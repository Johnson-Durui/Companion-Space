import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const rootPackageLock = JSON.parse(await readFile(resolve(root, "../../package-lock.json"), "utf8"));
const releaseMetadata = JSON.parse(await readFile(resolve(root, "release.json"), "utf8"));
assert.deepEqual(Object.keys(releaseMetadata).sort(), ["appId", "appName", "buildNumber", "lastPublishedBuildNumber", "marketingVersion", "schemaVersion"]);
assert.equal(releaseMetadata.schemaVersion, 1);
assert.match(releaseMetadata.appId, /^(?:[A-Za-z][A-Za-z0-9]*\.)+[A-Za-z][A-Za-z0-9]*$/);
assert.equal(releaseMetadata.appName, "Companion Space");
assert.match(releaseMetadata.marketingVersion, /^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){2}$/);
assert.ok(Number.isSafeInteger(releaseMetadata.buildNumber) && releaseMetadata.buildNumber > 0 && releaseMetadata.buildNumber <= 2_100_000_000);
assert.ok(Number.isSafeInteger(releaseMetadata.lastPublishedBuildNumber) && releaseMetadata.lastPublishedBuildNumber >= 0);
assert.ok(releaseMetadata.buildNumber > releaseMetadata.lastPublishedBuildNumber);
assert.equal(packageJson.version, releaseMetadata.marketingVersion, "package and store versions must match");
assert.equal(rootPackageLock.packages["apps/mobile"]?.version, releaseMetadata.marketingVersion, "lockfile and store versions must match");
const expectedVersions = {
  android: "8.5.0",
  app: "8.1.1",
  core: "8.5.0",
  filesystem: "8.1.2",
  ios: "8.5.0",
  preferences: "8.0.1",
};

for (const [name, version] of Object.entries(expectedVersions)) {
  assert.equal(packageJson.dependencies[`@capacitor/${name}`], version, `@capacitor/${name} must be pinned`);
}
assert.equal(packageJson.devDependencies["@capacitor/cli"], "8.5.0", "@capacitor/cli must be pinned");

const source = await readFile(resolve(root, "src/index.ts"), "utf8");
assert.match(source, /credentials: "omit"/);
assert.match(source, /redirect: "error"/);
assert.match(source, /url\.username \|\| url\.password/);
assert.match(source, /trustedOrigins\.has\(url\.origin\)/);
assert.match(source, /url\.port !== "443"/);
assert.doesNotMatch(source, /rejectUnauthorized|allowInsecure|token=/i);
assert.match(source, /Plugins\?\.CompanionAuth/);
assert.match(source, /\/api\/v1\/mobile\/pairing\/exchange/);
assert.match(source, /\/api\/v1\/mobile\/auth\/refresh/);
assert.match(source, /if \(!\/\^\\d\{8\}\$\/\.test\(code\)\)/);
assert.doesNotMatch(source, /challenge_id:/);
assert.doesNotMatch(source, /localStorage\.(?:setItem|getItem)\([^\n]*(?:refresh|access|token)/i);
assert.doesNotMatch(source, /localStorage\.(?:setItem|getItem)\([^\n]*(?:pair|challenge|code)/i);
const desktopPairingSource = await readFile(resolve(root, "../web/components/mobile-device-settings.tsx"), "utf8");
assert.match(desktopPairingSource, /navigator\.clipboard\.writeText\(challenge\.code\)/);
assert.doesNotMatch(desktopPairingSource, /localStorage/);
assert.doesNotMatch(desktopPairingSource, /fetch\([^\n]*(?:challenge_id|challenge\.code|pairingPayload)/i);
const webOwnerSession = await readFile(resolve(root, "../web/lib/owner-session.ts"), "utf8");
assert.match(webOwnerSession, /plugin\.returnToLauncher\(\)/);
assert.doesNotMatch(webOwnerSession, /plugin\.clearAuth\(\)/);
assert.match(webOwnerSession, /plugin\.refreshAccessToken\(\)/);
assert.match(webOwnerSession, /NATIVE_REFRESH_SKEW_MS = 30_000/);

const config = await readFile(resolve(root, "capacitor.config.ts"), "utf8");
assert.match(config, /releaseMetadata\.appId/);
assert.match(config, /releaseMetadata\.appName/);
assert.match(config, /cleartext: false/);
assert.doesNotMatch(config, /allowNavigation:\s*\[\s*["']\*["']/);
assert.match(config, /COMPANION_MOBILE_TRUSTED_ORIGINS is required/);
assert.doesNotMatch(config, /https:\/\/companion\.localhost/);
const buildScript = await readFile(resolve(root, "scripts/build.mjs"), "utf8");
assert.match(buildScript, /COMPANION_MOBILE_TRUSTED_ORIGINS is required/);
assert.match(buildScript, /url\.port === "443"/);
assert.doesNotMatch(buildScript, /https:\/\/companion\.localhost/);
const androidReleaseScript = await readFile(resolve(root, "scripts/release-android.mjs"), "utf8");
assert.match(androidReleaseScript, /validateProductionOrigins/);
assert.match(androidReleaseScript, /requireCleanRepository/);
assert.match(androidReleaseScript, /requirePathOutsideRepository/);
assert.match(androidReleaseScript, /:app:validateSigningRelease/);
assert.match(androidReleaseScript, /:app:verifyReleaseBundleMetadata/);
assert.match(androidReleaseScript, /jarsigner/);
assert.match(androidReleaseScript, /keytool/);
assert.match(androidReleaseScript, /release-evidence\.json/);
const iosReleaseScript = await readFile(resolve(root, "scripts/release-ios.mjs"), "utf8");
assert.match(iosReleaseScript, /validateProductionOrigins/);
assert.match(iosReleaseScript, /requireCleanRepository/);
assert.match(iosReleaseScript, /requirePathOutsideRepository/);
assert.match(iosReleaseScript, /generic\/platform=iOS/);
assert.match(iosReleaseScript, /app-store-connect/);
assert.match(iosReleaseScript, /-allowProvisioningUpdates/);
assert.match(iosReleaseScript, /codesign/);
assert.match(iosReleaseScript, /CFBundleShortVersionString/);
assert.match(iosReleaseScript, /CFBundleVersion/);
assert.match(iosReleaseScript, /CFBundleIdentifier/);
assert.match(iosReleaseScript, /PrivacyInfo\.xcprivacy/);
assert.match(iosReleaseScript, /privacyManifestSha256/);
assert.match(iosReleaseScript, /gitCommit/);
assert.match(iosReleaseScript, /ditto/);
assert.match(iosReleaseScript, /Payload/);
assert.match(iosReleaseScript, /runtime-config\.js/);
assert.match(iosReleaseScript, /sourceTreeClean/);
assert.match(iosReleaseScript, /release-evidence\.json/);
const iosReleaseGatesScript = await readFile(resolve(root, "scripts/release-ios-gates.mjs"), "utf8");
assert.match(iosReleaseGatesScript, /TeamIdentifier/);
assert.match(iosReleaseGatesScript, /Expected exactly one IPA/);
assert.match(iosReleaseGatesScript, /mkdir\(path, \{ recursive: false \}\)/);
assert.match(iosReleaseGatesScript, /Expected exactly one app/);
assert.match(iosReleaseGatesScript, /trusted origins do not match/);
const releaseCommonScript = await readFile(resolve(root, "scripts/release-common.mjs"), "utf8");
assert.match(releaseCommonScript, /--untracked-files=all/);
assert.match(releaseCommonScript, /Production release requires a clean committed repository/);
assert.match(releaseCommonScript, /must be outside the repository/);
assert.equal(packageJson.scripts["android:release:self-test"], "node scripts/release-android.mjs --self-test");
assert.equal(packageJson.scripts["ios:release:self-test"], "node scripts/release-ios.mjs --self-test");
assert.equal(packageJson.scripts["release:sync"], "node scripts/sync-release-version.mjs");
assert.equal(packageJson.scripts["release:sync:check"], "node scripts/sync-release-version.mjs --check");
assert.equal(packageJson.scripts["test:release-gates"], "node --test --test-isolation=none scripts/release-common.test.mjs scripts/release-ios-gates.test.mjs");
const releaseSyncScript = await readFile(resolve(root, "scripts/sync-release-version.mjs"), "utf8");
assert.match(releaseSyncScript, /release\.json/);
assert.match(releaseSyncScript, /expectedCount/);
assert.match(releaseSyncScript, /MARKETING_VERSION/);
assert.match(releaseSyncScript, /CURRENT_PROJECT_VERSION/);
assert.match(releaseSyncScript, /PRODUCT_BUNDLE_IDENTIFIER/);
assert.match(releaseSyncScript, /packages\?\.\["apps\/mobile"\]/);

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function assertPngDimensions(path, width, height) {
  const buffer = await readFile(path);
  assert.equal(buffer.toString("ascii", 1, 4), "PNG", `${path} must be a PNG`);
  assert.equal(buffer.readUInt32BE(16), width, `${path} width`);
  assert.equal(buffer.readUInt32BE(20), height, `${path} height`);
}

await assertPngDimensions(resolve(root, "assets/app-icon-master.png"), 1254, 1254);

const androidManifestPath = resolve(root, "android/app/src/main/AndroidManifest.xml");
if (await exists(androidManifestPath)) {
  const manifest = await readFile(androidManifestPath, "utf8");
  assert.match(manifest, /android\.permission\.RECORD_AUDIO/);
  assert.match(manifest, /android\.permission\.MODIFY_AUDIO_SETTINGS/);
  assert.match(manifest, /android\.hardware\.microphone/);
  assert.match(manifest, /android:required="false"/);
  assert.match(manifest, /android:allowBackup="false"/);
  assert.match(manifest, /android:usesCleartextTraffic="false"/);
  const androidPlugin = await readFile(resolve(root, "android/app/src/main/java/space/companion/mobile/CompanionAuthPlugin.java"), "utf8");
  const androidBuild = await readFile(resolve(root, "android/app/build.gradle"), "utf8");
  assert.match(androidBuild, /mobileRelease\.appId/);
  assert.match(androidBuild, /mobileRelease\.buildNumber/);
  assert.match(androidBuild, /mobileRelease\.marketingVersion/);
  assert.match(androidBuild, /verifyReleaseBundleMetadata/);
  assert.match(androidBuild, /BundleToolMain/);
  const androidStrings = await readFile(resolve(root, "android/app/src/main/res/values/strings.xml"), "utf8");
  assert.match(androidStrings, new RegExp(`<string name="app_name">${releaseMetadata.appName}</string>`));
  assert.match(androidStrings, new RegExp(`<string name="package_name">${releaseMetadata.appId.replaceAll(".", "\\.")}</string>`));
  assert.match(androidPlugin, /AndroidKeyStore/);
  assert.match(androidPlugin, /AES\/GCM\/NoPadding/);
  assert.match(androidPlugin, /isAuthorizedRemotePage/);
  assert.match(androidPlugin, /public void clearAccessToken/);
  assert.match(androidPlugin, /public void returnToLauncher/);
  assert.match(androidPlugin, /public void refreshAccessToken/);
  assert.match(androidPlugin, /setInstanceFollowRedirects\(false\)/);
  assert.match(androidPlugin, /\/api\/v1\/mobile\/auth\/refresh/);
  assert.match(androidPlugin, /Full mobile unpairing is restricted to the local launcher/);
  const androidOriginPolicy = await readFile(resolve(root, "android/app/src/main/java/space/companion/mobile/MobileOriginPolicy.java"), "utf8");
  assert.match(androidOriginPolicy, /approved\.getPort\(\) == current\.getPort\(\)/);
  assert.match(androidOriginPolicy, /uri\.getPort\(\) == 443/);
  assert.match(androidPlugin, /loadUrl\(getBridge\(\)\.getLocalUrl\(\)\)/);
  assert.doesNotMatch(androidPlugin, /putString\([^,]+,\s*refreshToken\)/);
  await assertPngDimensions(resolve(root, "android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png"), 192, 192);
}

const infoPlistPath = resolve(root, "ios/App/App/Info.plist");
if (await exists(infoPlistPath)) {
  const infoPlist = await readFile(infoPlistPath, "utf8");
  assert.match(infoPlist, /NSMicrophoneUsageDescription/);
  assert.match(infoPlist, /NSLocalNetworkUsageDescription/);
  const iosPlugin = await readFile(resolve(root, "ios/App/App/CompanionAuthPlugin.swift"), "utf8");
  assert.match(iosPlugin, /kSecClassGenericPassword/);
  assert.match(iosPlugin, /kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly/);
  assert.match(iosPlugin, /isAuthorizedRemotePage/);
  assert.match(iosPlugin, /func clearAccessToken/);
  assert.match(iosPlugin, /func returnToLauncher/);
  assert.match(iosPlugin, /func refreshAccessToken/);
  assert.match(iosPlugin, /NoRedirectSessionDelegate/);
  assert.match(iosPlugin, /URLSessionConfiguration\.ephemeral/);
  assert.match(iosPlugin, /SecItemUpdate/);
  assert.match(iosPlugin, /Full mobile unpairing is restricted to the local launcher/);
  assert.match(iosPlugin, /MobileAuthPolicy\.isSameOrigin/);
  assert.match(iosPlugin, /MobileAuthPolicy\.isCurrentRefresh/);
  const iosOriginPolicy = await readFile(resolve(root, "ios/App/App/MobileAuthPolicy.swift"), "utf8");
  assert.match(iosOriginPolicy, /current\.port == approved\.port/);
  assert.match(iosOriginPolicy, /components\.port == 443/);
  const privacy = await readFile(resolve(root, "ios/App/App/PrivacyInfo.xcprivacy"), "utf8");
  assert.match(privacy, /NSPrivacyAccessedAPICategoryUserDefaults/);
  assert.match(privacy, /NSPrivacyAccessedAPICategoryFileTimestamp/);
  const project = await readFile(resolve(root, "ios/App/App.xcodeproj/project.pbxproj"), "utf8");
  assert.match(project, /PrivacyInfo\.xcprivacy in Resources/);
  assert.match(project, /PBXNativeTarget "AppTests"/);
  assert.match(project, /MobileAuthPolicyTests\.swift in Sources/);
  assert.equal([...project.matchAll(new RegExp(`MARKETING_VERSION = ${releaseMetadata.marketingVersion.replaceAll(".", "\\.")};`, "g"))].length, 2);
  assert.equal([...project.matchAll(new RegExp(`CURRENT_PROJECT_VERSION = ${releaseMetadata.buildNumber};`, "g"))].length, 2);
  assert.equal([...project.matchAll(new RegExp(`PRODUCT_BUNDLE_IDENTIFIER = ${releaseMetadata.appId.replaceAll(".", "\\.")};`, "g"))].length, 2);
  assert.equal([...project.matchAll(new RegExp(`PRODUCT_BUNDLE_IDENTIFIER = ${releaseMetadata.appId.replaceAll(".", "\\.")}\\.tests;`, "g"))].length, 2);
  const scheme = await readFile(resolve(root, "ios/App/App.xcodeproj/xcshareddata/xcschemes/App.xcscheme"), "utf8");
  assert.match(scheme, /BlueprintName="AppTests"/);
  assert.match(scheme, /<TestableReference skipped="NO">/);
  const swiftPackage = await readFile(resolve(root, "ios/App/CapApp-SPM/Package.swift"), "utf8");
  assert.doesNotMatch(swiftPackage, /path:\s*"[^"]*\\/);
  await assertPngDimensions(resolve(root, "ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png"), 1024, 1024);
}

console.log("mobile static security checks passed");
