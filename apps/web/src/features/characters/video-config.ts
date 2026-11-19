import type {
  ClipSlot,
  VideoAvatarRuntimeConfig,
  VideoAvatarTier,
} from "@companion-space/avatar-engine/types";
import type { TutorVideoBoxLabels } from "@companion-space/avatar-engine/video-box";
import type { Character } from "../../app/api";
import t from "../../locales/zh-CN.json";

export function toVideoAvatarConfig(
  character: Pick<Character, "id" | "name" | "appearance" | "video_avatar">,
  reducedMotion = false,
): VideoAvatarRuntimeConfig {
  const video = character.video_avatar;
  const clips: Partial<Record<ClipSlot, string>> = {};
  if (video?.loop_pack?.clips) {
    for (const [slot, url] of Object.entries(video.loop_pack.clips)) {
      if (typeof url === "string" && url) {
        clips[slot as ClipSlot] = url;
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
      crossfadeMs: video?.loop_pack?.crossfade_ms ?? 180,
      clips,
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
  };
}

export function videoBoxLabels(): TutorVideoBoxLabels {
  return {
    tiers: t.classroom.videoTiers,
    toggleCaption: t.classroom.toggleCaption,
    switchToFree: t.classroom.switchToFree,
    degradedPrefix: t.classroom.degradedPrefix,
    dismissNotice: t.classroom.dismissNotice,
  };
}

export function buildAnimeLoopPromptSheet(character: Pick<Character, "id" | "name" | "persona">): string {
  const traits = character.persona.traits.join(", ");
  return [
    `# Anime 8-Clip Tutor Loop Pack Prompts — ${character.name} (${character.id})`,
    "",
    `Style Anchor: 2D / 2.5D high-detail anime tutor portrait, vertical 9:16 (720x1280 or 576x1024),`,
    `medium close-up upper body, warm desk lamp lighting, clean uncluttered study background with NO bystanders.`,
    `Role: ${character.persona.relationship || "1-on-1 anime tutor"} | Traits: ${traits || "warm, patient, expressive"}`,
    "",
    "Common Rules (Start + End Frame Lock):",
    "- Lock BOTH first frame and last frame to anchor.webp so every loop transitions smoothly with 180ms crossfade.",
    "- Keep camera fixed (static tripod), avoid drastic zoom or background drift.",
    "- Negative prompt: blurry, deformed hands, extra fingers, flickering face, background characters, text watermark, sudden cut.",
    "",
    "1. clips/idle_breathe.webm (4s, loop)",
    "   Gentle natural breathing, soft blink twice, relaxed shoulders, warm eye contact with camera, subtle smile.",
    "2. clips/listen_nod.webm (4s, loop)",
    "   Leaning slightly forward attentively, soft encouraging eye contact, two gentle slow nods as if listening closely.",
    "3. clips/think_chin.webm (3s, loop)",
    "   Lightly resting one finger near chin, eyes glancing slightly upward while pondering, then returning to camera with a warm spark.",
    "4. clips/speak_explain_a.webm (5s, loop)",
    "   Speaking smoothly with natural mouth movement and expressive single-hand explanation gesture, 70% eye contact with viewer.",
    "5. clips/speak_explain_b.webm (5s, loop)",
    "   Speaking smoothly with alternating two-hand counting/structuring gestures, brief glance toward right whiteboard side then back to camera.",
    "6. clips/board_point.webm (3s, one-shot)",
    "   Turning gaze clearly toward the RIGHT edge of frame (whiteboard direction), raising one hand smoothly to indicate right, then smiling back at camera.",
    "7. clips/react_praise.webm (3s, one-shot)",
    "   Eyes curving into a bright genuine smile, raising thumb up or gentle celebratory clap to praise the learner.",
    "8. clips/react_comfort.webm (3s, one-shot)",
    "   Warm reassuring smile, gentle forward nod with soft open-palm calming gesture conveying 'no worries, let us walk through it together'.",
    "",
    "Packaging command:",
    `python tools/tutorpack/cli.py scaffold "${character.name}" --anchor anchor.webp -o ./my-pack`,
    "python tools/tutorpack/cli.py validate ./my-pack",
    `python tools/tutorpack/cli.py pack ./my-pack -o ${character.id}.tutorpack`,
  ].join("\n");
}
