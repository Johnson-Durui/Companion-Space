import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";
import ts from "typescript";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PETS_ROOT = path.join(
  REPO_ROOT,
  "apps/web/public/assets/characters/pets",
);
const REGISTRY_PATH = path.join(
  REPO_ROOT,
  "apps/web/components/avatar/pet-registry.ts",
);
const RUNTIME_STYLE_PATH = path.join(
  REPO_ROOT,
  "apps/web/components/avatar/avatar-runtime.module.css",
);
const REQUIRED_EMOTIONS = ["neutral", "warm", "cheerful", "curious", "focused", "playful", "concerned"];
const ALLOWED_EMOTION_REACTIONS = ["calm", "soft", "wave", "lift", "attentive", "bounce", "failed"];

function requireNonEmptyString(value, label) {
  assert.equal(typeof value, "string", `${label} must be a string`);
  assert.notEqual(value.trim(), "", `${label} must not be empty`);
}

function requirePositiveInteger(value, label) {
  assert.ok(Number.isInteger(value) && value > 0, `${label} must be a positive integer`);
}

function unwrap(node) {
  while (
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isParenthesizedExpression(node)
  ) {
    node = node.expression;
  }
  return node;
}

function readStaticValue(input, sourceFile) {
  const node = unwrap(input);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.map((element) => readStaticValue(element, sourceFile));
  }
  if (ts.isObjectLiteralExpression(node)) {
    return Object.fromEntries(
      node.properties.map((property) => {
        assert.ok(
          ts.isPropertyAssignment(property),
          `unsupported registry syntax: ${property.getText(sourceFile)}`,
        );
        const name = property.name;
        assert.ok(
          ts.isIdentifier(name) || ts.isStringLiteral(name),
          `unsupported registry key: ${name.getText(sourceFile)}`,
        );
        return [name.text, readStaticValue(property.initializer, sourceFile)];
      }),
    );
  }
  assert.fail(`unsupported registry value: ${node.getText(sourceFile)}`);
}

export async function readPetRegistry(registryPath = REGISTRY_PATH) {
  const source = await readFile(registryPath, "utf8");
  const sourceFile = ts.createSourceFile(
    registryPath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const declarations = new Map();
  let exportedDefinitions;

  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      declarations.set(declaration.name.text, declaration.initializer);
      if (
        declaration.name.text === "BUILTIN_PET_DEFINITIONS" &&
        statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
      ) exportedDefinitions = declaration.initializer;
    }
  }

  assert.ok(exportedDefinitions, "pet registry must export BUILTIN_PET_DEFINITIONS");
  const array = unwrap(exportedDefinitions);
  assert.ok(
    ts.isArrayLiteralExpression(array),
    "BUILTIN_PET_DEFINITIONS must be a static array",
  );
  const definitions = array.elements.map((element) => {
    const member = unwrap(element);
    if (!ts.isIdentifier(member)) return readStaticValue(member, sourceFile);
    const initializer = declarations.get(member.text);
    assert.ok(initializer, `unknown pet definition: ${member.text}`);
    return readStaticValue(initializer, sourceFile);
  });
  assert.ok(definitions.length > 0, "pet registry contains no static pet definitions");
  return definitions;
}

export async function validatePetDirectory(petDir, registryDefinition) {
  const directoryId = path.basename(petDir);
  const manifestPath = path.join(petDir, "pet.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

  requireNonEmptyString(manifest.id, `${directoryId}.id`);
  assert.equal(manifest.id, directoryId, `${directoryId}.id must match its directory`);
  requireNonEmptyString(manifest.displayName, `${directoryId}.displayName`);
  requireNonEmptyString(manifest.description, `${directoryId}.description`);
  assert.equal(manifest.spriteVersionNumber, 2, `${directoryId} must use sprite schema v2`);
  requireNonEmptyString(manifest.spritesheetPath, `${directoryId}.spritesheetPath`);
  assert.equal(
    path.basename(manifest.spritesheetPath),
    manifest.spritesheetPath,
    `${directoryId}.spritesheetPath must be a local filename`,
  );
  assert.equal(path.extname(manifest.spritesheetPath), ".webp", `${directoryId} spritesheet must be WebP`);
  assert.match(
    manifest.spritesheetSha256,
    /^[a-f0-9]{64}$/,
    `${directoryId}.spritesheetSha256 must be lowercase SHA-256`,
  );

  const { atlas, provenance } = manifest;
  assert.ok(atlas && typeof atlas === "object", `${directoryId}.atlas is required`);
  for (const key of ["columns", "rows", "cellWidth", "cellHeight"]) {
    requirePositiveInteger(atlas[key], `${directoryId}.atlas.${key}`);
  }
  assert.ok(
    atlas.neutralLookFrame && typeof atlas.neutralLookFrame === "object",
    `${directoryId}.atlas.neutralLookFrame is required`,
  );
  assert.ok(
    Number.isInteger(atlas.neutralLookFrame.rowIndex) &&
      atlas.neutralLookFrame.rowIndex >= 0 &&
      atlas.neutralLookFrame.rowIndex < atlas.rows,
    `${directoryId}.atlas.neutralLookFrame.rowIndex is out of bounds`,
  );
  assert.ok(
    Number.isInteger(atlas.neutralLookFrame.columnIndex) &&
      atlas.neutralLookFrame.columnIndex >= 0 &&
      atlas.neutralLookFrame.columnIndex < atlas.columns,
    `${directoryId}.atlas.neutralLookFrame.columnIndex is out of bounds`,
  );
  assert.ok(provenance && typeof provenance === "object", `${directoryId}.provenance is required`);
  requireNonEmptyString(provenance.kind, `${directoryId}.provenance.kind`);
  requireNonEmptyString(provenance.generatedFor, `${directoryId}.provenance.generatedFor`);
  assert.equal(
    typeof provenance.thirdPartyCharacterOrTrademark,
    "boolean",
    `${directoryId}.provenance.thirdPartyCharacterOrTrademark must be boolean`,
  );

  const sheetPath = path.join(petDir, manifest.spritesheetPath);
  assert.ok((await stat(sheetPath)).isFile(), `${directoryId} spritesheet is not a file`);
  const sheetBytes = await readFile(sheetPath);
  assert.equal(
    createHash("sha256").update(sheetBytes).digest("hex"),
    manifest.spritesheetSha256,
    `${directoryId} spritesheet SHA-256 mismatch`,
  );

  const image = sharp(sheetBytes);
  assert.equal((await image.metadata()).format, "webp", `${directoryId} spritesheet content must be WebP`);
  const decoded = await image.raw().toBuffer({ resolveWithObject: true });
  assert.equal(decoded.info.width, atlas.columns * atlas.cellWidth, `${directoryId} decoded width mismatch`);
  assert.equal(decoded.info.height, atlas.rows * atlas.cellHeight, `${directoryId} decoded height mismatch`);

  assert.ok(registryDefinition, `${directoryId} is missing from the runtime registry`);
  assert.equal(registryDefinition.modelId, `${directoryId}_2d`, `${directoryId} registry modelId mismatch`);
  assert.ok(
    manifest.displayName.includes(registryDefinition.displayName),
    `${directoryId} registry displayName differs from the manifest`,
  );
  assert.equal(
    registryDefinition.assetUrl,
    `/assets/characters/pets/${directoryId}/${manifest.spritesheetPath}`,
    `${directoryId} registry assetUrl mismatch`,
  );
  assert.deepEqual(registryDefinition.atlas, {
    cellHeight: atlas.cellHeight,
    cellWidth: atlas.cellWidth,
    columns: atlas.columns,
    rows: atlas.rows,
  }, `${directoryId} registry atlas mismatch`);

  for (const [state, row] of Object.entries(registryDefinition.stateRows)) {
    assert.ok(Number.isInteger(row) && row >= 0 && row < atlas.rows, `${directoryId} ${state} row is out of bounds`);
    const frameCount = registryDefinition.stateFrameCounts[state];
    assert.ok(Number.isInteger(frameCount) && frameCount > 0 && frameCount <= atlas.columns, `${directoryId} ${state} frame count is invalid`);
  }
  requirePositiveInteger(registryDefinition.frameIntervalMs, `${directoryId} registry frameIntervalMs`);
  assert.equal(registryDefinition.gaze.directions, 16, `${directoryId} registry gaze must provide 16 directions`);
  assert.equal(
    registryDefinition.gaze.directions,
    registryDefinition.gaze.rows.length * registryDefinition.gaze.framesPerRow,
    `${directoryId} registry gaze layout mismatch`,
  );
  assert.equal(registryDefinition.gaze.clockwise, true, `${directoryId} registry gaze must be clockwise`);
  assert.equal(registryDefinition.gaze.zeroDirection, "up", `${directoryId} registry gaze zero direction mismatch`);
  for (const row of registryDefinition.gaze.rows) {
    assert.ok(Number.isInteger(row) && row >= 0 && row < atlas.rows, `${directoryId} gaze row is out of bounds`);
  }
  assert.deepEqual(
    Object.keys(registryDefinition.emotionReactions).sort(),
    [...REQUIRED_EMOTIONS].sort(),
    `${directoryId} registry must map every companion emotion`,
  );
  for (const [emotion, reaction] of Object.entries(registryDefinition.emotionReactions)) {
    assert.ok(ALLOWED_EMOTION_REACTIONS.includes(reaction), `${directoryId} ${emotion} reaction is invalid`);
  }
  assert.equal(
    new Set(Object.values(registryDefinition.emotionReactions)).size,
    REQUIRED_EMOTIONS.length,
    `${directoryId} registry emotion reactions must be visually distinct`,
  );
  assert.deepEqual(
    manifest.emotionReactions,
    registryDefinition.emotionReactions,
    `${directoryId} manifest emotion reactions differ from the runtime registry`,
  );
  assert.ok(Number.isInteger(registryDefinition.gesture.row) && registryDefinition.gesture.row >= 0 && registryDefinition.gesture.row < atlas.rows, `${directoryId} gesture row is out of bounds`);
  assert.ok(Number.isInteger(registryDefinition.gesture.frameCount) && registryDefinition.gesture.frameCount > 0 && registryDefinition.gesture.frameCount <= atlas.columns, `${directoryId} gesture frame count is invalid`);
  requirePositiveInteger(registryDefinition.gesture.durationMs, `${directoryId} registry gesture.durationMs`);

  return directoryId;
}

export async function validatePetAssets({ petsRoot = PETS_ROOT, registryPath = REGISTRY_PATH, runtimeStylePath = RUNTIME_STYLE_PATH } = {}) {
  const directories = (await readdir(petsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.ok(directories.length > 0, "no bundled pet directories found");

  const registry = await readPetRegistry(registryPath);
  const registryById = new Map(
    registry.map((definition) => [definition.modelId.replace(/_2d$/, ""), definition]),
  );
  assert.equal(registryById.size, registry.length, "pet registry contains duplicate model IDs");
  assert.deepEqual([...registryById.keys()].sort(), directories, "pet directories and registry entries differ");

  for (const directory of directories) {
    await validatePetDirectory(path.join(petsRoot, directory), registryById.get(directory));
  }
  const runtimeStyles = await readFile(runtimeStylePath, "utf8");
  for (const reaction of ALLOWED_EMOTION_REACTIONS.filter((value) => value !== "calm")) {
    assert.ok(
      runtimeStyles.includes(`[data-expression="${reaction}"]`),
      `runtime CSS is missing the ${reaction} expression selector`,
    );
  }
  return directories;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pets = await validatePetAssets();
  console.log(`Pet asset integrity passed: ${pets.join(", ")}`);
}
