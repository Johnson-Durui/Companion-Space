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

const BUILTIN_CHARACTER_VIDEO_LOCKS: Record<
  string,
  { styleLock: string; antiArtifact: string; toneNote: string; negativeExtra: string }
> = {
  "tutor-xuechuan": {
    styleLock:
      "Crisp Japanese shoujo watercolor key visual, pearl-morning study window light, snowy-white feathery hair, glacial-blue eyes, ivory/ice-blue sailor-knit pullover with silver four-point star brooch.",
    antiArtifact:
      "Lock bright morning exposure strictly (prevent overexposed whiteout), keep bangs away from eyes, keep silver star brooch and blurred armillary sphere/telescope completely static.",
    toneNote: "Gentle, airy, encouraging astronomy TA poise with smooth slender hand gestures.",
    negativeExtra: "overexposed whiteout, hair covering eyes, distorted star brooch, moving telescope",
  },
  "tutor-shenyan": {
    styleLock:
      "High-end dark-toned otome key art, walnut executive study with warm sunset highlight on cheek, black swept-back hair with curved forelock, midnight charcoal double-breasted suit, petrol tie and brushed-silver tie bar.",
    antiArtifact:
      "Keep suit lapels, silver tie bar, and leather armchair rigid; restrict facial reactions to restrained mature CEO poise (never goofy grin or frantic waving).",
    toneNote: "Composed, authoritative, crisp measured gestures and subtle approving smile.",
    negativeExtra: "wide toothy grin, goofy expression, frantic hand waving, warped tie bar",
  },
  "tutor-lanyue": {
    styleLock:
      "Fine-lined fantasy shoujo gouache and nacre tones, opal-silver long hair, twin swept-back pearlescent horns, pointed ears, wisteria temple ornament, ivory-lavender sheer sleeve dress, sunlit wisteria arched window.",
    antiArtifact:
      "CRITICAL: Keep twin pearlescent horns, pointed ears, wisteria ornament, and collar clasp strictly rigid; limit head yaw/tilt under 8 degrees so horns and ears never warp or melt.",
    toneNote: "Regal, serene, lyrical literature mentor with graceful small head motions.",
    negativeExtra: "melting horns, disappearing horns, deformed pointed ears, large head rotation",
  },
  "tutor-chutang": {
    styleLock:
      "Luminous Japanese shoujo anime card quality, sakura-pink silky long hair, two tiny ivory petal hairpins at right temple, sea-glass mint ribbon, aqua-green eyes, mint fine-knit cardigan over white rounded collar with translucent leaf button.",
    antiArtifact:
      "Lock both petal hairpins, mint ribbon, and translucent leaf collar button against flickering; avoid exaggerated chibi squash-stretch.",
    toneNote: "Warm, cheerful, supportive daily companion tutor with lively natural smiles.",
    negativeExtra: "flickering hairpins, disappearing mint ribbon, morphing leaf button, chibi distortion",
  },
  "tutor-qingheng": {
    styleLock:
      "Modern Chinese-donghua 2D key art, refined East Asian male scholar, black-jade half-up knot with horizontal green bamboo-jade hair clasp, warm green-brown eyes, stone-white crossed collar and celadon bamboo-leaf lapel, blurred wooden lattice window.",
    antiArtifact:
      "CRITICAL: Keep horizontal bamboo-jade hair clasp strictly straight and intact; limit head rotation under 8 degrees so the hairpin never bends or vanishes.",
    toneNote: "Dignified, unhurried, scholarly poise with calm measured sleeve gestures.",
    negativeExtra: "bending hair clasp, disappearing bamboo hairpin, calligraphy text artifacts, large head spin",
  },
  "tutor-lanyin": {
    styleLock:
      "Graphic contemporary josei anime illustration, deeper warm golden-brown skin with amber studio rim light, sleek asymmetric indigo bob with narrow cobalt streak, dark garnet-brown eyes, single brushed-gold round earring, blue-black structured jacket with silver wave embroidery.",
    antiArtifact:
      "Preserve exact warm brown skin tone, amber cheek light, cobalt streak, gold earring, and silver wave embroidery; keep studio monitor and lamp static.",
    toneNote: "Crisp, perceptive, confident modern sound-designer mentor with sharp rhythmic cadence.",
    negativeExtra: "skin tone lightening, disappearing cobalt streak, missing gold earring, warped embroidery",
  },
};

export function buildAnimeLoopPromptSheet(character: Pick<Character, "id" | "name" | "persona">): string {
  const traits = character.persona.traits.join(", ");
  const custom = BUILTIN_CHARACTER_VIDEO_LOCKS[character.id];
  const styleAnchor =
    custom?.styleLock ??
    "2D / 2.5D high-detail anime tutor portrait, vertical 9:16 (720x1280 or 576x1024), medium close-up upper body, warm desk lamp lighting, clean uncluttered study background with NO bystanders.";
  const negative = [
    "blurry, deformed hands, extra fingers, flickering face, background characters, text watermark, sudden cut, camera zoom, camera pan",
    custom?.negativeExtra ?? "",
  ]
    .filter(Boolean)
    .join(", ");

  return [
    `# Anime 8-Clip Tutor Loop Pack Prompts — ${character.name} (${character.id})`,
    "",
    `Style Anchor: ${styleAnchor}`,
    `Role: ${character.persona.relationship || "1-on-1 anime tutor"} | Traits: ${traits || "warm, patient, expressive"}`,
    ...(custom
      ? [
          `Character Lock: ${custom.antiArtifact}`,
          `Acting Direction: ${custom.toneNote}`,
          `Full bilingual prompt sheet in repo: tools/tutorpack/prompts/characters/`,
        ]
      : []),
    "",
    "Common Rules (Start + End Frame Lock):",
    "- Lock BOTH first frame and last frame to anchor.webp so every loop transitions smoothly with 180ms crossfade.",
    "- Keep camera fixed (static tripod), avoid drastic zoom or background drift.",
    `- Negative prompt: ${negative}.`,
    "",
    "1. clips/idle_breathe.webm (4s, loop)",
    "   Gentle natural breathing, soft blink twice, relaxed shoulders, warm eye contact with camera, subtle closed-lip smile.",
    "2. clips/listen_nod.webm (4s, loop)",
    "   Leaning slightly forward attentively, soft encouraging eye contact, two gentle slow nods as if listening closely.",
    "3. clips/think_chin.webm (3s, loop)",
    "   Lightly resting one finger near chin, eyes glancing slightly aside while pondering, then returning to camera with a clear spark.",
    "4. clips/speak_explain_a.webm (5s, loop)",
    "   Speaking smoothly with natural mouth movement and expressive single-hand explanation gesture at lower chest height, 70% eye contact with viewer.",
    "5. clips/speak_explain_b.webm (5s, loop)",
    "   Speaking smoothly with alternating two-hand structuring gestures in lower frame, brief glance toward right whiteboard side then back to camera.",
    "6. clips/board_point.webm (3s, one-shot)",
    "   Turning gaze clearly toward the RIGHT edge of frame (whiteboard direction), raising one hand smoothly to indicate right, then smiling back at camera.",
    "7. clips/react_praise.webm (3s, one-shot)",
    "   Eyes brightening into a genuine approving smile, gentle nod and neat celebratory thumbs-up or soft applause fitting the character persona.",
    "8. clips/react_comfort.webm (3s, one-shot)",
    "   Warm reassuring smile, gentle forward nod with soft open-palm calming gesture conveying 'no worries, let us walk through it together'.",
    "",
    "Packaging command:",
    `python tools/tutorpack/cli.py scaffold "${character.name}" --anchor anchor.webp -o ./my-pack --author "Companion Space" --terms "Apache-2.0"`,
    "python tools/tutorpack/cli.py validate ./my-pack",
    `python tools/tutorpack/cli.py pack ./my-pack -o ${character.id}.tutorpack`,
  ].join("\n");
}
