# anti-slop provenance

- Source: https://github.com/dmmulroy/anti-slop
- Commit: `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b` (2026-09-10), copied from `skills/install-anti-slop/assets/anti-slop/` with that skill's `scripts/install.mjs`.
- Installed: `tools/oxlint/anti-slop/index.ts` (generic rules), registered in `.oxlintrc.json` with every generic rule at `error`.
- Oxlint: `oxlint` and `@oxlint/plugins` pinned together at `1.85.0` (upstream tested `1.78.0`).

## Local deviations

- `effect/` removed: this app doesn't depend on Effect, so the opt-in Effect rules aren't installed.
- `package.json` added (`"type": "module"`) so Node loads the plugin as ESM without a reparse warning.
