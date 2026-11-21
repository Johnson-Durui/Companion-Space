import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const RUNTIME_VARS = new Set([
  "--speech-level",
  "--tvb-fade-ms",
]);

function collectCssFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      results.push(...collectCssFiles(full));
    } else if (entry.endsWith(".css")) {
      results.push(full);
    }
  }
  return results;
}

describe("stylesheet custom property definitions (I4 part 1)", () => {
  it("defines every CSS custom property referenced via var()", () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const files = [
      ...collectCssFiles(join(repoRoot, "apps/web/src")),
      ...collectCssFiles(join(repoRoot, "packages")),
    ];
    expect(files.length).toBeGreaterThan(0);

    const defined = new Set<string>(RUNTIME_VARS);
    const usages: Array<{ file: string; name: string }> = [];

    for (const file of files) {
      const css = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      for (const match of css.matchAll(/(--[a-zA-Z0-9_-]+)\s*:/g)) {
        defined.add(match[1]);
      }
      for (const match of css.matchAll(/var\(\s*(--[a-zA-Z0-9_-]+)/g)) {
        usages.push({ file: relative(repoRoot, file).replace(/\\/g, "/"), name: match[1] });
      }
    }

    const undefinedVars = usages.filter((usage) => !defined.has(usage.name));
    expect(undefinedVars).toEqual([]);
  });
});
