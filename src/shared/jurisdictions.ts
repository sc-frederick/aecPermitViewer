/** Public permit authorities and the portal that issues each record. */
export const JURISDICTIONS = [
  {
    id: "hillsborough-county-building",
    label: "Hillsborough County",
    authorityType: "county-government",
    portalFamily: "accela",
    startUrl: "https://aca-prod.accela.com/HCFL/Cap/CapHome.aspx?module=Building&TabName=Building",
    tenant: "HCFL",
    module: "Building",
    // HillsGovHub's Global Search finds a record number in any of these modules.
    globalSearch: true,
    modules: ["Building", "LandDevelopment", "Fire", "Enforcement", "Administrative"],
    coverageNote: "County government records in HillsGovHub, found with its Global Search across Building, Land Development (including utility and site permits), Fire, Enforcement, and Administrative; municipalities are separate authorities.",
    adapterVersion: "accela-global-reviews-1",
  },
  {
    id: "pasco-county-building",
    label: "Pasco County",
    authorityType: "county-government",
    portalFamily: "accela",
    startUrl: "https://aca-prod.accela.com/PASCO/Default.aspx",
    tenant: "PASCO",
    module: "Building",
    // PascoGateway's home-page Global Search finds a record number in any of these modules.
    globalSearch: true,
    modules: ["Building", "Permits", "Planning", "Enforcement"],
    coverageNote: "Pasco County records in PascoGateway, found with its Global Search across Building, Permits, Planning, and Enforcement.",
    adapterVersion: "accela-global-reviews-1",
  },
  {
    id: "tampa-building",
    label: "City of Tampa",
    authorityType: "municipality",
    portalFamily: "accela",
    startUrl: "https://aca-prod.accela.com/TAMPA/Cap/CapHome.aspx?module=Building&TabName=Building",
    tenant: "TAMPA",
    module: "Building",
    coverageNote: "City of Tampa Building records in the city's Accela portal.",
    adapterVersion: "accela-reviews-1",
  },
  {
    id: "pinellas-county-building",
    label: "Pinellas County",
    authorityType: "county-government",
    portalFamily: "accela",
    startUrl: "https://aca-prod.accela.com/PINELLAS/Cap/CapHome.aspx?module=Building&TabName=Building",
    tenant: "PINELLAS",
    module: "Building",
    coverageNote: "County and partner-community Building records in the Pinellas County Access Portal.",
    adapterVersion: "accela-reviews-1",
  },
  {
    id: "st-petersburg-building",
    label: "City of St. Petersburg",
    authorityType: "municipality",
    portalFamily: "click2gov",
    startUrl: "https://stpe-egov.aspgov.com/Click2GovBP/selectpermit.html?initialSearchView=true",
    tenant: "",
    module: "Building",
    numberExample: "25-05001277",
    coverageNote: "City of St. Petersburg Building permits in Click2Gov. Enter the application number as YY-serial, for example 25-05001277.",
    adapterVersion: "click2gov-1",
  },
  {
    id: "hernando-county-building",
    label: "Hernando County",
    authorityType: "county-government",
    portalFamily: "tyler-civic-access",
    startUrl: "https://hernandocountyfl-energovweb.tylerhost.net/apps/selfservice",
    tenant: "",
    module: "Building",
    coverageNote: "Tyler Civic Access public records. The county keeps earlier permits in a separate legacy portal.",
    adapterVersion: "tyler-1",
  },
  {
    id: "polk-county-building",
    label: "Polk County",
    authorityType: "county-government",
    portalFamily: "accela",
    startUrl: "https://aca-prod.accela.com/POLKCO/Cap/CapHome.aspx?module=Building&TabName=Building",
    tenant: "POLKCO",
    module: "Building",
    coverageNote: "Polk County Building records in Accela; historical permits use a separate county lookup.",
    adapterVersion: "accela-reviews-1",
  },
  // SWFWMD's public WMIS searches each cover one permit program. Record pages are served from a second host.
  {
    id: "swfwmd-erp",
    label: "SWFWMD · Environmental resource permit",
    authorityType: "water-management-district",
    portalFamily: "wmis",
    startUrl: "https://www18.swfwmd.state.fl.us/erp/erp/search/ERPSearch.aspx",
    recordHost: "www38.swfwmd.state.fl.us",
    tenant: "",
    module: "ERP",
    statusLabel: "Status",
    numberExample: "43047590.008 or 1001157",
    coverageNote: "Southwest Florida Water Management District ERP records in its public WMIS search. Enter the permit number with its revision, such as 43047590.008 or 47590.008, or the application ID, such as 1001157. WMIS shows Incomplete while an application is pending; the review stage is visible only after signing in to ePermitting.",
    adapterVersion: "wmis-1",
  },
  {
    id: "swfwmd-wup",
    label: "SWFWMD · Water use permit",
    authorityType: "water-management-district",
    portalFamily: "wmis",
    startUrl: "https://www18.swfwmd.state.fl.us/search/search/searchwupsimple.aspx",
    recordHost: "www38.swfwmd.state.fl.us",
    tenant: "",
    module: "WUP",
    statusLabel: "Permit Status",
    numberExample: "1960.023",
    coverageNote: "Southwest Florida Water Management District water use permits in its public WMIS search. Enter the permit number with its revision, such as 1960.023. The status is read from the search results, the only place the portal shows it.",
    adapterVersion: "wmis-1",
  },
  {
    id: "swfwmd-wcp",
    label: "SWFWMD · Well construction permit",
    authorityType: "water-management-district",
    portalFamily: "wmis",
    startUrl: "https://www18.swfwmd.state.fl.us/search/search/wcpsimple.aspx",
    recordHost: "www38.swfwmd.state.fl.us",
    tenant: "",
    module: "WCP",
    statusLabel: "Application Status",
    numberExample: "973309",
    coverageNote: "Southwest Florida Water Management District well construction permits in its public WMIS search. Enter the permit number, such as 973309.",
    adapterVersion: "wmis-1",
  },
  {
    id: "sfwmd",
    label: "SFWMD · All permits",
    authorityType: "water-management-district",
    portalFamily: "regpermitting",
    startUrl: "https://apps.sfwmd.gov/prweb/PRAuth/RegExternal",
    tenant: "",
    module: "All",
    statusLabels: ["Permit Status", "Application Status", "App Status"],
    // The district's firewall turns away browsers that name themselves HeadlessChrome, though its search is public.
    plainUserAgent: true,
    numberExample: "48-112909-P or 260901-67337",
    coverageNote: "South Florida Water Management District ERP, water use, and well construction records in RegPermitting's public Search Records. Enter an application number, such as 260901-67337, or a permit number, such as 48-112909-P. Right of way permits and EAA and C-139 permits aren't included.",
    adapterVersion: "regpermitting-1",
  },
  // St. Johns River WMD hosts one ePermit app per district. One search covers every permit type. The result's
  // Status and the record's Current Process Stage are saved together, because Status stays Pending through review.
  {
    id: "sjrwmd",
    label: "SJRWMD · All permits",
    authorityType: "water-management-district",
    portalFamily: "epermit",
    startUrl: "https://permitting.sjrwmd.com/ep/#/ep?target=srch",
    tenant: "",
    module: "All",
    statusLabel: "Status · Current Process Stage",
    numberExample: "219072-3",
    coverageNote: "St. Johns River Water Management District ERP, consumptive use, and well construction records in its ePermit search, which updates nightly and can take up to a minute to answer. Enter the permit number with its sequence, such as 219072-3.",
    adapterVersion: "epermit-1",
  },
  {
    id: "srwmd",
    label: "SRWMD · All permits",
    authorityType: "water-management-district",
    portalFamily: "epermit",
    startUrl: "https://permitting.sjrwmd.com/srep/#/ep?target=srch",
    tenant: "",
    module: "All",
    statusLabel: "Status · Current Process Stage",
    numberExample: "ERP-123-255799-1",
    coverageNote: "Suwannee River Water Management District ERP, water use, and well construction records in its ePermit search, which updates nightly. Enter the full number, such as ERP-123-255799-1 or 2-121-222487-2.",
    adapterVersion: "epermit-1",
  },
  {
    id: "nwfwmd",
    label: "NWFWMD · All permits",
    authorityType: "water-management-district",
    portalFamily: "epermit",
    startUrl: "https://permitting.sjrwmd.com/nwep/#/ep?target=srch",
    tenant: "",
    module: "All",
    statusLabel: "Status · Current Process Stage",
    numberExample: "IND-113-18663-5",
    coverageNote: "Northwest Florida Water Management District ERP, water use, and well construction records in its ePermit search, which updates nightly. Enter the full number, such as IND-113-18663-5 or 2E-131-6688-3.",
    adapterVersion: "epermit-1",
  },
  // None of these portals allows an anonymous automated lookup, so they are checked by hand: the app opens
  // the official search and records the status the user reads there.
  {
    id: "orange-county-building",
    label: "Orange County",
    authorityType: "county-government",
    portalFamily: "manual",
    startUrl: "https://fasttrack.ocfl.net/OnlineServices/PermitsAllTypes.aspx",
    tenant: "",
    module: "Building",
    coverageNote: "Checked by hand. Fast Track asks for human verification on each search, so Check now opens it and you enter the status you see.",
    adapterVersion: "manual-1",
  },
  {
    id: "palm-bay-building",
    label: "City of Palm Bay",
    authorityType: "municipality",
    portalFamily: "manual",
    startUrl: "https://ims.palmbayfl.gov/ims/Find?bNewSearch=true&cat=Permit",
    tenant: "",
    module: "Building",
    coverageNote: "Checked by hand. The city's iMS search requires a login, so Check now opens it and you enter the status you see.",
    adapterVersion: "manual-1",
  },
  // The Permit Search is public, but Cloudflare turns away headless browsers. The qr value is the MD5 of the
  // search page's name, corePermitByNumber, so the link stays put.
  {
    id: "baker-county-building",
    label: "Baker County",
    authorityType: "county-government",
    portalFamily: "manual",
    startUrl: "https://permits.bakercountyfl.org/permits?qr=13fafd9557bd7244d7fecbf073119784&t=0",
    tenant: "",
    module: "Building",
    numberExample: "202600500",
    coverageNote: "Checked by hand. The county's Permit Search is public but blocks automated browsers, so Check now opens it and you enter the status you see. Paste the full number, such as 202600500. The City of Macclenny issues its own permits.",
    adapterVersion: "manual-1",
  },
] as const;

/** One authority supported by the permit selector. */
export type JurisdictionProfile = (typeof JURISDICTIONS)[number];

/** An authority the browser worker can search on its own. */
export type AutomatedJurisdictionProfile = Exclude<JurisdictionProfile, { portalFamily: "manual" }>;

/** Stable identifier for a supported permit authority. */
export type JurisdictionId = JurisdictionProfile["id"];

/** Return the exact profile for a persisted or user-selected identifier. */
export function getJurisdiction(id: string): JurisdictionProfile | null {
  return JURISDICTIONS.find((profile) => profile.id === id) ?? null;
}

/** The profile only if the browser worker can check it; manual authorities return null. */
export function getAutomatedJurisdiction(id: string): AutomatedJurisdictionProfile | null {
  const profile = getJurisdiction(id);

  return profile && profile.portalFamily !== "manual" ? profile : null;
}

/** True for Accela portals searched through the home page's Global Search instead of one module's record search. */
export function usesGlobalSearch(id: string): boolean {
  const profile = getJurisdiction(id);

  return Boolean(profile && "globalSearch" in profile && profile.globalSearch);
}

/** Accela modules whose record pages belong to the authority. */
export function accelaModules(profile: JurisdictionProfile): readonly string[] {
  return "modules" in profile ? profile.modules : [profile.module];
}

/** True for authorities whose status the user enters by hand. */
export function isManualJurisdiction(id: string): boolean {
  return getJurisdiction(id)?.portalFamily === "manual";
}

/** The host serving record pages, when it differs from the search host. */
export function recordHost(profile: JurisdictionProfile): string {
  return "recordHost" in profile ? profile.recordHost : new URL(profile.startUrl).host;
}

/**
 * The portal a check's traffic lands on, used to pace checks: authorities that share one host, such as the Accela
 * tenants on aca-prod.accela.com or the districts on one ePermit server, share one pace.
 */
export function checkScope(profile: AutomatedJurisdictionProfile): string {
  return new URL(profile.startUrl).host;
}

/** An example of the number format the authority's search accepts, for the add form. */
export function numberExample(profile: JurisdictionProfile): string | null {
  return "numberExample" in profile ? profile.numberExample : null;
}

/** Selector groups: local permitting authorities first, then the water management districts. */
export const JURISDICTION_GROUPS = [
  { label: "Counties and cities", includes: (profile: JurisdictionProfile) => profile.authorityType !== "water-management-district" },
  { label: "Water management districts", includes: (profile: JurisdictionProfile) => profile.authorityType === "water-management-district" },
] as const;
