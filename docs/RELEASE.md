# Windows release qualification

The long-term release target is a signed, per-user Squirrel.Windows installer for currently serviced Windows 11 x64 Home and Pro releases. Build on native Windows. The source tree does not contain signing credentials or an update feed.

## Current unsigned releases

No signing certificate is available yet, so releases are unsigned. Bump `version` in `package.json`, commit, then push a matching tag:

```
git tag v0.1.0 && git push origin v0.1.0
```

The workflow checks that the tag matches `package.json`, runs type checks and tests, stages the browser, builds the Squirrel installer, and runs the packaged browser smoke check. It then publishes a GitHub prerelease with `PermitMonitorSetup.exe` and its SHA-256. Promote it to a full release on GitHub after the checks below.

Unsigned installers trigger SmartScreen's "Windows protected your PC." Users click **More info**, then **Run anyway**; the release notes say this. The in-app updater stays disabled because it requires an Authenticode publisher and a signed manifest. Users update by running a newer installer over the old one. Data in `%LOCALAPPDATA%\PermitMonitorData` is kept.

## Signed build inputs (not wired into CI)

When a certificate is available, `forge.config.cjs` signs the app and installer if these are set, and `scripts/sign-release-manifest.mjs` produces the update manifest:

- `WINDOWS_CERTIFICATE_FILE` and `WINDOWS_CERTIFICATE_PASSWORD`: PFX publisher certificate and password.
- `UPDATE_FEED_URL`: stable HTTPS URL for `release-manifest.json`.
- `UPDATE_PUBLIC_KEY_SPKI_BASE64`: Ed25519 public key in DER SPKI, base64 encoded.
- `UPDATE_EXPECTED_PUBLISHER`: exact signer certificate simple name.
- `UPDATE_INSTALLER_URL`: version-specific HTTPS URL for the complete `PermitMonitorSetup.exe`.
- `UPDATE_SIGNING_PRIVATE_KEY_FILE`: PEM private key for release manifests.

`RELEASE_BUILD=1` makes the build fail if any of these are missing. Publish the installer first and the manifest last. Keep old installer URLs available while their manifests may still be cached.

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

The app accepts only an HTTPS feed with an Ed25519-signed payload containing version, installer URL, SHA-256, size, and expected publisher. It downloads to a temporary file, enforces size, checks the hash and Authenticode publisher, then offers an explicit installation. The installer is rechecked before handoff. Updates replace the tested app, Playwright library, browser revision, adapter, and prompt together.

The browser hash manifest detects packaged-payload corruption at app startup. The signed installer and release metadata are the distribution trust anchors; a local attacker who can modify the app's own files is outside this check's guarantee.
