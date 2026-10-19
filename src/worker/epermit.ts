import type { Locator, Page } from "playwright";
import { epermitRecordUrl, expectedStatusLabel, parseEpermitNumber, sameEpermitRowNumber } from "../shared/permit.js";
import { onlyElement } from "../shared/array.js";
import type { AutomatedJurisdictionProfile } from "../shared/jurisdictions.js";
import type { Candidate } from "../shared/worker-protocol.js";
import type { DisplayedRecord, PortalAdapter, SearchObservation } from "./adapter.js";

type EpermitProfile = Extract<AutomatedJurisdictionProfile, { portalFamily: "epermit" }>;

const PERMIT_FIELD = "input[formcontrolname=permitNo]";

const SEQUENCE_FIELD = "input[formcontrolname=seqNo]";

const RESULT_LINK = "ng-reg-search td a";

const NO_RESULTS = "No Results Found";

const RECORD_FRAME = "iframe#iframeDiagHtml";

// ePermit clears its search fields after the third lookup list arrives.
export function watchEpermitForm(page: Page): () => Promise<void> {
  let lists = 0;
  page.on("response", (response) => {
    if (/\/api\/custom\/lookups\/catalogList/.test(response.url())) lists += 1;
  });

  return async () => {
    await page
      .locator(PERMIT_FIELD)
      .waitFor({ state: "visible", timeout: 25_000 })
      .catch(() => undefined);
    const until = Date.now() + 25_000;

    while (lists < 3 && Date.now() < until) await page.waitForTimeout(100);
    await page.waitForTimeout(300);
  };
}

function searchButton(page: Page): Locator {
  return page.locator("ng-reg-search button").filter({ hasText: /^\s*Search\s*$/ });
}

async function exactLinks(page: Page, requested: string): Promise<Array<{ link: Locator; text: string }>> {
  const links = page.locator(RESULT_LINK).filter({ visible: true });
  const texts = (await links.allInnerTexts()).map((text) => text.trim());

  return texts.flatMap((text, index) =>
    sameEpermitRowNumber(requested, text) ? [{ link: links.nth(index), text }] : [],
  );
}

async function criteriaEntered(page: Page, requested: string): Promise<boolean> {
  const wanted = parseEpermitNumber(requested);

  const value = (selector: string) =>
    page
      .locator(selector)
      .inputValue()
      .catch(() => "");

  const [permit, sequence] = [await value(PERMIT_FIELD), await value(SEQUENCE_FIELD)];

  return Boolean(
    wanted &&
    /^\d+$/.test(permit) &&
    /^\d+$/.test(sequence) &&
    Number(permit) === wanted.permit &&
    Number(sequence) === wanted.sequence,
  );
}

async function noResultsShown(page: Page): Promise<boolean> {
  return page
    .getByText(NO_RESULTS, { exact: true })
    .isVisible()
    .catch(() => false);
}

async function recordFields(page: Page): Promise<Array<[string, string]>> {
  const frame = page.locator(RECORD_FRAME);

  if ((await frame.count()) !== 1 || !(await frame.isVisible())) return [];

  return page
    .frameLocator(RECORD_FRAME)
    .locator("mat-label.fw-bold")
    .evaluateAll((labels) =>
      labels.map((label): [string, string] => [
        label.textContent?.trim() ?? "",
        label.nextElementSibling?.textContent?.trim() ?? "",
      ]),
    );
}

function field(fields: Array<[string, string]>, name: string): string | null {
  const values = fields.flatMap(([label, value]) => (label === name ? [value] : []));

  return values.length === 1 && values[0] ? values[0] : null;
}

async function observeEpermitSearch(
  page: Page,
  profile: EpermitProfile,
  requested: string,
): Promise<SearchObservation> {
  const entered = await criteriaEntered(page, requested);
  const inputValue = entered ? requested : "";

  if (
    (await page
      .locator("mat-dialog-container")
      .filter({ visible: true })
      .filter({ hasNot: page.locator(RECORD_FRAME) })
      .count()) > 0
  ) {
    return { phase: "unknown", inputValue, formLabels: [], visibleControls: [], resultNumbers: [], candidates: [] };
  }

  if (field(await recordFields(page), "Project Number")) {
    return {
      phase: "detail",
      inputValue,
      formLabels: [],
      visibleControls: ["Permit information"],
      resultNumbers: [],
      candidates: [],
    };
  }

  const exact = entered ? await exactLinks(page, requested) : [];

  if (exact.length > 0) {
    const resultNumbers = exact.map(({ text }) => text);

    return exact.length > 1
      ? {
          phase: "results",
          inputValue,
          formLabels: [],
          visibleControls: ["Search results"],
          resultNumbers,
          candidates: [],
        }
      : {
          phase: "search",
          inputValue,
          formLabels: [],
          visibleControls: ["Search results"],
          resultNumbers,
          candidates: [
            {
              id: "open_exact_result",
              established: true,
              description: `Open the result whose permit number exactly matches ${requested}.`,
            },
          ],
        };
  }

  const permit = page.locator(PERMIT_FIELD);
  const sequence = page.locator(SEQUENCE_FIELD);

  if (
    (await permit.count()) !== 1 ||
    (await sequence.count()) !== 1 ||
    !(await permit.isVisible()) ||
    !(await permit.isEnabled())
  ) {
    return { phase: "search", inputValue, formLabels: [], visibleControls: [], resultNumbers: [], candidates: [] };
  }

  const candidates: Candidate[] = [];

  if (!entered) {
    candidates.push({
      id: "fill_record_number",
      established: true,
      description:
        "Fill Application/Permit # and Sequence # with the number and sequence from the exact permit number.",
    });
  } else if (
    !(await noResultsShown(page)) &&
    (await searchButton(page).count()) === 1 &&
    (await searchButton(page).isEnabled())
  ) {
    candidates.push({
      id: "search_record_number",
      established: true,
      description: `Submit the ${profile.label} ePermit search for the exact permit and sequence number.`,
    });
  }

  return {
    phase: "search",
    inputValue,
    formLabels: ["Application/Permit #", "Sequence #"],
    visibleControls: ["Application/Permit # and Sequence # search"],
    resultNumbers: [],
    candidates,
  };
}

async function epermitSearchFoundNothing(page: Page, requested: string): Promise<boolean> {
  if (!(await criteriaEntered(page, requested))) return false;

  if (await noResultsShown(page)) return true;
  const shown = await page.locator(RESULT_LINK).filter({ visible: true }).allInnerTexts();

  return (
    shown.length > 0 &&
    shown.every((text) => parseEpermitNumber(text) !== null) &&
    !shown.some((text) => sameEpermitRowNumber(requested, text.trim()))
  );
}

async function fillEpermitSearch(page: Page, requested: string): Promise<void> {
  const wanted = parseEpermitNumber(requested);

  if (!wanted) return;
  await page.locator(PERMIT_FIELD).fill(String(wanted.permit));
  await page.locator(SEQUENCE_FIELD).fill(String(wanted.sequence));
}

async function submitEpermitSearch(page: Page, requested: string): Promise<void> {
  if (!(await criteriaEntered(page, requested))) return;
  await page
    .locator(".cdk-overlay-backdrop")
    .first()
    .waitFor({ state: "hidden", timeout: 20_000 })
    .catch(() => undefined);

  if (!(await criteriaEntered(page, requested))) await fillEpermitSearch(page, requested);

  if (
    !(await searchButton(page)
      .click()
      .then(
        () => true,
        () => false,
      ))
  )
    return;
  // St. Johns River's search request can take close to a minute to return.
  await Promise.any([
    page.locator(RESULT_LINK).first().waitFor({ state: "visible", timeout: 90_000 }),
    page.getByText(NO_RESULTS, { exact: true }).waitFor({ state: "visible", timeout: 90_000 }),
  ]).catch(() => undefined);
}

async function openEpermitResult(page: Page, requested: string): Promise<void> {
  const exact = onlyElement(await exactLinks(page, requested));

  if (!exact) return;
  await exact.link.click();
  await page
    .waitForFunction(
      (selector) => {
        const frame = document.querySelector<HTMLIFrameElement>(selector);
        const labels = [...(frame?.contentDocument?.querySelectorAll("mat-label.fw-bold") ?? [])];

        const value = (name: string) =>
          labels.find((label) => label.textContent?.trim() === name)?.nextElementSibling?.textContent?.trim();

        return Boolean(value("Project Number") && value("Status"));
      },
      RECORD_FRAME,
      { timeout: 60_000 },
    )
    .catch(() => undefined);
}

async function rowStatus(link: Locator): Promise<string | null> {
  return link.evaluate((anchor) => {
    const row = anchor.closest("tr");

    const header = [...(row?.closest("table")?.querySelectorAll("tr") ?? [])].find((candidate) =>
      [...candidate.cells].some((cell) => cell.textContent?.trim() === "Permit #"),
    );

    const index = [...(header?.cells ?? [])].findIndex((cell) => cell.textContent?.trim() === "Status");

    return index >= 0 && row?.cells[index] ? row.cells[index].textContent?.trim() || null : null;
  });
}

async function readEpermitRecord(page: Page, profile: EpermitProfile, requested: string): Promise<DisplayedRecord> {
  const fields = await recordFields(page);
  const row = onlyElement(await exactLinks(page, requested));
  const rowNumber = row?.text ?? null;
  const project = field(fields, "Project Number");
  const status = row ? await rowStatus(row.link) : null;
  const stage = field(fields, "Current Process Stage");

  return {
    displayedNumber: rowNumber && project ? `${rowNumber} · Project Number ${project}` : null,
    statusLabel: status && stage ? expectedStatusLabel(profile) : null,
    statusValue: status && stage ? `${status} · ${stage}` : null,
    recordUrl: rowNumber ? epermitRecordUrl(profile, rowNumber) : null,
  };
}

export function epermitAdapter(page: Page, profile: EpermitProfile, requested: string): PortalAdapter {
  return {
    observe: () => observeEpermitSearch(page, profile, requested),
    foundNothing: () => epermitSearchFoundNothing(page, requested),
    fill: () => fillEpermitSearch(page, requested),
    submit: () => submitEpermitSearch(page, requested),
    openResult: () => openEpermitResult(page, requested),
    read: () => readEpermitRecord(page, profile, requested),
  };
}
