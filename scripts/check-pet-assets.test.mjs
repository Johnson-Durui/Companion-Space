import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { validatePetAssets, validatePetDirectory } from "./check-pet-assets.mjs";

const SOURCE_DIR = path.resolve("apps/web/public/assets/characters/pets/mori");
const REGISTRY_PATH = path.resolve("apps/web/components/avatar/pet-registry.ts");
const REGISTRY = {
  assetUrl: "/assets/characters/pets/mori/spritesheet.webp",
  atlas: { cellHeight: 208, cellWidth: 192, columns: 8, rows: 11 },
  displayName: "Mori",
  emotionReactions: {
    neutral: "calm",
    warm: "soft",
    cheerful: "wave",
    curious: "lift",
    focused: "attentive",
    playful: "bounce",
    concerned: "failed",
  },
  frameIntervalMs: 160,
  gaze: { clockwise: true, directions: 16, framesPerRow: 8, rows: [9, 10], zeroDirection: "up" },
  gesture: { durationMs: 700, frameCount: 5, row: 4 },
  modelId: "mori_2d",
  stateFrameCounts: { idle: 6, listening: 6, speaking: 6, thinking: 6 },
  stateRows: { idle: 0, listening: 6, speaking: 8, thinking: 7 },
};

async function fixture(mutator, directory = "mori") {
  const root = await mkdtemp(path.join(tmpdir(), "pet-integrity-"));
  const petDir = path.join(root, directory);
  await cp(SOURCE_DIR, petDir, { recursive: true });
  const manifestPath = path.join(petDir, "pet.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  await mutator(manifest, petDir);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { petDir, root };
}

async function rejectsFixture(mutator, pattern, directory) {
  const { petDir, root } = await fixture(mutator, directory);
  try {
    await assert.rejects(() => validatePetDirectory(petDir, REGISTRY), pattern);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

test("rejects a tampered spritesheet hash", async () => {
  await rejectsFixture((manifest) => {
    manifest.spritesheetSha256 = "0".repeat(64);
  }, /SHA-256 mismatch/);
});

test("rejects decoded dimensions that differ from the atlas", async () => {
  await rejectsFixture((manifest) => {
    manifest.atlas.cellWidth += 1;
  }, /decoded width mismatch/);
});

test("rejects a manifest id that differs from its directory", async () => {
  await rejectsFixture(async (manifest, petDir) => {
    manifest.id = "mori";
    const bytes = await readFile(path.join(petDir, manifest.spritesheetPath));
    manifest.spritesheetSha256 = createHash("sha256").update(bytes).digest("hex");
  }, /id must match its directory/, "wrong-directory");
});

test("rejects a runtime registry that omits companion emotions", async () => {
  const incompleteRegistry = {
    ...REGISTRY,
    emotionReactions: { concerned: "failed" },
  };
  await assert.rejects(
    () => validatePetDirectory(SOURCE_DIR, incompleteRegistry),
    /must map every companion emotion/,
  );
});

test("rejects a pet directory omitted from the exported runtime registry", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pet-registry-"));
  const registryPath = path.join(root, "pet-registry.ts");
  try {
    const source = await readFile(REGISTRY_PATH, "utf8");
    const withoutYuzu = source.replace(
      /export const BUILTIN_PET_DEFINITIONS = \[MORI_PET, YUZU_PET\]/,
      "export const BUILTIN_PET_DEFINITIONS = [MORI_PET]",
    );
    assert.notEqual(withoutYuzu, source, "test fixture must remove Yuzu from the export array");
    await writeFile(registryPath, withoutYuzu);
    await assert.rejects(
      () => validatePetAssets({ registryPath }),
      /pet directories and registry entries differ/,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
