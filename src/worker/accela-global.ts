import { createHash } from "node:crypto";
import type { Page } from "playwright";
import { onlyElement } from "../shared/array.js";
import type { AutomatedJurisdictionProfile } from "../shared/jurisdictions.js";
import { exactLinks, type SearchObservation } from "./adapter.js";

const RESULTS_LABEL = "#ctl00_PlaceHolderMain_lblSearchResults";

const NO_RESULTS = "#ctl00_PlaceHolderMain_pnlNoResults";

/** A record link on Accela's Global Search results page. */
export const GLOBAL_RESULT_LINK = "a[id$='_lnkPermitNumber']";

const NEXT_PAGE = "a[href*='gdvPermitList']:text-is('Next >')";

/** The permit number on an Accela record page. */
export const DETAIL_NUMBER = "#ctl00_PlaceHolderMain_lblPermitNumber";

/** Accela Global Search results. `pageIdentity` hashes the visible rows and pager for the worker's fingerprint only. */
export interface AccelaGlobalResults {
  /** Offers only an exact record or the next results page; other row numbers never enter the model observation. */
  observe(): Promise<SearchObservation & { pageIdentity: string }>;
  /** True when a completed results page has no exact match and no next page. */
  foundNothing(): Promise<boolean>;
  /** Opens the sole exact result after rereading its identity. */
  openResult(): Promise<void>;
  /** Advances the page and waits for changed rows or a terminal result. */
  next(): Promise<void>;
}

/** Waits for a record, changed result rows, or the no-results notice after a Global Search postback. */
export async function waitForAccelaGlobalResults(page: Page, previousRows: string, previousPager = ""): Promise<void> {
  await page
    .waitForFunction(
      ({ rows, pager, link, detail, none }) => {
        if (document.querySelector(detail) || document.querySelector(none)) return true;

        const current = [...document.querySelectorAll<HTMLElement>(link)]
          .slice(0, 250)
          .map((anchor) => anchor.innerText.trim().slice(0, 160))
          .join("|");

        const currentPager = [...document.querySelectorAll("a[href*='gdvPermitList']")]
          .slice(0, 10)
          .map((anchor) => anchor.closest("tr")?.innerText.trim().slice(0, 512) ?? "")
          .join("|");

        return current !== "" && (current !== rows || currentPager !== pager);
      },
      { rows: previousRows, pager: previousPager, link: GLOBAL_RESULT_LINK, detail: DETAIL_NUMBER, none: NO_RESULTS },
      { timeout: 15_000 },
    )
    .catch(() => undefined);
  await page.waitForLoadState("domcontentloaded").catch(() => undefined);
}

/** Drives Accela Global Search results, including postbacks that leave the page URL unchanged. */
export function accelaGlobalResultsAdapter(
  page: Page,
  profile: AutomatedJurisdictionProfile,
  requested: string,
): AccelaGlobalResults {
  const read = async () => {
    const rows = await page.locator(GLOBAL_RESULT_LINK).evaluateAll((anchors) =>
      anchors.slice(0, 250).flatMap((anchor, index) => {
        if (!(anchor instanceof HTMLAnchorElement) || anchor.getBoundingClientRect().width === 0) return [];
        const href = anchor.getAttribute("href");

        return href ? [{ text: anchor.innerText.trim().slice(0, 160), href, index }] : [];
      }),
    );

    const pager = await page
      .locator("a[href*='gdvPermitList']")
      .evaluateAll((anchors) =>
        anchors.slice(0, 10).map((anchor) => anchor.closest("tr")?.innerText.trim().slice(0, 512) ?? ""),
      );

    const exact = exactLinks(rows, requested, profile.id);
    const next = page.locator(NEXT_PAGE);
    const hasNext = (await next.count()) === 1 && (await next.isVisible()) && (await next.isEnabled());

    const pageIdentity = createHash("sha256")
      .update(
        JSON.stringify({
          rows: rows.map((row) => ({ text: row.text, href: row.href.slice(0, 512), index: row.index })),
          pager,
        }),
      )
      .digest("hex");

    return { rows, exact, hasNext, pageIdentity, pager };
  };

  return {
    observe: async () => {
      const result = await read();

      const candidates =
        result.exact.length === 1
          ? [
              {
                id: "open_exact_result",
                established: true,
                description: `Open the result whose displayed permit number exactly equals ${requested}.`,
              },
            ]
          : result.exact.length === 0 && result.hasNext
            ? [
                {
                  id: "next_results_page",
                  established: true,
                  description: "Show the next page of Global Search results to look for the exact permit number.",
                },
              ]
            : [];

      return {
        phase: result.exact.length > 0 ? "results" : "search",
        inputValue: "",
        formLabels: [],
        visibleControls: (await page
          .locator(RESULTS_LABEL)
          .isVisible()
          .catch(() => false))
          ? ["Global Search results"]
          : [],
        resultNumbers: result.exact.map((row) => row.text),
        candidates,
        pageIdentity: result.pageIdentity,
      };
    },
    foundNothing: async () => {
      const result = await read();

      return (
        result.exact.length === 0 &&
        !result.hasNext &&
        (await page
          .locator(RESULTS_LABEL)
          .isVisible()
          .catch(() => false))
      );
    },
    openResult: async () => {
      const exact = onlyElement((await read()).exact);

      if (!exact) return;
      await page.locator(GLOBAL_RESULT_LINK).nth(exact.index).click({ noWaitAfter: true });
      await page
        .locator(DETAIL_NUMBER)
        .waitFor({ state: "visible", timeout: 15_000 })
        .catch(() => undefined);
    },
    next: async () => {
      const result = await read();

      if (!result.hasNext || result.exact.length > 0) return;
      await page.locator(NEXT_PAGE).click({ noWaitAfter: true });
      await waitForAccelaGlobalResults(page, result.rows.map((row) => row.text).join("|"), result.pager.join("|"));
    },
  };
}
