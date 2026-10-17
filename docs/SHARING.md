# Shared lists

One person sets up and checks the permits. Others follow that list read-only from their own copy of Permit Monitor, with no account and no setup beyond pasting a code. An app can share or follow, not both.

## How it works

### Sharing

**Settings → Shared list → Share this list** shows a code: `PMS1-` followed by 64 characters. The app sends an encrypted copy right away, then again whenever the list has changed and its checks have finished, meaning no checks are queued or running and the list has been unchanged for 2 minutes.

A scheduled round of checks therefore goes out as one copy, about three a day with the default check times. An edit outside a round, such as removing a permit, goes out 2 minutes later. **Sync now** in the header sends the list immediately.

The copy holds each permit, its latest status and review evidence, and one history entry per day for the last 120 days. Each history entry carries only that day's outstanding review requests, which is all the history view shows.

### Following

Paste the code under **Follow a shared list**. The window then shows the shared list in place of the follower's own, and the follower's own permits are neither shown nor checked. Check now, adding, removing, project numbers, and schedule toggles are hidden in the window and refused by the main process.

The follower fetches a newer copy at startup and then 90 minutes after each of the owner's check times, which the shared copy includes, so it looks when the owner's round should be done. A round of 60 Accela permits takes at least 30 minutes because checks on one portal are 30 seconds apart. A round that runs longer shows up at the next check time.

- If the owner has no schedule, the follower fetches every 3 hours.
- After a failed fetch, it tries again in 15 minutes.
- **Sync now** in the header fetches immediately.
- Check times are compared in local time, so the owner and followers are assumed to share a time zone.

When a newer copy shows that the owner has checked a permit since the last copy, the follower gets the same notice the owner's app would give: a status change, a new review request, or a first failure. The follower keeps the last copy, so it opens without a network connection. Record links go through the same portal allowlist as the follower's own.

### Stopping

**Stop sharing** deletes the stored copy, so the code stops working. Followers keep the last copy they received and see "The shared list was removed."

**Delete all data** also deletes the stored copy. If that deletion fails, nothing is deleted locally, because the write key it would erase is the only way to delete the stored copy.

## Why a Durable Object, not D1

The service is the `permitmon-sync` Worker in `infra/sync-server`, with one SQLite-backed Durable Object per shared list.

- **Each list is its own unit.** Every operation reads or writes one list, and nothing queries across lists. With D1, every list would share one database and each query would need to filter by list, so a bug in that filter could expose one firm's list to another. With a Durable Object per list, a request reaches a list's storage only through its name, and the Worker derives that name from the caller's token.
- **One writer, strong consistency.** A Durable Object handles requests for one list one at a time, so revisions go up in order and a reader never sees a half-written copy. A list's first revision is random, so a list deleted and shared again never reuses a revision a follower still holds. D1 gives the same guarantee only inside one query, and its read replicas can serve an older copy.
- **Expiry.** Each list sets its own alarm, which deletes a list nobody has published to for 180 days. The same object could later push updates to followers over hibernating WebSockets instead of polling.
- **Cost.** A shared list is one row of up to 1.5 MB. Seventy-five permits, each with a full 120 days of history and a 12-process review workflow, measured 570 KB sealed. A typical list, where most permits are weeks old, is much smaller. SQLite-backed Durable Objects are available on the Workers Free plan.

KV was ruled out: its reads can lag writes by about a minute, and it has no way to refuse a publication that arrives too soon.

## Keys and what the service can see

The publishing app makes three secrets:

| Secret      | Size                               | Who holds it                          | Sent to the Worker?       |
| ----------- | ---------------------------------- | ------------------------------------- | ------------------------- |
| Write key   | 32 random bytes                    | Publisher only                        | Yes, to publish or delete |
| Read token  | 16 bytes, SHA-256 of the write key | Publisher and followers (in the code) | Yes, to fetch             |
| Content key | 32 random bytes                    | Publisher and followers (in the code) | Never                     |

- The list is gzipped and sealed with AES-256-GCM under the content key before it leaves the app, so the Worker and Cloudflare store only ciphertext.
- The Worker names a list's Durable Object `SHA-256("permitmon-share-room\0" ‖ read token)`. Given a write key, it derives the read token first, so both reach the same object. A follower holds the read token but can't derive the write key, so it can't publish or delete.
- The Worker stores no key or token. Its admission database stores room hashes and source hashes, never IP addresses, bearer credentials, or ciphertext.
- Tokens travel in the `Authorization` header, never the URL, so they stay out of request logs.
- An unknown code and a deleted list both return 404. A read never writes storage.
- The keys sit in the app's local SQLite settings, next to the permit data they protect, which is already stored there in the clear. Unlike the TypeSafe key, they don't need operating-system encryption, so sharing also works in development on Linux.

Anyone with the code can read the list until sharing stops. Treat it like a link to a shared document. To revoke one person's access, stop sharing and share again, which makes a new code, and send the new code to everyone else.

## Limits

| Limit                     | Value                        | Notes                                                                                                                          |
| ------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| List size                 | 1.5 MB of ciphertext         | Durable Object rows hold 2 MB. Past the limit, the app reports "The list is too large to share."                               |
| Publication rate per list | One every 10 seconds         | The app itself sends only after a round of checks, on request, or 2 minutes after an edit.                                     |
| Publication attempts      | 60 per source per UTC minute | Counts malformed requests and updates to existing lists.                                                                       |
| New lists per source      | 5 per UTC day                | Changing write keys doesn't get around it. Existing lists don't count.                                                         |
| New lists per deployment  | 100 per UTC day              | Existing lists keep updating when creation quotas are full.                                                                    |
| Lists per deployment      | 1,024, permanently reserved  | Caps admitted ciphertext at 1,536,000,000 bytes, plus SQLite metadata and the [legacy baseline](#lists-from-before-admission). |
| Tracked sources           | 4,096 counter rows           | When the table is full, a new source gets 429 before any room access or body read.                                             |

The source is Cloudflare's trusted `CF-Connecting-IP`. IPv6 addresses share a quota per /64. Client-supplied forwarding headers are ignored. Requests with a missing or invalid address share one bucket, which includes local development. Several users behind one public IPv4 address share its quota.

Counters from earlier UTC days are pruned when no request in the current minute uses them. List-name rows are bounded by the 1,024-list cap, and no Durable Object is created per source.

The limits are Worker variables: `SHARE_SOURCE_WRITES_PER_MINUTE`, `SHARE_SOURCE_CREATIONS_PER_DAY`, `SHARE_DEPLOYMENT_CREATIONS_PER_DAY`, `SHARE_REGISTERED_ROOMS`, and `SHARE_TRACKED_SOURCES`. Deployment reads them from `infra/sync-server/cloudflare-cli/app/cloudflare.config.ts`, and local `wrangler dev` reads them from `infra/sync-server/wrangler.jsonc`, so change both. The admission object validates them at startup.

### Why list slots are never recycled

Deleted and expired lists keep their slots, and republishing with the same key reuses its slot. The cap limits lifetime admissions on purpose. A delayed deletion, a failed expiry alarm, or a publication whose reply was lost could otherwise free a slot while its ciphertext is still stored. Raising the cap requires reviewing the storage budget. Renaming or resetting the admission object, or deploying a Worker without admission, invalidates the budget and must not be used to clear capacity.

### How admission works

Admission runs in one fixed SQLite-backed Durable Object, `deployment-budget-v1`, which coordinates the shared budget. GET and DELETE go straight to each list. A Workers rate-limit binding can't enforce a storage budget on its own, because its counters are [eventually consistent](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/#accuracy). The admission object uses synchronous SQL with no I/O in between, and Cloudflare's [storage gates](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#transaction) serialize its checks and writes. If it fails, the Worker answers 503 rather than skipping the policy.

1. Source-request limits are checked before any room access or body read.
2. Creation quotas and capacity are checked before reading ciphertext.
3. After the body is validated, they are checked again atomically, before the list's first storage write.

Concurrent requests can use up their source-request budget while their bodies are read, but they can't overbook list slots. A rejected request leaves no list table, ciphertext, or alarm, only bounded admission counters. A malformed body reserves no slot. A failed or uncertain first publication keeps its reservation, since the room may already have accepted the bytes.

Every quota rejection returns 429 with a `Retry-After` between 1 and 3,600 seconds. The publisher keeps the pending change and retries after that interval, and Sync now reports the delay. Exhausted daily quotas or capacity can take several retries, and capacity needs an operator to raise it.

Source quotas limit abuse while keeping sharing accountless, but a distributed attacker can still use up the finite budget for new lists. Reads, deletes, and writes to lists already admitted keep their separate capabilities.

### Lists from before admission

Lists stored before the admission object existed form a legacy baseline outside the 1,024-list budget. A read-only existence check lets those lists keep updating when the budget or a creation quota is full. The check creates no list table or alarm and reads no ciphertext. New lists always reserve capacity first, so they can't become uncounted legacy lists. Once a legacy list is deleted or expires, sharing again must pass admission.

Each legacy list can still grow to 1.5 MB. Budget total storage as 1,500,000 bytes per legacy list, counted from Cloudflare's Durable Object analytics, plus the 1,536,000,000-byte admission budget and SQLite overhead.

### Monitoring

Worker observability samples all requests. Logs omit credentials, raw source addresses, and list contents.

- `share_admitted` reports `registeredRooms`, `roomCapacity`, and `maximumCiphertextBytes`. Alert before 80% of capacity. `registeredRooms` excludes the legacy baseline, so track that separately.
- `share_admission_denied` reports the reason, one of `source_writes`, `source_creations`, `deployment_creations`, `room_capacity`, or `tracked_sources`, with the retry delay. Sustained creation or capacity rejections call for a review of abuse and the storage budget. Source-write rejections can also mean many users behind one NAT.
- `room_failure` includes the failed operation.

Also review retained storage, SQLite row and operation usage, Worker errors, and 429 counts.

## Protocol

`/v1/list` on the Worker:

| Method   | Bearer     | Body       | Answers                                                                                                                                    |
| -------- | ---------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET`    | read token | none       | `200` ciphertext with `ETag: "r<revision>"` and `X-Published-At`; `304` when `If-None-Match` names the current revision; `404` when absent |
| `PUT`    | write key  | ciphertext | `200 {"revision","publishedAt"}`; `413` too large; `429` rate, admission, or capacity limit, with a bounded `Retry-After`                  |
| `DELETE` | write key  | none       | `204`, also when nothing was stored                                                                                                        |

`401` means a missing or malformed credential, and `503` means the Durable Object failed. `src/shared/share-protocol.ts` holds the token formats and derivations, and both the app and the Worker import it.

## Deploying and developing

The Worker runs on the Workers Free plan. It imports `zod/mini` rather than `zod` to keep the bundle small, about 35 KB. The `Sync server` workflow deploys it when it changes on master; see [RELEASE.md](RELEASE.md#shared-list-service) for the workflow, the deploy token, and deploying by hand.

The app uses `https://permitmon-sync.sc-frederick.workers.dev`, which `windows.yml` builds in as `SHARE_SERVICE_URL`. It doesn't use an `aeccloud.io` host because Bot Fight Mode there challenges non-browser clients. A build without `SHARE_SERVICE_URL` hides sharing.

The `v2` migration in `wrangler.jsonc` added the admission object and kept existing list storage. After changing bindings or limit variables, update the runner's `sourceHash` as described in `infra/sync-server/cloudflare-cli/README.md`, and regenerate the committed binding types from `infra/sync-server`:

```sh
npx wrangler@4.147.0 types src/worker-configuration.d.ts --env-interface SyncWorkerEnv --include-runtime=false --strict-vars=false
```

To validate the configuration without deploying, run `node cloudflare-cli/run.mjs dry-run` from `infra/sync-server`.

To run it locally:

```sh
npx wrangler dev --config infra/sync-server/wrangler.jsonc --port 8787
SHARE_SERVICE_URL=http://127.0.0.1:8787 npm run dev
```

The app accepts plain HTTP only for `localhost`, `127.0.0.1`, and `[::1]`. To try both sides on one machine, start a second instance with `--user-data-dir=<another folder>`.

`npm test` covers the Worker's routes, admission budget, and room, with `node:sqlite` standing in for Durable Object storage, and runs both apps end to end against it over HTTP. `tests/share-admission.test.ts` also checks that the real client receives a 429 and delivers its pending publication after `Retry-After`.
