import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  requireAbsoluteFile,
  requireCleanRepository,
  requirePathOutsideRepository,
  validatePublishedBuildSequence,
  validateProductionOrigins,
} from "./release-common.mjs";

const mobileRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(mobileRoot, "../..");
const releaseMetadata = JSON.parse(await readFile(resolve(mobileRoot, "release.json"), "utf8"));
const signingNames = [
  "COMPANION_ANDROID_KEYSTORE_FILE",
  "COMPANION_ANDROID_KEYSTORE_PASSWORD",
  "COMPANION_ANDROID_KEY_ALIAS",
  "COMPANION_ANDROID_KEY_PASSWORD",
];

function validateReleaseEnvironment(env) {
  const origins = validateProductionOrigins(env.COMPANION_MOBILE_TRUSTED_ORIGINS, "Android release");
  validatePublishedBuildSequence(releaseMetadata.buildNumber, releaseMetadata.lastPublishedBuildNumber);

  const missing = signingNames.filter((name) => !(env[name] ?? "").trim());
  if (missing.length) throw new Error(`Android release signing is incomplete: missing ${missing.join(", ")}`);
  const keystorePath = requirePathOutsideRepository(
    requireAbsoluteFile(env.COMPANION_ANDROID_KEYSTORE_FILE, "COMPANION_ANDROID_KEYSTORE_FILE"),
    repositoryRoot,
    "COMPANION_ANDROID_KEYSTORE_FILE",
  );
  return { keystorePath, origins };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? mobileRoot,
    env: process.env,
    encoding: options.capture ? "utf8" : undefined,
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (options.capture) process.stderr.write(`${result.stdout ?? ""}${result.stderr ?? ""}`);
    process.exit(result.status ?? 1);
  }
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

function javaTool(name) {
  const executable = process.platform === "win32" ? `${name}.exe` : name;
  const javaHome = (process.env.JAVA_HOME ?? "").trim();
  return javaHome ? resolve(javaHome, "bin", executable) : executable;
}

function certificateFromPem(output, label) {
  const match = output.match(/-----BEGIN CERTIFICATE-----([A-Za-z0-9+/=\r\n]+)-----END CERTIFICATE-----/);
  if (!match) throw new Error(`${label} did not expose an X.509 certificate.`);
  return Buffer.from(match[1].replace(/\s+/g, ""), "base64");
}

if (process.argv.includes("--self-test")) {
  const complete = {
    COMPANION_MOBILE_TRUSTED_ORIGINS: "https://companion.company.cn",
    COMPANION_ANDROID_KEYSTORE_FILE: process.execPath,
    COMPANION_ANDROID_KEYSTORE_PASSWORD: "store",
    COMPANION_ANDROID_KEY_ALIAS: "release",
    COMPANION_ANDROID_KEY_PASSWORD: "key",
  };
  assert.doesNotThrow(() => validateReleaseEnvironment(complete));
  assert.throws(() => validateReleaseEnvironment({ ...complete, COMPANION_MOBILE_TRUSTED_ORIGINS: "https://mobile-ci.example.test" }), /real, exact HTTPS origin/);
  assert.throws(() => validateReleaseEnvironment({ ...complete, COMPANION_MOBILE_TRUSTED_ORIGINS: "https://companion.your-real-domain.cn" }), /real, exact HTTPS origin/);
  assert.throws(() => validateReleaseEnvironment({ ...complete, COMPANION_MOBILE_TRUSTED_ORIGINS: "https://user:password@companion.company.cn" }), /exact HTTPS origin/);
  assert.throws(() => validateReleaseEnvironment({ ...complete, COMPANION_MOBILE_TRUSTED_ORIGINS: "https://companion.company.cn:8443" }), /port 443/);
  assert.throws(() => validateReleaseEnvironment({ ...complete, COMPANION_MOBILE_TRUSTED_ORIGINS: "https://companion.company.cn/mobile" }), /exact HTTPS origin/);
  assert.throws(() => validateReleaseEnvironment({ ...complete, COMPANION_MOBILE_TRUSTED_ORIGINS: "https://127.0.0.1" }), /real, exact HTTPS origin/);
  assert.throws(() => validateReleaseEnvironment({ ...complete, COMPANION_MOBILE_TRUSTED_ORIGINS: "https://[::1]" }), /real, exact HTTPS origin/);
  assert.throws(() => validateReleaseEnvironment({ ...complete, COMPANION_MOBILE_TRUSTED_ORIGINS: "https://[::ffff:127.0.0.1]" }), /real, exact HTTPS origin/);
  assert.throws(() => validateReleaseEnvironment({ ...complete, COMPANION_ANDROID_KEY_ALIAS: "" }), /incomplete/);
  assert.throws(() => validateReleaseEnvironment({ ...complete, COMPANION_ANDROID_KEYSTORE_FILE: "release.keystore" }), /absolute path/);
  assert.throws(() => validateReleaseEnvironment({ ...complete, COMPANION_ANDROID_KEYSTORE_FILE: dirname(fileURLToPath(import.meta.url)) }), /must be a file/);
  assert.throws(() => validateReleaseEnvironment({ ...complete, COMPANION_ANDROID_KEYSTORE_FILE: fileURLToPath(import.meta.url) }), /outside the repository/);
  console.log("Android release gate self-test passed.");
} else {
  const config = validateReleaseEnvironment(process.env);
  const source = requireCleanRepository(repositoryRoot);
  const gradle = resolve(mobileRoot, "android", process.platform === "win32" ? "gradlew.bat" : "gradlew");
  const runGradle = (tasks) => {
    if (process.platform === "win32") {
      const result = spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `call gradlew.bat ${tasks.join(" ")}`], {
        cwd: resolve(mobileRoot, "android"),
        env: process.env,
        stdio: "inherit",
      });
      if (result.error) throw result.error;
      if (result.status !== 0) process.exit(result.status ?? 1);
    } else {
      run(gradle, tasks);
    }
  };
  if (process.argv.includes("--check")) {
    runGradle([":app:validateSigningRelease"]);
    console.log("Android release origin, keystore, alias and passwords passed validation.");
  } else {
    const capacitor = resolve(mobileRoot, "..", "..", "node_modules", "@capacitor", "cli", "bin", "capacitor");
    run(process.execPath, [resolve(mobileRoot, "scripts", "build.mjs")]);
    run(process.execPath, [capacitor, "sync"]);
    run(process.execPath, [resolve(mobileRoot, "scripts", "normalize-native.mjs")]);
    const sourceAfterSync = requireCleanRepository(repositoryRoot);
    if (sourceAfterSync.gitCommit !== source.gitCommit) throw new Error("Repository commit changed during Android release preparation.");
    runGradle([":app:validateSigningRelease", ":app:verifyReleaseBundleMetadata"]);
    const bundlePath = resolve(mobileRoot, "android/app/build/outputs/bundle/release/app-release.aab");
    const metadataPath = resolve(mobileRoot, "android/app/build/outputs/bundle/release/bundle-metadata.json");
    if (!existsSync(bundlePath)) throw new Error(`Signed Android App Bundle is missing: ${bundlePath}`);
    if (!existsSync(metadataPath)) throw new Error(`Release bundle metadata evidence is missing: ${metadataPath}`);
    run(javaTool("jarsigner"), [
      "-verify", "-strict", "-verbose", "-certs",
      "-keystore", config.keystorePath,
      "-storepass:env", "COMPANION_ANDROID_KEYSTORE_PASSWORD",
      bundlePath,
    ], { capture: true });
    const signerCertificate = certificateFromPem(
      run(javaTool("keytool"), ["-printcert", "-jarfile", bundlePath, "-rfc"], { capture: true }),
      "Signed Android App Bundle",
    );
    const expectedCertificate = certificateFromPem(
      run(javaTool("keytool"), [
        "-exportcert", "-rfc",
        "-keystore", config.keystorePath,
        "-alias", process.env.COMPANION_ANDROID_KEY_ALIAS,
        "-storepass:env", "COMPANION_ANDROID_KEYSTORE_PASSWORD",
      ], { capture: true }),
      "Configured Android release key",
    );
    if (!signerCertificate.equals(expectedCertificate)) throw new Error("The AAB signer certificate does not match the configured release key.");
    const sourceAfterSigning = requireCleanRepository(repositoryRoot);
    if (sourceAfterSigning.gitCommit !== source.gitCommit) throw new Error("Repository commit changed during Android release signing.");
    const sha256 = createHash("sha256").update(await readFile(bundlePath)).digest("hex").toUpperCase();
    const signerSha256 = createHash("sha256").update(signerCertificate).digest("hex").toUpperCase();
    const bundleMetadata = JSON.parse(await readFile(metadataPath, "utf8"));
    const evidencePath = resolve(mobileRoot, "android/app/build/outputs/bundle/release/release-evidence.json");
    const evidence = {
      appId: releaseMetadata.appId,
      bundleMetadata,
      buildNumber: releaseMetadata.buildNumber,
      bundlePath,
      gitCommit: source.gitCommit,
      marketingVersion: releaseMetadata.marketingVersion,
      origins: config.origins,
      sha256,
      signerCertificateSha256: signerSha256,
      sourceTreeClean: source.sourceTreeClean,
    };
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    console.log(`Signed Android App Bundle: ${bundlePath}`);
    console.log(`SHA-256: ${sha256}`);
    console.log(`Release evidence: ${evidencePath}`);
  }
}
