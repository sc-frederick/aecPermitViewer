# Permit Monitor

Read README.md, PRODUCT.md, and docs/DESIGN.md before changing behavior or the interface, and docs/RELEASE.md before
release work. Use npm. Run the checks listed under Development in README.md before handing back a change.

## Performance

Measure performance with strobe, pinned as `@hona/strobe` in package.json. Read the strobe skill in
`.agents/skills/strobe/SKILL.md` (the same file is in `.claude/skills/strobe/`) before writing a bench or quoting a
result. Keep both copies identical and at the pinned version.

- Benches live in `perf/`. `perf/permits.bench.ts` launches the unpackaged app with `PERMIT_MONITOR_DATA_DIR` set to a
  private folder per launch, seeded by `perf/variant.mjs`. Such a copy has no key storage, no sharing service, and no
  scheduled checks. Never point a bench at the installed app or the user's own data.
- Run `npx strobe bench perf/permits.bench.ts --check --head .` before a comparison, then
  `npx strobe bench perf/permits.bench.ts --base origin/master --head .` to ask whether a change is faster.
- Every performance claim in a pull request carries the block `strobe report experiment <exp> --format pr` writes.
  Single runs and `--check` numbers are not results.
- Bench files need Bun installed. Ask before running `strobe up`: it changes the machine (PATH, a login daemon, and
  OpenCode's MCP entry and skill, plus a UAC prompt on Windows).
- Never bench while a build, test suite, or other heavy work runs on the same machine.
