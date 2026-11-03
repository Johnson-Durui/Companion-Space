import { constants, lstat, mkdir, realpath } from "node:fs/promises";
import { accessSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";

async function rejectLink(path, label) {
  try {
    if ((await lstat(path)).isSymbolicLink()) {
      throw new Error(`${label} must not be a symbolic link: ${path}`);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export async function resolveNamedPlaywrightStorage(repositoryRoot, storageRoot) {
  const normalized = storageRoot.replaceAll("\\", "/").replace(/^\.\//, "");
  const match = /^\.playwright\/([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(normalized);
  if (!match) {
    throw new Error("E2E storage must be one named child of .playwright");
  }
  const expectedRoot = join(resolve(repositoryRoot), ".playwright");
  await mkdir(expectedRoot, { recursive: true });
  await rejectLink(expectedRoot, ".playwright root");
  if ((await realpath(expectedRoot)) !== expectedRoot) {
    throw new Error(`.playwright root resolved outside the repository: ${expectedRoot}`);
  }
  const target = join(expectedRoot, match[1]);
  await rejectLink(target, "E2E storage child");
  return target;
}

export async function resolveWebBuildDirectory(repositoryRoot) {
  const webRoot = join(resolve(repositoryRoot), "apps", "web");
  await rejectLink(webRoot, "Web application directory");
  if ((await realpath(webRoot)) !== webRoot) {
    throw new Error(`Web application directory resolved outside the repository: ${webRoot}`);
  }
  const target = join(webRoot, ".next");
  await rejectLink(target, "Next.js build directory");
  return target;
}

function executableWorks(executable) {
  const result = spawnSync(executable, ["--version"], {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
  return !result.error && result.status === 0;
}

export async function resolvePython(repositoryRoot, environment = process.env) {
  const explicit = environment.COMPANION_E2E_PYTHON?.trim();
  if (explicit) {
    const candidate = resolve(repositoryRoot, explicit);
    if (!executableWorks(candidate)) {
      throw new Error(`COMPANION_E2E_PYTHON is not executable: ${candidate}`);
    }
    return candidate;
  }

  const localCandidates = process.platform === "win32"
    ? [join(repositoryRoot, ".venv", "Scripts", "python.exe")]
    : [join(repositoryRoot, ".venv", "bin", "python")];
  const pathNames = process.platform === "win32" ? ["python.exe", "python3.exe"] : ["python3", "python"];
  for (const candidate of [...localCandidates, ...pathNames]) {
    if (executableWorks(candidate)) return candidate;
  }
  throw new Error(
    `No usable Python found. Create the project .venv or set COMPANION_E2E_PYTHON. PATH entries: ${(environment.PATH ?? "").split(delimiter).length}`,
  );
}

export function resolveNextCli(repositoryRoot) {
  const candidate = join(repositoryRoot, "node_modules", "next", "dist", "bin", "next");
  accessSync(candidate, constants.R_OK);
  return candidate;
}

export function runChild(command, args, options = {}, onSpawn = undefined) {
  const child = spawn(command, args, { ...options, windowsHide: true });
  onSpawn?.(child);
  const forward = (signal) => {
    if (!child.killed) child.kill(signal);
  };
  const forwardInterrupt = () => forward("SIGINT");
  const forwardTermination = () => forward("SIGTERM");
  process.once("SIGINT", forwardInterrupt);
  process.once("SIGTERM", forwardTermination);
  child.once("error", (error) => {
    console.error(`Failed to start ${command}: ${error.message}`);
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    process.removeListener("SIGINT", forwardInterrupt);
    process.removeListener("SIGTERM", forwardTermination);
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
}
