# Windows release qualification

The long-term release target is a signed, per-user Squirrel.Windows installer for currently serviced Windows 11 x64 Home and Pro releases. Build on native Windows. The source tree contains the update feed URL and public key but no signing credentials or private keys.

## Current unsigned releases

No signing certificate is available, so releases are unsigned. Bump `version` in `package.json`, commit, then push a matching annotated tag whose message sums up the release:

```
git tag -a v0.2.0 -m "Permit Monitor v0.2.0: in-app updates" && git push origin v0.2.0
```

The workflow checks that the tag matches `package.json` and is annotated (it stops on a lightweight tag; delete it with `git tag -d` and `git push origin :refs/tags/vX.Y.Z`, then push an annotated one), runs type checks and tests, stages the browser, builds the Squirrel installer, and runs the packaged browser smoke check. The release job then signs the update manifest, uploads the installer and manifest to the update feed, and publishes a GitHub release with the installer, its SHA-256, and the manifest. **Pushing a tag ships the update to every installed copy**, so run the checks below first.

The same tag builds a Mac app for Apple silicon on a macOS runner (the `package-mac` job): it stages the headless shell, packages with `npm run package:mac`, signs the bundle ad hoc, runs the packaged browser smoke check, and zips the app. The release job needs both builds, so a Mac failure holds the Windows release too. Run the workflow from the Actions tab on a branch to try the Mac build without releasing; macOS runners use ten times the minutes of Linux ones, so pull requests skip it.

Unsigned installers trigger SmartScreen's "Windows protected your PC." on first install. Users click **More info**, then **Run anyway**; the release notes say this. After that, **Settings → Updates** downloads and installs new versions in the app. Updates downloaded by the app don't carry a download-origin mark, so SmartScreen doesn't prompt again. Data in `%LOCALAPPDATA%\PermitMonitorData` is kept. Builds before 0.2.0 have no update feed; those users must install 0.2.0 by hand once.

### Mac builds

There is no Apple Developer ID, so the Mac app is signed ad hoc and not notarized. Packaging changes Electron's `Info.plist`, which breaks the bundle's seal, and Gatekeeper calls an app with a broken seal "damaged" and offers no way to open it; the ad hoc signature (`codesign --force --deep --sign -`) reseals it. Gatekeeper still blocks the downloaded app as unverified. The release notes tell users to drag it to Applications and run `xattr -dr com.apple.quarantine "/Applications/Permit Monitor.app"`. **Open Anyway** in Privacy & Security isn't enough, because it clears the app but not the headless shell inside it.

- Only the headless shell is staged (`--only-shell`), on every platform. The worker never launches the full Chromium, and on macOS it is an app bundle full of symlinks, which the payload check refuses.
- The TypeSafe key is encrypted with a key macOS keeps in the login Keychain. The Keychain ties that entry to the app's signature, and an ad hoc signature changes with every build, so after each update macOS asks for the Mac password once more; users click **Always Allow**.
- The app doesn't install its own updates. **Settings → Updates** reads the same signed manifest and, when a newer version is out, opens the feed's `/mac` link in the browser. Users replace the app and repeat the `xattr` step.
- Start at sign-in and the desktop shortcut are Windows-only and hidden on the Mac. Closing the window keeps the app in the menu bar.
- Data lives in `~/Library/Application Support/Permit Monitor/PermitMonitorData`.

An Apple Developer account ($99 a year) would remove the Gatekeeper step and the repeated Keychain prompt: sign with a Developer ID certificate and notarize in the `package-mac` job. No Mac is needed for that. The runner does the signing.

## Update feed

The feed is the `permitmon-updates` Worker (`infra/update-server`), backed by the `permitmon-updates` R2 bucket in the Surfside Software Cloudflare account. The app and CI use `https://permitmon-updates.sc-frederick.workers.dev`. People use `https://permitmon-updates.aeccloud.io`. Both hosts serve the same routes, but `aeccloud.io` has Bot Fight Mode on, which challenges non-browser clients, so the app must not use it.

- `/` and `/PermitMonitorSetup.exe` redirect to the current installer. This is the link to send to new users.
- `/release-manifest.json` is the signed manifest the app checks.
- `/PermitMonitorSetup-X.Y.Z.exe` are the versioned installers. Old ones stay so cached manifests keep working.
- `/mac` redirects to `/PermitMonitor-X.Y.Z-mac-arm64.zip`, the zipped Mac app for the version the manifest names. Both publishers upload the zip before the manifest under the same write-once rule. Manifest promotion requires the matching Mac archive; a Windows-only upload leaves the previous release and its Mac link in place.
- `/upload/...` takes manual uploads from `scripts/publish-update.mjs` and requires the `UPLOAD_TOKEN` Worker secret. It accepts Windows installers and Mac archives, and refuses a manifest unless the installer it names is already uploaded at the stated size and hash and the matching Mac archive is present with a recorded hash.

Both publication paths follow the same rules (`infra/update-server/src/release-policy.ts`):

- A versioned installer or Mac archive is created atomically with a storage-enforced `If-None-Match: *` condition, shared across CI and manual publication. Its SHA-256 is recorded as object metadata. Republishing identical bytes is skipped; different bytes under the same version are refused, so a rebuilt release needs a new version. Installers uploaded before hashes were recorded are hashed on a CI rerun and matched by size in the Worker. New manual multipart uploads assemble under unique private `_uploads/` staging keys, validate their size and actual SHA-256, and stream through `FixedLengthStream` into the conditional final write. Validation failures and losing publishers can delete only their staging objects. CI sends `Content-MD5` on its conditional S3 `PutObject` for integrity.
- The manifest only moves to a newer version. Re-sending the identical manifest is a no-op. A different manifest for the published version is refused. CI leaves a newer published manifest in place with a warning; the manual script stops before uploading.
- If the published manifest can't be parsed, both paths stop and leave it for a person to replace.

Deploy Worker changes with `node cloudflare-cli/run.mjs deploy` from `infra/update-server` before using the updated manual publisher; its multipart sessions now include a private staging key. The native CLI and Wrangler bundler are pinned in `cloudflare-cli/app`. The Worker is TypeScript and bundles `zod` from the repository's `node_modules`, so run `npm ci --allow-git=all` first. `npm test` covers it with a local bucket. A Linux `publication-tests` job runs the Worker, CI publisher, and manual publisher regression suites on ordinary pull requests and master pushes with install scripts disabled, no staged browser, and no upload credentials. The release job waits for that check too. Configure a bucket lifecycle rule to expire objects and abandoned multipart uploads under `_uploads/` after one day; completed staging objects are deleted by the Worker, while interrupted uploads may remain for a retry or cleanup.

Cloudflare challenges requests from GitHub's runner IPs on both Worker hosts, so the release job uploads straight to the bucket's S3 endpoint with `scripts/publish-feed.mjs` instead of through the Worker.

Release jobs share one concurrency group, so only one CI job publishes at a time. Atomic artifact creation also protects concurrent manual/manual and CI/manual publication: identical retries succeed, and different bytes cannot replace the winner. The manifest write requires the ETag it read (or that no manifest exists), so it refuses a concurrent manifest change. Retry a refused manifest publication after inspecting the current feed. GitHub cancels an older release job that is still waiting when a newer tag queues; rerun it after the newer one finishes.

CI inputs:

- `UPDATE_FEED_URL` and `UPDATE_PUBLIC_KEY_SPKI_BASE64` (plain values in `windows.yml`) are built into the app.
- `UPDATE_SIGNING_PRIVATE_KEY` (Actions secret): Ed25519 PEM private key for release manifests.
- `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` (Actions secrets): an R2 API token with Object Read & Write on the `permitmon-updates` bucket only. Without them the release job skips the feed upload and warns.

To publish by hand (for example, when the R2 secrets are missing), download the same run's `windows-installer` artifact into `out/make/squirrel.windows/x64` and its `mac-app` artifact into `out/make` as `PermitMonitor-mac-arm64.zip`, then from a network Cloudflare doesn't challenge. Both scripts refuse a missing or empty local Mac archive before uploading anything:

```
UPDATE_INSTALLER_URL=https://permitmon-updates.sc-frederick.workers.dev/PermitMonitorSetup-X.Y.Z.exe \
UPDATE_SIGNING_PRIVATE_KEY_FILE=... UPDATE_PUBLIC_KEY_SPKI_BASE64=... node scripts/sign-release-manifest.mjs
UPDATE_SERVER_URL=https://permitmon-updates.sc-frederick.workers.dev UPDATE_UPLOAD_TOKEN=... node scripts/publish-update.mjs
```

`UPDATE_UPLOAD_TOKEN` must match the Worker's `UPLOAD_TOKEN` secret; it is also stored as an Actions secret.

The private key's offline backup lives outside the repository with the maintainer. If it's lost, create a new key pair, update the public key in `windows.yml` and the secret, and have users install the next release by hand. To rotate the upload token, set the new value as the Worker's `UPLOAD_TOKEN` secret and wherever you keep it for manual publishing.

## Shared-list service

Shared lists use the `permitmon-sync` Worker (`infra/sync-server`) with SQLite-backed Durable Object classes in the same Cloudflare account. Release builds get `SHARE_SERVICE_URL=https://permitmon-sync.sc-frederick.workers.dev` from `windows.yml`. The `Sync server` workflow (`.github/workflows/sync-server.yml`) deploys it whenever `infra/sync-server` or `src/shared/share-protocol.ts` changes on master, so check that run passed before tagging a release. Pull requests only bundle it with `node cloudflare-cli/run.mjs dry-run --skip-prepare`. The Worker has no secrets. The workflow uses the `CLOUDFLARE_SYNC_DEPLOY_TOKEN` Actions secret, the `permitmon-sync CI deploy` account API token, which has Workers Scripts Write and Account Settings Read. To deploy by hand, run `node cloudflare-cli/run.mjs deploy` from `infra/sync-server` after `npm ci --allow-git=all`, or run the workflow from the Actions tab. Changing the share-code format or the room derivation strands existing codes, so give a new format a new `PMS` prefix and keep the old one working. See [shared lists](SHARING.md).

## Signed build inputs (not wired into CI)

If a certificate becomes available, `forge.config.cjs` signs the app and installer when these are set:

- `WINDOWS_CERTIFICATE_FILE` and `WINDOWS_CERTIFICATE_PASSWORD`: PFX publisher certificate and password.
- `UPDATE_EXPECTED_PUBLISHER`: exact signer certificate simple name. Once built into the app, the updater also requires this Authenticode publisher on downloaded installers, and manifests without it are rejected.

`RELEASE_BUILD=1` makes the build fail without signing credentials, the feed URL, or the public key.

## Required checks before distribution

1. Repeat each available public jurisdiction workflow on native Windows with the pinned Playwright revision and actual launch mode. Verify the portal's permit identifier and record-level status field, and open each saved detail link in a fresh session. Include Pasco's older Permits module, St. Petersburg's zero-padded application number, and Hernando's Tyler record page. Save sanitized fixtures. The September 24, 2026 Hillsborough observation of `HC-BLD-26-0087599` as “In Process” is historical; live tests must accept the current displayed wording.
2. Run the TypeSafe-key-driven app flow with a real key. Confirm Jev selects only current approved actions, records its actual model, and stops on malformed, low-confidence, or unsafe choices. Calibrate the current confidence and margin thresholds against the fixture set before release.
3. Install the **actual released `Setup.exe`** as a standard user on clean Windows 11 x64 VMs covering the oldest and newest supported feature releases. No WSL, Node, npm, Python, Git, Visual Studio, or Playwright cache may be present. Verify the app launches its own bundled browser.
4. Exercise in-app key entry (save, replace, remove), a live check, record opening, restart and history persistence, cancellation, sleep and resume, failed checks preserving prior observations, corrupt-update rejection, upgrade, uninstall, and reinstall. Include paths with spaces and non-ASCII characters, Defender enabled, offline installation, and network or proxy failure.
5. Audit a canary key across renderer state, IPC, worker environment, logs, crash reports, and exports. Verify no prohibited portal actions, no false-positive identifier or status observations in adversarial fixtures, bounded runs, and no orphaned browser processes.
6. Download the release through the intended public route with Windows download-origin marking intact. For signed builds, verify the publisher and timestamp on the installer and app binaries and test the user-approved full-installer update. For unsigned builds, verify the SmartScreen bypass path and an installer-over-installer upgrade. In both cases, test database migration recovery.
7. Review third-party notices and licenses in the installer, then re-audit build tooling and production dependencies. The production dependency audit passed locally, but current development tooling still reports advisories that require release-time review.

The release is blocked until all checks pass. CI package success alone is not clean-machine qualification.

## Install experience

Squirrel.Windows has no installer pages. While it installs, it plays `assets/install-splash.gif` and then starts the app with `--squirrel-firstrun`. The app handles Squirrel's install, update, and uninstall events itself in `src/main/squirrel.ts`:

- Install and update create only the Start menu shortcut, which carries the notification identity, and copy `icon.ico` over Squirrel's `app.ico`. Squirrel otherwise downloads Electron's icon there, and Installed apps shows it.
- The first launch after a fresh install asks whether to add a desktop shortcut. **Settings → Shortcut on the desktop** changes it later. Updates leave an existing desktop shortcut alone, and uninstall removes both shortcuts.

On a clean install, check the splash, the first-run question (both answers), the Settings toggle, the icon in Installed apps and on the taskbar, and that an update doesn't bring back a desktop shortcut the user removed. Copies installed before this change keep their desktop shortcut and get the right `app.ico` with their next update.

## Desktop notifications

With status-change notifications enabled, check a permit whose latest discipline review newly requires corrections while its Record Status stays unchanged. Verify the notice names the discipline and correction date, and the permit shows AEC action. Repeat the check and confirm it stays quiet. A newly completed discipline or later correction date should notify again.

Check each display state: focused (in-app notice, including above open dialogs), unfocused, minimized, and closed to the tray (Windows notification). Click both a banner and its retained Notification Center entry and confirm the window opens the correct permit. Turn off status-change notifications and confirm review notices stop; failure notifications have a separate setting. If native delivery fails, verify a diagnostic is recorded and the retained notice appears when the window regains focus. Windows may deliver directly to Notification Center when banners are disabled or Do Not Disturb is active; an Electron `show` event alone does not prove a visible banner.

On September 28, 2026, the source notification adapter was exercised on native Windows using Electron 44.4.5 and the installed `com.squirrel.PermitMonitor.PermitMonitor` identity. Electron reported `show`, and Windows notification history contained the test title and body. The user confirmed seeing the notification and that Do Not Disturb had been enabled. Native click-through was not manually verified. This verifies native receipt on that host; it does not replace a banner/click check of the packaged release. Automated tests cover preferences, foreground routing, failed-delivery recovery, notice visibility above dialogs, and opening the selected permit from the notification event.

## Update trust

The app accepts only an HTTPS feed with an Ed25519-signed payload containing version, installer URL, SHA-256, size, and expected publisher. It downloads to a temporary file, enforces size, checks the hash (and the Authenticode publisher when one is configured), then offers an explicit installation. For unsigned builds the Ed25519 key is the only trust anchor: whoever holds it can ship code to every install, so keep it only in the Actions secret and the offline backup. The installer is rechecked before handoff. Updates replace the tested app, Playwright library, browser revision, adapter, and prompt together.

The browser hash manifest detects packaged-payload corruption at app startup. The signed installer and release metadata are the distribution trust anchors; a local attacker who can modify the app's own files is outside this check's guarantee.
