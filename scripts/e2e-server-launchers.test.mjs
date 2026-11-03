import assert from "node:assert/strict";
import { lstat, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { test } from "node:test";
import { join } from "node:path";

import {
  resolveNamedPlaywrightStorage,
  resolvePython,
  resolveWebBuildDirectory,
} from "../tests/e2e/server-launcher-lib.mjs";

const repositoryRoot = process.cwd();

async function nextCacheIdentity() {
  try {
    const details = await lstat(join(repositoryRoot, "apps", "web", ".next"));
    return { dev: details.dev, ino: details.ino };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
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

test("accepts only one named child below the real .playwright directory", async () => {
  assert.equal(
    await resolveNamedPlaywrightStorage(repositoryRoot, ".playwright/launcher-test"),
    join(repositoryRoot, ".playwright", "launcher-test"),
  );
  await assert.rejects(
    resolveNamedPlaywrightStorage(repositoryRoot, ".playwright"),
    /one named child/,
  );
  await assert.rejects(
    resolveNamedPlaywrightStorage(repositoryRoot, ".playwright/../storage"),
    /one named child/,
  );
});

test("rejects a symlinked storage child before cleanup", async () => {
  const outside = join(repositoryRoot, ".launcher-test-outside");
  const link = join(repositoryRoot, ".playwright", "launcher-test-link");
  await mkdir(outside, { recursive: true });
  await symlink(outside, link, "junction");
  try {
    await assert.rejects(
      resolveNamedPlaywrightStorage(repositoryRoot, ".playwright/launcher-test-link"),
      /symbolic link/,
    );
  } finally {
    await rm(link, { force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("web cleanup resolves only to the repository Next cache", async () => {
  assert.equal(
    await resolveWebBuildDirectory(repositoryRoot),
    join(repositoryRoot, "apps", "web", ".next"),
  );
});

test("an invalid explicit Python path fails without fallback", async () => {
  await assert.rejects(
    resolvePython(repositoryRoot, { COMPANION_E2E_PYTHON: "missing/python" }),
    /COMPANION_E2E_PYTHON/,
  );
});

test("an invalid explicit Python path fails before storage cleanup", async () => {
  const storage = join(repositoryRoot, ".playwright", "launcher-preserve");
  const sentinel = join(storage, "sentinel.txt");
  await mkdir(storage, { recursive: true });
  await writeFile(sentinel, "keep", "utf8");
  try {
    const result = spawnSync(
      process.execPath,
      ["tests/e2e/start-api.mjs", "18110", "18111", ".playwright/launcher-preserve"],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: { ...process.env, COMPANION_E2E_PYTHON: "missing/python" },
        windowsHide: true,
      },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /COMPANION_E2E_PYTHON/);
    assert.equal(await readFile(sentinel, "utf8"), "keep");
  } finally {
    await rm(storage, { recursive: true, force: true });
  }
});

test("web launcher starts Next from the app directory with the requested runtime environment", async () => {
  const fixture = await resolveNamedPlaywrightStorage(repositoryRoot, ".playwright/launcher-web-fixture");
  const nextCli = join(fixture, "node_modules", "next", "dist", "bin", "next");
  const fixtureWebRoot = join(fixture, "apps", "web");
  const actualCacheBefore = await nextCacheIdentity();
  await rm(fixture, { recursive: true, force: true });
  await mkdir(join(fixtureWebRoot, ".next"), { recursive: true });
  await mkdir(join(fixture, "node_modules", "next", "dist", "bin"), { recursive: true });
  await writeFile(join(fixtureWebRoot, ".next", "fixture-only.txt"), "delete me", "utf8");
  await writeFile(nextCli, [
    "const http = require('node:http');",
    "const port = Number(process.argv[process.argv.indexOf('--port') + 1]);",
    "const payload = JSON.stringify({ cwd: process.cwd(), api: process.env.NEXT_PUBLIC_API_BASE_URL, ws: process.env.NEXT_PUBLIC_REALTIME_WS_URL, audio: process.env.NEXT_PUBLIC_E2E_AUDIO_HOOK, argv: process.argv.slice(2) });",
    "const server = http.createServer((_request, response) => response.end(payload));",
    "server.listen(port, '127.0.0.1');",
    "process.once('SIGTERM', () => server.close(() => process.exit(0)));",
    "process.once('SIGINT', () => server.close(() => process.exit(0)));",
  ].join("\n"), "utf8");

  const port = await unusedPort();
  const api = "http://127.0.0.1:19110";
  const ws = "ws://127.0.0.1:19110/api/v1/sessions/:sessionId/realtime";
  const launcher = spawn(
    process.execPath,
    [join(repositoryRoot, "tests", "e2e", "start-web.mjs"), "dev", String(port), api, ws],
    { cwd: fixture, stdio: "pipe", windowsHide: true },
  );
  const exited = new Promise((resolve) => launcher.once("exit", (code, signal) => resolve({ code, signal })));
  try {
    let payload;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}`);
        payload = await response.json();
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    assert.ok(payload, "fake Next CLI did not start");
    assert.equal(payload.cwd, fixtureWebRoot);
    assert.equal(payload.api, api);
    assert.equal(payload.ws, ws);
    assert.equal(payload.audio, "1");
    assert.deepEqual(payload.argv, ["dev", "--hostname", "127.0.0.1", "--port", String(port)]);
    await assert.rejects(readFile(join(fixtureWebRoot, ".next", "fixture-only.txt"), "utf8"), /ENOENT/);
    assert.deepEqual(await nextCacheIdentity(), actualCacheBefore);
  } finally {
    if (launcher.exitCode === null && launcher.signalCode === null) launcher.kill("SIGTERM");
    const exitResult = await exited;
    assert.ok(exitResult.code === 0 || exitResult.signal === "SIGTERM", `unexpected launcher exit: ${JSON.stringify(exitResult)}`);
    await assert.rejects(fetch(`http://127.0.0.1:${port}`));
    const safeFixture = await resolveNamedPlaywrightStorage(repositoryRoot, ".playwright/launcher-web-fixture");
    assert.equal(safeFixture, fixture);
    await rm(safeFixture, { recursive: true, force: true });
  }
});
