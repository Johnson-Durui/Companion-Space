"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { Canvas, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";
import {
  createVRMAnimationClip,
  VRMAnimationLoaderPlugin,
  type VRMAnimation,
} from "@pixiv/three-vrm-animation";

import type { AvatarSpeechController } from "@/components/avatar/vrm-speech-controller";
import {
  dominantViseme,
  VISEME_NAMES,
  nextSpeakingEnvelope,
  visemeWeights,
} from "@/components/avatar/vrm-viseme";
import {
  applyRecipeAppearance,
  type AvatarAppearanceCapabilities,
} from "@/components/avatar/vrm-appearance";
import {
  AVATAR_MOTION_STATES,
  getRuntimeRecipeView,
  type AvatarMotionStatus,
} from "@/components/avatar/vrm-recipe";
import { postLocalMetricSignalSafe } from "@/lib/api";
import styles from "@/components/avatar/avatar-runtime.module.css";
import type {
  AvatarFraming,
  CharacterPreviewState,
  CharacterRecipe,
  CompanionEmotion,
} from "@/lib/types";

type Object3DLike = {
  position: { x: number; y: number; z: number; set: (x: number, y: number, z: number) => void };
  quaternion?: { toArray: () => number[] };
  rotation: { x: number; y: number; z: number; set: (x: number, y: number, z: number) => void };
};

const leftArmPoseQuaternion = new THREE.Quaternion();
const rightArmPoseQuaternion = new THREE.Quaternion();
const armPoseEuler = new THREE.Euler();
const gestureHeadBeforeQuaternion = new THREE.Quaternion();
const gestureSpineBeforeQuaternion = new THREE.Quaternion();

const GESTURE_HEAD_SAMPLE = 1;
const GESTURE_SPINE_SAMPLE = 2;
const REACTION_DURATION_SECONDS = 1.3;

interface ReactionProfile {
  armX: number;
  armZ: number;
  headX: number;
  headY: number;
  headZ: number;
  spineX: number;
  spineZ: number;
}

const REACTION_PROFILES: Record<CompanionEmotion, ReactionProfile> = {
  neutral: { armX: 0.14, armZ: 0.1, headX: 0.11, headY: 0, headZ: 0, spineX: 0.07, spineZ: 0 },
  warm: { armX: 0.11, armZ: 0.17, headX: 0.08, headY: 0.05, headZ: 0.13, spineX: 0.075, spineZ: 0.05 },
  cheerful: { armX: -0.18, armZ: 0.26, headX: -0.11, headY: 0.08, headZ: -0.08, spineX: -0.08, spineZ: -0.065 },
  curious: { armX: 0.1, armZ: 0.15, headX: 0.07, headY: 0.09, headZ: 0.18, spineX: 0.075, spineZ: 0.08 },
  focused: { armX: 0.15, armZ: 0.09, headX: 0.16, headY: -0.05, headZ: 0, spineX: 0.1, spineZ: 0 },
  playful: { armX: -0.16, armZ: 0.24, headX: -0.08, headY: 0.1, headZ: -0.19, spineX: -0.075, spineZ: -0.09 },
  concerned: { armX: 0.17, armZ: -0.14, headX: 0.16, headY: -0.05, headZ: 0.09, spineX: 0.11, spineZ: 0.05 },
};

function getReactionEnvelope(progress: number) {
  if (progress <= 0 || progress >= 1) {
    return 0;
  }
  if (progress < 0.22) {
    return THREE.MathUtils.smoothstep(progress, 0, 0.22);
  }
  if (progress <= 0.42) {
    return 1;
  }
  return 1 - THREE.MathUtils.smoothstep(progress, 0.42, 1);
}

const FACIAL_EXPRESSION_NAMES = ["happy", "relaxed", "surprised", "sad"] as const;

const EMOTION_EXPRESSION_PROFILES: Record<
  CompanionEmotion,
  ReadonlyArray<{ name: (typeof FACIAL_EXPRESSION_NAMES)[number]; weight: number }>
> = {
  neutral: [],
  warm: [
    { name: "relaxed", weight: 0.18 },
    { name: "happy", weight: 0.16 },
  ],
  cheerful: [
    { name: "happy", weight: 0.35 },
    { name: "relaxed", weight: 0.2 },
  ],
  curious: [{ name: "surprised", weight: 0.22 }],
  focused: [{ name: "relaxed", weight: 0.08 }],
  playful: [
    { name: "happy", weight: 0.4 },
    { name: "surprised", weight: 0.24 },
    { name: "relaxed", weight: 0.2 },
  ],
  concerned: [{ name: "sad", weight: 0.25 }],
};

const CAMERA_FRAMING_PROFILES: Record<
  AvatarFraming,
  { fov: number; position: [number, number, number]; target: [number, number, number] }
> = {
  full_body: {
    fov: 32,
    position: [0, 1.3, 3.9],
    target: [0, 0, 0],
  },
  portrait: {
    fov: 30,
    position: [0, 0.55, 2.35],
    target: [0, -0.05, 0],
  },
};

export type AvatarExpressionCapabilityStatus =
  | "safe"
  | "binary"
  | "blink-override"
  | "mouth-override"
  | "blink-mouth-override"
  | "unsafe-metadata"
  | "missing";

export interface AvatarExpressionCapability {
  name: (typeof FACIAL_EXPRESSION_NAMES)[number];
  status: AvatarExpressionCapabilityStatus;
}

export interface AvatarRuntimeCapabilities {
  appearance: AvatarAppearanceCapabilities;
  configuredMotionStates: CharacterPreviewState[];
  expressions: AvatarExpressionCapability[];
  modelVersion: "VRM 0.x" | "VRM 1.0" | "VRM unknown";
  motionMode: "loading" | "ready" | "procedural" | "reduced";
  readyMotionStates: CharacterPreviewState[];
}

export interface AvatarGazeInput {
  active: boolean;
  x: number;
  y: number;
}

interface VrmStageProps {
  emotion: CompanionEmotion;
  gazeInputRef: { readonly current: AvatarGazeInput };
  gestureSequence: number;
  motionAssetUrls?: Partial<Record<CharacterPreviewState, string>>;
  onCapabilitiesChange?: (capabilities: AvatarRuntimeCapabilities | null) => void;
  onFailure: (error: Error) => void;
  onMotionStatusChange: (status: AvatarMotionStatus) => void;
  onReady: (detail: string) => void;
  onStatusChange: (detail: string) => void;
  recipe: CharacterRecipe | Record<string, unknown>;
  reactionKey?: string | null;
  reducedMotion: boolean;
  sessionId?: string | null;
  speechController?: AvatarSpeechController;
  state: CharacterPreviewState;
}

interface SceneProps extends VrmStageProps {
  onFrameRate: (framesPerSecond: number) => void;
}

interface LoadedRuntime {
  activeMotionAction: THREE.AnimationAction | null;
  activeMotionState: CharacterPreviewState | null;
  baseRotations: Map<string, { x: number; y: number; z: number }>;
  disposed: boolean;
  expressionNames: Set<string>;
  expressionManager: Record<string, unknown> | null;
  instanceId: string;
  lookTarget: Object3DLike | null;
  mixer: THREE.AnimationMixer;
  motionActivationCount: number;
  motionActions: Map<CharacterPreviewState, THREE.AnimationAction>;
  motionClips: Map<CharacterPreviewState, THREE.AnimationClip>;
  nodes: Record<string, Object3DLike | null>;
  root: Object3DLike;
  vrm: Record<string, unknown>;
}

function asError(error: unknown, fallback: string) {
  return error instanceof Error ? error : new Error(fallback);
}

interface RuntimeExpression {
  isBinary?: boolean;
  outputWeight?: unknown;
  overrideBlink?: unknown;
  overrideMouth?: unknown;
}

type CameraFitSource = "humanoid" | "visible-bounds" | "legacy";

interface AvatarBoundsMeasurement {
  bounds: THREE.Box3;
  conversationLowerY: number | null;
  headY: number | null;
  hipsY: number | null;
  neckY: number | null;
  shoulderSpan: number | null;
  upperBodyCenterX: number | null;
  source: Exclude<CameraFitSource, "legacy">;
}

function finiteVector(vector: THREE.Vector3) {
  return Number.isFinite(vector.x) && Number.isFinite(vector.y) && Number.isFinite(vector.z);
}

function worldVisible(object: THREE.Object3D) {
  let current: THREE.Object3D | null = object;
  while (current) {
    if (!current.visible) {
      return false;
    }
    current = current.parent;
  }
  return true;
}

function materialVisible(material: THREE.Material | THREE.Material[] | undefined) {
  if (!material) {
    return true;
  }
  const materials = Array.isArray(material) ? material : [material];
  return materials.some((candidate) => candidate.visible);
}

function meshWorldBounds(object: THREE.Object3D) {
  const mesh = object as THREE.Mesh;
  if (!materialVisible(mesh.material)) {
    return null;
  }
  if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) {
    const skinnedMesh = mesh as THREE.SkinnedMesh;
    skinnedMesh.computeBoundingBox();
    return skinnedMesh.boundingBox?.clone().applyMatrix4(skinnedMesh.matrixWorld) ?? null;
  }
  const geometry = mesh.geometry;
  if (!geometry) {
    return null;
  }
  geometry.computeBoundingBox();
  return geometry.boundingBox?.clone().applyMatrix4(mesh.matrixWorld) ?? null;
}

function measureAvatarBounds(runtime: LoadedRuntime): AvatarBoundsMeasurement | null {
  const root = runtime.root as unknown as THREE.Object3D;
  root.updateMatrixWorld(true);
  const bounds = new THREE.Box3();
  root.traverse((object) => {
    const renderable = object as THREE.Object3D & { isMesh?: boolean; isSkinnedMesh?: boolean };
    if ((renderable.isMesh || renderable.isSkinnedMesh) && worldVisible(object)) {
      const objectBounds = meshWorldBounds(object);
      if (objectBounds && finiteVector(objectBounds.min) && finiteVector(objectBounds.max)) {
        bounds.union(objectBounds);
      }
    }
  });

  const landmarkNames = [
    "head",
    "neck",
    "hips",
    "leftFoot",
    "rightFoot",
    "leftLowerLeg",
    "rightLowerLeg",
    "leftShoulder",
    "rightShoulder",
    "leftUpperArm",
    "rightUpperArm",
  ] as const;
  const landmarks = new Map<(typeof landmarkNames)[number], THREE.Vector3>();
  for (const name of landmarkNames) {
    const node = getBoneNode(runtime.vrm, name) as unknown as THREE.Object3D | null;
    if (!node) {
      continue;
    }
    const point = node.getWorldPosition(new THREE.Vector3());
    if (finiteVector(point)) {
      landmarks.set(name, point);
      bounds.expandByPoint(point);
    }
  }

  const size = bounds.getSize(new THREE.Vector3());
  if (
    bounds.isEmpty()
    || !finiteVector(bounds.min)
    || !finiteVector(bounds.max)
    || !finiteVector(size)
    || size.x <= 0.01
    || size.y <= 0.2
    || size.z <= 0.01
    || size.x > 20
    || size.y > 20
    || size.z > 20
  ) {
    return null;
  }

  const head = landmarks.get("head") ?? null;
  const neck = landmarks.get("neck") ?? null;
  const hips = landmarks.get("hips") ?? null;
  const hasFeet = landmarks.has("leftFoot") || landmarks.has("rightFoot");
  const hasHumanoidLandmarks = Boolean(head && hips && hasFeet && head.y > hips.y + 0.05);
  const leftKnee = landmarks.get("leftLowerLeg") ?? null;
  const rightKnee = landmarks.get("rightLowerLeg") ?? null;
  const kneeY = leftKnee && rightKnee
    ? (leftKnee.y + rightKnee.y) * 0.5
    : leftKnee?.y ?? rightKnee?.y ?? null;
  const leftShoulder = landmarks.get("leftShoulder") ?? landmarks.get("leftUpperArm") ?? null;
  const rightShoulder = landmarks.get("rightShoulder") ?? landmarks.get("rightUpperArm") ?? null;
  const shoulderSpan = leftShoulder && rightShoulder
    ? leftShoulder.distanceTo(rightShoulder)
    : null;
  return {
    bounds,
    conversationLowerY: hasHumanoidLandmarks && kneeY !== null && hips
      ? THREE.MathUtils.lerp(kneeY, hips.y, 0.42)
      : null,
    headY: hasHumanoidLandmarks ? head?.y ?? null : null,
    hipsY: hasHumanoidLandmarks ? hips?.y ?? null : null,
    neckY: hasHumanoidLandmarks ? neck?.y ?? null : null,
    shoulderSpan: shoulderSpan && Number.isFinite(shoulderSpan) && shoulderSpan > 0.05
      ? shoulderSpan
      : null,
    upperBodyCenterX: leftShoulder && rightShoulder
      ? (leftShoulder.x + rightShoulder.x) * 0.5
      : head?.x ?? null,
    source: hasHumanoidLandmarks ? "humanoid" : "visible-bounds",
  };
}

function CameraFramingController({
  framing,
  measurement,
  state,
}: {
  framing: AvatarFraming;
  measurement: AvatarBoundsMeasurement | null;
  state: CharacterPreviewState;
}) {
  const camera = useThree((state) => state.camera);
  const canvas = useThree((state) => state.gl.domElement);
  const width = useThree((state) => state.size.width);
  const height = useThree((state) => state.size.height);

  useEffect(() => {
    const profile = CAMERA_FRAMING_PROFILES[framing];
    const aspect = width > 0 && height > 0 ? width / height : 1;
    let fitSource: CameraFitSource = "legacy";
    let boundsSize = new THREE.Vector3();
    let target = new THREE.Vector3(...profile.target);
    let distance = new THREE.Vector3(...profile.position).distanceTo(target);
    let occupancy = 0;
    let headOccupancy = 0;
    let verticalOccupancy = 0;
    let frameSize = new THREE.Vector3();

    if (measurement && camera instanceof THREE.PerspectiveCamera) {
      fitSource = measurement.source;
      boundsSize = measurement.bounds.getSize(new THREE.Vector3());
      const center = measurement.bounds.getCenter(new THREE.Vector3());
      const useConversationFrame = framing === "full_body"
        && (width <= 480 || aspect < 0.92 || state !== "idle");
      const portraitLower = measurement.headY !== null && measurement.hipsY !== null
        ? THREE.MathUtils.lerp(measurement.hipsY, measurement.headY, 0.35)
        : measurement.bounds.min.y + boundsSize.y * 0.48;
      const conversationLower = measurement.conversationLowerY
        ?? measurement.bounds.min.y + boundsSize.y * 0.3;
      const lower = framing === "portrait"
        ? portraitLower
        : useConversationFrame
          ? conversationLower
          : measurement.bounds.min.y;
      const upper = measurement.bounds.max.y;
      const framedHeight = Math.max(0.2, upper - lower);
      const shoulderEnvelope = Math.max(
        (measurement.shoulderSpan ?? framedHeight * 0.55) * 1.35,
        framedHeight * 0.5,
      );
      const portraitWidthCap = framedHeight * Math.min(0.9, Math.max(0.4, aspect));
      const conversationWidth = Math.min(
        boundsSize.x,
        Math.max((measurement.shoulderSpan ?? framedHeight * 0.42) * 2.05, framedHeight * 0.58),
        framedHeight * Math.max(0.1, aspect) * 0.94,
      );
      const fullBodyWidth = measurement.shoulderSpan !== null
        ? Math.min(
            boundsSize.x,
            Math.max(measurement.shoulderSpan * 2.2, framedHeight * 0.62),
          )
        : boundsSize.x;
      const framedWidth = framing === "portrait"
        ? Math.min(boundsSize.x, shoulderEnvelope, portraitWidthCap)
        : useConversationFrame
          ? conversationWidth
          : fullBodyWidth;
      frameSize = new THREE.Vector3(framedWidth, framedHeight, boundsSize.z);
      const margin = framing === "portrait" ? 1.08 : useConversationFrame ? 1.09 : 1.13;
      const verticalFov = THREE.MathUtils.degToRad(profile.fov);
      const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * Math.max(0.1, aspect));
      const verticalDistance = (framedHeight * margin * 0.5) / Math.tan(verticalFov / 2);
      const horizontalDistance = (framedWidth * margin * 0.5) / Math.tan(horizontalFov / 2);
      distance = Math.max(0.5, verticalDistance, horizontalDistance) + boundsSize.z * 0.5;
      const targetX = framing === "portrait" && measurement.upperBodyCenterX !== null
        ? measurement.upperBodyCenterX
        : center.x;
      target = new THREE.Vector3(targetX, lower + framedHeight * 0.5, center.z);
      camera.position.set(target.x, target.y, target.z + distance);
      camera.lookAt(target);
      camera.fov = profile.fov;
      camera.far = Math.max(30, distance + boundsSize.length() * 2 + 5);
      camera.updateProjectionMatrix();
      const effectiveDistance = Math.max(0.001, distance - boundsSize.z * 0.5);
      verticalOccupancy = framedHeight / (2 * effectiveDistance * Math.tan(verticalFov / 2));
      const visibleHeadHeight = measurement.neckY !== null
        ? Math.max(0, upper - measurement.neckY)
        : framedHeight * 0.14;
      headOccupancy = visibleHeadHeight / (2 * effectiveDistance * Math.tan(verticalFov / 2));
      const horizontalOccupancy = framedWidth / (2 * effectiveDistance * Math.tan(horizontalFov / 2));
      occupancy = THREE.MathUtils.clamp(Math.max(verticalOccupancy, horizontalOccupancy), 0, 1);
      canvas.dataset.cameraComposition = useConversationFrame ? "conversation" : framing;
    } else {
      camera.position.set(...profile.position);
      camera.lookAt(...profile.target);
      if (camera instanceof THREE.PerspectiveCamera) {
        camera.fov = profile.fov;
        camera.far = 30;
        camera.updateProjectionMatrix();
      }
      canvas.dataset.cameraComposition = framing;
    }

    if (camera instanceof THREE.PerspectiveCamera) {
      canvas.dataset.cameraFov = String(camera.fov);
    }

    canvas.dataset.avatarFraming = framing;
    canvas.dataset.cameraFitSource = fitSource;
    canvas.dataset.avatarBoundsSize = boundsSize.toArray().map((value) => value.toFixed(3)).join(",");
    canvas.dataset.cameraFrameSize = frameSize.toArray().map((value) => value.toFixed(3)).join(",");
    canvas.dataset.cameraTarget = target.toArray().map((value) => value.toFixed(3)).join(",");
    canvas.dataset.cameraDistance = distance.toFixed(3);
    canvas.dataset.cameraOccupancy = occupancy.toFixed(3);
    canvas.dataset.cameraHeadOccupancy = THREE.MathUtils.clamp(headOccupancy, 0, 1).toFixed(3);
    canvas.dataset.cameraVerticalOccupancy = THREE.MathUtils.clamp(verticalOccupancy, 0, 1).toFixed(3);
    canvas.dataset.cameraPosition = camera.position.toArray().join(",");
    canvas.dataset.cameraDirection = camera
      .getWorldDirection(new THREE.Vector3())
      .toArray()
      .map((value) => value.toFixed(6))
      .join(",");
  }, [camera, canvas, framing, height, measurement, state, width]);

  return null;
}

function disposeScene(root: Object3DLike | null | undefined) {
  if (root) {
    VRMUtils.deepDispose(root as unknown as THREE.Object3D);
  }
}

function clearRuntimeMotions(runtime: LoadedRuntime) {
  if (runtime.disposed) {
    return;
  }
  runtime.mixer.stopAllAction();
  const humanoid = runtime.vrm.humanoid as {
    resetNormalizedPose?: () => void;
  } | undefined;
  humanoid?.resetNormalizedPose?.();
  for (const [boneName, baseRotation] of runtime.baseRotations) {
    assignRotation(runtime.nodes[boneName], baseRotation);
  }
  runtime.mixer.uncacheRoot(runtime.root as unknown as THREE.Object3D);
  runtime.motionActions.clear();
  runtime.motionClips.clear();
  runtime.activeMotionAction = null;
  runtime.activeMotionState = null;
}

function disposeLoadedRuntime(runtime: LoadedRuntime | null | undefined) {
  if (!runtime || runtime.disposed) {
    return;
  }
  clearRuntimeMotions(runtime);
  disposeScene(runtime.root);
  runtime.disposed = true;
}

function loadVrmAnimation(url: string) {
  return new Promise<VRMAnimation>((resolve, reject) => {
    const loader = new GLTFLoader();
    loader.crossOrigin = "anonymous";
    loader.register((parser) => new VRMAnimationLoaderPlugin(parser));
    loader.load(
      url,
      (gltf) => {
        const animations = (gltf.userData as { vrmAnimations?: unknown }).vrmAnimations;
        if (!Array.isArray(animations) || !animations[0]) {
          disposeScene(gltf.scene as unknown as Object3DLike);
          reject(new Error("The VRMA asset does not contain a playable animation."));
          return;
        }
        const animation = animations[0] as VRMAnimation;
        disposeScene(gltf.scene as unknown as Object3DLike);
        resolve(animation);
      },
      undefined,
      (error: unknown) => reject(asError(error, "VRMA asset failed to load.")),
    );
  });
}

function updateRuntimeVrm(runtime: LoadedRuntime, delta: number) {
  const updateVrm = runtime.vrm.update as ((step: number) => void) | undefined;
  if (updateVrm) {
    updateVrm.call(runtime.vrm, delta);
  } else {
    (runtime.vrm.springBoneManager as { update?: (step: number) => void } | undefined)?.update?.(delta);
  }
}

function finishRuntimeFrame(
  runtime: LoadedRuntime,
  canvas: HTMLCanvasElement,
  delta: number,
  gestureSampleMask: number,
  publishMotionTelemetry: boolean,
) {
  updateRuntimeVrm(runtime, delta);

  let appliedGestureAngle = 0;
  const headQuaternion = runtime.nodes.head?.quaternion as THREE.Quaternion | undefined;
  const spineQuaternion = runtime.nodes.spine?.quaternion as THREE.Quaternion | undefined;
  if ((gestureSampleMask & GESTURE_HEAD_SAMPLE) !== 0 && headQuaternion) {
    appliedGestureAngle = gestureHeadBeforeQuaternion.angleTo(headQuaternion);
  }
  if ((gestureSampleMask & GESTURE_SPINE_SAMPLE) !== 0 && spineQuaternion) {
    appliedGestureAngle = Math.max(
      appliedGestureAngle,
      gestureSpineBeforeQuaternion.angleTo(spineQuaternion),
    );
  }
  canvas.dataset.avatarGestureOffset = appliedGestureAngle.toFixed(3);

  if (!publishMotionTelemetry) {
    return;
  }

  const poseValues = [
    "hips",
    "spine",
    "head",
    "leftUpperArm",
    "rightUpperArm",
  ].flatMap((boneName) => runtime.nodes[boneName]?.quaternion?.toArray() ?? []);
  if (poseValues.length) {
    canvas.dataset.avatarMotionBoneSample = poseValues
      .map((value) => value.toFixed(6))
      .join(",");
  }
  const lookTargetPosition = runtime.lookTarget?.position;
  if (lookTargetPosition) {
    canvas.dataset.avatarGazeSample = [
      lookTargetPosition.x,
      lookTargetPosition.y,
      lookTargetPosition.z,
    ].map((value) => value.toFixed(6)).join(",");
  } else {
    delete canvas.dataset.avatarGazeSample;
  }
  const lookAt = runtime.vrm.lookAt as {
    pitch?: unknown;
    target?: unknown;
    yaw?: unknown;
  } | undefined;
  if (!lookAt) {
    delete canvas.dataset.avatarGazeOutput;
    delete canvas.dataset.avatarGazeTargetAttached;
  } else {
    canvas.dataset.avatarGazeTargetAttached = String(lookAt.target === runtime.lookTarget);
    if (
      typeof lookAt.yaw === "number"
      && Number.isFinite(lookAt.yaw)
      && typeof lookAt.pitch === "number"
      && Number.isFinite(lookAt.pitch)
    ) {
      canvas.dataset.avatarGazeOutput = `${lookAt.yaw.toFixed(6)},${lookAt.pitch.toFixed(6)}`;
    } else {
      delete canvas.dataset.avatarGazeOutput;
    }
  }
  const activeAction = runtime.activeMotionAction;
  if (activeAction) {
    canvas.dataset.avatarMotionActionRunning = String(activeAction.isRunning());
    canvas.dataset.avatarMotionEffectiveWeight = activeAction.getEffectiveWeight().toFixed(3);
    canvas.dataset.avatarMotionTime = activeAction.time.toFixed(3);
  }
}

function getBoneNode(vrm: Record<string, unknown>, boneName: string) {
  const humanoid = vrm.humanoid as {
    getNormalizedBoneNode?: (name: string) => Object3DLike | null;
    getRawBoneNode?: (name: string) => Object3DLike | null;
  } | undefined;
  return humanoid?.getNormalizedBoneNode?.(boneName) ?? humanoid?.getRawBoneNode?.(boneName) ?? null;
}

function captureRotation(node: Object3DLike | null) {
  return {
    x: node?.rotation.x ?? 0,
    y: node?.rotation.y ?? 0,
    z: node?.rotation.z ?? 0,
  };
}

function assignRotation(node: Object3DLike | null, nextRotation: { x: number; y: number; z: number }) {
  if (!node) {
    return;
  }
  node.rotation.set(nextRotation.x, nextRotation.y, nextRotation.z);
}

function collectExpressionNames(manager: Record<string, unknown> | null) {
  const names = new Set<string>();
  if (!manager) {
    return names;
  }

  for (const candidate of [manager.expressionMap, manager.presetExpressionMap, manager._expressionMap]) {
    if (candidate && typeof candidate === "object") {
      Object.keys(candidate).forEach((name) => names.add(name));
    }
  }

  for (const candidate of [manager.expressions, manager._expressions]) {
    if (!Array.isArray(candidate)) {
      continue;
    }
    for (const expression of candidate) {
      const expressionName = (expression as Record<string, unknown>).expressionName;
      if (typeof expressionName === "string") {
        names.add(expressionName);
      }
    }
  }

  return names;
}

function setExpressionValue(runtime: LoadedRuntime | null, name: string, value: number) {
  if (!runtime?.expressionManager) {
    return false;
  }
  if (runtime.expressionNames.size > 0 && !runtime.expressionNames.has(name)) {
    return false;
  }

  const setter = runtime.expressionManager.setValue as ((expressionName: string, expressionValue: number) => void) | undefined;
  if (!setter) {
    return false;
  }

  try {
    setter.call(runtime.expressionManager, name, Math.max(0, Math.min(1, value)));
    return true;
  } catch {
    runtime.expressionNames.delete(name);
    return false;
  }
}

function getExpression(runtime: LoadedRuntime, name: string) {
  const manager = runtime.expressionManager;
  if (!manager) {
    return null;
  }
  const getter = manager.getExpression as ((expressionName: string) => unknown) | undefined;
  if (getter) {
    try {
      const expression = getter.call(manager, name);
      return expression && typeof expression === "object"
        ? expression as RuntimeExpression
        : null;
    } catch {
      return null;
    }
  }
  return null;
}

function getExpressionValue(runtime: LoadedRuntime, name: string, fallback: number) {
  const manager = runtime.expressionManager;
  const getter = manager?.getValue as ((expressionName: string) => unknown) | undefined;
  if (!manager || !getter) {
    return fallback;
  }
  try {
    const value = getter.call(manager, name);
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function getExpressionOutputWeight(runtime: LoadedRuntime, name: string, fallback: number) {
  const outputWeight = getExpression(runtime, name)?.outputWeight;
  return typeof outputWeight === "number" && Number.isFinite(outputWeight)
    ? outputWeight
    : getExpressionValue(runtime, name, fallback);
}

function isSafeFacialExpression(expression: RuntimeExpression | null) {
  return Boolean(
    expression &&
    expression.isBinary === false &&
    expression.overrideBlink === "none" &&
    expression.overrideMouth === "none",
  );
}

function classifyExpressionCapability(
  runtime: LoadedRuntime,
  name: AvatarExpressionCapability["name"],
): AvatarExpressionCapability {
  const expression = getExpression(runtime, name);
  if (!expression) {
    return { name, status: "missing" };
  }
  if (expression.isBinary === true) {
    return { name, status: "binary" };
  }
  if (expression.isBinary !== false) {
    return { name, status: "unsafe-metadata" };
  }
  if (
    !["none", "blend", "block"].includes(String(expression.overrideBlink))
    || !["none", "blend", "block"].includes(String(expression.overrideMouth))
  ) {
    return { name, status: "unsafe-metadata" };
  }
  const blinkOverride = expression.overrideBlink !== "none";
  const mouthOverride = expression.overrideMouth !== "none";
  if (blinkOverride && mouthOverride) {
    return { name, status: "blink-mouth-override" };
  }
  if (blinkOverride) {
    return { name, status: "blink-override" };
  }
  if (mouthOverride) {
    return { name, status: "mouth-override" };
  }
  return { name, status: "safe" };
}

function readVrmModelVersion(vrm: Record<string, unknown>): AvatarRuntimeCapabilities["modelVersion"] {
  const meta = vrm.meta;
  if (!meta || typeof meta !== "object") {
    return "VRM unknown";
  }
  const metaVersion = (meta as Record<string, unknown>).metaVersion;
  if (metaVersion === "0") {
    return "VRM 0.x";
  }
  if (metaVersion === "1") {
    return "VRM 1.0";
  }
  return "VRM unknown";
}

function declaredRecipeMotionStates(recipe: CharacterRecipe | Record<string, unknown>) {
  const motions = (recipe as Record<string, unknown>).motions;
  if (!motions || typeof motions !== "object" || Array.isArray(motions)) {
    return [];
  }
  const motionRecord = motions as Record<string, unknown>;
  return AVATAR_MOTION_STATES.filter((motionState) => {
    const value = motionRecord[motionState];
    return typeof value === "string" && value.toLowerCase().endsWith(".vrma");
  });
}

function selectEmotionExpression(
  runtime: LoadedRuntime,
  emotion: CompanionEmotion,
  reducedMotion: boolean,
) {
  for (const candidate of EMOTION_EXPRESSION_PROFILES[emotion]) {
    if (
      (runtime.expressionNames.size === 0 || runtime.expressionNames.has(candidate.name)) &&
      isSafeFacialExpression(getExpression(runtime, candidate.name))
    ) {
      return {
        ...candidate,
        weight: candidate.weight * (reducedMotion ? 0.7 : 1),
      };
    }
  }
  return null;
}

function selectStateExpression(runtime: LoadedRuntime, state: CharacterPreviewState) {
  const candidate = state === "speaking"
    ? { name: "happy" as const, weight: 0.12 }
    : state === "thinking"
      ? { name: "surprised" as const, weight: 0.08 }
      : { name: "relaxed" as const, weight: 0.08 };
  return (
    (runtime.expressionNames.size === 0 || runtime.expressionNames.has(candidate.name)) &&
    isSafeFacialExpression(getExpression(runtime, candidate.name))
  )
    ? candidate
    : null;
}

function buildLoadedRuntime(vrm: Record<string, unknown>, root: Object3DLike) {
  const lookTarget = vrm.lookAt ? (new THREE.Object3D() as Object3DLike) : null;
  lookTarget?.position.set(0, 1.35, 1.6);

  const expressionManager =
    (vrm.expressionManager as Record<string, unknown> | undefined) ??
    (vrm.blendShapeProxy as Record<string, unknown> | undefined) ??
    null;

  const nodes = {
    chest: getBoneNode(vrm, "chest"),
    head: getBoneNode(vrm, "head"),
    hips: getBoneNode(vrm, "hips"),
    leftUpperArm: getBoneNode(vrm, "leftUpperArm"),
    neck: getBoneNode(vrm, "neck"),
    rightUpperArm: getBoneNode(vrm, "rightUpperArm"),
    spine: getBoneNode(vrm, "spine"),
  };

  const baseRotations = new Map<string, { x: number; y: number; z: number }>();
  Object.entries(nodes).forEach(([name, node]) => {
    baseRotations.set(name, captureRotation(node));
  });

  return {
    activeMotionAction: null,
    activeMotionState: null,
    baseRotations,
    disposed: false,
    expressionManager,
    expressionNames: collectExpressionNames(expressionManager),
    instanceId: (root as unknown as THREE.Object3D).uuid,
    lookTarget,
    mixer: new THREE.AnimationMixer(root as unknown as THREE.Object3D),
    motionActivationCount: 0,
    motionActions: new Map<CharacterPreviewState, THREE.AnimationAction>(),
    motionClips: new Map<CharacterPreviewState, THREE.AnimationClip>(),
    nodes,
    root,
    vrm,
  } satisfies LoadedRuntime;
}

function describeReadyState(runtimeRecipeName: string, reducedMotion: boolean) {
  return reducedMotion
    ? `${runtimeRecipeName} 的 VRM runtime 已就绪（低动态模式）。`
    : `${runtimeRecipeName} 的 VRM runtime 已就绪。`;
}

function Scene({
  emotion,
  gazeInputRef,
  gestureSequence,
  motionAssetUrls,
  onCapabilitiesChange,
  onFailure,
  onMotionStatusChange,
  onReady,
  onStatusChange,
  onFrameRate,
  recipe,
  reactionKey,
  reducedMotion,
  speechController,
  state,
}: SceneProps) {
  const runtimeRecipe = getRuntimeRecipeView(recipe);
  const appearanceKey = [
    runtimeRecipe.body,
    runtimeRecipe.face,
    runtimeRecipe.hairstyle,
    runtimeRecipe.outfit,
    [...runtimeRecipe.accessories].sort().join(","),
    runtimeRecipe.skinTone,
    runtimeRecipe.hairColor,
    runtimeRecipe.eyeColor,
    runtimeRecipe.outfitColor,
    runtimeRecipe.accentColor,
  ].join("|");
  const canvas = useThree((frameState) => frameState.gl.domElement);
  const configuredMotionUrls = {
    ...runtimeRecipe.motionUrls,
    ...motionAssetUrls,
  };
  const idleMotionUrl = configuredMotionUrls.idle;
  const listeningMotionUrl = configuredMotionUrls.listening;
  const thinkingMotionUrl = configuredMotionUrls.thinking;
  const speakingMotionUrl = configuredMotionUrls.speaking;
  const declaredMotionStates = declaredRecipeMotionStates(recipe);
  const configuredMotionStates = AVATAR_MOTION_STATES.filter((motionState) =>
    declaredMotionStates.includes(motionState) || Boolean(configuredMotionUrls[motionState]),
  );
  const configuredMotionCount = configuredMotionStates.length;
  const configuredMotionStateKey = configuredMotionStates.join(",");
  const [loadedRuntime, setLoadedRuntime] = useState<LoadedRuntime | null>(null);
  const [framingMeasurement, setFramingMeasurement] = useState<AvatarBoundsMeasurement | null>(null);
  const loadedRuntimeRef = useRef<LoadedRuntime | null>(null);
  const capabilitiesRef = useRef<AvatarRuntimeCapabilities | null>(null);
  const configuredMotionStatesRef = useRef<CharacterPreviewState[]>(configuredMotionStates);
  configuredMotionStatesRef.current = configuredMotionStates;
  const recipeRef = useRef(recipe);
  recipeRef.current = recipe;
  const stateRef = useRef(state);
  const runtimeNameRef = useRef(runtimeRecipe.name);
  const reducedMotionRef = useRef(reducedMotion);
  const frameAccumulatorRef = useRef(0);
  const elapsedRef = useRef(0);
  const frameRateSampleRef = useRef({ elapsed: 0, frames: 0 });
  const motionTelemetryAccumulatorRef = useRef(0);
  const speechLevelRef = useRef(0);
  const speakingEnvelopeRef = useRef(0);
  const blinkRef = useRef({
    activeStart: 0,
    activeUntil: 0,
    nextAt: 0.8,
  });
  const gestureRef = useRef({
    appliedHead: { x: 0, y: 0, z: 0 },
    appliedLeftUpperArm: { x: 0, y: 0, z: 0 },
    appliedRightUpperArm: { x: 0, y: 0, z: 0 },
    appliedSpine: { x: 0, y: 0, z: 0 },
    elapsed: REACTION_DURATION_SECONDS,
    sequence: gestureSequence,
  });

  const publishCapabilities = useCallback((next: AvatarRuntimeCapabilities | null) => {
    capabilitiesRef.current = next;
    if (!next) {
      delete canvas.dataset.avatarVrmVersion;
      delete canvas.dataset.avatarSafeExpressionCount;
      delete canvas.dataset.avatarSafeExpressions;
      delete canvas.dataset.avatarExpressionCapabilities;
      delete canvas.dataset.avatarMotionConfiguredCount;
      delete canvas.dataset.avatarMotionLoadedStates;
      delete canvas.dataset.avatarMotionReadyCount;
      delete canvas.dataset.avatarAppearanceSlotCount;
      delete canvas.dataset.avatarAppearanceSelectedSlotCount;
      delete canvas.dataset.avatarColorMaterialCount;
      delete canvas.dataset.avatarColorMaterialSemantics;
      delete canvas.dataset.avatarRuntimeInstance;
      delete canvas.dataset.avatarGazeSource;
      delete canvas.dataset.avatarGazeInput;
      delete canvas.dataset.avatarGazeSample;
      delete canvas.dataset.avatarGazeOutput;
      delete canvas.dataset.avatarGazeTargetAttached;
      onCapabilitiesChange?.(null);
      return;
    }

    const slotCounts = Object.values(next.appearance.slots);
    const recognizedSlotCount = slotCounts.reduce((total, slot) => total + slot.recognized, 0);
    const selectedSlotCount = slotCounts.reduce((total, slot) => total + slot.selected, 0);
    const safeExpressions = next.expressions
      .filter((expression) => expression.status === "safe")
      .map((expression) => expression.name);
    canvas.dataset.avatarVrmVersion = next.modelVersion;
    canvas.dataset.avatarSafeExpressionCount = String(safeExpressions.length);
    canvas.dataset.avatarSafeExpressions = safeExpressions.join(",");
    canvas.dataset.avatarExpressionCapabilities = next.expressions
      .map((expression) => `${expression.name}:${expression.status}`)
      .join(",");
    canvas.dataset.avatarMotionConfiguredCount = String(next.configuredMotionStates.length);
    canvas.dataset.avatarMotionLoadedStates = next.readyMotionStates.join(",");
    canvas.dataset.avatarMotionReadyCount = String(next.readyMotionStates.length);
    canvas.dataset.avatarAppearanceSlotCount = String(recognizedSlotCount);
    canvas.dataset.avatarAppearanceSelectedSlotCount = String(selectedSlotCount);
    canvas.dataset.avatarColorMaterialCount = String(next.appearance.colorMaterialCount);
    canvas.dataset.avatarColorMaterialSemantics = next.appearance.colorMaterialSemantics.join(",");
    onCapabilitiesChange?.(next);
  }, [canvas, onCapabilitiesChange]);

  const patchCapabilities = useCallback((patch: Partial<AvatarRuntimeCapabilities>) => {
    const current = capabilitiesRef.current;
    if (current) {
      publishCapabilities({ ...current, ...patch });
    }
  }, [publishCapabilities]);

  useEffect(() => {
    canvas.dataset.avatarEmotion = emotion;
    canvas.dataset.avatarStageBackground = runtimeRecipe.stageBackground;
    canvas.dataset.avatarExpression = "none";
    canvas.dataset.avatarExpressionWeight = "0.000";
    canvas.dataset.avatarExpressionIsBinary = "none";
    canvas.dataset.avatarExpressionOverrideBlink = "none";
    canvas.dataset.avatarExpressionOverrideMouth = "none";
    canvas.dataset.avatarMouthWeight = "0.000";
    canvas.dataset.avatarViseme = "none";
    canvas.dataset.avatarVisemeWeights = "aa:0.000,ih:0.000,ou:0.000,ee:0.000,oh:0.000";
    canvas.dataset.avatarBlinkWeight = "0.000";
  }, [canvas, emotion, runtimeRecipe.stageBackground]);

  useEffect(() => {
    const gesture = gestureRef.current;
    canvas.dataset.avatarGestureSequence = String(gestureSequence);
    canvas.dataset.avatarGestureProgress = "0.000";
    canvas.dataset.avatarGestureOffset = "0.000";
    canvas.dataset.avatarReactionEmotion = emotion;
    canvas.dataset.avatarReactionDuration = REACTION_DURATION_SECONDS.toFixed(2);
    canvas.dataset.avatarReactionEnvelope = "0.000";
    canvas.dataset.avatarReactionKey = reactionKey ?? "none";
    canvas.dataset.avatarReactionSequence = String(gestureSequence);
    canvas.dataset.avatarReactionProgress = "0.000";
    canvas.dataset.avatarReactionReducedMotion = String(reducedMotion);

    if (gesture.sequence === gestureSequence) {
      const reactionState = gesture.sequence > 0 && gesture.elapsed < REACTION_DURATION_SECONDS
        ? reducedMotion ? "reduced" : "active"
        : "idle";
      canvas.dataset.avatarGestureState = reactionState;
      canvas.dataset.avatarReactionState = reactionState;
      return;
    }

    gesture.elapsed = 0;
    gesture.sequence = gestureSequence;
    const reactionState = reducedMotion ? "reduced" : "active";
    canvas.dataset.avatarGestureState = reactionState;
    canvas.dataset.avatarReactionState = reactionState;
  }, [canvas, emotion, gestureSequence, reactionKey, reducedMotion]);

  useEffect(() => {
    const gesture = gestureRef.current;
    gesture.appliedHead = { x: 0, y: 0, z: 0 };
    gesture.appliedLeftUpperArm = { x: 0, y: 0, z: 0 };
    gesture.appliedRightUpperArm = { x: 0, y: 0, z: 0 };
    gesture.appliedSpine = { x: 0, y: 0, z: 0 };
  }, [loadedRuntime]);

  const publishMotionStatus = useCallback((
    status: AvatarMotionStatus,
    requestedState: CharacterPreviewState,
    action?: THREE.AnimationAction | null,
  ) => {
    canvas.dataset.avatarMotionMode = status.mode;
    canvas.dataset.avatarMotionState = status.state;
    canvas.dataset.avatarMotionRequestedState = requestedState;
    canvas.dataset.avatarMotionDetail = status.detail;
    if (action) {
      canvas.dataset.avatarMotionActionRunning = String(action.isRunning());
      canvas.dataset.avatarMotionClipTracks = String(action.getClip().tracks.length);
      canvas.dataset.avatarMotionEffectiveWeight = action.getEffectiveWeight().toFixed(3);
      canvas.dataset.avatarMotionTime = action.time.toFixed(3);
    } else {
      delete canvas.dataset.avatarMotionActionRunning;
      delete canvas.dataset.avatarMotionClipTracks;
      delete canvas.dataset.avatarMotionEffectiveWeight;
      delete canvas.dataset.avatarMotionTime;
      delete canvas.dataset.avatarMotionBoneSample;
    }
    onMotionStatusChange(status);
  }, [canvas, onMotionStatusChange]);

  const activateRuntimeMotion = useCallback((
    runtime: LoadedRuntime,
    requestedState: CharacterPreviewState,
  ) => {
    const selectedState = runtime.motionActions.has(requestedState)
      ? requestedState
      : null;
    const nextAction = selectedState ? runtime.motionActions.get(selectedState) ?? null : null;
    const previousAction = runtime.activeMotionAction;

    if (!nextAction || !selectedState) {
      runtime.mixer.stopAllAction();
      const humanoid = runtime.vrm.humanoid as {
        resetNormalizedPose?: () => void;
      } | undefined;
      humanoid?.resetNormalizedPose?.();
      for (const [boneName, baseRotation] of runtime.baseRotations) {
        assignRotation(runtime.nodes[boneName], baseRotation);
      }
      const gesture = gestureRef.current;
      gesture.appliedHead = { x: 0, y: 0, z: 0 };
      gesture.appliedLeftUpperArm = { x: 0, y: 0, z: 0 };
      gesture.appliedRightUpperArm = { x: 0, y: 0, z: 0 };
      gesture.appliedSpine = { x: 0, y: 0, z: 0 };
      runtime.activeMotionAction = null;
      runtime.activeMotionState = null;
      delete canvas.dataset.avatarMotionActivationCount;
      publishMotionStatus({
        mode: "procedural",
        state: requestedState,
        detail: `No usable VRMA is available for ${requestedState}; using procedural motion.`,
      }, requestedState);
      return;
    }

    if (previousAction !== nextAction) {
      nextAction
        .reset()
        .setEffectiveTimeScale(1)
        .setEffectiveWeight(1)
        .play();
      if (previousAction) {
        previousAction.crossFadeTo(nextAction, 0.22, false);
      } else {
        nextAction.fadeIn(0.22);
      }
      runtime.motionActivationCount += 1;
    } else if (!nextAction.isRunning()) {
      nextAction.play();
      runtime.motionActivationCount += 1;
    }

    runtime.activeMotionAction = nextAction;
    runtime.activeMotionState = selectedState;
    canvas.dataset.avatarMotionActivationCount = String(runtime.motionActivationCount);
    publishMotionStatus({
      mode: "vrma",
      state: selectedState,
      detail: `Playing the ${selectedState} VRMA loop.`,
    }, requestedState, nextAction);
  }, [canvas, publishMotionStatus]);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    runtimeNameRef.current = runtimeRecipe.name;
    reducedMotionRef.current = reducedMotion;
  }, [reducedMotion, runtimeRecipe.name]);

  useEffect(() => {
    if (!speechController) {
      speechLevelRef.current = 0;
      return;
    }

    return speechController.subscribe((level) => {
      speechLevelRef.current = level;
    });
  }, [speechController]);

  useEffect(() => {
    let disposed = false;
    let ownedRuntime: LoadedRuntime | null = null;
    onStatusChange("正在加载 VRM 资产。");
    publishCapabilities(null);
    loadedRuntimeRef.current = null;
    setLoadedRuntime(null);
    setFramingMeasurement(null);

    const loader = new GLTFLoader();
    loader.crossOrigin = "anonymous";
    loader.register((parser) => new VRMLoaderPlugin(parser));

    loader.load(
      runtimeRecipe.vrmAssetUrl,
      (gltf) => {
        if (disposed) {
          disposeScene(gltf.scene as unknown as Object3DLike);
          return;
        }

        VRMUtils.removeUnnecessaryVertices(gltf.scene);
        VRMUtils.removeUnnecessaryJoints(gltf.scene);

        const vrm = (gltf.userData as Record<string, unknown> | undefined)?.vrm as Record<string, unknown> | undefined;
        if (!vrm) {
          disposeScene(gltf.scene as unknown as Object3DLike);
          onFailure(new Error("加载的模型不包含 VRM 元数据，已回退到 2D 立绘。"));
          return;
        }

        const sceneRoot = (
          (vrm.scene as Object3DLike | undefined) ??
          (gltf.scene as unknown as Object3DLike)
        );
        sceneRoot.position.set(0, -1.55, 0);
        VRMUtils.rotateVRM0(vrm as never);

        const runtime = buildLoadedRuntime(vrm, sceneRoot);
        const lookAt = vrm.lookAt as { target?: Object3DLike | null } | undefined;
        if (lookAt && runtime.lookTarget) {
          lookAt.target = runtime.lookTarget;
        }

        const appearance = applyRecipeAppearance(
          runtime.root as unknown as Parameters<typeof applyRecipeAppearance>[0],
          recipeRef.current,
          THREE as unknown as Record<string, unknown>,
        );
        const configuredStates = configuredMotionStatesRef.current;
        publishCapabilities({
          appearance,
          configuredMotionStates: configuredStates,
          expressions: FACIAL_EXPRESSION_NAMES.map((name) =>
            classifyExpressionCapability(runtime, name),
          ),
          modelVersion: readVrmModelVersion(vrm),
          motionMode: reducedMotionRef.current
            ? "reduced"
            : configuredStates.length
              ? "loading"
              : "procedural",
          readyMotionStates: [],
        });
        canvas.dataset.avatarRuntimeInstance = runtime.instanceId;
        ownedRuntime = runtime;
        loadedRuntimeRef.current = runtime;
        setLoadedRuntime(runtime);
        setFramingMeasurement(measureAvatarBounds(runtime));
        onReady(
          describeReadyState(runtimeNameRef.current, reducedMotionRef.current),
        );
      },
      undefined,
      (error: unknown) => {
        if (!disposed) {
          onFailure(asError(error, "VRM 资产加载失败，已回退到 2D 立绘。"));
        }
      },
    );

    return () => {
      disposed = true;
      if (loadedRuntimeRef.current === ownedRuntime) {
        loadedRuntimeRef.current = null;
      }
      disposeLoadedRuntime(ownedRuntime);
      ownedRuntime = null;
      publishCapabilities(null);
    };
  }, [
    canvas,
    onFailure,
    onReady,
    onStatusChange,
    publishCapabilities,
    runtimeRecipe.vrmAssetUrl,
  ]);

  useEffect(() => {
    const runtime = loadedRuntimeRef.current;
    if (!runtime || runtime.disposed) {
      return;
    }
    const appearance = applyRecipeAppearance(
      runtime.root as unknown as Parameters<typeof applyRecipeAppearance>[0],
      recipeRef.current,
      THREE as unknown as Record<string, unknown>,
    );
    patchCapabilities({ appearance });
    setFramingMeasurement(measureAvatarBounds(runtime));
  }, [appearanceKey, patchCapabilities]);

  useEffect(() => {
    const runtime = loadedRuntime;
    if (!runtime || runtime.disposed) {
      return;
    }

    const gesture = gestureRef.current;
    gesture.appliedHead = { x: 0, y: 0, z: 0 };
    gesture.appliedLeftUpperArm = { x: 0, y: 0, z: 0 };
    gesture.appliedRightUpperArm = { x: 0, y: 0, z: 0 };
    gesture.appliedSpine = { x: 0, y: 0, z: 0 };
    clearRuntimeMotions(runtime);
    const requestedState = stateRef.current;
    const urls: Partial<Record<CharacterPreviewState, string>> = {
      idle: idleMotionUrl,
      listening: listeningMotionUrl,
      thinking: thinkingMotionUrl,
      speaking: speakingMotionUrl,
    };
    const configuredEntries = AVATAR_MOTION_STATES.flatMap((motionState) => {
      const url = urls[motionState];
      return url ? [[motionState, url] as const] : [];
    });
    const nextConfiguredStates = configuredMotionStatesRef.current;
    if (reducedMotion) {
      patchCapabilities({
        configuredMotionStates: nextConfiguredStates,
        motionMode: "reduced",
        readyMotionStates: [],
      });
      publishMotionStatus({
        mode: "procedural",
        state: requestedState,
        detail: "Reduced-motion mode keeps the body and gaze still while preserving blink and lip sync.",
      }, requestedState);
      return;
    }

    if (!configuredEntries.length) {
      patchCapabilities({
        configuredMotionStates: nextConfiguredStates,
        motionMode: "procedural",
        readyMotionStates: [],
      });
      publishMotionStatus({
        mode: "procedural",
        state: requestedState,
        detail: nextConfiguredStates.length
          ? "Configured VRMA motion assets are unavailable; using procedural motion."
          : "No VRMA motion set is configured; using procedural motion.",
      }, requestedState);
      return;
    }

    let disposed = false;
    patchCapabilities({
      configuredMotionStates: nextConfiguredStates,
      motionMode: "loading",
      readyMotionStates: [],
    });
    publishMotionStatus({
      mode: "loading",
      state: requestedState,
      detail: `Loading ${configuredEntries.length} VRMA motion asset${configuredEntries.length === 1 ? "" : "s"}.`,
    }, requestedState);

    void Promise.allSettled(
      configuredEntries.map(async ([motionState, url]) => ({
        motionState,
        animation: await loadVrmAnimation(url),
      })),
    ).then((results) => {
      if (disposed || loadedRuntimeRef.current !== runtime) {
        return;
      }

      const failures: string[] = [];
      for (const result of results) {
        if (result.status === "rejected") {
          failures.push(result.reason instanceof Error ? result.reason.message : "VRMA load failed");
          continue;
        }
        try {
          const clip = createVRMAnimationClip(result.value.animation, runtime.vrm as never);
          const humanoid = runtime.vrm.humanoid as {
            getNormalizedBoneNode?: (boneName: string) => { name?: string } | null;
          } | undefined;
          const controlledArmTracks = new Set(
            ["leftUpperArm", "rightUpperArm"]
              .map((boneName) => humanoid?.getNormalizedBoneNode?.(boneName)?.name)
              .filter((name): name is string => Boolean(name))
              .map((name) => `${name}.quaternion`),
          );
          clip.tracks = clip.tracks.filter((track) => !controlledArmTracks.has(track.name));
          if (!clip.tracks.length) {
            throw new Error(`${result.value.motionState} VRMA has no compatible humanoid tracks.`);
          }
          clip.name = `companion-${result.value.motionState}`;
          const action = runtime.mixer.clipAction(clip);
          action.setLoop(THREE.LoopRepeat, Infinity);
          runtime.motionClips.set(result.value.motionState, clip);
          runtime.motionActions.set(result.value.motionState, action);
        } catch (error) {
          failures.push(asError(error, "VRMA retargeting failed.").message);
        }
      }

      if (!runtime.motionActions.size) {
        patchCapabilities({
          configuredMotionStates: nextConfiguredStates,
          motionMode: "procedural",
          readyMotionStates: [],
        });
        publishMotionStatus({
          mode: "procedural",
          state: stateRef.current,
          detail: failures[0]
            ? `VRMA unavailable (${failures[0]}); using procedural motion.`
            : "VRMA unavailable; using procedural motion.",
        }, stateRef.current);
        return;
      }

      patchCapabilities({
        configuredMotionStates: nextConfiguredStates,
        motionMode: "ready",
        readyMotionStates: AVATAR_MOTION_STATES.filter((motionState) =>
          runtime.motionActions.has(motionState),
        ),
      });
      activateRuntimeMotion(runtime, stateRef.current);
    });

    return () => {
      disposed = true;
      gesture.appliedHead = { x: 0, y: 0, z: 0 };
      gesture.appliedLeftUpperArm = { x: 0, y: 0, z: 0 };
      gesture.appliedRightUpperArm = { x: 0, y: 0, z: 0 };
      gesture.appliedSpine = { x: 0, y: 0, z: 0 };
      clearRuntimeMotions(runtime);
    };
  }, [
    activateRuntimeMotion,
    configuredMotionStateKey,
    idleMotionUrl,
    listeningMotionUrl,
    loadedRuntime,
    patchCapabilities,
    publishMotionStatus,
    reducedMotion,
    speakingMotionUrl,
    thinkingMotionUrl,
  ]);

  useEffect(() => {
    const runtime = loadedRuntimeRef.current;
    if (!runtime || runtime.disposed) {
      return;
    }
    if (reducedMotion) {
      publishMotionStatus({
        mode: "procedural",
        state,
        detail: "Reduced-motion mode keeps the body and gaze still while preserving blink and lip sync.",
      }, state);
      return;
    }
    if (!runtime.motionActions.size) {
      if (configuredMotionCount === 0) {
        publishMotionStatus({
          mode: "procedural",
          state,
          detail: "No VRMA motion set is configured; using procedural motion.",
        }, state);
      }
      return;
    }
    activateRuntimeMotion(runtime, state);
  }, [
    activateRuntimeMotion,
    configuredMotionCount,
    publishMotionStatus,
    reducedMotion,
    state,
  ]);

  useFrame((_frameState, delta) => {
    const frameRateSample = frameRateSampleRef.current;
    frameRateSample.elapsed += delta;
    frameRateSample.frames += 1;
    if (frameRateSample.elapsed >= 1) {
      onFrameRate(frameRateSample.frames / frameRateSample.elapsed);
      frameRateSample.elapsed = 0;
      frameRateSample.frames = 0;
    }

    const runtime = loadedRuntimeRef.current;
    if (!runtime || runtime.disposed) {
      return;
    }

    const gesture = gestureRef.current;
    const clearAdditiveRotation = (
      node: Object3DLike | null,
      applied: { x: number; y: number; z: number },
    ) => {
      if (node) {
        node.rotation.x -= applied.x;
        node.rotation.y -= applied.y;
        node.rotation.z -= applied.z;
      }
      applied.x = 0;
      applied.y = 0;
      applied.z = 0;
    };
    clearAdditiveRotation(runtime.nodes.head, gesture.appliedHead);
    clearAdditiveRotation(runtime.nodes.spine, gesture.appliedSpine);
    clearAdditiveRotation(runtime.nodes.leftUpperArm, gesture.appliedLeftUpperArm);
    clearAdditiveRotation(runtime.nodes.rightUpperArm, gesture.appliedRightUpperArm);

    runtime.mixer.update(delta);
    gesture.elapsed = Math.min(REACTION_DURATION_SECONDS, gesture.elapsed + delta);
    const gestureProgress = gesture.sequence === 0
      ? 0
      : gesture.elapsed / REACTION_DURATION_SECONDS;
    const reactionEnvelope = gesture.sequence > 0 && gestureProgress < 1 && !reducedMotion
      ? getReactionEnvelope(gestureProgress)
      : 0;
    const reactionProfile = REACTION_PROFILES[emotion];
    const applyGesture = () => {
      let sampleMask = 0;
      const spine = runtime.nodes.spine;
      const head = runtime.nodes.head;
      const spineQuaternion = spine?.quaternion as THREE.Quaternion | undefined;
      const headQuaternion = head?.quaternion as THREE.Quaternion | undefined;
      if (spineQuaternion) {
        gestureSpineBeforeQuaternion.copy(spineQuaternion);
        sampleMask |= GESTURE_SPINE_SAMPLE;
      }
      if (headQuaternion) {
        gestureHeadBeforeQuaternion.copy(headQuaternion);
        sampleMask |= GESTURE_HEAD_SAMPLE;
      }
      if (reactionEnvelope > 0) {
        const applyAdditiveRotation = (
          node: Object3DLike | null,
          applied: { x: number; y: number; z: number },
          x: number,
          y: number,
          z: number,
        ) => {
          if (!node) {
            return;
          }
          applied.x = x * reactionEnvelope;
          applied.y = y * reactionEnvelope;
          applied.z = z * reactionEnvelope;
          node.rotation.x += applied.x;
          node.rotation.y += applied.y;
          node.rotation.z += applied.z;
        };
        applyAdditiveRotation(spine, gesture.appliedSpine, reactionProfile.spineX, 0, reactionProfile.spineZ);
        applyAdditiveRotation(head, gesture.appliedHead, reactionProfile.headX, reactionProfile.headY, reactionProfile.headZ);
        applyAdditiveRotation(runtime.nodes.leftUpperArm, gesture.appliedLeftUpperArm, reactionProfile.armX, 0, reactionProfile.armZ);
        applyAdditiveRotation(runtime.nodes.rightUpperArm, gesture.appliedRightUpperArm, reactionProfile.armX, 0, -reactionProfile.armZ);
      }
      canvas.dataset.avatarGestureSequence = String(gesture.sequence);
      canvas.dataset.avatarGestureState = gesture.sequence === 0 || gestureProgress >= 1
        ? "idle"
        : reducedMotion
          ? "reduced"
          : "active";
      canvas.dataset.avatarGestureProgress = gestureProgress.toFixed(3);
      canvas.dataset.avatarReactionEmotion = emotion;
      canvas.dataset.avatarReactionDuration = REACTION_DURATION_SECONDS.toFixed(2);
      canvas.dataset.avatarReactionEnvelope = reactionEnvelope.toFixed(3);
      canvas.dataset.avatarReactionKey = reactionKey ?? "none";
      canvas.dataset.avatarReactionProgress = gestureProgress.toFixed(3);
      canvas.dataset.avatarReactionState = gesture.sequence === 0 || gestureProgress >= 1
        ? "idle"
        : reducedMotion
          ? "reduced"
          : "active";
      canvas.dataset.avatarReactionBoneSample = [
        gesture.appliedHead.x,
        gesture.appliedHead.y,
        gesture.appliedHead.z,
        gesture.appliedSpine.x,
        gesture.appliedSpine.y,
        gesture.appliedSpine.z,
        gesture.appliedLeftUpperArm.x,
        gesture.appliedLeftUpperArm.z,
        gesture.appliedRightUpperArm.x,
        gesture.appliedRightUpperArm.z,
      ].map((value) => value.toFixed(6)).join(",");
      return sampleMask;
    };
    motionTelemetryAccumulatorRef.current += delta;
    const publishMotionTelemetry = motionTelemetryAccumulatorRef.current >= 0.25;
    if (publishMotionTelemetry) {
      motionTelemetryAccumulatorRef.current = 0;
    }

    frameAccumulatorRef.current += delta;
    if (frameAccumulatorRef.current < 1 / 30) {
      finishRuntimeFrame(
        runtime,
        canvas,
        delta,
        applyGesture(),
        publishMotionTelemetry,
      );
      return;
    }

    const step = Math.min(frameAccumulatorRef.current, 1 / 12);
    frameAccumulatorRef.current = 0;
    elapsedRef.current += step;

    const now = elapsedRef.current;
    const blink = blinkRef.current;
    if (now >= blink.nextAt && now >= blink.activeUntil) {
      const duration = reducedMotion ? 0.08 : 0.12;
      blink.activeStart = now;
      blink.activeUntil = now + duration;
      blink.nextAt = now + (reducedMotion ? 5.2 : 3.2) + ((Math.sin(now * 2.7) + 1) * 0.35);
    }

    const blinkProgress =
      now >= blink.activeStart && now <= blink.activeUntil
        ? 1 - Math.abs(((now - blink.activeStart) / Math.max(0.001, blink.activeUntil - blink.activeStart)) * 2 - 1)
        : 0;

    const breathing = Math.sin(now * 1.6) * (reducedMotion ? 0 : 0.02);
    const sway = Math.sin(now * (state === "thinking" ? 2.1 : 1.35));
    const armWave = Math.sin(now * 1.7 + 0.6);
    const armRestAngle = 1.08;
    speakingEnvelopeRef.current = nextSpeakingEnvelope({
      current: speakingEnvelopeRef.current,
      speaking: state === "speaking",
      speechLevel: speechLevelRef.current,
      deltaSeconds: step,
    });
    const mouthShapes = visemeWeights({
      elapsedSeconds: now,
      speaking: state === "speaking",
      speechLevel: speechLevelRef.current,
      envelope: speakingEnvelopeRef.current,
      emotion,
    });
    const mouth = mouthShapes.aa;
    const motionScale = reducedMotion ? 0 : 1;

    const stateProfiles: Record<CharacterPreviewState, { chestX: number; chestY: number; headX: number; headY: number; lean: number; lookX: number; lookY: number }> = {
      idle: { chestX: 0.012, chestY: 0.03, headX: 0.02, headY: 0.03, lean: 0, lookX: 0.06, lookY: 0.02 },
      listening: { chestX: 0.02, chestY: 0.05, headX: 0.04, headY: 0.06, lean: -0.03, lookX: 0.04, lookY: 0.06 },
      thinking: { chestX: 0.018, chestY: 0.018, headX: 0.085, headY: 0.03, lean: -0.05, lookX: 0.12, lookY: -0.08 },
      speaking: { chestX: 0.024, chestY: 0.08, headX: 0.03, headY: 0.08, lean: 0.01, lookX: 0.08, lookY: 0.04 },
    };

    const profile = stateProfiles[state];
    const gazeInput = gazeInputRef.current;
    const gazeSource = reducedMotion ? "reduced" : gazeInput.active ? "pointer" : "idle";
    const gazeX = gazeSource === "pointer" ? gazeInput.x : 0;
    const gazeY = gazeSource === "pointer" ? gazeInput.y : 0;
    if (runtime.lookTarget) {
      const targetX = gazeSource === "pointer"
        ? gazeX * 0.42
        : Math.sin(now * 0.8) * profile.lookX * motionScale;
      const targetY = gazeSource === "pointer"
        ? 1.3 + gazeY * 0.28
        : 1.3 + breathing + Math.cos(now * 0.56) * profile.lookY * motionScale;
      const smoothing = gazeSource === "pointer" ? 1 - Math.exp(-12 * step) : 1;
      runtime.lookTarget.position.x += (targetX - runtime.lookTarget.position.x) * smoothing;
      runtime.lookTarget.position.y += (targetY - runtime.lookTarget.position.y) * smoothing;
      runtime.lookTarget.position.z += (1.55 - runtime.lookTarget.position.z) * smoothing;
    }
    canvas.dataset.avatarGazeSource = gazeSource;
    canvas.dataset.avatarGazeInput = `${gazeX.toFixed(3)},${gazeY.toFixed(3)}`;

    const hasVrmaAction = Boolean(
      runtime.activeMotionAction && runtime.activeMotionAction.isRunning(),
    );
    const allowStateExpressions = !hasVrmaAction && !reducedMotion;
    if (!hasVrmaAction) {
      const hipsBase = runtime.baseRotations.get("hips");
      const spineBase = runtime.baseRotations.get("spine");
      const chestBase = runtime.baseRotations.get("chest");
      const neckBase = runtime.baseRotations.get("neck");
      const headBase = runtime.baseRotations.get("head");
      assignRotation(runtime.nodes.hips, {
        x: (hipsBase?.x ?? 0) + profile.lean * motionScale,
        y: (hipsBase?.y ?? 0) + sway * profile.chestY * 0.26 * motionScale,
        z: hipsBase?.z ?? 0,
      });
      assignRotation(runtime.nodes.spine, {
        x: (spineBase?.x ?? 0) + breathing * 0.6,
        y: (spineBase?.y ?? 0) + sway * profile.chestY * 0.42 * motionScale,
        z: spineBase?.z ?? 0,
      });
      assignRotation(runtime.nodes.chest, {
        x: (chestBase?.x ?? 0) + breathing + Math.sin(now * 0.74) * profile.chestX * motionScale,
        y: (chestBase?.y ?? 0) + sway * profile.chestY * motionScale,
        z: chestBase?.z ?? 0,
      });
      assignRotation(runtime.nodes.neck, {
        x: (neckBase?.x ?? 0) + Math.sin(now * 0.9) * profile.headX * 0.35 * motionScale,
        y: (neckBase?.y ?? 0) + Math.sin(now * 0.62) * profile.headY * 0.42 * motionScale,
        z: neckBase?.z ?? 0,
      });
      assignRotation(runtime.nodes.head, {
        x: (headBase?.x ?? 0) + profile.lean * 0.55 * motionScale + Math.sin(now * 0.85) * profile.headX * motionScale,
        y: (headBase?.y ?? 0) + Math.sin(now * 0.55) * profile.headY * motionScale,
        z: (headBase?.z ?? 0) + Math.cos(now * 0.67) * 0.018 * motionScale,
      });
    }

    // The bundled VRMA clips intentionally keep the torso alive, but some
    // source arm tracks retarget into a permanent overhead V pose on VRM 0.x.
    // Own the upper-arm resting pose here for every motion mode, then let the
    // one-shot emotion reaction add a visible gesture on top of it.
    const armDirection = readVrmModelVersion(runtime.vrm) === "VRM 0.x" ? 1 : -1;
    const armAngleMagnitude =
      armRestAngle - (state === "speaking" ? 0.16 : -0.02) * motionScale;
    leftArmPoseQuaternion.setFromEuler(
      armPoseEuler.set(
        armWave * 0.06 * motionScale,
        0,
        armDirection * armAngleMagnitude,
      ),
    );
    rightArmPoseQuaternion.setFromEuler(
      armPoseEuler.set(
        -armWave * 0.06 * motionScale,
        0,
        -armDirection * armAngleMagnitude,
      ),
    );
    const humanoid = runtime.vrm.humanoid as {
      setNormalizedPose?: (
        pose: Record<string, { rotation: [number, number, number, number] }>,
      ) => void;
    } | undefined;
    humanoid?.setNormalizedPose?.({
      leftUpperArm: {
        rotation: leftArmPoseQuaternion.toArray(),
      },
      rightUpperArm: {
        rotation: rightArmPoseQuaternion.toArray(),
      },
    });

    for (const expressionName of FACIAL_EXPRESSION_NAMES) {
      setExpressionValue(runtime, expressionName, 0);
    }
    const selectedExpression =
      selectEmotionExpression(runtime, emotion, reducedMotion) ??
      (allowStateExpressions ? selectStateExpression(runtime, state) : null);
    const expressionApplied = selectedExpression
      ? setExpressionValue(runtime, selectedExpression.name, selectedExpression.weight)
      : false;
    setExpressionValue(runtime, "blink", blinkProgress);
    for (const visemeName of VISEME_NAMES) {
      setExpressionValue(runtime, visemeName, mouthShapes[visemeName]);
    }
    finishRuntimeFrame(
      runtime,
      canvas,
      delta,
      applyGesture(),
      publishMotionTelemetry,
    );

    canvas.dataset.avatarEmotion = emotion;
    canvas.dataset.avatarExpression = expressionApplied && selectedExpression
      ? selectedExpression.name
      : "none";
    const selectedExpressionMetadata = expressionApplied && selectedExpression
      ? getExpression(runtime, selectedExpression.name)
      : null;
    canvas.dataset.avatarExpressionWeight = expressionApplied && selectedExpression
      ? getExpressionOutputWeight(runtime, selectedExpression.name, selectedExpression.weight).toFixed(3)
      : "0.000";
    canvas.dataset.avatarExpressionIsBinary = selectedExpressionMetadata
      ? String(selectedExpressionMetadata.isBinary)
      : "none";
    canvas.dataset.avatarExpressionOverrideBlink = selectedExpressionMetadata?.overrideBlink === "none"
      ? "none"
      : "unsafe";
    canvas.dataset.avatarExpressionOverrideMouth = selectedExpressionMetadata?.overrideMouth === "none"
      ? "none"
      : "unsafe";
    canvas.dataset.avatarMouthWeight = getExpressionOutputWeight(runtime, "aa", mouth).toFixed(3);
    canvas.dataset.avatarViseme = dominantViseme(mouthShapes);
    canvas.dataset.avatarVisemeWeights = VISEME_NAMES
      .map((name) => `${name}:${getExpressionOutputWeight(runtime, name, mouthShapes[name]).toFixed(3)}`)
      .join(",");
    canvas.dataset.avatarBlinkWeight = getExpressionOutputWeight(runtime, "blink", blinkProgress).toFixed(3);
  });

  return (
    <group>
      <CameraFramingController
        framing={runtimeRecipe.avatarFraming}
        measurement={framingMeasurement}
        state={state}
      />
      <mesh position={[0, 1.05, -1.85]}>
        <circleGeometry args={[2.85, 64]} />
        <meshBasicMaterial color={runtimeRecipe.accentColor} opacity={0.09} transparent />
      </mesh>
      {loadedRuntime?.lookTarget ? <primitive object={loadedRuntime.lookTarget} /> : null}
      {loadedRuntime?.root ? <primitive object={loadedRuntime.root} /> : null}
    </group>
  );
}

export function VrmStage(props: VrmStageProps) {
  const { emotion, onReady, reactionKey, recipe, reducedMotion, sessionId } = props;
  const runtimeRecipe = getRuntimeRecipeView(recipe);
  const cameraFraming = CAMERA_FRAMING_PROFILES[runtimeRecipe.avatarFraming];
  const [frameRate, setFrameRate] = useState(0);
  const [modelReady, setModelReady] = useState(false);
  const reportedSessionsRef = useRef(new Set<string>());

  const handleReady = useCallback(
    (detail: string) => {
      setFrameRate(0);
      setModelReady(true);
      onReady(detail);
    },
    [onReady],
  );

  useEffect(() => {
    setFrameRate(0);
    setModelReady(false);
  }, [runtimeRecipe.vrmAssetUrl]);

  useEffect(() => {
    const normalizedSessionId = sessionId?.trim();
    if (!modelReady || !normalizedSessionId || !Number.isFinite(frameRate) || frameRate <= 0) {
      return;
    }
    if (reportedSessionsRef.current.has(normalizedSessionId)) {
      return;
    }
    reportedSessionsRef.current.add(normalizedSessionId);
    void postLocalMetricSignalSafe({
      event: "avatar_fps",
      session_id: normalizedSessionId,
      value: Number(frameRate.toFixed(1)),
    });
  }, [frameRate, modelReady, sessionId]);

  return (
    <Canvas
      aria-label="VRM character canvas"
      camera={{
        far: 30,
        fov: cameraFraming.fov,
        near: 0.1,
        position: cameraFraming.position,
      }}
      className={styles.runtimeStage}
      data-avatar-emotion={emotion}
      data-avatar-reaction-key={reactionKey ?? "none"}
      data-avatar-reaction-reduced-motion={reducedMotion}
      data-avatar-reduced-motion={reducedMotion}
      data-avatar-stage-background={runtimeRecipe.stageBackground}
      data-vrm-fps={frameRate > 0 ? frameRate.toFixed(1) : "measuring"}
      dpr={reducedMotion ? [1, 1.25] : [1, 1.75]}
      frameloop="always"
      gl={{
        alpha: true,
        antialias: true,
        powerPreference: "high-performance",
      }}
    >
      <ambientLight intensity={0.9} />
      <hemisphereLight args={["#fff7ec", "#7f8da6", 1.05]} />
      <directionalLight intensity={2.1} position={[2.2, 3.8, 3]} />
      <directionalLight intensity={0.72} position={[-2.4, 2.1, 1.4]} />
      <directionalLight intensity={0.62} position={[0.4, 3.2, -2.2]} />
      <Scene
        {...props}
        key={`${runtimeRecipe.modelId}:${runtimeRecipe.vrmAssetUrl}`}
        onFrameRate={setFrameRate}
        onReady={handleReady}
      />
    </Canvas>
  );
}
