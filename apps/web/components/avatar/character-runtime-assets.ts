import {
  AVATAR_MOTION_STATES,
  COMPANION_CC0_MOTION_URLS,
} from "@/components/avatar/vrm-recipe";
import { downloadCharacterAsset } from "@/lib/api";
import type {
  CharacterPackDetail,
  CharacterPreviewState,
  LicensedAvatarRuntimeFormat,
} from "@/lib/types";

interface CharacterRuntimeAssetsBase {
  motionUrls: Partial<Record<CharacterPreviewState, string>>;
  warnings: string[];
  revoke: () => void;
}

export interface CharacterVrmRuntimeAssets extends CharacterRuntimeAssetsBase {
  kind: "vrm";
  modelUrl: string;
}

export interface CharacterLicensedRuntimeAssets extends CharacterRuntimeAssetsBase {
  kind: "licensed";
  archive: Blob;
  entrypoint: string;
  format: LicensedAvatarRuntimeFormat;
  sha256: string;
}

export interface CharacterBuiltinRuntimeAssets extends CharacterRuntimeAssetsBase {
  kind: "builtin";
}

export type CharacterRuntimeAssetUrls =
  | CharacterVrmRuntimeAssets
  | CharacterLicensedRuntimeAssets
  | CharacterBuiltinRuntimeAssets;

type AssetRequest =
  | { kind: "model"; path: string }
  | { kind: "motion"; path: string; state: CharacterPreviewState };

function isSafeRelativeAssetPath(path: string) {
  if (!path || path.startsWith("/") || path.includes("\\")) {
    return false;
  }
  const parts = path.split("/");
  return parts.every((part) => part && part !== "." && part !== "..");
}

function listedAssetPaths(character: CharacterPackDetail) {
  const manifest = character.asset_manifest;
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return new Set<string>();
  }
  const paths = manifest.asset_paths;
  if (!Array.isArray(paths)) {
    return new Set<string>();
  }
  return new Set(
    paths.filter((path): path is string => (
      typeof path === "string" && isSafeRelativeAssetPath(path)
    )),
  );
}

async function sha256Hex(blob: Blob) {
  if (!globalThis.crypto?.subtle) {
    throw new Error("Browser SHA-256 verification is unavailable.");
  }
  const digest = await globalThis.crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function managedMotionPath(
  character: CharacterPackDetail,
  state: CharacterPreviewState,
  listedPaths: Set<string>,
) {
  const managedMotions = character.asset_manifest?.managed_motions;
  if (!managedMotions || typeof managedMotions !== "object" || Array.isArray(managedMotions)) {
    return null;
  }
  const entry = (managedMotions as Record<string, unknown>)[state];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return null;
  }
  const record = entry as Record<string, unknown>;
  const path = record.path;
  const sha256 = record.sha256;
  return typeof path === "string"
    && path.toLowerCase().endsWith(".vrma")
    && isSafeRelativeAssetPath(path)
    && listedPaths.has(path)
    && typeof record.source_filename === "string"
    && record.source_filename.trim().length > 0
    && typeof sha256 === "string"
    && /^[a-f0-9]{64}$/.test(sha256)
    && path === `managed-motions/${state}-${sha256}.vrma`
    && record.provenance === "owner_upload"
    && record.redistribution_allowed === "no"
    ? path
    : null;
}

export async function loadCharacterRuntimeAssetUrls(
  character: CharacterPackDetail,
): Promise<CharacterRuntimeAssetUrls> {
  const listedPaths = listedAssetPaths(character);
  const warnings: string[] = [];
  const requests: AssetRequest[] = [];
  const modelPath = character.asset_manifest?.model_path;
  const manifestFormat = character.asset_manifest?.format;
  const renderMode = character.asset_manifest?.render_mode;
  const licensedFormat = manifestFormat === "live2d-zip"
    ? "live2d"
    : manifestFormat === "spine-zip"
      ? "spine"
      : null;
  let licensedEntrypoint: string | null = null;
  let licensedSha256: string | null = null;

  if (typeof modelPath === "string" && modelPath.trim()) {
    const normalizedModelPath = modelPath.trim();
    if (!isSafeRelativeAssetPath(normalizedModelPath) || !listedPaths.has(normalizedModelPath)) {
      throw new Error("Character model asset is not declared by its manifest.");
    }
    if (licensedFormat) {
      const entrypoint = character.asset_manifest?.entrypoint;
      const sha256 = character.asset_manifest?.sha256;
      if (
        normalizedModelPath !== "display-model/model.zip"
        || renderMode !== licensedFormat
        || typeof entrypoint !== "string"
        || !isSafeRelativeAssetPath(entrypoint)
        || typeof sha256 !== "string"
        || !/^[a-f0-9]{64}$/.test(sha256)
      ) {
        throw new Error("Licensed character runtime declaration is invalid.");
      }
      licensedEntrypoint = entrypoint;
      licensedSha256 = sha256;
    } else if (manifestFormat === "live2d-zip" || manifestFormat === "spine-zip") {
      throw new Error("Licensed character runtime format is invalid.");
    }
    requests.push({ kind: "model", path: normalizedModelPath });
  }

  for (const state of AVATAR_MOTION_STATES) {
    const overlayPath = managedMotionPath(character, state, listedPaths);
    if (overlayPath) {
      requests.push({ kind: "motion", path: overlayPath, state });
      continue;
    }
    const managedMotions = character.asset_manifest?.managed_motions;
    if (
      managedMotions
      && typeof managedMotions === "object"
      && !Array.isArray(managedMotions)
      && Object.hasOwn(managedMotions, state)
    ) {
      warnings.push(`${state}: managed motion declaration is invalid.`);
    }
    const configuredPath = character.recipe.motions[state];
    if (typeof configuredPath !== "string" || !configuredPath.toLowerCase().endsWith(".vrma")) {
      continue;
    }
    if (configuredPath === COMPANION_CC0_MOTION_URLS[state]) {
      continue;
    }
    if (!isSafeRelativeAssetPath(configuredPath) || !listedPaths.has(configuredPath)) {
      warnings.push(`${state}: motion asset is not declared by the character manifest.`);
      continue;
    }
    requests.push({ kind: "motion", path: configuredPath, state });
  }

  const settled = await Promise.allSettled(
    requests.map(async (request) => ({
      request,
      blob: await downloadCharacterAsset(character.id, request.path),
    })),
  );
  const objectUrls: string[] = [];
  let modelBlob: Blob | null = null;
  let modelUrl: string | null = null;
  const motionUrls: Partial<Record<CharacterPreviewState, string>> = {};

  for (let index = 0; index < settled.length; index += 1) {
    const result = settled[index];
    const request = requests[index];
    if (result.status === "rejected") {
      const detail = result.reason instanceof Error ? result.reason.message : "asset download failed";
      if (request.kind === "model") {
        objectUrls.forEach((url) => URL.revokeObjectURL(url));
        throw new Error(`Character model asset failed to load: ${detail}`);
      }
      warnings.push(`${request.state}: ${detail}`);
      continue;
    }

    if (request.kind === "model") {
      modelBlob = result.value.blob;
      if (!licensedFormat) {
        modelUrl = URL.createObjectURL(modelBlob);
        objectUrls.push(modelUrl);
      }
    } else {
      const url = URL.createObjectURL(result.value.blob);
      objectUrls.push(url);
      motionUrls[request.state] = url;
    }
  }

  const common = {
    motionUrls,
    warnings,
    revoke: () => objectUrls.forEach((url) => URL.revokeObjectURL(url)),
  };
  if (licensedFormat) {
    if (!modelBlob || !licensedEntrypoint || !licensedSha256) {
      common.revoke();
      throw new Error("Licensed character archive failed to load.");
    }
    let actualSha256: string;
    try {
      actualSha256 = await sha256Hex(modelBlob);
    } catch (error) {
      common.revoke();
      throw error;
    }
    if (actualSha256 !== licensedSha256) {
      common.revoke();
      throw new Error("Licensed character archive SHA-256 does not match its manifest.");
    }
    return {
      ...common,
      kind: "licensed",
      archive: modelBlob,
      entrypoint: licensedEntrypoint,
      format: licensedFormat,
      sha256: licensedSha256,
    };
  }
  if (modelUrl) {
    return { ...common, kind: "vrm", modelUrl };
  }
  return { ...common, kind: "builtin" };
}
