import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "src");
const dist = resolve(root, "dist");
const allowHttpLocalhost = process.env.COMPANION_MOBILE_ALLOW_HTTP_LOCALHOST === "1";
const configuredOriginText = process.env.COMPANION_MOBILE_TRUSTED_ORIGINS?.trim();
if (!configuredOriginText) {
  throw new Error("COMPANION_MOBILE_TRUSTED_ORIGINS is required; production mobile builds have no implicit server origin.");
}
const trustedOrigins = configuredOriginText
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean)
  .map(normalizeBuildOrigin);

function normalizeBuildOrigin(value) {
  const url = new URL(value);
  const localhost = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  const validProtocol = url.protocol === "https:" || (allowHttpLocalhost && localhost && url.protocol === "http:");
  const defaultPort = !url.port || (url.protocol === "https:" && url.port === "443");
  if (!validProtocol || !defaultPort || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error(`Trusted mobile server must be an approved HTTPS origin (or explicit dev localhost HTTP): ${value}`);
  }
  return url.origin;
}

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await Promise.all([
  cp(resolve(source, "index.html"), resolve(dist, "index.html")),
  cp(resolve(source, "index.css"), resolve(dist, "index.css")),
]);

const sourceText = await import("node:fs/promises").then(({ readFile }) => readFile(resolve(source, "index.ts"), "utf8"));
const output = ts.transpileModule(sourceText, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  fileName: "index.ts",
  reportDiagnostics: true,
});
const errors = output.diagnostics?.filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error) ?? [];
if (errors.length) throw new Error(ts.formatDiagnostics(errors, { getCanonicalFileName: (name) => name, getCurrentDirectory: () => root, getNewLine: () => "\n" }));

await writeFile(resolve(dist, "index.js"), output.outputText, "utf8");
await writeFile(
  resolve(dist, "runtime-config.js"),
  `globalThis.__COMPANION_TRUSTED_ORIGINS__=${JSON.stringify(trustedOrigins)};globalThis.__COMPANION_ALLOW_HTTP_LOCALHOST__=${allowHttpLocalhost};\n`,
  "utf8",
);
console.log(`mobile launcher built for ${trustedOrigins.join(", ")}`);
