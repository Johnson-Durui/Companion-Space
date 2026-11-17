# Mobile Release Candidate Runbook

Status date: 2026-08-13

This is the current Android/iOS release source of truth. The v0.1 documents in
this directory remain historical desktop-browser evidence and are not rewritten.

## Readiness Matrix

| Gate | Status | Evidence or required input |
| --- | --- | --- |
| Mobile launcher security checks and TypeScript | PASS | `npm run check:mobile`, `npm run typecheck:mobile` |
| Android JVM tests, Lint, Debug app and instrumentation | PASS | Gradle Debug suite and six emulator instrumentation tests |
| Android unsigned release AAB | PASS | `:app:bundleRelease`; CI uploads an artifact explicitly named `unsigned` |
| Android signed AAB gate | IMPLEMENTED; PRODUCTION NOT RUN | Final AAB metadata, strict signature verification and configured-certificate matching passed with an ephemeral QA key; signed QA AAB SHA-256 `8E41511857123DA1DAA4B6B27F2C580D86D8F0F39B97F1FC9DAC5B76C34E5BD3`, signer certificate SHA-256 `AC907C24C0BAD9CAA52D298A40F7763948227FC76530EF1B8F1D69DB9A5232B8`; the QA key/evidence were removed and the workspace restored to unsigned output. The production clean-tree/outside-keystore gate has not run with the publisher key. |
| iOS project, AppTests target and shared scheme | PASS (STATIC) | Mobile static checks validate PBX references and the shared scheme |
| iOS Debug/Release simulator build and XCTest | CI CONFIGURED, NOT RUN ON THIS WINDOWS HOST | The `ios` GitHub Actions job requires macOS 26 / Xcode 26 |
| iOS archive/export automation | IMPLEMENTED, NOT RUN | `npm run ios:release`; Windows has not run a real iOS archive/export. It requires a real origin, Apple team, App Store Connect API key and repository-external output directory on macOS. |
| Production HTTPS mobile origin | NOT CONFIGURED | Supply one phone-reachable, device-trusted HTTPS origin on port 443 |
| Google Play signing and upload | NOT RUN | Supply the persistent release keystore and Play Console authority |
| Apple archive, signing and TestFlight/App Store upload | NOT RUN | Supply Apple Developer team, certificates and provisioning profiles on macOS |
| Physical iPhone/Android microphone, Bluetooth and lifecycle matrix | NOT RUN | Run on the release devices before store submission |
| Apple/Google store data disclosures and privacy-policy URL | WORKSHEET READY, PUBLISHER CONFIRMATION REQUIRED | Complete `docs/release/mobile-store-disclosure.md` against the production deployment and public policy URL |
| Running Docker deployment contains the mobile API | DEFERRED | The operator requested no image rebuild; source changes are not present in the currently running old images |

Current final unsigned Android AAB:

- path: `apps/mobile/android/app/build/outputs/bundle/release/app-release.aab`
- SHA-256: `3A11B7AE4F978BD1918CD636CB830DB84165592773B1F33554A01F2B052FE14D`
- signing entries: `0`

`NOT RUN` is not a passing result. It is an external release operation that
requires a real domain, durable signing identity, store authority or physical
device. Do not replace it with a development key or a placeholder domain.

## Android Release

Commit the exact source intended for release, then confirm that `git status
--short --untracked-files=all` produces no output. Both Android release commands
reject any tracked change or untracked file and bind their evidence to the
current commit.

Set the exact production origin and all four signing values. Replace the hostname
below with the actual production hostname before running it; placeholder domains
are intentionally rejected. The keystore path must be absolute, point to a file
and resolve outside the repository.

```powershell
$env:COMPANION_MOBILE_TRUSTED_ORIGINS='https://companion.your-real-domain.cn'
$env:COMPANION_ANDROID_KEYSTORE_FILE='D:\secure\companion-release.jks'
$env:COMPANION_ANDROID_KEYSTORE_PASSWORD='<store password>'
$env:COMPANION_ANDROID_KEY_ALIAS='companion-release'
$env:COMPANION_ANDROID_KEY_PASSWORD='<key password>'
npm run android:release:check --workspace @companion-space/mobile
npm run android:release --workspace @companion-space/mobile
```

The check runs Android Gradle Plugin signing validation, including keystore,
alias and password verification. The release command produces
`apps/mobile/android/app/build/outputs/bundle/release/app-release.aab`.
It then runs strict JAR-signature verification, reads the signer certificate and
writes `release-evidence.json` beside the AAB with the commit, version, approved
origin and SHA-256. Preserve both files before upload, then verify the Play
Console reports the same upload certificate.

## iOS Release

CI builds and tests the unsigned simulator app and performs an unsigned generic
iOS compile diagnostic. Neither output is installable or store-ready. Store
release requires a macOS signing environment and these inputs. Before running,
commit the exact release source and confirm that `git status --short
--untracked-files=all` produces no output. The release commands reject any
tracked change or untracked file and bind their evidence to the current commit.

```bash
export COMPANION_MOBILE_TRUSTED_ORIGINS='https://companion.your-real-domain.cn'
export COMPANION_IOS_TEAM_ID='ABCDE12345'
export COMPANION_IOS_ASC_KEY_PATH='/secure/AuthKey_XXXXXXXXXX.p8'
export COMPANION_IOS_ASC_KEY_ID='XXXXXXXXXX'
export COMPANION_IOS_ASC_ISSUER_ID='00000000-0000-4000-8000-000000000000'
export COMPANION_IOS_OUTPUT_DIR='/absolute/path/to/companion-ios-release'
npm run ios:release:check --workspace @companion-space/mobile
npm run ios:release --workspace @companion-space/mobile
```

The ASC `.p8` path and output directory must be absolute and resolve outside the
repository. The release command requires Xcode 26+, checks the installed
`xcodebuild -help` contract for `app-store-connect`, archives against
`generic/platform=iOS`, and verifies the archived app before export. It then
accepts exactly one newly exported IPA, unpacks it, and rechecks the bundle ID,
marketing version, build number, code signature, signing team, privacy manifest
and embedded production runtime origin. It writes `release-evidence.json` with
the commit, Xcode version and hashes. Preserve that evidence together with the
IPA and CI logs.

This repository has not run a real iOS archive, signing operation or IPA export
on the current Windows host. App Store Connect upload, processing, TestFlight
distribution, privacy questionnaire and public privacy-policy URL remain
external gates and cannot be replaced by a local self-test or successful export.

Before the first store registration, confirm that `space.companion.mobile` in
`apps/mobile/release.json` is the durable bundle/application ID owned by the
publisher. Later store uploads must not silently change it. Increment
`buildNumber` for every upload and set `lastPublishedBuildNumber` to the latest
accepted store build first; `release.json` is the single source for both
platforms. Run `npm run release:sync --workspace @companion-space/mobile` after
editing it. The gate rejects repeated/decreasing build numbers and values above
Google Play's limit.

## Physical Device Gate

On at least one supported iPhone and Android device, verify:

- trusted HTTPS connection and first pairing;
- token refresh across foreground/background and device revocation;
- text chat, microphone permission, realtime interruption and local playback;
- wired/Bluetooth route changes and phone-call audio interruption;
- character rendering, reduced motion, file import/share and app relaunch;
- no credential in URLs, browser storage, logs or screenshots.

Keep signed artifacts, private keys, provisioning profiles and store credentials
outside the repository.
