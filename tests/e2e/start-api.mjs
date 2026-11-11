import { createWriteStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import {
  assertPort,
  findPython,
  monitorOwnedChild,
  prepareIsolatedStorage,
  spawnOwnedChild,
  terminateOwnedChild,
} from "./runtime.mjs";

const [apiPortValue, webPortValue, storageRoot] = process.argv.slice(2);
const apiPort = assertPort(apiPortValue, "API port");
const webPort = assertPort(webPortValue, "Web port");
const python = findPython();
const storagePath = await prepareIsolatedStorage(process.cwd(), storageRoot);
const apiLog = createWriteStream(path.join(storagePath, "api.log"), { flags: "a" });

const childEnvironment = {
  ...process.env,
  ALLOWED_ORIGINS: `http://127.0.0.1:${webPort}`,
  API_BASE_URL: `http://127.0.0.1:${apiPort}`,
  APP_BASE_URL: `http://127.0.0.1:${webPort}`,
  AUDIO_PERSIST_ENABLED: "false",
  BUILTIN_NEURAL_TTS_ENABLED:
    process.env.E2E_BUILTIN_NEURAL_TTS_ENABLED === "true" ? "true" : "false",
  OBJECT_STORAGE_PATH: storageRoot,
  PYTHONPATH: "services/api",
};

const child = spawnOwnedChild(python, [
  "-m", "uvicorn", "app.main:app",
  "--host", "127.0.0.1",
  "--port", String(apiPort),
], {
  env: childEnvironment,
  stdio: ["inherit", "pipe", "pipe"],
});
const logFailure = new Promise((_, reject) => {
  apiLog.once("error", reject);
});
const monitoredChild = monitorOwnedChild(child, logFailure);

try {
  await writeFile(path.join(storagePath, "api.pid"), `${child.pid}\n`);
  child.stdout.pipe(process.stdout);
  child.stdout.pipe(apiLog, { end: false });
  child.stderr.pipe(process.stderr);
  child.stderr.pipe(apiLog, { end: false });
  process.exitCode = await monitoredChild;
} catch (error) {
  await terminateOwnedChild(child);
  await monitoredChild.catch(() => {});
  throw error;
} finally {
  apiLog.end();
}
