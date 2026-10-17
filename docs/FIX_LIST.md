# Master fix list

Audited September 28, 2026, against `master` at `2dc5b92`, including merged [PR #12](https://github.com/sc-frederick/aecPermitViewer/pull/12). This is the implementation backlog from the accuracy, Jev, performance, and cleanup review. No application fixes have been applied as part of this audit.

The product is a dashboard for scanning dozens of permits. Keep labels short and use the existing permit link for deeper review. Preserve exact portal status text, record identity checks, and the last successful observation when a newer check fails.

**Priorities:** P1 affects trust, responsiveness, or substantial waiting/download time. P2 is a concrete correctness or efficiency improvement. P3 is small cleanup. Items explicitly marked **measure first** are candidates, not established bottlenecks. All items below are open unless stated otherwise.

## Status, September 28, 2026

Implemented on `master` for release 0.6.0. "Verified" names the evidence gathered, not a Windows qualification.

| Item                            | Status      | Verified by                                                                                                                                                                                                                                                                                           |
| ------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F01 workflow evidence           | Open        | Needs F02 and a labeled permit set; nothing reads Processing Status or Plan Tracking yet.                                                                                                                                                                                                             |
| F02 Jev responsibility judgment | Open        | Needs human-labeled permit examples to set thresholds.                                                                                                                                                                                                                                                |
| F03 one browser copy            | Done        | An allow-list keeps only `package.json`, `dist/`, and production `node_modules` in the ASAR. Linux package: `app.asar` 681 → 23 MiB, package 1622 → 964 MiB; packaged browser smoke passed. Windows sizes still to record.                                                                            |
| F04 per-portal pacing           | Done        | `CheckQueue` paces by portal host with a cancellable timer. Queue tests use controlled time. In the live app, a Hernando check ran as soon as a Hillsborough check ended, and a second Hillsborough check waited out its 30 seconds.                                                                  |
| F05 row updates                 | Done        | Rows are kept by permit ID and only changed cells are replaced. Renderer tests confirm focus and unchanged rows survive. Median update time in headless Chromium on WSL: 25 / 50 / 100 permits went from 4.7–6.0 / 9.0–10.4 / 17.0–18.1 ms to 0.6 / 0.8 / 1.1–1.2 ms.                                 |
| F06 Hernando plans              | Done        | Fields are chosen by record kind (`#/permit/` or `#/plan/`). Covered by recorded fixtures, and live checks passed for DEVP-000011-2026 by search and by saved link.                                                                                                                                   |
| F07 compact uncertainty         | Done        | AEC? badge with a dashed frame and a reason tooltip, included in the AEC filter. Empty filters say "No matches."                                                                                                                                                                                      |
| F08 action evidence and alerts  | Open        | Depends on F01 and F02.                                                                                                                                                                                                                                                                               |
| F09 queue policy at start       | Done        | Entries carry a reason. Scheduled work is rechecked just before it starts; cancelled work is deferred to its next slot.                                                                                                                                                                               |
| F10 scheduler shutdown          | Done        | The scheduler is synchronous and guarded; its timer and listener stop with shutdown and restart if shutdown fails.                                                                                                                                                                                    |
| F11 missing key                 | Done        | A missing or unreadable key empties the queue with one notice and no failed runs, and work resumes once a key reads; saving a key re-queues due work at once. A rejected key pauses scheduled work until a new key is saved. Check now without a key gets a direct message.                           |
| F12 pending history             | Done        | Renderer test: one request while unrelated snapshots arrive, and a newer answer wins.                                                                                                                                                                                                                 |
| F13 Hernando detail readiness   | Done        | Search waits only on search pages. A live saved-link check took 8 seconds.                                                                                                                                                                                                                            |
| F14 established steps           | Done        | Worker candidates carry `established`, and a lone established step skips Jev unless the page hasn't moved since that same step, when Jev can still answer WAIT. One client per run. All recorded flows now make zero Jev requests: a live run with a fake key verified three permits.                 |
| F15 worker reads                | Done        | The detail read carries through to the result, challenge text is cut in the browser, and each field is read in one round trip.                                                                                                                                                                        |
| F16 credentials and snapshots   | Done        | The key is read and decrypted once, `state()` checks existence only, and save/remove no longer ask for a second snapshot. No caching added; Windows call timings not measured.                                                                                                                        |
| F17 update downloads            | Done        | Stream, timer, file, and redirect bodies are released on failure. Stream tests cover early end, a failed connection, oversize, and an unwritable path.                                                                                                                                                |
| F18 PR #6 cleanup               | Done        | Changes carried forward against current code, including removing the Hillsborough label aliases (the only caller sends profile IDs).                                                                                                                                                                  |
| F19 model metadata              | Done        | `NAVIGATION_MODEL` feeds both the request and the stored run.                                                                                                                                                                                                                                         |
| F20 test cleanup                | Done        | The query-plan check asserts no temporary sort, and the observation fixture is shared.                                                                                                                                                                                                                |
| F21 headless shell only         | Done        | Staging passes `--only-shell` on every platform; the worker and tests already launched only the headless shell. Tests pass with the full Chromium removed. The Windows installer went from 477 MB (0.9.0) to 277 MB, and the packaged browser smoke passed on Windows and macOS (CI run 36591749174). |
| F22–F23                         | Not started | Measure first.                                                                                                                                                                                                                                                                                        |
| F24 CI                          | Partly done | Superseded PR runs are cancelled, and the browser is staged before tests (renderer and worker tests need it). Job boundaries unchanged.                                                                                                                                                               |

Found while implementing: Hernando's not-found check looked for "Found 0 results", but the portal shows "No results were found", so a missing permit ended as "Portal page changed". The search-result wait picked a hidden label, and the start-page wait picked a hidden menu link; both always waited the full 12 seconds. All three are fixed and covered by fixtures. On September 28, St. Petersburg's portal returned a 503 maintenance page and SWFWMD's search page timed out, on unchanged `master` as well as this branch, so neither family was checked live.

## Evidence and baseline

- `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build` passed. There are 77 tests in 10 files.
- In the T3 browser, the actual built renderer ran with a synthetic bridge and 50 permits. Changing one permit's `checking` flag replaced all 50 permit rows and 17 group headers. A focused table button was detached and focus moved to `BODY`.
- Fifteen single-permit updates at each list size, with synchronous rendering plus a forced table layout, produced median times of **9.4 ms for 25 permits, 13.6 ms for 50, and 24.9 ms for 100**. This was a background browser at 1280 by 800, not the packaged Windows app. These numbers establish a baseline, not a Windows performance guarantee.
- Opening details with a pending history response, then delivering two snapshots that changed other permits, produced **three history calls** for the same displayed history.
- A temporary real SQLite database contained 50 permits, 54,750 runs, and 54,750 observations, equivalent to 1,095 observations per permit. Across 30 warmed reads, median times were **0.161 ms for the permit list, 0.002 ms for the latest browser version, and 3.140 ms for one permit's full history**. No user database was used.
- The installed Electron Packager's path filter includes `vendor/playwright-browsers` in the application copy. Forge also declares that directory as an extra resource. Source, tests, and documentation pass the application filter too. A finished Windows package was not built during this audit.
- Portal-specific accuracy examples below come from the repository's [status survey](PERMIT_STATUSES.md), not a fresh live-portal survey. No live Jev accuracy evaluation was performed.

## P1: accuracy and high-impact performance

### F01. Read workflow evidence before treating generic statuses as AHJ

**Evidence:** [action.ts](../src/shared/action.ts), lines 22, 30, 35, and 57, classifies broad review statuses as AHJ. The status survey documents applicant requests hidden underneath them. Those records disappear from the AEC filter.

**Fix:** Read Accela Processing Status for Hillsborough, Tampa, and Pasco, and St. Petersburg Plan Tracking. Preserve task/agency identity, dates, and review cycles. In Accela, a later submission may be on a different task; do not let an unrelated upload clear every request. For St. Petersburg, use the current step per agency rather than any historical RFC row. For Pasco, distinguish review findings from requests actually released to the applicant.

**Done when:** Recorded examples cover an outstanding request, a later matching resubmittal, unresolved requests on another task, and Pasco reviews not yet released. Missing workflow evidence must not become a confident AHJ decision. Depends on F02 for wording that needs interpretation.

### F02. Put Jev on the responsibility judgment

**Evidence:** [jev.ts](../src/main/jev.ts) currently asks only which browser action to take. [action.ts](../src/shared/action.ts) decides responsibility solely from a wording table.

**Fix:** Keep established exact rules in code. Give Jev relevant jurisdiction rules, the displayed status, and dated workflow evidence when those rules do not settle responsibility. Ask for a bounded judgment with an explicit insufficient-evidence outcome. Treat AEC as having the next step whenever a current actionable applicant obligation exists, even if other reviews continue. Jev cannot resolve evidence that was never collected.

**Done when:** Compare decisions against human-labeled permit examples, especially missed AEC requests and superseded requests. Select confidence thresholds from those results. A model/API failure must not discard a successfully verified raw status or imply that no action is needed. Use the current [Choice](https://docs.typesafe.ai/primitives/choice) and [confidence](https://docs.typesafe.ai/confidence) guidance.

### F03. Keep one packaged copy of the browser

**Evidence:** [forge.config.cjs](../forge.config.cjs), lines 58-65, enables ASAR and separately copies `vendor/playwright-browsers`, but does not exclude the original directory from the application copy. The installed packager filter confirmed that both paths are included. `.gitignore` does not provide that exclusion.

**Fix:** Exclude the browser's source directory from the ASAR input while retaining the separate runtime resource. Exclude development-only source, tests, docs, and tooling where they are not runtime inputs. Preserve Forge's output-directory exclusion and required production dependencies.

**Done when:** Inspect a built Windows ASAR and resources directory, record before/after installed and installer sizes, and pass the packaged browser smoke. Do not claim a specific download saving from the local Linux payload sizes.

### F04. Remove the global 30-second queue penalty across authorities

**Evidence:** [main/index.ts](../src/main/index.ts), `runNext`, uses one `lastJurisdictionCheckEndedAt` for every authority. Fifty checks incur 49 gaps, or **24 minutes 30 seconds** of added waiting, before browser/model time. Each gap polls every 100 ms.

**Fix:** Track cooldown by the actual throttling scope, accounting for authorities sharing infrastructure. Select eligible work from other scopes instead of blocking behind the first queued permit. Retain conservative portal pacing. Start with one active browser; only add bounded parallelism if measurement justifies it. Replace the polling loop with a cancellable timer.

**Done when:** Independent eligible authorities do not wait on each other's cooldown; same-scope checks remain paced; cancellation interrupts the wait promptly. Measure a mixed-authority queue and a same-authority queue separately.

### F05. Update changed rows without rebuilding the table

**Evidence:** [renderer/index.ts](../src/renderer/index.ts), lines 471-486, skips an identical snapshot but removes every table body whenever one visible permit changes. The browser reproduction confirmed full replacement and lost focus.

**Fix:** Retain rows by permit ID and update changed cells/controls. Reconcile project groups when membership or ordering changes. Keep the existing delegated click listener. Reuse each permit's classification for its badge, count, and filter during the same render rather than repeatedly normalizing it.

**Done when:** An unrelated check update preserves a focused permit link/button and unchanged rows. Group changes and filters remain correct. Compare 25/50/100-permit updates against the baseline. Virtualization is not a prerequisite for dozens of rows.

## P2: correctness and avoidable work

### F06. Support Hernando plan detail fields

**Evidence:** [worker/index.ts](../src/worker/index.ts), line 45, reads only `#label-PermitDetail-Status`. The survey identifies `#label-PlanDetail-Status` for DEVP-, SUB-, CSC-, and REZ-type plans. The URL policy already accepts plan detail routes.

**Fix:** Select the appropriate fields from the actual detail page and use the same selection for readiness and extraction. Verify the displayed record number for both permits and plans. Do not classify a plan successfully merely because a status-like field exists somewhere on the page.

**Done when:** Permit and plan fixtures succeed, and mismatched identities or ambiguous/missing status fields fail. A live representative plan check should confirm the fixture before release. This limitation predates PR #12.

### F07. Keep uncertainty compact and visible

**Evidence:** [renderer/index.ts](../src/renderer/index.ts), line 493, says "Nothing is waiting on AEC" even when records are unclassified. `StatusAction.listed` distinguishes unfamiliar wording but loses the survey's distinction between explicit requests and cautious classifications.

**Fix:** Use **"No matches"** for an empty filtered list. Retain **AEC / AHJ / None**; use **AEC?** as the proposed short signal for uncertain cases worth opening, and include those in the AEC filter. Keep a reason/source internally and, where useful, in a tooltip. Keep unsupported or never-checked records visibly distinct from None. Do not add explanatory paragraphs to table rows.

**Done when:** The filter never presents unclassified records as an all-clear. Explicit requests and cautious guesses are distinguishable at a glance. Update product/design wording with the final behavior.

### F08. Persist action evidence and notify on responsibility changes

**Evidence:** [notifications.ts](../src/main/notifications.ts) only announces changed status text. `PermitRow` and stored observations have no workflow-derived responsibility, evidence version, or classification timestamp.

**Fix:** Store the responsibility judgment separately from the literal portal status. Cache it by relevant evidence plus jurisdiction rules, prompt, and model version, not just the header wording. Invalidate it when those inputs change. Trigger an action-change notification when a request appears beneath an unchanged header, and deduplicate unchanged repeat checks.

**Done when:** A header that remains "In Process" can produce a new AEC alert when workflow evidence changes. Repeated identical evidence does not rerun inference or nag. Older evidence is not presented as newly verified when a workflow check fails. Depends on F01/F02.

### F09. Enforce queue policy when work starts

**Evidence:** [main/index.ts](../src/main/index.ts) gates scheduled enqueueing in `scheduleDue`, but `runNext` does not recheck the window, global mode, or permit inclusion. The queue stores only IDs, so manual and scheduled requests are indistinguishable. Canceling queued/pending work leaves its due time unchanged, allowing the next scheduler tick to enqueue it again.

**Fix:** Track why work was queued. Recheck scheduled eligibility at execution time, including after cooldown. Preserve explicit manual requests. Defer an intentionally canceled scheduled check until its next eligible slot, without erasing history.

**Done when:** A backlog does not start scheduled checks after the window closes; disabling scheduling or excluding a permit prevents its queued scheduled work; canceling a queued item is not undone one minute later. Test these through queue behavior with controlled time.

### F10. Stop scheduling before the store closes

**Evidence:** `scheduleDue` reads the store without checking `shuttingDown`; its interval and resume listener remain active during update/deletion shutdown. It is declared async without awaiting anything. This is already addressed in the open cleanup PR.

**Fix:** Guard shutdown before any store access, make the function synchronous, and manage scheduler timer/listener cleanup alongside shutdown. Account for a failed shutdown that returns to the running app.

**Done when:** A scheduler tick or resume during shutdown cannot access a closed database or create an unhandled rejection. Source: [main/index.ts](../src/main/index.ts), lines 359 and 708.

### F11. Suspend automatic checks when the shared key is unavailable

**Evidence:** `runNext` waits through the global cooldown before reading the key. A missing key creates an authentication failure per permit, advances each permit's next due time, and applies another cooldown. Saving a key broadcasts state but does not immediately resume these failed permits.

**Fix:** Treat unavailable credentials as a shared prerequisite for scheduled work. Pause that work once, surface one key notice, and resume eligible work when a key is saved. Preserve explicit manual-check feedback and distinguish a missing key from a service-rejected key.

**Done when:** A large scheduled queue with no key neither spends minutes manufacturing identical failures nor silently postpones all checks until the next slot after the key is restored.

### F12. Avoid repeated pending history requests

**Evidence:** [renderer/index.ts](../src/renderer/index.ts), `loadHistory` and `onSnapshot`, track only the last completed history key. While it is pending, snapshots about other permits launch duplicate calls. The browser reproduction produced three calls for one opening plus two unrelated updates.

**Fix:** Track the requested permit/history key while loading. Reuse the same pending request for the same key; start a fresh request when the displayed permit or its history changes. Preserve the generation guard against late results and clear pending state after failure.

**Done when:** Unrelated snapshots issue no additional history request while one is pending; switching permits and newer results still win.

### F13. Skip search readiness on an already-open Hernando detail

**Evidence:** [worker/index.ts](../src/worker/index.ts), lines 506-515, waits for detail fields and then unconditionally waits for `#SearchKeyword` or a search link for Tyler. A valid detail page without those controls can incur the full 12-second search timeout. This path is confirmed in code; frequency on live pages is not measured.

**Fix:** Wait for search controls only on the search/home path. Use detail readiness on saved record links.

**Done when:** A ready detail fixture with no search controls finishes without that timeout, while a delayed search form is still awaited correctly.

### F14. Use code for already-established navigation steps

**Evidence:** [check-runner.ts](../src/main/check-runner.ts) calls `chooseNavigation` for every offered step, including a single fill/search/open candidate whose preconditions the worker has already checked. A new TypeSafe client is also constructed for each decision.

**Fix:** Execute a deterministic step when explicit page and readiness checks establish it. One candidate alone is not proof of readiness: retain challenge checks, WAIT/STOP behavior where needed, candidate revalidation, and run limits. Reserve Jev navigation calls for a real semantic choice. Reuse a run-scoped client if calls remain.

**Done when:** Common recorded portal flows need fewer model round trips while stale pages, ambiguous results, and challenges still stop. Record request counts and elapsed time; do not assume an API call costs a fixed number of milliseconds.

### F15. Consolidate worker reads within one observation

**Evidence:** `observe` reads a detail record and `sendObservationOrResult` immediately reads it again. Challenge handling retrieves the full body's `innerText` before slicing it in Node. Locator count/visibility/text calls also make several sequential browser round trips.

**Fix:** Carry the detail data already read through the current observation's verification, and limit text before transferring it out of the browser. Batch independent field reads where this preserves uniqueness and visibility checks. Keep the fresh observation before executing a previously selected action; that revalidation is useful.

**Done when:** A fixture returns the same exact identity/status/link with fewer browser calls, and a page that changes between navigation decisions is still rejected or reobserved. Sources: [worker/index.ts](../src/worker/index.ts), lines 236, 328, 404, and 525.

### F16. Reduce repeated snapshot and credential work

**Evidence:** [key-store.ts](../src/main/key-store.ts) reads the encrypted file in `state()`, then reads it again in `read()`. Every [snapshot](../src/main/index.ts) requests state again. Key save/remove already await a broadcast, but the renderer asks for another snapshot afterward.

**Fix:** Read/decrypt once per credential read, handle absence at that boundary, and avoid redundant snapshot requests after operations that already deliver one. Measure Windows credential-state and login-item calls before adding caches; if cached, invalidate on save/remove and storage failure. Keep the add-permit snapshot unless its manual-jurisdiction notification path is fixed too.

**Done when:** Save/remove updates the UI once, credential changes are reflected immediately, and no plaintext key enters a renderer snapshot or diagnostic.

### F17. Release failed update-download resources

**Evidence:** [updater.ts](../src/main/updater.ts), `download`, closes/removes the temporary file on a read/write/size failure but does not abort the response or cancel its reader. The stall timer is cleared, and opening the file occurs outside the cleanup block. Redirect responses in `fetchHttps` also are not explicitly disposed of.

**Fix:** Own the response, reader, timer, and temporary file through failure cleanup. Abort/cancel remaining network work on failure and dispose of redirect bodies. Keep size, hash, publisher, and final handoff verification.

**Done when:** A controlled failing response or disk write leaves no active download, timer, open file, or partial installer. Keep success-path and integrity checks intact.

## P3: remove duplication without creating new layers

### F18. Reuse the worthwhile parts of the open cleanup PR

[PR #6](https://github.com/sc-frederick/aecPermitViewer/pull/6) predates the current branch. Bring its still-relevant changes forward against current code; do not merge its old test helpers blindly.

- Replace `setManualError`, `setFieldError`, and `setKeyError` with the existing `setInlineError` calls. Reuse `clockFormat`, `make`, and `icon` where duplicate implementations remain.
- Share the project-number rule and length limit between form feedback and IPC parsing. Retain the boundary schema.
- Share the worker environment allow-list between normal runs and packaged smoke. Keep the key excluded.
- Simplify the worker failure helper to accept its changing inputs rather than repeating the message envelope.
- Remove the unused `START_URL`, `i-refresh`, `.btn-arrow`, and empty non-Windows block. Legacy Hillsborough aliases are a compatibility change, not dead code; remove them only after confirming the supported callers use profile IDs.
- Remove the identical `APIConnectionError`/`APIError` catch result and redundant updater billion-byte check. Keep candidate-count enforcement at the boundary that owns navigation input; retain fresh-candidate validation in the worker.

**Validation:** Typecheck, lint, tests, build, and a focused renderer check. Do not add tests that merely freeze the replacement helper's shape. F10 tracks the shutdown fix separately.

### F19. Keep model metadata in one place

**Evidence:** [store.ts](../src/main/store.ts), line 325, embeds `jev-1.13.0` while the caller uses `JEV_MODEL` from [permit.ts](../src/shared/permit.ts). An upgrade can make recorded requested-model metadata disagree with the actual request. New action judgments will also need their own prompt/rule version.

**Fix:** Pass or share the actual model/version metadata at the run boundary. Keep navigation and action-classification metadata distinguishable.

**Done when:** A model configuration change reaches both the request and stored audit data without editing a second string literal.

### F20. Trim brittle assertions and repeated fixture data

**Evidence:** [store.test.ts](../tests/store.test.ts), line 350, asserts the exact index name `idx_runs_started`. The preceding assertion already verifies the selected browser version. A renamed or improved index can fail this assertion without worsening behavior. Successful-observation fixture literals are repeated in several tests.

**Fix:** If retaining a query-plan guard, assert the property it protects, such as avoiding an unnecessary sort, rather than a private index name. Share stable observation fixture data where that makes scenarios clearer. Keep expected outcomes explicit in each test.

**Already resolved on master:** The hardcoded nine-jurisdiction count is gone. Store tests now use `withDatabase`, a separate SQLite connection with explicit cleanup. PR #6's older `rawDb()` private-field cast would regress that improvement.

**Keep:** Identity/link rejection tests, persistence after failed checks, deletion cascades, migrations, scheduler boundaries, signature verification, browser integrity, and action-table uniqueness. These protect actual behavior. There is no evidence that deleting test suites would materially speed this project; the full suite took about one second locally.

## Measure first: possible later improvements

### F21. Stage only the browser variant the app uses

[stage-browsers.mjs](../scripts/stage-browsers.mjs) installs all of Chromium's default payload, while the worker always launches headless. The local Linux payload contains about 393 MiB of full Chromium, 261 MiB of headless shell, and 4.9 MiB of FFmpeg. Investigate headless-shell-only staging using the installed Playwright version's supported options. Verify Windows launch, HTTPS, every supported portal family, integrity manifests, and packaged smoke before removing anything. This is separate from the confirmed duplicate-copy problem F03.

### F22. Reuse a browser process across checks only if launch time warrants it

Every check creates a utility process and Chromium, then closes both. Measure launch/close time and peak memory after F04/F14. If worthwhile, keep a bounded worker/browser lifetime with a fresh isolated context per permit and explicit crash recovery. Do not trade reliable cancellation and clean session isolation for an unmeasured saving.

### F23. Bound history loading only when accumulated history warrants it

[store.ts](../src/main/store.ts) returns every run and observation; [history.ts](../src/shared/history.ts) reduces them to daily entries in the renderer. The one-year fixture was fast, so this is below row rendering and duplicate request fixes. If multi-year or high-frequency histories become slow, page by complete days and preserve the day's latest successful observation even when a later attempt failed. Do not delete unchanged observations merely to reduce UI work.

### F24. Separate fast CI feedback from installer construction

[windows.yml](../.github/workflows/windows.yml) stages browsers, creates the full installer, and runs a live public-portal smoke on every PR. Artifact upload is already restricted to releases/manual runs. Measure step timings before changing job boundaries. Consider canceling superseded PR runs and giving code checks an earlier result while retaining a required Windows package/smoke gate for shipping. Do not weaken coverage simply to report a shorter build.

## Validation gaps

When this list was written, the tests covered domain functions and SQLite behavior only. Since then, these have gained tests: the built renderer with a controlled bridge (focus, row reuse, filtering, pending history), `CheckQueue` through its ports with controlled time (pacing, cancellation, keys, eligibility, shutdown), recorded Hernando pages for record-vs-plan fields and readiness waits, `chooseNavigation` through the SDK's fetch seam (malformed, uncertain, and unknown answers, cancellation, and retries), and update downloads that stop early or fail while writing.

Still open, as of September 28, 2026 (see the [codebase audit](AUDIT-2026-09-28.md) for detail):

- A labeled permit evaluation and workflow-chronology fixtures for F01, F02, and F08: outstanding requests, cleared requests, and missing evidence. Keep the exact state, selected outcome, and safe diagnostics needed to tell missing evidence from model mistakes. Never record the key.
- Recorded pages for the other portal families (Accela, Click2Gov, WMIS, ePermit, RegPermitting): success, ambiguity, stale pages, and not found. Only Hernando has DOM fixtures; the others rely on parsing and URL tests. Run live smokes separately from repeatable fixture tests.
- The main-process composition: IPC handlers, credential recovery, snapshot ordering, and the check runner's utility-process lifecycle.
- `UpdateManager` operation ordering (a recheck during a download), and the update Worker's handler.
- Migration backups taken while committed data is still in SQLite's WAL file.

Do not add module mocks, tests for trivial wrappers, or assertions pinning incidental markup, function calls, list lengths, or private names. Tiny functions that centralize real rules or boundaries still earn their place: the preload bridge, SQLite parsing/transaction helpers, `parsePortalUrl`, and shared action lookup should not be deleted just for being small.

## Suggested implementation order

1. **Small cleanup and guard fixes:** F07's empty-state wording, F10, F12, F13, and F18-F20. Keep current test improvements when reconciling PR #6.
2. **Package and dashboard performance:** F03 and F05, with packaged verification and before/after renderer measurements.
3. **Queue behavior and fewer round trips:** F04, F09, F11, and F14-F17. Preserve portal pacing and cancellation.
4. **Action accuracy:** F06, then F01/F02/F08 together as an evidence-to-badge path. F07's uncertainty badge belongs with this work. Validate decisions on labeled permits before treating them as authoritative.
5. **Only after measurement:** F21-F24. Keep the already-fast SQLite list path and existing useful tests unless new evidence changes the priority.
