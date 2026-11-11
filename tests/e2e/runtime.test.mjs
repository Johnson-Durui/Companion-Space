import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertPort,
  findPython,
  monitorOwnedChild,
  prepareIsolatedStorage,
  pythonCandidates,
  spawnOwnedChild,
  terminateOwnedChild,
} from "./runtime.mjs";

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function waitFor(check, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for process fixture");
}

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

test("accepts only an unambiguous TCP port", () => {
  assert.equal(assertPort("8100", "API port"), 8100);
  for (const value of ["0", "65536", "81x", " 8100", "8100 "]) {
    assert.throws(() => assertPort(value, "API port"), /API port/);
  }
});

test("prefers an explicit Python and otherwise stays project-local before PATH", () => {
  assert.deepEqual(pythonCandidates("C:/tools/python.exe", "win32"), ["C:/tools/python.exe"]);
  const previous = process.env.COMPANION_PYTHON;
  const legacy = process.env.COMPANION_E2E_PYTHON;
  process.env.COMPANION_E2E_PYTHON = "legacy/python";
  delete process.env.COMPANION_PYTHON;
  try {
    assert.deepEqual(pythonCandidates(), ["legacy/python"]);
    process.env.COMPANION_PYTHON = "preferred/python";
    assert.deepEqual(pythonCandidates(), ["preferred/python"]);
  } finally {
    if (previous === undefined) delete process.env.COMPANION_PYTHON;
    else process.env.COMPANION_PYTHON = previous;
    if (legacy === undefined) delete process.env.COMPANION_E2E_PYTHON;
    else process.env.COMPANION_E2E_PYTHON = legacy;
  }
  assert.deepEqual(pythonCandidates(null, "win32"), [
    path.resolve(".venv/Scripts/python.exe"),
    "python.exe",
  ]);
  assert.deepEqual(pythonCandidates(null, "linux"), [
    path.resolve(".venv/bin/python"),
    "python3",
    "python",
  ]);
});

test("rejects an invalid explicit Python before clearing storage", async (t) => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "companion-runtime-"));
  const storage = path.join(repoRoot, ".playwright", "launcher-preserve");
  await mkdir(storage, { recursive: true });
  await writeFile(path.join(storage, "sentinel.txt"), "keep", "utf8");
  t.after(() => rm(repoRoot, { force: true, recursive: true }));
  const result = spawnSync(
    process.execPath,
    [path.join(import.meta.dirname, "start-api.mjs"), "18110", "18111", ".playwright/launcher-preserve"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, COMPANION_PYTHON: path.join(repoRoot, "missing-python") },
      windowsHide: true,
      timeout: 5_000,
    },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No usable Python/);
  assert.equal(await readFile(path.join(storage, "sentinel.txt"), "utf8"), "keep");
});

test("web launcher keeps the source .next cache and passes runtime environment", async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), "companion-web-launcher-"));
  const webRoot = path.join(fixture, "apps", "web");
  const nextBin = path.join(fixture, "node_modules", "next", "dist", "bin", "next");
  await mkdir(path.join(webRoot, ".next"), { recursive: true });
  await mkdir(path.dirname(nextBin), { recursive: true });
  await writeFile(path.join(webRoot, ".next", "fixture-only.txt"), "keep", "utf8");
  await writeFile(nextBin, [
    "const http = require('node:http');",
    "const port = Number(process.argv[process.argv.indexOf('--port') + 1]);",
    "const payload = JSON.stringify({ cwd: process.cwd(), api: process.env.NEXT_PUBLIC_API_BASE_URL, ws: process.env.NEXT_PUBLIC_REALTIME_WS_URL, audio: process.env.NEXT_PUBLIC_E2E_AUDIO_HOOK, dist: process.env.NEXT_DIST_DIR });",
    "const server = http.createServer((_request, response) => response.end(payload));",
    "server.listen(port, '127.0.0.1');",
    "process.once('SIGTERM', () => server.close(() => process.exit(0)));",
  ].join("\n"), "utf8");
  const port = await unusedPort();
  const api = "http://127.0.0.1:19110";
  const ws = "ws://127.0.0.1:19110/api/v1/sessions/:sessionId/realtime";
  const launcher = spawnOwnedChild(
    process.execPath,
    [path.resolve("tests/e2e/start-web.mjs"), "dev", String(port), api, ws],
    { cwd: fixture, stdio: "ignore" },
  );
  t.after(async () => {
    await terminateOwnedChild(launcher, 500);
    await rm(fixture, { force: true, recursive: true });
  });
  let payload;
  await waitFor(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}`);
      payload = await response.json();
      return true;
    } catch {
      return false;
    }
  });
  assert.equal(payload.cwd, webRoot);
  assert.equal(payload.api, api);
  assert.equal(payload.ws, ws);
  assert.equal(payload.audio, "1");
  assert.equal(payload.dist, ".next-e2e");
  assert.equal(await readFile(path.join(webRoot, ".next", "fixture-only.txt"), "utf8"), "keep");
});

test("rejects an executable that is not Python even when it runs", () => {
  const previous = process.env.COMPANION_PYTHON;
  process.env.COMPANION_PYTHON = process.execPath;
  try {
    assert.throws(() => findPython(), /No usable Python/);
  } finally {
    if (previous === undefined) delete process.env.COMPANION_PYTHON;
    else process.env.COMPANION_PYTHON = previous;
  }
});

test("clears one named child under a real .playwright directory", async (t) => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "companion-runtime-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(repoRoot, { force: true, recursive: true });
  });
  await mkdir(path.join(repoRoot, ".playwright", "mock-storage"), { recursive: true });

  const result = await prepareIsolatedStorage(repoRoot, ".playwright/mock-storage");

  assert.equal(result, path.join(repoRoot, ".playwright", "mock-storage"));
});

test("rejects traversal, nested targets, the root, and linked storage", async (t) => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "companion-runtime-"));
  const outside = await mkdtemp(path.join(tmpdir(), "companion-outside-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(repoRoot, { force: true, recursive: true });
    await rm(outside, { force: true, recursive: true });
  });
  await mkdir(path.join(repoRoot, ".playwright"), { recursive: true });

  for (const unsafe of [
    ".playwright",
    ".playwright/../storage",
    ".playwright/a/b",
    "storage",
  ]) {
    await assert.rejects(() => prepareIsolatedStorage(repoRoot, unsafe), /one named child|isolated/);
  }

  const linkedTarget = path.join(repoRoot, ".playwright", "linked-storage");
  await symlink(outside, linkedTarget, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(
    () => prepareIsolatedStorage(repoRoot, ".playwright/linked-storage"),
    /link|reparse/i,
  );
});

test("terminates only the owned process tree and preserves an unrelated process", async (t) => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "companion-process-tree-"));
  const grandchildPidPath = path.join(fixtureRoot, "grandchild.pid");
  const sleeper = "setInterval(() => {}, 1_000)";
  const parentProgram = [
    "const { spawn } = require('node:child_process');",
    "const { writeFileSync } = require('node:fs');",
    `const child = spawn(process.execPath, ['-e', ${JSON.stringify(sleeper)}], { stdio: 'ignore' });`,
    `writeFileSync(${JSON.stringify(grandchildPidPath)}, String(child.pid));`,
    sleeper,
  ].join("\n");
  const owned = spawnOwnedChild(process.execPath, ["-e", parentProgram], { stdio: "ignore" });
  const unrelated = spawnOwnedChild(process.execPath, ["-e", sleeper], { stdio: "ignore" });
  let grandchildPid;
  t.after(async () => {
    await terminateOwnedChild(owned, 500);
    await terminateOwnedChild(unrelated, 500);
    const { rm } = await import("node:fs/promises");
    await rm(fixtureRoot, { force: true, recursive: true });
  });

  await waitFor(async () => {
    grandchildPid = Number(await readFile(grandchildPidPath, "utf8"));
    return Number.isInteger(grandchildPid) && processExists(grandchildPid);
  });
  assert.equal(processExists(unrelated.pid), true);

  await terminateOwnedChild(owned, 750);
  await waitFor(() => !processExists(grandchildPid));

  assert.equal(processExists(owned.pid), false);
  assert.equal(processExists(unrelated.pid), true, "an unrelated process must not be terminated");
});

test("a wrapper I/O failure terminates its owned child without touching another process", async (t) => {
  const sleeper = "setInterval(() => {}, 1_000)";
  const owned = spawnOwnedChild(process.execPath, ["-e", sleeper], { stdio: "ignore" });
  const unrelated = spawnOwnedChild(process.execPath, ["-e", sleeper], { stdio: "ignore" });
  t.after(async () => {
    await terminateOwnedChild(owned, 500);
    await terminateOwnedChild(unrelated, 500);
  });

  await assert.rejects(
    () => monitorOwnedChild(owned, Promise.reject(new Error("log write failed"))),
    /log write failed/,
  );
  await waitFor(() => !processExists(owned.pid));

  assert.equal(processExists(unrelated.pid), true, "an unrelated process must remain alive");
});
