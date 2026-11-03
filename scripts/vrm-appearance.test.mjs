import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { MToonMaterial } from "@pixiv/three-vrm-materials-mtoon";
import * as THREE from "three";
import ts from "typescript";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

async function loadAppearanceModule(runtimeRecipe) {
  const sourcePath = join(repositoryRoot, "apps/web/components/avatar/vrm-appearance.ts");
  const source = await readFile(sourcePath, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: sourcePath,
  }).outputText;
  const module = { exports: {} };
  const sandbox = {
    exports: module.exports,
    module,
    require(specifier) {
      if (specifier === "@/components/avatar/vrm-recipe") {
        return { getRuntimeRecipeView: () => runtimeRecipe };
      }
      throw new Error(`Unexpected vrm-appearance dependency: ${specifier}`);
    },
  };
  vm.runInNewContext(compiled, sandbox, { filename: sourcePath });
  return module.exports;
}

function makeMaterial(name, index) {
  const material = new MToonMaterial();
  material.name = name;
  material.color.setRGB(0.05 + index * 0.03, 0.08 + index * 0.02, 0.11 + index * 0.01);
  material.shadeColorFactor.setRGB(0.13 + index * 0.02, 0.16 + index * 0.02, 0.19 + index * 0.02);
  material.emissive.setRGB(0.21 + index * 0.02, 0.24 + index * 0.02, 0.27 + index * 0.02);
  material.emissiveIntensity = 0.35 + index * 0.25;
  material.parametricRimColorFactor.setRGB(0.31 + index * 0.02, 0.34 + index * 0.02, 0.37 + index * 0.02);
  material.parametricRimLiftFactor = 0.15 + index * 0.1;
  material.parametricRimFresnelPowerFactor = 1.5 + index;
  material.rimLightingMixFactor = 0.2 + index * 0.15;
  material.uniforms.rimColorFactor = {
    value: new THREE.Color(0.41 + index * 0.02, 0.44 + index * 0.02, 0.47 + index * 0.02),
  };
  return material;
}

function snapshotEffects(material) {
  return {
    emissive: material.emissive.clone(),
    emissiveIntensity: material.emissiveIntensity,
    parametricRimColor: material.parametricRimColorFactor.clone(),
    parametricRimFresnelPower: material.parametricRimFresnelPowerFactor,
    parametricRimLift: material.parametricRimLiftFactor,
    rimColor: material.uniforms.rimColorFactor.value.clone(),
    rimLightingMix: material.rimLightingMixFactor,
  };
}

function assertColor(actual, expected, message) {
  assert.ok(actual.equals(expected), `${message}: got ${actual.getHexString()}, expected ${expected.getHexString()}`);
}

test("recipe colors preserve authored MToon emissive and rim effects", async () => {
  const runtimeRecipe = {
    accentColor: "#d95f42",
    accessories: [],
    body: "mini",
    eyeColor: "#4ea8b8",
    face: "soft",
    hairColor: "#173f52",
    hairstyle: "short_bob",
    outfit: "academy",
    outfitColor: "#25364c",
    skinTone: "#e3b6a7",
  };
  const { applyRecipeAppearance } = await loadAppearanceModule(runtimeRecipe);
  const cases = [
    { semantic: "skin", materialName: "Skin", meshName: "SkinMesh", color: runtimeRecipe.skinTone, shade: 0.84 },
    { semantic: "outfit", materialName: "Outfit", meshName: "GarmentMesh", color: runtimeRecipe.outfitColor, shade: 0.72 },
    { semantic: "accent", materialName: "Accent", meshName: "AccentMesh", color: runtimeRecipe.accentColor, shade: 0.72 },
  ];
  const root = new THREE.Group();
  const materials = cases.map((entry, index) => {
    const material = makeMaterial(entry.materialName, index);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
    mesh.name = entry.meshName;
    root.add(mesh);
    return material;
  });
  const effectsBefore = materials.map(snapshotEffects);

  const capabilities = applyRecipeAppearance(root, runtimeRecipe, THREE);

  assert.equal(capabilities.colorMaterialCount, cases.length);
  assert.equal(Array.from(capabilities.colorMaterialSemantics).join(","), "accent,outfit,skin");
  for (const [index, entry] of cases.entries()) {
    const material = materials[index];
    const expectedColor = new THREE.Color(entry.color);
    const expectedShade = expectedColor.clone().multiplyScalar(entry.shade);
    const before = effectsBefore[index];
    assertColor(material.color, expectedColor, `${entry.semantic} lit color was not updated`);
    assertColor(material.shadeColorFactor, expectedShade, `${entry.semantic} shade color was not updated`);
    assertColor(material.emissive, before.emissive, `${entry.semantic} authored emissive color changed`);
    assert.equal(material.emissiveIntensity, before.emissiveIntensity, `${entry.semantic} authored emissive intensity changed`);
    assertColor(material.parametricRimColorFactor, before.parametricRimColor, `${entry.semantic} authored parametric rim color changed`);
    assert.equal(material.parametricRimFresnelPowerFactor, before.parametricRimFresnelPower, `${entry.semantic} authored rim Fresnel power changed`);
    assert.equal(material.parametricRimLiftFactor, before.parametricRimLift, `${entry.semantic} authored rim lift changed`);
    assertColor(material.uniforms.rimColorFactor.value, before.rimColor, `${entry.semantic} authored rim color changed`);
    assert.equal(material.rimLightingMixFactor, before.rimLightingMix, `${entry.semantic} authored rim lighting mix changed`);
  }
});
