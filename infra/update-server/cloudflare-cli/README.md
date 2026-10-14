# Cloudflare CLI

Use `node cloudflare-cli/run.mjs <command>` from this Worker directory. The package
scripts `cf`, `cf:build`, `cf:dry-run`, `cf:dev`, and `cf:types` use the same runner
where a package manifest is available. Targets: app. Select another target
with `--target mcp` or `--target build`. Select an environment with `--mode`.

```
node cloudflare-cli/run.mjs dry-run
node cloudflare-cli/run.mjs dry-run --skip-prepare
node cloudflare-cli/run.mjs dev
node cloudflare-cli/run.mjs workers types
```

The runner builds with this project's existing framework and then runs the pinned
`cf` CLI against the native configuration in `cloudflare-cli/<target>`. Its separate
dependency lock keeps this beta migration out of the application dependency tree.
On a fresh checkout it installs those dependencies with `npm ci`. Authentication
uses the same cf profile as the globally installed CLI. Do not run bare `cf deploy`
from the application root: framework autodetection there can bypass these settings.

`cloudflare.config.ts` contains Worker identity, routes, bindings, runtime settings,
and exported classes. `wrangler.config.ts` contains build settings for cf's supported
Wrangler bundler. Existing Wrangler configs remain necessary for the current stable
framework adapters and legacy compatibility checks. Reconcile both when changing a
binding or runtime setting. The runner stops if the old config changed; update its
SHA-256 in `projects.json` after reviewing the corresponding native config changes.

Local development explicitly retains `.wrangler/state`.
D1 migration aliases use the configured database ID, migration directory and state:

```
node cloudflare-cli/run.mjs db:migrate DB --local
node cloudflare-cli/run.mjs db:migrate DB --remote
```

Use the original binding or database name instead of `DB` when different. Raw cf API
commands take Cloudflare IDs. Pass absolute paths to raw commands that read files,
because the CLI runs inside its target directory. Native type generation writes
types inside that directory; existing checked-in declarations and their verification
commands remain available until the framework integration supports the new output.

Deployment owner: `cf`. Native direct deployment is enabled only for targets
owned by `cf`. Alchemy and existing promotion/release pipelines keep resource
ownership and approval gates. Use their existing deployment commands. Native build,
dry-run and API commands remain available for every target. Do not start a dev server
where this repository's instructions require permission.

Migration limitations:
No additional project-specific conversion limitations.

Reference: https://developers.cloudflare.com/cf/wrangler/migrate/

Local D1 migration aliases use the pinned Wrangler compatibility backend because cf beta
12 does not exit after completing local D1 requests. Remote migration aliases use
cf. This preserves existing local data and lets automated scripts terminate.

The runner links the dev server's default state directory to the existing repo
state. The beta dev delegate does not forward the global `--persist-to` option.
Use this runner to choose a different state directory. Native dev arguments include
`--port` and `--host`; Wrangler's old `--ip` flag is unsupported by the cf delegate.
Raw cf local resource requests also have the D1 shutdown limitation described above.

Original dotenv and dev-variable files are linked beside the native config at run
time. The links are ignored by Git; file contents are never copied into this tooling.
