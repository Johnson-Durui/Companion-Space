import path from "node:path";

import { assertPort, runChild } from "./runtime.mjs";

const [mode, webPortValue, apiBaseUrl, wsBaseUrl] = process.argv.slice(2);
if (mode !== "dev" && mode !== "production") {
  throw new Error("Web mode must be dev or production");
}
const webPort = assertPort(webPortValue, "Web port");
for (const [label, value, protocol] of [
  ["API base URL", apiBaseUrl, "http:"],
  ["WebSocket base URL", wsBaseUrl, "ws:"],
]) {
  const parsed = new URL(value);
  if (parsed.protocol !== protocol || parsed.hostname !== "127.0.0.1") {
    throw new Error(`${label} must use loopback ${protocol}`);
  }
}

const nextBin = path.resolve("node_modules/next/dist/bin/next");
const webRoot = path.resolve("apps/web");
const childEnvironment = {
  ...process.env,
  NEXT_PUBLIC_API_BASE_URL: apiBaseUrl,
  NEXT_PUBLIC_REALTIME_WS_URL: wsBaseUrl,
};
if (mode === "dev") {
  childEnvironment.NEXT_DIST_DIR = process.env.NEXT_DIST_DIR ?? ".next-e2e";
  childEnvironment.NEXT_PUBLIC_E2E_AUDIO_HOOK = "1";
}
const command = mode === "dev" ? "dev" : "start";
process.exitCode = await runChild(
  process.execPath,
  [nextBin, command, "--hostname", "127.0.0.1", "--port", String(webPort)],
  { cwd: webRoot, env: childEnvironment, stdio: "inherit" },
);
