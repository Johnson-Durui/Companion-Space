import { defineConfig, devices } from "@playwright/test";

const WEB_PORT = 3200;
const API_PORT = 8200;
const baseURL = `http://127.0.0.1:${WEB_PORT}`;
const apiBaseURL = `http://127.0.0.1:${API_PORT}`;
const wsBaseURL = `ws://127.0.0.1:${API_PORT}/api/v1/sessions/:sessionId/realtime`;
const storageRoot = ".playwright/soak-storage";
const gracefulShutdown = { signal: "SIGTERM", timeout: 5_000 } as const;

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "realtime-soak.spec.ts",
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report/soak" }]],
  outputDir: "test-results/realtime-soak",
  timeout: 35 * 60 * 1_000,
  expect: {
    timeout: 30_000,
  },
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [
    {
      name: "chromium-soak",
      use: {
        ...devices["Desktop Chrome"],
        headless: true,
        ...(process.env.E2E_BROWSER_CHANNEL ? { channel: process.env.E2E_BROWSER_CHANNEL } : {}),
      },
    },
  ],
  webServer: [
    {
      command: `node tests/e2e/start-api.mjs ${API_PORT} ${WEB_PORT} ${storageRoot}`,
      port: API_PORT,
      timeout: 120_000,
      gracefulShutdown,
      reuseExistingServer: false,
    },
    {
      command: `node tests/e2e/start-web.mjs production ${WEB_PORT} ${apiBaseURL} ${wsBaseURL}`,
      port: WEB_PORT,
      timeout: 120_000,
      gracefulShutdown,
      reuseExistingServer: false,
    },
  ],
});
