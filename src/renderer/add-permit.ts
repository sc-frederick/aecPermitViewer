import {
  getJurisdiction,
  isManualJurisdiction,
  JURISDICTION_GROUPS,
  JURISDICTIONS,
  numberExample,
} from "../shared/jurisdictions.js";
import type { PermitRow } from "../shared/permit.js";
import { PERMIT_NUMBER_MIN, PERMIT_NUMBER_PATTERN } from "../shared/permit-number.js";
import { projectProblem } from "../shared/project-number.js";
import { recentProjects } from "../shared/projects.js";
import { busy, element, eventButton, make, setInlineError } from "./dom.js";
import { notice } from "./overlays.js";
import { fetchSnapshot, setFilter } from "./snapshot-render.js";
import { api, ui } from "./state.js";

const addForm = element("add-form", HTMLFormElement);

const jurisdictionSelect = element("jurisdiction", HTMLSelectElement);

const jurisdictionHelp = element("jurisdiction-help");

const permitNumberInput = element("permit-number", HTMLInputElement);

const permitNumberError = element("permit-number-error");

const addButton = element("add-button", HTMLButtonElement);

const manualDialog = element("manual-dialog", HTMLDialogElement);

const manualForm = element("manual-form", HTMLFormElement);

const manualJurisdiction = element("manual-jurisdiction");

const manualTitle = element("manual-title");

const manualStatus = element("manual-status", HTMLInputElement);

const manualLink = element("manual-link", HTMLInputElement);

const manualError = element("manual-error");

const manualReopen = element("manual-reopen", HTMLButtonElement);

const manualCancel = element("manual-cancel", HTMLButtonElement);

const manualSave = element("manual-save", HTMLButtonElement);

const projectDialog = element("project-dialog", HTMLDialogElement);

const projectForm = element("project-form", HTMLFormElement);

const projectPermit = element("project-permit");

const projectInput = element("project-input", HTMLInputElement);

const projectError = element("project-error");

const projectRecent = element("project-recent");

const projectRecentList = element("project-recent-list", HTMLUListElement);

const projectSkip = element("project-skip", HTMLButtonElement);

const projectSave = element("project-save", HTMLButtonElement);

let manualPermitId: string | null = null;

let projectPermitId: string | null = null;

let settleProject: ((saved: string | null) => void) | null = null;

/**
 * Opens a hand-checked permit's portal, then the dialog that records the status the user reads there. A portal that
 * fails to open shows a notice instead.
 */
export async function startManualCheck(permit: PermitRow): Promise<void> {
  const result = await api.openPortal(permit.id);

  if (!result.ok) {
    notice(result.error);

    return;
  }

  const profile = getJurisdiction(permit.jurisdictionId);
  manualPermitId = permit.id;
  manualJurisdiction.textContent = profile?.label ?? "";
  manualTitle.textContent = permit.permitNumber;
  manualStatus.value = permit.lastStatus ?? "";
  manualLink.value = permit.lastRecordUrl && permit.lastRecordUrl !== profile?.startUrl ? permit.lastRecordUrl : "";
  setInlineError(manualStatus, manualError, null);

  if (!manualDialog.open) manualDialog.showModal();
  manualStatus.focus();
  manualStatus.select();
}

function closeManual(): void {
  manualPermitId = null;

  if (manualDialog.open) manualDialog.close();
}

function askProjectNumber(permit: PermitRow): Promise<string | null> {
  settleProject?.(null);
  projectPermitId = permit.id;
  projectPermit.textContent = permit.permitNumber;
  const others = ui.currentSnapshot?.permits.filter((entry) => entry.id !== permit.id) ?? [];
  const recent = recentProjects(others, 5);
  projectInput.value = recent[0] ?? "";
  projectRecent.hidden = recent.length < 2;
  projectRecentList.replaceChildren(
    ...recent.map((number) => {
      const item = make("li");
      const chip = make("button", "project-chip", number);
      chip.type = "button";
      chip.dataset.project = number;
      item.append(chip);

      return item;
    }),
  );
  setInlineError(projectInput, projectError, null);
  projectDialog.showModal();
  projectInput.focus();
  projectInput.select();

  return new Promise((resolve) => {
    settleProject = resolve;
  });
}

/** Closes the project number prompt, if open, and settles its pending question with `saved`. */
export function finishProject(saved: string | null): void {
  projectPermitId = null;

  if (projectDialog.open) projectDialog.close();
  const settle = settleProject;
  settleProject = null;
  settle?.(saved);
}

function renderJurisdictionOptions(): void {
  jurisdictionSelect.replaceChildren(
    ...JURISDICTION_GROUPS.map((group) => {
      const optgroup = make("optgroup");
      optgroup.label = group.label;
      optgroup.append(
        ...JURISDICTIONS.filter(group.includes).map((profile) => {
          const option = make("option", "", profile.label);
          option.value = profile.id;

          return option;
        }),
      );

      return optgroup;
    }),
  );
  renderJurisdictionHelp();
}

function renderJurisdictionHelp(): void {
  const profile = getJurisdiction(jurisdictionSelect.value);
  jurisdictionHelp.textContent = profile?.coverageNote ?? "";
  permitNumberInput.placeholder = (profile && numberExample(profile)) ?? "Full permit number";
}

/** Wires the hand-check dialog, the project number prompt, and the add form, and fills the jurisdiction menu. */
export function initAddPermit(): void {
  manualStatus.addEventListener("input", () => setInlineError(manualStatus, manualError, null));

  manualCancel.addEventListener("click", closeManual);

  manualDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeManual();
  });

  manualReopen.addEventListener("click", async () => {
    if (!manualPermitId) return;
    const result = await api.openPortal(manualPermitId);

    if (!result.ok) setInlineError(manualStatus, manualError, result.error);
  });

  manualForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const permitId = manualPermitId;

    if (!permitId) return;
    const status = manualStatus.value.trim();

    if (!status) {
      setInlineError(manualStatus, manualError, "Enter the status shown on the portal.");
      manualStatus.focus();

      return;
    }

    const recordUrl = manualLink.value.trim();
    const result = await busy(manualSave, () => api.recordManualStatus({ permitId, status, recordUrl }));

    if (!result.ok) {
      setInlineError(manualStatus, manualError, result.error);

      return;
    }

    closeManual();
    notice("Status saved.", "info");
  });

  projectInput.addEventListener("input", () => setInlineError(projectInput, projectError, null));

  projectRecentList.addEventListener("click", (event) => {
    const chip = eventButton(event, "button[data-project]");

    if (!chip?.dataset.project) return;
    projectInput.value = chip.dataset.project;
    setInlineError(projectInput, projectError, null);
    projectInput.focus();
  });

  projectSkip.addEventListener("click", () => finishProject(null));

  projectDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    finishProject(null);
  });

  projectDialog.addEventListener("click", (event) => {
    if (event.target === projectDialog) finishProject(null);
  });

  projectForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const permitId = projectPermitId;

    if (!permitId) return;
    const value = projectInput.value.trim();

    if (!value) {
      finishProject(null);

      return;
    }

    const problem = projectProblem(value);

    if (problem) {
      setInlineError(projectInput, projectError, problem);
      projectInput.focus();

      return;
    }

    const result = await busy(projectSave, () => api.setProjectNumber(permitId, value));

    if (!result.ok) {
      setInlineError(projectInput, projectError, result.error);
      projectInput.focus();

      return;
    }

    finishProject(value);
  });

  permitNumberInput.addEventListener("input", () => setInlineError(permitNumberInput, permitNumberError, null));

  addForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const number = permitNumberInput.value.trim();

    if (!number) {
      setInlineError(permitNumberInput, permitNumberError, "Enter a permit number.");
      permitNumberInput.focus();

      return;
    }

    if (!PERMIT_NUMBER_PATTERN.test(number) || number.length < PERMIT_NUMBER_MIN) {
      setInlineError(permitNumberInput, permitNumberError, "Use letters, numbers, hyphens, and dots only.");
      permitNumberInput.focus();

      return;
    }

    const jurisdiction = jurisdictionSelect.value;

    const result = await busy(addButton, () => api.addAndCheck({ jurisdiction, permitNumber: number }));

    if (!result.ok) {
      setInlineError(permitNumberInput, permitNumberError, result.error);
      permitNumberInput.focus();

      return;
    }

    permitNumberInput.value = "";
    setInlineError(permitNumberInput, permitNumberError, null);

    if (ui.filter !== "all") setFilter("all");

    if (!(await fetchSnapshot())) return;
    const added = ui.currentSnapshot?.permits.find((entry) => entry.id === result.value);
    const project = added ? await askProjectNumber(added) : null;
    notice(project ? `${number} added to project ${project}.` : `${number} added.`, "info");

    if (added && isManualJurisdiction(added.jurisdictionId)) await startManualCheck(added);
  });

  renderJurisdictionOptions();

  jurisdictionSelect.addEventListener("change", renderJurisdictionHelp);
}
