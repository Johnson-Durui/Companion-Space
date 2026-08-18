import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

function isLocalOnlyHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const mappedLoopback = host.startsWith("::ffff:") && (host.includes("127.") || host.startsWith("::ffff:7f"));
  const mappedUnspecified = host === "::ffff:0.0.0.0" || host === "::ffff:0:0";
  return host === "localhost" || host.endsWith(".localhost") || host === "0.0.0.0" || host === "::" || host === "::1" || host.startsWith("127.") || mappedLoopback || mappedUnspecified;
}

export function validateProductionOrigins(value, label = "Release") {
  const origins = (value ?? "").split(",").map((origin) => origin.trim()).filter(Boolean);
  if (!origins.length) throw new Error("COMPANION_MOBILE_TRUSTED_ORIGINS is required.");
  for (const origin of origins) {
    let url;
    try {
      url = new URL(origin);
    } catch {
      throw new Error(`${label} origin must be an exact HTTPS origin: ${origin}`);
    }
    const placeholder = /(^|\.)(example\.(com|net|org)|test|example|invalid|localhost)$/i.test(url.hostname) || url.hostname.includes("your-real-domain");
    const exactOrigin = !url.username && !url.password && !url.port && (url.pathname === "" || url.pathname === "/") && !url.search && !url.hash;
    if (url.protocol !== "https:" || placeholder || isLocalOnlyHost(url.hostname) || !exactOrigin) {
      throw new Error(`${label} origin must be a real, exact HTTPS origin on port 443: ${origin}`);
    }
  }
  return origins.map((origin) => new URL(origin).origin);
}

export function requireAbsoluteFile(value, label) {
  const path = (value ?? "").trim();
  if (!path) throw new Error(`${label} is required.`);
  if (!isAbsolute(path)) throw new Error(`${label} must be an absolute path.`);
  const resolved = resolve(path);
  if (!existsSync(resolved) || !statSync(resolved).isFile()) throw new Error(`${label} must be a file: ${resolved}`);
  return resolved;
}

function canonicalizePath(path) {
  let cursor = resolve(path);
  const missingSegments = [];
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) break;
    missingSegments.unshift(basename(cursor));
    cursor = parent;
  }
  const canonicalBase = existsSync(cursor) ? realpathSync.native(cursor) : cursor;
  return resolve(canonicalBase, ...missingSegments);
}

export function requirePathOutsideRepository(path, repositoryRoot, label) {
  const resolvedPath = resolve(path);
  const resolvedRepository = resolve(repositoryRoot);
  const canonicalPath = canonicalizePath(path);
  const canonicalRepository = canonicalizePath(repositoryRoot);
  const isInside = (root, candidate) => {
    const pathRelativeToRepository = relative(root, candidate);
    return pathRelativeToRepository === ""
      || (pathRelativeToRepository !== ".."
        && !pathRelativeToRepository.startsWith(`..${sep}`)
        && !isAbsolute(pathRelativeToRepository));
  };
  const isInsideRepository = isInside(resolvedRepository, resolvedPath)
    || isInside(canonicalRepository, canonicalPath);
  if (isInsideRepository) throw new Error(`${label} must be outside the repository: ${canonicalPath}`);
  return canonicalPath;
}

function runGit(repositoryRoot, args) {
  const result = spawnSync("git", ["-c", `safe.directory=${repositoryRoot}`, ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout || "unknown error").trim()}`);
  }
  return result.stdout.trim();
}

export function requireCleanRepository(repositoryRoot) {
  const changes = runGit(repositoryRoot, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (changes) {
    const preview = changes.split(/\r?\n/).slice(0, 8).join("\n");
    throw new Error(`Production release requires a clean committed repository, including no untracked files.\n${preview}`);
  }
  return {
    gitCommit: runGit(repositoryRoot, ["rev-parse", "HEAD"]),
    sourceTreeClean: true,
  };
}

export function validateAppId(value, label) {
  const appId = (value ?? "").trim();
  if (!/^(?:[A-Za-z][A-Za-z0-9]*\.)+[A-Za-z][A-Za-z0-9]*$/.test(appId)) throw new Error(`${label} must be a reverse-DNS identifier.`);
  return appId;
}

export function validateMarketingVersion(value) {
  const version = String(value ?? "").trim();
  if (!/^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){2}$/.test(version)) throw new Error("Mobile marketing version must contain three numeric components.");
  return version;
}

export function validateBuildNumber(value) {
  const text = String(value ?? "").trim();
  if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(Number(text)) || Number(text) > 2_100_000_000) {
    throw new Error("Mobile build number must be a positive integer no greater than 2100000000.");
  }
  return text;
}

export function validatePublishedBuildSequence(buildNumber, lastPublishedBuildNumber) {
  const current = Number(validateBuildNumber(buildNumber));
  const previous = Number(lastPublishedBuildNumber);
  if (!Number.isSafeInteger(previous) || previous < 0 || previous > 2_100_000_000 || current <= previous) {
    throw new Error("Mobile build number must be greater than lastPublishedBuildNumber.");
  }
  return { current, previous };
}
