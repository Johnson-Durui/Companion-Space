import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const paths = {
  package: resolve(root, "package.json"),
  lock: resolve(root, "../../package-lock.json"),
  project: resolve(root, "ios/App/App.xcodeproj/project.pbxproj"),
};
const release = JSON.parse(await readFile(resolve(root, "release.json"), "utf8"));

assert.match(release.appId, /^(?:[A-Za-z][A-Za-z0-9]*\.)+[A-Za-z][A-Za-z0-9]*$/);
assert.match(release.marketingVersion, /^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){2}$/);
assert.ok(Number.isSafeInteger(release.buildNumber) && release.buildNumber > 0 && release.buildNumber <= 2_100_000_000);
assert.ok(Number.isSafeInteger(release.lastPublishedBuildNumber) && release.lastPublishedBuildNumber >= 0);
assert.ok(release.buildNumber > release.lastPublishedBuildNumber);

function replaceExactly(source, pattern, replacement, expectedCount, label) {
  const matches = [...source.matchAll(pattern)];
  assert.equal(matches.length, expectedCount, `${label}: expected ${expectedCount} occurrences, found ${matches.length}`);
  return source.replace(pattern, replacement);
}

const original = {
  package: await readFile(paths.package, "utf8"),
  lock: await readFile(paths.lock, "utf8"),
  project: await readFile(paths.project, "utf8"),
};

const packageJson = JSON.parse(original.package);
assert.equal(packageJson.name, "@companion-space/mobile");
let nextPackage = replaceExactly(
  original.package,
  /^(\s*"version"\s*:\s*)"[^"]+"/gm,
  `$1"${release.marketingVersion}"`,
  1,
  "mobile package version",
);

const lockJson = JSON.parse(original.lock);
assert.equal(lockJson.packages?.["apps/mobile"]?.name, "@companion-space/mobile");
const lockBlockPattern = /^(\s*"apps\/mobile"\s*:\s*\{[\s\S]*?^\s*\})(?=,?\r?\n\s*"[^"]+"\s*:)/m;
const lockBlocks = [...original.lock.matchAll(new RegExp(lockBlockPattern.source, "gm"))];
assert.equal(lockBlocks.length, 1, `mobile lock workspace: expected 1 block, found ${lockBlocks.length}`);
const nextLockBlock = replaceExactly(
  lockBlocks[0][0],
  /^(\s*"version"\s*:\s*)"[^"]+"/gm,
  `$1"${release.marketingVersion}"`,
  1,
  "mobile lock workspace version",
);
const nextLock = original.lock.replace(lockBlocks[0][0], nextLockBlock);

let nextProject = replaceExactly(
  original.project,
  /^(\s*MARKETING_VERSION\s*=\s*)[^;]+;/gm,
  `$1${release.marketingVersion};`,
  2,
  "iOS MARKETING_VERSION",
);
nextProject = replaceExactly(
  nextProject,
  /^(\s*CURRENT_PROJECT_VERSION\s*=\s*)[^;]+;/gm,
  `$1${release.buildNumber};`,
  2,
  "iOS CURRENT_PROJECT_VERSION",
);
nextProject = replaceExactly(
  nextProject,
  /^(\s*PRODUCT_BUNDLE_IDENTIFIER\s*=\s*)[^;\r\n]+\.tests;/gm,
  `$1${release.appId}.tests;`,
  2,
  "iOS test PRODUCT_BUNDLE_IDENTIFIER",
);
nextProject = replaceExactly(
  nextProject,
  /^(\s*PRODUCT_BUNDLE_IDENTIFIER\s*=\s*)(?![^;\r\n]+\.tests;)[^;\r\n]+;/gm,
  `$1${release.appId};`,
  2,
  "iOS app PRODUCT_BUNDLE_IDENTIFIER",
);

const next = { package: nextPackage, lock: nextLock, project: nextProject };
const changed = Object.keys(paths).filter((key) => original[key] !== next[key]);
if (process.argv.includes("--check")) {
  assert.deepEqual(changed, [], `release metadata is not synchronized: ${changed.join(", ")}`);
  console.log("mobile release metadata is synchronized");
} else {
  await Promise.all(changed.map((key) => writeFile(paths[key], next[key], "utf8")));
  console.log(changed.length ? `synchronized: ${changed.join(", ")}` : "mobile release metadata already synchronized");
}
