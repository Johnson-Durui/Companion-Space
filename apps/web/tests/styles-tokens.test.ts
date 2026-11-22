import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const RUNTIME_VARS = new Set([
  "--speech-level",
  "--tvb-fade-ms",
  "--transform-origin",
  "--anchor-width",
]);

const RETIRED_LEGACY_FILES = [
  "apps/web/src/styles/tokens.css",
  "apps/web/src/features/classroom/classroom.css",
  "apps/web/src/features/learner/setup.css",
  "apps/web/src/features/practice/practice.css",
  "apps/web/src/features/progress/progress.css",
  "apps/web/src/features/review/review.css",
];

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

function repoCssFiles() {
  const repoRoot = resolve(import.meta.dirname, "../../..");
  const files = [
    ...collectCssFiles(join(repoRoot, "apps/web/src")),
    ...collectCssFiles(join(repoRoot, "packages")),
  ];
  return files.map((file) => ({
    abs: file,
    rel: relative(repoRoot, file).replace(/\\/g, "/"),
    raw: readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, ""),
  }));
}

describe("stylesheet design-system invariants (I4 — U7 final closure)", () => {
  it("defines every CSS custom property referenced via var()", () => {
    const files = repoCssFiles();
    expect(files.length).toBeGreaterThan(0);

    const defined = new Set<string>(RUNTIME_VARS);
    const usages: Array<{ file: string; name: string }> = [];

    for (const { rel, raw } of files) {
      for (const match of raw.matchAll(/(--[a-zA-Z0-9_-]+)\s*:/g)) {
        defined.add(match[1]);
      }
      for (const match of raw.matchAll(/var\(\s*(--[a-zA-Z0-9_-]+)/g)) {
        usages.push({ file: rel, name: match[1] });
      }
    }

    const undefinedVars = usages.filter((usage) => !defined.has(usage.name));
    expect(undefinedVars).toEqual([]);
  });

  it("restricts hex color literals strictly to theme.css (legacy allowlist retired)", () => {
    const violations: Array<{ file: string; hex: string }> = [];
    for (const { rel, raw } of repoCssFiles()) {
      if (rel === "apps/web/src/styles/theme.css") continue;
      for (const match of raw.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
        violations.push({ file: rel, hex: match[0] });
      }
    }
    expect(violations).toEqual([]);
  });

  it("forbids transition: all and !important in product stylesheets", () => {
    const transitionAll: string[] = [];
    const importants: string[] = [];
    for (const { rel, raw } of repoCssFiles()) {
      if (/\btransition(?:-property)?\s*:\s*[^;]*\ball\b/i.test(raw)) {
        transitionAll.push(rel);
      }
      if (/!important\b/i.test(raw)) {
        importants.push(rel);
      }
    }
    expect(transitionAll).toEqual([]);
    expect(importants).toEqual([]);
  });

  it("retires @layer legacy and deletes all old global CSS files", () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    for (const rel of RETIRED_LEGACY_FILES) {
      expect(existsSync(join(repoRoot, rel)), `${rel} must be deleted in U7`).toBe(false);
    }

    for (const { rel, raw } of repoCssFiles()) {
      const trimmed = raw.trim();
      expect(raw, `${rel} must not reference @layer legacy`).not.toMatch(/@layer\s+legacy\b/);
      if (rel === "apps/web/src/styles/base.css") {
        expect(trimmed.startsWith("@layer base"), "base.css must start with @layer base").toBe(true);
      }
      if (rel === "apps/web/src/styles/theme.css") {
        expect(
          trimmed.startsWith("@layer theme, base, components, utilities;"),
          "theme.css must declare canonical layer order without legacy",
        ).toBe(true);
      }
    }
  });
});
