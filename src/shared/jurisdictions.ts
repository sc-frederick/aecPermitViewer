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
    coverageNote: "County government Building records in HillsGovHub; municipalities are separate authorities.",
    adapterVersion: "accela-2",
  },
  {
    id: "pasco-county-building",
    label: "Pasco County",
    authorityType: "county-government",
    portalFamily: "accela",
    startUrl: "https://aca-prod.accela.com/PASCO/Cap/CapHome.aspx?module=Building&TabName=Building",
    tenant: "PASCO",
    module: "Building",
    coverageNote: "Pasco County records in PasCoGateway. Older numbered permits use its Permits search.",
    adapterVersion: "accela-2",
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
] as const;

/** One authority supported by the permit selector. */
export type JurisdictionProfile = (typeof JURISDICTIONS)[number];

/** Stable identifier for a supported permit authority. */
export type JurisdictionId = JurisdictionProfile["id"];

/** Return the exact profile for a persisted or user-selected identifier. */
export function getJurisdiction(id: string): JurisdictionProfile | null {
  return JURISDICTIONS.find((profile) => profile.id === id) ?? null;
}
