# Windows release qualification

The long-term release target is a signed, per-user Squirrel.Windows installer for currently serviced Windows 11 x64 Home and Pro releases. Build on native Windows. The source tree contains the update feed URL and public key but no signing credentials or private keys.

## Current unsigned releases

No signing certificate is available, so releases are unsigned. Bump `version` in `package.json`, commit, then push a matching tag:

```
git tag v0.2.0 && git push origin v0.2.0
```

The workflow checks that the tag matches `package.json`, runs type checks and tests, stages the browser, builds the Squirrel installer, and runs the packaged browser smoke check. The release job then signs the update manifest, uploads the installer and manifest to the update feed, and publishes a GitHub release with the installer, its SHA-256, and the manifest. **Pushing a tag ships the update to every installed copy**, so run the checks below first.

Unsigned installers trigger SmartScreen's "Windows protected your PC." on first install. Users click **More info**, then **Run anyway**; the release notes say this. After that, **Settings → Updates** downloads and installs new versions in the app. Updates downloaded by the app don't carry a download-origin mark, so SmartScreen doesn't prompt again. Data in `%LOCALAPPDATA%\PermitMonitorData` is kept. Builds before 0.2.0 have no update feed; those users must install 0.2.0 by hand once.

## Update feed

The feed is the `permitmon-updates` Worker (`infra/update-server`), backed by the `permitmon-updates` R2 bucket in the Surfside Software Cloudflare account. The app and CI use `https://permitmon-updates.sc-frederick.workers.dev`. People use `https://permitmon-updates.aeccloud.io`. Both hosts serve the same routes, but `aeccloud.io` has Bot Fight Mode on, which challenges non-browser clients, so the app must not use it.

- `/` and `/PermitMonitorSetup.exe` redirect to the current installer. This is the link to send to new users.
- `/release-manifest.json` is the signed manifest the app checks.
- `/PermitMonitorSetup-X.Y.Z.exe` are the versioned installers. Old ones stay so cached manifests keep working.
- `/upload/...` takes manual uploads from `scripts/publish-update.mjs` and requires the `UPLOAD_TOKEN` Worker secret. It refuses a manifest unless the installer it names is already uploaded at the stated size and hash.

Both publication paths follow the same rules (`infra/update-server/src/release-policy.ts`):

- During serialized publication, a versioned installer is written once. Its SHA-256 is recorded as object metadata. Republishing identical bytes is skipped; different bytes under the same version are refused, so a rebuilt release needs a new version. Installers uploaded before hashes were recorded are hashed on a CI rerun and matched by size in the Worker.
- The manifest only moves to a newer version. Re-sending the identical manifest is a no-op. A different manifest for the published version is refused. CI leaves a newer published manifest in place with a warning; the manual script stops before uploading.
- If the published manifest can't be parsed, both paths stop and leave it for a person to replace.

Deploy Worker changes with `npx wrangler deploy` from `infra/update-server`. The Worker is TypeScript and bundles `zod` from the repository's `node_modules`, so run `npm ci --allow-git=all` first. `npm test` covers it with an in-memory bucket.

Cloudflare challenges requests from GitHub's runner IPs on both Worker hosts, so the release job uploads straight to the bucket's S3 endpoint with `scripts/publish-feed.mjs` instead of through the Worker.

Release jobs share one concurrency group, so only one publishes at a time. The manifest write also requires the ETag it read (or that no manifest exists), so it refuses a concurrent manual manifest change. Do not run a manual installer upload while a CI release is publishing: R2 multipart completion can still write the same installer key after CI checks it. GitHub cancels an older release job that is still waiting when a newer tag queues; rerun it after the newer one finishes.

CI inputs:

- `UPDATE_FEED_URL` and `UPDATE_PUBLIC_KEY_SPKI_BASE64` (plain values in `windows.yml`) are built into the app.
- `UPDATE_SIGNING_PRIVATE_KEY` (Actions secret): Ed25519 PEM private key for release manifests.
- `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` (Actions secrets): an R2 API token with Object Read & Write on the `permitmon-updates` bucket only. Without them the release job skips the feed upload and warns.

To publish by hand (for example, when the R2 secrets are missing), download the run's `windows-installer` artifact into `out/make/squirrel.windows/x64`, then from a network Cloudflare doesn't challenge:

```
UPDATE_INSTALLER_URL=https://permitmon-updates.sc-frederick.workers.dev/PermitMonitorSetup-X.Y.Z.exe \
UPDATE_SIGNING_PRIVATE_KEY_FILE=... UPDATE_PUBLIC_KEY_SPKI_BASE64=... node scripts/sign-release-manifest.mjs
UPDATE_SERVER_URL=https://permitmon-updates.sc-frederick.workers.dev UPDATE_UPLOAD_TOKEN=... node scripts/publish-update.mjs
```

`UPDATE_UPLOAD_TOKEN` must match the Worker's `UPLOAD_TOKEN` secret; it is also stored as an Actions secret.

The private key's offline backup lives outside the repository with the maintainer. If it's lost, create a new key pair, update the public key in `windows.yml` and the secret, and have users install the next release by hand. To rotate the upload token, set the new value as the Worker's `UPLOAD_TOKEN` secret and wherever you keep it for manual publishing.

## Shared-list service

Shared lists use the `permitmon-sync` Worker (`infra/sync-server`) with a SQLite-backed Durable Object class in the same Cloudflare account. Release builds get `SHARE_SERVICE_URL=https://permitmon-sync.sc-frederick.workers.dev` from `windows.yml`. The Worker is deployed (first on 2026-09-28). Deploy it again whenever `infra/sync-server` or `src/shared/share-protocol.ts` changes: `npx wrangler deploy` from `infra/sync-server`, after `npm ci --allow-git=all`. It has no secrets. Changing the share-code format or the room derivation strands existing codes, so give a new format a new `PMS` prefix and keep the old one working. See [shared lists](SHARING.md).

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

## Desktop notifications

With status-change notifications enabled, check a permit whose latest discipline review newly requires corrections while its Record Status stays unchanged. Verify the notice names the discipline and correction date, and the permit shows AEC action. Repeat the check and confirm it stays quiet. A newly completed discipline or later correction date should notify again.

Check each display state: focused (in-app notice, including above open dialogs), unfocused, minimized, and closed to the tray (Windows notification). Click both a banner and its retained Notification Center entry and confirm the window opens the correct permit. Turn off status-change notifications and confirm review notices stop; failure notifications have a separate setting. If native delivery fails, verify a diagnostic is recorded and the retained notice appears when the window regains focus. Windows may deliver directly to Notification Center when banners are disabled or Do Not Disturb is active; an Electron `show` event alone does not prove a visible banner.

On September 28, 2026, the source notification adapter was exercised on native Windows using Electron 44.4.5 and the installed `com.squirrel.PermitMonitor.PermitMonitor` identity. Electron reported `show`, and Windows notification history contained the test title and body. The user confirmed seeing the notification and that Do Not Disturb had been enabled. Native click-through was not manually verified. This verifies native receipt on that host; it does not replace a banner/click check of the packaged release. Automated tests cover preferences, foreground routing, failed-delivery recovery, notice visibility above dialogs, and opening the selected permit from the notification event.

## Update trust

The app accepts only an HTTPS feed with an Ed25519-signed payload containing version, installer URL, SHA-256, size, and expected publisher. It downloads to a temporary file, enforces size, checks the hash (and the Authenticode publisher when one is configured), then offers an explicit installation. For unsigned builds the Ed25519 key is the only trust anchor: whoever holds it can ship code to every install, so keep it only in the Actions secret and the offline backup. The installer is rechecked before handoff. Updates replace the tested app, Playwright library, browser revision, adapter, and prompt together.

The browser hash manifest detects packaged-payload corruption at app startup. The signed installer and release metadata are the distribution trust anchors; a local attacker who can modify the app's own files is outside this check's guarantee.
