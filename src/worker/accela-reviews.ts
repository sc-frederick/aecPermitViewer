import type { Page } from "playwright";
import { reviewDate, reviewsSchema, type ReviewEntry } from "../shared/reviews.js";

/** The workflow could not be read completely; treating that as an empty workflow would clear known requests. */
export class ReviewReadFailed extends Error {
  readonly _tag = "ReviewReadFailed" as const;

  constructor() {
    super("Accela processing status could not be read.");
  }
}

type ReviewRead = { _tag: "ok"; value: ReviewEntry[] | null } | { _tag: "err"; error: ReviewReadFailed };

/**
 * Reads Accela's nested Processing Status history, including collapsed rows. Only structured status fields count;
 * reviewer comments, icons, assignment names, and unrelated record text never become statuses.
 */
export async function readAccelaReviews(page: Page): Promise<ReviewRead> {
  const failed: ReviewRead = { _tag: "err", error: new ReviewReadFailed() };

  try {
    const tab = page.locator("#tab-processing_status");

    if (await tab.count() === 0) return failed;
    const table = page.locator("#divProcessingTable");

    // Some tenants render the workflow at page load; others fetch it the first time the tab opens.
    if (await table.locator("table, .ACA_CapDetail_NoRecord").count() === 0) {
      await page.locator('a[data-control="tab-processing_status"]').evaluate((link) => {
        if (link instanceof HTMLElement) link.click();
      });
      await table.locator("table, .ACA_CapDetail_NoRecord").first().waitFor({ state: "attached", timeout: 12_000 });
    }

    const processes = await table.evaluate((root) => {
      const workflow = root.querySelector(":scope > table");

      if (!(workflow instanceof HTMLTableElement)) return root.querySelector(".ACA_CapDetail_NoRecord") ? [] : null;

      if (workflow.rows.length === 0) return null;
      const result: Array<{ process: string; entries: string[][] }> = [];

      for (const row of workflow.rows) {
        if (row.id) continue;
        const process = row.cells[1]?.textContent?.trim();
        const history = row.nextElementSibling;

        if (!process || !(history instanceof HTMLTableRowElement) || !history.id) return null;
        const entries: string[][] = [];

        for (const cell of history.querySelectorAll("td")) {
          const spans = [...cell.querySelectorAll(":scope > span")];

          if (spans.length === 0 || !cell.textContent?.includes("Marked as")) continue;
          entries.push(spans.map((span) => span.textContent?.trim() ?? ""));
        }

        if (entries.length !== history.querySelectorAll("tr.ACA_TabRow_Bold, tr.ACA_TabRow_Italic").length) return null;
        result.push({ process, entries });
      }

      return result;
    });

    if (!processes) return failed;
    const entries: ReviewEntry[] = [];

    for (const process of processes) {
      if (process.entries.length === 0) entries.push({ process: process.process, status: null, date: null, dueDate: null });

      for (const values of process.entries) {
        const [due, , status, dated] = values;

        if (values.length !== 5 || due === undefined || !status || !dated) return failed;
        const date = reviewDate(dated);
        const dueDate = reviewDate(due);

        if ((!date && dated !== "TBD") || (!dueDate && due !== "TBD")) return failed;
        entries.push({ process: process.process, status: status === "TBD" ? null : status, date, dueDate });
      }
    }

    const parsed = reviewsSchema.safeParse(entries);

    return parsed.success ? { _tag: "ok", value: parsed.data } : failed;
  } catch {
    return failed;
  }
}
