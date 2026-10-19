import type { Page } from "playwright";
import {
  expectedStatusLabel,
  parseApplicationNumber,
  parsePortalUrl,
  sameJurisdictionPermitNumber,
} from "../shared/permit.js";
import { DETAIL_NUMBER } from "./accela-global.js";
import { readAccelaReviews } from "./accela-reviews.js";
import type { AutomatedJurisdictionProfile } from "../shared/jurisdictions.js";
import { NOTHING_DISPLAYED, type DisplayedRecord } from "./adapter.js";

interface DetailFields {
  number: string;
  status: string;
  label: string | null;
}

const ACCELA_FIELDS: DetailFields = {
  number: DETAIL_NUMBER,
  status: "#ctl00_PlaceHolderMain_lblRecordStatus",
  label: "#ctl00_PlaceHolderMain_lblRecordStatusTitle",
};

const CLICK2GOV_FIELDS: DetailFields = {
  number: 'label:has-text("Application #:") + div p.form-control-static',
  status: 'label:has-text("Application Status:") + div p.form-control-static',
  label: null,
};

const TYLER_FIELDS = {
  permit: {
    number: '#focusText span[ng-bind-html="vm.model.PermitNumber"]',
    status: "#label-PermitDetail-Status p.form-control-static",
    label: "#label-PermitDetail-Status h4.control-label",
  },
  plan: {
    number: '#focusText span[ng-bind-html="vm.model.PlanNumber"]',
    status: "#label-PlanDetail-Status p.form-control-static",
    label: "#label-PlanDetail-Status h4.control-label",
  },
} as const satisfies Record<string, DetailFields>;

function tylerRecordKind(url: string): keyof typeof TYLER_FIELDS | null {
  const hash = new URL(url).hash;

  if (/^#\/permit\/[^/]+$/i.test(hash)) return "permit";

  if (/^#\/plan\/[^/]+$/i.test(hash)) return "plan";

  return null;
}

function detailFields(profile: AutomatedJurisdictionProfile, url: string): DetailFields | null {
  switch (profile.portalFamily) {
    case "accela":
      return ACCELA_FIELDS;
    case "click2gov":
      return CLICK2GOV_FIELDS;
    case "tyler-civic-access": {
      const kind = tylerRecordKind(url);

      return kind ? TYLER_FIELDS[kind] : null;
    }

    default:
      return null;
  }
}

async function visibleText(page: Page, selector: string): Promise<string | null> {
  const texts = await page.locator(selector).evaluateAll((nodes) =>
    nodes.map((node) => {
      if (!(node instanceof HTMLElement)) return null;
      const box = node.getBoundingClientRect();

      return box.width > 0 && box.height > 0 && node.checkVisibility({ visibilityProperty: true })
        ? node.innerText.trim()
        : null;
    }),
  );

  return texts.length === 1 ? (texts[0] ?? null) : null;
}

function stPeteRecordUrl(number: string): string | null {
  const parts = parseApplicationNumber(number);

  if (!parts) return null;
  const url = new URL("https://stpe-egov.aspgov.com/Click2GovBP/selectpermit.html");
  url.searchParams.set("permit.appYear", parts.year);
  url.searchParams.set("permit.appNumber", parts.serial);
  url.searchParams.set("searchType", "0");
  url.searchParams.set("validatePermitView", "true");

  return url.toString();
}

/** The record page's displayed number, status, status label, and the record link to save. */
export async function readDetail(
  page: Page,
  profile: AutomatedJurisdictionProfile,
  requestedNumber: string,
): Promise<DisplayedRecord> {
  const fields = detailFields(profile, page.url());

  if (!fields) return NOTHING_DISPLAYED;

  const record: DisplayedRecord = {
    displayedNumber: await visibleText(page, fields.number),
    statusValue: await visibleText(page, fields.status),
    statusLabel: fields.label ? await visibleText(page, fields.label) : `${expectedStatusLabel(profile)}:`,
    recordUrl: profile.portalFamily === "click2gov" ? stPeteRecordUrl(requestedNumber) : page.url(),
  };

  if (
    profile.portalFamily === "accela" &&
    record.displayedNumber &&
    sameJurisdictionPermitNumber(requestedNumber, record.displayedNumber, profile.id)
  ) {
    const reviews = await readAccelaReviews(page);

    if (reviews._tag === "err") return { ...record, statusValue: null };
    record.reviews = reviews.value;
  }

  return record;
}

/** Waits for a Tyler record's number and status to hold text; Tyler renders after load. Other families load ready. */
export async function waitForDetail(page: Page, profile: AutomatedJurisdictionProfile): Promise<void> {
  const fields = profile.portalFamily === "tyler-civic-access" ? detailFields(profile, page.url()) : null;

  if (!fields) return;

  for (const selector of [fields.number, fields.status]) {
    await page
      .locator(selector)
      .filter({ hasText: /\S/ })
      .waitFor({ state: "visible", timeout: 12_000 })
      .catch(() => undefined);
  }
}

/** The keyword search input on Tyler Civic Access portals. */
export const TYLER_SEARCH_FIELD = "#SearchKeyword";

const TYLER_RESULT_MESSAGE = "#moduleResultMessage label";

// Tyler's startup requests can clear a keyword entered before they finish.
/**
 * Waits for a Tyler search or home page to be usable, then for its startup requests to finish, since a keyword typed
 * before then can be cleared. The search route waits for its keyword field; the home page for the field or the menu's
 * search link (the menu repeats that link hidden, so only a visible one counts).
 */
export async function waitForTylerSearch(page: Page): Promise<void> {
  const ready = /^#\/search/i.test(new URL(page.url()).hash)
    ? page.locator(TYLER_SEARCH_FIELD)
    : page.locator(`${TYLER_SEARCH_FIELD}, a[href*='#/search']`).filter({ visible: true }).first();

  await ready.waitFor({ state: "visible", timeout: 12_000 }).catch(() => undefined);
  await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
}

/**
 * Waits for the page a run just opened (its start page or a saved record link) to be ready to observe: a record page
 * for its number and status (see `waitForDetail`), a Tyler search page for its keyword field. The worker waits on
 * other families' start pages itself.
 */
export async function waitForLanding(page: Page, profile: AutomatedJurisdictionProfile): Promise<void> {
  const url = page.url();

  if (parsePortalUrl(url, "search", profile.id)) {
    if (profile.portalFamily === "tyler-civic-access") await waitForTylerSearch(page);

    return;
  }

  if (parsePortalUrl(url, "detail", profile.id)) await waitForDetail(page, profile);
}

/** Waits for Tyler's visible result count or no-results message after a search. */
export async function waitForTylerResults(page: Page): Promise<void> {
  await page
    .locator(TYLER_RESULT_MESSAGE)
    .filter({ visible: true })
    .first()
    .waitFor({ state: "visible", timeout: 12_000 })
    .catch(() => undefined);
}

/** True when Tyler's finished search says it found nothing. */
export async function tylerFoundNothing(page: Page): Promise<boolean> {
  const shown = await page.locator(TYLER_RESULT_MESSAGE).filter({ visible: true }).allInnerTexts();

  return shown.some((text) => text.trim() === "No results were found");
}
