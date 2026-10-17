import { describe, expect, it } from "vitest";
import {
  epermitRecordUrl,
  HILLSBOROUGH_ID,
  parseDisplayedStatus,
  parseEpermitNumber,
  parseRegPermittingNumber,
  parseWmisNumber,
  permitComparisonValue,
  permitNumberProblem,
  permitNumberSchema,
  parsePortalUrl,
  regPermittingRecordUrl,
  resolveJurisdiction,
  sameJurisdictionPermitNumber,
  samePermitNumber,
} from "../src/shared/permit.js";
import { getJurisdiction, JURISDICTIONS } from "../src/shared/jurisdictions.js";
import { defined } from "./support/defined.js";

const detailUrl =
  "https://aca-prod.accela.com/HCFL/Cap/CapDetail.aspx?Module=Building&TabName=Building&capID1=26CAP&capID2=00000&capID3=01Y33&agencyCode=HCFL";

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
    expect(parseDisplayedStatus({ ...candidate, statusValue: "Pending agency review — Phase 2" })).toMatchObject({
      _tag: "ok",
      value: { statusValue: "Pending agency review — Phase 2" },
    });
  });

  it("rejects wrong identities, including a changed digit and a lost leading zero", () => {
    expect(parseDisplayedStatus({ ...candidate, displayedNumber: "HC-BLD-26-0087598" })).toEqual({
      _tag: "err",
      outcome: "identity_mismatch",
    });
    expect(samePermitNumber("HC-BLD-26-0087599", "HC-BLD-26-087599")).toBe(false);
  });

  it("rejects an unrelated status field and an unqualified record link", () => {
    expect(parseDisplayedStatus({ ...candidate, statusLabel: "Inspection Status:" })).toEqual({
      _tag: "err",
      outcome: "status_unavailable",
    });
    expect(parseDisplayedStatus({ ...candidate, recordUrl: detailUrl.replace("/HCFL/", "/OTHER/") })).toEqual({
      _tag: "err",
      outcome: "record_link_unavailable",
    });
  });

  it("restricts record links to the official tenant and Building module", () => {
    expect(parsePortalUrl(detailUrl, "detail", HILLSBOROUGH_ID)).not.toBeNull();
    expect(
      parsePortalUrl(detailUrl.replace("Module=Building", "Module=Planning"), "detail", HILLSBOROUGH_ID),
    ).toBeNull();
    expect(
      parsePortalUrl(detailUrl.replace("agencyCode=HCFL", "agencyCode=OTHER"), "detail", HILLSBOROUGH_ID),
    ).toBeNull();
    expect(
      parsePortalUrl(
        detailUrl.replace("aca-prod.accela.com", "aca-prod.accela.com.evil.test"),
        "detail",
        HILLSBOROUGH_ID,
      ),
    ).toBeNull();
    expect(parsePortalUrl(`${detailUrl}&agencyCode=OTHER`, "detail", HILLSBOROUGH_ID)).toBeNull();
    expect(parsePortalUrl(`${detailUrl}&module=Planning`, "detail", HILLSBOROUGH_ID)).toBeNull();
  });

  it("keeps county government distinct from municipalities", () => {
    expect(resolveJurisdiction("Hillsborough County")).toBe("hillsborough-county-building");
    expect(resolveJurisdiction("Tampa, Florida")).toBeNull();
    expect(resolveJurisdiction("Temple Terrace")).toBeNull();
  });

  it("resolves each selected authority and keeps record links in its own portal", () => {
    expect(new Set(JURISDICTIONS.map((profile) => profile.id)).size).toBe(JURISDICTIONS.length);

    for (const profile of JURISDICTIONS) {
      expect(resolveJurisdiction(profile.id)).toBe(profile.id);
      expect(resolveJurisdiction(profile.label)).toBe(profile.id);
      expect(parsePortalUrl(profile.startUrl, "search", profile.id)).not.toBeNull();
    }

    const tampaDetail = detailUrl.replaceAll("HCFL", "TAMPA");
    expect(parsePortalUrl(tampaDetail, "detail", "tampa-building")).not.toBeNull();
    expect(parsePortalUrl(tampaDetail, "detail", "hillsborough-county-building")).toBeNull();
    expect(
      parsePortalUrl(
        "https://aca-prod.accela.com/PASCO/Cap/CapHome.aspx?module=Permits&TabName=Permits",
        "search",
        "pasco-county-building",
      ),
    ).not.toBeNull();
  });

  it("follows Global Search into each searched module, and only those modules", () => {
    const pasco =
      "https://aca-prod.accela.com/PASCO/Cap/CapDetail.aspx?Module=Planning&TabName=Planning&capID1=REC26&capID2=00000&capID3=0029W&agencyCode=PASCO";

    expect(
      parsePortalUrl("https://aca-prod.accela.com/PASCO/Default.aspx", "search", "pasco-county-building"),
    ).not.toBeNull();
    expect(
      parsePortalUrl(
        "https://aca-prod.accela.com/PASCO/Cap/GlobalSearchResults.aspx?QueryText=SDP-2026-00005",
        "search",
        "pasco-county-building",
      ),
    ).not.toBeNull();
    expect(parsePortalUrl(pasco, "detail", "pasco-county-building")).not.toBeNull();
    expect(parsePortalUrl(pasco.replaceAll("Planning", "Licenses"), "detail", "pasco-county-building")).toBeNull();
    const landDevelopment = detailUrl.replaceAll("Building", "LandDevelopment");
    expect(parsePortalUrl(landDevelopment, "detail", HILLSBOROUGH_ID)).not.toBeNull();
    expect(
      parsePortalUrl(detailUrl.replaceAll("Building", "Administrative"), "detail", HILLSBOROUGH_ID),
    ).not.toBeNull();
    expect(
      parseDisplayedStatus({
        ...candidate,
        requestedNumber: "HC-MINSITE-26-0000079",
        displayedNumber: "HC-MINSITE-26-0000079",
        recordUrl: landDevelopment,
      }),
    ).toMatchObject({ _tag: "ok" });
    expect(parsePortalUrl(detailUrl.replaceAll("Building", "Licenses"), "detail", HILLSBOROUGH_ID)).toBeNull();
    // Tampa searches only its Building module.
    expect(parsePortalUrl(landDevelopment.replaceAll("HCFL", "TAMPA"), "detail", "tampa-building")).toBeNull();
    expect(
      parsePortalUrl(
        "https://aca-prod.accela.com/TAMPA/Cap/GlobalSearchResults.aspx?QueryText=X",
        "search",
        "tampa-building",
      ),
    ).toBeNull();
  });

  it("accepts revision record numbers with a dot", () => {
    expect(permitNumberSchema.safeParse("COMALT-2025-000297.R01").success).toBe(true);
    expect(permitNumberSchema.safeParse(".R01").success).toBe(false);
  });

  it("accepts Tyler's permit status but not a status from another authority", () => {
    const hernando = {
      ...candidate,
      jurisdictionId: "hernando-county-building" as const,
      requestedNumber: "BLDR-004412-2026",
      displayedNumber: "BLDR-004412-2026",
      statusLabel: "Status:",
      statusValue: "Issued",
      recordUrl:
        "https://hernandocountyfl-energovweb.tylerhost.net/apps/selfservice/hernandocountyflprod#/permit/d342dc84-196f-4f0e-b14b-1cee8bd7bcc6",
    };

    expect(parseDisplayedStatus(hernando)).toMatchObject({ _tag: "ok", value: { statusValue: "Issued" } });
    expect(parseDisplayedStatus({ ...hernando, statusLabel: "Inspection Status:" })).toEqual({
      _tag: "err",
      outcome: "status_unavailable",
    });
    expect(parseDisplayedStatus({ ...hernando, recordUrl: detailUrl })).toEqual({
      _tag: "err",
      outcome: "record_link_unavailable",
    });
  });

  it("rejects a status field from another portal family", () => {
    const tampa = {
      ...candidate,
      recordUrl: detailUrl.replaceAll("HCFL", "TAMPA"),
      jurisdictionId: "tampa-building" as const,
    };

    expect(parseDisplayedStatus(tampa)).toMatchObject({ _tag: "ok" });
    expect(parseDisplayedStatus({ ...tampa, statusLabel: "Application Status:" })).toEqual({
      _tag: "err",
      outcome: "status_unavailable",
    });
  });

  it("compares St. Petersburg's displayed serial with its zero-padded application number", () => {
    const recordUrl =
      "https://stpe-egov.aspgov.com/Click2GovBP/selectpermit.html?permit.appYear=25&permit.appNumber=05001277&searchType=0&validatePermitView=true";

    expect(sameJurisdictionPermitNumber("25-05001277", "25 - 5001277", "st-petersburg-building")).toBe(true);
    expect(sameJurisdictionPermitNumber("25-05001277", "25 - 5001278", "st-petersburg-building")).toBe(false);
    expect(
      parseDisplayedStatus({
        ...candidate,
        jurisdictionId: "st-petersburg-building",
        requestedNumber: "25-05001277",
        displayedNumber: "25 - 5001277",
        statusLabel: "Application Status:",
        statusValue: "CLOSED",
        recordUrl,
      }),
    ).toMatchObject({ _tag: "ok", value: { statusValue: "CLOSED" } });
    expect(parsePortalUrl(recordUrl, "detail", "st-petersburg-building")).not.toBeNull();
    expect(
      parsePortalUrl(
        "https://stpe-egov.aspgov.com/Click2GovBP/selectpermit.html?initialSearchView=true",
        "detail",
        "st-petersburg-building",
      ),
    ).toBeNull();
  });
});

describe("hand-checked portal links", () => {
  it("accept only HTTPS pages on the authority's own portal host", () => {
    expect(
      parsePortalUrl(
        "https://fasttrack.ocfl.net/OnlineServices/permit-building.aspx?id=1",
        "detail",
        "orange-county-building",
      ),
    ).not.toBeNull();
    expect(
      parsePortalUrl("https://ims.palmbayfl.gov/ims/Find?bNewSearch=true&cat=Permit", "detail", "palm-bay-building"),
    ).not.toBeNull();
    expect(parsePortalUrl("http://fasttrack.ocfl.net/OnlineServices/", "detail", "orange-county-building")).toBeNull();
    expect(parsePortalUrl("https://evil.example/fasttrack.ocfl.net", "detail", "orange-county-building")).toBeNull();
    expect(parsePortalUrl("https://ims.palmbayfl.gov/ims/", "detail", "orange-county-building")).toBeNull();
    expect(
      parsePortalUrl(
        "https://permits.bakercountyfl.org/permits?qr=13fafd9557bd7244d7fecbf073119784&t=0",
        "detail",
        "baker-county-building",
      ),
    ).not.toBeNull();
    expect(parsePortalUrl("https://www.bakercountyfl.org/permits", "detail", "baker-county-building")).toBeNull();
  });
});

describe("SWFWMD WMIS records", () => {
  const erp = "https://www38.swfwmd.state.fl.us/ERP/ERP/Entry/ERP.aspx?id=1001157";
  const erpHeading = "ERP Permit: 47590.008 (App: 1001157) · Prefix 43";

  const erpCandidate = {
    ...candidate,
    jurisdictionId: "swfwmd-erp" as const,
    requestedNumber: "43047590.008",
    displayedNumber: erpHeading,
    statusLabel: "Status:",
    statusValue: "Approved",
    recordUrl: erp,
  };

  it("accepts the numbers each search takes, and nothing else", () => {
    expect(parseWmisNumber("43047590.008", "ERP")).toEqual({
      kind: "permit",
      prefix: "43",
      permit: 47590,
      revision: 8,
    });
    expect(parseWmisNumber("47590.008", "ERP")).toEqual({ kind: "permit", prefix: null, permit: 47590, revision: 8 });
    expect(parseWmisNumber("1001157", "ERP")).toEqual({ kind: "application", id: 1001157 });
    expect(parseWmisNumber("1960.023", "WUP")).toEqual({ kind: "permit", prefix: null, permit: 1960, revision: 23 });
    expect(parseWmisNumber("973309", "WCP")).toEqual({ kind: "well", permit: 973309 });
    // A seven-digit serial can't be split into a prefix and serial, and water use and well numbers have no prefix or app ID.
    expect(parseWmisNumber("4347590.008", "ERP")).toBeNull();
    expect(parseWmisNumber("20001960.023", "WUP")).toBeNull();
    expect(parseWmisNumber("1960", "WUP")).toBeNull();
    expect(parseWmisNumber("973309.1", "WCP")).toBeNull();
    expect(parseWmisNumber("0.001", "ERP")).toBeNull();
    expect(permitNumberProblem("swfwmd-wup", "1960")).toBe(
      "Use the number as the district writes it, for example 1960.023.",
    );
    expect(permitNumberProblem("swfwmd-erp", "1001157")).toBeNull();
    expect(permitNumberProblem("st-petersburg-building", "25-05001277")).toBeNull();
    expect(permitNumberProblem(HILLSBOROUGH_ID, "HC-BLD-26-0087599")).toBeNull();
  });

  it("saves the prefixed, short, and zero-padded forms of one permit as one permit", () => {
    expect(permitComparisonValue("43047590.008", "swfwmd-erp")).toBe(permitComparisonValue("047590.8", "swfwmd-erp"));
    expect(permitComparisonValue("1001157", "swfwmd-erp")).not.toBe(permitComparisonValue("1001157.000", "swfwmd-erp"));
    expect(permitComparisonValue("001960.023", "swfwmd-wup")).toBe("1960.23");
  });

  it("matches the ERP heading by permit and revision, type prefix, or application ID", () => {
    expect(sameJurisdictionPermitNumber("43047590.008", erpHeading, "swfwmd-erp")).toBe(true);
    expect(sameJurisdictionPermitNumber("47590.008", erpHeading, "swfwmd-erp")).toBe(true);
    expect(sameJurisdictionPermitNumber("1001157", erpHeading, "swfwmd-erp")).toBe(true);
    expect(sameJurisdictionPermitNumber("44047590.008", erpHeading, "swfwmd-erp")).toBe(false);
    expect(sameJurisdictionPermitNumber("43047590.008", "ERP Permit: 47590.008 (App: 1001157)", "swfwmd-erp")).toBe(
      false,
    );
    expect(sameJurisdictionPermitNumber("47590.009", erpHeading, "swfwmd-erp")).toBe(false);
    expect(sameJurisdictionPermitNumber("1001158", erpHeading, "swfwmd-erp")).toBe(false);
    expect(sameJurisdictionPermitNumber("942840", "ERP Permit Application: 942840 · Prefix 46", "swfwmd-erp")).toBe(
      true,
    );
    expect(sameJurisdictionPermitNumber("1000558", "Exemption Application: 1000558", "swfwmd-erp")).toBe(true);
    expect(sameJurisdictionPermitNumber("973309", "WCP Detail - 973309", "swfwmd-wcp")).toBe(true);
    expect(sameJurisdictionPermitNumber("973309", "WCP Detail - 973308", "swfwmd-wcp")).toBe(false);
  });

  it("keeps searches on the search host and record pages on the record host, over HTTPS", () => {
    expect(parsePortalUrl(erp, "detail", "swfwmd-erp")).not.toBeNull();
    expect(parsePortalUrl(erp.replace("https:", "http:"), "detail", "swfwmd-erp")).toBeNull();
    expect(parsePortalUrl(`${erp}&UniquePageID=6a33d6ae`, "detail", "swfwmd-erp")).toBeNull();
    expect(parsePortalUrl(erp.replace("id=1001157", "id=1001157x"), "detail", "swfwmd-erp")).toBeNull();
    expect(parsePortalUrl(erp.replace("www38", "www18"), "detail", "swfwmd-erp")).toBeNull();
    expect(parsePortalUrl(erp, "detail", "swfwmd-wcp")).toBeNull();
    expect(
      parsePortalUrl(
        "https://www38.swfwmd.state.fl.us/Support/WCP/WcpDetail.aspx?permit=973309",
        "detail",
        "swfwmd-wcp",
      ),
    ).not.toBeNull();
    expect(
      parsePortalUrl(
        "https://www38.swfwmd.state.fl.us/Support/WUP/WupSimple.aspx?st=1960&rev=23",
        "detail",
        "swfwmd-wup",
      ),
    ).not.toBeNull();
    expect(
      parsePortalUrl("https://www38.swfwmd.state.fl.us/erp/erp/search/ERPSearch.aspx", "search", "swfwmd-erp"),
    ).toBeNull();
    expect(
      parsePortalUrl("https://www18.swfwmd.state.fl.us/erp/erp/search/ERPSearch.aspx?x=1", "search", "swfwmd-erp"),
    ).toBeNull();
  });

  it("accepts each program's own status field on a link to the same record", () => {
    expect(parseDisplayedStatus(erpCandidate)).toMatchObject({ _tag: "ok", value: { statusValue: "Approved" } });
    expect(parseDisplayedStatus({ ...erpCandidate, recordUrl: erp.replace("1001157", "1001156") })).toEqual({
      _tag: "err",
      outcome: "record_link_unavailable",
    });
    expect(parseDisplayedStatus({ ...erpCandidate, statusLabel: "Permit Status" })).toEqual({
      _tag: "err",
      outcome: "status_unavailable",
    });

    const water = {
      ...candidate,
      jurisdictionId: "swfwmd-wup" as const,
      requestedNumber: "1960.023",
      displayedNumber: "1960.023",
      statusLabel: "Permit Status",
      statusValue: "Approved",
      recordUrl: "https://www38.swfwmd.state.fl.us/Support/WUP/WupSimple.aspx?st=1960&rev=23",
    };

    expect(parseDisplayedStatus(water)).toMatchObject({ _tag: "ok", value: { statusValue: "Approved" } });
    expect(parseDisplayedStatus({ ...water, recordUrl: water.recordUrl.replace("rev=23", "rev=22") })).toEqual({
      _tag: "err",
      outcome: "record_link_unavailable",
    });

    const well = {
      ...candidate,
      jurisdictionId: "swfwmd-wcp" as const,
      requestedNumber: "973309",
      displayedNumber: "WCP Detail - 973309",
      statusLabel: "Application Status:",
      statusValue: "UNDER REVIEW",
      recordUrl: "https://www38.swfwmd.state.fl.us/Support/WCP/WcpDetail.aspx?permit=973309",
    };

    expect(parseDisplayedStatus(well)).toMatchObject({ _tag: "ok", value: { statusValue: "UNDER REVIEW" } });
  });
});

describe("St. Johns River-hosted ePermit records", () => {
  const nw = "https://permitting.sjrwmd.com/nwep/#/prmtInfo?curId=&hdr=1&usrId=0&offclId=6688&seqNo=3";

  const record = {
    ...candidate,
    jurisdictionId: "nwfwmd" as const,
    requestedNumber: "2E-131-6688-3",
    displayedNumber: "2E-131-6688-3 · Project Number 6688 - 3",
    statusLabel: "Status · Current Process Stage",
    statusValue: "Pending · Pending RAI Response",
    recordUrl: nw,
  };

  it("splits a number into its prefix, number, and sequence, with or without a prefix", () => {
    expect(parseEpermitNumber("ERP-123-255799-1")).toEqual({ prefix: "ERP-123", permit: 255799, sequence: 1 });
    expect(parseEpermitNumber("2e-131-6688-3")).toEqual({ prefix: "2E-131", permit: 6688, sequence: 3 });
    expect(parseEpermitNumber("219072-3")).toEqual({ prefix: null, permit: 219072, sequence: 3 });
    expect(parseEpermitNumber("219072")).toBeNull();
    // A number missing its sequence can't be split into Permit # and Sequence #.
    expect(parseEpermitNumber("ERP-123-255799")).toBeNull();
    expect(permitNumberProblem("sjrwmd", "219072")).toBe(
      "Use the number as the district writes it, for example 219072-3.",
    );
    expect(permitComparisonValue("ERP-123-255799-1", "srwmd")).toBe(permitComparisonValue("255799-01", "srwmd"));
  });

  it("matches the result row's full number together with the record's Project Number", () => {
    expect(sameJurisdictionPermitNumber("2E-131-6688-3", record.displayedNumber, "nwfwmd")).toBe(true);
    expect(sameJurisdictionPermitNumber("6688-3", record.displayedNumber, "nwfwmd")).toBe(true);
    expect(sameJurisdictionPermitNumber("2E-999-6688-3", record.displayedNumber, "nwfwmd")).toBe(false);
    expect(sameJurisdictionPermitNumber("2E-131-6688-3", "2E-131-6688-3 · Project Number 6688 - 2", "nwfwmd")).toBe(
      false,
    );
    expect(sameJurisdictionPermitNumber("2E-131-6688-3", "2E-131-6688-3", "nwfwmd")).toBe(false);
    expect(sameJurisdictionPermitNumber("219072-3", "219072-3 · Project Number 219072 - 3", "sjrwmd")).toBe(true);
  });

  it("keeps each district's search and Copy Link records in its own app", () => {
    expect(parsePortalUrl("https://permitting.sjrwmd.com/nwep/#/ep", "search", "nwfwmd")).not.toBeNull();
    expect(parsePortalUrl("https://permitting.sjrwmd.com/nwep/#/home", "search", "nwfwmd")).toBeNull();
    expect(parsePortalUrl(nw, "detail", "nwfwmd")).not.toBeNull();
    expect(parsePortalUrl(nw, "detail", "srwmd")).toBeNull();
    expect(parsePortalUrl(nw.replace("seqNo=3", "seqNo=3&x=1"), "detail", "nwfwmd")).toBeNull();
    expect(epermitRecordUrl(defined(getJurisdiction("nwfwmd"), "the nwfwmd profile"), "2E-131-6688-3")).toBe(nw);
  });

  it("saves the combined status on a link to the same number and sequence", () => {
    expect(parseDisplayedStatus(record)).toMatchObject({
      _tag: "ok",
      value: { statusValue: "Pending · Pending RAI Response" },
    });
    expect(parseDisplayedStatus({ ...record, recordUrl: nw.replace("seqNo=3", "seqNo=2") })).toEqual({
      _tag: "err",
      outcome: "record_link_unavailable",
    });
    expect(parseDisplayedStatus({ ...record, statusLabel: "Status" })).toEqual({
      _tag: "err",
      outcome: "status_unavailable",
    });
  });
});

describe("SFWMD RegPermitting records", () => {
  const sfwmd = defined(getJurisdiction("sfwmd"), "the sfwmd profile");

  const permitUrl = defined(
    regPermittingRecordUrl(sfwmd, "SFWMD-REG-PERMIT-WORK 48-112909-P"),
    "an ERP permit record link",
  );

  const permit = {
    ...candidate,
    jurisdictionId: "sfwmd" as const,
    requestedNumber: "48-112909-P",
    displayedNumber: "48-112909-P",
    statusLabel: "Permit Status",
    statusValue: "Approved",
    recordUrl: permitUrl,
  };

  it("accepts application numbers and ERP, water use, and well construction permit numbers", () => {
    expect(parseRegPermittingNumber("260901-67337")).toEqual({ kind: "application", number: "260901-67337" });
    expect(parseRegPermittingNumber("48-112909-p")).toEqual({ kind: "permit", number: "48-112909-P" });
    expect(parseRegPermittingNumber("36-00142-S-73")).toMatchObject({ kind: "permit" });
    expect(parseRegPermittingNumber("44-117840-WC")).toMatchObject({ kind: "permit" });
    // EAA and C-139 permits show no status.
    expect(parseRegPermittingNumber("50-00024-E")).toBeNull();
    expect(permitNumberProblem("sfwmd", "50-00024-E")).not.toBeNull();
  });

  it("links to a record by the key its record view carries, and nothing else", () => {
    expect(permitUrl).toBe(
      "https://apps.sfwmd.gov/prweb/PRAuth/RegExternal?pyActivity=%40baseclass.doUIAction&action=openWorkByHandle&key=SFWMD-REG-PERMIT-WORK%2048-112909-P",
    );
    expect(parsePortalUrl(permitUrl, "detail", "sfwmd")).not.toBeNull();
    expect(regPermittingRecordUrl(sfwmd, "SFWMD-ROW-WORK 10041")).toBeNull();
    expect(parsePortalUrl(permitUrl.replace("PERMIT-WORK", "ROW-WORK"), "detail", "sfwmd")).toBeNull();
    expect(parsePortalUrl(`${permitUrl}&x=1`, "detail", "sfwmd")).toBeNull();
    expect(
      parsePortalUrl(
        "https://apps.sfwmd.gov/prweb/PRAuth/app/RegulationExternal/Bf3e1VeqoUmE2OCqYZzon9lNIoWs6WGdqwSWjMsfkr8*/!STANDARD?pzuiactionrrr=abc",
        "search",
        "sfwmd",
      ),
    ).not.toBeNull();
    expect(
      parsePortalUrl("https://apps.sfwmd.gov/prweb/PRAuth/app/RegulationExternal/x/!STANDARD", "detail", "sfwmd"),
    ).toBeNull();
    expect(parsePortalUrl("https://webauth.sfwmd.gov/login", "search", "sfwmd")).toBeNull();
  });

  it("reads a permit's Permit Status and an application's own status, never the other", () => {
    expect(parseDisplayedStatus(permit)).toMatchObject({ _tag: "ok", value: { statusValue: "Approved" } });
    expect(parseDisplayedStatus({ ...permit, statusLabel: "Application Status" })).toEqual({
      _tag: "err",
      outcome: "status_unavailable",
    });

    const application = {
      ...permit,
      requestedNumber: "260915-67760",
      displayedNumber: "260915-67760",
      statusLabel: "App Status",
      statusValue: "Pending-TechnicalReview",
      recordUrl: defined(
        regPermittingRecordUrl(sfwmd, "SFWMD-REG-WUPERMIT-WORK 260915-67760"),
        "a water use application record link",
      ),
    };

    expect(parseDisplayedStatus(application)).toMatchObject({
      _tag: "ok",
      value: { statusValue: "Pending-TechnicalReview" },
    });
    expect(parseDisplayedStatus({ ...application, statusLabel: "Permit Status" })).toEqual({
      _tag: "err",
      outcome: "status_unavailable",
    });
    expect(
      parseDisplayedStatus({
        ...permit,
        recordUrl: defined(
          regPermittingRecordUrl(sfwmd, "SFWMD-REG-PERMIT-WORK 48-112909-M"),
          "a modified ERP permit record link",
        ),
      }),
    ).toEqual({ _tag: "err", outcome: "record_link_unavailable" });
  });
});
