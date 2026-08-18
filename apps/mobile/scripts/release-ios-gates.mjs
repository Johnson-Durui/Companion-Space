import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export function requireFreshPath(path, label) {
  if (existsSync(path)) throw new Error(`${label} must not already exist: ${path}`);
}

export async function createFreshDirectory(path, label) {
  await mkdir(dirname(path), { recursive: true });
  try {
    await mkdir(path, { recursive: false });
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error(`${label} must not already exist: ${path}`);
    throw error;
  }
}

export function requireSingleIpa(entries, exportPath) {
  const matches = entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".ipa"));
  if (matches.length !== 1) throw new Error(`Expected exactly one IPA in ${exportPath}; found ${matches.length}.`);
  return matches[0].name;
}

export function requireSinglePackagedApp(entries) {
  const matches = entries.filter((entry) => entry.isDirectory() && entry.name.endsWith(".app"));
  if (matches.length !== 1) throw new Error(`Expected exactly one app in the IPA Payload; found ${matches.length}.`);
  return matches[0].name;
}

export function validatePackagedMetadata(actual, expected, label) {
  if (actual.appId !== expected.appId || actual.version !== expected.marketingVersion || actual.build !== expected.buildNumber) {
    throw new Error(`${label} metadata mismatch: ${actual.appId} ${actual.version} (${actual.build})`);
  }
}

export function expectedRuntimeConfig(origins) {
  return `globalThis.__COMPANION_TRUSTED_ORIGINS__=${JSON.stringify(origins)};globalThis.__COMPANION_ALLOW_HTTP_LOCALHOST__=false;\n`;
}

export function validateRuntimeConfig(actual, origins, label) {
  if (actual !== expectedRuntimeConfig(origins)) throw new Error(`${label} trusted origins do not match the release configuration.`);
}

export function parseAndValidateSigningDetails(signingDetails, expected, label) {
  const identifier = signingDetails.match(/^Identifier=(.+)$/m)?.[1]?.trim();
  const teamId = signingDetails.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim();
  const authority = signingDetails.match(/^Authority=(.+)$/m)?.[1]?.trim();
  if (identifier !== expected.appId || teamId !== expected.teamId || !authority) {
    throw new Error(`${label} signature identity mismatch: identifier=${identifier ?? "missing"}, team=${teamId ?? "missing"}`);
  }
  return { authority, identifier, teamId };
}
