#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;
const FLOAT = 5126;
const EXPECTED_TARGETS = [
  "happy",
  "relaxed",
  "surprised",
  "sad",
  "aa",
  "ih",
  "ou",
  "ee",
  "oh",
  "blink",
];

export const PAINTED_MODELS = Object.freeze([
  { id: "mira", file: "Mira.vrm", width: 0.172, height: 0.166, headRadius: 0.1034, faceDepth: 0.1094 },
  { id: "kite", file: "Kite.vrm", width: 0.172, height: 0.166, headRadius: 0.1034, faceDepth: 0.1094 },
  { id: "cael", file: "Cael.vrm", width: 0.154, height: 0.15, headRadius: 0.11, faceDepth: 0.116 },
  { id: "lyra", file: "Lyra.vrm", width: 0.172, height: 0.166, headRadius: 0.1034, faceDepth: 0.1094 },
]);

const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const COMPONENT_BYTES = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };

function componentReader(buffer, offset, componentType) {
  switch (componentType) {
    case 5120: return buffer.readInt8(offset);
    case 5121: return buffer.readUInt8(offset);
    case 5122: return buffer.readInt16LE(offset);
    case 5123: return buffer.readUInt16LE(offset);
    case 5125: return buffer.readUInt32LE(offset);
    case 5126: return buffer.readFloatLE(offset);
    default: throw new Error(`Unsupported glTF component type ${componentType}`);
  }
}

export function parseGlb(buffer) {
  assert.equal(buffer.readUInt32LE(0), GLB_MAGIC, "not a GLB/VRM file");
  assert.equal(buffer.readUInt32LE(4), 2, "only GLB 2 is supported");
  assert.equal(buffer.readUInt32LE(8), buffer.length, "GLB length header is invalid");
  const chunks = [];
  for (let offset = 12; offset < buffer.length;) {
    const length = buffer.readUInt32LE(offset);
    const type = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    chunks.push({ type, data: Buffer.from(buffer.subarray(start, start + length)) });
    offset = start + length;
  }
  const jsonIndex = chunks.findIndex((chunk) => chunk.type === JSON_CHUNK);
  const binIndex = chunks.findIndex((chunk) => chunk.type === BIN_CHUNK);
  assert.notEqual(jsonIndex, -1, "GLB JSON chunk is missing");
  assert.notEqual(binIndex, -1, "GLB BIN chunk is missing");
  const jsonText = chunks[jsonIndex].data.toString("utf8").replace(/[\u0000\u0020]+$/u, "");
  const json = JSON.parse(jsonText);
  const logicalLength = json.buffers?.[0]?.byteLength;
  assert.ok(Number.isInteger(logicalLength), "GLB buffer byteLength is missing");
  return {
    json,
    bin: Buffer.from(chunks[binIndex].data.subarray(0, logicalLength)),
    chunks,
    jsonIndex,
    binIndex,
  };
}

export function buildGlb(parsed) {
  parsed.json.buffers[0].byteLength = parsed.bin.length;
  let jsonData = Buffer.from(JSON.stringify(parsed.json), "utf8");
  jsonData = Buffer.concat([jsonData, Buffer.alloc((4 - jsonData.length % 4) % 4, 0x20)]);
  let binData = parsed.bin;
  binData = Buffer.concat([binData, Buffer.alloc((4 - binData.length % 4) % 4)]);
  const chunks = parsed.chunks.map((chunk, index) => {
    if (index === parsed.jsonIndex) return { type: JSON_CHUNK, data: jsonData };
    if (index === parsed.binIndex) return { type: BIN_CHUNK, data: binData };
    return chunk;
  });
  const length = 12 + chunks.reduce((sum, chunk) => sum + 8 + chunk.data.length, 0);
  const output = Buffer.alloc(length);
  output.writeUInt32LE(GLB_MAGIC, 0);
  output.writeUInt32LE(2, 4);
  output.writeUInt32LE(length, 8);
  let offset = 12;
  for (const chunk of chunks) {
    output.writeUInt32LE(chunk.data.length, offset);
    output.writeUInt32LE(chunk.type, offset + 4);
    chunk.data.copy(output, offset + 8);
    offset += 8 + chunk.data.length;
  }
  return output;
}

export function readAccessor(json, bin, accessorIndex) {
  const accessor = json.accessors[accessorIndex];
  assert.ok(accessor, `accessor ${accessorIndex} is missing`);
  const componentCount = COMPONENTS[accessor.type];
  const componentBytes = COMPONENT_BYTES[accessor.componentType];
  assert.ok(componentCount && componentBytes, `unsupported accessor ${accessorIndex}`);
  const values = new Float64Array(accessor.count * componentCount);
  if (accessor.bufferView !== undefined) {
    const view = json.bufferViews[accessor.bufferView];
    assert.equal(view.buffer ?? 0, 0, "only the primary GLB buffer is supported");
    const stride = view.byteStride ?? componentCount * componentBytes;
    const base = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
    for (let element = 0; element < accessor.count; element += 1) {
      for (let component = 0; component < componentCount; component += 1) {
        values[element * componentCount + component] = componentReader(
          bin,
          base + element * stride + component * componentBytes,
          accessor.componentType,
        );
      }
    }
  }
  if (accessor.sparse) {
    const sparse = accessor.sparse;
    const indexView = json.bufferViews[sparse.indices.bufferView];
    const valueView = json.bufferViews[sparse.values.bufferView];
    const indexBase = (indexView.byteOffset ?? 0) + (sparse.indices.byteOffset ?? 0);
    const valueBase = (valueView.byteOffset ?? 0) + (sparse.values.byteOffset ?? 0);
    const indexBytes = COMPONENT_BYTES[sparse.indices.componentType];
    for (let sparseIndex = 0; sparseIndex < sparse.count; sparseIndex += 1) {
      const element = componentReader(
        bin,
        indexBase + sparseIndex * indexBytes,
        sparse.indices.componentType,
      );
      for (let component = 0; component < componentCount; component += 1) {
        values[element * componentCount + component] = componentReader(
          bin,
          valueBase + (sparseIndex * componentCount + component) * componentBytes,
          accessor.componentType,
        );
      }
    }
  }
  return values;
}

function extrema(values, components) {
  const min = Array(components).fill(Infinity);
  const max = Array(components).fill(-Infinity);
  for (let index = 0; index < values.length; index += components) {
    for (let component = 0; component < components; component += 1) {
      min[component] = Math.min(min[component], values[index + component]);
      max[component] = Math.max(max[component], values[index + component]);
    }
  }
  return { min, max };
}

function appendVec3Accessor(parsed, accessorIndex, values, includeExtrema) {
  const padding = (4 - parsed.bin.length % 4) % 4;
  if (padding) parsed.bin = Buffer.concat([parsed.bin, Buffer.alloc(padding)]);
  const byteOffset = parsed.bin.length;
  const data = Buffer.alloc(values.length * 4);
  for (let index = 0; index < values.length; index += 1) data.writeFloatLE(values[index], index * 4);
  parsed.bin = Buffer.concat([parsed.bin, data]);
  const bufferView = parsed.json.bufferViews.push({
    buffer: 0,
    byteOffset,
    byteLength: data.length,
  }) - 1;
  const accessor = parsed.json.accessors[accessorIndex];
  accessor.bufferView = bufferView;
  accessor.byteOffset = 0;
  accessor.componentType = FLOAT;
  accessor.count = values.length / 3;
  accessor.type = "VEC3";
  delete accessor.sparse;
  delete accessor.normalized;
  if (includeExtrema) Object.assign(accessor, extrema(values, 3));
  else {
    delete accessor.min;
    delete accessor.max;
  }
}

function findFace(json) {
  const nodeIndex = json.nodes.findIndex((node) => node.name === "FaceFront");
  assert.notEqual(nodeIndex, -1, "FaceFront node is missing");
  const node = json.nodes[nodeIndex];
  assert.equal(node.skin, undefined, "FaceFront unexpectedly has a skin binding");
  assert.ok(Number.isInteger(node.mesh), "FaceFront mesh is missing");
  const mesh = json.meshes[node.mesh];
  assert.equal(mesh.primitives.length, 1, "FaceFront must have one primitive");
  const primitive = mesh.primitives[0];
  assert.ok(primitive.attributes?.POSITION !== undefined, "FaceFront POSITION is missing");
  assert.ok(primitive.attributes?.NORMAL !== undefined, "FaceFront NORMAL is missing");
  assert.ok(primitive.indices !== undefined, "FaceFront indices are missing");
  const targetNames = mesh.extras?.targetNames;
  assert.deepEqual(targetNames, EXPECTED_TARGETS, "FaceFront morph target order changed");
  assert.equal(primitive.targets?.length, EXPECTED_TARGETS.length, "FaceFront morph targets are missing");
  return { nodeIndex, node, mesh, primitive, targetNames };
}

function findMeshNode(json, name) {
  const nodeIndex = json.nodes.findIndex((node) => node.name === name);
  assert.notEqual(nodeIndex, -1, `${name} node is missing`);
  const node = json.nodes[nodeIndex];
  assert.ok(Number.isInteger(node.mesh), `${name} mesh is missing`);
  const mesh = json.meshes[node.mesh];
  assert.equal(mesh.primitives.length, 1, `${name} must have one primitive`);
  const primitive = mesh.primitives[0];
  assert.ok(primitive.attributes?.POSITION !== undefined, `${name} POSITION is missing`);
  assert.ok(primitive.attributes?.NORMAL !== undefined, `${name} NORMAL is missing`);
  assert.ok(primitive.indices !== undefined, `${name} indices are missing`);
  return { nodeIndex, node, mesh, primitive };
}

function projectedTriangles(json, bin, name) {
  const meshNode = findMeshNode(json, name);
  const positions = worldPositions(
    json,
    meshNode.nodeIndex,
    readAccessor(json, bin, meshNode.primitive.attributes.POSITION),
  );
  const indices = readAccessor(json, bin, meshNode.primitive.indices);
  const triangles = [];
  for (let index = 0; index < indices.length; index += 3) {
    const a = indices[index] * 3;
    const b = indices[index + 1] * 3;
    const c = indices[index + 2] * 3;
    triangles.push({
      a,
      b,
      c,
      maxX: Math.max(positions[a], positions[b], positions[c]),
      maxY: Math.max(positions[a + 1], positions[b + 1], positions[c + 1]),
      minX: Math.min(positions[a], positions[b], positions[c]),
      minY: Math.min(positions[a + 1], positions[b + 1], positions[c + 1]),
      positions,
    });
  }
  return triangles;
}

function projectedFront(x, y, triangleGroups) {
  let front = -Infinity;
  for (const triangles of triangleGroups) {
    for (const triangle of triangles) {
      if (x < triangle.minX || x > triangle.maxX || y < triangle.minY || y > triangle.maxY) continue;
      const { a, b, c, positions } = triangle;
      const ax = positions[a];
      const ay = positions[a + 1];
      const bx = positions[b];
      const by = positions[b + 1];
      const cx = positions[c];
      const cy = positions[c + 1];
      const denominator = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
      if (Math.abs(denominator) < 1e-12) continue;
      const weightA = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / denominator;
      const weightB = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / denominator;
      const weightC = 1 - weightA - weightB;
      if (weightA < -1e-6 || weightB < -1e-6 || weightC < -1e-6) continue;
      front = Math.max(
        front,
        weightA * positions[a + 2] + weightB * positions[b + 2] + weightC * positions[c + 2],
      );
    }
  }
  return front;
}

function smoothstep(edge0, edge1, value) {
  const normalized = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return normalized * normalized * (3 - 2 * normalized);
}

function correctedPositions(current, spec, json, bin, face) {
  const bounds = extrema(current, 3);
  const currentHeight = bounds.max[1] - bounds.min[1];
  const legacy = Math.abs(currentHeight - 1) < 0.002;
  const fixed = Math.abs(currentHeight - spec.height) < 0.002;
  assert.ok(legacy || fixed, `FaceFront height ${currentHeight} is neither legacy nor repaired`);
  const flat = new Float64Array(current.length);
  for (let index = 0; index < current.length; index += 3) {
    const x = current[index];
    const y = legacy ? current[index + 1] * spec.height : current[index + 1];
    flat[index] = x;
    flat[index + 1] = y;
  }
  const origin = worldPositions(json, face.nodeIndex, new Float64Array([0, 0, 0]));
  const occluders = [projectedTriangles(json, bin, "Hair"), projectedTriangles(json, bin, "BodySkin")];
  const output = new Float64Array(flat.length);
  for (let index = 0; index < flat.length; index += 3) {
    let x = flat[index];
    let y = flat[index + 1];
    let front = projectedFront(origin[0] + x, origin[1] + y, occluders);
    for (let attempt = 0; !Number.isFinite(front) && attempt < 20; attempt += 1) {
      x *= 0.97;
      y *= 0.97;
      front = projectedFront(origin[0] + x, origin[1] + y, occluders);
    }
    assert.ok(Number.isFinite(front), `FaceFront vertex ${index / 3} has no head or hair coverage`);
    const ellipseRadius = Math.hypot(x / (spec.width / 2), y / (spec.height / 2));
    const edgeBlend = smoothstep(0.72, 1.02, ellipseRadius);
    const clearance = 0.008 - 0.016 * edgeBlend;
    output[index] = x;
    output[index + 1] = y;
    output[index + 2] = front + clearance - origin[2];
  }
  return output;
}

function faceOcclusionMetrics(json, bin, face, positions, spec) {
  const origin = worldPositions(json, face.nodeIndex, new Float64Array([0, 0, 0]));
  const occluders = [projectedTriangles(json, bin, "Hair"), projectedTriangles(json, bin, "BodySkin")];
  const centralClearances = [];
  const edgeClearances = [];
  let uncoveredVertices = 0;
  for (let index = 0; index < positions.length; index += 3) {
    const x = positions[index];
    const y = positions[index + 1];
    const front = projectedFront(origin[0] + x, origin[1] + y, occluders);
    if (!Number.isFinite(front)) {
      uncoveredVertices += 1;
      continue;
    }
    const ellipseRadius = Math.hypot(x / (spec.width / 2), y / (spec.height / 2));
    const clearance = origin[2] + positions[index + 2] - front;
    if (ellipseRadius <= 0.7) centralClearances.push(clearance);
    if (ellipseRadius >= 0.98) edgeClearances.push(clearance);
  }
  assert.ok(centralClearances.length, "FaceFront central feature region is empty");
  assert.ok(edgeClearances.length, "FaceFront edge region is empty");
  return {
    centralClearance: Math.min(...centralClearances),
    edgeClearance: Math.max(...edgeClearances),
    uncoveredVertices,
  };
}

function calculateNormals(positions, indices) {
  const normals = new Float64Array(positions.length);
  for (let triangle = 0; triangle < indices.length; triangle += 3) {
    const ia = indices[triangle] * 3;
    const ib = indices[triangle + 1] * 3;
    const ic = indices[triangle + 2] * 3;
    const abx = positions[ib] - positions[ia];
    const aby = positions[ib + 1] - positions[ia + 1];
    const abz = positions[ib + 2] - positions[ia + 2];
    const acx = positions[ic] - positions[ia];
    const acy = positions[ic + 1] - positions[ia + 1];
    const acz = positions[ic + 2] - positions[ia + 2];
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    for (const vertex of [ia, ib, ic]) {
      normals[vertex] += nx;
      normals[vertex + 1] += ny;
      normals[vertex + 2] += nz;
    }
  }
  for (let index = 0; index < normals.length; index += 3) {
    const length = Math.hypot(normals[index], normals[index + 1], normals[index + 2]);
    assert.ok(length > 1e-10, `mesh has a degenerate normal at vertex ${index / 3}`);
    normals[index] /= length;
    normals[index + 1] /= length;
    normals[index + 2] /= length;
  }
  return normals;
}

function correctedClothGeometry(json, bin) {
  const body = findMeshNode(json, "BodySkin");
  const cloth = findMeshNode(json, "Cloth");
  assert.ok(Number.isInteger(body.node.skin), "BodySkin must remain skinned");
  assert.ok(Number.isInteger(cloth.node.skin), "Cloth must remain skinned");
  const bodyPositions = readAccessor(json, bin, body.primitive.attributes.POSITION);
  const currentPositions = readAccessor(json, bin, cloth.primitive.attributes.POSITION);
  const currentBounds = extrema(currentPositions, 3);
  let bodyFront = -Infinity;
  for (let index = 0; index < bodyPositions.length; index += 3) {
    const x = bodyPositions[index];
    const y = bodyPositions[index + 1];
    if (
      x >= currentBounds.min[0] && x <= currentBounds.max[0]
      && y >= currentBounds.min[1] && y <= currentBounds.max[1]
    ) {
      bodyFront = Math.max(bodyFront, bodyPositions[index + 2]);
    }
  }
  assert.ok(Number.isFinite(bodyFront), "Cloth does not overlap any BodySkin torso samples");
  const targetFront = bodyFront + 0.012;
  const currentBack = currentBounds.min[2];
  const currentFront = currentBounds.max[2];
  assert.ok(currentFront > currentBack + 1e-4, "Cloth has no depth");
  const depthScale = currentFront >= targetFront - 2e-6
    ? 1
    : (targetFront - currentBack) / (currentFront - currentBack);
  assert.ok(depthScale >= 1 && depthScale < 4, `Cloth depth repair scale ${depthScale} is unsafe`);
  const positions = new Float64Array(currentPositions.length);
  for (let index = 0; index < currentPositions.length; index += 3) {
    positions[index] = currentPositions[index];
    positions[index + 1] = currentPositions[index + 1];
    positions[index + 2] = currentBack + (currentPositions[index + 2] - currentBack) * depthScale;
  }
  const indices = readAccessor(json, bin, cloth.primitive.indices);
  assert.equal(indices.length % 3, 0, "Cloth indices are not triangles");
  return {
    body,
    cloth,
    bodyFront,
    targetFront,
    currentBack,
    currentFront,
    currentPositions,
    positions,
    normals: calculateNormals(positions, indices),
  };
}

function calculateMorph(name, positions, spec) {
  const output = new Float64Array(positions.length);
  for (let index = 0; index < positions.length; index += 3) {
    const baseX = positions[index];
    const baseY = positions[index + 1];
    const baseZ = positions[index + 2];
    let blenderX = baseX;
    let blenderY = -baseZ;
    let blenderZ = baseY;
    const u = blenderX / spec.width + 0.5;
    const v = blenderZ / spec.height + 0.5;
    const mouth = v < 0.38 && u > 0.28 && u < 0.72;
    const lid = v > 0.55 && ((u > 0.16 && u < 0.42) || (u > 0.58 && u < 0.84));
    if ((name === "happy" || name === "sad") && mouth) {
      blenderZ += (name === "sad" ? -0.01 * 0.6 : 0.012);
      blenderX += u < 0.5 ? -0.004 : 0.004;
    } else if (name === "aa" && mouth) {
      blenderZ -= 0.016;
      blenderY -= 0.006;
    } else if (name === "ih" && mouth) {
      blenderZ -= 0.007;
      blenderX *= 1.08;
    } else if (name === "ee" && mouth) {
      blenderZ -= 0.005;
      blenderX += u < 0.5 ? -0.006 : 0.006;
    } else if (name === "ou" && mouth) {
      blenderZ -= 0.008;
      blenderY -= 0.01;
      blenderX *= 0.86;
    } else if (name === "oh" && mouth) {
      blenderZ -= 0.013;
      blenderY -= 0.007;
      blenderX *= 0.9;
    } else if (name === "surprised" && mouth) {
      blenderZ -= 0.012;
      blenderY -= 0.004;
    } else if ((name === "blink" || name === "relaxed" || name === "surprised") && lid) {
      const lidOffset = name === "blink" ? -0.018 : name === "relaxed" ? -0.006 : 0.01;
      blenderZ += lidOffset;
    }
    output[index] = blenderX - baseX;
    output[index + 1] = blenderZ - baseY;
    output[index + 2] = -blenderY - baseZ;
  }
  return output;
}

function arraysEqual(left, right, tolerance = 2e-6) {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (Math.abs(left[index] - right[index]) > tolerance) return false;
  }
  return true;
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function transformPoint(point, node) {
  const scale = node.scale ?? [1, 1, 1];
  const rotation = node.rotation ?? [0, 0, 0, 1];
  const translation = node.translation ?? [0, 0, 0];
  let [x, y, z] = [point[0] * scale[0], point[1] * scale[1], point[2] * scale[2]];
  const [qx, qy, qz, qw] = rotation;
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  x += qw * tx + (qy * tz - qz * ty);
  y += qw * ty + (qz * tx - qx * tz);
  z += qw * tz + (qx * ty - qy * tx);
  return [x + translation[0], y + translation[1], z + translation[2]];
}

function worldPositions(json, nodeIndex, positions) {
  const parents = new Map();
  json.nodes.forEach((node, parentIndex) => {
    for (const child of node.children ?? []) parents.set(child, parentIndex);
  });
  const lineage = [];
  for (let current = nodeIndex; current !== undefined; current = parents.get(current)) lineage.push(json.nodes[current]);
  const output = new Float64Array(positions.length);
  for (let index = 0; index < positions.length; index += 3) {
    let point = [positions[index], positions[index + 1], positions[index + 2]];
    for (const node of lineage) point = transformPoint(point, node);
    output.set(point, index);
  }
  return output;
}

export function inspectFaceBuffer(buffer, spec) {
  const parsed = parseGlb(buffer);
  const face = findFace(parsed.json);
  const clothGeometry = correctedClothGeometry(parsed.json, parsed.bin);
  const positions = readAccessor(parsed.json, parsed.bin, face.primitive.attributes.POSITION);
  const occlusion = faceOcclusionMetrics(parsed.json, parsed.bin, face, positions, spec);
  const normals = readAccessor(parsed.json, parsed.bin, face.primitive.attributes.NORMAL);
  const clothPositions = readAccessor(
    parsed.json,
    parsed.bin,
    clothGeometry.cloth.primitive.attributes.POSITION,
  );
  const clothNormals = readAccessor(
    parsed.json,
    parsed.bin,
    clothGeometry.cloth.primitive.attributes.NORMAL,
  );
  const bounds = extrema(positions, 3);
  const clothBounds = extrema(clothPositions, 3);
  const worldBounds = extrema(worldPositions(parsed.json, face.nodeIndex, positions), 3);
  const width = bounds.max[0] - bounds.min[0];
  const height = bounds.max[1] - bounds.min[1];
  const worldWidth = worldBounds.max[0] - worldBounds.min[0];
  const worldHeight = worldBounds.max[1] - worldBounds.min[1];
  const morphMagnitudes = face.primitive.targets.map((target) => {
    const values = readAccessor(parsed.json, parsed.bin, target.POSITION);
    return Math.max(...values.map(Math.abs));
  });
  const normalLengths = [];
  for (let index = 0; index < normals.length; index += 3) {
    normalLengths.push(Math.hypot(normals[index], normals[index + 1], normals[index + 2]));
  }
  const clothNormalLengths = [];
  for (let index = 0; index < clothNormals.length; index += 3) {
    clothNormalLengths.push(Math.hypot(clothNormals[index], clothNormals[index + 1], clothNormals[index + 2]));
  }
  const preset = parsed.json.extensions?.VRMC_vrm?.expressions?.preset ?? {};
  const boundTargetIndices = new Set();
  for (const expression of Object.values(preset)) {
    for (const bind of expression?.morphTargetBinds ?? []) {
      if (bind.node === face.nodeIndex) boundTargetIndices.add(bind.index);
    }
  }
  return {
    width,
    height,
    depth: bounds.max[2] - bounds.min[2],
    faceNodeDepth: face.node.translation?.[2] ?? 0,
    faceSurfaceDepth: (face.node.translation?.[2] ?? 0) + bounds.max[2],
    centralFaceClearance: occlusion.centralClearance,
    edgeFaceClearance: occlusion.edgeClearance,
    uncoveredFaceVertices: occlusion.uncoveredVertices,
    aspectRatio: height / width,
    worldWidth,
    worldHeight,
    worldAspectRatio: worldHeight / worldWidth,
    vertexCount: positions.length / 3,
    targetNames: face.targetNames,
    morphMagnitudes,
    normalLengthRange: [Math.min(...normalLengths), Math.max(...normalLengths)],
    clothBack: clothBounds.min[2],
    clothFront: clothBounds.max[2],
    bodyFront: clothGeometry.bodyFront,
    clothClearance: clothBounds.max[2] - clothGeometry.bodyFront,
    clothNormalLengthRange: [Math.min(...clothNormalLengths), Math.max(...clothNormalLengths)],
    clothSkin: clothGeometry.cloth.node.skin,
    boundTargetIndices: [...boundTargetIndices].sort((a, b) => a - b),
    sha256: sha256(buffer),
    bytes: buffer.length,
  };
}

export function repairFaceBuffer(buffer, spec) {
  const parsed = parseGlb(buffer);
  const face = findFace(parsed.json);
  const clothGeometry = correctedClothGeometry(parsed.json, parsed.bin);
  const positionAccessor = face.primitive.attributes.POSITION;
  const normalAccessor = face.primitive.attributes.NORMAL;
  const currentPositions = readAccessor(parsed.json, parsed.bin, positionAccessor);
  assert.equal(currentPositions.length / 3, 645, "FaceFront vertex count changed");
  const positions = correctedPositions(currentPositions, spec, parsed.json, parsed.bin, face);
  const indices = readAccessor(parsed.json, parsed.bin, face.primitive.indices);
  assert.equal(indices.length % 3, 0, "FaceFront indices are not triangles");
  const normals = calculateNormals(positions, indices);
  const morphs = face.targetNames.map((name) => calculateMorph(name, positions, spec));
  const currentNormals = readAccessor(parsed.json, parsed.bin, normalAccessor);
  const currentMorphs = face.primitive.targets.map((target) => readAccessor(parsed.json, parsed.bin, target.POSITION));
  const faceGeometryChanged = !arraysEqual(currentPositions, positions)
    || !arraysEqual(currentNormals, normals)
    || currentMorphs.some((values, index) => !arraysEqual(values, morphs[index]));
  assert.ok(Array.isArray(face.node.translation) && face.node.translation.length === 3, "FaceFront translation is missing");
  const faceDepthChanged = Math.abs(face.node.translation[2] - spec.faceDepth) > 2e-6;
  const clothPositionAccessor = clothGeometry.cloth.primitive.attributes.POSITION;
  const clothNormalAccessor = clothGeometry.cloth.primitive.attributes.NORMAL;
  const currentClothNormals = readAccessor(parsed.json, parsed.bin, clothNormalAccessor);
  const clothGeometryChanged = !arraysEqual(clothGeometry.currentPositions, clothGeometry.positions)
    || !arraysEqual(currentClothNormals, clothGeometry.normals);
  const changed = faceGeometryChanged || faceDepthChanged || clothGeometryChanged;
  if (!changed) return { buffer, changed: false, inspection: inspectFaceBuffer(buffer, spec) };

  const originalBin = Buffer.from(parsed.bin);
  const originalBufferViews = structuredClone(parsed.json.bufferViews);
  const repairedAccessorIndices = new Set([
    positionAccessor,
    normalAccessor,
    ...face.primitive.targets.map((target) => target.POSITION),
    clothPositionAccessor,
    clothNormalAccessor,
  ]);
  const protectedAccessors = parsed.json.accessors.map((accessor, index) => (
    repairedAccessorIndices.has(index) ? null : structuredClone(accessor)
  ));
  const protectedMetadata = structuredClone({
    asset: parsed.json.asset,
    extensions: parsed.json.extensions,
    extensionsRequired: parsed.json.extensionsRequired,
    extensionsUsed: parsed.json.extensionsUsed,
    images: parsed.json.images,
    materials: parsed.json.materials,
    meshes: parsed.json.meshes,
    samplers: parsed.json.samplers,
    skins: parsed.json.skins,
    textures: parsed.json.textures,
  });
  const protectedNodes = parsed.json.nodes.map((node, index) => (
    index === face.nodeIndex ? null : structuredClone(node)
  ));
  if (faceGeometryChanged) {
    appendVec3Accessor(parsed, positionAccessor, positions, true);
    appendVec3Accessor(parsed, normalAccessor, normals, false);
    face.primitive.targets.forEach((target, index) => {
      appendVec3Accessor(parsed, target.POSITION, morphs[index], true);
    });
  }
  if (clothGeometryChanged) {
    appendVec3Accessor(parsed, clothPositionAccessor, clothGeometry.positions, true);
    appendVec3Accessor(parsed, clothNormalAccessor, clothGeometry.normals, false);
  }
  if (faceDepthChanged) {
    face.node.translation = [face.node.translation[0], face.node.translation[1], spec.faceDepth];
  }
  assert.deepEqual(parsed.bin.subarray(0, originalBin.length), originalBin, "repair modified existing GLB payload bytes");
  assert.deepEqual(parsed.json.bufferViews.slice(0, originalBufferViews.length), originalBufferViews, "repair modified an existing bufferView");
  protectedAccessors.forEach((accessor, index) => {
    if (accessor) assert.deepEqual(parsed.json.accessors[index], accessor, `repair modified unrelated accessor ${index}`);
  });
  protectedNodes.forEach((node, index) => {
    if (node) assert.deepEqual(parsed.json.nodes[index], node, `repair modified unrelated node ${index}`);
  });
  assert.deepEqual({
    asset: parsed.json.asset,
    extensions: parsed.json.extensions,
    extensionsRequired: parsed.json.extensionsRequired,
    extensionsUsed: parsed.json.extensionsUsed,
    images: parsed.json.images,
    materials: parsed.json.materials,
    meshes: parsed.json.meshes,
    samplers: parsed.json.samplers,
    skins: parsed.json.skins,
    textures: parsed.json.textures,
  }, protectedMetadata, "repair modified VRM metadata, textures, materials, or meshes");
  const output = buildGlb(parsed);
  return { buffer: output, changed: true, inspection: inspectFaceBuffer(output, spec) };
}

async function updateManifest(modelRoot, repaired, check) {
  const manifestPath = path.join(modelRoot, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  let changed = false;
  for (const result of repaired) {
    const entry = manifest.models.find((model) => model.id === result.spec.id);
    assert.ok(entry, `manifest entry ${result.spec.id} is missing`);
    assert.equal(entry.file, result.spec.file, `manifest file changed for ${result.spec.id}`);
    assert.equal(entry.quality, "painted-blender", `manifest quality changed for ${result.spec.id}`);
    if (entry.sha256 !== result.inspection.sha256 || entry.bytes !== result.inspection.bytes) {
      if (check) throw new Error(`${result.spec.file}: manifest hash or size is stale`);
      entry.sha256 = result.inspection.sha256;
      entry.bytes = result.inspection.bytes;
      changed = true;
    }
  }
  if (changed) await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

async function main() {
  const check = process.argv.includes("--check");
  const rootArgIndex = process.argv.indexOf("--model-root");
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const modelRoot = rootArgIndex === -1
    ? path.join(repoRoot, "apps/web/public/assets/characters/models")
    : path.resolve(process.argv[rootArgIndex + 1]);
  const repaired = [];
  for (const spec of PAINTED_MODELS) {
    const modelPath = path.join(modelRoot, spec.file);
    const input = await readFile(modelPath);
    const result = repairFaceBuffer(input, spec);
    if (check && result.changed) throw new Error(`${spec.file}: FaceFront geometry needs repair`);
    if (!check && result.changed) {
      const temporary = `${modelPath}.face-repair-${process.pid}.tmp`;
      await writeFile(temporary, result.buffer);
      await rename(temporary, modelPath);
    }
    repaired.push({ spec, ...result, inspection: result.changed ? inspectFaceBuffer(result.buffer, spec) : result.inspection });
    console.log(`${result.changed ? "repaired" : "checked"} ${spec.file}: ${result.inspection.height.toFixed(6)}m high, ${result.inspection.sha256}`);
  }
  await updateManifest(modelRoot, repaired, check);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
});
