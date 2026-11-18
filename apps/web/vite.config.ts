import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const backend = `http://127.0.0.1:${process.env.COMPANION_API_PORT ?? "8000"}`;
const webRoot = dirname(fileURLToPath(import.meta.url));
const dependencyRoot = resolve(webRoot, "../../node_modules");
const vadAssets = [
  resolve(dependencyRoot, "@ricky0123/vad-web/dist/silero_vad_v5.onnx"),
  resolve(dependencyRoot, "@ricky0123/vad-web/dist/vad.worklet.bundle.min.js"),
  resolve(dependencyRoot, "onnxruntime-web/dist/ort-wasm-simd-threaded.mjs"),
  resolve(dependencyRoot, "onnxruntime-web/dist/ort-wasm-simd-threaded.wasm"),
];

function selfHostedVad(): Plugin {
  return {
    name: "self-hosted-vad",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const name = basename(new URL(request.url ?? "/", "http://localhost").pathname);
        const asset = vadAssets.find((candidate) => basename(candidate) === name);
        if (!asset || !request.url?.startsWith("/audio/vad/")) return next();
        const contentType = name.endsWith(".wasm")
          ? "application/wasm"
          : name.endsWith(".js") || name.endsWith(".mjs")
            ? "text/javascript"
            : "application/octet-stream";
        response.setHeader("Content-Type", contentType);
        response.end(readFileSync(asset));
      });
    },
    closeBundle() {
      const destination = resolve(webRoot, "dist/audio/vad");
      mkdirSync(destination, { recursive: true });
      for (const asset of vadAssets) copyFileSync(asset, resolve(destination, basename(asset)));
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), selfHostedVad()],
  server: {
    host: "127.0.0.1",
    proxy: {
      "/api": { target: backend, ws: true },
      "/static/avatars": { target: backend },
    },
  },
});
