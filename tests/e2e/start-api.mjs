import { openSync, writeFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";

import { resolveNamedPlaywrightStorage, resolvePython, runChild } from "./server-launcher-lib.mjs";

const [apiPort, webPort, storageRoot, mode = "test"] = process.argv.slice(2);
if (!apiPort || !webPort || !storageRoot || !["test", "soak"].includes(mode)) {
  throw new Error("Usage: node start-api.mjs <api-port> <web-port> <.playwright/name> [test|soak]");
}

const repositoryRoot = process.cwd();
const python = await resolvePython(repositoryRoot);
const storagePath = await resolveNamedPlaywrightStorage(repositoryRoot, storageRoot);
await rm(storagePath, { recursive: true, force: true });
await mkdir(storagePath, { recursive: true });
const environment = {
  ...process.env,
  PYTHONPATH: "services/api",
  OBJECT_STORAGE_PATH: storageRoot,
  APP_BASE_URL: `http://127.0.0.1:${webPort}`,
  API_BASE_URL: `http://127.0.0.1:${apiPort}`,
  ALLOWED_ORIGINS: `http://127.0.0.1:${webPort}`,
  ...(mode === "soak" ? { AUDIO_PERSIST_ENABLED: "false" } : {}),
};
const log = mode === "soak" ? openSync(`${storagePath}/api.log`, "a") : "inherit";
runChild(
  python,
  ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", apiPort],
  { cwd: repositoryRoot, env: environment, stdio: ["inherit", log, log] },
  (child) => {
    if (mode === "soak") writeFileSync(`${storagePath}/api.pid`, `${child.pid}\n`, "utf8");
  },
);
