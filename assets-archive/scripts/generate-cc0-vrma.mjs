import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const outputRoot = fileURLToPath(
  new URL("../apps/web/public/assets/characters/motions/", import.meta.url),
);
const checkOnly = process.argv.includes("--check");

const TIMES = [0, 0.25, 0.5, 0.75, 1];
const BONE_NODES = [
  { name: "hips", translation: [0, 1, 0], parent: null },
  { name: "spine", translation: [0, 0.18, 0], parent: 0 },
  { name: "chest", translation: [0, 0.18, 0], parent: 1 },
  { name: "neck", translation: [0, 0.18, 0], parent: 2 },
  { name: "head", translation: [0, 0.15, 0], parent: 3 },
  { name: "leftUpperArm", translation: [0.16, 0.12, 0], parent: 2 },
  { name: "leftLowerArm", translation: [0.25, 0, 0], parent: 5 },
  { name: "leftHand", translation: [0.23, 0, 0], parent: 6 },
  { name: "rightUpperArm", translation: [-0.16, 0.12, 0], parent: 2 },
  { name: "rightLowerArm", translation: [-0.25, 0, 0], parent: 8 },
  { name: "rightHand", translation: [-0.23, 0, 0], parent: 9 },
  { name: "leftUpperLeg", translation: [0.09, -0.08, 0], parent: 0 },
  { name: "leftLowerLeg", translation: [0, -0.42, 0], parent: 11 },
  { name: "leftFoot", translation: [0, -0.4, 0.03], parent: 12 },
  { name: "rightUpperLeg", translation: [-0.09, -0.08, 0], parent: 0 },
  { name: "rightLowerLeg", translation: [0, -0.42, 0], parent: 14 },
  { name: "rightFoot", translation: [0, -0.4, 0.03], parent: 15 },
];

const MOTIONS = [
  {
    state: "idle",
    duration: 3.2,
    poses: {
      hips: axisPoses("y", [0, 0.025, 0, -0.025, 0]),
      spine: axisPoses("x", [0, 0.018, 0, -0.012, 0]),
      head: axisPoses("y", [0, -0.035, 0, 0.035, 0]),
      leftUpperArm: axisPoses("z", [1.04, 1.02, 1.04, 1.06, 1.04]),
      rightUpperArm: axisPoses("z", [-1.04, -1.06, -1.04, -1.02, -1.04]),
    },
  },
  {
    state: "listening",
    duration: 2.6,
    poses: {
      hips: axisPoses("x", [0, -0.018, -0.03, -0.018, 0]),
      spine: axisPoses("x", [0, -0.045, -0.065, -0.045, 0]),
      head: axisPoses("x", [0.02, 0.09, 0.025, 0.09, 0.02]),
      leftUpperArm: axisPoses("z", [1.04, 1.01, 1.04, 1.07, 1.04]),
      rightUpperArm: axisPoses("z", [-1.04, -1.07, -1.04, -1.01, -1.04]),
    },
  },
  {
    state: "thinking",
    duration: 3.4,
    poses: {
      hips: axisPoses("y", [0, 0.018, 0.032, 0.018, 0]),
      spine: axisPoses("z", [0, 0.022, 0.04, 0.022, 0]),
      head: combinedPoses([
        [0.02, 0, 0],
        [0.055, 0.16, 0.025],
        [0.025, 0.08, 0.04],
        [0.055, 0.16, 0.025],
        [0.02, 0, 0],
      ]),
      leftUpperArm: axisPoses("z", [1.04, 1.02, 1.04, 1.06, 1.04]),
      rightUpperArm: combinedPoses([
        [0, 0, -1.04],
        [-0.1, 0, -0.74],
        [-0.16, 0, -0.62],
        [-0.1, 0, -0.74],
        [0, 0, -1.04],
      ]),
    },
  },
  {
    state: "speaking",
    duration: 1.8,
    poses: {
      hips: axisPoses("y", [0, 0.035, -0.025, 0.035, 0]),
      chest: combinedPoses([
        [0, 0, 0],
        [0.025, 0.045, 0],
        [-0.01, -0.03, 0],
        [0.025, 0.045, 0],
        [0, 0, 0],
      ]),
      head: axisPoses("x", [0, 0.035, -0.025, 0.035, 0]),
      leftUpperArm: combinedPoses([
        [0, 0, 1.04],
        [0.08, 0, 0.78],
        [-0.04, 0, 0.98],
        [0.1, 0, 0.72],
        [0, 0, 1.04],
      ]),
      rightUpperArm: combinedPoses([
        [0, 0, -1.04],
        [-0.06, 0, -0.92],
        [0.09, 0, -0.7],
        [-0.04, 0, -0.96],
        [0, 0, -1.04],
      ]),
    },
  },
];

function axisPoses(axis, values) {
  const index = { x: 0, y: 1, z: 2 }[axis];
  return values.map((value) => {
    const pose = [0, 0, 0];
    pose[index] = value;
    return pose;
  });
}

function combinedPoses(poses) {
  return poses;
}

function quaternionFromEuler([x, y, z]) {
  const c1 = Math.cos(x / 2);
  const c2 = Math.cos(y / 2);
  const c3 = Math.cos(z / 2);
  const s1 = Math.sin(x / 2);
  const s2 = Math.sin(y / 2);
  const s3 = Math.sin(z / 2);
  return [
    s1 * c2 * c3 + c1 * s2 * s3,
    c1 * s2 * c3 - s1 * c2 * s3,
    c1 * c2 * s3 + s1 * s2 * c3,
    c1 * c2 * c3 - s1 * s2 * s3,
  ];
}

function float32Buffer(values) {
  const array = new Float32Array(values);
  return Buffer.from(array.buffer, array.byteOffset, array.byteLength);
}

function pad(buffer, fill = 0) {
  const padding = (4 - (buffer.length % 4)) % 4;
  return padding ? Buffer.concat([buffer, Buffer.alloc(padding, fill)]) : buffer;
}

function makeVrma({ state, duration, poses }) {
  const binaryParts = [];
  const bufferViews = [];
  const accessors = [];
  let byteOffset = 0;

  const addAccessor = (buffer, accessor) => {
    const viewIndex = bufferViews.length;
    bufferViews.push({ buffer: 0, byteLength: buffer.length, byteOffset });
    binaryParts.push(buffer);
    byteOffset += buffer.length;
    const accessorIndex = accessors.length;
    accessors.push({ bufferView: viewIndex, byteOffset: 0, ...accessor });
    return accessorIndex;
  };

  const seconds = TIMES.map((value) => value * duration);
  const inputAccessor = addAccessor(float32Buffer(seconds), {
    componentType: 5126,
    count: seconds.length,
    max: [duration],
    min: [0],
    type: "SCALAR",
  });

  const samplers = [];
  const channels = [];
  for (const [boneName, bonePoses] of Object.entries(poses)) {
    if (bonePoses.length !== TIMES.length) {
      throw new Error(`${state}/${boneName} must have ${TIMES.length} poses`);
    }
    const nodeIndex = BONE_NODES.findIndex((node) => node.name === boneName);
    if (nodeIndex < 0) {
      throw new Error(`Unknown humanoid bone: ${boneName}`);
    }
    const outputAccessor = addAccessor(
      float32Buffer(bonePoses.flatMap(quaternionFromEuler)),
      {
        componentType: 5126,
        count: bonePoses.length,
        type: "VEC4",
      },
    );
    const samplerIndex = samplers.length;
    samplers.push({ input: inputAccessor, interpolation: "LINEAR", output: outputAccessor });
    channels.push({ sampler: samplerIndex, target: { node: nodeIndex, path: "rotation" } });
  }

  const childrenByParent = new Map();
  BONE_NODES.forEach((node, index) => {
    if (node.parent === null) {
      return;
    }
    const children = childrenByParent.get(node.parent) ?? [];
    children.push(index);
    childrenByParent.set(node.parent, children);
  });

  const binary = Buffer.concat(binaryParts);
  const document = {
    asset: {
      version: "2.0",
      generator: "Companion Space deterministic CC0 VRMA generator",
      extras: {
        license: "CC0-1.0",
        source: "scripts/generate-cc0-vrma.mjs",
      },
    },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: BONE_NODES.map((node, index) => ({
      name: node.name,
      translation: node.translation,
      ...(childrenByParent.has(index) ? { children: childrenByParent.get(index) } : {}),
    })),
    animations: [{ name: `companion-${state}`, channels, samplers }],
    buffers: [{ byteLength: binary.length }],
    bufferViews,
    accessors,
    extensionsUsed: ["VRMC_vrm_animation"],
    extensionsRequired: ["VRMC_vrm_animation"],
    extensions: {
      VRMC_vrm_animation: {
        specVersion: "1.0",
        humanoid: {
          humanBones: Object.fromEntries(
            BONE_NODES.map((node, index) => [node.name, { node: index }]),
          ),
        },
      },
    },
  };

  const jsonChunk = pad(Buffer.from(JSON.stringify(document), "utf8"), 0x20);
  const binaryChunk = pad(binary);
  const totalLength = 12 + 8 + jsonChunk.length + 8 + binaryChunk.length;
  const header = Buffer.alloc(12);
  header.write("glTF", 0, "ascii");
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(totalLength, 8);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonChunk.length, 0);
  jsonHeader.write("JSON", 4, "ascii");
  const binaryHeader = Buffer.alloc(8);
  binaryHeader.writeUInt32LE(binaryChunk.length, 0);
  binaryHeader.write("BIN\0", 4, "binary");
  return Buffer.concat([header, jsonHeader, jsonChunk, binaryHeader, binaryChunk]);
}

function publish(filename, data) {
  const path = `${outputRoot}${filename}`;
  if (checkOnly) {
    if (!existsSync(path) || !readFileSync(path).equals(Buffer.from(data))) {
      throw new Error(`${filename} does not match the deterministic generator output.`);
    }
    return;
  }
  writeFileSync(path, data);
}

if (!checkOnly) {
  mkdirSync(outputRoot, { recursive: true });
}
const manifestMotions = MOTIONS.map((motion) => {
  const filename = `companion-${motion.state}.vrma`;
  const data = makeVrma(motion);
  publish(filename, data);
  return {
    id: `companion_${motion.state}`,
    state: motion.state,
    name: `Companion ${motion.state}`,
    file: filename,
    format: "VRMC_vrm_animation 1.0",
    author: "Companion Space project",
    license: "CC0 1.0 Universal",
    redistribution_allowed: true,
    modification_allowed: true,
    attribution_required: false,
    in_place: true,
    sha256: createHash("sha256").update(data).digest("hex"),
  };
});

publish(
  "manifest.json",
  `${JSON.stringify({
    schema_version: 1,
    repository_notice: "assets/THIRD_PARTY_NOTICES.md",
    generator: "scripts/generate-cc0-vrma.mjs",
    license_path: "LICENSE-CC0.txt",
    motions: manifestMotions,
  }, null, 2)}\n`,
);
