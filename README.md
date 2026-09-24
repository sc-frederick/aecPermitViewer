# Permit Monitor

Permit Monitor is a local Windows desktop app for a permit professional who tracks Hillsborough County government building records. It saves exact record-status observations with their observation times and verified detail links. A failed check leaves the prior verified status and its original time intact.

## Supported workflow

- Hillsborough County government's public HillsGovHub **Building** search only. Municipal authorities and older records outside this search are not covered.
- Add a full permit number, check now, review each observation or failed attempt, and open the verified record. Scheduled checks run at 8:30 AM, 12:30 PM, and 4:30 PM while Permit Monitor is running and Windows is awake. A time missed because the app was closed or the computer was asleep is made up once, but only between 8:30 AM and 5 PM, so nothing runs in the evening. New permits are included automatically, and each can be excluded from its details. Choose Manual checks only to turn scheduling off.
- Closing the window keeps Permit Monitor running in the Windows notification area; quit from the tray icon. It can also start at Windows sign-in, hidden in the tray.
- Windows desktop notifications report when a portal status changes (quoting the old and new wording exactly) and the first failure in a run of failed checks. Clicking a notification opens that permit. Both notification types can be turned off in Settings.
- The displayed record status is preserved as written. The app does not interpret “In Process” as a request for action.
- Each user pastes a TypeSafe API key into Settings. The window sends it once to the main process, where Electron safeStorage encrypts it for the Windows user. It is never shown again. Filtered page text is sent to TypeSafe Jev for navigation choices; browser execution and history stay local.

The [product scope](PRODUCT.md) and [release qualification](docs/RELEASE.md) describe the boundaries in more detail.

## Development

Use Node.js 24. Nothing in the project compiles native code. SQLite comes from Node's built-in `node:sqlite`, and the key is entered in the app, so neither Visual Studio nor Python is needed on any platform. End users of a qualified installer need no development tools. On Windows, run:

```sh
npm ci --allow-git=all
npm run browser:stage
npm run typecheck
npm test
npm run dev
```

`npm run browser:stage` installs Playwright's pinned Chromium and headless shell under `vendor/playwright-browsers`, then writes a SHA-256 manifest for the complete payload. On Windows, `npm run make:win` creates the Squirrel installer. Key storage uses Windows encryption, so saving a key works only on Windows. Elsewhere, use the development key variable described below.

On Linux, the same commands run the tests, a build, and `npm run smoke:portal`.

### Testing on Windows from a WSL checkout

Windows npm cannot run from a `\\wsl.localhost\...` folder: `cmd.exe` rejects UNC working directories, and that `node_modules` holds Linux binaries. Mirror the source to a Windows folder instead. `npm run sync:windows` copies it to `C:\Users\<you>\dev\aecPermitViewer` by default, and you can pass another `/mnt/c/...` path after `--`. Each side keeps its own `node_modules`, browser payload, and build output. Run it again after each change, then install and start as above in PowerShell in that folder. Paste your key under **Settings → TypeSafe key**. Start-at-sign-in is available only in an installed build.

### Running the app against live permits on Linux or WSL

Saving a key needs Windows encrypted storage, so an unpackaged development run elsewhere can take the TypeSafe key from the environment instead. Main reads it once at startup and removes it from its environment. It is never saved to disk, logged, or passed to the renderer or browser worker. Packaged builds ignore it.

```sh
npm run browser:stage          # once, if vendor/playwright-browsers is missing
TYPESAFE_API_KEY=... npm run dev
```

With WSLg the window opens on the Windows desktop. Add real Hillsborough County Building permit numbers and use Check now. Checks are spaced at least 30 seconds apart. On Linux, closing the window quits the app, and notices appear inside the window instead of as desktop notifications. Data is stored under `~/.config/Permit Monitor/PermitMonitorData`.

To confirm the portal shows a permit without using TypeSafe, run `npm run smoke:portal -- HC-BLD-26-0087599` with any full permit number. It prints the verified number, the exact status, and the record link.

`npm run smoke:portal` performs a live, public portal check of `HC-BLD-26-0087599`. It checks the identifier and current displayed status without expecting the historical trial wording. This smoke bypasses Jev to isolate portal and browser behavior; it is not a full TypeSafe integration test.

## Architecture

The renderer receives display data through a narrow preload bridge. Main owns the SQLite database, encrypted key, job queue, scheduler, TypeSafe client, and update verification. An Electron utility process owns Playwright and exposes only bounded observations and approved action IDs. The worker verifies the full identifier on the detail page and reads the record-level status field before main commits an observation.

The browser is launched from the packaged Playwright payload in a fresh context. No personal browser profile, cloud browser, or local HTTP server is used. Browser redirects and record URLs must stay within the Hillsborough tenant and Building module.

## Current qualification state

Local type checking, tests, build, direct browser smoke, and a live worker portal check have passed on Linux. A TypeSafe-key-driven end-to-end check, in-app key entry on Windows, signed Squirrel installer, and clean Windows 11 x64 installation and upgrade still require Windows qualification. **Do not distribute this source tree as a finished release installer.** The signed build workflow needs a signing certificate, update-feed configuration, release-manifest key, and the release gates in [docs/RELEASE.md](docs/RELEASE.md).
