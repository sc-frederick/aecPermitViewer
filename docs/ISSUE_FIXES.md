# Open-issue fixes, September 30, 2026

This change addresses every issue open at the start of the work: #21 through #35. The audited baseline is `6bf018d`.

| Issue | Result | Regression coverage |
| --- | --- | --- |
| #21 | CI and manual uploads conditionally create immutable final artifacts; private staging is validated and cleaned independently. | `publish-update.test.ts`, `publish-feed.test.ts`, `update-server.test.ts`: competing manual/manual and CI/manual publishers, either winner, identical retries, failed validation, unconsumed-stream rejection. |
| #22 | Saves, removal and migrations share one mutation queue; obsolete reads reread the current generation. Each write has a unique temporary file. | `key-store.test.ts`: held decrypt with removal/replacement, concurrent mutations, encryption failure preserving the previous file, obsolete read failure. |
| #23 | Announcement reads the preceding completed outcome before finishing the active run. Interrupted recovered runs count as failures without replaying a startup notice. | `desktop-regressions.test.ts` exercises real SQLite start/finish announcements; existing notification/review tests retain status and review behavior. |
| #24 | Authentication rejection applies only to the check's key generation. Delayed reads reread the replacement; delayed starters retain the original request for the new key. | `check-queue.test.ts`: delayed read and starter, stale rejection, current rejection, pending work and scope spacing. |
| #25 | Schedule edits and deadline realignment are atomic. Ordinary future deadlines move both directions; overdue catch-up remains due. A pending service retry retains its completion-based hour deadline, capped by the new next slot. Explicitly deferred retries follow the new slot. | `store.test.ts`: postponed/advanced/removed slots, overdue and midnight catch-up, transient retry, transaction rollback. |
| #26 | A Linux publication-test job runs on ordinary PR/master workflows without upload credentials or browser staging. | The job runs all publication script and Worker cases. The executable test process exits nonzero on failed assertions. |
| #27 | Accountless writes pass source quotas and a fixed deployment admission budget before storing a fresh list. Existing shares retain capability separation and can keep updating. | `sync-server.test.ts`, `share-admission.test.ts`: rotating keys, source/deployment/capacity limits, unread rejected bodies, concurrent reservations, legacy shares, restart, real HTTP retry. |
| #28 | A follower saves its cache before committing the new revision and notifying listeners; local save failures have their own message and retry. | `share-follower-persistence.test.ts`: real SQLite trigger failure, recovery, unchanged response, one update, offline restart. |
| #29 | Both release paths require the same-version Mac ZIP before promoting the common manifest. Windows-only manual publication leaves the known-good manifest/downloads intact. | Real manual and CI scripts plus Worker tests cover missing Mac archives and immutable ZIP retries. |
| #30 | Indexed daily seeks select the retained rows before parsing review JSON. Details page at 120 days; sharing reads exactly its 120 entries per permit, yields between permits, and compresses asynchronously. A store mutation while yielding causes a fresh snapshot. Raw history remains available. | `daily-history-store.test.ts`, `history-growth.test.ts`, `renderer.test.ts`, `sharing.test.ts`: daily pick parity, reviews/DST, whole-day cursors, obsolete page replies, discarded malformed JSON, consistent publication, growth/responsiveness budget. |
| #31 | Accela Global Search fingerprints include a bounded digest of actual result rows and pager identity. Nonmatching rows remain local. | Routed Chromium `worker-global.test.ts`: exact record on page 3 with zero model requests, changed rows/pager, unchanged postback, ambiguity and terminal no-match. |
| #32 | Repeated established actions settle locally for four 800 ms re-observations and then fail deterministically. Unresolved choices retain the model path. | `check-runner.test.ts`: zero SDK calls, delayed progress, deterministic failure, cancellation/deadline. |
| #33 | SFWMD detail reads share a bounded wait for exact identity and the correct nonblank status field across saved links/search results. | Routed Chromium `worker-regpermitting.test.ts`: delayed permit/application/water-use fields, wrong identity, missing status and approved URL validation. |
| #34 | The twentieth action may produce a verified result; main and worker refuse action 21. | `check-runner.test.ts`: action 20 success, observation requiring action 21, impossible count, cancellation/deadline. |
| #35 | Every saved insertion announces the change independently of whether checking can queue. Existing serial broadcasting coalesces the automated queue's notification. | `desktop-regressions.test.ts`: Palm Bay, Orange and Baker with no subsequent mutation, local/tray/publication listeners, one automated enqueue/snapshot, duplicate insertion. |

## History growth benchmark

Run `npm run benchmark:history`. The fixture stores 75 permits, three successful observations per day and 20 outstanding reviews per observation, first for one year and then three years. Each publication materializes exactly 9,000 observations, versus 82,125 and 246,375 stored observations. Checks fail if a permit read or event-loop delay exceeds 100 ms, or if the event loop never gets a turn during publication. The final JSON assembly is included in the delay measurement. The publication contains about 22.7 MB of uncompressed JSON in this deliberately review-heavy fixture.

Local runs take roughly 0.7–0.9 seconds spread over 74–75 event-loop turns; these are synthetic host measurements, not production telemetry. Both fixture sizes publish identical retained content. Benchmark measurements are printed and saved to the operating system's temporary directory as `aec-history-365.json` and `aec-history-1095.json`.

## Verification and rollout boundaries

The full local suite has 374 passing tests. Typechecking, lint, the application build and whitespace checks pass. SQLite schedule, history and announcement tests also pass with `TZ=America/New_York`. Disabling the sharing revision guard makes its consistency regression fail; restoring it passes.

The release Worker was also bundled and exercised under native local workerd/R2, including multipart completion, conditional publication and stream cleanup. The sync Worker passed generated-binding checks, a dry-run bundle and a local SQLite Durable Object smoke: rotating keys hit admission limits while an existing list still updated. No live resources were deployed or released.

Review the configured source and deployment limits in [SHARING.md](SHARING.md#limits). The permanent new-room cap bounds newly admitted ciphertext to 1.536 GB; pre-upgrade shares require a separate retained-room inventory and storage allowance before rollout. A distributed caller can exhaust finite enrollment capacity; increasing the reviewed cap is the operator recovery mechanism.

This PR does not qualify live third-party portals, Windows clean-machine installation or macOS distribution. Those release checks remain in [RELEASE.md](RELEASE.md#required-checks-before-distribution).
