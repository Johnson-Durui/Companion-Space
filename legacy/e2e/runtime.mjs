import { spawn, spawnSync } from "node:child_process";
import { lstat, mkdir, realpath, rm } from "node:fs/promises";
import path from "node:path";

const STORAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function assertPort(value, label) {
  if (!/^[0-9]+$/.test(value ?? "")) {
    throw new Error(`${label} must be an integer between 1 and 65535`);
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${label} must be an integer between 1 and 65535`);
  }
  return port;
}

export function pythonCandidates(
  explicit = process.env.COMPANION_PYTHON?.trim() || process.env.COMPANION_E2E_PYTHON?.trim(),
  platform = process.platform,
) {
  if (explicit) {
    return [explicit];
  }
  return platform === "win32"
    ? [path.resolve(".venv/Scripts/python.exe"), "python.exe"]
    : [path.resolve(".venv/bin/python"), "python3", "python"];
}

export function findPython() {
  const candidates = pythonCandidates();
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ["-c", "import sys; print(sys.executable)"], {
      encoding: "utf8",
      shell: false,
      windowsHide: true,
    });
    if (!probe.error && probe.status === 0) {
      return candidate;
    }
  }
  throw new Error(
    `No usable Python found. Create .venv or set COMPANION_PYTHON. Tried: ${candidates.join(", ")}`,
  );
}

async function optionalLstat(target) {
  try {
    return await lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function prepareIsolatedStorage(repoRoot, storageRoot) {
  const normalized = storageRoot?.replaceAll("\\", "/");
  const segments = normalized?.split("/") ?? [];
  if (
    segments.length !== 2
    || segments[0] !== ".playwright"
    || !STORAGE_NAME.test(segments[1] ?? "")
  ) {
    throw new Error("E2E storage must be one named child of the isolated .playwright directory");
  }

  const canonicalRepo = await realpath(repoRoot);
  const playwrightRoot = path.join(canonicalRepo, ".playwright");
  const rootStat = await optionalLstat(playwrightRoot);
  if (rootStat?.isSymbolicLink()) {
    throw new Error("Refusing to use a linked or reparse-point .playwright directory");
  }
  await mkdir(playwrightRoot, { recursive: true });
  if (await realpath(playwrightRoot) !== playwrightRoot) {
    throw new Error("Refusing to use a linked or reparse-point .playwright directory");
  }

  const storagePath = path.join(playwrightRoot, segments[1]);
  const storageStat = await optionalLstat(storagePath);
  if (storageStat?.isSymbolicLink()) {
    throw new Error("Refusing to clear linked or reparse-point E2E storage");
  }
  if (storageStat && await realpath(storagePath) !== storagePath) {
    throw new Error("Refusing to clear linked or reparse-point E2E storage");
  }

  await rm(storagePath, { force: true, recursive: true });
  await mkdir(storagePath);
  return storagePath;
}

export function spawnOwnedChild(command, args, options = {}) {
  return spawn(command, args, {
    ...options,
    detached: process.platform !== "win32",
    shell: false,
    windowsHide: true,
  });
}

function childHasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitForExit(child, timeoutMs) {
  if (childHasExited(child)) return true;
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.removeListener("exit", onExit);
      resolve(false);
    }, timeoutMs);
    timeout.unref?.();
    function onExit() {
      clearTimeout(timeout);
      resolve(true);
    }
    child.once("exit", onExit);
  });
}

export async function terminateOwnedChild(child, graceMs = 1_500) {
  if (!child?.pid || childHasExited(child)) return;
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T"], {
      encoding: "utf8",
      shell: false,
      windowsHide: true,
    });
    if (!await waitForExit(child, graceMs)) {
      spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        encoding: "utf8",
        shell: false,
        windowsHide: true,
      });
      await waitForExit(child, graceMs);
    }
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
  if (!await waitForExit(child, graceMs)) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
    await waitForExit(child, graceMs);
  }
}

export async function monitorOwnedChild(child, failurePromise) {
  let terminationRequested = false;
  const forward = () => {
    terminationRequested = true;
    void terminateOwnedChild(child);
  };
  process.once("SIGINT", forward);
  process.once("SIGTERM", forward);
  const childResult = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  try {
    const result = await (failurePromise
      ? Promise.race([childResult, failurePromise])
      : childResult);
    return terminationRequested ? 1 : result.code ?? 1;
  } catch (error) {
    await terminateOwnedChild(child);
    throw error;
  } finally {
    process.removeListener("SIGINT", forward);
    process.removeListener("SIGTERM", forward);
  }
}

export async function runChild(command, args, options = {}) {
  return monitorOwnedChild(spawnOwnedChild(command, args, options));
}
