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
- The Worker names a list's Durable Object `SHA-256("permitmon-share-room\0" ‖ read token)`. Given a write key, it derives the read token first, so both sides reach the same object. A follower holds the read token but can't work out the write key, so it can't publish or delete. The Worker stores no key or token.
- Tokens travel in the `Authorization` header, never the URL, so they stay out of request logs.
- An unknown code and a deleted list both answer 404. A read never writes storage.
- The keys sit in the app's local SQLite settings, next to the permit data they protect. That data is already stored there in the clear, and unlike the TypeSafe key they need no Windows-only encryption, so sharing also works in development on Linux.

Anyone who has the code can read the list until sharing stops. Treat it like a link to a shared document. To revoke one person's access, stop sharing and share again, which makes a new code, and send the new code to everyone else.

## Limits

- 1.5 MB of ciphertext per list (Durable Object rows hold 2 MB); the app reports "The list is too large to share." past it.
- One publication per list every 10 seconds (the Worker answers 429 with `Retry-After`, and Sync now says to try again shortly). The app itself sends only after a round of checks, on request, or 2 minutes after an edit.
- There is no per-IP rate limit. Anyone can create lists by making up write keys, bounded by the size limit and the 180-day expiry. If that becomes a problem, add a Workers rate-limiting binding in front of `PUT`.

## Protocol

`/v1/list` on the Worker:

| Method | Bearer | Body | Answers |
| --- | --- | --- | --- |
| `GET` | read token | — | `200` ciphertext with `ETag: "r<revision>"` and `X-Published-At`; `304` when `If-None-Match` names the current revision; `404` when absent |
| `PUT` | write key | ciphertext | `200 {"revision","publishedAt"}`; `413` too large; `429` too soon |
| `DELETE` | write key | — | `204`, also when nothing was stored |

`401` means a missing or malformed credential, and `503` means the Durable Object failed. `src/shared/share-protocol.ts` holds the token formats and derivations, and both the app and the Worker import it.

## Deploying and developing

The Worker was first deployed on September 28, 2026, and it runs on the free plan. The Worker imports `zod/mini` (`import * as z`), not `zod`, which keeps the bundle at about 27 KB instead of about 280 KB. Deploy with `npx wrangler deploy` from `infra/sync-server` after `npm ci --allow-git=all` (the Worker bundles `zod` and `src/shared/share-protocol.ts` from the repository). The app uses `https://permitmon-sync.sc-frederick.workers.dev`, which `windows.yml` builds in as `SHARE_SERVICE_URL`, because `aeccloud.io`'s Bot Fight Mode challenges non-browser clients. A build without `SHARE_SERVICE_URL` hides sharing.

To run it locally:

```sh
npx wrangler dev --config infra/sync-server/wrangler.jsonc --port 8787
SHARE_SERVICE_URL=http://127.0.0.1:8787 npm run dev
```

The app accepts plain HTTP only for `localhost`, `127.0.0.1`, and `[::1]`. To try both sides on one machine, start a second instance with `--user-data-dir=<another folder>`. `npm test` covers the Worker's routes and room with node:sqlite standing in for Durable Object storage, and covers both apps end to end against it over HTTP.
