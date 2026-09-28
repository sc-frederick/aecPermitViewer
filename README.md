# Permit Monitor

Permit Monitor is a local Windows desktop app for tracking public building permits from selected Florida authorities, and permits from Florida's five water management districts. It saves the status shown on a verified permit record, the observation time, and a record link. A failed check leaves the prior verified status and its original time intact.

## Supported workflow

- Select Hillsborough, Pasco, Pinellas, Hernando, Polk, Orange, or Baker County, or the cities of Tampa, St. Petersburg, or Palm Bay. Each choice searches its own issuing authority. See the [portal research](docs/FL_PERMIT_PORTALS.md) for search inputs and record coverage.
- Water management district permits are listed separately in the jurisdiction menu. Southwest Florida (SWFWMD) has one choice each for environmental resource (ERP), water use, and well construction permits, because its public WMIS search has a page for each. South Florida (SFWMD), St. Johns River (SJRWMD), Suwannee River (SRWMD), and Northwest Florida (NWFWMD) each have one choice covering ERP, water use, and well construction. Each note under the menu gives the number format the district uses, such as `43047590.008` or App ID `1001157` for SWFWMD ERP, `48-112909-P` or `260901-67337` for SFWMD, and `ERP-123-255799-1` for SRWMD. SJRWMD, SRWMD, and NWFWMD share one ePermit system. For them, the app saves the district's Status and the record's Current Process Stage together, such as `Pending · Pending RAI Response`, because Status stays Pending through the whole review. SWFWMD's public ERP record shows `Incomplete` while an application is pending; its review stage appears only after signing in to the district's ePermitting. SFWMD's firewall rejects browsers that identify as headless Chrome, so for that portal only, the bundled browser reports an ordinary Chrome user agent.
- Accela searches cover Hillsborough, Pasco, Tampa, Pinellas, and Polk. Hernando uses Tyler Civic Access, which covers both permits and plan records (numbers such as DEVP-, SUB-, CSC-, or REZ-); St. Petersburg uses Click2Gov. Palm Bay's iMS search requires a login, Orange County's Fast Track search requires a CAPTCHA, and Baker County's public Permit Search turns away automated browsers, so all three are checked by hand: Check now opens the portal search, copies the permit number, and asks for the status you see there. Scheduled checks skip them. Pasco and Hillsborough are searched with their portals' Global Search, so records in other modules, such as Pasco Planning or Hillsborough Land Development (site and utility permits like HC-UTLCON), are found too. Hernando's separate legacy portal is outside the automated search.
- Add a full permit number, check now, review the history (one entry per day with that day's status), and open the verified record. Scheduled checks run at 8:30 AM, 12:30 PM, and 4:30 PM by default while Permit Monitor is running and Windows is awake; Settings lets you change, add, or remove times (up to eight a day). A time missed because the app was closed or the computer was asleep is made up once, but only between the first time and half an hour after the last (past midnight when the last time is after 11:30 PM), so nothing runs overnight. New permits are included automatically, and each can be excluded from its details. Choose Manual only to turn scheduling off.
- Closing the window keeps Permit Monitor running in the Windows notification area; quit from the tray icon. It can also start at Windows sign-in, hidden in the tray.
- Windows desktop notifications report when a portal status changes (quoting the old and new wording exactly), new requests for an applicant response in Accela review processes, and the first failure in a run of failed checks. Review notices name the process, its exact status, and the decision date; a later discipline or correction round notifies even if Record Status stays unchanged. Repeated checks of the same request stay quiet. Clicking a notification opens that permit. Both notification types can be turned off in Settings.
- When Permit Monitor has focus, notices appear inside the app. Otherwise, Windows receives a desktop notification. Native delivery failures are logged and retained as an in-app notice for the next time the window gains focus. Windows notification and Do Not Disturb settings control whether a delivered notification appears as a banner or only in Notification Center.
- The displayed record status is preserved as written. For the counties and cities, an Action column shows who that wording waits on: **AEC** when the applicant owes something (Hillsborough and Tampa's “Awaiting Client Reply”, Polk's “Fees Due”, Hernando's “Requires Resubmittal”), **AHJ** while the authority is reviewing, and **None** once the record is issued, finished, or withdrawn. When in doubt it says **AEC?**: unclear wording, records that stopped short (expired, denied, revoked), and wording a portal hasn't been seen to use count as AEC, so nothing waiting on the firm is missed, but the question mark and a dashed frame set them apart from explicit requests. The badge's tooltip gives the reason. AEC and AEC? rows are marked in ember, and Show → AEC action lists both. A filter with nothing to show says "No matches." Water management district permits show a dash. See the [status survey](docs/PERMIT_STATUSES.md) for each portal's list and where a status can lag behind the portal's own review steps.
- For Accela jurisdictions (Hillsborough, Pasco, Tampa, Pinellas, and Polk), checks also read **Record Info → Processing Status**, including each collapsed review history. A current “Corrections Required”, “Revisions Required”, “Awaiting Client Reply”, or equivalent request puts the permit in **AEC** action while other disciplines are pending. Details show each process’s latest status and date. A later approval or pending round supersedes that discipline’s older corrections; a later explicit resubmittal or routing event on an intake or coordination task clears requests from earlier rounds. A resubmittal to one discipline does not clear another discipline’s request. A payment or document upload alone does not clear a request. Failed workflow reads keep the previous verified status and review evidence. Existing history is retained when the database upgrades; review evidence fills in on the next successful check. Other portal families continue using their existing status checks.
- Other people can follow the list read-only without setting anything up. **Settings → Shared list → Share this list** gives a code. Pasting it under **Follow a shared list** in another copy of Permit Monitor shows that list in place of the follower's own. The sharing app sends the list after each round of checks, and followers fetch it about 90 minutes after each of the owner's check times. **Sync now** in the header does either at once. The follower needs no TypeSafe key, and its own permits aren't shown or checked until it stops following. The list is encrypted before it leaves the sharing app, and the code holds the only key that decrypts it. **Stop sharing** deletes the stored copy, so the code stops working. See [shared lists](docs/SHARING.md) for the service design.
- Each user pastes a TypeSafe API key into Settings. The window sends it once to the main process, where Electron safeStorage encrypts it for the Windows user. It is never shown again. Filtered page text goes to TypeSafe Jev only for a navigation step the browser's own checks don't settle; browser execution and history stay local. Checks need a saved key: without a readable one, checks are skipped with one notice (and a notice for each Check now) instead of recorded as failures, and they resume once a key reads. A key the service rejects pauses scheduled checks until a new key is saved.

The [product scope](PRODUCT.md) and [release qualification](docs/RELEASE.md) describe the boundaries in more detail.

## Development

Use Node.js 24. Nothing in the project compiles native code. SQLite comes from Node's built-in `node:sqlite`, and the key is entered in the app, so neither Visual Studio nor Python is needed on any platform. End users of a qualified installer need no development tools. On Windows, run:

```sh
npm ci --allow-git=all
npm run browser:stage
npm run typecheck
npm run lint
npm test
npm run dev
```

The renderer and worker tests run in the staged browser, so stage it before `npm test`.

`npm run lint` runs Oxlint with the vendored [anti-slop](https://github.com/dmmulroy/anti-slop) rules in `tools/oxlint/anti-slop/` (provenance in its `UPSTREAM.md`). They reject unchecked type assertions and `unknown` inputs, so values from IPC, the worker, SQLite, and the network are parsed with zod where they enter. Fix a finding rather than suppressing it.

`npm run browser:stage` installs Playwright's pinned Chromium and headless shell under `vendor/playwright-browsers`, then writes a SHA-256 manifest for the complete payload. On Windows, `npm run make:win` creates the Squirrel installer. Key storage uses Windows encryption, so saving a key works only on Windows. Elsewhere, use the development key variable described below.

On Linux, the same commands run the tests, a build, and `npm run smoke:portal`.

### Testing on Windows from a WSL checkout

Windows npm cannot run from a `\\wsl.localhost\...` folder: `cmd.exe` rejects UNC working directories, and that `node_modules` holds Linux binaries. Mirror the source to a Windows folder instead. `npm run sync:windows` copies it to `C:\Users\<you>\dev\aecPermitViewer` by default, and you can pass another `/mnt/c/...` path after `--`. Each side keeps its own `node_modules`, browser payload, and build output. Run it again after each change, then install and start as above in PowerShell in that folder. Paste your key under **Settings → TypeSafe key**. Start-at-sign-in is available only in an installed build.

### Running the app against live permits on Linux or WSL

Saving a key needs Windows encrypted storage, so an unpackaged development run elsewhere can take the TypeSafe key from the environment instead. Main reads it once at startup and removes it from its environment. It is never saved to disk, logged, or passed to the renderer or browser worker. Packaged builds ignore it.

```sh
npm run browser:stage          # once, if vendor/playwright-browsers is missing
TYPESAFE_API_KEY=... npm run dev
```

With WSLg the window opens on the Windows desktop. Add a permit number under its issuing jurisdiction and use Check now. Checks run one at a time. Checks on the same portal host are at least 30 seconds apart, and a check on another portal can run in the meantime. On Linux, closing the window quits the app, and notices appear inside the window instead of as desktop notifications. Data is stored under `~/.config/Permit Monitor/PermitMonitorData`.

To try shared lists locally, run the sync Worker with `npx wrangler dev --config infra/sync-server/wrangler.jsonc --port 8787` and start the app with `SHARE_SERVICE_URL=http://127.0.0.1:8787 npm run dev`. A second instance started with `electron . --user-data-dir=<another folder>` can follow the first. A build without `SHARE_SERVICE_URL` hides sharing.

To confirm a portal shows a permit without using TypeSafe, run `npm run smoke:portal -- <permit-number> <jurisdiction-id> [saved-record-link]`. The default is the Hillsborough sample. For example, `npm run smoke:portal -- BLDR-004412-2026 hernando-county-building`, `npm run smoke:portal -- 25-05001277 st-petersburg-building`, or `npm run smoke:portal -- 1001157 swfwmd-erp`. It applies the same verification main does before saving, then prints the verified number, exact status, and record link. Passing a record link from an earlier check exercises the path scheduled checks take, which opens the saved record instead of searching where the portal allows it.

`npm run smoke:portal` performs a live, public portal check of `HC-BLD-26-0087599`. It checks the identifier and current displayed status without expecting the historical trial wording. This smoke bypasses Jev to isolate portal and browser behavior; it is not a full TypeSafe integration test.

## Architecture

The renderer receives display data through a narrow preload bridge. Main owns the SQLite database, encrypted key, job queue, scheduler, TypeSafe client, and update verification. An Electron utility process owns Playwright and exposes only bounded observations and approved action IDs. The worker verifies the full identifier on the detail page and reads the record-level status field before main commits an observation. Where a water management district's record page lacks the full number or the status, the worker reads them from the exactly matching search result.

The browser is launched from the packaged Playwright payload in a fresh context. No personal browser profile, cloud browser, or local HTTP server is used. Browser redirects and record URLs must stay within the selected authority's approved portal. The browser handles page actions and exact record/status checks. A lone step the worker's own checks establish (a visible, enabled field; an exact-number result; the portal's own search link) runs without a model call. Otherwise Jev chooses only from the actions the browser offers. Either way the worker revalidates the page before acting.

Shared lists go through the `permitmon-sync` Worker (`infra/sync-server`), with one SQLite-backed Durable Object per list. Main seals the list with AES-256-GCM before sending it, so the Worker stores only ciphertext. A follower's main fetches, decrypts, and parses the list with zod, then serves it to the window read-only. See [docs/SHARING.md](docs/SHARING.md).

Failures the window only shows as a generic message are recorded in `PermitMonitorData/logs/diagnostics.jsonl`, one JSON line each: the time, the operation (an IPC channel or check step), the check run ID where there is one, and the cause classified from its structured fields (SQLite code, system call and code, the app's error tag, or error name). Messages, stacks, paths, permit data, and the key are never written. The file is moved aside to `diagnostics.jsonl.1` at 256 KB and is removed with the rest of the local data.

## Current qualification state

Local type checking, tests, and build pass. Live worker smoke checks retrieved sample permit statuses from Hillsborough, Pasco Building and Permits, Tampa, Pinellas, Polk, Hernando, and St. Petersburg, and from all five water management districts. The new jurisdiction flows still need a TypeSafe-key-driven end-to-end check and Windows qualification. Pushing a `vX.Y.Z` tag publishes an unsigned installer to https://permitmon-updates.aeccloud.io/ and a GitHub release. Users click through SmartScreen on first install; after that the app updates itself from an Ed25519-signed feed. See [docs/RELEASE.md](docs/RELEASE.md) for the release steps and the checks required before promoting a prerelease.
