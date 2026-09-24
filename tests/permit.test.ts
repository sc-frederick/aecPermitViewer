import { describe, expect, it } from "vitest";
import { parseDisplayedStatus, parsePortalUrl, resolveJurisdiction, samePermitNumber } from "../src/shared/permit.js";

const detailUrl = "https://aca-prod.accela.com/HCFL/Cap/CapDetail.aspx?Module=Building&TabName=Building&capID1=26CAP&capID2=00000&capID3=01Y33&agencyCode=HCFL";
const candidate = {
  requestedNumber: "HC-BLD-26-0087599",
  displayedNumber: "HC-BLD-26-0087599",
  statusLabel: "Record Status:",
  statusValue: "In Process",
  recordUrl: detailUrl,
  observedAt: "2026-09-24T12:00:00.000Z",
};

describe("verified portal observation", () => {
  it("preserves the exact displayed status without interpretation", () => {
    expect(parseDisplayedStatus(candidate)).toMatchObject({ _tag: "ok", value: { statusValue: "In Process" } });
    expect(parseDisplayedStatus({ ...candidate, statusValue: "Pending agency review — Phase 2" }))
      .toMatchObject({ _tag: "ok", value: { statusValue: "Pending agency review — Phase 2" } });
  });

  it("rejects wrong identities, including a changed digit and a lost leading zero", () => {
    expect(parseDisplayedStatus({ ...candidate, displayedNumber: "HC-BLD-26-0087598" }))
      .toEqual({ _tag: "err", outcome: "identity_mismatch" });
    expect(samePermitNumber("HC-BLD-26-0087599", "HC-BLD-26-087599")).toBe(false);
  });

  it("rejects an unrelated status field and an unqualified record link", () => {
    expect(parseDisplayedStatus({ ...candidate, statusLabel: "Inspection Status:" }))
      .toEqual({ _tag: "err", outcome: "status_unavailable" });
    expect(parseDisplayedStatus({ ...candidate, recordUrl: detailUrl.replace("/HCFL/", "/OTHER/") }))
      .toEqual({ _tag: "err", outcome: "record_link_unavailable" });
  });

  it("restricts record links to the official tenant and Building module", () => {
    expect(parsePortalUrl(detailUrl, "detail")).not.toBeNull();
    expect(parsePortalUrl(detailUrl.replace("Module=Building", "Module=Planning"), "detail")).toBeNull();
    expect(parsePortalUrl(detailUrl.replace("agencyCode=HCFL", "agencyCode=OTHER"), "detail")).toBeNull();
    expect(parsePortalUrl(detailUrl.replace("aca-prod.accela.com", "aca-prod.accela.com.evil.test"), "detail")).toBeNull();
    expect(parsePortalUrl(`${detailUrl}&agencyCode=OTHER`, "detail")).toBeNull();
    expect(parsePortalUrl(`${detailUrl}&module=Planning`, "detail")).toBeNull();
  });

  it("keeps county government distinct from municipalities", () => {
    expect(resolveJurisdiction("Hillsborough County government · Building")).toBe("hillsborough-county-building");
    expect(resolveJurisdiction("Tampa, Florida")).toBeNull();
    expect(resolveJurisdiction("Temple Terrace")).toBeNull();
  });
});
