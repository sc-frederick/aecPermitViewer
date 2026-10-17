# Cloudflare CLI runner

`run.mjs` builds, runs, and deploys the `permitmon-sync` Worker with Cloudflare's `cf` CLI. The toolchain is pinned in `app/package.json`, `cf` 1.0.0-beta.12 with Wrangler 4.147.0 as its bundler, and has its own lockfile so it stays out of the repository's dependency tree. The runner installs it with `npm ci` on first use.

## Commands

Run these from `infra/sync-server`. The Worker bundles `zod` and `src/shared/share-protocol.ts` from the repository, so run `npm ci --allow-git=all` at the repository root first.

```sh
node cloudflare-cli/run.mjs dry-run    # bundle and validate without deploying
node cloudflare-cli/run.mjs deploy     # deploy by hand
```

The `Sync server` workflow, `.github/workflows/sync-server.yml`, runs `dry-run --skip-prepare` on pull requests and `deploy --message "$GITHUB_SHA"` on master. This Worker has no prepare step, so `--skip-prepare` changes nothing here. The workflow authenticates with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. Run by hand, the runner uses the same `cf` profile as a globally installed `cf` CLI. See `docs/RELEASE.md` for the deploy token.

Any other command passes through to `cf`, which runs inside `cloudflare-cli/app`. Pass absolute paths to commands that read files. `npm run cf -- <command>` in this directory does the same.

Don't run `cf deploy` directly from the Worker directory. `cf` would autodetect the project there and could deploy without these settings.

## Configuration

- `app/cloudflare.config.ts` is what deploys: the Worker name, entry point, compatibility date, observability, the `ShareRoomObject` and `ShareAdmissionObject` Durable Object classes and their bindings, and the admission limit variables.
- `app/wrangler.config.ts` holds bundler settings. The bundle is minified.
- `../wrangler.jsonc` is the original Wrangler configuration. Local `wrangler dev` and `wrangler types` read it, and it holds the Durable Object migration history.

The two configurations describe the same Worker, so a binding, variable, or runtime setting changed in one must change in the other.

## Keeping the configurations in sync

`projects.json` records the SHA-256 of `wrangler.jsonc` as `sourceHash`. Before `build`, `dev`, `deploy`, or `dry-run`, the runner hashes `wrangler.jsonc` and stops if it doesn't match:

```text
wrangler.jsonc changed after migration. Reconcile app/cloudflare.config.ts and update projects.json sourceHash before continuing.
```

Any change to `wrangler.jsonc` trips this check, including reformatting. To clear it, make the matching change in `app/cloudflare.config.ts` or `app/wrangler.config.ts`, then record the new hash. From `infra/sync-server`:

```sh
node -e "console.log(require('crypto').createHash('sha256').update(require('fs').readFileSync('wrangler.jsonc')).digest('hex'))"
```

Put the output in `projects.json` as `app.sourceHash`.

## Local development

`node cloudflare-cli/run.mjs dev` links `app/.wrangler/state` to `infra/sync-server/.wrangler/state`, the Worker's existing local state directory. Pass `--persist-to <dir>` to use a different state directory. The dev server takes `--port` and `--host`; Wrangler's `--ip` flag is not supported.

The runner also links any `.env*` and `.dev.vars*` files in `infra/sync-server` into `app/`. It never copies their contents, and Git ignores the links.

`docs/SHARING.md` describes running the Worker with `wrangler dev` alongside the app.
