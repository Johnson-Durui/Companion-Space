import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const GLB_MAGIC = 0x46546c67;
const GLB_VERSION = 2;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;
const FLOAT = 5126;
const UNSIGNED_BYTE = 5121;
const UNSIGNED_SHORT = 5123;
const UNSIGNED_INT = 5125;
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;
const EPSILON = 1e-5;

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const modelRoot = join(repositoryRoot, "apps/web/public/assets/characters/models");
const manifestPath = join(modelRoot, "manifest.json");

const paintedModels = [
  { id: "mira", file: "Mira.vrm", sizeX: 0.172, sizeY: 0.166, faceZ: 0.108, faceCenterY: 1.349041, capCenter: [0, 1.371041, -0.014], capRadius: 0.138, faceCut: 166, hairCut: 407 },
  { id: "kite", file: "Kite.vrm", sizeX: 0.172, sizeY: 0.166, faceZ: 0.108, faceCenterY: 1.349041, capCenter: [0, 1.382041, -0.02], capRadius: 0.128, faceCut: 166, hairCut: 657 },
  { id: "cael", file: "Cael.vrm", sizeX: 0.154, sizeY: 0.15, faceZ: 0.116, faceCenterY: 1.613145, capCenter: [0, 1.651145, -0.022], capRadius: 0.132, faceCut: 166, hairCut: 412 },
  { id: "lyra", file: "Lyra.vrm", sizeX: 0.172, sizeY: 0.166, faceZ: 0.108, faceCenterY: 1.349041, capCenter: [-0.018, 1.369041, -0.022], capRadius: 0.124, faceCut: 166, hairCut: 605 },
];

const expectedMorphNames = [
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

function fail(message) {
  throw new Error(message);
}

function approx(actual, expected, epsilon = EPSILON) {
  return Math.abs(actual - expected) <= epsilon;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseGlb(bytes, filename) {
  if (bytes.length < 20) {
    fail(`${filename}: file is too small to be a GLB.`);
  }
  if (bytes.readUInt32LE(0) !== GLB_MAGIC) {
    fail(`${filename}: invalid GLB magic.`);
  }
  if (bytes.readUInt32LE(4) !== GLB_VERSION) {
    fail(`${filename}: only GLB 2.0 is supported.`);
  }
  if (bytes.readUInt32LE(8) !== bytes.length) {
    fail(`${filename}: GLB header length does not match the file length.`);
  }

  const chunks = [];
  let offset = 12;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) {
      fail(`${filename}: truncated GLB chunk header.`);
    }
    const byteLength = bytes.readUInt32LE(offset);
    const type = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + byteLength;
    if (end > bytes.length) {
      fail(`${filename}: truncated GLB chunk payload.`);
    }
    chunks.push({ type, data: Buffer.from(bytes.subarray(start, end)) });
    offset = end;
  }

  if (chunks.length !== 2 || chunks[0].type !== JSON_CHUNK || chunks[1].type !== BIN_CHUNK) {
    fail(`${filename}: expected exactly one JSON chunk followed by one BIN chunk.`);
  }

  const jsonText = chunks[0].data.toString("utf8").replace(/[\u0000 ]+$/u, "");
  let json;
  try {
    json = JSON.parse(jsonText);
  } catch (error) {
    fail(`${filename}: invalid GLB JSON (${error.message}).`);
  }
  if (!Array.isArray(json.buffers) || json.buffers.length !== 1 || json.buffers[0].uri) {
    fail(`${filename}: expected one embedded GLB buffer.`);
  }
  if (json.buffers[0].byteLength > chunks[1].data.length) {
    fail(`${filename}: declared buffer length exceeds the BIN chunk.`);
  }
  return { json, binary: chunks[1].data };
}

function encodeGlb(json, binary) {
  const jsonSource = Buffer.from(JSON.stringify(json), "utf8");
  const jsonPadding = (4 - (jsonSource.length % 4)) % 4;
  const jsonChunk = Buffer.concat([jsonSource, Buffer.alloc(jsonPadding, 0x20)]);
  const binaryPadding = (4 - (binary.length % 4)) % 4;
  const binaryChunk = binaryPadding
    ? Buffer.concat([binary, Buffer.alloc(binaryPadding)])
    : binary;

  const output = Buffer.alloc(12 + 8 + jsonChunk.length + 8 + binaryChunk.length);
  output.writeUInt32LE(GLB_MAGIC, 0);
  output.writeUInt32LE(GLB_VERSION, 4);
  output.writeUInt32LE(output.length, 8);
  output.writeUInt32LE(jsonChunk.length, 12);
  output.writeUInt32LE(JSON_CHUNK, 16);
  jsonChunk.copy(output, 20);
  const binaryHeader = 20 + jsonChunk.length;
  output.writeUInt32LE(binaryChunk.length, binaryHeader);
  output.writeUInt32LE(BIN_CHUNK, binaryHeader + 4);
  binaryChunk.copy(output, binaryHeader + 8);
  return output;
}

function componentByteLength(componentType, filename, label) {
  if (componentType === FLOAT || componentType === UNSIGNED_INT) return 4;
  if (componentType === UNSIGNED_SHORT) return 2;
  if (componentType === UNSIGNED_BYTE) return 1;
  fail(`${filename}: unsupported ${label} component type ${componentType}.`);
}

function accessorLayout(json, accessorIndex, expectedType, expectedComponentType, filename, label) {
  const accessor = json.accessors?.[accessorIndex];
  if (!accessor) fail(`${filename}: ${label} accessor ${accessorIndex} is missing.`);
  if (accessor.type !== expectedType || accessor.componentType !== expectedComponentType || accessor.normalized) {
    fail(`${filename}: ${label} accessor has an unsupported type or component format.`);
  }
  if (accessor.sparse) fail(`${filename}: sparse ${label} accessors are unsupported.`);
  const view = json.bufferViews?.[accessor.bufferView];
  if (!view || view.buffer !== 0) fail(`${filename}: ${label} must use the embedded buffer.`);
  const componentCount = expectedType === "VEC3" ? 3 : 1;
  const elementSize = componentByteLength(accessor.componentType, filename, label) * componentCount;
  const stride = view.byteStride ?? elementSize;
  if (stride < elementSize) fail(`${filename}: ${label} byte stride is too small.`);
  const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const lastByte = start + Math.max(0, accessor.count - 1) * stride + elementSize;
  if (lastByte > (view.byteOffset ?? 0) + view.byteLength) {
    fail(`${filename}: ${label} accessor exceeds its buffer view.`);
  }
  return { accessor, view, start, stride, count: accessor.count, elementSize };
}

function readVec3(binary, layout, index) {
  const offset = layout.start + index * layout.stride;
  return [
    binary.readFloatLE(offset),
    binary.readFloatLE(offset + 4),
    binary.readFloatLE(offset + 8),
  ];
}

function writeVec3(binary, layout, index, value) {
  const offset = layout.start + index * layout.stride;
  binary.writeFloatLE(value[0], offset);
  binary.writeFloatLE(value[1], offset + 4);
  binary.writeFloatLE(value[2], offset + 8);
}

function readIndex(binary, layout, index) {
  const offset = layout.start + index * layout.stride;
  if (layout.accessor.componentType === UNSIGNED_BYTE) return binary.readUInt8(offset);
  if (layout.accessor.componentType === UNSIGNED_SHORT) return binary.readUInt16LE(offset);
  if (layout.accessor.componentType === UNSIGNED_INT) return binary.readUInt32LE(offset);
  fail("unreachable index component type");
}

function writeIndex(binary, layout, index, value) {
  const offset = layout.start + index * layout.stride;
  if (layout.accessor.componentType === UNSIGNED_BYTE) return binary.writeUInt8(value, offset);
  if (layout.accessor.componentType === UNSIGNED_SHORT) return binary.writeUInt16LE(value, offset);
  if (layout.accessor.componentType === UNSIGNED_INT) return binary.writeUInt32LE(value, offset);
  fail("unreachable index component type");
}

function scalarBounds(values) {
  return { min: [Math.min(...values)], max: [Math.max(...values)] };
}

function disjointSets(size) {
  const parent = Int32Array.from({ length: size }, (_, index) => index);
  const find = (value) => {
    let root = value;
    while (parent[root] !== root) root = parent[root];
    while (parent[value] !== value) {
      const next = parent[value];
      parent[value] = root;
      value = next;
    }
    return root;
  };
  const joinSets = (a, b) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent[rootB] = rootA;
  };
  return { find, joinSets };
}

function distance(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function bounds(values) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const value of values) {
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis], value[axis]);
      max[axis] = Math.max(max[axis], value[axis]);
    }
  }
  return { min, max, size: max.map((value, axis) => value - min[axis]) };
}

function floatVector(values) {
  return values.map((value) => Math.fround(value));
}

function recalculateNormals(positions, indices, filename) {
  if (indices.length % 3 !== 0) fail(`${filename}: FaceFront indices do not form triangles.`);
  const normals = positions.map(() => [0, 0, 0]);
  for (let offset = 0; offset < indices.length; offset += 3) {
    const ia = indices[offset];
    const ib = indices[offset + 1];
    const ic = indices[offset + 2];
    if (ia >= positions.length || ib >= positions.length || ic >= positions.length) {
      fail(`${filename}: FaceFront index exceeds the POSITION accessor.`);
    }
    const a = positions[ia];
    const b = positions[ib];
    const c = positions[ic];
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = c[0] - a[0];
    const vy = c[1] - a[1];
    const vz = c[2] - a[2];
    const normal = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    for (const index of [ia, ib, ic]) {
      normals[index][0] += normal[0];
      normals[index][1] += normal[1];
      normals[index][2] += normal[2];
    }
  }
  for (const normal of normals) {
    const length = Math.hypot(normal[0], normal[1], normal[2]);
    if (length <= Number.EPSILON) fail(`${filename}: FaceFront contains a vertex with no valid normal.`);
    normal[0] /= length;
    normal[1] /= length;
    normal[2] /= length;
  }
  return normals.map(floatVector);
}

function morphDelta(name, position, sizeX, sizeY) {
  const [x, y] = position;
  const u = (x / sizeX + 1) * 0.5;
  const v = (y / sizeY + 1) * 0.5;
  const mouth = v < 0.38 && u > 0.28 && u < 0.72;
  const lid = v > 0.55 && ((u > 0.16 && u < 0.42) || (u > 0.58 && u < 0.84));
  const side = u < 0.5 ? -1 : 1;

  if (name === "happy" && mouth) return floatVector([side * 0.004, 0.012, 0]);
  if (name === "sad" && mouth) return floatVector([side * 0.004, -0.006, 0]);
  if (name === "aa" && mouth) return floatVector([0, -0.016, 0.006]);
  if (name === "ih" && mouth) return floatVector([x * 0.08, -0.007, 0]);
  if (name === "ee" && mouth) return floatVector([side * 0.006, -0.005, 0]);
  if (name === "ou" && mouth) return floatVector([x * -0.14, -0.008, 0.01]);
  if (name === "oh" && mouth) return floatVector([x * -0.1, -0.013, 0.007]);
  if (name === "surprised" && mouth) return floatVector([0, -0.012, 0.004]);
  if (name === "relaxed" && lid) return floatVector([0, -0.006, 0]);
  if (name === "surprised" && lid) return floatVector([0, 0.01, 0]);
  if (name === "blink" && lid) return floatVector([0, -0.018, 0]);
  return [0, 0, 0];
}

function maxVectorError(actual, expected) {
  let maximum = 0;
  for (let index = 0; index < actual.length; index += 1) {
    for (let axis = 0; axis < 3; axis += 1) {
      maximum = Math.max(maximum, Math.abs(actual[index][axis] - expected[index][axis]));
    }
  }
  return maximum;
}

function arraysDiffer(actual, expected) {
  return actual.length !== expected.length || actual.some((value, index) => value !== expected[index]);
}

function degenerateTriangleCount(indices) {
  let count = 0;
  for (let offset = 0; offset < indices.length; offset += 3) {
    if (indices[offset] === indices[offset + 1] && indices[offset] === indices[offset + 2]) count += 1;
  }
  return count;
}

function trimFaceCardIndices(positions, indices, spec) {
  const existing = degenerateTriangleCount(indices);
  if (existing === spec.faceCut) return { indices, cut: existing };
  if (existing !== 0) fail(`${spec.file}: FaceFront has a partial or unsupported ellipse trim (${existing} triangles).`);

  const repaired = [...indices];
  let cut = 0;
  for (let offset = 0; offset < repaired.length; offset += 3) {
    const a = repaired[offset];
    const b = repaired[offset + 1];
    const c = repaired[offset + 2];
    const x = (positions[a][0] + positions[b][0] + positions[c][0]) / 3;
    const y = (positions[a][1] + positions[b][1] + positions[c][1]) / 3;
    const exterior = (x / (spec.sizeX * 0.5)) ** 2 + (y / (spec.sizeY * 0.5)) ** 2 > 1;
    if (exterior) {
      repaired[offset + 1] = a;
      repaired[offset + 2] = a;
      cut += 1;
    }
  }
  if (cut !== spec.faceCut) {
    fail(`${spec.file}: expected to trim ${spec.faceCut} FaceFront triangles, found ${cut}.`);
  }
  return { indices: repaired, cut };
}

function repairHairAperture(json, sourceBinary, binary, spec) {
  const nodes = json.nodes
    ?.map((node) => node)
    .filter((node) => node.name === "Hair") ?? [];
  if (nodes.length !== 1 || !Number.isInteger(nodes[0].mesh) || !Number.isInteger(nodes[0].skin)) {
    fail(`${spec.file}: expected exactly one skinned Hair node.`);
  }
  const mesh = json.meshes?.[nodes[0].mesh];
  if (!mesh || mesh.primitives?.length !== 1) fail(`${spec.file}: Hair must contain exactly one primitive.`);
  const primitive = mesh.primitives[0];
  if (!Number.isInteger(primitive.attributes?.POSITION) || !Number.isInteger(primitive.indices)) {
    fail(`${spec.file}: Hair POSITION or indices are missing.`);
  }
  const positionLayout = accessorLayout(
    json,
    primitive.attributes.POSITION,
    "VEC3",
    FLOAT,
    spec.file,
    "Hair POSITION",
  );
  const indexAccessor = json.accessors[primitive.indices];
  if (![UNSIGNED_BYTE, UNSIGNED_SHORT, UNSIGNED_INT].includes(indexAccessor?.componentType)) {
    fail(`${spec.file}: Hair indices use an unsupported component type.`);
  }
  const indexLayout = accessorLayout(
    json,
    primitive.indices,
    "SCALAR",
    indexAccessor.componentType,
    spec.file,
    "Hair indices",
  );
  const positions = Array.from(
    { length: positionLayout.count },
    (_, index) => readVec3(sourceBinary, positionLayout, index),
  );
  const indices = Array.from(
    { length: indexLayout.count },
    (_, index) => readIndex(sourceBinary, indexLayout, index),
  );
  if (indices.length % 3 !== 0) fail(`${spec.file}: Hair indices do not form triangles.`);
  const existing = degenerateTriangleCount(indices);
  if (existing === spec.hairCut) {
    return { changed: false, cut: existing, capComponents: 6 };
  }
  if (existing !== 0) fail(`${spec.file}: Hair has a partial or unsupported cap aperture (${existing} triangles).`);

  const sets = disjointSets(positions.length);
  for (let offset = 0; offset < indices.length; offset += 3) {
    sets.joinSets(indices[offset], indices[offset + 1]);
    sets.joinSets(indices[offset + 1], indices[offset + 2]);
  }
  const components = new Map();
  positions.forEach((position, index) => {
    const root = sets.find(index);
    const component = components.get(root) ?? { count: 0, nearCap: 0 };
    component.count += 1;
    if (Math.abs(distance(position, spec.capCenter) - spec.capRadius) < 0.01) component.nearCap += 1;
    components.set(root, component);
  });
  const capRoots = new Set(
    [...components]
      .filter(([, component]) => component.count > 200 && component.nearCap / component.count > 0.95)
      .map(([root]) => root),
  );
  if (capRoots.size !== 6) {
    fail(`${spec.file}: expected 6 spherical hair-cap components, found ${capRoots.size}.`);
  }

  const repaired = [...indices];
  let cut = 0;
  for (let offset = 0; offset < repaired.length; offset += 3) {
    const a = repaired[offset];
    const b = repaired[offset + 1];
    const c = repaired[offset + 2];
    if (!capRoots.has(sets.find(a))) continue;
    const x = (positions[a][0] + positions[b][0] + positions[c][0]) / 3;
    const y = (positions[a][1] + positions[b][1] + positions[c][1]) / 3;
    const z = (positions[a][2] + positions[b][2] + positions[c][2]) / 3;
    const inFront = z > spec.capCenter[2];
    const inAperture = (
      (x / (spec.sizeX * 0.56)) ** 2
      + ((y - spec.faceCenterY) / (spec.sizeY * 0.56)) ** 2
      < 1
    );
    if (inFront && inAperture) {
      repaired[offset + 1] = a;
      repaired[offset + 2] = a;
      cut += 1;
    }
  }
  if (cut !== spec.hairCut) {
    fail(`${spec.file}: expected to open ${spec.hairCut} Hair triangles, found ${cut}.`);
  }
  repaired.forEach((value, index) => writeIndex(binary, indexLayout, index, value));
  const indexBounds = scalarBounds(repaired);
  indexLayout.accessor.min = indexBounds.min;
  indexLayout.accessor.max = indexBounds.max;
  return { changed: arraysDiffer(indices, repaired), cut, capComponents: capRoots.size };
}

function repairModel(source, spec) {
  const { json, binary: sourceBinary } = parseGlb(source, spec.file);
  const binary = Buffer.from(sourceBinary);
  const faceNodes = json.nodes
    ?.map((node, index) => ({ node, index }))
    .filter(({ node }) => node.name === "FaceFront") ?? [];
  if (faceNodes.length !== 1) fail(`${spec.file}: expected exactly one FaceFront node.`);
  const faceNode = faceNodes[0].node;
  if (!Number.isInteger(faceNode.mesh) || faceNode.skin !== undefined) {
    fail(`${spec.file}: FaceFront must be an unskinned mesh node.`);
  }
  if (!Array.isArray(faceNode.translation) || faceNode.translation.length !== 3) {
    fail(`${spec.file}: FaceFront translation is missing.`);
  }
  const originalFaceZ = faceNode.translation[2];
  if (!approx(originalFaceZ, 0.07, 1e-4) && !approx(originalFaceZ, spec.faceZ, 1e-4)) {
    fail(`${spec.file}: unsupported FaceFront depth ${originalFaceZ}.`);
  }
  const mesh = json.meshes?.[faceNode.mesh];
  if (!mesh || mesh.primitives?.length !== 1) {
    fail(`${spec.file}: FaceFront must contain exactly one primitive.`);
  }
  const primitive = mesh.primitives[0];
  if (primitive.mode !== undefined && primitive.mode !== 4) {
    fail(`${spec.file}: FaceFront must use triangle primitives.`);
  }
  if (!Number.isInteger(primitive.attributes?.POSITION)
    || !Number.isInteger(primitive.attributes?.NORMAL)
    || !Number.isInteger(primitive.attributes?.TEXCOORD_0)
    || !Number.isInteger(primitive.indices)) {
    fail(`${spec.file}: FaceFront is missing POSITION, NORMAL, TEXCOORD_0, or indices.`);
  }
  if (primitive.attributes.TANGENT !== undefined) {
    fail(`${spec.file}: FaceFront tangents require regeneration, but this asset is expected not to contain them.`);
  }
  if (json.bufferViews[json.accessors[primitive.attributes.POSITION].bufferView].target !== ARRAY_BUFFER
    || json.bufferViews[json.accessors[primitive.attributes.NORMAL].bufferView].target !== ARRAY_BUFFER
    || json.bufferViews[json.accessors[primitive.indices].bufferView].target !== ELEMENT_ARRAY_BUFFER) {
    fail(`${spec.file}: FaceFront buffer view targets are unsupported.`);
  }

  const targetNames = mesh.extras?.targetNames;
  if (!Array.isArray(targetNames)
    || targetNames.length !== expectedMorphNames.length
    || targetNames.some((name, index) => name !== expectedMorphNames[index])) {
    fail(`${spec.file}: FaceFront morph target names or order are unsupported.`);
  }
  if (!Array.isArray(primitive.targets) || primitive.targets.length !== targetNames.length) {
    fail(`${spec.file}: FaceFront morph target count is unsupported.`);
  }
  if (primitive.targets.some((target) => !Number.isInteger(target.POSITION)
    || target.NORMAL !== undefined
    || target.TANGENT !== undefined
    || Object.keys(target).some((key) => key !== "POSITION"))) {
    fail(`${spec.file}: FaceFront must have POSITION-only morph targets.`);
  }

  const positionLayout = accessorLayout(
    json,
    primitive.attributes.POSITION,
    "VEC3",
    FLOAT,
    spec.file,
    "FaceFront POSITION",
  );
  const normalLayout = accessorLayout(
    json,
    primitive.attributes.NORMAL,
    "VEC3",
    FLOAT,
    spec.file,
    "FaceFront NORMAL",
  );
  if (positionLayout.count !== normalLayout.count) {
    fail(`${spec.file}: FaceFront POSITION and NORMAL counts differ.`);
  }
  const indexAccessor = json.accessors[primitive.indices];
  if (![UNSIGNED_BYTE, UNSIGNED_SHORT, UNSIGNED_INT].includes(indexAccessor?.componentType)) {
    fail(`${spec.file}: FaceFront indices use an unsupported component type.`);
  }
  const indexLayout = accessorLayout(
    json,
    primitive.indices,
    "SCALAR",
    indexAccessor.componentType,
    spec.file,
    "FaceFront indices",
  );
  const morphLayouts = primitive.targets.map((target, index) => {
    const layout = accessorLayout(
      json,
      target.POSITION,
      "VEC3",
      FLOAT,
      spec.file,
      `FaceFront ${targetNames[index]} morph`,
    );
    if (layout.count !== positionLayout.count) {
      fail(`${spec.file}: ${targetNames[index]} morph count differs from POSITION.`);
    }
    return layout;
  });

  const originalPositions = Array.from(
    { length: positionLayout.count },
    (_, index) => readVec3(sourceBinary, positionLayout, index),
  );
  const originalBounds = bounds(originalPositions);
  if (!approx(originalBounds.size[0], spec.sizeX, 1e-4)) {
    fail(`${spec.file}: unexpected FaceFront width ${originalBounds.size[0]}.`);
  }
  const broken = approx(originalBounds.size[1], 1, 1e-4);
  const alreadyScaled = approx(originalBounds.size[1], spec.sizeY, 1e-4);
  if (!broken && !alreadyScaled) {
    fail(`${spec.file}: unexpected FaceFront height ${originalBounds.size[1]}.`);
  }

  const positions = originalPositions.map(([x, y]) => {
    const repairedY = broken ? y * spec.sizeY : y;
    const repairedZ = Math.abs(x) * 0.12 + Math.abs(repairedY) * 0.04;
    return floatVector([x, repairedY, repairedZ]);
  });
  const repairedBounds = bounds(positions);
  if (!approx(repairedBounds.size[0], spec.sizeX, 1e-4)
    || !approx(repairedBounds.size[1], spec.sizeY, 1e-4)) {
    fail(`${spec.file}: repaired FaceFront bounds do not match the source dimensions.`);
  }

  const indices = Array.from(
    { length: indexLayout.count },
    (_, index) => readIndex(sourceBinary, indexLayout, index),
  );
  const originalNormals = Array.from(
    { length: normalLayout.count },
    (_, index) => readVec3(sourceBinary, normalLayout, index),
  );
  const existingFaceCut = degenerateTriangleCount(indices);
  const normals = existingFaceCut === 0
    ? recalculateNormals(positions, indices, spec.file)
    : originalNormals;
  const faceTrim = trimFaceCardIndices(positions, indices, spec);
  const morphs = targetNames.map((name) => positions.map((position) => morphDelta(
    name,
    position,
    spec.sizeX,
    spec.sizeY,
  )));

  const originalMorphs = morphLayouts.map((layout) => Array.from(
    { length: layout.count },
    (_, index) => readVec3(sourceBinary, layout, index),
  ));
  faceTrim.indices.forEach((value, index) => writeIndex(binary, indexLayout, index, value));
  const faceIndexBounds = scalarBounds(faceTrim.indices);
  indexLayout.accessor.min = faceIndexBounds.min;
  indexLayout.accessor.max = faceIndexBounds.max;
  faceNode.translation[2] = spec.faceZ;
  const hairAperture = repairHairAperture(json, sourceBinary, binary, spec);

  const changed = broken
    || !approx(originalFaceZ, spec.faceZ, 1e-6)
    || arraysDiffer(indices, faceTrim.indices)
    || hairAperture.changed
    || maxVectorError(originalPositions, positions) > 1e-6
    || maxVectorError(originalNormals, normals) > 1e-6
    || originalMorphs.some((values, index) => maxVectorError(values, morphs[index]) > 1e-6);

  positions.forEach((value, index) => writeVec3(binary, positionLayout, index, value));
  normals.forEach((value, index) => writeVec3(binary, normalLayout, index, value));
  morphs.forEach((values, morphIndex) => {
    values.forEach((value, index) => writeVec3(binary, morphLayouts[morphIndex], index, value));
  });

  const positionBounds = bounds(positions);
  positionLayout.accessor.min = positionBounds.min;
  positionLayout.accessor.max = positionBounds.max;
  morphs.forEach((values, index) => {
    const morphBounds = bounds(values);
    morphLayouts[index].accessor.min = morphBounds.min;
    morphLayouts[index].accessor.max = morphBounds.max;
  });
  json.buffers[0].byteLength = binary.length;

  const encodedOutput = encodeGlb(json, binary);
  const reparsed = parseGlb(encodedOutput, spec.file);
  if (reparsed.binary.length < json.buffers[0].byteLength) {
    fail(`${spec.file}: repaired GLB failed its structural round trip.`);
  }
  const output = changed ? encodedOutput : source;

  return {
    output,
    changed,
    originalBounds,
    repairedBounds,
    faceCut: faceTrim.cut,
    hairCut: hairAperture.cut,
    capComponents: hairAperture.capComponents,
    originalHash: sha256(source),
    repairedHash: sha256(output),
  };
}

async function loadManifest() {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (!Array.isArray(manifest.models)) fail("manifest.json: models must be an array.");
  return manifest;
}

function manifestEntry(manifest, spec) {
  const matches = manifest.models.filter((entry) => entry.id === spec.id && entry.file === spec.file);
  if (matches.length !== 1) {
    fail(`manifest.json: expected exactly one ${spec.id}/${spec.file} entry.`);
  }
  return matches[0];
}

async function main() {
  const write = process.argv.includes("--write");
  const check = process.argv.includes("--check");
  if (write && check) fail("Use either --write or --check, not both.");
  const unknown = process.argv.slice(2).filter((arg) => !["--write", "--check"].includes(arg));
  if (unknown.length) fail(`Unknown arguments: ${unknown.join(", ")}`);

  const manifest = await loadManifest();
  const repairs = [];
  for (const spec of paintedModels) {
    const path = join(modelRoot, spec.file);
    const source = await readFile(path);
    const entry = manifestEntry(manifest, spec);
    if (entry.sha256 !== sha256(source) || entry.bytes !== source.length) {
      fail(`${spec.file}: source bytes do not match manifest.json.`);
    }
    const repair = repairModel(source, spec);
    repairs.push({ spec, path, entry, ...repair });
  }

  if (check) {
    const pending = repairs.filter((repair) => repair.changed);
    if (pending.length) {
      fail(`painted VRM face repair is still required: ${pending.map(({ spec }) => spec.file).join(", ")}`);
    }
    for (const repair of repairs) {
      console.log(`${repair.spec.id}\tok\t${repair.repairedBounds.size.map((value) => value.toFixed(6)).join("x")}\t${repair.originalHash}`);
    }
    return;
  }

  for (const repair of repairs) {
    const action = repair.changed ? (write ? "write" : "would-repair") : "unchanged";
    console.log(
      `${repair.spec.id}\t${action}\t`
      + `${repair.originalBounds.size.map((value) => value.toFixed(6)).join("x")} -> `
      + `${repair.repairedBounds.size.map((value) => value.toFixed(6)).join("x")}\t`
      + `${repair.repairedHash}\t${repair.output.length}`,
    );
  }

  if (!write) {
    console.log("dry run only; pass --write to replace the four VRMs and update manifest.json");
    return;
  }

  for (const repair of repairs) {
    if (!repair.changed) continue;
    await writeFile(repair.path, repair.output);
    repair.entry.sha256 = repair.repairedHash;
    repair.entry.bytes = repair.output.length;
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log("painted VRM faces repaired; manifest hashes and byte counts updated");
}

await main();
