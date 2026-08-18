import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  createFreshDirectory,
  parseAndValidateSigningDetails,
  requireFreshPath,
  requireSingleIpa,
  requireSinglePackagedApp,
  validatePackagedMetadata,
  validateRuntimeConfig,
} from "./release-ios-gates.mjs";

const entry = (name, kind) => ({
  isDirectory: () => kind === "directory",
  isFile: () => kind === "file",
  name,
});

test("iOS output must be fresh", async () => {
  const base = await mkdtemp(join(tmpdir(), "companion-ios-output-"));
  try {
    const existing = resolve(base, "existing");
    await mkdir(existing);
    assert.throws(() => requireFreshPath(existing, "output"), /must not already exist/);
    assert.doesNotThrow(() => requireFreshPath(resolve(base, "new"), "output"));
    const concurrent = resolve(base, "concurrent", "release");
    const results = await Promise.allSettled([
      createFreshDirectory(concurrent, "output"),
      createFreshDirectory(concurrent, "output"),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find((result) => result.status === "rejected");
    assert.match(rejected.reason.message, /must not already exist/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("IPA and Payload selection require exactly one matching artifact", () => {
  assert.throws(() => requireSingleIpa([], "/export"), /found 0/);
  assert.throws(
    () => requireSingleIpa([entry("a.ipa", "file"), entry("b.IPA", "file")], "/export"),
    /found 2/,
  );
  assert.equal(requireSingleIpa([entry("notes.txt", "file"), entry("App.ipa", "file")], "/export"), "App.ipa");
  assert.throws(() => requireSinglePackagedApp([]), /found 0/);
  assert.throws(
    () => requireSinglePackagedApp([entry("A.app", "directory"), entry("B.app", "directory")]),
    /found 2/,
  );
  assert.equal(requireSinglePackagedApp([entry("App.app", "directory"), entry("readme", "file")]), "App.app");
});

test("packaged metadata and runtime origin must exactly match the release", () => {
  const expected = { appId: "space.companion.mobile", buildNumber: "7", marketingVersion: "1.2.3" };
  const actual = { appId: expected.appId, build: expected.buildNumber, version: expected.marketingVersion };
  assert.doesNotThrow(() => validatePackagedMetadata(actual, expected, "IPA"));
  for (const mismatch of [
    { ...actual, appId: "space.attacker.mobile" },
    { ...actual, version: "1.2.4" },
    { ...actual, build: "8" },
  ]) assert.throws(() => validatePackagedMetadata(mismatch, expected, "IPA"), /metadata mismatch/);

  const origins = ["https://companion.company.cn"];
  const validRuntime = `globalThis.__COMPANION_TRUSTED_ORIGINS__=["https://companion.company.cn"];globalThis.__COMPANION_ALLOW_HTTP_LOCALHOST__=false;\n`;
  assert.doesNotThrow(() => validateRuntimeConfig(validRuntime, origins, "IPA"));
  assert.throws(() => validateRuntimeConfig(validRuntime.replace("company.cn", "attacker.invalid"), origins, "IPA"), /trusted origins/);
  assert.throws(() => validateRuntimeConfig(validRuntime.replace("false", "true"), origins, "IPA"), /trusted origins/);
});

test("codesign identity requires exact identifier, team, and authority", () => {
  const expected = { appId: "space.companion.mobile", teamId: "ABCDE12345" };
  const valid = "Identifier=space.companion.mobile\nAuthority=Apple Distribution: Companion\nTeamIdentifier=ABCDE12345\n";
  assert.equal(parseAndValidateSigningDetails(valid, expected, "IPA").authority, "Apple Distribution: Companion");
  assert.throws(() => parseAndValidateSigningDetails(valid.replace(expected.appId, "space.attacker.mobile"), expected, "IPA"), /signature identity mismatch/);
  assert.throws(() => parseAndValidateSigningDetails(valid.replace(expected.teamId, "ZZZZZ99999"), expected, "IPA"), /signature identity mismatch/);
  assert.throws(() => parseAndValidateSigningDetails(valid.replace(/^Authority=.*\n/m, ""), expected, "IPA"), /signature identity mismatch/);
});
