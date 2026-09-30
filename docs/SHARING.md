# Shared lists

One person sets up and checks the permits. Others follow that list read-only from their own copy of Permit Monitor, with no account and no setup beyond pasting a code.

## How it works

- **Share:** Settings → Shared list → **Share this list** shows a code (`PMS1-…`, 69 characters). The app sends an encrypted copy right away, then again whenever the list has changed and its checks have finished: it waits until no checks are queued or running and the list has been still for 2 minutes. A scheduled round of checks therefore goes out as one copy, about three a day with the default times. Edits outside a round, such as removing a permit, go out 2 minutes later. **Sync now** in the header sends the list immediately. The copy holds each permit, its latest status and review evidence, and one history entry per day for the last 120 days. History entries carry only that day's outstanding review requests, which is all the history view shows.
- **Follow:** paste the code under **Follow a shared list**. The window then shows the shared list in place of the follower's own, and the follower's own permits are neither shown nor checked. Check now, adding, removing, project numbers, and schedule toggles are hidden, and main refuses them too. The follower asks for a newer copy when it starts, and then 90 minutes after each of the owner's check times, which the shared copy includes, so it looks when the owner's round should be done. A round of 60 Accela permits takes at least 30 minutes, because checks on one portal are 30 seconds apart. A round that runs longer shows up at the next check time. If the owner has no schedule, the follower asks every 3 hours. After a failed fetch it tries again in 15 minutes. **Sync now** in the header fetches immediately. Check times are compared in local time, so the owner and followers are assumed to share a time zone. When a newer copy shows a permit the publisher has checked since the last one, the follower gets the same notice the publisher's app would give (status change, new review request, first failure). The follower keeps the last copy, so it opens without a network connection. Record links go through the same portal allowlist as the follower's own.
- **Stop sharing** deletes the stored copy, so the code stops working. Followers keep the last copy they received and see "The shared list was removed." **Delete all data** also deletes the stored copy, and deletes nothing locally when that fails, because the write key it would erase is the only way to delete the copy.
- An app can share or follow, not both.

## Why a Durable Object, not D1

The service is the `permitmon-sync` Worker (`infra/sync-server`) with one SQLite-backed Durable Object per shared list.

- **Each list is its own unit.** Every operation reads or writes one list, and nothing queries across lists. A Durable Object per list matches that. With D1, every list would share one database and each query would need to filter by list, so a bug in that filter could expose one firm's list to another. With a Durable Object per list, requests only reach a list's storage through its name, and the Worker derives that name from the caller's token.
- **One writer, strong consistency.** A Durable Object runs requests for one list one at a time, so revisions go up in order and a reader never sees a half-written copy. A list's first revision is random, so a list deleted and shared again never reuses a revision a follower still holds. D1 gives the same guarantee only inside one query. Its read replicas can serve an older copy.
- **Expiry and room to grow.** Each list sets its own alarm, which deletes a list nobody has published to for 180 days. The same object could later push updates to followers over hibernating WebSockets instead of polling.
- **Cost.** A shared list is one row of up to 1.5 MB. Seventy-five permits, each with a full 120 days of history and a 12-process review workflow, measured 570 KB sealed. A typical list, where most permits are weeks old, is much smaller. SQLite-backed Durable Objects are available on the Workers Free plan.

KV was ruled out: its reads can lag writes by about a minute, and nothing in it can refuse a publication that arrives too soon.

## Keys and what the service can see

The publishing app makes three secrets:

| Secret | Size | Who holds it | Sent to the Worker? |
| --- | --- | --- | --- |
| Write key | 32 random bytes | Publisher only | Yes, to publish or delete |
| Read token | 16 bytes, SHA-256 of the write key | Publisher and followers (in the code) | Yes, to fetch |
| Content key | 32 random bytes | Publisher and followers (in the code) | Never |

- The list is gzipped and sealed with AES-256-GCM under the content key before it leaves the app, so the Worker and Cloudflare only ever store ciphertext.
- The Worker names a list's Durable Object `SHA-256("permitmon-share-room\0" ‖ read token)`. Given a write key, it derives the read token first, so both sides reach the same object. A follower holds the read token but can't work out the write key, so it can't publish or delete. The Worker stores no key or token. Its admission database stores room hashes and source hashes, never IP addresses, bearer credentials or ciphertext.
- Tokens travel in the `Authorization` header, never the URL, so they stay out of request logs.
- An unknown code and a deleted list both answer 404. A read never writes storage.
- The keys sit in the app's local SQLite settings, next to the permit data they protect. That data is already stored there in the clear, and unlike the TypeSafe key they need no Windows-only encryption, so sharing also works in development on Linux.

Anyone who has the code can read the list until sharing stops. Treat it like a link to a shared document. To revoke one person's access, stop sharing and share again, which makes a new code, and send the new code to everyone else.

## Limits

- 1.5 MB of ciphertext per list (Durable Object rows hold 2 MB); the app reports "The list is too large to share." past it.
- One publication per list every 10 seconds. The app itself sends only after a round of checks, on request, or 2 minutes after an edit.
- 60 publication attempts per source per UTC minute, including malformed requests and existing-list updates. The source is Cloudflare's trusted `CF-Connecting-IP`; IPv6 addresses share a /64 quota. Client-supplied forwarding headers are ignored. A missing or invalid source address uses one shared bucket, including local development. Multiple users behind one public IPv4 address share its quota.
- 5 new room names per source per UTC day and 100 new room names across the deployment per UTC day. Changing write keys cannot evade these limits. Existing admitted lists consume no new-room quota and continue updating when creation quotas are full.
- 1,024 permanently reserved room names across the deployment, so ciphertext admitted by this policy cannot exceed 1,536,000,000 bytes, plus SQLite metadata and the pre-upgrade baseline described below. Deleted and expired names keep their slots, and republishing the same key reuses its slot. This deliberately limits lifetime admissions rather than recycling slots across asynchronous objects: a delayed deletion, failed expiry alarm or publication whose RPC answer was lost cannot accidentally free capacity while its ciphertext is still stored. Increasing the cap requires reviewing the storage budget. Renaming/resetting the admission object or reverting to a Worker without admission invalidates the budget and must not be used to clear capacity.
- At most 4,096 source-counter rows. Counters from earlier UTC days are pruned when no request in the current minute uses them. When the table is full, a new source gets 429 before any room access or body read. Room-name rows are bounded by the permanent capacity limit; no Durable Object is created per source.

The limits live in `infra/sync-server/wrangler.jsonc` as `SHARE_SOURCE_WRITES_PER_MINUTE`, `SHARE_SOURCE_CREATIONS_PER_DAY`, `SHARE_DEPLOYMENT_CREATIONS_PER_DAY`, `SHARE_REGISTERED_ROOMS` and `SHARE_TRACKED_SOURCES`. The admission object validates them at startup. Source-request admission happens before any room access or body read; creation quotas and capacity are checked before reading ciphertext and checked again atomically after body validation, before its first storage write. Concurrent candidates can consume their allowed source-request budget while reading bodies, but cannot overbook room slots. Rejected requests retain no list table, ciphertext or alarm; only bounded admission counters remain. Malformed bodies reserve no slot. A failed or uncertain first publication keeps its reservation, conservatively accounting for bytes the room may already have accepted.

Admission uses one fixed SQLite-backed Durable Object, `deployment-budget-v1`, as the coordination unit for the shared budget. GET and DELETE continue reaching each list directly. A Workers rate-limit binding alone cannot enforce this storage budget because its counters are [eventually consistent](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/#accuracy). The admission object uses synchronous SQL without intervening I/O; Cloudflare's [storage gates](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#transaction) serialize its checks and writes. Its failure answers 503 rather than bypassing the policy.

Every quota rejection answers 429 with a `Retry-After` between 1 and 3,600 seconds. The publisher retains the pending change and automatically retries after that interval; Sync now also reports the delay. Daily quota/capacity exhaustion can require several retries, and capacity requires an operator decision to increase it. Source quotas reduce abuse while keeping sharing accountless; a distributed attacker can still exhaust the finite new-share budget. Reads, deletes and writes to previously admitted shares keep their capability separation.

### Existing shares and operational monitoring

Lists stored before the admission policy form a retained baseline outside the new 1,024-room budget. A read-only existence probe lets those lists update even when the new budget or creation quota is full. The probe creates no list table or alarm and reads no ciphertext. Newly stored lists always reserve capacity first, so they cannot become unaccounted legacy lists. Once a legacy list is deleted or expires, sharing again must pass current admission. Existing share codes and room derivations do not change.

Before rollout, record the namespace's retained room count and storage baseline from Cloudflare's Durable Object analytics. Each legacy room can still grow to the 1.5 MB list limit, so budget `legacy room count × 1,500,000` bytes plus the configured new-room ciphertext budget and SQLite overhead. This change does not claim that unknown pre-upgrade data fits inside 1.536 GB. Review retained storage, SQLite row/operation usage, Worker errors, and 429 counts after rollout. No live namespace inventory or deployment is performed by the tests.

Worker observability samples all requests. Structured `share_admitted` events report `registeredRooms`, `roomCapacity` and `maximumCiphertextBytes`; alert before 80% of room capacity. `share_admission_denied` reports `source_writes`, `source_creations`, `deployment_creations`, `room_capacity` or `tracked_sources` with the retry delay. Sustained creation/capacity rejections require reviewing abuse and the storage budget; source-write rejections can also indicate many users behind one NAT. `room_failure` events include the failed operation. Logs omit credentials, raw source addresses and list contents. Track the legacy baseline separately because it is not included in `registeredRooms`.

## Protocol

`/v1/list` on the Worker:

| Method | Bearer | Body | Answers |
| --- | --- | --- | --- |
| `GET` | read token | — | `200` ciphertext with `ETag: "r<revision>"` and `X-Published-At`; `304` when `If-None-Match` names the current revision; `404` when absent |
| `PUT` | write key | ciphertext | `200 {"revision","publishedAt"}`; `413` too large; `429` rate, admission or capacity limit, with bounded `Retry-After` |
| `DELETE` | write key | — | `204`, also when nothing was stored |

`401` means a missing or malformed credential, and `503` means the Durable Object failed. `src/shared/share-protocol.ts` holds the token formats and derivations, and both the app and the Worker import it.

## Deploying and developing

The Worker was first deployed on September 28, 2026, and it runs on the free plan. The Worker imports `zod/mini` (`import * as z`), not `zod`; the admission-enabled dry-run bundle measures about 35 KB. The `Sync server` workflow deploys it when it changes on master (see [RELEASE.md](RELEASE.md#shared-list-service)). To deploy by hand, run `npx wrangler@4.143.0 deploy` from `infra/sync-server` after `npm ci --allow-git=all` (the Worker bundles `zod` and `src/shared/share-protocol.ts` from the repository). The app uses `https://permitmon-sync.sc-frederick.workers.dev`, which `windows.yml` builds in as `SHARE_SERVICE_URL`, because `aeccloud.io`'s Bot Fight Mode challenges non-browser clients. A build without `SHARE_SERVICE_URL` hides sharing.

The `v2` migration adds the admission object while preserving existing room storage. After changing its bindings or limit variables, regenerate the committed binding types from `infra/sync-server` with `npx wrangler@4.143.0 types src/worker-configuration.d.ts --env-interface SyncWorkerEnv --include-runtime=false --strict-vars=false`. A dry-run bundle validates configuration without deploying: `npx wrangler@4.143.0 deploy --dry-run`.

To run it locally:

```sh
npx wrangler dev --config infra/sync-server/wrangler.jsonc --port 8787
SHARE_SERVICE_URL=http://127.0.0.1:8787 npm run dev
```

The app accepts plain HTTP only for `localhost`, `127.0.0.1`, and `[::1]`. To try both sides on one machine, start a second instance with `--user-data-dir=<another folder>`. `npm test` covers the Worker's routes, admission budget and room with node:sqlite standing in for Durable Object storage, and covers both apps end to end against it over HTTP. `tests/share-admission.test.ts` also exercises the real client receiving 429 and automatically delivering its pending publication after `Retry-After`.
