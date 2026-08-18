import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const outputRoot = fileURLToPath(
  new URL("../apps/web/public/assets/characters/models/", import.meta.url),
);
const checkOnly = process.argv.includes("--check");
const forcePrototype = process.argv.includes("--prototype");
const blenderMarkerPath = `${outputRoot}.blender-built`;

const FINGER_CHAINS = [
  ["ThumbMetacarpal", "ThumbProximal", "ThumbDistal"],
  ["IndexProximal", "IndexIntermediate", "IndexDistal"],
  ["MiddleProximal", "MiddleIntermediate", "MiddleDistal"],
  ["RingProximal", "RingIntermediate", "RingDistal"],
  ["LittleProximal", "LittleIntermediate", "LittleDistal"],
];

const CHARACTERS = [
  {
    id: "mira",
    file: "Mira.vrm",
    name: "澄羽 MIRA",
    authors: ["Companion Space"],
    body: "mini",
    hair: "bob",
    outfit: "cloak",
    extra: "ribbon",
    face: "soft",
    palette: {
      skin: "#f0d3ca",
      hair: "#0c5961",
      eye: "#78c9ca",
      outfit: "#f0eadf",
      accent: "#d6644a",
      inner: "#d7e7ea",
      secondary: "#0c5961",
    },
  },
  {
    id: "kite",
    file: "Kite.vrm",
    name: "曜柚 KITE",
    authors: ["Companion Space"],
    body: "mini",
    hair: "ponytail",
    outfit: "jacket",
    extra: "clip",
    face: "round",
    palette: {
      skin: "#efd1c4",
      hair: "#2c2528",
      eye: "#168b83",
      outfit: "#fff4dd",
      accent: "#f2c84b",
      inner: "#3aa39a",
      secondary: "#1a1a1c",
    },
  },
  {
    id: "cael",
    file: "Cael.vrm",
    name: "凛序 CAEL",
    authors: ["Companion Space"],
    body: "tall",
    hair: "long",
    outfit: "coat",
    extra: "glasses",
    face: "sharp",
    palette: {
      skin: "#e7c8bb",
      hair: "#162433",
      eye: "#86dce3",
      outfit: "#1a2b3d",
      accent: "#c69a52",
      inner: "#d8e8ea",
      secondary: "#0e1720",
    },
  },
  {
    id: "lyra",
    file: "Lyra.vrm",
    name: "弦灯 LYRA",
    authors: ["Companion Space"],
    body: "mini",
    hair: "asym",
    outfit: "studio",
    extra: "sash",
    face: "serene",
    palette: {
      skin: "#f0d3ca",
      hair: "#463843",
      eye: "#d4a24c",
      outfit: "#3c2f3d",
      accent: "#e78745",
      inner: "#f4d7c0",
      secondary: "#2a1f28",
    },
  },
];

const SAMPLE_SHA256 = new Set([
  "12c2b97e95e700783a6a550dc0eee2d7880aeedccef9ae67bc4c5a2f0f2631a2",
  "624d0d554bc205bbdc33e22a68a2c3c20edebb3e573011ead8878a65e5329b23",
  "f11b2648e7e588ae171ad1c32e465f84e5b130b1d1789e3a3702946c0981d2a9",
  "a36e91b81518c59f6da0e3f34a176b79090a8c68cc6bd5fe03c1560744b283f3",
]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let crc = index;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    table[index] = crc;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeBuffer = Buffer.from(type);
  const payload = Buffer.concat([typeBuffer, data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(payload));
  return Buffer.concat([length, payload, checksum]);
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function hexRgb(hex) {
  const value = hex.replace("#", "");
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
  ];
}

function hexToRgba(hex) {
  const rgb = hexRgb(hex);
  return [rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, 1];
}

function mixRgb(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

function putPixel(data, width, x, y, rgb, alpha = 255) {
  const px = Math.round(x);
  const py = Math.round(y);
  if (px < 0 || py < 0 || px >= width || py >= width) {
    return;
  }
  const index = (py * width + px) * 4;
  data[index] = rgb[0];
  data[index + 1] = rgb[1];
  data[index + 2] = rgb[2];
  data[index + 3] = alpha;
}

function fillEllipse(data, width, cx, cy, rx, ry, rgb, alpha = 255) {
  const x0 = Math.max(0, Math.floor(cx - rx));
  const x1 = Math.min(width - 1, Math.ceil(cx + rx));
  const y0 = Math.max(0, Math.floor(cy - ry));
  const y1 = Math.min(width - 1, Math.ceil(cy + ry));
  const rx2 = rx * rx || 1;
  const ry2 = ry * ry || 1;
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const dx = x - cx;
      const dy = y - cy;
      if ((dx * dx) / rx2 + (dy * dy) / ry2 <= 1) {
        putPixel(data, width, x, y, rgb, alpha);
      }
    }
  }
}

function paintFaceTexture(spec) {
  const width = 512;
  const data = Buffer.alloc(width * width * 4, 255);
  const skin = hexRgb(spec.palette.skin);
  const eye = hexRgb(spec.palette.eye);
  const accent = hexRgb(spec.palette.accent);
  const hair = hexRgb(spec.palette.hair);
  const round = spec.face === "round";
  const sharp = spec.face === "sharp";
  const smile = spec.face === "round" || spec.face === "serene" ? 1 : spec.face === "soft" ? 0.55 : 0.2;
  for (let y = 0; y < width; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const shade = 1 - Math.abs(x / width - 0.5) * 0.06 - (y / width) * 0.03;
      putPixel(data, width, x, y, [
        Math.min(255, skin[0] * shade),
        Math.min(255, skin[1] * shade),
        Math.min(255, skin[2] * shade),
      ]);
    }
  }
  fillEllipse(data, width, 168, 318, 58, 28, mixRgb(skin, accent, 0.18), 90);
  fillEllipse(data, width, 344, 318, 58, 28, mixRgb(skin, accent, 0.18), 90);
  const browY = sharp ? 168 : 176;
  const browW = sharp ? 54 : round ? 62 : 58;
  fillEllipse(data, width, 170, browY, browW, sharp ? 6 : 8, mixRgb(hair, [40, 30, 28], 0.35));
  fillEllipse(data, width, 342, browY, browW, sharp ? 6 : 8, mixRgb(hair, [40, 30, 28], 0.35));
  const eyeY = 232;
  const eyeRx = round ? 58 : sharp ? 46 : 52;
  const eyeRy = round ? 32 : sharp ? 22 : 28;
  for (const cx of [168, 344]) {
    fillEllipse(data, width, cx, eyeY, eyeRx, eyeRy, [252, 250, 247]);
    fillEllipse(data, width, cx + (sharp ? 4 : 0), eyeY + 2, eyeRx * 0.55, eyeRy * 0.78, eye);
    fillEllipse(data, width, cx + 2, eyeY + 4, 11, 14, [28, 24, 32]);
    fillEllipse(data, width, cx - 10, eyeY - 8, 8, 7, [255, 255, 255]);
    fillEllipse(data, width, cx + 8, eyeY + 6, 4, 3, [255, 255, 255], 200);
    fillEllipse(data, width, cx, eyeY - eyeRy + 2, eyeRx, 7, mixRgb(hair, [20, 16, 18], 0.2));
  }
  fillEllipse(data, width, 256, 292, 8, 6, mixRgb(skin, [120, 80, 70], 0.25));
  fillEllipse(data, width, 256, 298, 5, 4, mixRgb(skin, [120, 80, 70], 0.18));
  const mouthY = 348 + smile * 4;
  fillEllipse(data, width, 256, mouthY, 28 + smile * 10, 6 + smile * 5, mixRgb(accent, [90, 40, 40], 0.45));
  fillEllipse(data, width, 256, mouthY - 2, 22 + smile * 8, 3 + smile * 2, mixRgb(skin, [255, 220, 210], 0.35));
  return encodePng(width, width, data);
}

function pad(buffer, fill = 0) {
  const padding = (4 - (buffer.length % 4)) % 4;
  return padding ? Buffer.concat([buffer, Buffer.alloc(padding, fill)]) : buffer;
}

function inverseMat4(m) {
  const out = new Float32Array(16);
  const a00 = m[0];
  const a01 = m[1];
  const a02 = m[2];
  const a03 = m[3];
  const a10 = m[4];
  const a11 = m[5];
  const a12 = m[6];
  const a13 = m[7];
  const a20 = m[8];
  const a21 = m[9];
  const a22 = m[10];
  const a23 = m[11];
  const a30 = m[12];
  const a31 = m[13];
  const a32 = m[14];
  const a33 = m[15];
  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;
  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (Math.abs(det) < 1e-10) {
    throw new Error("Bone matrix is not invertible.");
  }
  const inv = 1 / det;
  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * inv;
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * inv;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * inv;
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * inv;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * inv;
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * inv;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * inv;
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * inv;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * inv;
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * inv;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * inv;
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * inv;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * inv;
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * inv;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * inv;
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * inv;
  return out;
}

function mulMat4(a, b) {
  const out = new Float32Array(16);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      out[column * 4 + row] =
        a[row] * b[column * 4]
        + a[4 + row] * b[column * 4 + 1]
        + a[8 + row] * b[column * 4 + 2]
        + a[12 + row] * b[column * 4 + 3];
    }
  }
  return out;
}

function translationMat4(x, y, z) {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
}

function normalize(vector) {
  const length = Math.hypot(vector[0], vector[1], vector[2]) || 1;
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}

function makeBones(body) {
  const mini = body === "mini";
  const defs = [];
  const bone = (name, translation, parent) => {
    defs.push({
      name,
      translation,
      parent: parent === null ? null : defs.findIndex((entry) => entry.name === parent),
    });
  };
  bone("hips", [0, mini ? 0.94 : 1.08, 0], null);
  bone("spine", [0, mini ? 0.15 : 0.17, 0], "hips");
  bone("chest", [0, mini ? 0.15 : 0.17, 0], "spine");
  bone("upperChest", [0, mini ? 0.12 : 0.14, 0], "chest");
  bone("neck", [0, mini ? 0.12 : 0.13, 0], "upperChest");
  bone("head", [0, mini ? 0.13 : 0.14, 0], "neck");
  bone("leftEye", [0.03, 0.04, 0.09], "head");
  bone("rightEye", [-0.03, 0.04, 0.09], "head");
  const shoulderX = mini ? 0.12 : 0.15;
  bone("leftShoulder", [shoulderX, 0.08, 0], "upperChest");
  bone("leftUpperArm", [0.09, 0, 0], "leftShoulder");
  bone("leftLowerArm", [mini ? 0.22 : 0.26, 0, 0], "leftUpperArm");
  bone("leftHand", [mini ? 0.2 : 0.23, 0, 0], "leftLowerArm");
  bone("rightShoulder", [-shoulderX, 0.08, 0], "upperChest");
  bone("rightUpperArm", [-0.09, 0, 0], "rightShoulder");
  bone("rightLowerArm", [mini ? -0.22 : -0.26, 0, 0], "rightUpperArm");
  bone("rightHand", [mini ? -0.2 : -0.23, 0, 0], "rightLowerArm");
  const hipX = mini ? 0.09 : 0.1;
  bone("leftUpperLeg", [hipX, -0.07, 0], "hips");
  bone("leftLowerLeg", [0, mini ? -0.4 :  -0.46, 0], "leftUpperLeg");
  bone("leftFoot", [0, mini ? -0.38 : -0.42, 0.03], "leftLowerLeg");
  bone("leftToes", [0, 0, 0.06], "leftFoot");
  bone("rightUpperLeg", [-hipX, -0.07, 0], "hips");
  bone("rightLowerLeg", [0, mini ? -0.4 : -0.46, 0], "rightUpperLeg");
  bone("rightFoot", [0, mini ? -0.38 : -0.42, 0.03], "rightLowerLeg");
  bone("rightToes", [0, 0, 0.06], "rightFoot");
  for (const side of ["left", "right"]) {
    const sign = side === "left" ? 1 : -1;
    FINGER_CHAINS.forEach((chain, finger) => {
      chain.forEach((suffix, joint) => {
        const name = `${side}${suffix}`;
        const parent = joint === 0 ? `${side}Hand` : `${side}${chain[joint - 1]}`;
        const spread = (finger - 2) * 0.012;
        bone(name, [sign * (joint === 0 ? 0.03 : 0.022), spread, finger === 0 ? 0.016 : 0], parent);
      });
    });
  }
  const world = defs.map(() => new Float32Array(16));
  defs.forEach((entry, index) => {
    const local = translationMat4(...entry.translation);
    world[index] = entry.parent === null ? local : mulMat4(world[entry.parent], local);
  });
  const byName = Object.fromEntries(defs.map((entry, index) => [entry.name, index]));
  const worldPos = (name) => {
    const matrix = world[byName[name]];
    return [matrix[12], matrix[13], matrix[14]];
  };
  return { defs, world, byName, worldPos, mini };
}

class MeshPart {
  constructor(name, materialName) {
    this.name = name;
    this.materialName = materialName;
    this.positions = [];
    this.normals = [];
    this.uvs = [];
    this.indices = [];
    this.joints = [];
    this.weights = [];
    this.hasUv = false;
    this.tags = { lid: [], mouthCorner: [], mouthOpen: [] };
  }

  vertex(x, y, z, nx, ny, nz, bone, tag, uv) {
    const index = this.positions.length / 3;
    this.positions.push(x, y, z);
    const normal = normalize([nx, ny, nz]);
    this.normals.push(normal[0], normal[1], normal[2]);
    this.joints.push(bone, 0, 0, 0);
    this.weights.push(1, 0, 0, 0);
    if (uv) {
      this.hasUv = true;
      this.uvs.push(uv[0], uv[1]);
    } else {
      this.uvs.push(0, 0);
    }
    if (tag && this.tags[tag]) {
      this.tags[tag].push(index);
    }
    return index;
  }

  tri(a, b, c) {
    this.indices.push(a, b, c);
  }

  addEllipsoid(center, radii, segsU, segsV, bone, clip = null) {
    const [cx, cy, cz] = center;
    const [rx, ry, rz] = radii;
    const rings = [];
    for (let v = 0; v <= segsV; v += 1) {
      const phi = (v / segsV) * Math.PI;
      const ring = [];
      for (let u = 0; u <= segsU; u += 1) {
        const theta = (u / segsU) * Math.PI * 2;
        const nx = Math.sin(phi) * Math.cos(theta);
        const ny = Math.cos(phi);
        const nz = Math.sin(phi) * Math.sin(theta);
        const x = cx + rx * nx;
        const y = cy + ry * ny;
        const z = cz + rz * nz;
        if (clip && !clip(x, y, z, nx, ny, nz)) {
          ring.push(-1);
          continue;
        }
        ring.push(this.vertex(x, y, z, nx, ny, nz, bone));
      }
      rings.push(ring);
    }
    for (let v = 0; v < segsV; v += 1) {
      for (let u = 0; u < segsU; u += 1) {
        const a = rings[v][u];
        const b = rings[v + 1][u];
        const c = rings[v + 1][u + 1];
        const d = rings[v][u + 1];
        if (a < 0 || b < 0 || c < 0 || d < 0) {
          continue;
        }
        this.tri(a, b, d);
        this.tri(b, c, d);
      }
    }
  }

  addBox(center, size, bone, tag) {
    const [cx, cy, cz] = center;
    const [sx, sy, sz] = size;
    const hx = sx / 2;
    const hy = sy / 2;
    const hz = sz / 2;
    const faces = [
      { n: [0, 0, 1], corners: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]] },
      { n: [0, 0, -1], corners: [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]] },
      { n: [1, 0, 0], corners: [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]] },
      { n: [-1, 0, 0], corners: [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]] },
      { n: [0, 1, 0], corners: [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]] },
      { n: [0, -1, 0], corners: [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]] },
    ];
    for (const face of faces) {
      const verts = face.corners.map(([x, y, z]) =>
        this.vertex(cx + x * hx, cy + y * hy, cz + z * hz, ...face.n, bone, tag),
      );
      this.tri(verts[0], verts[1], verts[2]);
      this.tri(verts[0], verts[2], verts[3]);
    }
  }

  addCapsule(a, b, radius, segs, boneA, boneB) {
    const axis = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const direction = normalize(axis);
    const helper = Math.abs(direction[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const side = normalize([
      direction[1] * helper[2] - direction[2] * helper[1],
      direction[2] * helper[0] - direction[0] * helper[2],
      direction[0] * helper[1] - direction[1] * helper[0],
    ]);
    const up = [
      side[1] * direction[2] - side[2] * direction[1],
      side[2] * direction[0] - side[0] * direction[2],
      side[0] * direction[1] - side[1] * direction[0],
    ];
    const rings = [];
    const lengthSegs = 7;
    for (let v = 0; v <= lengthSegs; v += 1) {
      const t = v / lengthSegs;
      const ring = [];
      const cx = a[0] + axis[0] * t;
      const cy = a[1] + axis[1] * t;
      const cz = a[2] + axis[2] * t;
      const bone = t < 0.5 ? boneA : boneB;
      for (let u = 0; u <= segs; u += 1) {
        const theta = (u / segs) * Math.PI * 2;
        const nx = Math.cos(theta) * side[0] + Math.sin(theta) * up[0];
        const ny = Math.cos(theta) * side[1] + Math.sin(theta) * up[1];
        const nz = Math.cos(theta) * side[2] + Math.sin(theta) * up[2];
        ring.push(this.vertex(cx + nx * radius, cy + ny * radius, cz + nz * radius, nx, ny, nz, bone));
      }
      rings.push(ring);
    }
    for (let v = 0; v < lengthSegs; v += 1) {
      for (let u = 0; u < segs; u += 1) {
        const p = rings[v][u];
        const q = rings[v + 1][u];
        const r = rings[v + 1][u + 1];
        const s = rings[v][u + 1];
        this.tri(p, q, s);
        this.tri(q, r, s);
      }
    }
    this.addEllipsoid(a, [radius, radius, radius], segs, 5, boneA);
    this.addEllipsoid(b, [radius * 0.9, radius * 0.9, radius * 0.9], segs, 5, boneB);
  }

  addFaceCard(headPos, headR, bone) {
    const cols = 20;
    const rows = 16;
    const verts = [];
    for (let v = 0; v <= rows; v += 1) {
      for (let u = 0; u <= cols; u += 1) {
        const uu = u / cols;
        const vv = v / rows;
        const x = headPos[0] + (uu - 0.5) * headR * 1.52;
        const y = headPos[1] + (0.46 - vv) * headR * 1.42;
        const z = headPos[2] + headR * 0.58 + (0.5 - Math.abs(uu - 0.5)) * 0.045;
        let tag;
        if (vv >= 0.72 && (uu <= 0.32 || uu >= 0.68)) {
          tag = "mouthCorner";
        } else if (vv >= 0.7 && uu > 0.32 && uu < 0.68) {
          tag = "mouthOpen";
        } else if (vv <= 0.42 && ((uu > 0.18 && uu < 0.4) || (uu > 0.6 && uu < 0.82))) {
          tag = "lid";
        }
        verts.push(this.vertex(x, y, z, 0, 0, 1, bone, tag, [uu, 1 - vv]));
      }
    }
    for (let v = 0; v < rows; v += 1) {
      for (let u = 0; u < cols; u += 1) {
        const a = verts[v * (cols + 1) + u];
        const b = verts[v * (cols + 1) + u + 1];
        const c = verts[(v + 1) * (cols + 1) + u + 1];
        const d = verts[(v + 1) * (cols + 1) + u];
        this.tri(a, d, b);
        this.tri(b, d, c);
      }
    }
  }
}

function buildCharacter(spec) {
  const bones = makeBones(spec.body);
  const headPos = bones.worldPos("head");
  const neckPos = bones.worldPos("neck");
  const chestPos = bones.worldPos("upperChest");
  const hipsPos = bones.worldPos("hips");
  const headR = spec.body === "mini" ? 0.112 : 0.102;
  const torsoW = spec.body === "mini" ? 0.13 : 0.145;
  const skin = new MeshPart("BodySkin", "Skin");
  const cloth = new MeshPart("Cloth", "Cloth");
  const inner = new MeshPart("InnerCloth", "Inner");
  const hair = new MeshPart("Hair", "Hair");
  const innerHair = new MeshPart("InnerHair", "Accent");
  const accent = new MeshPart("AccentTrim", "Accent");
  const secondary = new MeshPart("SecondaryCloth", "Secondary");
  const face = new MeshPart("FaceFront", "Face");

  skin.addEllipsoid(headPos, [headR * 0.94, headR, headR * 0.9], 18, 14, bones.byName.head, (_x, _y, z) => z < headPos[2] + headR * 0.35);
  face.addFaceCard(headPos, headR, bones.byName.head);
  skin.addCapsule(neckPos, [chestPos[0], chestPos[1] + 0.03, chestPos[2]], 0.038, 10, bones.byName.neck, bones.byName.upperChest);
  inner.addEllipsoid(
    [hipsPos[0], (hipsPos[1] + chestPos[1]) / 2, hipsPos[2]],
    [torsoW * 0.8, (chestPos[1] - hipsPos[1]) * 0.5, 0.08],
    12,
    8,
    bones.byName.spine,
  );

  for (const side of ["left", "right"]) {
    skin.addCapsule(bones.worldPos(`${side}Shoulder`), bones.worldPos(`${side}UpperArm`), 0.04, 10, bones.byName[`${side}Shoulder`], bones.byName[`${side}UpperArm`]);
    skin.addCapsule(bones.worldPos(`${side}UpperArm`), bones.worldPos(`${side}LowerArm`), 0.034, 10, bones.byName[`${side}UpperArm`], bones.byName[`${side}LowerArm`]);
    skin.addCapsule(bones.worldPos(`${side}LowerArm`), bones.worldPos(`${side}Hand`), 0.028, 10, bones.byName[`${side}LowerArm`], bones.byName[`${side}Hand`]);
    skin.addEllipsoid(bones.worldPos(`${side}Hand`), [0.028, 0.02, 0.016], 8, 6, bones.byName[`${side}Hand`]);
    FINGER_CHAINS.forEach((chain) => {
      const tip = bones.worldPos(`${side}${chain[chain.length - 1]}`);
      skin.addEllipsoid(tip, [0.01, 0.008, 0.008], 6, 4, bones.byName[`${side}${chain[chain.length - 1]}`]);
    });
    skin.addCapsule(bones.worldPos(`${side}UpperLeg`), bones.worldPos(`${side}LowerLeg`), spec.body === "mini" ? 0.056 : 0.05, 10, bones.byName[`${side}UpperLeg`], bones.byName[`${side}LowerLeg`]);
    skin.addCapsule(bones.worldPos(`${side}LowerLeg`), bones.worldPos(`${side}Foot`), 0.042, 10, bones.byName[`${side}LowerLeg`], bones.byName[`${side}Foot`]);
    cloth.addBox(
      [bones.worldPos(`${side}Foot`)[0], bones.worldPos(`${side}Foot`)[1] - 0.02, bones.worldPos(`${side}Foot`)[2] + 0.04],
      [0.08, 0.045, 0.14],
      bones.byName[`${side}Foot`],
    );
  }

  const hipY = hipsPos[1];
  const chestY = chestPos[1];
  if (spec.outfit === "cloak") {
    cloth.addEllipsoid([0, chestY + 0.02, 0], [0.2, 0.08, 0.12], 12, 8, bones.byName.upperChest);
    cloth.addBox([0, chestY + 0.04, -0.01], [0.38, 0.1, 0.18], bones.byName.upperChest);
    secondary.addEllipsoid([0, hipY + 0.02, 0.01], [0.17, 0.16, 0.1], 12, 8, bones.byName.hips);
    cloth.addBox([0, hipY - 0.08, -0.09], [0.42, 0.55, 0.06], bones.byName.hips);
    accent.addBox([0, chestY + 0.08, 0.1], [0.05, 0.05, 0.02], bones.byName.upperChest);
  } else if (spec.outfit === "jacket") {
    cloth.addBox([0, chestY + 0.02, 0.03], [0.28, 0.16, 0.16], bones.byName.upperChest);
    inner.addBox([0, chestY - 0.02, 0.04], [0.16, 0.1, 0.08], bones.byName.chest);
    secondary.addBox([0, hipY + 0.08, 0.02], [0.2, 0.12, 0.12], bones.byName.hips);
    secondary.addBox([0, hipY - 0.12, 0.01], [0.18, 0.28, 0.1], bones.byName.hips);
    accent.addBox([0, hipY + 0.16, 0.1], [0.08, 0.08, 0.03], bones.byName.spine);
  } else if (spec.outfit === "coat") {
    cloth.addBox([0, hipY - 0.12, -0.02], [0.32, 0.72, 0.18], bones.byName.hips);
    inner.addBox([0, chestY, 0.03], [0.18, 0.22, 0.1], bones.byName.chest);
    accent.addBox([0, chestY + 0.08, 0.1], [0.05, 0.18, 0.02], bones.byName.upperChest);
    accent.addBox([0.12, chestY + 0.16, 0.04], [0.08, 0.03, 0.12], bones.byName.upperChest);
  } else {
    cloth.addBox([0, hipY - 0.06, -0.02], [0.28, 0.58, 0.16], bones.byName.hips);
    inner.addBox([0, chestY + 0.02, 0.04], [0.16, 0.18, 0.1], bones.byName.chest);
    accent.addBox([0.1, hipY + 0.04, 0.08], [0.08, 0.1, 0.04], bones.byName.hips);
    secondary.addCapsule(bones.worldPos("leftUpperLeg"), bones.worldPos("leftFoot"), 0.048, 8, bones.byName.leftUpperLeg, bones.byName.leftFoot);
  }

  if (spec.hair === "bob") {
    hair.addEllipsoid([headPos[0], headPos[1] + 0.03, headPos[2] - 0.02], [headR * 1.18, headR * 1.12, headR * 1.2], 16, 12, bones.byName.head, (_x, y) => y > headPos[1] - 0.08);
    hair.addEllipsoid([headPos[0] + 0.1, headPos[1] - 0.01, headPos[2] + 0.02], [0.055, 0.09, 0.07], 10, 8, bones.byName.head);
    hair.addEllipsoid([headPos[0] - 0.1, headPos[1] - 0.01, headPos[2] + 0.02], [0.055, 0.09, 0.07], 10, 8, bones.byName.head);
    hair.addEllipsoid([0.02, headPos[1] + 0.05, 0.09], [0.08, 0.04, 0.035], 8, 6, bones.byName.head);
  } else if (spec.hair === "ponytail") {
    hair.addEllipsoid([headPos[0], headPos[1] + 0.04, headPos[2]], [headR * 1.1, headR * 0.95, headR * 1.1], 16, 11, bones.byName.head, (_x, y) => y > headPos[1] - 0.05);
    hair.addEllipsoid([0, headPos[1] + 0.12, -0.01], [0.05, 0.045, 0.05], 8, 6, bones.byName.head);
    for (let index = 0; index < 6; index += 1) {
      hair.addEllipsoid([0.01 * (index % 2), headPos[1] - 0.01 - index * 0.085, -0.09 - index * 0.018], [0.038, 0.055, 0.038], 8, 6, bones.byName.head);
    }
    accent.addBox([0.02, headPos[1] + 0.1, -0.02], [0.05, 0.03, 0.03], bones.byName.head);
  } else if (spec.hair === "long") {
    hair.addEllipsoid([headPos[0], headPos[1] + 0.05, headPos[2] - 0.01], [headR * 1.12, headR * 1.0, headR * 1.16], 16, 11, bones.byName.head, (_x, y) => y > headPos[1] - 0.04);
    for (let index = 0; index < 8; index += 1) {
      hair.addEllipsoid(
        [0.02 * ((index % 2) * 2 - 1), headPos[1] - 0.02 - index * 0.09, -0.08 - index * 0.012],
        [0.06, 0.075, 0.045],
        8,
        6,
        index < 4 ? bones.byName.head : bones.byName.upperChest,
      );
    }
  } else {
    hair.addEllipsoid([headPos[0], headPos[1] + 0.03, headPos[2] - 0.01], [headR * 1.16, headR * 1.08, headR * 1.18], 16, 12, bones.byName.head, (_x, y) => y > headPos[1] - 0.07);
    hair.addEllipsoid([0.11, headPos[1] - 0.02, 0.02], [0.065, 0.11, 0.06], 10, 8, bones.byName.head);
    innerHair.addEllipsoid([0.08, headPos[1] - 0.04, 0.01], [0.04, 0.08, 0.04], 8, 6, bones.byName.head);
    innerHair.addEllipsoid([-0.02, headPos[1] + 0.01, -0.06], [0.05, 0.07, 0.04], 8, 6, bones.byName.head);
  }

  if (spec.extra === "ribbon") {
    accent.addBox([0.09, headPos[1] + 0.03, 0.04], [0.055, 0.04, 0.02], bones.byName.head);
    accent.addBox([0.12, headPos[1] - 0.02, 0.02], [0.02, 0.07, 0.012], bones.byName.head);
  } else if (spec.extra === "clip") {
    accent.addBox([-0.07, headPos[1] + 0.08, 0.07], [0.055, 0.02, 0.02], bones.byName.head);
  } else if (spec.extra === "glasses") {
    accent.addBox([0.04, headPos[1] + 0.04, 0.11], [0.055, 0.03, 0.012], bones.byName.head);
    accent.addBox([-0.04, headPos[1] + 0.04, 0.11], [0.055, 0.03, 0.012], bones.byName.head);
    accent.addBox([0, headPos[1] + 0.04, 0.11], [0.03, 0.01, 0.01], bones.byName.head);
  } else {
    accent.addBox([0.09, neckPos[1] + 0.02, 0.04], [0.035, 0.035, 0.02], bones.byName.neck);
  }

  const parts = [skin, inner, cloth, secondary, hair, innerHair, accent, face].filter((part) => part.indices.length > 0);
  return { bones, parts, face };
}

function makeMorphTargets(face) {
  const count = face.positions.length / 3;
  const blank = () => new Float32Array(count * 3);
  const apply = (indices, dx, dy, dz) => {
    const delta = blank();
    for (const index of indices) {
      delta[index * 3] += dx;
      delta[index * 3 + 1] += dy;
      delta[index * 3 + 2] += dz;
    }
    return delta;
  };
  return {
    names: ["happy", "relaxed", "surprised", "sad", "aa", "blink"],
    deltas: [
      apply(face.tags.mouthCorner, 0, 0.016, 0.004),
      apply(face.tags.lid, 0, -0.008, 0),
      (() => {
        const delta = apply(face.tags.mouthOpen, 0, -0.018, 0.006);
        for (const index of face.tags.lid) {
          delta[index * 3 + 1] += 0.01;
        }
        return delta;
      })(),
      apply(face.tags.mouthCorner, 0, -0.014, 0),
      apply(face.tags.mouthOpen, 0, -0.022, 0.008),
      apply(face.tags.lid, 0, -0.024, 0.002),
    ],
  };
}

function packAttribute(values, size) {
  const array = new Float32Array(values);
  let min;
  let max;
  if (size === 2 || size === 3) {
    min = Array.from({ length: size }, () => Infinity);
    max = Array.from({ length: size }, () => -Infinity);
    for (let index = 0; index < array.length; index += size) {
      for (let axis = 0; axis < size; axis += 1) {
        min[axis] = Math.min(min[axis], array[index + axis]);
        max[axis] = Math.max(max[axis], array[index + axis]);
      }
    }
  }
  return { array, min, max, count: array.length / size };
}

function shadeFactor(hex, amount) {
  return hexToRgba(hex).slice(0, 3).map((channel) => Math.max(0, channel * amount));
}

function mtoonExtension(hex, outline = 0.0035) {
  return {
    specVersion: "1.0",
    transparentWithZWrite: false,
    renderQueueOffsetNumber: 0,
    shadeColorFactor: shadeFactor(hex, 0.62),
    shadingShiftFactor: -0.04,
    shadingToonyFactor: 0.92,
    giEqualizationFactor: 0.8,
    matcapFactor: [1, 1, 1],
    parametricRimColorFactor: [0, 0, 0],
    parametricRimFresnelPowerFactor: 5,
    parametricRimLiftFactor: 0,
    rimLightingMixFactor: 0,
    outlineWidthMode: "worldCoordinates",
    outlineWidthFactor: outline,
    outlineColorFactor: [0.08, 0.06, 0.07],
    outlineLightingMixFactor: 1,
    uvAnimationScrollXSpeedFactor: 0,
    uvAnimationScrollYSpeedFactor: 0,
    uvAnimationRotationSpeedFactor: 0,
  };
}

function makeVrm(spec) {
  const { bones, parts, face } = buildCharacter(spec);
  const morphs = makeMorphTargets(face);
  const facePng = paintFaceTexture(spec);
  const binaryParts = [];
  const bufferViews = [];
  const accessors = [];
  let byteOffset = 0;
  const addBuffer = (buffer, extra = {}) => {
    const source = Buffer.isBuffer(buffer)
      ? buffer
      : Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const padded = pad(source);
    const viewIndex = bufferViews.length;
    bufferViews.push({ buffer: 0, byteLength: padded.length, byteOffset, ...extra });
    binaryParts.push(padded);
    byteOffset += padded.length;
    return viewIndex;
  };
  const addAccessor = (buffer, accessor, extraView) => {
    const viewIndex = addBuffer(buffer, extraView);
    const accessorIndex = accessors.length;
    accessors.push({ bufferView: viewIndex, byteOffset: 0, ...accessor });
    return accessorIndex;
  };

  const imageView = addBuffer(facePng);
  const materials = [];
  const materialIndex = new Map();
  const ensureMaterial = (name, hex, doubleSided = false, textured = false) => {
    if (materialIndex.has(name)) {
      return materialIndex.get(name);
    }
    const index = materials.length;
    materials.push({
      name,
      doubleSided,
      pbrMetallicRoughness: {
        baseColorFactor: textured ? [1, 1, 1, 1] : hexToRgba(hex),
        metallicFactor: 0,
        roughnessFactor: 0.68,
        ...(textured ? { baseColorTexture: { index: 0 } } : {}),
      },
      extensions: {
        VRMC_materials_mtoon: mtoonExtension(hex, name === "Hair" || name === "Face" ? 0.0028 : 0.0036),
      },
    });
    materialIndex.set(name, index);
    return index;
  };
  ensureMaterial("Skin", spec.palette.skin);
  ensureMaterial("Inner", spec.palette.inner);
  ensureMaterial("Cloth", spec.palette.outfit, true);
  ensureMaterial("Secondary", spec.palette.secondary ?? spec.palette.outfit, true);
  ensureMaterial("Hair", spec.palette.hair, true);
  ensureMaterial("Accent", spec.palette.accent);
  ensureMaterial("Face", spec.palette.skin, false, true);

  const meshes = [];
  const meshNodes = [];
  for (const part of parts) {
    const position = packAttribute(part.positions, 3);
    const normal = packAttribute(part.normals, 3);
    const indices = Uint16Array.from(part.indices);
    if (part.positions.length / 3 > 65535) {
      throw new Error(`${part.name} exceeds 16-bit indices.`);
    }
    const joints = Uint8Array.from(part.joints);
    const weights = Float32Array.from(part.weights);
    const primitive = {
      attributes: {
        POSITION: addAccessor(position.array, {
          componentType: 5126,
          count: position.count,
          max: position.max,
          min: position.min,
          type: "VEC3",
        }),
        NORMAL: addAccessor(normal.array, {
          componentType: 5126,
          count: normal.count,
          type: "VEC3",
        }),
        JOINTS_0: addAccessor(joints, {
          componentType: 5121,
          count: joints.length / 4,
          type: "VEC4",
        }),
        WEIGHTS_0: addAccessor(weights, {
          componentType: 5126,
          count: weights.length / 4,
          type: "VEC4",
        }),
      },
      indices: addAccessor(indices, {
        componentType: 5123,
        count: indices.length,
        type: "SCALAR",
      }),
      material: ensureMaterial(part.materialName, spec.palette.skin, part.materialName === "Hair" || part.materialName === "Cloth"),
    };
    if (part.hasUv) {
      const uv = packAttribute(part.uvs, 2);
      primitive.attributes.TEXCOORD_0 = addAccessor(uv.array, {
        componentType: 5126,
        count: uv.count,
        type: "VEC2",
      });
    }
    if (part === face) {
      primitive.targets = morphs.deltas.map((delta) => {
        const packed = packAttribute(delta, 3);
        return {
          POSITION: addAccessor(packed.array, {
            componentType: 5126,
            count: packed.count,
            max: packed.max,
            min: packed.min,
            type: "VEC3",
          }),
        };
      });
      primitive.extras = { targetNames: morphs.names };
    }
    meshes.push({
      name: part.name,
      extras: part === face ? { targetNames: morphs.names } : undefined,
      primitives: [primitive],
      weights: part === face ? morphs.names.map(() => 0) : undefined,
    });
  }

  const inverseBind = new Float32Array(bones.defs.length * 16);
  bones.world.forEach((matrix, index) => {
    inverseBind.set(inverseMat4(matrix), index * 16);
  });
  const ibmAccessor = addAccessor(inverseBind, {
    componentType: 5126,
    count: bones.defs.length,
    type: "MAT4",
  });

  const childrenByParent = new Map();
  bones.defs.forEach((bone, index) => {
    if (bone.parent === null) {
      return;
    }
    const children = childrenByParent.get(bone.parent) ?? [];
    children.push(index);
    childrenByParent.set(bone.parent, children);
  });

  const nodes = bones.defs.map((bone, index) => ({
    name: bone.name,
    translation: bone.translation,
    ...(childrenByParent.has(index) ? { children: childrenByParent.get(index) } : {}),
  }));
  const faceNodeIndex = [];
  meshes.forEach((mesh, meshIndex) => {
    const nodeIndex = nodes.length;
    nodes.push({
      name: mesh.name,
      mesh: meshIndex,
      skin: 0,
    });
    meshNodes.push(nodeIndex);
    if (mesh.name === "FaceFront") {
      faceNodeIndex.push(nodeIndex);
    }
  });

  const bindExpression = (names, weight = 1) => ({
    isBinary: false,
    morphTargetBinds: names.map((name) => ({
      node: faceNodeIndex[0],
      index: morphs.names.indexOf(name),
      weight,
    })),
    overrideBlink: "none",
    overrideLookAt: "none",
    overrideMouth: "none",
  });

  const binary = Buffer.concat(binaryParts);
  const humanBones = Object.fromEntries(
    bones.defs
      .map((bone) => [bone.name, { node: bones.byName[bone.name] }]),
  );
  const document = {
    asset: {
      version: "2.0",
      generator: "Companion Space original VRM generator",
      extras: {
        characterId: spec.id,
        license: "VRM-Public-License-1.0",
        originalCustom: true,
        quality: "stylized-production",
        provenance: "Project-owned stylized production VRM with painted face map and MToon outlines.",
        source: "scripts/generate-original-vrm.mjs",
      },
    },
    scene: 0,
    scenes: [{ nodes: [0, ...meshNodes] }],
    nodes,
    meshes,
    skins: [{
      inverseBindMatrices: ibmAccessor,
      joints: bones.defs.map((_bone, index) => index),
      skeleton: 0,
    }],
    materials,
    textures: [{ sampler: 0, source: 0 }],
    images: [{ mimeType: "image/png", bufferView: imageView }],
    samplers: [{ magFilter: 9729, minFilter: 9729, wrapS: 33071, wrapT: 33071 }],
    accessors,
    bufferViews,
    buffers: [{ byteLength: binary.length }],
    extensionsUsed: ["VRMC_vrm", "VRMC_materials_mtoon"],
    extensions: {
      VRMC_vrm: {
        specVersion: "1.0",
        meta: {
          name: spec.name,
          version: "1.1.0",
          authors: spec.authors,
          copyrightInformation: "Companion Space original custom study companion. Not a third-party sample VRM.",
          contactInformation: "",
          references: [],
          thirdPartyLicenses: "",
          licenseUrl: "https://vrm.dev/licenses/1.0/",
          avatarPermission: "everyone",
          allowExcessivelyViolentUsage: false,
          allowExcessivelySexualUsage: false,
          allowPoliticalOrReligiousUsage: false,
          allowAntisocialOrHateUsage: false,
          commercialUsage: "personalProfit",
          creditNotation: "unnecessary",
          allowRedistribution: true,
          modification: "allowModificationRedistribution",
        },
        humanoid: { humanBones },
        firstPerson: { meshAnnotations: [] },
        lookAt: {
          offsetFromHeadBone: [0, 0.04, 0.09],
          type: "bone",
          rangeMapHorizontalInner: { inputMaxValue: 90, outputScale: 8 },
          rangeMapHorizontalOuter: { inputMaxValue: 90, outputScale: 8 },
          rangeMapVerticalDown: { inputMaxValue: 90, outputScale: 8 },
          rangeMapVerticalUp: { inputMaxValue: 90, outputScale: 8 },
        },
        expressions: {
          preset: {
            happy: bindExpression(["happy"]),
            relaxed: bindExpression(["relaxed"]),
            surprised: bindExpression(["surprised"]),
            sad: bindExpression(["sad"]),
            aa: bindExpression(["aa"]),
            ih: bindExpression(["aa"], 0.45),
            ou: bindExpression(["aa"], 0.55),
            ee: bindExpression(["aa"], 0.35),
            oh: bindExpression(["aa"], 0.7),
            blink: bindExpression(["blink"]),
            blinkLeft: bindExpression(["blink"], 0.85),
            blinkRight: bindExpression(["blink"], 0.85),
            neutral: bindExpression([]),
          },
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
      throw new Error(`${filename} does not match the original VRM generator.`);
    }
    return;
  }
  writeFileSync(path, data);
}

if (checkOnly && !forcePrototype) {
  const manifestPath = `${outputRoot}manifest.json`;
  if (!existsSync(manifestPath)) {
    throw new Error("The published VRM manifest is missing.");
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const originalModels = manifest.models.filter((entry) => entry.original_custom);
  if (originalModels.length !== CHARACTERS.length) {
    throw new Error(`Expected ${CHARACTERS.length} original VRMs, found ${originalModels.length}.`);
  }
  for (const model of originalModels) {
    const modelPath = `${outputRoot}${model.file}`;
    if (!existsSync(modelPath)) {
      throw new Error(`${model.file} is missing from the published VRM assets.`);
    }
    const data = readFileSync(modelPath);
    const sha256 = createHash("sha256").update(data).digest("hex");
    if (sha256 !== model.sha256) {
      throw new Error(`${model.file} does not match the published manifest hash.`);
    }
    if (data.length !== model.bytes) {
      throw new Error(`${model.file} does not match the published manifest byte count.`);
    }
    console.log(`${model.id}\t${data.length}\t${sha256}`);
  }
  process.exit(0);
}

if (existsSync(blenderMarkerPath) && !forcePrototype) {
  throw new Error(
    "Blender-built VRMs are locked. Pass --prototype to overwrite with the Node generator, or rebuild with scripts/blender/build_original_companions.py.",
  );
}

if (!checkOnly) {
  mkdirSync(outputRoot, { recursive: true });
}

const originalModels = CHARACTERS.map((spec) => {
  const data = makeVrm(spec);
  const sha256 = createHash("sha256").update(data).digest("hex");
  if (SAMPLE_SHA256.has(sha256)) {
    throw new Error(`${spec.id} hashed to a third-party sample; generation failed.`);
  }
  if (data.length < 20_000 || data.length > 12_000_000) {
    throw new Error(`${spec.id} size ${data.length} is outside the expected original VRM range.`);
  }
  publish(spec.file, data);
  return {
    id: spec.id,
    name: spec.name,
    file: spec.file,
    format: "vrm1",
    author: "Companion Space project",
    license: "VRM Public License 1.0",
    redistribution_allowed: true,
    modification_allowed: true,
    attribution_required: false,
    avatar_permission: "everyone",
    commercial_usage: "personalProfit",
    credit_notation: "unnecessary",
    allow_excessively_violent_usage: false,
    allow_excessively_sexual_usage: false,
    allow_political_or_religious_usage: false,
    allow_antisocial_or_hate_usage: false,
    usage_restrictions: [
      "corporate commercial use is not granted",
      "no excessively violent or sexual usage",
      "no political, religious, antisocial, or hate usage",
    ],
    original_custom: true,
    featured_preset: true,
    quality: "stylized-production",
    sha256,
    bytes: data.length,
  };
});

const sampleModels = [
  {
    id: "vrm1_constraint_twist_sample",
    name: "Constraint Sample",
    file: "VRM1_Constraint_Twist_Sample.vrm",
    format: "vrm1",
    author: "pixiv Inc.",
    license: "VRM Public License 1.0",
    redistribution_allowed: true,
    modification_allowed: true,
    attribution_required: false,
    featured_preset: false,
    sha256: "12c2b97e95e700783a6a550dc0eee2d7880aeedccef9ae67bc4c5a2f0f2631a2",
  },
  {
    id: "seed_san",
    name: "Seed-san Sample",
    file: "Seed-san.vrm",
    format: "vrm1",
    author: "VirtualCast, Inc.",
    license: "VRM Public License 1.0",
    redistribution_allowed: true,
    modification_allowed: true,
    attribution_required: true,
    featured_preset: false,
    sha256: "624d0d554bc205bbdc33e22a68a2c3c20edebb3e573011ead8878a65e5329b23",
  },
  {
    id: "sendagaya_shino",
    name: "Sendagaya Shino Sample",
    file: "Sendagaya-Shino.vrm",
    format: "vrm0",
    author: "VRoid Project / pixiv Inc.",
    license: "CC0 1.0 Universal",
    redistribution_allowed: true,
    modification_allowed: true,
    attribution_required: false,
    featured_preset: false,
    sha256: "f11b2648e7e588ae171ad1c32e465f84e5b130b1d1789e3a3702946c0981d2a9",
  },
  {
    id: "sakurada_fumiriya",
    name: "Sakurada Fumiriya Sample",
    file: "Sakurada-Fumiriya.vrm",
    format: "vrm0",
    author: "VRoid Project / pixiv Inc.",
    license: "CC0 1.0 Universal",
    redistribution_allowed: true,
    modification_allowed: true,
    attribution_required: false,
    featured_preset: false,
    sha256: "a36e91b81518c59f6da0e3f34a176b79090a8c68cc6bd5fe03c1560744b283f3",
  },
];

publish(
  "manifest.json",
  `${JSON.stringify({
    schema_version: 1,
    repository_notice: "assets/THIRD_PARTY_NOTICES.md",
    original_generator: "scripts/generate-original-vrm.mjs",
    models: [...originalModels, ...sampleModels],
  }, null, 2)}\n`,
);

for (const model of originalModels) {
  console.log(`${model.id}\t${model.bytes}\t${model.sha256}`);
}
