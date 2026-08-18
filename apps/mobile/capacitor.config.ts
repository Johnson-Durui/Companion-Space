import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const releaseMetadata = JSON.parse(readFileSync(resolve(__dirname, "release.json"), "utf8")) as {
  appId: string;
  appName: string;
};

const allowHttpLocalhost = process.env.COMPANION_MOBILE_ALLOW_HTTP_LOCALHOST === "1";
const configuredOriginText = process.env.COMPANION_MOBILE_TRUSTED_ORIGINS?.trim();
if (!configuredOriginText) {
  throw new Error("COMPANION_MOBILE_TRUSTED_ORIGINS is required; mobile builds have no implicit server origin.");
}
const configuredOrigins = configuredOriginText
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean)
  .map((value) => new URL(value));

for (const url of configuredOrigins) {
  const localhost = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  const validProtocol = url.protocol === "https:" || (allowHttpLocalhost && localhost && url.protocol === "http:");
  const defaultPort = !url.port || (url.protocol === "https:" && url.port === "443");
  if (!validProtocol || !defaultPort || url.origin !== url.href.replace(/\/$/, "")) {
    throw new Error(`COMPANION_MOBILE_TRUSTED_ORIGINS contains an invalid origin: ${url.href}`);
  }
}

const config = {
  appId: releaseMetadata.appId,
  appName: releaseMetadata.appName,
  webDir: "dist",
  server: {
    hostname: "app.companion.local",
    androidScheme: "https",
    iosScheme: "capacitor",
    cleartext: false,
    allowNavigation: configuredOrigins.map((url) => url.hostname),
  },
};

export default config;
