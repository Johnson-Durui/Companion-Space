import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";

const port = process.env.E2E_API_PORT ?? "8731";
const baseURL = `http://127.0.0.1:${port}`;
const venv = process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python";
const python = existsSync(venv) ? venv : "python";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "*.spec.ts",
  timeout: 45_000,
  workers: 1,
  use: { baseURL, viewport: { width: 1440, height: 900 }, browserName: "chromium", trace: "retain-on-failure" },
  webServer: {
    command: `"${python}" services/api/tests/e2e_server.py`,
    env: { PYTHONPATH: "services/api", E2E_API_PORT: port },
    url: `${baseURL}/healthz`,
    timeout: 60_000,
    reuseExistingServer: false,
  },
});
