import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const batch = readFileSync("start.bat");
const launcher = readFileSync("start.ps1");
assert(launcher.every((byte) => byte < 128), "start.ps1 must be ASCII");
assert(batch.every((byte) => byte < 128), "start.bat must be ASCII");
assert(!batch.toString().replaceAll("\r\n", "").includes("\n"), "start.bat must use CRLF");

if (process.platform === "win32") {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject).listen(0, "127.0.0.1", resolve);
  });
  const { port } = probe.address();
  const closePortProbe = () => new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));

  const tempRoot = realpathSync(tmpdir());
  const testData = mkdtempSync(join(tempRoot, "companion-m1-start-"));
  const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "start.ps1", "-NoBrowser", "-Port", String(port)];
  const env = { ...process.env, COMPANION_DATA_DIR: testData };
  let proc;
  try {
    await assert.rejects(promisify(execFile)("powershell.exe", args, { env, windowsHide: true, timeout: 120_000 }), { code: 1 });
    assert(!existsSync(join(testData, "companion.db")), "Occupied port must be rejected before application startup");
    await closePortProbe();

    proc = spawn("powershell.exe", args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let output = "";
    let failure;
    proc.once("error", (error) => { failure = error; });
    proc.stdout.on("data", (data) => { output += data; });
    proc.stderr.on("data", (data) => { output += data; });
    const url = "http://127.0.0.1:" + port;
    const deadline = performance.now() + 120_000;
    let health;
    while (performance.now() < deadline && proc.exitCode === null && !failure) {
      try {
        const response = await fetch(url + "/healthz", { signal: AbortSignal.timeout(1000) });
        if (response.ok) { health = await response.json(); break; }
      } catch {
        await delay(250);
      }
    }
    if (failure) throw failure;
    assert.equal(health?.ok, true, output);
    const page = await fetch(url + "/welcome", { signal: AbortSignal.timeout(3000) });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /id="root"/);
    console.log("Windows launch smoke served /healthz and the single-process SPA.");
  } finally {
    try {
      if (probe.listening) await closePortProbe();
      if (proc?.pid && proc.exitCode === null) {
        execFileSync("taskkill.exe", ["/pid", String(proc.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
      }
    } finally {
      const resolved = realpathSync(testData);
      assert.equal(dirname(resolved), tempRoot);
      assert(basename(resolved).startsWith("companion-m1-start-"));
      rmSync(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
    }
  }
}
