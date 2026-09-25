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
    modules: ["Building", "LandDevelopment", "Fire", "Enforcement"],
    coverageNote: "County government records in HillsGovHub, found with its Global Search across Building, Land Development, Fire, and Enforcement; municipalities are separate authorities.",
    adapterVersion: "accela-global-1",
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
    adapterVersion: "accela-global-1",
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
    adapterVersion: "accela-2",
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
    adapterVersion: "accela-2",
  },
  {
    id: "st-petersburg-building",
    label: "City of St. Petersburg",
    authorityType: "municipality",
    portalFamily: "click2gov",
    startUrl: "https://stpe-egov.aspgov.com/Click2GovBP/selectpermit.html?initialSearchView=true",
    tenant: "",
    module: "Building",
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
    adapterVersion: "accela-2",
  },
  // Neither portal allows an anonymous automated lookup, so these are checked by hand: the app opens
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
