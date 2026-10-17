# Permit Monitor

<!-- impeccable:product-schema 1 -->

## Platform

desktop

The interface is local HTML and CSS in a single-user Electron app for Windows 11 x64, with an Apple silicon macOS build.

## Stack

TypeScript, Electron, a bundled and pinned Playwright Chromium headless shell, SQLite through Node's built-in `node:sqlite`, and TypeSafe Jev for bounded navigation decisions. Two Cloudflare Workers serve the update feed and shared lists.

## Users

The first user is a permit professional who tracks public building permit records and needs to know the exact status the issuing authority last displayed.

## Product purpose

For a supported authority, the app checks a saved permit and records the exact record status displayed, the time it was observed, and a verified record link. When a check cannot establish these, it records a check failure separately from the last verified status.

## Operating context

- **Counties and cities:** Hillsborough, Pasco, Pinellas, Hernando, Polk, Orange, and Baker counties, plus Tampa, St. Petersburg, and Palm Bay. A municipality inside a county is a separate authority. Accela, Tyler Civic Access, and Click2Gov each need their own search path.
- **Water management districts:** a second group in the selector. SWFWMD's WMIS has one choice each for ERP, water use, and well construction. SFWMD uses RegPermitting. SJRWMD, SRWMD, and NWFWMD use the ePermit system St. Johns River hosts. Where a district's record page lacks the status or the full number, the app reads it from the exactly matching search result.
- **Checked by hand:** Palm Bay requires a login, Orange County shows a CAPTCHA on every search, and Baker County's Cloudflare check turns away automated browsers. For these, the app opens the official search and records the status the user enters.
- Checks run locally while the app is open and the computer is awake. Selected, filtered page text goes to TypeSafe only when the browser's own checks don't settle the next navigation step.

See the [portal research](docs/FL_PERMIT_PORTALS.md) for each portal's search inputs and access limits.

## Capabilities and constraints

- Saved permit list, Check now, status history, and record links. Scheduled checks run at up to eight user-chosen times a day, by default 8:30 AM, 12:30 PM, and 4:30 PM local time. A missed time is made up once, and only between the first time and half an hour after the last.
- The app keeps running in the Windows notification area or the macOS menu bar when its window is closed, and on Windows it can start at sign-in. It sends local desktop notifications when a displayed status changes, an Accela review issues a new request for an applicant response, or a check starts failing.
- Shared lists: the person who checks the permits can share a read-only copy with a code. Followers need no account or TypeSafe key. The list is encrypted in the app before upload, and stopping sharing deletes the stored copy. Followers see statuses, Action badges, history, and notices but cannot check, add, remove, or edit permits. See [shared lists](docs/SHARING.md).
- Out of scope: document analysis, response recommendations, inspection scheduling, payments, applications, email notifications, and cloud browser execution.
- The TypeSafe key is typed into Settings, sent once to the main process, and encrypted there with the operating system's per-user store. It is never displayed again or returned to the renderer, and it stays out of the browser worker, logs, and database.
- Portal status wording is preserved exactly. A separate Action column says who the wording waits on: AEC (the applicant), the AHJ, or no one. When in doubt it shows AEC?. For Accela records, current review requests put the action on AEC even when the record status has not changed. Water management district permits are not classified. The rules and per-authority wording are in the [status survey](docs/PERMIT_STATUSES.md).
- Supporting a jurisdiction requires an explicit profile, a portal-specific search, and a verified permit-level status field. A portal login or human challenge produces a failed check, not an inferred status.

## Evidence on hand

On September 24, 2026, a public HillsGovHub search for `HC-BLD-26-0087599` displayed `Record Status: In Process` on the detail page. This is a point-in-time observation, not an expected status.

## Product principles

- Verify the full permit identifier on the detail page before recording a status. Where a portal's record page lacks the full number or the status, verify it on the exactly matching search result instead.
- Keep the time of the last successful observation visible when a newer check fails.
- Stop on unknown portal states and access challenges.
- Show only statuses and dates the portal provided or the app observed.
