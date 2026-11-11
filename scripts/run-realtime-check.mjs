import path from "node:path";
import { runChild } from "../tests/e2e/runtime.mjs";

const mode = process.argv[2];
if (!["performance", "soak", "soak-smoke"].includes(mode)) {
  throw new Error("Choose performance, soak, or soak-smoke");
}
const root = path.resolve(import.meta.dirname, "..");
const env = { ...process.env };
const playwright = path.join(root, "node_modules/@playwright/test/cli.js");
let buildResult = 0;
let args;
if (mode === "performance") {
  env.E2E_REQUIRE_HARDWARE_RENDERING = "1";
  env.E2E_HEADED = "1";
  args = ["test", "tests/e2e/realtime-guardrails.spec.ts", "--project=chromium", "-g", "sustains 30 fps on hardware"];
} else {
  env.NEXT_PUBLIC_API_BASE_URL = "http://127.0.0.1:8200";
  env.NEXT_PUBLIC_REALTIME_WS_URL = "ws://127.0.0.1:8200/api/v1/sessions/:sessionId/realtime";
  env.NEXT_DIST_DIR = ".next-soak";
  env.E2E_RUN_SOAK = "1";
  env.E2E_SOAK_MINUTES = mode === "soak-smoke" ? "0.2" : "30";
  if (mode === "soak-smoke") {
    env.E2E_SOAK_SAMPLE_SECONDS = "2";
    env.E2E_SOAK_TURN_SECONDS = "3";
  }
  buildResult = await runChild(process.execPath, [path.join(root, "node_modules/next/dist/bin/next"), "build"], {
    cwd: path.join(root, "apps/web"), env, stdio: "inherit",
  });
  args = ["test", "--config=playwright.soak.config.ts"];
}
process.exitCode = buildResult || await runChild(process.execPath, [playwright, ...args], {
  cwd: root, env, stdio: "inherit",
});
