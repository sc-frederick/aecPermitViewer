# Warm Aether migration — 0.11.0

The renderer now shares the complete Aether design system, warm orange background,
local Inter / JetBrains Mono fonts, Lucide strokes, control scale and final polish
of AEC Plan Search 0.3.3. Permit Monitor keeps its table, project grouping, exact
portal wording, AEC/AEC? distinctions, status history, manual check flow, schedule,
notification routing, key storage, updates, and encrypted shared-list behavior.

The renderer's CSP, sandbox and context isolation remain in effect. The main window uses the matching warm background color. No database, IPC contract, portal adapter, scheduler, notification, update or sharing implementation changed. The browser payload verifier now recognizes only Chromium's regular Windows debug.log as mutable diagnostic data. Every immutable manifest file remains SHA-256 checked, extra code is rejected, and symlinks are rejected. Staging removes this diagnostic before writing the manifest; the build also removes it before Forge copies resources into the installer.

The warm background uses Shaders 4.0.4's public manual WebGPU engine. It is frame
locked before initialization, reuses the probed adapter, renders one still frame
with MultiPointGradient and non-animated FilmGrain, caps pixel resolution, and
redraws on resize. Cleanup releases its GPU resources and canvas buffer. No adapter,
initialization failure, reduced motion/transparency, and forced colors use CSS.
The renderer does not make external requests or start shader telemetry.

## Checks

- Linux: all 377 tests pass across 34 files, including the browser diagnostic regression. The final renderer subset passes all
  28 tests, including keyboard access to row actions at 820 × 560 and changing
  reduced-motion preferences while Settings remains usable.
- Windows: 361 tests pass in the full suite; the added diagnostic regression also passes; 15 publication tests are skipped by the repository's
  existing Windows guards. All 28 renderer tests pass using the staged Chromium.
- TypeScript checks pass on Linux and Windows. Renderer/build/source lint passes
  (`npx oxlint --deny-warnings src tests scripts forge.config.cjs`). Whole-repo
  `npm run lint` reports existing spacing violations in the uncommitted
  `infra/*/cloudflare-cli/run.mjs` files; those predate this task and were left intact.
- Axe WCAG 2 A/AA and 2.1 AA: zero violations in the workspace, Details, Settings,
  removal confirmation, manual check dialog, and project prompt. Manual keyboard checks cover the scroll region,
  grouped jurisdiction selection, focus return, and row actions.
- Native Windows Electron 44.4.5 / Chromium 152: packaged renderer screenshots at
  the normal window and 820 × 560 client area, rounded picker, centered close
  hover (zero pixel center error, no hover shadow), both inset 8px scrollbars,
  independent sheet scrolling, shader, reduced motion and no-GPU fallback.
- Native shader: one paint, unchanged after idle, capped at one pixel per CSS
  pixel, no external requests or console errors. Fallbacks show the same warm
  CSS background. Reduced-motion canvas dimensions in its receipt are the
  untouched default for a hidden canvas; no GPU renderer is acquired.
- Packaged Windows executable: bundled-browser integrity and live HTTPS smoke
  pass against a verified HillsGovHub record using Chromium 153.0.8010.12.
  Repeat executable launches also pass with the browser payload unchanged. This check reads the current public portal; it is a point-in-time observation.

## Evidence

The screenshots in `screenshots/aether-0.11.0` and the standalone
`aether-ui-review-0.11.0.html` use sanitized example permit snapshots through a
controlled bridge. Native screenshots load the shipped renderer from app.asar
under its original CSP and sandbox, rather than a visual mockup. Windows WebGPU tests exposed a Chromium driver diagnostic that writes debug.log beside the browser. A regression verifies that this changing regular log is accepted while extra DLLs and log symlinks are rejected. The live browser
smoke separately launches the actual executable and worker. Receipts are in
`windows-ui-*-0.11.0.json` and `windows-browser-smoke-0.11.0.json`.

Windows packages are built natively using the repository's Forge/Squirrel process,
with the same public update-feed key and shared-list service configured as CI.
The installer is unsigned, consistent with the current release workflow. The
team ZIP includes the installer, SHA-256 manifest, UI review, verification notes,
and design/font/shader notices. No user data, keys, or fixture bridge ships in the
installer. This local distribution does not publish a tag or promote the update feed.

macOS icons were regenerated; native macOS packaging and OS-level qualification
were not exercised on this Windows/Linux host. Clean-VM installer upgrades and
notification click-through remain the separate release qualification in RELEASE.md.
