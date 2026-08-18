import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { VRMLoaderPlugin } from "@pixiv/three-vrm";
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
];
const expressions = ["happy", "relaxed", "surprised", "sad", "aa", "ih", "ou", "ee", "oh"];

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

async function main() {
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
    console.log(`${id}\tload=ok\texpressions=${expressions.join(",")}\tmaterials=${mats.length}`);
  }
  console.log("original VRM three-vrm smoke passed: 4 models x happy/relaxed/surprised/sad.");
}

await main();
