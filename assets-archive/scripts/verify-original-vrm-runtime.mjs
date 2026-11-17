import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { VRMLoaderPlugin } from "@pixiv/three-vrm";
import { Box3, Raycaster, Vector3 } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

globalThis.self ??= globalThis;
globalThis.createImageBitmap ??= async () => ({
  width: 1,
  height: 1,
  close() {},
});

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const modelRoot = join(repositoryRoot, "apps/web/public/assets/characters/models");
const originals = [
  ["mira", "Mira.vrm"],
  ["kite", "Kite.vrm"],
  ["cael", "Cael.vrm"],
  ["lyra", "Lyra.vrm"],
  ["nova", "Nova.vrm"],
  ["echo", "Echo.vrm"],
];
const expressions = ["happy", "relaxed", "surprised", "sad", "aa", "ih", "ou", "ee", "oh"];
const deformationExpressions = [...expressions, "blink"];
const localizedExpressions = new Set(["happy", "sad", "aa", "ih", "ou", "ee", "oh", "blink"]);
const paintedFaceLandmarks = {
  mira: [
    ["browL", 0.3, 0.32],
    ["browR", 0.72, 0.32],
    ["eyeL", 0.3, 0.49],
    ["eyeR", 0.72, 0.49],
    ["mouth", 0.5, 0.78],
  ],
  kite: [
    ["browL", 0.28, 0.33],
    ["browR", 0.73, 0.33],
    ["eyeL", 0.28, 0.48],
    ["eyeR", 0.73, 0.48],
    ["mouth", 0.5, 0.78],
  ],
  cael: [
    ["browL", 0.28, 0.32],
    ["browR", 0.72, 0.32],
    ["eyeL", 0.28, 0.41],
    ["eyeR", 0.72, 0.41],
    ["mouth", 0.5, 0.81],
  ],
  lyra: [
    ["browL", 0.3, 0.4],
    ["browR", 0.7, 0.4],
    ["eyeL", 0.3, 0.53],
    ["eyeR", 0.7, 0.53],
    ["mouth", 0.5, 0.8],
  ],
};
const prototypeFaceLandmarks = {
  nova: [
    ["eyeL", 168 / 512, 232 / 512],
    ["eyeR", 344 / 512, 232 / 512],
    ["mouth", 0.5, 348 / 512],
  ],
  echo: [
    ["eyeL", 168 / 512, 232 / 512],
    ["eyeR", 344 / 512, 232 / 512],
    ["mouth", 0.5, 348 / 512],
  ],
};

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function parseVrm(path) {
  const bytes = await readFile(path);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  return new Promise((resolve, reject) => loader.parse(buffer, "", resolve, reject));
}

function materialNames(vrm) {
  const names = [];
  vrm.scene.traverse((node) => {
    const materials = Array.isArray(node.material) ? node.material : node.material ? [node.material] : [];
    for (const material of materials) {
      if (material?.name) {
        names.push(material.name);
      }
    }
  });
  return names;
}

function finiteVector(vector) {
  return Number.isFinite(vector.x) && Number.isFinite(vector.y) && Number.isFinite(vector.z);
}

function baseVertexBounds(mesh) {
  const position = mesh.geometry?.attributes?.position;
  assert(position, `${mesh.name} has no position attribute.`);
  mesh.updateMatrixWorld(true);
  const bounds = new Box3();
  const vertex = new Vector3();
  for (let index = 0; index < position.count; index += 1) {
    vertex.fromBufferAttribute(position, index).applyMatrix4(mesh.matrixWorld);
    assert(finiteVector(vertex), `${mesh.name} base vertex ${index} is not finite.`);
    bounds.expandByPoint(vertex);
  }
  return bounds;
}

function evaluatedVertices(mesh) {
  const position = mesh.geometry?.attributes?.position;
  assert(position, `${mesh.name} has no position attribute.`);
  assert(typeof mesh.getVertexPosition === "function", `${mesh.name} cannot evaluate morphed vertices.`);
  mesh.updateMatrixWorld(true);
  const bounds = new Box3();
  const vertices = [];
  const vertex = new Vector3();
  for (let index = 0; index < position.count; index += 1) {
    mesh.getVertexPosition(index, vertex);
    vertex.applyMatrix4(mesh.matrixWorld);
    assert(finiteVector(vertex), `${mesh.name} evaluated vertex ${index} is not finite.`);
    vertices.push(vertex.clone());
    bounds.expandByPoint(vertex);
  }
  return { bounds, vertices };
}

function maxVertexDelta(vertices, baseline) {
  assert(vertices.length === baseline.length, "Expression evaluation changed the face vertex count.");
  let maxDelta = 0;
  let movedVertices = 0;
  for (let index = 0; index < vertices.length; index += 1) {
    const delta = vertices[index].distanceTo(baseline[index]);
    assert(Number.isFinite(delta), `Face vertex ${index} produced a non-finite delta.`);
    if (delta > 1e-6) {
      movedVertices += 1;
    }
    maxDelta = Math.max(maxDelta, delta);
  }
  return { maxDelta, movedVertices };
}

function nearestUvVertex(mesh, targetU, targetV) {
  const uv = mesh.geometry?.attributes?.uv;
  assert(uv, `${mesh.name} has no UV attribute.`);
  let nearestIndex = -1;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < uv.count; index += 1) {
    const du = uv.getX(index) - targetU;
    const dv = uv.getY(index) - targetV;
    const distance = du * du + dv * dv;
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestIndex = index;
    }
  }
  assert(nearestIndex >= 0, `${mesh.name} has no UV vertices.`);
  return nearestIndex;
}

function facePointAtUv(face, u, v) {
  const vertexIndex = nearestUvVertex(face, u, v);
  const point = new Vector3();
  face.getVertexPosition(vertexIndex, point);
  return point.applyMatrix4(face.matrixWorld);
}

function blockedFaceLandmarks(face, occluders, landmarks) {
  const raycaster = new Raycaster();
  const rayOrigin = new Vector3();
  const rayDirection = new Vector3(0, 0, -1);
  const blocked = [];
  for (const [name, u, v] of landmarks) {
    const facePoint = facePointAtUv(face, u, v);
    rayOrigin.set(facePoint.x, facePoint.y, facePoint.z + 1);
    raycaster.set(rayOrigin, rayDirection);
    const blocker = raycaster
      .intersectObjects(occluders, true)
      .find((hit) => hit.point.z > facePoint.z + 1e-4);
    if (blocker) {
      blocked.push(`${name}:${blocker.object.name}@+${(blocker.point.z - facePoint.z).toFixed(4)}m`);
    }
  }
  return blocked;
}

function faceOccluders(vrm) {
  const body = vrm.scene.getObjectByName("BodySkin");
  const hair = vrm.scene.getObjectByName("Hair");
  return {
    missing: [!body?.isMesh ? "BodySkin" : null, !hair?.isMesh ? "Hair" : null].filter(Boolean),
    objects: [body?.isMesh ? body : null, hair?.isMesh ? hair : null].filter(Boolean),
  };
}

function inspectPaintedFaceVisibility(id, filename, vrm, face) {
  const landmarks = paintedFaceLandmarks[id];
  if (!landmarks) {
    return { failures: [], metric: "faceLandmarks=n/a" };
  }
  const occluders = faceOccluders(vrm);
  if (occluders.missing.length) {
    return {
      failures: [`${filename}: painted face occlusion check is missing ${occluders.missing.join(" and ")} mesh.`],
      metric: `faceLandmarks=0/${landmarks.length}`,
    };
  }

  vrm.scene.updateMatrixWorld(true);
  const blocked = blockedFaceLandmarks(face, occluders.objects, landmarks);

  return {
    failures: blocked.length === 0
      ? []
      : [`${filename}: ${blocked.length}/${landmarks.length} painted face landmarks are occluded (${blocked.join(", ")}).`],
    metric: `faceLandmarks=${landmarks.length - blocked.length}/${landmarks.length}`,
  };
}

function inspectFaceUvOrientation(filename, face) {
  const topTexturePoint = facePointAtUv(face, 0.5, 0.1);
  const bottomTexturePoint = facePointAtUv(face, 0.5, 0.9);
  return {
    failures: topTexturePoint.y > bottomTexturePoint.y + 0.05
      ? []
      : [
          `${filename}: FaceFront glTF UV orientation is inverted; top texture V maps to Y=${topTexturePoint.y.toFixed(3)}m and bottom V maps to Y=${bottomTexturePoint.y.toFixed(3)}m.`,
        ],
    metric: `faceUvY=${topTexturePoint.y.toFixed(3)}>${bottomTexturePoint.y.toFixed(3)}`,
  };
}

function inspectPrototypeFaceVisibility(id, filename, vrm, face) {
  const landmarks = prototypeFaceLandmarks[id];
  if (!landmarks) {
    return { failures: [], metric: "prototypeFace=n/a" };
  }
  const occluders = faceOccluders(vrm);
  if (occluders.missing.length) {
    return {
      failures: [`${filename}: prototype face occlusion check is missing ${occluders.missing.join(" and ")} mesh.`],
      metric: `prototypeFace=0/${landmarks.length}`,
    };
  }

  vrm.scene.updateMatrixWorld(true);
  const blocked = blockedFaceLandmarks(face, occluders.objects, landmarks);
  const failures = [];
  if (blocked.length) {
    failures.push(
      `${filename}: ${blocked.length}/${landmarks.length} prototype face landmarks are occluded (${blocked.join(", ")}).`,
    );
  }
  return {
    failures,
    metric: `prototypeFace=${landmarks.length - blocked.length}/${landmarks.length}`,
  };
}

function inspectAvatarGeometry(id, filename, vrm) {
  const failures = [];
  const expect = (condition, message) => {
    if (!condition) {
      failures.push(`${filename}: ${message}`);
    }
  };
  const face = vrm.scene.getObjectByName("FaceFront");
  const body = vrm.scene.getObjectByName("BodySkin");
  expect(Boolean(face?.isMesh), "FaceFront mesh is missing.");
  expect(Boolean(body?.isMesh), "BodySkin mesh is missing.");
  if (!face?.isMesh || !body?.isMesh) {
    return { failures, metric: "geometry=unavailable" };
  }

  for (const expression of deformationExpressions) {
    vrm.expressionManager.setValue(expression, 0);
  }
  vrm.update(0);
  vrm.scene.updateMatrixWorld(true);

  const faceBaseBounds = baseVertexBounds(face);
  const faceBaseSize = faceBaseBounds.getSize(new Vector3());
  const faceBaseCenter = faceBaseBounds.getCenter(new Vector3());
  const bodyRest = evaluatedVertices(body);
  const bodyRestSize = bodyRest.bounds.getSize(new Vector3());
  const faceHeightRatio = faceBaseSize.y / bodyRestSize.y;
  const faceAspect = faceBaseSize.y / faceBaseSize.x;
  const head = vrm.humanoid?.getRawBoneNode?.("head");
  const headPosition = head?.getWorldPosition(new Vector3()) ?? null;
  const headDistance = headPosition ? faceBaseCenter.distanceTo(headPosition) : Number.POSITIVE_INFINITY;

  expect(finiteVector(faceBaseSize) && faceBaseSize.x > 0 && faceBaseSize.y > 0 && faceBaseSize.z >= 0, "FaceFront base bounds are invalid.");
  expect(finiteVector(bodyRestSize) && bodyRestSize.x > 0 && bodyRestSize.y > 0 && bodyRestSize.z > 0, "BodySkin rest bounds are invalid.");
  expect(faceBaseSize.y < 0.25, `FaceFront base height ${faceBaseSize.y.toFixed(3)}m must be under 0.25m.`);
  expect(faceHeightRatio < 0.2, `FaceFront/body height ratio ${faceHeightRatio.toFixed(3)} must be under 0.20.`);
  expect(faceAspect >= 0.65 && faceAspect <= 1.4, `FaceFront height/width aspect ${faceAspect.toFixed(3)} must be within 0.65..1.40.`);
  expect(Boolean(headPosition && finiteVector(headPosition)), "Raw humanoid head landmark is unavailable.");
  expect(headDistance < 0.2, `FaceFront center is ${headDistance.toFixed(3)}m from the head landmark; expected under 0.20m.`);

  const faceRest = evaluatedVertices(face);
  const faceVisibility = inspectPaintedFaceVisibility(id, filename, vrm, face);
  failures.push(...faceVisibility.failures);
  const faceUvOrientation = inspectFaceUvOrientation(filename, face);
  failures.push(...faceUvOrientation.failures);
  const prototypeFaceVisibility = inspectPrototypeFaceVisibility(id, filename, vrm, face);
  failures.push(...prototypeFaceVisibility.failures);
  for (const expression of deformationExpressions) {
    vrm.expressionManager.setValue(expression, 1);
    vrm.update(0);
    vrm.scene.updateMatrixWorld(true);
    const active = evaluatedVertices(face);
    const activeSize = active.bounds.getSize(new Vector3());
    const { maxDelta, movedVertices } = maxVertexDelta(active.vertices, faceRest.vertices);
    expect(
      finiteVector(activeSize) && activeSize.x > 0 && activeSize.y > 0 && activeSize.z >= 0,
      `${expression} produced invalid FaceFront bounds.`,
    );
    expect(
      activeSize.x < faceBaseSize.x * 1.5 + 0.05
        && activeSize.y < faceBaseSize.y * 1.5 + 0.05
        && activeSize.z < faceBaseSize.z + 0.1,
      `${expression} expanded FaceFront beyond its rest envelope: ${activeSize.toArray().map((value) => value.toFixed(3)).join(",")}m.`,
    );
    expect(movedVertices > 0, `${expression} did not deform FaceFront geometry.`);
    expect(movedVertices < active.vertices.length, `${expression} deformed every FaceFront vertex instead of a facial region.`);
    expect(maxDelta < 0.08, `${expression} moved a FaceFront vertex ${maxDelta.toFixed(3)}m; expected under 0.08m.`);
    if (localizedExpressions.has(expression)) {
      expect(
        movedVertices / active.vertices.length < 0.5,
        `${expression} affected ${(movedVertices / active.vertices.length).toFixed(3)} of FaceFront vertices; expected a localized region under 0.50.`,
      );
    }

    vrm.expressionManager.setValue(expression, 0);
    vrm.update(0);
    vrm.scene.updateMatrixWorld(true);
    const reset = evaluatedVertices(face);
    const resetDelta = maxVertexDelta(reset.vertices, faceRest.vertices).maxDelta;
    expect(resetDelta < 1e-6, `${expression} did not reset FaceFront to rest geometry (delta ${resetDelta.toExponential(3)}m).`);
  }

  return {
    failures,
    metric: [
      `face=${faceBaseSize.toArray().map((value) => value.toFixed(3)).join(",")}`,
      `body=${bodyRestSize.toArray().map((value) => value.toFixed(3)).join(",")}`,
      `faceBody=${faceHeightRatio.toFixed(3)}`,
      `faceAspect=${faceAspect.toFixed(3)}`,
      `headDelta=${headDistance.toFixed(3)}`,
      faceVisibility.metric,
      faceUvOrientation.metric,
      prototypeFaceVisibility.metric,
      `deformations=${deformationExpressions.length}`,
    ].join("\t"),
  };
}

async function main() {
  const geometryFailures = [];
  for (const [id, filename] of originals) {
    const gltf = await parseVrm(join(modelRoot, filename));
    const vrm = gltf.userData.vrm;
    assert(vrm, `${filename} did not load as a VRM.`);
    assert(vrm.meta.metaVersion === "1", `${filename} is not VRM 1.0.`);
    assert(vrm.meta.avatarPermission === "everyone", `${filename} has unexpected avatar permission.`);
    assert(vrm.meta.commercialUsage === "personalProfit", `${filename} has unexpected commercial usage.`);
    assert(vrm.meta.creditNotation === "unnecessary", `${filename} has unexpected credit requirement.`);
    assert(vrm.meta.allowRedistribution === true, `${filename} must allow redistribution.`);
    assert(vrm.meta.modification === "allowModificationRedistribution", `${filename} has unexpected modification permission.`);
    assert(vrm.meta.allowExcessivelyViolentUsage === false, `${filename} must forbid excessively violent usage.`);
    assert(vrm.meta.allowExcessivelySexualUsage === false, `${filename} must forbid excessively sexual usage.`);
    assert(vrm.meta.allowPoliticalOrReligiousUsage === false, `${filename} must forbid political or religious usage.`);
    assert(vrm.meta.allowAntisocialOrHateUsage === false, `${filename} must forbid antisocial or hate usage.`);
    const names = new Set(vrm.expressionManager?.expressions?.map((item) => item.expressionName) ?? []);
    if (names.size === 0 && vrm.expressionManager?.expressionMap) {
      for (const key of Object.keys(vrm.expressionManager.expressionMap)) {
        names.add(key);
      }
    }
    for (const expression of expressions) {
      assert(names.has(expression), `${filename} is missing expression ${expression}.`);
      vrm.expressionManager.setValue(expression, 1);
      const value = vrm.expressionManager.getValue(expression);
      assert(value >= 0.99, `${filename} ${expression} did not stick (got ${value}).`);
      vrm.expressionManager.setValue(expression, 0);
    }
    const mats = materialNames(vrm);
    assert(mats.some((name) => /face/i.test(name)), `${filename} has no Face material.`);
    const geometry = inspectAvatarGeometry(id, filename, vrm);
    geometryFailures.push(...geometry.failures);
    console.log(`${id}\tload=ok\texpressions=${expressions.join(",")}\tmaterials=${mats.length}\t${geometry.metric}`);
  }
  assert(
    geometryFailures.length === 0,
    `Original VRM geometry validation failed:\n- ${geometryFailures.join("\n- ")}`,
  );
  console.log("original VRM three-vrm smoke passed: 6 models x happy/relaxed/surprised/sad.");
}

await main();
