# Releases

Permit Monitor ships as a per-user Squirrel.Windows installer for currently serviced Windows 11 x64 Home and Pro releases, plus an Apple silicon Mac app. Both are unsigned because no code-signing certificate or Apple Developer ID is available. The Windows installer should be built on native Windows. The source tree contains the update feed URL and public key, but no signing credentials or private keys.

Pushing a version tag publishes the release to the update feed, and every installed Windows copy offers the update. Run the [checks before distribution](#checks-before-distribution) first.

## Cutting a release

1. Bump `version` in `package.json` and commit.
2. If the release depends on a change to the shared-list Worker, confirm the latest [Sync server](#shared-list-service) run on master passed.
3. Push an annotated tag whose message sums up the release:

   ```sh
   git tag -a v0.2.0 -m "Permit Monitor v0.2.0: in-app updates" && git push origin v0.2.0
   ```

The workflow stops on a lightweight tag. Delete it with `git tag -d vX.Y.Z` and `git push origin :refs/tags/vX.Y.Z`, then push an annotated one.

## The Package workflow

`.github/workflows/windows.yml` has four jobs:

| Job                 | Runs on                        | What it does                                                                                                                                                                                                                                   |
| ------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `publication-tests` | Every run, Linux               | Runs the update Worker, CI publisher, and manual publisher tests with install scripts disabled, no staged browser, and no upload credentials.                                                                                                  |
| `package`           | Every run, Windows             | On a tag, checks that the tag matches `package.json` and is annotated. Runs type checks, lint, format check, and tests, then builds the Squirrel installer and runs the packaged browser smoke check.                                          |
| `package-mac`       | Tags and manual runs, macOS 15 | Stages the headless shell, runs the tests, packages with `npm run package:mac`, signs the bundle ad hoc, runs the packaged browser smoke check, and zips the app with `ditto`.                                                                 |
| `release`           | Tags                           | Waits for the other three jobs. Signs the update manifest, uploads the installer, Mac archive, and manifest to the update feed, and publishes a GitHub release with the installer, the Mac archive, a SHA-256 file for each, and the manifest. |

A Mac build failure holds the Windows release too. To try the Mac build without releasing, run the workflow on a branch from the Actions tab. Pull requests and master pushes skip it because macOS runners use ten times the minutes of Linux ones.

Both package jobs run the history growth benchmark on its own after the rest of the suite, so its 100 ms permit-read and event-loop budgets don't compete with parallel browser and SQLite test workers. To reproduce the CI checks locally:

```sh
npm test -- --exclude tests/history-growth.test.ts
npm run benchmark:history
```

Set `HISTORY_BENCHMARK_OUTPUT` to a folder to also save each round's measurements there as JSON.

## Installing unsigned builds

### Windows

SmartScreen shows "Windows protected your PC" on first install. Users click **More info**, then **Run anyway**. The release notes say this. After that, **Settings → Updates** downloads and installs new versions in the app. Updates the app downloads carry no download-origin mark, so SmartScreen doesn't prompt again. Data in `%LOCALAPPDATA%\PermitMonitorData` is kept. Versions before 0.2.0 have no update feed and must be replaced by hand.

Squirrel.Windows has no installer pages. It plays `assets/install-splash.gif` while installing, then starts the app with `--squirrel-firstrun`. The app handles Squirrel's install, update, and uninstall events in `src/main/squirrel.ts`:

- Install and update create only the Start menu shortcut, which carries the notification identity. They also copy `icon.ico` over Squirrel's `app.ico`, the icon Installed apps displays. Otherwise Squirrel puts Electron's icon there.
- The first launch after a fresh install asks whether to add a desktop shortcut. **Settings → Shortcut on the desktop** changes it later. Updates leave an existing desktop shortcut alone. Uninstall removes both shortcuts.

### Mac builds

The Mac app is signed ad hoc and not notarized. Packaging edits Electron's `Info.plist`, which breaks the bundle's seal, and Gatekeeper calls an app with a broken seal "damaged" with no way to open it. The ad hoc signature, `codesign --force --deep --sign -`, reseals it.

Gatekeeper still blocks the downloaded app as unverified. The release notes tell users to drag it to Applications and run:

```sh
xattr -dr com.apple.quarantine "/Applications/Permit Monitor.app"
```

**Open Anyway** in Privacy & Security is not enough, because it clears the app but not the headless shell inside it.

- Only the headless shell is staged, with `--only-shell`, on every platform. The worker never launches the full Chromium, and on macOS the full Chromium is an app bundle full of symlinks, which the payload check refuses.
- The TypeSafe key is encrypted with a key macOS keeps in the login Keychain. The Keychain ties that entry to the app's signature, and an ad hoc signature changes with every build, so macOS asks for the Mac password again after each update. Users click **Always Allow**.
- The app doesn't install its own updates. **Settings → Updates** reads the same signed manifest and, when a newer version is out, opens the feed's `/mac` link in the browser. Users replace the app and repeat the `xattr` step.
- Start at sign-in and the desktop shortcut are Windows-only and hidden on the Mac. Closing the window keeps the app in the menu bar.
- Data lives in `~/Library/Application Support/Permit Monitor/PermitMonitorData`.

An Apple Developer account, at $99 a year, would remove the Gatekeeper step and the repeated Keychain prompt: sign with a Developer ID certificate and notarize in the `package-mac` job. The runner does the signing, so no Mac is needed.

## Update feed

The feed is the `permitmon-updates` Worker in `infra/update-server`, backed by the `permitmon-updates` R2 bucket in the Surfside Software Cloudflare account. It has two hosts with the same routes:

- `https://permitmon-updates.sc-frederick.workers.dev` is for the app and CI.
- `https://permitmon-updates.aeccloud.io` is for people. Bot Fight Mode is on for `aeccloud.io` and challenges non-browser clients, so the app must not use it.

Routes:

| Route                           | Purpose                                                                                                                                                                                                                                                                      |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`, `/PermitMonitorSetup.exe`  | Redirect to the current installer. This is the link to send new users.                                                                                                                                                                                                       |
| `/release-manifest.json`        | The signed manifest the app checks.                                                                                                                                                                                                                                          |
| `/PermitMonitorSetup-X.Y.Z.exe` | Versioned installers. Old ones stay so cached manifests keep working.                                                                                                                                                                                                        |
| `/mac`                          | Redirects to `/PermitMonitor-X.Y.Z-mac-arm64.zip` for the version the manifest names.                                                                                                                                                                                        |
| `/upload/...`                   | Manual uploads from `scripts/publish-update.mjs`. Requires the `UPLOAD_TOKEN` Worker secret. Accepts installers and Mac archives. Refuses a manifest unless its installer is stored at the stated size and hash and the matching Mac archive is stored with a recorded hash. |

### Publication rules

CI and manual publication follow the same rules, defined in `infra/update-server/src/release-policy.ts`:

- **Versioned artifacts are write-once.** An installer or Mac archive is created with a storage-enforced `If-None-Match: *` condition, and its SHA-256 is recorded as object metadata. Republishing identical bytes is skipped. Different bytes under the same version are refused, so a rebuilt release needs a new version. The condition holds across concurrent CI and manual publishers: identical retries succeed, and different bytes cannot replace the first write. Older installers with no recorded hash are matched by size in the Worker, and CI hashes them on a rerun.
- **Manual uploads are staged.** Multipart uploads assemble under a unique private `_uploads/` key, are checked for size and actual SHA-256, and stream through `FixedLengthStream` into the conditional final write. A failed validation or a losing publisher can delete only its own staging object.
- **The Mac archive comes first.** Both publishers upload the archive before the manifest, and the manifest can't advance to a version without it. A Windows-only upload leaves the previous release and its Mac link in place.
- **The manifest only moves forward.** Re-sending the identical manifest does nothing. A different manifest for the published version is refused. CI leaves a newer published manifest in place with a warning; the manual script stops before uploading.
- **The manifest write is conditional.** It requires the ETag it read, or that no manifest exists, so a concurrent manifest change is refused. Inspect the current feed before retrying.
- **An unreadable manifest stops both paths** and stays in place until a person replaces it.

CI sends `Content-MD5` with its conditional S3 `PutObject` for integrity. Release jobs share the `update-feed-publication` concurrency group, so only one CI job publishes at a time. GitHub cancels an older release job that is still waiting when a newer tag queues; rerun it after the newer one finishes.

Configure a bucket lifecycle rule that expires objects and abandoned multipart uploads under `_uploads/` after one day. The Worker deletes completed staging objects, but an interrupted upload can leave one behind.

### Deploying the feed Worker

No workflow deploys this Worker. Deploy changes by hand before relying on them in the manual publisher. The Worker bundles `zod` from the repository's `node_modules`, so run `npm ci --allow-git=all` at the root first, then run `node cloudflare-cli/run.mjs deploy` from `infra/update-server`. The runner is described in `infra/update-server/cloudflare-cli/README.md`. `npm test` covers the Worker against a local bucket.

### CI inputs

Cloudflare challenges requests from GitHub's runner IPs on both Worker hosts, so the release job writes straight to the bucket's S3 endpoint with `scripts/publish-feed.mjs`.

- `UPDATE_FEED_URL` and `UPDATE_PUBLIC_KEY_SPKI_BASE64`: plain values in `windows.yml`, built into the app.
- `UPDATE_SIGNING_PRIVATE_KEY` (Actions secret): the Ed25519 PEM private key for release manifests.
- `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` (Actions secrets): an R2 API token with Object Read & Write on the `permitmon-updates` bucket only. Without them, the release job skips the feed upload with a warning.

### Publishing by hand

Use this when the R2 secrets are missing. Download the same run's `windows-installer` artifact into `out/make/squirrel.windows/x64` and its `mac-app` artifact into `out/make` as `PermitMonitor-mac-arm64.zip`. Then, from a network Cloudflare doesn't challenge, run:

```sh
UPDATE_INSTALLER_URL=https://permitmon-updates.sc-frederick.workers.dev/PermitMonitorSetup-X.Y.Z.exe \
UPDATE_SIGNING_PRIVATE_KEY_FILE=... UPDATE_PUBLIC_KEY_SPKI_BASE64=... node scripts/sign-release-manifest.mjs
UPDATE_SERVER_URL=https://permitmon-updates.sc-frederick.workers.dev UPDATE_UPLOAD_TOKEN=... node scripts/publish-update.mjs
```

Both publish scripts refuse a missing or empty Mac archive before uploading anything. `UPDATE_UPLOAD_TOKEN` must match the Worker's `UPLOAD_TOKEN` secret. The same value is stored as the `UPDATE_UPLOAD_TOKEN` Actions secret, which no workflow reads.

### Keys

The signing key's offline backup is kept outside the repository by the maintainer. If the key is lost, create a new key pair, update the public key in `windows.yml` and the Actions secret, and have users install the next release by hand.

To rotate the upload token, set the new value as the Worker's `UPLOAD_TOKEN` secret and wherever it is kept for manual publishing.

## Shared-list service

Shared lists use the `permitmon-sync` Worker in `infra/sync-server`, in the same Cloudflare account. Release builds get `SHARE_SERVICE_URL=https://permitmon-sync.sc-frederick.workers.dev` from `windows.yml`. The design is in [shared lists](SHARING.md).

The `Sync server` workflow, `.github/workflows/sync-server.yml`, deploys the Worker when `infra/sync-server`, `src/shared/share-protocol.ts`, `tests/sync-server.test.ts`, or the workflow itself changes on master. Pull requests only bundle it with `node cloudflare-cli/run.mjs dry-run --skip-prepare`. The Worker has no secrets. The workflow authenticates with the `CLOUDFLARE_SYNC_DEPLOY_TOKEN` Actions secret, the `permitmon-sync CI deploy` account API token, which has Workers Scripts Write and Account Settings Read.

To deploy by hand, run `node cloudflare-cli/run.mjs deploy` from `infra/sync-server` after `npm ci --allow-git=all`, or run the workflow from the Actions tab.

Changing the share-code format or the room derivation strands existing codes. Give a new format a new `PMS` prefix and keep the old one working.

## Signed build inputs

These are not wired into CI. If a certificate becomes available, `forge.config.cjs` signs the app and installer when these are set:

- `WINDOWS_CERTIFICATE_FILE` and `WINDOWS_CERTIFICATE_PASSWORD`: the PFX publisher certificate and its password.
- `UPDATE_EXPECTED_PUBLISHER`: the signer certificate's exact simple name. Once built into the app, the updater also requires this Authenticode publisher on downloaded installers and rejects manifests without it.

`RELEASE_BUILD=1` makes the build fail without signing credentials, the feed URL, or the public key.

## Checks before distribution

CI passing is not clean-machine qualification. A release is blocked until all of these pass:

1. **Portals.** Repeat each automated jurisdiction workflow on native Windows with the pinned Playwright revision and the real launch mode. Verify the permit identifier and record-level status field, and open each saved record link in a fresh session. Include Pasco's older Permits module, St. Petersburg's zero-padded application number, and Hernando's Tyler record page. Save sanitized fixtures. Live tests must accept whatever wording the portal currently displays.
2. **TypeSafe.** Run the app flow with a real key. Confirm Jev selects only current approved actions, records the model that answered, and stops on malformed, low-confidence, or unsafe choices. Calibrate the confidence and margin thresholds against the fixture set.
3. **Clean install.** Install the released `Setup.exe` as a standard user on clean Windows 11 x64 VMs covering the oldest and newest supported feature releases. No WSL, Node, npm, Python, Git, Visual Studio, or Playwright cache may be present. Verify the app launches its own bundled browser.
4. **App behavior.** Exercise key entry (save, replace, remove), a live check, opening a record, restart and history persistence, cancellation, sleep and resume, failed checks preserving prior observations, corrupt-update rejection, upgrade, uninstall, and reinstall. Include paths with spaces and non-ASCII characters, Defender enabled, offline installation, and network or proxy failure.
5. **Key handling.** Trace a canary key across renderer state, IPC, worker environment, logs, crash reports, and exports. Verify no prohibited portal actions, no false-positive identifier or status observations in adversarial fixtures, bounded runs, and no orphaned browser processes.
6. **Distribution.** Download the release through the public route with the download-origin mark intact. For signed builds, verify the publisher and timestamp on the installer and app binaries and test the full-installer update. For unsigned builds, verify the SmartScreen bypass and an installer-over-installer upgrade. In both cases, test database migration recovery.
7. **Licenses and dependencies.** Review third-party notices and licenses in the installer. Run `npm audit` and review advisories in production and development dependencies.

### Installer

On a clean install, check the splash, both answers to the first-run shortcut question, the Settings toggle, the icon in Installed apps and on the taskbar, and that an update doesn't restore a desktop shortcut the user removed.

### Notifications

Automated tests cover notification preferences, foreground routing, failed-delivery recovery, notice visibility above dialogs, and opening the selected permit from a notification. Check the rest on the packaged release:

- With status-change notifications on, check a permit whose latest discipline review newly requires corrections while its Record Status is unchanged. The notice should name the discipline and correction date, and the permit should show AEC action. Check again and confirm it stays quiet. A newly completed discipline or a later correction date should notify again.
- Check each display state: focused, which shows an in-app notice even above open dialogs; unfocused; minimized; and closed to the tray, which shows a Windows notification.
- Click both a banner and its Notification Center entry and confirm the window opens the right permit.
- Turn off status-change notifications and confirm review notices stop. Failure notifications have a separate setting.
- If native delivery fails, confirm a diagnostic is recorded and the notice appears when the window regains focus.

Windows may deliver straight to Notification Center when banners are off or Do Not Disturb is on. An Electron `show` event alone doesn't prove a banner was visible.

## Update trust

The app accepts only an HTTPS feed with an Ed25519-signed payload containing the version, installer URL, SHA-256, size, and expected publisher. It downloads to a temporary file, enforces the size, checks the hash and, when one is configured, the Authenticode publisher, then offers an explicit install. The installer is checked again before handoff. An update replaces the tested app, Playwright library, browser revision, adapter, and prompt together.

For unsigned builds, the Ed25519 key is the only trust anchor: whoever holds it can ship code to every installed copy. Keep it only in the Actions secret and the offline backup.

The browser hash manifest detects corruption of the packaged browser at startup. It is not a defense against a local attacker who can modify the app's own files. The signed installer and release metadata are the distribution trust anchors.
