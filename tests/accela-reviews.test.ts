import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PermitStore } from "../src/main/store.js";
import { describeCheckEvent } from "../src/main/notifications.js";
import { permitAction } from "../src/shared/action.js";
import { getAutomatedJurisdiction } from "../src/shared/jurisdictions.js";
import { parseDisplayedStatus } from "../src/shared/permit.js";
import { latestReviews, outstandingReviews } from "../src/shared/reviews.js";
import { workerToMainSchema } from "../src/shared/worker-protocol.js";
import { readDetail } from "../src/worker/detail.js";
import { defined } from "./support/defined.js";

// Captured from the reported live permit on September 28, 2026. Only record fields and the workflow table remain;
// comments, scripts, links, and images were removed. Nested/collapsed rows and status fields retain Accela's markup.
const html = readFileSync("tests/fixtures/hillsborough/processing-status.html", "utf8");

const number = "HC-SITECON-26-0000004";

const url =
  "https://aca-prod.accela.com/HCFL/Cap/CapDetail.aspx?Module=LandDevelopment&TabName=LandDevelopment&capID1=26CAP&capID2=00000&capID3=00CKN&agencyCode=HCFL";

const profile = defined(getAutomatedJurisdiction("hillsborough-county-building"), "Hillsborough profile");

let browser: Browser;

let page: Page;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
}, 60_000);

afterEach(async () => {
  await page?.close();
});

afterAll(async () => {
  await browser?.close();
});

async function serve(body: string): Promise<void> {
  page = await browser.newPage();
  await page.route("https://aca-prod.accela.com/**", (route) => route.fulfill({ contentType: "text/html", body }));
  await page.goto(url);
}

describe("Accela Processing Status", () => {
  it("reads the reported permit's collapsed histories, saves them, classifies AEC, and announces each new request only once", async () => {
    await serve(html);
    const record = await readDetail(page, profile, number);
    expect(record.statusValue).toBe("In Process");
    const reviews = defined(record.reviews, "workflow history");
    expect(outstandingReviews(reviews)).toEqual(
      expect.arrayContaining([
        {
          process: "Natural Resources Review",
          status: "Corrections Required",
          date: "2026-09-24",
          dueDate: "2026-09-22",
        },
        { process: "Site Engineer Review", status: "Corrections Required", date: "2026-09-22", dueDate: "2026-09-22" },
      ]),
    );
    expect(outstandingReviews(reviews).some((review) => review.process === "Stormwater Review")).toBe(false);
    expect(outstandingReviews(reviews).some((review) => review.process === "Plans Coordination")).toBe(false);
    expect(latestReviews(reviews).find((review) => review.process === "Stormwater Review")).toEqual({
      process: "Stormwater Review",
      status: null,
      date: null,
      dueDate: "2026-09-22",
    });

    const message = workerToMainSchema.parse({
      ...record,
      kind: "verified",
      runId: "test",
      browserVersion: "test",
      observedAt: "2026-09-28T12:00:00.000Z",
    });

    if (message.kind !== "verified") throw new Error("Expected verified message");
    const parsed = parseDisplayedStatus({ ...message, jurisdictionId: profile.id, requestedNumber: number });

    if (parsed._tag === "err") throw new Error(parsed.outcome);
    const directory = mkdtempSync(path.join(tmpdir(), "permit-review-test-"));
    const store = new PermitStore(path.join(directory, "data.sqlite"));

    try {
      const added = store.addPermit(number);

      if (added._tag === "err") throw added.error;
      const permitId = added.value;
      const before = defined(store.getPermit(permitId), "new permit");

      const finish = (outcome: "success" | "status_unavailable") => {
        const runId = store.startRun({
          permitId,
          appVersion: "test",
          playwrightVersion: "test",
          requestedModel: "test",
          promptVersion: "test",
        });

        store.finishRun({
          runId,
          permitId,
          outcome,
          actionCount: 0,
          requestCount: 0,
          actualModel: null,
          browserVersion: null,
          observation: parsed.value,
        });

        return defined(store.getPermit(permitId), "saved permit");
      };

      const after = finish("success");
      expect(after.reviews).toEqual(reviews);
      expect(permitAction(after)).toMatchObject({ action: "applicant", basis: "review" });
      expect(describeCheckEvent({ ...before, lastStatus: "In Process" }, after, "success")).toMatchObject({
        kind: "review-action",
        body: expect.stringContaining("Natural Resources Review: “Corrections Required” (2026-09-24)"),
      });
      expect(describeCheckEvent(after, finish("success"), "success")).toBeNull();
      const failed = finish("status_unavailable");
      expect(failed.reviews).toEqual(reviews);
      expect(failed.lastObservedAt).toBe(after.lastObservedAt);
      expect(permitAction(failed)?.action).toBe("applicant");
      const observation = defined(store.history(permitId).observations[0], "saved observation");
      expect(store.getObservation(observation.id)?.reviews).toEqual(reviews);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("waits for lazy-loaded Processing Status before reading the disciplines", async () => {
    const table = /<div id="divProcessingTable"[\s\S]*<\/div>/.exec(html)?.[0];
    expect(table).toBeTruthy();
    const encoded = JSON.stringify(table).replaceAll("<", "\\u003c");
    await serve(
      html
        .replace(table ?? "", '<div id="divProcessingTable"></div>')
        .replace(
          "</body>",
          `<a data-control="tab-processing_status" onclick='setTimeout(() => document.querySelector("#divProcessingTable").outerHTML = ${encoded}, 50)'>Processing Status</a></body>`,
        ),
    );
    expect(outstandingReviews((await readDetail(page, profile, number)).reviews ?? [])).toHaveLength(3);
  });

  it("fails a check rather than treating a missing workflow as no outstanding corrections", async () => {
    await serve(html.replace('id="tab-processing_status"', 'id="missing"'));
    expect(await readDetail(page, profile, number)).toMatchObject({ displayedNumber: number, statusValue: null });
  });

  it("rejects invalid dates instead of sorting them into an apparent current state", async () => {
    await serve(html.replaceAll("09/24/2026", "09/31/2026"));
    expect((await readDetail(page, profile, number)).statusValue).toBeNull();
  });

  it("rejects changed status markup rather than clearing known requests", async () => {
    await serve(html.replaceAll("Marked as", "Review result"));
    expect((await readDetail(page, profile, number)).statusValue).toBeNull();
  });

  it("accepts the portal's explicit no-records message as an empty workflow", async () => {
    await serve(`<span id="ctl00_PlaceHolderMain_lblPermitNumber">${number}</span>
      <span id="ctl00_PlaceHolderMain_lblRecordStatusTitle">Record Status:</span>
      <span id="ctl00_PlaceHolderMain_lblRecordStatus">In Process</span>
      <div id="tab-processing_status"><div id="divProcessingTable"><span class="ACA_CapDetail_NoRecord">No records found.</span></div></div>`);
    expect(await readDetail(page, profile, number)).toMatchObject({ statusValue: "In Process", reviews: [] });
  });

  it("does not read workflow evidence belonging to a different permit", async () => {
    await serve(html);
    expect((await readDetail(page, profile, "HC-SITECON-26-9999999")).reviews).toBeUndefined();
  });
});
