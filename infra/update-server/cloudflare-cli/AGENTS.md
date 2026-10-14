# Cloudflare CLI tooling

Use the runner in this directory for native cf commands. Its target configurations
and dependency locks are separate from the application framework dependencies.
Keep the application package manager and existing stable framework adapter.

When changing runtime settings, reconcile the native cloudflare.config.ts, the
original Wrangler config used by framework tooling, and Alchemy definitions where
present. Update projects.json sourceHash after reviewing that reconciliation.

Preserve deployment owners and release approval gates. Keep Durable Object storage
matching its live namespace. In particular, the notes backend uses legacy-kv.
Local D1 migration aliases use Wrangler until cf beta 12's shutdown issue is fixed.
The dev runner links .wrangler/state to the original application state directory.
Do not substitute cf's global state directory or regenerate resource identities.

Use cf cli search with an anonymous task description to discover API commands.
Raw resource commands require IDs. Follow the parent project's rules for dev
servers, deployments, testing and active agent work.
