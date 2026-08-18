import { defineConfig, devices } from "@playwright/test";

const WEB_PORT = 3100;
const API_PORT = 8100;
const baseURL = `http://127.0.0.1:${WEB_PORT}`;
const apiBaseURL = `http://127.0.0.1:${API_PORT}`;
const wsBaseURL = `ws://127.0.0.1:${API_PORT}/api/v1/sessions/:sessionId/realtime`;
const storageRoot = ".playwright/mock-storage";
const reuseExistingServer = process.env.PLAYWRIGHT_REUSE_SERVER === "1";
const useHeadlessBrowser = process.env.E2E_HEADED !== "1";
const browserChannel = process.env.E2E_BROWSER_CHANNEL;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        headless: useHeadlessBrowser,
        ...(browserChannel ? { channel: browserChannel } : {}),
      },
    },
  ],
  webServer: [
    {
      command: `bash tests/e2e/start-api.sh ${API_PORT} ${WEB_PORT} ${storageRoot}`,
      port: API_PORT,
      timeout: 120_000,
      reuseExistingServer,
    },
    {
      command: `bash tests/e2e/start-web.sh ${WEB_PORT} ${apiBaseURL} ${wsBaseURL}`,
      port: WEB_PORT,
      timeout: 120_000,
      reuseExistingServer,
    },
  ],
});
