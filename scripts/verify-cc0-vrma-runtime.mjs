import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { VRMLoaderPlugin } from "@pixiv/three-vrm";
import {
  createVRMAnimationClip,
  VRMAnimationLoaderPlugin,
} from "@pixiv/three-vrm-animation";
import { AnimationMixer, PropertyBinding } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

globalThis.self ??= globalThis;
globalThis.createImageBitmap ??= async () => ({
  width: 1,
  height: 1,
  close() {},
});

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const assetRoot = join(repositoryRoot, "apps/web/public/assets/characters");
const motionRoot = join(assetRoot, "motions");
const modelRoot = join(assetRoot, "models");
const motionStates = ["idle", "listening", "thinking", "speaking"];
const models = [
  ["VRM1", "VRM1_Constraint_Twist_Sample.vrm", "1"],
  ["VRM0", "Sendagaya-Shino.vrm", "0"],
];

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function parseAsset(path, createPlugin) {
  const bytes = await readFile(path);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const loader = new GLTFLoader();
  loader.register(createPlugin);
  return new Promise((resolve, reject) => loader.parse(buffer, "", resolve, reject));
}

async function verifyManifestHashes() {
  const manifest = JSON.parse(await readFile(join(motionRoot, "manifest.json"), "utf8"));
  const entries = new Map(manifest.motions.map((motion) => [motion.state, motion]));

  for (const state of motionStates) {
    const entry = entries.get(state);
    assert(entry, `Manifest has no ${state} motion.`);
    const bytes = await readFile(join(motionRoot, entry.file));
    const hash = createHash("sha256").update(bytes).digest("hex");
    assert(hash === entry.sha256, `${entry.file} SHA-256 does not match the manifest.`);
    console.log(`HASH ${entry.file}: ${hash}`);
  }
}

async function main() {
  await verifyManifestHashes();

  const animations = new Map();
  for (const state of motionStates) {
    const gltf = await parseAsset(
      join(motionRoot, `companion-${state}.vrma`),
      (parser) => new VRMAnimationLoaderPlugin(parser),
    );
    const animation = gltf.userData.vrmAnimations?.[0];
    assert(animation, `${state} VRMA has no playable animation.`);
    animations.set(state, animation);
    console.log(`VRMA ${state}: duration=${animation.duration.toFixed(3)}`);
  }

  for (const [kind, filename, expectedMetaVersion] of models) {
    const gltf = await parseAsset(
      join(modelRoot, filename),
      (parser) => new VRMLoaderPlugin(parser),
    );
    const vrm = gltf.userData.vrm;
    assert(vrm, `${filename} did not load as a VRM.`);
    assert(vrm.meta.metaVersion === expectedMetaVersion, `${filename} is not ${kind}.`);

    for (const [state, animation] of animations) {
      vrm.humanoid.resetNormalizedPose();
      const clip = createVRMAnimationClip(animation, vrm);
      assert(clip.tracks.length > 0, `${kind}/${state} produced no tracks.`);

      const unresolved = clip.tracks.filter((track) => {
        const parsed = PropertyBinding.parseTrackName(track.name);
        const node = PropertyBinding.findNode(vrm.scene, parsed.nodeName);
        return !node || !(parsed.propertyName in node);
      });
      assert(unresolved.length === 0, `${kind}/${state} has unresolved tracks: ${unresolved.map((track) => track.name).join(", ")}`);

      const hips = vrm.humanoid.getNormalizedBoneNode("hips");
      assert(hips, `${kind} has no normalized hips bone.`);
      const before = hips.quaternion.toArray();
      const mixer = new AnimationMixer(vrm.scene);
      const action = mixer.clipAction(clip);
      action.reset().setEffectiveTimeScale(1).setEffectiveWeight(1).play().fadeIn(0.22);
      mixer.update(0.25);
      const hipsDelta = Math.max(...hips.quaternion.toArray().map((value, index) => Math.abs(value - before[index])));

      assert(action.isRunning(), `${kind}/${state} action is not running.`);
      assert(action.getEffectiveWeight() > 0.8, `${kind}/${state} effective weight is not above 0.8.`);
      assert(hipsDelta > 1e-6, `${kind}/${state} did not animate the hips quaternion.`);
      console.log(
        `CLIP ${kind}/${state}: tracks=${clip.tracks.length} unresolved=0 running=true weight=${action.getEffectiveWeight().toFixed(3)} hipsDelta=${hipsDelta.toExponential(3)}`,
      );

      mixer.stopAllAction();
      mixer.uncacheRoot(vrm.scene);
    }
  }

  console.log("VRMA runtime verification passed: 4 assets x VRM1/VRM0.");
}

await main();
