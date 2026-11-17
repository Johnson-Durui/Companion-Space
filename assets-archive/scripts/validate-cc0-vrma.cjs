const fs = require("node:fs");
const path = require("node:path");

const motionDirectory = process.argv[2] ?? path.resolve(
  __dirname,
  "../apps/web/public/assets/characters/motions",
);
const expectedFiles = [
  "companion-idle.vrma",
  "companion-listening.vrma",
  "companion-speaking.vrma",
  "companion-thinking.vrma",
];

async function validateAssets(directory, validator, log = console.log) {
  const files = fs.readdirSync(directory)
    .filter((name) => name.endsWith(".vrma"))
    .sort();
  const missing = expectedFiles.filter((file) => !files.includes(file));
  const unexpected = files.filter((file) => !expectedFiles.includes(file));

  if (missing.length > 0 || unexpected.length > 0) {
    log(JSON.stringify({ gate: "cc0-vrma", missing, status: "failed", unexpected }));
    return false;
  }

  validator ??= require("gltf-validator");
  let hasIssues = false;
  for (const file of files) {
    const report = await validator.validateBytes(
      new Uint8Array(fs.readFileSync(path.join(directory, file))),
      { uri: file },
    );
    const issues = report.issues;
    log(JSON.stringify({
      errors: issues.numErrors,
      file,
      hints: issues.numHints,
      infos: issues.numInfos,
      messages: issues.messages.map(({ code, message, severity }) => ({
        code,
        message,
        severity,
      })),
      warnings: issues.numWarnings,
    }));
    hasIssues ||= issues.numErrors > 0 || issues.numWarnings > 0;
  }

  log(JSON.stringify({ gate: "cc0-vrma", status: hasIssues ? "failed" : "passed" }));
  return !hasIssues;
}

if (require.main === module) {
  void validateAssets(motionDirectory).then((passed) => {
    process.exitCode = passed ? 0 : 1;
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { validateAssets };
