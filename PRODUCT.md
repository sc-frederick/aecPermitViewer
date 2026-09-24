# Permit Monitor

<!-- impeccable:product-schema 1 -->

## Platform

desktop

The interface is local HTML and CSS inside a single-user Windows 11 x64 Electron app.

## Stack

The user specified TypeScript, Electron, a bundled pinned Playwright Chromium, SQLite, and TypeSafe Jev for bounded navigation decisions.

## Users

The first user is a permit professional who tracks public building permit records and needs to know the exact status last displayed by the issuing authority.

## Product purpose

For a supported authority, the app checks a saved permit and records its exact displayed record status, the observation time, and a verified record link. When a check cannot establish these, it records a check failure separately from the last verified status.

## Operating context

The first supported authority is Hillsborough County government, using the public HillsGovHub Building and Site record search for its covered records. A municipality inside the county is a separate authority. Checks run locally while the app is open and the computer is awake. Selected, filtered page text goes to TypeSafe for navigation decisions.

## Capabilities and constraints

- Saved permit list, Check Now, status history, record link, and scheduled checks three times each business day (8:30 AM, 12:30 PM, 4:30 PM local time) while the app is running. A missed time is made up once, only between 8:30 AM and 5 PM.
- Runs from the Windows notification area when its window is closed, can start at sign-in, and sends local desktop notifications when a displayed status changes or a check starts failing.
- No document analysis, response recommendations, inspection scheduling, payments, applications, email notifications, or cloud browser execution.
- The user's TypeSafe key is typed into the app's settings, sent once to the main process, and encrypted there for the Windows user. It is never displayed again or returned to the renderer, and it stays out of the worker, logs, and database.
- Portal status wording is preserved exactly. "In Process" is not interpreted as an action request.
- Jurisdiction support requires an explicit qualified adapter and profile.

## Evidence on hand

On September 24, 2026, a public HillsGovHub search for `HC-BLD-26-0087599` displayed `Record Status: In Process` on the detail page. This is a point-in-time observation, not a permanent expected status.

## Product principles

- Verify the full permit identifier on the detail page before recording status.
- Keep the time of the last successful observation visible when a newer check fails.
- Stop on unknown portal states or access challenges.
- Show only statuses and dates the portal actually provided or the app actually observed.
