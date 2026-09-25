import { describe, expect, it } from "vitest";
import { HILLSBOROUGH_ID, parseDisplayedStatus, parsePortalUrl, resolveJurisdiction, sameJurisdictionPermitNumber, samePermitNumber } from "../src/shared/permit.js";
import { JURISDICTIONS } from "../src/shared/jurisdictions.js";

const detailUrl = "https://aca-prod.accela.com/HCFL/Cap/CapDetail.aspx?Module=Building&TabName=Building&capID1=26CAP&capID2=00000&capID3=01Y33&agencyCode=HCFL";
const candidate = {
  jurisdictionId: HILLSBOROUGH_ID,
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
    expect(parsePortalUrl(detailUrl, "detail", HILLSBOROUGH_ID)).not.toBeNull();
    expect(parsePortalUrl(detailUrl.replace("Module=Building", "Module=Planning"), "detail", HILLSBOROUGH_ID)).toBeNull();
    expect(parsePortalUrl(detailUrl.replace("agencyCode=HCFL", "agencyCode=OTHER"), "detail", HILLSBOROUGH_ID)).toBeNull();
    expect(parsePortalUrl(detailUrl.replace("aca-prod.accela.com", "aca-prod.accela.com.evil.test"), "detail", HILLSBOROUGH_ID)).toBeNull();
    expect(parsePortalUrl(`${detailUrl}&agencyCode=OTHER`, "detail", HILLSBOROUGH_ID)).toBeNull();
    expect(parsePortalUrl(`${detailUrl}&module=Planning`, "detail", HILLSBOROUGH_ID)).toBeNull();
  });

  it("keeps county government distinct from municipalities", () => {
    expect(resolveJurisdiction("Hillsborough County government · Building")).toBe("hillsborough-county-building");
    expect(resolveJurisdiction("Tampa, Florida")).toBeNull();
    expect(resolveJurisdiction("Temple Terrace")).toBeNull();
  });

  it("resolves each selected authority and keeps record links in its own portal", () => {
    expect(JURISDICTIONS).toHaveLength(9);
    for (const profile of JURISDICTIONS) {
      expect(resolveJurisdiction(profile.id)).toBe(profile.id);
      expect(resolveJurisdiction(profile.label)).toBe(profile.id);
      expect(parsePortalUrl(profile.startUrl, "search", profile.id)).not.toBeNull();
    }
    const tampaDetail = detailUrl.replaceAll("HCFL", "TAMPA");
    expect(parsePortalUrl(tampaDetail, "detail", "tampa-building")).not.toBeNull();
    expect(parsePortalUrl(tampaDetail, "detail", "hillsborough-county-building")).toBeNull();
    expect(parsePortalUrl("https://aca-prod.accela.com/PASCO/Cap/CapHome.aspx?module=Permits&TabName=Permits",
      "search", "pasco-county-building")).not.toBeNull();
  });

  it("accepts Tyler's permit status but not a status from another authority", () => {
    const hernando = { ...candidate, jurisdictionId: "hernando-county-building" as const,
      requestedNumber: "BLDR-004412-2026", displayedNumber: "BLDR-004412-2026", statusLabel: "Status:",
      statusValue: "Issued",
      recordUrl: "https://hernandocountyfl-energovweb.tylerhost.net/apps/selfservice/hernandocountyflprod#/permit/d342dc84-196f-4f0e-b14b-1cee8bd7bcc6" };
    expect(parseDisplayedStatus(hernando)).toMatchObject({ _tag: "ok", value: { statusValue: "Issued" } });
    expect(parseDisplayedStatus({ ...hernando, statusLabel: "Inspection Status:" }))
      .toEqual({ _tag: "err", outcome: "status_unavailable" });
    expect(parseDisplayedStatus({ ...hernando, recordUrl: detailUrl }))
      .toEqual({ _tag: "err", outcome: "record_link_unavailable" });
  });

  it("rejects a status field from another portal family", () => {
    const tampa = { ...candidate, recordUrl: detailUrl.replaceAll("HCFL", "TAMPA"), jurisdictionId: "tampa-building" as const };
    expect(parseDisplayedStatus(tampa)).toMatchObject({ _tag: "ok" });
    expect(parseDisplayedStatus({ ...tampa, statusLabel: "Application Status:" }))
      .toEqual({ _tag: "err", outcome: "status_unavailable" });
  });

  it("compares St. Petersburg's displayed serial with its zero-padded application number", () => {
    const recordUrl = "https://stpe-egov.aspgov.com/Click2GovBP/selectpermit.html?permit.appYear=25&permit.appNumber=05001277&searchType=0&validatePermitView=true";
    expect(sameJurisdictionPermitNumber("25-05001277", "25 - 5001277", "st-petersburg-building")).toBe(true);
    expect(sameJurisdictionPermitNumber("25-05001277", "25 - 5001278", "st-petersburg-building")).toBe(false);
    expect(parseDisplayedStatus({ ...candidate, jurisdictionId: "st-petersburg-building",
      requestedNumber: "25-05001277", displayedNumber: "25 - 5001277", statusLabel: "Application Status:",
      statusValue: "CLOSED", recordUrl })).toMatchObject({ _tag: "ok", value: { statusValue: "CLOSED" } });
    expect(parsePortalUrl(recordUrl, "detail", "st-petersburg-building")).not.toBeNull();
    expect(parsePortalUrl("https://stpe-egov.aspgov.com/Click2GovBP/selectpermit.html?initialSearchView=true",
      "detail", "st-petersburg-building")).toBeNull();
  });
});

describe("hand-checked portal links", () => {
  it("accept only HTTPS pages on the authority's own portal host", () => {
    expect(parsePortalUrl("https://fasttrack.ocfl.net/OnlineServices/permit-building.aspx?id=1", "detail", "orange-county-building")).not.toBeNull();
    expect(parsePortalUrl("https://ims.palmbayfl.gov/ims/Find?bNewSearch=true&cat=Permit", "detail", "palm-bay-building")).not.toBeNull();
    expect(parsePortalUrl("http://fasttrack.ocfl.net/OnlineServices/", "detail", "orange-county-building")).toBeNull();
    expect(parsePortalUrl("https://evil.example/fasttrack.ocfl.net", "detail", "orange-county-building")).toBeNull();
    expect(parsePortalUrl("https://ims.palmbayfl.gov/ims/", "detail", "orange-county-building")).toBeNull();
  });
});
