# Florida permit lookup portals

These are the issuing authorities' public permit portals, as checked in September 2026. Each section gives the date of its check, and any of these observations can change. A county search does not cover the cities in that county. Pages behind a session or sign-in may show more fields. The fields below are the ones the linked public instructions or public search forms establish.

## Summary

| Authority              | Platform                  | How the app checks it             | Status field                                      |
| ---------------------- | ------------------------- | --------------------------------- | ------------------------------------------------- |
| Hillsborough County    | Accela, HillsGovHub       | Automated, Accela Global Search   | Record Status                                     |
| Pasco County           | Accela, PascoGateway      | Automated, Accela Global Search   | Record Status                                     |
| City of Tampa          | Accela                    | Automated                         | Record Status                                     |
| Pinellas County        | Accela                    | Automated                         | Record Status                                     |
| Polk County            | Accela                    | Automated                         | Record Status                                     |
| Hernando County        | Tyler Civic Access        | Automated                         | Status, or the plan status field for plan records |
| City of St. Petersburg | Click2Gov                 | Automated                         | Application Status                                |
| Orange County          | Fast Track                | By hand: CAPTCHA on every search  | Entered by the user                               |
| City of Palm Bay       | iMS                       | By hand: login required           | Entered by the user                               |
| Baker County           | ADG CitizenLink           | By hand: Cloudflare challenge     | Entered by the user                               |
| SWFWMD                 | WMIS                      | Automated, one choice per program | Status, Permit Status, or Application Status      |
| SFWMD                  | RegPermitting             | Automated                         | Permit Status, Application Status, or App Status  |
| SJRWMD, SRWMD, NWFWMD  | ePermit, hosted by SJRWMD | Automated                         | Status and Current Process Stage                  |

For a hand-checked authority, Check now opens the official search in the user's browser, where they log in or solve the challenge, and the app saves the status they enter. Scheduled checks skip these authorities. Automate them only if public access changes.

## Counties and cities

Checked September 24, 2026, except Baker County, checked September 28, 2026.

### Hillsborough County

- **Portal:** [HillsGovHub](https://aca-prod.accela.com/HCFL/Cap/CapHome.aspx?module=Building&TabName=Building), Accela tenant `HCFL`.
- **Search:** the app uses the portal's Global Search, which finds a record number across Building, Land Development, Fire, Enforcement, and Administrative. Land Development includes utility and site permits.
- **Status:** the record page shows **Record Status**. **Record Info > Processing Status** shows the review workflow.
- **Access and scope:** the worker's public search returned the sample record without a login. County government records only. Municipalities are separate authorities.

### Pasco County

- **Portal:** [PascoGateway](https://aca-prod.accela.com/pasco/Default.aspx), Accela Citizen Access.
- **Search:** the county's [search guide](https://content.civicplus.com/api/assets/faffdfda-9a8c-44f2-8a33-f6ed15a651ef) routes newer records such as `RESNEW-2022-000001` through **Building > Search Applications** and older records such as `21B000001` through **Permits > Search Permit Records**. The [Building search form](https://aca-prod.accela.com/PASCO/Cap/CapHome.aspx?module=Building&TabName=Building) takes record number, site address, parcel, contractor or license, and contact. The separate [global search](https://aca-prod.accela.com/PASCO/customization/common/searchPage.aspx) takes a permit number, address, license number, or contact. The app uses the Global Search, which finds a record number across Building, Permits, Planning, and Enforcement.
- **Status:** search results open records by record number. The county's [status instructions](https://cms1files.revize.com/pasco/Documents/Services/Building%20Construction/Instructions%20to%20Reinstate%20or%20Close%20an%20Expired%20Permit.pdf) say to select **Record Info > Processing Status** for a permit's progress.
- **Access and scope:** login is optional for searching, and anonymous access is read-only. The [portal notice](https://aca-prod.accela.com/pasco/welcome.aspx) says current residential and commercial building applications are under Building and earlier paper applications under Permits. Treat results as Pasco County's records, not a complete inventory of municipal permits.

### City of Tampa

- **Portal:** [Tampa Accela](https://aca.tampagov.net/), the city's permitting system. Record pages are served from `aca-prod.accela.com/TAMPA`.
- **Search:** according to the city's [record number guide](https://www.tampa.gov/sites/default/files/document/2026/accela_guide_search_for_permits_by_record_number_ada.pdf), the search bar takes the complete record number, such as `BLD-20-0471790`. The city also publishes an [address search guide](https://www.tampa.gov/construction-services/homeowner-resources).
- **Status:** the record shows **Record Status**. According to the city's [status guide](https://www.tampa.gov/sites/default/files/document/2022/accela_guide_find_permit_status_comments.pdf), **Record Info > Processing Status** shows active workflow tasks and permit-specific comments.
- **Access and scope:** public records can be searched without an account. Exempt or secure files need an authorized contact to log in. City of Tampa permits only.

### Pinellas County

- **Portal:** [Pinellas County Access Portal](https://aca-prod.accela.com/pinellas/Default.aspx), Accela. The county's [status instructions](https://pinellas.gov/check-building-permit-status-without-a-contractors-license/) route users to **Building > Search Permits**.
- **Search:** General Search takes a street number and street name, and a matching permit list opens the selected record. A [county inspection guide](https://pinellas.gov/pinellas-county-florida-building-and-development-review-services-phone-inspection-numbers-and-types/) also describes searching by permit number and opening **Record Info > Inspections** for results.
- **Status:** the record shows **Record Status**. **Record Info > Processing Status** shows status information and each department's review status.
- **Access and scope:** the county's [permitting guide](https://pinellas.gov/wp-content/uploads/2022/05/Pinellas_County_permitting_guide.pdf) says status search doesn't require a portal account. The [building services page](https://pinellas.gov/building-services/) says county building permits cover unincorporated Pinellas plus Belleair Beach, Belleair Shore, Indian Rocks Beach, Kenneth City, Oldsmar, and Safety Harbor. St. Petersburg has its own portal.

### Polk County

- **Portal:** [Polk County Citizen Access](https://aca-prod.accela.com/POLKCO/Default.aspx), Accela, with a direct [Building search](https://aca-prod.accela.com/POLKCO/Cap/CapHome.aspx?module=Building&TabName=Building) and a county [user guide](https://www.polkfl.gov/wp-content/uploads/2023/07/building-accela-user-guide.pdf).
- **Search:** the public Building search takes permit number, record type, site address, parcel number, contractor or license, and contact.
- **Status:** the record shows **Record Status**. **Record Info > Processing Status** shows workflow status, and **Inspections** shows scheduled inspections and results. The user guide gives `Inspections`, `Fees Due`, `Closed-CO Issued`, and `Closed-CC Issued` as examples.
- **Access and scope:** the [county historical lookup](https://apps.polk-county.net/cmslookup/externalhansendetail/) points permits from 2010 on to Accela and searches older permits by permit number, parcel number, or address. The user guide notes that Dundee, Fort Meade, or Polk City processed some records, so check the issuing jurisdiction on a match. No login or CAPTCHA was found on the public search form.

### Hernando County

- **Portal:** the [Tyler Civic Access portal](https://hernandocountyfl-energovweb.tylerhost.net/apps/selfservice) holds current records. The county's [building page](https://www.hernandocounty.us/building-development/building/) says it began March 3, 2026. Permits submitted before that date are in the [legacy lookup](https://pvweb.hernandopa-fl.us/), which the app does not search.
- **Search:** the [public search](https://hernandocountyfl-energovweb.tylerhost.net/apps/selfservice/hernandocountyflprod#/search) takes a permit number in a keyword field and lists exact permit-number links. The building page also describes property and contractor lookup.
- **Status:** a [permit page](https://hernandocountyfl-energovweb.tylerhost.net/apps/selfservice/hernandocountyflprod#/permit/d342dc84-196f-4f0e-b14b-1cee8bd7bcc6) shows **Permit Number** and the permit-level **Status** above workflow and inspection details. Plan records use a different status field; see the [status survey](PERMIT_STATUSES.md#tyler-civic-access-hernando).
- **Access and scope:** the public search and the sample permit page loaded without a login. The county says the legacy lookup is for review, status, and inspection scheduling only, and new applications must use Tyler. Hernando County Building Division records.

### City of St. Petersburg

- **Portal:** [Click2Gov Building Permit Select Permit](https://stpe-egov.aspgov.com/Click2GovBP/selectpermit.html).
- **Search:** the form offers **Application Number**, **Address** by street number, direction, name, and suffix with begins-with or contains matching, **Parcel Number** by section, township, range, subdivision, block, and lot, and **Name**. The app takes the application number as year and serial, such as `25-05001277`.
- **Status:** a [Status Detail record](https://stpe-egov.aspgov.com/Click2GovBP/selectpermit.html?permit.appYear=25&permit.appNumber=05001277&searchType=0&validatePermitView=true) shows **Application #** and **Application Status**. It displays the serial without the input's leading zero. The [portal home](https://stpe-egov.aspgov.com/Click2GovBP/index.html) also offers plan tracking comments, inspection results, and permit history.
- **Access and scope:** the portal home says these lookups need no account. Login uses email MFA, and contractor history requires an account. City of St. Petersburg building permits.

### Orange County

- **Portal:** [Fast Track Permits, All Types](https://fasttrack.ocfl.net/OnlineServices/PermitsAllTypes.aspx), the county's own system, and its [property search](https://fasttrack.ocfl.net/OnlineServices/Properties.aspx). The county [confirms both URLs](https://engageorange.ocfl.net/permitting-tech-upgrades?tool=qanda).
- **Search:** for building permits, choose **Permits, All Types > Building Permits** and search by permit number, address, or parcel ID. Open the permit number for details. Linked items in blue show more. Required processes marked **Open** mean the permit is not ready for issuance. The property search takes an address or parcel ID and lists permit history, according to the [county FAQ](https://engageorange.ocfl.net/fast-track-permitting-services/widgets/118242/faqs).
- **Access and scope:** search and status browsing need no Member Services account. Applications and electronic plan submission do, according to a [second county FAQ](https://engageorange.ocfl.net/fast-track-permitting-services/widgets/118243/faqs). A [county statement](https://newsroom.ocfl.net/media-advisories/press-releases/2023/02/orange-county-division-of-building-safety-2022-year-in-review/) gives Building Safety's permitting scope as unincorporated Orange County.
- **Why by hand:** in an interactive browser check, the [Building search](https://fasttrack.ocfl.net/OnlineServices/permit-building.aspx) showed a human-verification image. The official instructions don't mention it.

### City of Palm Bay

- **Portal:** [iMS](https://ims.palmbayfl.gov/ims), from Intuitive Municipal Solutions. The city's [building page](https://www.palmbayfl.gov/government/city-departments-a-to-e/building-permits-inspections) also describes the ePermitHub Digital Plan Room for plans.
- **Search:** the city's [FAQ](https://www.palmbayfl.gov/government/city-departments-a-to-e/building-permits-inspections/building-permits-faqs) directs users to Online Services to search permits and inspection results. The building page says applicants can see permit and review status in the Digital Plan Room. The public pages don't establish the anonymous search fields or status labels.
- **Access and scope:** the city's [permit form](https://www.palmbayfl.gov/home/showpublisheddocument/25074/639095891441270000) says registration is required to apply. City of Palm Bay permits.
- **Why by hand:** an unauthenticated request to `https://ims.palmbayfl.gov/ims` redirected to the login page, and in an interactive browser the [permit search](https://ims.palmbayfl.gov/ims/Find?bNewSearch=true&cat=Permit) also redirected to login.

### Baker County

- **Portal:** [Building Permits Portal, Permit Search](https://permits.bakercountyfl.org/permits?qr=13fafd9557bd7244d7fecbf073119784&t=0), American Data Group CitizenLink, also called Tripleview. `permits.bakercountyfl.org/start/` is the staff sign-in, not the public search. The county's earlier MaintStar portal at `h8.maintstar.co/BakerCountypublic` refused connections.
- **Search:** a type-ahead that takes the full year-plus-serial permit number, such as `202600500` or `202500100`, or the last 5 digits for the current year. The portal also has public Parcel and Contractor searches.
- **Status:** choosing a match opens the record, which shows `Permit Status`, description, address, contractor, and Inspections Requested, Scheduled, and Completed tabs. A lapsed permit keeps ACTIVE under a "This permit expired on" banner.
- **Access and scope:** public and read-only without a login. The contractor login covers applications and payments. Unincorporated Baker County only. The City of Macclenny runs its own building department.
- **Why by hand:** the whole host is behind a Cloudflare managed challenge. In the app's own Chromium, both the headless shell and full Chromium in headless mode stayed on Cloudflare's "Just a moment" page, even with a plain user agent and automation flags removed. A visible window cleared the challenge in about 4 seconds without a click, and headless runs that reused that profile's `cf_clearance` cookie and user agent then searched successfully. The app starts each check in a fresh headless context, so it can't reuse a clearance.

The `qr` value in the Baker County link is the MD5 of the page name `corePermitByNumber`, not a session token, so the link is stable.

### Sample records

On September 24, 2026, the worker checked one record per automated county and city portal, using the bundled Chromium and the public search. It verified the displayed permit number and record-level status before returning each result. These are point-in-time statuses, not expected ones.

| Authority                   | Sample record                                                                                                                                                          | Displayed status     |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| Hillsborough County         | [HC-BLD-26-0087599](https://aca-prod.accela.com/HCFL/Cap/CapDetail.aspx?Module=Building&TabName=Building&capID1=26CAP&capID2=00000&capID3=01Y33&agencyCode=HCFL)       | In Process           |
| Pasco County, Building      | [RESALT-2022-000153](https://aca-prod.accela.com/PASCO/Cap/CapDetail.aspx?Module=Building&TabName=Building&capID1=REC22&capID2=00000&capID3=000O5&agencyCode=PASCO)    | Closed               |
| Pasco County, older Permits | [21B09023](https://aca-prod.accela.com/PASCO/Cap/CapDetail.aspx?Module=Permits&TabName=Permits&capID1=21AC2&capID2=00000&capID3=0DLYN&agencyCode=PASCO)                | Closed               |
| City of Tampa               | [BLD-26-0528305](https://aca-prod.accela.com/TAMPA/Cap/CapDetail.aspx?Module=Building&TabName=Building&capID1=26CAP&capID2=00000&capID3=02KWE&agencyCode=TAMPA)        | In Process           |
| Pinellas County             | [BR-SFR-26-00246](https://aca-prod.accela.com/PINELLAS/Cap/CapDetail.aspx?Module=Building&TabName=Building&capID1=26CAP&capID2=00000&capID3=01F67&agencyCode=PINELLAS) | Plans Received       |
| Polk County                 | [BR-2026-7675](https://aca-prod.accela.com/POLKCO/Cap/CapDetail.aspx?Module=Building&TabName=Building&capID1=REC26&capID2=00000&capID3=013DW&agencyCode=POLKCO)        | Application Received |
| Hernando County             | [BLDR-004412-2026](https://hernandocountyfl-energovweb.tylerhost.net/apps/selfservice/hernandocountyflprod#/permit/d342dc84-196f-4f0e-b14b-1cee8bd7bcc6)               | Issued               |
| City of St. Petersburg      | [25-05001277](https://stpe-egov.aspgov.com/Click2GovBP/selectpermit.html?permit.appYear=25&permit.appNumber=05001277&searchType=0&validatePermitView=true)             | CLOSED               |

## Water management districts

Checked September 25, 2026, in the bundled headless Chromium the worker uses. A district's permits are separate from any county or city building permit, and each district covers its own region. Record pages open without a session unless noted.

### Southwest Florida Water Management District (SWFWMD)

SWFWMD's public Water Management Information System, WMIS, has a separate search page for each permit program, and the app treats each as its own selection. Searches run on `www18.swfwmd.state.fl.us` and record pages are on `www38.swfwmd.state.fl.us`. Result rows link to record pages over plain HTTP, so the app opens and saves the HTTPS address of the same page. The pages sometimes reset the first connection or take over 20 seconds to load, so the worker retries the first load once.

**Environmental Resource Permit (ERP)**

- **Search:** [ERP Search](https://www18.swfwmd.state.fl.us/erp/erp/search/ERPSearch.aspx). Enter **Permit**, six digits with no type prefix, and **Rev**, or the **ERP App ID**. Each is added to a search list with **Add** before **Search**.
- **Number entered:** the permit and revision as the district writes it, `43047590.008`, or as WMIS shows it, `47590.008`, or the application ID, `1001157`.
- **Record:** `ERP/ERP/Entry/ERP.aspx?id=<App ID>`, headed `ERP Permit: 47590.008 (App: 1001157)`. Before a permit number exists, the heading reads `ERP Permit Application: 942840` or `Exemption Application: 1000558`. **Status** is a read-only drop-down with values such as `Approved`, `Incomplete`, `Denied`, and `Deleted`. WMIS shows `Incomplete` while an application is pending; the review stage is visible only after signing in to ePermitting. The type prefix, such as 43, is a separate field and is checked when entered.

**Water Use Permit (WUP)**

- **Search:** [Water Use Permit Search](https://www18.swfwmd.state.fl.us/search/search/searchwupsimple.aspx), with **Permit #** and **Rev #**, such as `1960.023`.
- **Record:** `Support/WUP/WupSimple.aspx?st=<permit>&rev=<rev>`, headed `Water Use Permit: 1960.023`. This page has no status field. The search results' **Permit Status** column, with values such as `Approved` and `Submitted`, is the only record-level status, so the app reads it from the exactly matching result row and saves the record page as the link.

**Well Construction Permit (WCP)**

- **Search:** [Well Construction Permit Search](https://www18.swfwmd.state.fl.us/search/search/wcpsimple.aspx), with **Permit #**, such as `973309`. It takes up to seven digits and silently cuts off longer input.
- **Record:** `Support/WCP/WcpDetail.aspx?permit=<permit>`, headed `WCP Detail - 973309`. **Application Status** shows values such as `UNDER REVIEW` or `COMPLETED`. The results grid shows the same value in title case.

A search for a number that doesn't exist shows `No records matched search criteria. Please try again.` Since July 7, 2026, new ERP applications are filed in SWFWMD's Appian ePermitting system at [swfwmd.watermatters.org](https://swfwmd.watermatters.org/suite/), which requires a sign-in. Water use and well construction stay in WMIS, according to the [district notice](https://www.swfwmd.state.fl.us/business/epermitting/environmental-resource-permit). The public ERP search still listed applications received in September 2026, including application IDs above 1,000,000. An application that hasn't reached WMIS returns no record, which the app reports as not found.

| Program                                 | Sample record                                                                                    | Displayed status |
| --------------------------------------- | ------------------------------------------------------------------------------------------------ | ---------------- |
| ERP                                     | [43047590.008 (App 1001157)](https://www38.swfwmd.state.fl.us/ERP/ERP/Entry/ERP.aspx?id=1001157) | Approved         |
| ERP application without a permit number | [942840](https://www38.swfwmd.state.fl.us/ERP/ERP/Entry/ERP.aspx?id=942840)                      | Incomplete       |
| Water use                               | [1960.023](https://www38.swfwmd.state.fl.us/Support/WUP/WupSimple.aspx?st=1960&rev=23)           | Approved         |
| Well construction                       | [973309](https://www38.swfwmd.state.fl.us/Support/WCP/WcpDetail.aspx?permit=973309)              | UNDER REVIEW     |

### South Florida Water Management District (SFWMD)

[RegPermitting](https://www.sfwmd.gov/regpermitting), a Pega application at `apps.sfwmd.gov`, replaced the retired `my.sfwmd.gov/ePermitting`. Its **Search Records** page is open without an account, and one search covers ERP, water use, well construction, and Works of the District records, including EAA and C-139. Right of way permits use a [separate portal](https://apps.sfwmd.gov/prweb/PRAuth/ROWExternal), whose record view showed `Permanent` for records its results listed as `Resolved-Completed` or `Resolved-Cancelled`, so the app doesn't cover them.

- **Access:** a FortiWeb firewall answers any browser whose user agent contains `HeadlessChrome` with HTTP 500 "Web Page Blocked". With an ordinary Chrome user agent, which the worker uses for this portal only, the search and record pages load with no login, CAPTCHA, or other challenge.
- **Search:** [the entry page](https://apps.sfwmd.gov/prweb/PRAuth/RegExternal) opens the app. **Search Records**, in a navigation drawer that starts collapsed, opens a frame with **Search by Application** (`Application No`) and **Search by Permit** (`Permit No`) tabs. Both match any record containing the text, 20 rows to a page, so `36-00142-S` also returns `36-00142-S-02` and later modifications. The worker opens only the row whose number matches exactly, and reports "not found" only when every result fits on one page. A search with no match shows `No cases`.
- **Numbers:** applications are `YYMMDD-NNNNN`, such as `260901-67337`. Permits are `CC-NNNNN(N)-X`, with `-P`, `-S`, or `-M` for ERP, `-W` for water use, and `-WC` for well construction. Older ERP numbers can carry a modification suffix, such as `36-00142-S-73`. EAA and C-139 permits, ending in `-E`, have no status on their record, so the app doesn't accept them.
- **Record:** a result opens in its own frame, headed by the record type and the number and project name. An application shows **Application Number** and **Application Status**, labeled **App Status** for water use applications, plus the permit number it concerns. A permit shows **Permit Number** and **Permit Status**. Statuses read like `Pending-TechnicalReview`, `Resolved-Completed`, `Approved`, `Pending-Expired`, and `Resolved-Expired`.
- **Record link:** `RegExternal?pyActivity=%40baseclass.doUIAction&action=openWorkByHandle&key=<class> <number>` opens a record in a fresh browser without a session. The record frame's own address carries that key, with class `SFWMD-REG-PERMIT-WORK` for ERP, `SFWMD-REG-WUPERMIT-WORK` for water use, `SFWMD-REG-WCPERMIT-WORK` for well construction, or `SFWMD-REG-WODPERMIT-WORK` for Works of the District. The address the app lands on after opening a record requires a sign-in, so it is never saved. Search and record views share one address, so the worker tells them apart by what the page shows.

| Record                              | Sample                                                                                                                                                                | Displayed status                            |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| ERP permit                          | [48-112909-P](https://apps.sfwmd.gov/prweb/PRAuth/RegExternal?pyActivity=%40baseclass.doUIAction&action=openWorkByHandle&key=SFWMD-REG-PERMIT-WORK%2048-112909-P)     | Permit Status: Approved                     |
| ERP permit with later modifications | [36-00142-S](https://apps.sfwmd.gov/prweb/PRAuth/RegExternal?pyActivity=%40baseclass.doUIAction&action=openWorkByHandle&key=SFWMD-REG-PERMIT-WORK%2036-00142-S)       | Permit Status: Pending-Expired              |
| ERP application                     | [260901-67337](https://apps.sfwmd.gov/prweb/PRAuth/RegExternal?pyActivity=%40baseclass.doUIAction&action=openWorkByHandle&key=SFWMD-REG-PERMIT-WORK%20260901-67337)   | Application Status: Pending-TechnicalReview |
| Water use application               | [260915-67760](https://apps.sfwmd.gov/prweb/PRAuth/RegExternal?pyActivity=%40baseclass.doUIAction&action=openWorkByHandle&key=SFWMD-REG-WUPERMIT-WORK%20260915-67760) | App Status: Pending-TechnicalReview         |
| Water use permit                    | [11-02638-W](https://apps.sfwmd.gov/prweb/PRAuth/RegExternal?pyActivity=%40baseclass.doUIAction&action=openWorkByHandle&key=SFWMD-REG-WUPERMIT-WORK%2011-02638-W)     | Permit Status: Approved                     |
| Well construction permit            | [44-117840-WC](https://apps.sfwmd.gov/prweb/PRAuth/RegExternal?pyActivity=%40baseclass.doUIAction&action=openWorkByHandle&key=SFWMD-REG-WCPERMIT-WORK%2044-117840-WC) | Permit Status: Approved                     |

### St. Johns River (SJRWMD), Suwannee River (SRWMD), and Northwest Florida (NWFWMD)

St. Johns River hosts one Angular ePermit app per district at `permitting.sjrwmd.com`: [SJRWMD](https://permitting.sjrwmd.com/ep/#/ep?target=srch) at `/ep/`, [SRWMD](https://permitting.sjrwmd.com/srep/#/ep?target=srch) at `/srep/`, and [NWFWMD](https://permitting.sjrwmd.com/nwep/#/ep?target=srch) at `/nwep/`. Each district's search covers its ERP, consumptive or water use, and well construction records, with no login or challenge. Results carry an "Information as of" time from the previous night, so a status can be up to a day old. SJRWMD's search took from 4 to 54 seconds to answer.

- **Numbers:** SRWMD and NWFWMD show a type and county prefix, such as `ERP-123-255799-1`, `2-121-222487-2` for water use, `3-023-255802-1` for a well, `IND-113-18663-5`, `2E-131-6688-3`, or `DO-C-332829-1`. SJRWMD numbers have no prefix, such as `219072-3`. The search takes only the application or permit number, `255799`, and the sequence, `1`, in separate fields, and rejects a full number typed into the first field. The worker splits the entered number, then accepts only the result whose full number matches. A number entered without its prefix matches on the number and sequence, which identify the record by themselves.
- **Search:** the form renders in an open shadow root, and results appear in the same view with each number as a link. A search with no match shows `No Results Found`. The form clears its fields just after its third lookup list, `lookups/catalogList`, loads, about 3 seconds after the form appears. A number entered before then is lost, and the search answers `Not enough criteria provided to search`. The worker waits for those lists before entering a number, and enters it again if it has vanished just before searching.
- **Record:** opening a result shows the record in a dialog frame with **Project Number**, such as `255799 - 1` without the prefix, **Status**, and **Current Process Stage**. The dialog derives its Status in the browser from the stage, so a withdrawn application reads `Closed` there while the result row shows the district's own status, `Never Issued`. Status also stays `Pending` through routing, review, and requests for additional information. So the app saves the result row's Status and the record's Current Process Stage together, such as `Pending · Review`, `Pending · Pending RAI Response`, `Issued · Compliance`, or `Never Issued · Closed`.
- **Record link:** the portal's Copy Link format, `#/prmtInfo?curId=&hdr=1&usrId=0&offclId=<number>&seqNo=<sequence>`, opens the record in a fresh browser. The record page omits the prefix, so a saved link can't confirm the full number, and each check searches again.

| District | Sample                                                                                                         | Displayed status · stage       |
| -------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| SJRWMD   | [219072-3](https://permitting.sjrwmd.com/ep/#/prmtInfo?curId=&hdr=1&usrId=0&offclId=219072&seqNo=3)            | Issued · Compliance            |
| SJRWMD   | [10837-9](https://permitting.sjrwmd.com/ep/#/prmtInfo?curId=&hdr=1&usrId=0&offclId=10837&seqNo=9)              | Pending · Pending RAI Response |
| SJRWMD   | [257469-1](https://permitting.sjrwmd.com/ep/#/prmtInfo?curId=&hdr=1&usrId=0&offclId=257469&seqNo=1)            | Never Issued · Closed          |
| SRWMD    | [ERP-123-255799-1](https://permitting.sjrwmd.com/srep/#/prmtInfo?curId=&hdr=1&usrId=0&offclId=255799&seqNo=1)  | Pending · Review               |
| SRWMD    | [2-121-222487-2](https://permitting.sjrwmd.com/srep/#/prmtInfo?curId=&hdr=1&usrId=0&offclId=222487&seqNo=2)    | Issued · Compliance            |
| NWFWMD   | [2E-131-6688-3](https://permitting.sjrwmd.com/nwep/#/prmtInfo?curId=&hdr=1&usrId=0&offclId=6688&seqNo=3)       | Pending · Review               |
| NWFWMD   | [DO-C-332829-1](https://permitting.sjrwmd.com/nwep/#/prmtInfo?curId=&hdr=1&usrId=0&offclId=332829&seqNo=1)     | Issued · Compliance            |
| NWFWMD   | [PDEX-033-332746-1](https://permitting.sjrwmd.com/nwep/#/prmtInfo?curId=&hdr=1&usrId=0&offclId=332746&seqNo=1) | Never Issued · Closed          |
