import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");
const startupScript = path.join(repoRoot, "START-LOCAL-WINDOWS.ps1");

async function listen(handler) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server;
}

function portOf(server) {
  const address = server.address();
  assert(address && typeof address !== "string");
  return address.port;
}

async function close(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function runStartup(apiPort, webPort, { env = process.env, production = false } = {}) {
  const args = [
    "-NoLogo", "-NoProfile", "-NonInteractive",
    "-File", startupScript,
    "-ApiPort", String(apiPort),
    "-WebPort", String(webPort),
  ];
  if (production) {
    args.push("-Production");
  }
  const child = spawn("pwsh.exe", [
    ...args,
  ], {
    cwd: repoRoot,
    env,
    shell: false,
    windowsHide: true,
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  return { code, output };
}

async function unusedPort() {
  const server = await listen((_request, response) => response.end());
  const port = portOf(server);
  await close(server);
  return port;
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

async function waitForProcessExit(pid, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processExists(pid)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`process ${pid} was still running after ${timeoutMs}ms`);
}

async function canConnect(port) {
  return await new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (connected) => {
      socket.destroy();
      resolve(connected);
    };
    socket.setTimeout(500, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function waitForPortClosed(port, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!await canConnect(port)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`port ${port} was still accepting connections after ${timeoutMs}ms`);
}

async function withFakePair(t, apiHandler) {
  const api = await listen(apiHandler);
  const web = await listen((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("ready");
  });
  t.after(async () => {
    await close(api);
    await close(web);
  });
  return { api, web };
}

test("rejects an unrelated HTTP 200 service on the API port", async (t) => {
  const { api, web } = await withFakePair(t, (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"service":"other"}');
  });

  const result = await runStartup(portOf(api), portOf(web));

  assert.notEqual(result.code, 0);
  assert.match(result.output, /not a compatible Companion API/);
  assert.equal(api.listening, true);
  assert.equal(web.listening, true);
});

test("rejects a Companion-shaped API that disallows this browser origin", async (t) => {
  const { api, web } = await withFakePair(t, (request, response) => {
    if (request.method === "OPTIONS") {
      response.writeHead(200, { "access-control-allow-origin": "http://127.0.0.1:1" });
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"ok":true}');
  });

  const result = await runStartup(portOf(api), portOf(web));

  assert.notEqual(result.code, 0);
  assert.match(result.output, /does not allow browser origin/);
  assert.equal(api.listening, true);
});

test("reuses a compatible API without stopping either existing service", async (t) => {
  let allowedOrigin = "";
  const { api, web } = await withFakePair(t, (request, response) => {
    if (request.method === "OPTIONS") {
      response.writeHead(200, {
        "access-control-allow-origin": allowedOrigin,
        "access-control-allow-methods": "GET",
      });
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"ok":true}');
  });
  allowedOrigin = `http://127.0.0.1:${portOf(web)}`;

  const result = await runStartup(portOf(api), portOf(web));

  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /API already healthy/);
  assert.equal(api.listening, true);
  assert.equal(web.listening, true);
});

test("cleans up the API process tree when the production Web build fails", async (t) => {
  const apiPort = await unusedPort();
  const webPort = await unusedPort();
  const sentinel = await listen((_request, response) => response.end("unrelated"));
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "companion-startup-failure-"));
  const listenerPidFile = path.join(fixtureDir, "api-listener.pid");
  const fakeNpm = path.join(fixtureDir, "npm.cmd");
  const failBuild = path.join(fixtureDir, "fail-build.mjs");
  let listenerPid = 0;

  await writeFile(fakeNpm, `@echo off\r\n"${process.execPath}" "%~dp0fail-build.mjs"\r\nexit /b %errorlevel%\r\n`);
  await writeFile(failBuild, `
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";

const port = Number(process.env.TEST_API_PORT);
const deadline = Date.now() + 20_000;
while (Date.now() < deadline) {
  try {
    const response = await fetch(\`http://127.0.0.1:\${port}/healthz\`);
    if (response.ok) break;
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 100));
}
const lines = execFileSync("netstat.exe", ["-ano", "-p", "tcp"], { encoding: "utf8" }).split(/\\r?\\n/);
const listener = lines.find((line) => line.includes(\`127.0.0.1:\${port}\`) && /\\sLISTENING\\s+\\d+\\s*$/i.test(line));
if (!listener) throw new Error(\`API did not listen on port \${port}\`);
const pid = listener.trim().split(/\\s+/).at(-1);
await writeFile(process.env.TEST_API_LISTENER_PID_FILE, pid, "utf8");
process.exit(42);
`);

  t.after(async () => {
    if (listenerPid && processExists(listenerPid)) {
      process.kill(listenerPid, "SIGKILL");
      await waitForProcessExit(listenerPid);
    }
    await close(sentinel);
    await rm(fixtureDir, { recursive: true, force: true });
  });

  const python = process.env.COMPANION_PYTHON ?? "python.exe";
  const result = await runStartup(apiPort, webPort, {
    production: true,
    env: {
      ...process.env,
      COMPANION_PYTHON: python,
      OBJECT_STORAGE_PATH: path.join(fixtureDir, "storage"),
      PATH: `${fixtureDir}${path.delimiter}${process.env.PATH ?? ""}`,
      TEST_API_PORT: String(apiPort),
      TEST_API_LISTENER_PID_FILE: listenerPidFile,
    },
  });

  assert.notEqual(result.code, 0);
  assert.match(result.output, /Production Web build failed with exit code 42/);
  listenerPid = Number((await readFile(listenerPidFile, "utf8")).trim());
  assert(Number.isSafeInteger(listenerPid) && listenerPid > 0);
  await waitForProcessExit(listenerPid);
  await waitForPortClosed(apiPort);
  assert.equal(sentinel.listening, true, "cleanup must preserve an unrelated existing service");
});
