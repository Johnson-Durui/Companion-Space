import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  requireAbsoluteFile,
  requireCleanRepository,
  requirePathOutsideRepository,
  validateAppId,
  validateBuildNumber,
  validateMarketingVersion,
  validateProductionOrigins,
  validatePublishedBuildSequence,
} from "./release-common.mjs";
import {
  createFreshDirectory,
  parseAndValidateSigningDetails,
  requireFreshPath,
  requireSingleIpa,
  requireSinglePackagedApp,
  validatePackagedMetadata,
  validateRuntimeConfig,
} from "./release-ios-gates.mjs";

const mobileRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(mobileRoot, "../..");
const releaseMetadata = JSON.parse(await readFile(resolve(mobileRoot, "release.json"), "utf8"));

function validateReleaseEnvironment(env) {
  const origins = validateProductionOrigins(env.COMPANION_MOBILE_TRUSTED_ORIGINS, "iOS release");
  const appId = validateAppId(releaseMetadata.appId, "release.json appId");
  const marketingVersion = validateMarketingVersion(releaseMetadata.marketingVersion);
  const buildNumber = validateBuildNumber(releaseMetadata.buildNumber);
  validatePublishedBuildSequence(releaseMetadata.buildNumber, releaseMetadata.lastPublishedBuildNumber);
  const teamId = (env.COMPANION_IOS_TEAM_ID ?? "").trim();
  const keyId = (env.COMPANION_IOS_ASC_KEY_ID ?? "").trim();
  const issuerId = (env.COMPANION_IOS_ASC_ISSUER_ID ?? "").trim();
  if (!/^[A-Z0-9]{10}$/.test(teamId)) throw new Error("COMPANION_IOS_TEAM_ID must be a 10-character Apple team ID.");
  if (!/^[A-Z0-9]{10}$/.test(keyId)) throw new Error("COMPANION_IOS_ASC_KEY_ID must be a 10-character App Store Connect key ID.");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(issuerId)) {
    throw new Error("COMPANION_IOS_ASC_ISSUER_ID must be an App Store Connect issuer UUID.");
  }
  const keyPath = requirePathOutsideRepository(
    requireAbsoluteFile(env.COMPANION_IOS_ASC_KEY_PATH, "COMPANION_IOS_ASC_KEY_PATH"),
    repositoryRoot,
    "COMPANION_IOS_ASC_KEY_PATH",
  );
  const outputText = (env.COMPANION_IOS_OUTPUT_DIR ?? "").trim();
  if (!isAbsolute(outputText)) throw new Error("COMPANION_IOS_OUTPUT_DIR must be an absolute path.");
  const outputRoot = requirePathOutsideRepository(resolve(outputText), repositoryRoot, "COMPANION_IOS_OUTPUT_DIR");
  return { appId, buildNumber, issuerId, keyId, keyPath, marketingVersion, origins, outputRoot, teamId };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: options.cwd ?? mobileRoot, env: process.env, encoding: "utf8", stdio: options.capture ? "pipe" : "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (options.capture) process.stderr.write(`${result.stdout ?? ""}${result.stderr ?? ""}`);
    process.exit(result.status ?? 1);
  }
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

function exportOptions(teamId) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key>
  <string>app-store-connect</string>
  <key>signingStyle</key>
  <string>automatic</string>
  <key>teamID</key>
  <string>${teamId}</string>
  <key>uploadSymbols</key>
  <true/>
  <key>manageAppVersionAndBuildNumber</key>
  <false/>
</dict>
</plist>
`;
}

async function inspectPackagedApp(appPath, config, label) {
  const infoPath = resolve(appPath, "Info.plist");
  const privacyManifestPath = resolve(appPath, "PrivacyInfo.xcprivacy");
  const runtimeConfigPath = resolve(appPath, "public/runtime-config.js");
  if (!existsSync(infoPath)) throw new Error(`${label} Info.plist is missing: ${infoPath}`);
  if (!existsSync(privacyManifestPath)) throw new Error(`${label} privacy manifest is missing: ${privacyManifestPath}`);
  if (!existsSync(runtimeConfigPath)) throw new Error(`${label} runtime configuration is missing: ${runtimeConfigPath}`);
  run("plutil", ["-lint", privacyManifestPath]);
  const appId = run("plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", infoPath], { capture: true }).trim();
  const version = run("plutil", ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", infoPath], { capture: true }).trim();
  const build = run("plutil", ["-extract", "CFBundleVersion", "raw", "-o", "-", infoPath], { capture: true }).trim();
  validatePackagedMetadata({ appId, build, version }, config, label);
  const runtimeConfig = await readFile(runtimeConfigPath, "utf8");
  validateRuntimeConfig(runtimeConfig, config.origins, label);
  run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
  const signingDetails = run("codesign", ["-d", "--verbose=4", appPath], { capture: true });
  const signingIdentity = parseAndValidateSigningDetails(signingDetails, config, label);
  return {
    privacyManifestSha256: createHash("sha256").update(await readFile(privacyManifestPath)).digest("hex").toUpperCase(),
    signingAuthority: signingIdentity.authority,
  };
}

if (process.argv.includes("--self-test")) {
  const complete = {
    COMPANION_MOBILE_TRUSTED_ORIGINS: "https://companion.company.cn",
    COMPANION_IOS_TEAM_ID: "ABCDE12345",
    COMPANION_IOS_ASC_KEY_PATH: process.execPath,
    COMPANION_IOS_ASC_KEY_ID: "ZXCVB67890",
    COMPANION_IOS_ASC_ISSUER_ID: "123e4567-e89b-42d3-a456-426614174000",
    COMPANION_IOS_OUTPUT_DIR: resolve(repositoryRoot, "../ios-release-self-test"),
  };
  assert.doesNotThrow(() => validateReleaseEnvironment(complete));
  assert.throws(() => validateReleaseEnvironment({ ...complete, COMPANION_MOBILE_TRUSTED_ORIGINS: "https://127.0.0.1" }), /real, exact HTTPS origin/);
  assert.throws(() => validateReleaseEnvironment({ ...complete, COMPANION_IOS_TEAM_ID: "short" }), /team ID/);
  assert.throws(() => validateReleaseEnvironment({ ...complete, COMPANION_IOS_ASC_KEY_PATH: "AuthKey.p8" }), /absolute path/);
  assert.throws(() => validateReleaseEnvironment({ ...complete, COMPANION_IOS_ASC_KEY_PATH: fileURLToPath(import.meta.url) }), /outside the repository/);
  assert.throws(() => validateReleaseEnvironment({ ...complete, COMPANION_IOS_OUTPUT_DIR: resolve(mobileRoot, "build/ios-release") }), /outside the repository/);
  assert.throws(() => validateReleaseEnvironment({ ...complete, COMPANION_IOS_ASC_ISSUER_ID: "not-a-uuid" }), /issuer UUID/);
  assert.match(exportOptions(complete.COMPANION_IOS_TEAM_ID), /<string>app-store-connect<\/string>/);
  console.log("iOS release gate self-test passed.");
} else {
  if (process.platform !== "darwin") throw new Error("iOS archive/export requires macOS with Xcode 26 or newer.");
  const config = validateReleaseEnvironment(process.env);
  const source = requireCleanRepository(repositoryRoot);
  requireFreshPath(config.outputRoot, "COMPANION_IOS_OUTPUT_DIR");
  const archivePath = resolve(config.outputRoot, `Companion-Space-${config.marketingVersion}-${config.buildNumber}.xcarchive`);
  const derivedDataPath = resolve(config.outputRoot, "DerivedData");
  const exportPath = resolve(config.outputRoot, "export");
  const exportOptionsPath = resolve(config.outputRoot, "ExportOptions.plist");
  const helpPath = resolve(config.outputRoot, "xcodebuild-help.txt");
  const evidencePath = resolve(config.outputRoot, "release-evidence.json");
  const verificationPath = resolve(config.outputRoot, "verified-ipa");

  const versionOutput = run("xcodebuild", ["-version"], { capture: true });
  const major = Number(versionOutput.match(/Xcode\s+(\d+)/)?.[1] ?? 0);
  if (major < 26) throw new Error(`Xcode 26 or newer is required; received: ${versionOutput.trim()}`);
  const helpOutput = run("xcodebuild", ["-help"], { capture: true });
  if (!helpOutput.includes("app-store-connect")) throw new Error("Installed Xcode does not advertise the app-store-connect export method.");
  if (process.argv.includes("--check")) {
    console.log("iOS release environment, clean source tree and Xcode export method passed validation.");
    process.exit(0);
  }

  await createFreshDirectory(config.outputRoot, "COMPANION_IOS_OUTPUT_DIR");
  await writeFile(helpPath, helpOutput, "utf8");
  await writeFile(exportOptionsPath, exportOptions(config.teamId), "utf8");
  run("plutil", ["-lint", exportOptionsPath]);

  run(process.execPath, [resolve(mobileRoot, "scripts/build.mjs")]);
  const capacitor = resolve(mobileRoot, "..", "..", "node_modules", "@capacitor", "cli", "bin", "capacitor");
  run(process.execPath, [capacitor, "sync", "ios"]);
  run(process.execPath, [resolve(mobileRoot, "scripts/normalize-native.mjs")]);
  const sourceAfterSync = requireCleanRepository(repositoryRoot);
  if (sourceAfterSync.gitCommit !== source.gitCommit) throw new Error("Repository commit changed during iOS release preparation.");

  const authentication = [
    "-allowProvisioningUpdates",
    "-authenticationKeyPath", config.keyPath,
    "-authenticationKeyID", config.keyId,
    "-authenticationKeyIssuerID", config.issuerId,
  ];
  run("xcodebuild", [
    "archive",
    "-project", resolve(mobileRoot, "ios/App/App.xcodeproj"),
    "-scheme", "App",
    "-configuration", "Release",
    "-destination", "generic/platform=iOS",
    "-archivePath", archivePath,
    "-derivedDataPath", derivedDataPath,
    ...authentication,
    `MARKETING_VERSION=${config.marketingVersion}`,
    `CURRENT_PROJECT_VERSION=${config.buildNumber}`,
    `PRODUCT_BUNDLE_IDENTIFIER=${config.appId}`,
    `DEVELOPMENT_TEAM=${config.teamId}`,
    "CODE_SIGN_STYLE=Automatic",
  ]);

  const appPath = resolve(archivePath, "Products/Applications/App.app");
  const archivedApp = await inspectPackagedApp(appPath, config, "Archived app");
  run("xcodebuild", ["-exportArchive", "-archivePath", archivePath, "-exportPath", exportPath, "-exportOptionsPlist", exportOptionsPath, ...authentication]);
  const ipaName = requireSingleIpa(await readdir(exportPath, { withFileTypes: true }), exportPath);
  const ipaPath = resolve(exportPath, ipaName);
  requireFreshPath(verificationPath, "IPA verification directory");
  await mkdir(verificationPath, { recursive: false });
  run("ditto", ["-x", "-k", ipaPath, verificationPath]);
  const payloadPath = resolve(verificationPath, "Payload");
  if (!existsSync(payloadPath)) throw new Error("Exported IPA does not contain a Payload directory.");
  const packagedAppName = requireSinglePackagedApp(await readdir(payloadPath, { withFileTypes: true }));
  const exportedApp = await inspectPackagedApp(resolve(payloadPath, packagedAppName), config, "Exported IPA app");
  const sourceAfterExport = requireCleanRepository(repositoryRoot);
  if (sourceAfterExport.gitCommit !== source.gitCommit) throw new Error("Repository commit changed during iOS archive/export.");
  const sha256 = createHash("sha256").update(await readFile(ipaPath)).digest("hex").toUpperCase();
  const evidence = {
    appId: config.appId,
    archivePath,
    buildNumber: config.buildNumber,
    gitCommit: source.gitCommit,
    ipaPath,
    marketingVersion: config.marketingVersion,
    method: "app-store-connect",
    origins: config.origins,
    privacyManifestSha256: exportedApp.privacyManifestSha256,
    sha256,
    archiveSigningAuthority: archivedApp.signingAuthority,
    ipaSigningAuthority: exportedApp.signingAuthority,
    sourceTreeClean: source.sourceTreeClean,
    teamId: config.teamId,
    xcode: versionOutput.trim(),
  };
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  console.log(`Signed iOS App Store Connect IPA: ${ipaPath}`);
  console.log(`SHA-256: ${sha256}`);
}
