import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  PAINTED_MODELS,
  buildGlb,
  inspectFaceBuffer,
  parseGlb,
  readAccessor,
  repairFaceBuffer,
} from "./repair-original-vrm-face.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modelRoot = path.join(repoRoot, "apps/web/public/assets/characters/models");
const expectedTargetIndices = Array.from({ length: 10 }, (_, index) => index);

function closeTo(actual, expected, tolerance, message) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: expected ${expected}, got ${actual}`);
}

test("painted VRMs keep FaceFront within the intended head-sized geometry", async () => {
  const manifest = JSON.parse(await readFile(path.join(modelRoot, "manifest.json"), "utf8"));
  for (const spec of PAINTED_MODELS) {
    const buffer = await readFile(path.join(modelRoot, spec.file));
    const face = inspectFaceBuffer(buffer, spec);
    closeTo(face.width, spec.width, 2e-6, `${spec.file} local width`);
    closeTo(face.height, spec.height, 2e-6, `${spec.file} local height`);
    closeTo(face.worldWidth, spec.width, 2e-6, `${spec.file} world width`);
    closeTo(face.worldHeight, spec.height, 2e-6, `${spec.file} world height`);
    closeTo(face.faceNodeDepth, spec.faceDepth, 2e-6, `${spec.file} face surface offset`);
    assert.ok(face.faceNodeDepth >= spec.headRadius + 0.0059, `${spec.file} face card is buried inside the head`);
    assert.ok(face.centralFaceClearance >= 0.0079, `${spec.file} eye/mouth region is hidden by hair (${face.centralFaceClearance})`);
    assert.ok(face.edgeFaceClearance <= -0.0055, `${spec.file} face edge does not recede behind hair (${face.edgeFaceClearance})`);
    assert.equal(face.uncoveredFaceVertices, 0, `${spec.file} has square card corners outside the hair/head silhouette`);
    assert.ok(face.aspectRatio > 0.85 && face.aspectRatio < 1.05, `${spec.file} local face/head ratio is ${face.aspectRatio}`);
    assert.ok(face.worldAspectRatio > 0.85 && face.worldAspectRatio < 1.05, `${spec.file} world face/head ratio is ${face.worldAspectRatio}`);
    assert.equal(face.vertexCount, 645);
    assert.ok(face.morphMagnitudes.every((magnitude) => magnitude > 0.003), `${spec.file} has an ineffective facial morph`);
    assert.deepEqual(face.boundTargetIndices, expectedTargetIndices, `${spec.file} expressions no longer bind every facial morph`);
    assert.ok(face.normalLengthRange[0] > 0.999 && face.normalLengthRange[1] < 1.001, `${spec.file} normals are not normalized`);
    assert.ok(face.clothBack < -0.03, `${spec.file} main garment no longer retains back coverage`);
    assert.ok(face.clothClearance >= 0.0119, `${spec.file} main garment remains behind the body by ${face.clothClearance}`);
    assert.ok(face.clothNormalLengthRange[0] > 0.999 && face.clothNormalLengthRange[1] < 1.001, `${spec.file} cloth normals are not normalized`);
    assert.ok(Number.isInteger(face.clothSkin), `${spec.file} main garment lost its skin binding`);
    const entry = manifest.models.find((model) => model.id === spec.id);
    assert.ok(entry, `${spec.file} manifest entry is missing`);
    assert.equal(entry.bytes, buffer.length, `${spec.file} manifest size is stale`);
    assert.equal(entry.sha256, createHash("sha256").update(buffer).digest("hex"), `${spec.file} manifest hash is stale`);
  }
});

test("painted VRM face repair is byte-idempotent", async () => {
  for (const spec of PAINTED_MODELS) {
    const buffer = await readFile(path.join(modelRoot, spec.file));
    const result = repairFaceBuffer(buffer, spec);
    assert.equal(result.changed, false, `${spec.file} still needs repair`);
    assert.deepEqual(result.buffer, buffer, `${spec.file} changed on an idempotent repair`);
  }
});

test("repair accepts a sparse morph accessor and rebuilds it as dense geometry", async () => {
  const spec = PAINTED_MODELS[0];
  const parsed = parseGlb(await readFile(path.join(modelRoot, spec.file)));
  const faceNode = parsed.json.nodes.find((node) => node.name === "FaceFront");
  const primitive = parsed.json.meshes[faceNode.mesh].primitives[0];
  const accessorIndex = primitive.targets[0].POSITION;
  const accessor = parsed.json.accessors[accessorIndex];
  const indexPadding = (4 - parsed.bin.length % 4) % 4;
  parsed.bin = Buffer.concat([parsed.bin, Buffer.alloc(indexPadding)]);
  const indexOffset = parsed.bin.length;
  const sparseIndex = Buffer.alloc(4);
  sparseIndex.writeUInt16LE(0, 0);
  parsed.bin = Buffer.concat([parsed.bin, sparseIndex]);
  const valueOffset = parsed.bin.length;
  const sparseValue = Buffer.alloc(12);
  sparseValue.writeFloatLE(0.1, 0);
  parsed.bin = Buffer.concat([parsed.bin, sparseValue]);
  const indexView = parsed.json.bufferViews.push({ buffer: 0, byteOffset: indexOffset, byteLength: 2 }) - 1;
  const valueView = parsed.json.bufferViews.push({ buffer: 0, byteOffset: valueOffset, byteLength: 12 }) - 1;
  delete accessor.bufferView;
  delete accessor.byteOffset;
  accessor.sparse = {
    count: 1,
    indices: { bufferView: indexView, componentType: 5123 },
    values: { bufferView: valueView },
  };
  const sparseBuffer = buildGlb(parsed);
  const sparseParsed = parseGlb(sparseBuffer);
  closeTo(readAccessor(sparseParsed.json, sparseParsed.bin, accessorIndex)[0], 0.1, 1e-6, "sparse morph value");

  const repaired = repairFaceBuffer(sparseBuffer, spec);
  assert.equal(repaired.changed, true);
  const repairedParsed = parseGlb(repaired.buffer);
  assert.equal(repairedParsed.json.accessors[accessorIndex].sparse, undefined);
  assert.equal(repairFaceBuffer(repaired.buffer, spec).changed, false);
});
