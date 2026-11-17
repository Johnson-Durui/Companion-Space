import path from "node:path";
import { fileURLToPath } from "node:url";

import { FlatCompat } from "@eslint/eslintrc";
import nextVitals from "eslint-config-next/core-web-vitals.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const compat = new FlatCompat({ baseDirectory: __dirname });

const config = [
  {
    ignores: [".next/**", ".next-*/**", "node_modules/**"],
  },
  ...compat.config(nextVitals),
];

export default config;
