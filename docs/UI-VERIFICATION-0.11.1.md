# Fullscreen spacing polish — 0.11.1

The workspace now expands with the window, using aligned fluid gutters for the
command dock, add/filter form and permit list. The shared view uses a compact
horizontal filter and reserves only the visible record button's column width.
Dates stay on one line. Project groups have quiet spacing, consistent warm row
surfaces and lighter separators. Applicant emphasis remains in AEC/AEC? badges;
the interrupted left-edge rules were removed. Full project names, exact status
wording, review prompts and all existing actions remain available.

This pass changes renderer CSS, design notes, the package version and a layout
regression test. It does not change backend, database, IPC, scheduler, portal,
notification, update or shared-list behavior.

## Validation

- All 378 tests pass across 34 files on Linux. All 29 renderer tests also pass
  on Windows with the pinned browser. The added regression checks expansion at
  1920 and 2560px, aligned dock/list edges, single-line timestamps, full project
  names and keyboard access to record actions at 820 × 560.
- TypeScript checks and whole-repository lint pass. The pending Cloudflare CLI
  runners were formatted before committing; both native CLI dry runs pass with
  the existing Worker names, storage bindings and runtime settings.
- Axe WCAG 2 A/AA and 2.1 AA reports zero violations in the shared workspace.
- Native Windows Electron 44.4.5 / Chromium 152 screenshots load the packaged
  renderer from app.asar with its original CSP, sandbox and context isolation.
  Maximized owner and shared views, normal and minimum windows, dropdown,
  details, settings, close hover and scrolling were checked.
- Native maximized client area: 1707 × 996 CSS pixels. Shared dock/filter/list
  widths match at 1639px, all six verification timestamps occupy one line and
  rows remain approximately 68px high at Windows display scaling.
- The shader paints once and stays idle; resolution remains capped. There are
  no renderer console errors or external requests. Close hover has zero center
  offset and both table scrollbars remain 8px.
- The actual packaged executable passes bundled-browser integrity and the live
  public-portal smoke check. This is a point-in-time read of a public record.

## Evidence and distribution

`screenshots/aether-0.11.1`, `aether-ui-review-0.11.1.html` and the Windows JSON
receipts contain sanitized fixture evidence, separate from user data. The
installer does not include the fixture bridge, keys or local permits.

The native Forge/Squirrel Windows installer uses the existing public update
verification key and sharing service. The team ZIP includes the installer,
offline screenshot review, verification notes, licenses and SHA-256 manifest.
The local build was verified before publication. The annotated release tag runs
the existing Windows/Mac build and signed-manifest publication workflow.
Clean-VM installer upgrade and OS notification qualification remain the separate
release process described in RELEASE.md; macOS packaging was not exercised.
