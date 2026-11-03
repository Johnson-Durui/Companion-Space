import { access, rm } from "node:fs/promises";
import { join } from "node:path";

import { resolveNextCli, resolveWebBuildDirectory, runChild } from "./server-launcher-lib.mjs";

const [mode, webPort, apiBaseUrl, wsBaseUrl] = process.argv.slice(2);
if (!["dev", "start"].includes(mode) || !webPort || !apiBaseUrl || !wsBaseUrl) {
  throw new Error("Usage: node start-web.mjs <dev|start> <web-port> <api-url> <ws-url>");
}

const repositoryRoot = process.cwd();
const buildDirectory = await resolveWebBuildDirectory(repositoryRoot);
if (mode === "dev") {
  await rm(buildDirectory, { recursive: true, force: true });
} else {
  await access(`${buildDirectory}/BUILD_ID`);
}
runChild(
  process.execPath,
  [resolveNextCli(repositoryRoot), mode, "--hostname", "127.0.0.1", "--port", webPort],
  {
    cwd: join(repositoryRoot, "apps", "web"),
    env: {
      ...process.env,
      NEXT_PUBLIC_API_BASE_URL: apiBaseUrl,
      NEXT_PUBLIC_REALTIME_WS_URL: wsBaseUrl,
      ...(mode === "dev" ? { NEXT_PUBLIC_E2E_AUDIO_HOOK: "1" } : {}),
    },
    stdio: "inherit",
  },
);
