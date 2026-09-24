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
- `/upload/...` takes CI uploads and requires the `UPLOAD_TOKEN` Worker secret. It refuses a manifest unless the installer it names is already uploaded at the stated size, and it never overwrites the installer the live manifest points to.

Deploy Worker changes with `npx wrangler deploy` from `infra/update-server`.

CI inputs:

- `UPDATE_FEED_URL` and `UPDATE_PUBLIC_KEY_SPKI_BASE64` (plain values in `windows.yml`) are built into the app.
- `UPDATE_SIGNING_PRIVATE_KEY` (Actions secret): Ed25519 PEM private key for release manifests.
- `UPDATE_UPLOAD_TOKEN` (Actions secret): must match the Worker's `UPLOAD_TOKEN`.

The private key's offline backup lives outside the repository with the maintainer. If it's lost, create a new key pair, update the public key in `windows.yml` and the secret, and have users install the next release by hand. Rotating the upload token only needs the Worker secret and the Actions secret to match.

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

## Update trust

The app accepts only an HTTPS feed with an Ed25519-signed payload containing version, installer URL, SHA-256, size, and expected publisher. It downloads to a temporary file, enforces size, checks the hash (and the Authenticode publisher when one is configured), then offers an explicit installation. For unsigned builds the Ed25519 key is the only trust anchor: whoever holds it can ship code to every install, so keep it only in the Actions secret and the offline backup. The installer is rechecked before handoff. Updates replace the tested app, Playwright library, browser revision, adapter, and prompt together.

The browser hash manifest detects packaged-payload corruption at app startup. The signed installer and release metadata are the distribution trust anchors; a local attacker who can modify the app's own files is outside this check's guarantee.
