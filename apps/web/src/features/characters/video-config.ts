import {
  ACTIVE_CLIP_SLOTS,
  CLIP_ENTRY_BY_ID,
  isCatalogClipSlot,
  isStillSlot,
  resolveStillForLocation,
  STILL_SLOTS,
} from "@companion-space/avatar-engine/catalog";
import type {
  ClipMeta,
  ClipSlot,
  StillLocation,
  StillSlot,
  VideoAvatarRuntimeConfig,
  VideoAvatarTier,
} from "@companion-space/avatar-engine/types";
import type { TutorVideoBoxLabels } from "@companion-space/avatar-engine/video-box";
import type { Character } from "../../app/api";
import t from "../../locales/zh-CN.json";

export function toVideoAvatarConfig(
  character: Pick<Character, "id" | "name" | "appearance" | "video_avatar">,
  reducedMotion = false,
  options?: { disableIdleScheduler?: boolean },
): VideoAvatarRuntimeConfig {
  const video = character.video_avatar;
  const loopPackRaw = video?.loop_pack;
  const clips: Partial<Record<ClipSlot, string>> = {};
  if (loopPackRaw?.clips) {
    for (const [slot, url] of Object.entries(loopPackRaw.clips)) {
      if (typeof url === "string" && url && isCatalogClipSlot(slot)) {
        clips[slot] = url;
      }
    }
  }
  const clipMeta: Partial<Record<ClipSlot, ClipMeta>> = {};
  if (loopPackRaw?.clip_meta) {
    for (const [slot, meta] of Object.entries(loopPackRaw.clip_meta)) {
      if (!isCatalogClipSlot(slot) || !meta) continue;
      clipMeta[slot] = {
        settleMs: typeof meta.settle_ms === "number" ? meta.settle_ms : undefined,
        durationMs: typeof meta.duration_ms === "number" ? meta.duration_ms : undefined,
      };
    }
  }
  const stills: Partial<Record<StillSlot, string>> = {};
  if (loopPackRaw?.stills) {
    for (const [stillKey, url] of Object.entries(loopPackRaw.stills)) {
      if (typeof url === "string" && url && isStillSlot(stillKey)) {
        stills[stillKey] = url;
      }
    }
  }

  return {
    characterId: character.id,
    name: character.name,
    aspectRatio: video?.aspect_ratio === "3:4" ? "3:4" : "9:16",
    preferredTier: (video?.preferred_tier ?? "static") as VideoAvatarTier,
    anchorImage: video?.anchor_image || character.appearance.src,
    loopPack: {
      crossfadeMs: loopPackRaw?.crossfade_ms ?? 180,
      canvas: loopPackRaw?.canvas
        ? {
            width: loopPackRaw.canvas.width,
            height: loopPackRaw.canvas.height,
            fps: loopPackRaw.canvas.fps,
          }
        : undefined,
      clips,
      clipMeta,
      stills,
      media: loopPackRaw?.media
        ? {
            generator: loopPackRaw.media.generator,
            aiGenerated: loopPackRaw.media.ai_generated,
            imageGenerator: loopPackRaw.media.image_generator,
            videoGenerator: loopPackRaw.media.video_generator,
          }
        : undefined,
    },
    localSidecar: video?.local_sidecar
      ? {
          driverId: video.local_sidecar.driver_id ?? null,
          fps: video.local_sidecar.fps ?? 25,
          resolution: video.local_sidecar.resolution ?? "512x896",
        }
      : undefined,
    cloudLive: video?.cloud_live
      ? {
          connectionId: video.cloud_live.connection_id ?? null,
          model: video.cloud_live.model ?? null,
          idleSuspendSec: video.cloud_live.idle_suspend_sec ?? 30,
          maxSessionMinutes: video.cloud_live.max_session_minutes ?? 10,
          maxSessionCostCny: video.cloud_live.max_session_cost_cny ?? 20,
          actionPrompts: video.cloud_live.action_prompts ?? {},
        }
      : undefined,
    reducedMotion,
    disableIdleScheduler: options?.disableIdleScheduler,
  };
}

export function resolveCharacterStill(
  character: Pick<Character, "appearance" | "video_avatar"> | null | undefined,
  location: StillLocation,
): { still: StillSlot | "anchor"; url: string } {
  if (!character) return { still: "anchor", url: "" };
  const anchor = character.video_avatar?.anchor_image || character.appearance.src;
  const rawStills = character.video_avatar?.loop_pack?.stills;
  const stills: Partial<Record<StillSlot, string>> = {};
  if (rawStills) {
    for (const [key, url] of Object.entries(rawStills)) {
      if (typeof url === "string" && url && isStillSlot(key)) {
        stills[key] = url;
      }
    }
  }
  return resolveStillForLocation(location, stills, anchor);
}

export function videoBoxLabels(): TutorVideoBoxLabels {
  return {
    tiers: t.classroom.videoTiers,
    toggleCaption: t.classroom.toggleCaption,
    switchToFree: t.classroom.switchToFree,
    degradedPrefix: t.classroom.degradedPrefix,
    degradedReasons: t.classroom.videoDegraded,
    degradedFallback: t.classroom.videoDegraded.fallback,
    dismissNotice: t.classroom.dismissNotice,
  };
}

export function buildAnimeLoopPromptSheet(character: Pick<Character, "id" | "name" | "persona">): string {
  const traits = character.persona.traits.join(", ");
  const clipLines = ACTIVE_CLIP_SLOTS.map((slot, idx) => {
    const entry = CLIP_ENTRY_BY_ID.get(slot);
    const label = (t.characters.clips as Record<string, string>)[slot] ?? slot;
    const kind = entry?.kind === "one_shot" ? "one-shot" : entry?.kind === "loop_insert" ? "loop-insert" : "loop";
    return `${String(idx + 1).padStart(2, " ")}. clips/${slot}.webm [${entry?.batch ?? "P1"} | ${kind}] — ${label}`;
  });
  const stillLines = STILL_SLOTS.map((still, idx) => {
    const label = (t.characters.stills as Record<string, string>)[still] ?? still;
    return `${String(idx + 1).padStart(2, " ")}. stills/${still}.webp — ${label}`;
  });

  return [
    `# Tutor Media Pack Prompt & Manifest Spec — ${character.name} (${character.id})`,
    "",
    `Role: ${character.persona.relationship || "1-on-1 anime tutor"} | Traits: ${traits || "warm, patient, expressive"}`,
    "Canvas: 576x1024 @ 24fps (exact 9:16; fallback 480x864), VP9 profile 0, yuv420p, single keyframe (-g 240).",
    "Rules:",
    "- Start and end every video clip on the exact hub anchor frame (FL2VA), static camera, single action per clip.",
    "- Generate expression stills directly from anchor (1080x1920 WebP), changing only expression/hand pose.",
    "- Full generator script & tutor data: tools/tutorpack/generate-prompts.mjs & tools/tutorpack/tutors-data.json",
    "- Batch runner: tools/tutorpack/run-h3-batch.mjs",
    "",
    "## Video Clips Catalog (27 slots)",
    ...clipLines,
    "",
    "## Expression Stills (7 slots + anchor.webp)",
    ...stillLines,
    "",
    "## Packaging & Validation Commands",
    `python tools/tutorpack/cli.py scaffold "${character.name}" --anchor anchor.webp -o ./my-pack --author "User" --terms "Local personal use"`,
    "python tools/tutorpack/cli.py ingest --pack <media-pack-dir> --tutor <slug>",
    "python tools/tutorpack/cli.py stills --pack <media-pack-dir> --tutor <slug>",
    "python tools/tutorpack/cli.py validate ./my-pack",
    `python tools/tutorpack/cli.py pack ./my-pack -o ${character.id}.tutorpack`,
  ].join("\n");
}
