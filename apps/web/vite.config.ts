import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const backend = `http://127.0.0.1:${process.env.COMPANION_API_PORT ?? "8000"}`;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: "127.0.0.1",
    proxy: {
      "/api": { target: backend, ws: true },
      "/static/avatars": { target: backend },
    },
  },
});
