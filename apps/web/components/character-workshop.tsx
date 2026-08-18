"use client";

import type { ChangeEvent, FormEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";

import {
  AvatarRuntime,
  type AvatarRuntimeMode,
} from "@/components/avatar/avatar-runtime";
import type {
  AvatarExpressionCapabilityStatus,
  AvatarRuntimeCapabilities,
} from "@/components/avatar/vrm-stage";
import {
  COMPANION_CC0_MOTION_URLS,
  getRuntimeRecipeView,
} from "@/components/avatar/vrm-recipe";
import { BUILTIN_PET_DEFINITIONS } from "@/components/avatar/pet-registry";
import { BUILTIN_PORTRAIT_DEFINITIONS } from "@/components/avatar/portrait-registry";
import type { AvatarSpeechController } from "@/components/avatar/vrm-speech-controller";
import type { CharacterLicensedRuntimeAssets } from "@/components/avatar/character-runtime-assets";
import { createCharacterWorkshopDocument, createDefaultCharacterRecipe } from "@/lib/api";
import type {
  AvatarFraming,
  AvatarStageBackground,
  CharacterAssetManifest,
  CharacterPackDetail,
  CharacterPreviewState,
  CharacterRecipe,
  CharacterWorkshopDocument,
  StudySpaceSummary,
} from "@/lib/types";
import styles from "@/components/character-workshop.module.css";

export interface CharacterWorkshopRecipeDraft {
  avatar_model: string;
  avatar_framing: AvatarFraming;
  stage_background: AvatarStageBackground;
  body_base: string;
  face_shape: string;
  hair_style: string;
  outfit_style: string;
  accessory_ids: string[];
  persona_preset: string;
  relation_mode: string;
  relation_custom: string;
  warmth: number;
  initiative: number;
  humor: number;
  challenge: number;
  motions: Record<string, string>;
  voice_provider: string;
  voice_model: string;
  voice_id: string;
  voice_rate: number;
  voice_preview_text: string;
  preview_state: CharacterPreviewState;
  palette: {
    skin_tone: string;
    hair_color: string;
    eye_color: string;
    outfit_color: string;
    accent_color: string;
  };
}

export interface CharacterWorkshopDraft {
  name: string;
  description: string;
  recipe: CharacterWorkshopRecipeDraft;
}

interface CharacterWorkshopProps {
  mode: "create" | "edit";
  seed: CharacterWorkshopDraft;
  seedKey: string | number;
  adultRelationshipsEnabled?: boolean;
  busy?: boolean;
  notice?: string | null;
  error?: string | null;
  assetError?: string | null;
  assetLoading?: boolean;
  assetPreviewStale?: boolean;
  assetManifest?: CharacterAssetManifest | null;
  motionAssetUrls?: Partial<Record<CharacterPreviewState, string>>;
  title: string;
  description: string;
  submitLabel: string;
  statusLabel?: string | null;
  assetUrl?: string | null;
  licensedRuntimeAsset?: CharacterLicensedRuntimeAssets | null;
  attachedModelLabel?: string | null;
  previewSpaces?: StudySpaceSummary[];
  previewSpaceId?: string;
  onPreviewSpaceChange?: (spaceId: string) => void;
  defaultCharacterSpaceIds?: string[];
  speechController?: AvatarSpeechController;
  onSubmit: (draft: CharacterWorkshopDraft) => Promise<void> | void;
  onCopy?: (draft: CharacterWorkshopDraft) => Promise<void> | void;
  onDelete?: () => Promise<void> | void;
  onExportPack?: () => Promise<void> | void;
  onReplaceAvatar?: (file: File) => Promise<void> | void;
  onRemoveAvatar?: () => Promise<void> | void;
  onReplaceMotion?: (state: CharacterPreviewState, file: File) => Promise<void> | void;
  onRemoveMotion?: (state: CharacterPreviewState) => Promise<void> | void;
  onVoicePreview?: (draft: CharacterWorkshopDraft) => Promise<void> | void;
  onSetDefaultSpace?: () => Promise<void> | void;
}

type ChoiceOption = {
  value: string;
  label: string;
  blurb: string;
  disabled?: boolean;
  disabledReason?: string;
};

const RELATION_PRESET_VALUES = new Set(["friend", "senior", "lover", "rival", "partner"]);
const MANAGED_MOTION_STATES: Array<{ state: CharacterPreviewState; label: string }> = [
  { state: "idle", label: "Idle" },
  { state: "listening", label: "Listening" },
  { state: "thinking", label: "Thinking" },
  { state: "speaking", label: "Speaking" },
];
const DEFAULT_VOICE_PREVIEW_TEXT = "今晚先从最难的那一页开始，我会把节奏陪你稳住。";
const LOCAL_NEURAL_VOICE_MODEL = "qwen3-tts-0.6b-customvoice";
const LOCAL_NEURAL_VOICES = [
  { value: "Serena", label: "Serena · 温柔女声" },
  { value: "Vivian", label: "Vivian · 明亮女声" },
  { value: "Dylan", label: "Dylan · 北京青年男声" },
  { value: "Eric", label: "Eric · 成都活力男声" },
  { value: "Uncle_Fu", label: "Uncle Fu · 成熟男声" },
] as const;
const ADULT_RELATIONSHIP_PATTERN =
  /\b(?:lover|romantic(?:\s+partner)?|girlfriend|boyfriend|spouse|husband|wife)\b/i;
const ADULT_RELATIONSHIP_TERMS = [
  "恋人",
  "情侣",
  "男友",
  "女友",
  "爱人",
  "伴侣",
  "亲密关系",
  "浪漫关系",
] as const;

const AVATAR_MODEL_OPTIONS: ChoiceOption[] = [
  {
    value: "mira",
    label: "澄羽 · MIRA · painted-blender",
    blurb: "复盘导航员的 painted-blender 人体：深海青短发、雾白斗篷。不是 VRoid Hub 精模。",
  },
  {
    value: "kite",
    label: "曜柚 · KITE · painted-blender",
    blurb: "启动搭档的 painted-blender 人体：深色高马尾、柚黄夹克。不是 VRoid Hub 精模。",
  },
  {
    value: "cael",
    label: "凛序 · CAEL · painted-blender",
    blurb: "攻坚前辈的 painted-blender 人体：墨蓝长发、长风衣与眼镜。不是 VRoid Hub 精模。",
  },
  {
    value: "lyra",
    label: "弦灯 · LYRA · painted-blender",
    blurb: "创意共学者的 painted-blender 人体：炭紫不对称发、灯橙饰带。不是 VRoid Hub 精模。",
  },
  ...BUILTIN_PORTRAIT_DEFINITIONS.map((definition) => ({
    value: definition.modelId,
    label: definition.pickerLabel,
    blurb: definition.pickerBlurb,
  })),
  ...BUILTIN_PET_DEFINITIONS.map((definition) => ({
    value: definition.modelId,
    label: definition.pickerLabel,
    blurb: definition.pickerBlurb,
  })),
  {
    value: "vrm1_constraint_twist_sample",
    label: "Constraint Sample",
    blurb: "pixiv 许可样本，不是四主角。适合验证完整驱动链路。",
  },
  {
    value: "seed_san",
    label: "Seed-san Sample",
    blurb: "VirtualCast 许可样本，不是四主角；导出时必须保留署名。",
  },
  {
    value: "sendagaya_shino",
    label: "Sendagaya Shino Sample",
    blurb: "pixiv CC0 许可样本，不是澄羽。黑长直学院风。",
  },
  {
    value: "sakurada_fumiriya",
    label: "Sakurada Fumiriya Sample",
    blurb: "pixiv CC0 许可样本，不是凛序。金发冷感男性角色。",
  },
];

const BODY_OPTIONS: ChoiceOption[] = [
  { value: "mini", label: "Mini Body", blurb: "更轻巧，表情和配饰会显得更亲近。" },
  { value: "tall", label: "Tall Body", blurb: "线条更利落，适合冷感或前辈型角色。" },
];

const CAMERA_FRAMING_OPTIONS: ChoiceOption[] = [
  { value: "full_body", label: "Full Body", blurb: "Keep the complete character visible." },
  { value: "portrait", label: "Portrait", blurb: "Move closer for a face-first stage view." },
];

const STAGE_BACKGROUND_OPTIONS: ChoiceOption[] = [
  { value: "neutral", label: "Neutral", blurb: "Warm neutral light for everyday study." },
  { value: "study", label: "Study", blurb: "A cool structured backdrop for focused sessions." },
  { value: "midnight", label: "Midnight", blurb: "A darker cyan-lit stage for late sessions." },
];

const FACE_OPTIONS: ChoiceOption[] = [
  { value: "soft", label: "Soft", blurb: "柔和、容易建立安全感。" },
  { value: "sharp", label: "Sharp", blurb: "更果断，适合高压冲刺节奏。" },
  { value: "round", label: "Round", blurb: "显得元气，适合轻快陪练。" },
  { value: "serene", label: "Serene", blurb: "安静克制，适合夜读和长时陪伴。" },
];

const HAIR_OPTIONS: ChoiceOption[] = [
  { value: "short_bob", label: "Short Bob", blurb: "整洁稳定，适合通用日常搭子。" },
  { value: "long_wave", label: "Long Wave", blurb: "更柔和，也更具陪伴感。" },
  { value: "twin_tail", label: "Twin Tail", blurb: "活泼，适合高能提醒。" },
  { value: "wolf_cut", label: "Wolf Cut", blurb: "利落，适合强节奏反馈。" },
  { value: "hime_cut", label: "Hime Cut", blurb: "静气更足，适合专注环境。" },
  { value: "high_ponytail", label: "High Ponytail", blurb: "动作感强，适合挑战模式。" },
];

const OUTFIT_OPTIONS: ChoiceOption[] = [
  { value: "academy", label: "Academy", blurb: "学院制服，稳定且不分心。" },
  { value: "street", label: "Street", blurb: "日常休闲，更贴近轻量复习。" },
  { value: "studio", label: "Studio", blurb: "录音棚风格，强调语音陪伴。" },
  { value: "techwear", label: "Techwear", blurb: "冷感机能，更像夜间指挥台。" },
];

const ACCESSORY_OPTIONS: ChoiceOption[] = [
  { value: "headphones", label: "Headphones", blurb: "强化语音陪伴氛围。" },
  { value: "hair_clip", label: "Hair Clip", blurb: "轻量点缀，不抢主视觉。" },
  { value: "ribbon", label: "Ribbon", blurb: "偏可爱和柔和的提示。" },
  { value: "glasses", label: "Glasses", blurb: "强调理性与专注感。" },
  { value: "ear_cuff", label: "Ear Cuff", blurb: "增加一点冷感层次。" },
  { value: "badge", label: "Badge", blurb: "适合做空间主题标识。" },
];

const PERSONA_OPTIONS: ChoiceOption[] = [
  { value: "cute", label: "Cute", blurb: "亲昵灵动，用轻松语气降低开始学习的阻力。" },
  { value: "gentle", label: "Gentle", blurb: "先接住情绪，再慢慢推进。" },
  { value: "cool", label: "Cool", blurb: "反馈利落，适合冲刺与纠错。" },
  { value: "spark", label: "Spark", blurb: "元气更足，适合低能量恢复。" },
  { value: "sharp_tongue", label: "Sharp Tongue", blurb: "会吐槽，但不羞辱、不越过用户边界。" },
];

const RELATION_OPTIONS: ChoiceOption[] = [
  { value: "friend", label: "Friend", blurb: "平视、轻松、适合日常复习。" },
  { value: "senior", label: "Senior", blurb: "更会追问，适合系统化学习。" },
  { value: "lover", label: "Lover", blurb: "更亲密的成人关系语气，仍以学习与尊重边界为先。" },
  { value: "rival", label: "Rival", blurb: "适合目标驱动和闯关式节奏。" },
  { value: "partner", label: "Partner", blurb: "更协作，适合长期项目搭档。" },
  { value: "custom", label: "Custom", blurb: "关系文案完全由你定义。" },
];

const VOICE_PROVIDER_OPTIONS: ChoiceOption[] = [
  { value: "mock", label: "Mock", blurb: "本地占位，适合无密钥闭环。" },
  { value: "local-neural", label: "本地神经语音", blurb: "使用内置 Qwen3-TTS 固定声线。" },
  { value: "openai_compatible", label: "OpenAI-compatible", blurb: "通过空间的 TTS 能力位调用。" },
  { value: "elevenlabs", label: "ElevenLabs", blurb: "使用已连接的 ElevenLabs 语音。" },
  { value: "local", label: "Local", blurb: "为可选本地合成器保留槽位。" },
];

const PREVIEW_STATES: Array<{ value: CharacterPreviewState; label: string }> = [
  { value: "idle", label: "Idle" },
  { value: "listening", label: "Listening" },
  { value: "thinking", label: "Thinking" },
  { value: "speaking", label: "Speaking" },
];

const COLOR_FIELDS = [
  { key: "skin_tone", label: "Skin" },
  { key: "hair_color", label: "Hair" },
  { key: "eye_color", label: "Eye" },
  { key: "outfit_color", label: "Outfit" },
  { key: "accent_color", label: "Accent" },
] as const;

function relationToDraft(relationshipRole: string) {
  if (RELATION_PRESET_VALUES.has(relationshipRole)) {
    return {
      relation_mode: relationshipRole,
      relation_custom: "",
    };
  }
  return {
    relation_mode: "custom",
    relation_custom: relationshipRole,
  };
}

export function characterRecipeToWorkshopDraft(
  recipe?: Partial<CharacterRecipe> | null,
  preview?: {
    preview_state?: CharacterPreviewState | null;
    voice_preview_text?: string | null;
  },
): CharacterWorkshopRecipeDraft {
  const normalized = createDefaultCharacterRecipe(recipe ?? {});
  const relation = relationToDraft(normalized.relationship_role);

  return {
    avatar_model: normalized.avatar_model,
    avatar_framing: normalized.avatar_framing,
    stage_background: normalized.stage_background,
    body_base: normalized.base_model,
    face_shape: normalized.face_style,
    hair_style: normalized.hairstyle,
    outfit_style: normalized.outfit,
    accessory_ids: normalized.accessories,
    persona_preset: normalized.personality,
    relation_mode: relation.relation_mode,
    relation_custom: relation.relation_custom,
    warmth: normalized.warmth,
    initiative: normalized.initiative,
    humor: normalized.humor,
    challenge: normalized.challenge,
    motions: normalized.motions,
    voice_provider: normalized.voice_provider,
    voice_model: normalized.voice_model,
    voice_id: normalized.voice_id,
    voice_rate: normalized.speaking_rate,
    voice_preview_text: preview?.voice_preview_text ?? DEFAULT_VOICE_PREVIEW_TEXT,
    preview_state: preview?.preview_state ?? "idle",
    palette: {
      skin_tone: normalized.palette.skin_tone ?? "#f3d3c3",
      hair_color: normalized.palette.hair_color ?? "#5d718d",
      eye_color: normalized.palette.eye_color ?? "#9ed2ff",
      outfit_color: normalized.palette.outfit_color ?? "#29354a",
      accent_color: normalized.palette.accent_color ?? "#77d7d1",
    },
  };
}

export function workshopRecipeToCharacterRecipe(
  draft: CharacterWorkshopRecipeDraft,
): CharacterRecipe {
  return createDefaultCharacterRecipe({
    avatar_model: draft.avatar_model,
    avatar_framing: draft.avatar_framing,
    stage_background: draft.stage_background,
    base_model: draft.body_base,
    face_style: draft.face_shape,
    hairstyle: draft.hair_style,
    outfit: draft.outfit_style,
    accessories: draft.accessory_ids,
    personality: draft.persona_preset,
    relationship_role:
      draft.relation_mode === "custom"
        ? draft.relation_custom.trim() || "friend"
        : draft.relation_mode,
    warmth: draft.warmth,
    initiative: draft.initiative,
    humor: draft.humor,
    challenge: draft.challenge,
    motions: draft.motions,
    voice_provider: draft.voice_provider,
    voice_model: draft.voice_model,
    voice_id: draft.voice_id,
    speaking_rate: draft.voice_rate,
    palette: draft.palette,
  });
}

export function createCharacterWorkshopSeed(
  seed: Partial<CharacterWorkshopDraft> = {},
): CharacterWorkshopDraft {
  return {
    name: seed.name ?? "New Companion",
    description: seed.description ?? "",
    recipe:
      seed.recipe ??
      characterRecipeToWorkshopDraft(undefined, {
        voice_preview_text: DEFAULT_VOICE_PREVIEW_TEXT,
      }),
  };
}

export function characterPackToWorkshopSeed(
  character: Pick<CharacterPackDetail, "name" | "description" | "recipe">,
): CharacterWorkshopDraft {
  return createCharacterWorkshopSeed({
    name: character.name,
    description: character.description ?? "",
    recipe: characterRecipeToWorkshopDraft(character.recipe),
  });
}

const TEMPLATE_PRESETS: Array<{
  id: string;
  title: string;
  blurb: string;
  rosterRole?: string;
  art?: {
    src: string;
    alt: string;
    position?: string;
  };
  draft: CharacterWorkshopDraft;
}> = [
  {
    id: "memory-navigator",
    title: "澄羽 · MIRA",
    rosterRole: "复盘导航员",
    blurb: "沉静、细腻、可靠。陪你把散落的笔记与想法一页页找回来。",
    art: {
      src: "/assets/characters/art/roster/mira.png",
      alt: "原创学习伙伴澄羽，身穿雾白与深海青短斗篷，手托发光的学习记录页",
      position: "50% 36%",
    },
    draft: createCharacterWorkshopSeed({
      name: "澄羽",
      description: "温柔的复盘导航员。擅长整理笔记、回顾对话和稳定学习焦虑，会先接住情绪，再把散落的想法整理成下一步。",
      recipe: characterRecipeToWorkshopDraft(
        {
          avatar_model: "mira",
          avatar_framing: "full_body",
          stage_background: "neutral",
          base_model: "mini",
          face_style: "soft",
          hairstyle: "short_bob",
          outfit: "academy",
          accessories: ["ribbon", "badge"],
          personality: "gentle",
          relationship_role: "friend",
          warmth: 90,
          initiative: 52,
          humor: 30,
          challenge: 22,
          motions: COMPANION_CC0_MOTION_URLS,
          voice_provider: "local-neural",
          voice_model: LOCAL_NEURAL_VOICE_MODEL,
          voice_id: "Serena",
          speaking_rate: 0.94,
          palette: {
            skin_tone: "#f0d3ca",
            hair_color: "#0c5961",
            eye_color: "#78c9ca",
            outfit_color: "#f0eadf",
            accent_color: "#d6644a",
          },
        },
        { voice_preview_text: "先不用急着回答，我们把散落的想法一页页找回来。" },
      ),
    }),
  },
  {
    id: "short-round-captain",
    title: "曜柚 · KITE",
    rosterRole: "启动搭档",
    blurb: "爽朗、敏捷、好胜。把任务切成十二分钟的小回合，先带你跑起来。",
    art: {
      src: "/assets/characters/art/roster/kite.png",
      alt: "原创学习伙伴曜柚，身穿柚黄与松石绿运动夹克，向前做倒数手势",
      position: "50% 30%",
    },
    draft: createCharacterWorkshopSeed({
      name: "曜柚",
      description: "低能量启动搭档。会把目标拆成十到十五分钟的小回合，用倒数、庆祝和及时反馈帮你跨过开始阻力。",
      recipe: characterRecipeToWorkshopDraft(
        {
          avatar_model: "kite",
          avatar_framing: "full_body",
          stage_background: "study",
          base_model: "mini",
          face_style: "round",
          hairstyle: "high_ponytail",
          outfit: "street",
          accessories: ["hair_clip", "badge"],
          personality: "spark",
          relationship_role: "rival",
          warmth: 72,
          initiative: 90,
          humor: 72,
          challenge: 58,
          motions: COMPANION_CC0_MOTION_URLS,
          voice_provider: "local-neural",
          voice_model: LOCAL_NEURAL_VOICE_MODEL,
          voice_id: "Eric",
          speaking_rate: 1.1,
          palette: {
            skin_tone: "#efd1c4",
            hair_color: "#2c2528",
            eye_color: "#168b83",
            outfit_color: "#fff4dd",
            accent_color: "#f2c84b",
          },
        },
        { voice_preview_text: "十二分钟就好。你负责开始，我负责把这一局带到终点。" },
      ),
    }),
  },
  {
    id: "constraint-senior",
    title: "凛序 · CAEL",
    rosterRole: "攻坚前辈",
    blurb: "克制、锐利、公正。从唯一确定的条件开始，陪你拆掉最难的那一层。",
    art: {
      src: "/assets/characters/art/roster/cael.png",
      alt: "原创学习伙伴凛序，身穿墨蓝长风衣，在观测书室指出冰青色约束图形",
      position: "50% 28%",
    },
    draft: createCharacterWorkshopSeed({
      name: "凛序",
      description: "逻辑攻坚型前辈。擅长寻找约束、拆解难题并指出知识漏洞；反馈克制而直接，但不会羞辱或越过用户边界。",
      recipe: characterRecipeToWorkshopDraft(
        {
          avatar_model: "cael",
          avatar_framing: "full_body",
          stage_background: "midnight",
          base_model: "tall",
          face_style: "sharp",
          hairstyle: "long_wave",
          outfit: "techwear",
          accessories: ["glasses", "ear_cuff", "badge"],
          personality: "cool",
          relationship_role: "senior",
          warmth: 48,
          initiative: 78,
          humor: 20,
          challenge: 86,
          motions: COMPANION_CC0_MOTION_URLS,
          voice_provider: "local-neural",
          voice_model: LOCAL_NEURAL_VOICE_MODEL,
          voice_id: "Dylan",
          speaking_rate: 0.92,
          palette: {
            skin_tone: "#e7c8bb",
            hair_color: "#162433",
            eye_color: "#86dce3",
            outfit_color: "#162433",
            accent_color: "#c69a52",
          },
        },
        { voice_preview_text: "不要猜答案。把条件给我，我们从唯一确定的地方开始。" },
      ),
    }),
  },
  {
    id: "story-lantern",
    title: "弦灯 · LYRA",
    rosterRole: "创意共学者",
    blurb: "灵动、好奇、共情。把抽象概念讲成画面，让结构在表达中亮起来。",
    art: {
      src: "/assets/characters/art/roster/lyra.png",
      alt: "原创学习伙伴弦灯，身穿炭紫与灯橙创作服，在暖灯工作室展开故事卡片",
      position: "50% 34%",
    },
    draft: createCharacterWorkshopSeed({
      name: "弦灯",
      description: "创意共学者。适合写作、脑暴和语言表达，会把抽象概念变成画面，再陪你把灵感整理成清楚的结构。",
      recipe: characterRecipeToWorkshopDraft(
        {
          avatar_model: "lyra",
          avatar_framing: "full_body",
          stage_background: "midnight",
          base_model: "mini",
          face_style: "serene",
          hairstyle: "short_bob",
          outfit: "studio",
          accessories: ["ear_cuff", "badge"],
          personality: "gentle",
          relationship_role: "partner",
          warmth: 84,
          initiative: 66,
          humor: 72,
          challenge: 36,
          motions: COMPANION_CC0_MOTION_URLS,
          voice_provider: "local-neural",
          voice_model: LOCAL_NEURAL_VOICE_MODEL,
          voice_id: "Vivian",
          speaking_rate: 1.02,
          palette: {
            skin_tone: "#f0d3ca",
            hair_color: "#463843",
            eye_color: "#79a99e",
            outfit_color: "#463843",
            accent_color: "#e78745",
          },
        },
        { voice_preview_text: "先把它讲得像一个故事，结构会在我们说出口时自己亮起来。" },
      ),
    }),
  },
  {
    id: "day-shift",
    title: "Day Shift",
    blurb: "白天模式，柔和陪伴，适合资料梳理和逐步推进。形象用 Sendagaya Shino 许可样本，不是澄羽。",
    draft: createCharacterWorkshopSeed({
      name: "Mika",
      description: "适合白天学习场景的陪练角色，会先安稳节奏，再逐步推进难点。",
      recipe: characterRecipeToWorkshopDraft(
        {
          avatar_model: "sendagaya_shino",
          base_model: "mini",
          face_style: "soft",
          hairstyle: "short_bob",
          outfit: "academy",
          accessories: ["headphones", "ribbon"],
          personality: "gentle",
          relationship_role: "friend",
          warmth: 78,
          initiative: 56,
          humor: 42,
          challenge: 28,
          voice_provider: "local-neural",
          voice_model: LOCAL_NEURAL_VOICE_MODEL,
          voice_id: "Serena",
          speaking_rate: 1,
          palette: {
            skin_tone: "#f0d3ca",
            hair_color: "#7d98b8",
            eye_color: "#8ee1ff",
            outfit_color: "#22314a",
            accent_color: "#72d8d2",
          },
        },
        { voice_preview_text: "先把今天最卡的概念说出来，我会陪你拆成三步。" },
      ),
    }),
  },
  {
    id: "airi-inspired-stage",
    title: "Stage Companion",
    blurb: "AIRI 灵感的社区预设，使用 Sendagaya Shino CC0 许可样本；不是 AIRI 官方角色，也不是澄羽。",
    draft: createCharacterWorkshopSeed({
      name: "Mio",
      description:
        "受 AIRI 的舞台式数字伴侣体验启发，使用仓库内 CC0 VRM；不是 AIRI 官方角色或官方资产。会用短句确认进度，在卡顿时主动把学习拉回下一步。",
      recipe: characterRecipeToWorkshopDraft(
        {
          avatar_model: "sendagaya_shino",
          avatar_framing: "portrait",
          stage_background: "midnight",
          base_model: "mini",
          face_style: "serene",
          hairstyle: "hime_cut",
          outfit: "studio",
          accessories: ["headphones", "badge"],
          personality: "spark",
          relationship_role: "partner",
          warmth: 78,
          initiative: 72,
          humor: 50,
          challenge: 40,
          motions: COMPANION_CC0_MOTION_URLS,
          voice_provider: "local-neural",
          voice_model: LOCAL_NEURAL_VOICE_MODEL,
          voice_id: "Vivian",
          speaking_rate: 1.04,
          palette: {
            skin_tone: "#f0d3ca",
            hair_color: "#171c2b",
            eye_color: "#67d8ee",
            outfit_color: "#28324a",
            accent_color: "#58d8bd",
          },
        },
        { voice_preview_text: "连接完成。把今天想完成的目标交给我，我们一起把下一步变得清楚。" },
      ),
    }),
  },
  {
    id: "midnight-coach",
    title: "Midnight Coach",
    blurb: "夜间模式，节奏更锋利，适合冲刺和查漏补缺。形象用 Sakurada Fumiriya 许可样本，不是凛序。",
    draft: createCharacterWorkshopSeed({
      name: "Rei",
      description: "适合夜间冲刺的前辈型角色，会把模糊问题压缩成可执行动作。",
      recipe: characterRecipeToWorkshopDraft(
        {
          avatar_model: "sakurada_fumiriya",
          base_model: "tall",
          face_style: "sharp",
          hairstyle: "wolf_cut",
          outfit: "techwear",
          accessories: ["headphones", "glasses", "ear_cuff"],
          personality: "cool",
          relationship_role: "senior",
          warmth: 54,
          initiative: 74,
          humor: 33,
          challenge: 71,
          voice_provider: "local-neural",
          voice_model: LOCAL_NEURAL_VOICE_MODEL,
          voice_id: "Dylan",
          speaking_rate: 0.92,
          palette: {
            skin_tone: "#e7c8bb",
            hair_color: "#50658b",
            eye_color: "#80f0ff",
            outfit_color: "#171f31",
            accent_color: "#85e3ff",
          },
        },
        { voice_preview_text: "别再绕圈，先把题干里的约束条件一条条说清楚。" },
      ),
    }),
  },
  {
    id: "focus-spark",
    title: "Focus Spark",
    blurb: "元气挑战者，使用 Seed-san 许可样本，不是曜柚；随应用保留 VirtualCast 署名。",
    draft: createCharacterWorkshopSeed({
      name: "Aki",
      description: "适合低能量启动和限时练习的元气搭档，会把目标拆成短回合，再用及时反馈维持节奏。",
      recipe: characterRecipeToWorkshopDraft(
        {
          avatar_model: "seed_san",
          avatar_framing: "portrait",
          stage_background: "study",
          base_model: "mini",
          face_style: "round",
          hairstyle: "high_ponytail",
          outfit: "street",
          accessories: ["headphones", "hair_clip"],
          personality: "spark",
          relationship_role: "rival",
          warmth: 70,
          initiative: 84,
          humor: 62,
          challenge: 64,
          motions: COMPANION_CC0_MOTION_URLS,
          voice_provider: "local-neural",
          voice_model: LOCAL_NEURAL_VOICE_MODEL,
          voice_id: "Eric",
          speaking_rate: 1.06,
          palette: {
            skin_tone: "#efd1c4",
            hair_color: "#176f70",
            eye_color: "#65d8e4",
            outfit_color: "#f2f1e8",
            accent_color: "#d87655",
          },
        },
        { voice_preview_text: "先开一个十二分钟的小回合。你只管开始，我来帮你守住节奏。" },
      ),
    }),
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readStringRecord(value: unknown) {
  if (!isRecord(value)) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function relationDisplay(recipe: CharacterWorkshopRecipeDraft) {
  const actualValue =
    recipe.relation_mode === "custom"
      ? recipe.relation_custom.trim()
      : recipe.relation_mode;
  const option = RELATION_OPTIONS.find((item) => item.value === actualValue);
  return option?.label ?? (actualValue || "Unset");
}

function normalizeRelationshipText(value: string) {
  return value.trim().toLowerCase();
}

function usesAdultRelationship(text: string) {
  const normalized = normalizeRelationshipText(text);
  if (!normalized) {
    return false;
  }
  return (
    ADULT_RELATIONSHIP_PATTERN.test(normalized) ||
    ADULT_RELATIONSHIP_TERMS.some((term) => normalized.includes(term))
  );
}

function getAdultRelationshipBlockedReason(
  recipe: CharacterWorkshopRecipeDraft,
  adultRelationshipsEnabled: boolean,
) {
  if (adultRelationshipsEnabled) {
    return null;
  }
  if (recipe.relation_mode === "lover") {
    return "Lover 关系已被关闭。请先在 Settings 中由本机拥有者确认 18+ 后开启成人关系模式。";
  }
  if (recipe.relation_mode === "custom" && usesAdultRelationship(recipe.relation_custom)) {
    return "当前自定义关系包含成人关系词汇。请改成非成人关系描述，或先在 Settings 中开启成人关系模式。";
  }
  return null;
}

function personaDisplay(recipe: CharacterWorkshopRecipeDraft) {
  return PERSONA_OPTIONS.find((item) => item.value === recipe.persona_preset)?.label ?? recipe.persona_preset;
}

function previewLabel(state: CharacterPreviewState) {
  return PREVIEW_STATES.find((item) => item.value === state)?.label ?? state;
}

function previewPropsJson(recipe: CharacterWorkshopRecipeDraft) {
  return JSON.stringify(
    {
      state: recipe.preview_state,
      recipe: workshopRecipeToCharacterRecipe(recipe),
    },
    null,
    2,
  );
}

function parseImportedDraft(payload: unknown): CharacterWorkshopDraft {
  if (!isRecord(payload)) {
    throw new Error("导入文件不是有效对象。");
  }

  const name = typeof payload.name === "string" ? payload.name : "Imported Companion";
  const description = typeof payload.description === "string" ? payload.description : "";
  const recipeSource = isRecord(payload.recipe) ? payload.recipe : payload;
  const paletteSource = isRecord(recipeSource.palette) ? recipeSource.palette : {};

  if ("base_model" in recipeSource || "face_style" in recipeSource) {
    return createCharacterWorkshopSeed({
      name,
      description,
      recipe: characterRecipeToWorkshopDraft(
        {
          avatar_model:
            typeof recipeSource.avatar_model === "string"
              ? recipeSource.avatar_model
              : undefined,
          avatar_framing:
            recipeSource.avatar_framing === "portrait" || recipeSource.avatar_framing === "full_body"
              ? recipeSource.avatar_framing
              : undefined,
          stage_background:
            recipeSource.stage_background === "neutral"
            || recipeSource.stage_background === "study"
            || recipeSource.stage_background === "midnight"
              ? recipeSource.stage_background
              : undefined,
          base_model: typeof recipeSource.base_model === "string" ? recipeSource.base_model : undefined,
          face_style: typeof recipeSource.face_style === "string" ? recipeSource.face_style : undefined,
          hairstyle: typeof recipeSource.hairstyle === "string" ? recipeSource.hairstyle : undefined,
          outfit: typeof recipeSource.outfit === "string" ? recipeSource.outfit : undefined,
          accessories: Array.isArray(recipeSource.accessories)
            ? recipeSource.accessories.filter((item): item is string => typeof item === "string")
            : undefined,
          personality: typeof recipeSource.personality === "string" ? recipeSource.personality : undefined,
          relationship_role:
            typeof recipeSource.relationship_role === "string" ? recipeSource.relationship_role : undefined,
          warmth: typeof recipeSource.warmth === "number" ? recipeSource.warmth : undefined,
          initiative: typeof recipeSource.initiative === "number" ? recipeSource.initiative : undefined,
          humor: typeof recipeSource.humor === "number" ? recipeSource.humor : undefined,
          challenge: typeof recipeSource.challenge === "number" ? recipeSource.challenge : undefined,
          motions: readStringRecord(recipeSource.motions),
          voice_provider:
            typeof recipeSource.voice_provider === "string" ? recipeSource.voice_provider : undefined,
          voice_model: typeof recipeSource.voice_model === "string" ? recipeSource.voice_model : undefined,
          voice_id: typeof recipeSource.voice_id === "string" ? recipeSource.voice_id : undefined,
          speaking_rate:
            typeof recipeSource.speaking_rate === "number" ? recipeSource.speaking_rate : undefined,
          palette: {
            ...(typeof paletteSource.skin_tone === "string" ? { skin_tone: paletteSource.skin_tone } : {}),
            ...(typeof paletteSource.hair_color === "string" ? { hair_color: paletteSource.hair_color } : {}),
            ...(typeof paletteSource.eye_color === "string" ? { eye_color: paletteSource.eye_color } : {}),
            ...(typeof paletteSource.outfit_color === "string" ? { outfit_color: paletteSource.outfit_color } : {}),
            ...(typeof paletteSource.accent_color === "string" ? { accent_color: paletteSource.accent_color } : {}),
          },
        },
        {
          preview_state:
            typeof payload.preview_state === "string"
              ? (payload.preview_state as CharacterPreviewState)
              : undefined,
          voice_preview_text:
            typeof payload.voice_preview_text === "string" ? payload.voice_preview_text : undefined,
        },
      ),
    });
  }

  return createCharacterWorkshopSeed({
    name,
    description,
    recipe: {
      avatar_model:
        typeof recipeSource.avatar_model === "string"
          ? recipeSource.avatar_model
          : "mira",
      avatar_framing:
        recipeSource.avatar_framing === "portrait" || recipeSource.avatar_framing === "full_body"
          ? recipeSource.avatar_framing
          : "full_body",
      stage_background:
        recipeSource.stage_background === "study" || recipeSource.stage_background === "midnight"
          ? recipeSource.stage_background
          : "neutral",
      body_base: typeof recipeSource.body_base === "string" ? recipeSource.body_base : "mini",
      face_shape: typeof recipeSource.face_shape === "string" ? recipeSource.face_shape : "soft",
      hair_style: typeof recipeSource.hair_style === "string" ? recipeSource.hair_style : "short_bob",
      outfit_style: typeof recipeSource.outfit_style === "string" ? recipeSource.outfit_style : "academy",
      accessory_ids: Array.isArray(recipeSource.accessory_ids)
        ? recipeSource.accessory_ids.filter((item): item is string => typeof item === "string")
        : [],
      persona_preset:
        typeof recipeSource.persona_preset === "string" ? recipeSource.persona_preset : "gentle",
      relation_mode:
        typeof recipeSource.relation_mode === "string" ? recipeSource.relation_mode : "friend",
      relation_custom:
        typeof recipeSource.relation_custom === "string" ? recipeSource.relation_custom : "",
      warmth: typeof recipeSource.warmth === "number" ? recipeSource.warmth : 72,
      initiative: typeof recipeSource.initiative === "number" ? recipeSource.initiative : 58,
      humor: typeof recipeSource.humor === "number" ? recipeSource.humor : 44,
      challenge: typeof recipeSource.challenge === "number" ? recipeSource.challenge : 34,
      motions: readStringRecord(recipeSource.motions) ?? {},
      voice_provider:
        typeof recipeSource.voice_provider === "string" ? recipeSource.voice_provider : "mock",
      voice_model: typeof recipeSource.voice_model === "string" ? recipeSource.voice_model : "mock-voice",
      voice_id: typeof recipeSource.voice_id === "string" ? recipeSource.voice_id : "default",
      voice_rate: typeof recipeSource.voice_rate === "number" ? recipeSource.voice_rate : 1,
      voice_preview_text:
        typeof recipeSource.voice_preview_text === "string"
          ? recipeSource.voice_preview_text
          : DEFAULT_VOICE_PREVIEW_TEXT,
      preview_state:
        typeof recipeSource.preview_state === "string"
          ? (recipeSource.preview_state as CharacterPreviewState)
          : "idle",
      palette: {
        skin_tone: typeof paletteSource.skin_tone === "string" ? paletteSource.skin_tone : "#f3d3c3",
        hair_color: typeof paletteSource.hair_color === "string" ? paletteSource.hair_color : "#5d718d",
        eye_color: typeof paletteSource.eye_color === "string" ? paletteSource.eye_color : "#9ed2ff",
        outfit_color: typeof paletteSource.outfit_color === "string" ? paletteSource.outfit_color : "#29354a",
        accent_color: typeof paletteSource.accent_color === "string" ? paletteSource.accent_color : "#77d7d1",
      },
    },
  });
}

export function characterStatusLabel(character: CharacterPackDetail | null) {
  if (!character) {
    return "Draft";
  }
  return character.visibility === "shared" ? "Shared" : "Private";
}

const APPEARANCE_SLOT_LABELS = {
  body: "Body",
  face: "Face",
  hairstyle: "Hair",
  outfit: "Outfit",
  accessory: "Accessory",
} as const;

const EXPRESSION_STATUS_LABELS: Record<AvatarExpressionCapabilityStatus, string> = {
  safe: "safe",
  binary: "binary; skipped",
  "blink-override": "overrides blink; skipped",
  "mouth-override": "overrides mouth; skipped",
  "blink-mouth-override": "overrides blink and mouth; skipped",
  "unsafe-metadata": "metadata incomplete; skipped",
  missing: "missing",
};

function manifestText(manifest: CharacterAssetManifest | null | undefined, key: string) {
  const value = manifest?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function manifestBoolean(manifest: CharacterAssetManifest | null | undefined, key: string) {
  const value = manifest?.[key];
  if (typeof value === "boolean") {
    return value ? "yes" : "no";
  }
  return typeof value === "string" && value.trim() ? value.trim() : "not declared";
}

function hasManifestLicenseFacts(manifest: CharacterAssetManifest | null | undefined) {
  return [
    "license",
    "author",
    "source_url",
    "redistribution_allowed",
    "modification_allowed",
    "attribution_required",
  ].some((key) => {
    const value = manifest?.[key];
    return typeof value === "boolean"
      || (typeof value === "string" && value.trim().length > 0);
  });
}

function assetFilename(value: string | null) {
  return value?.split("/").pop() ?? value;
}

export function CharacterWorkshop({
  mode,
  seed,
  seedKey,
  adultRelationshipsEnabled = false,
  busy = false,
  notice,
  error,
  assetError,
  assetLoading = false,
  assetPreviewStale = false,
  assetManifest,
  motionAssetUrls,
  title,
  description,
  submitLabel,
  statusLabel,
  assetUrl,
  licensedRuntimeAsset,
  attachedModelLabel,
  previewSpaces = [],
  previewSpaceId = "",
  onPreviewSpaceChange,
  defaultCharacterSpaceIds = [],
  speechController,
  onSubmit,
  onCopy,
  onDelete,
  onExportPack,
  onReplaceAvatar,
  onRemoveAvatar,
  onReplaceMotion,
  onRemoveMotion,
  onVoicePreview,
  onSetDefaultSpace,
}: CharacterWorkshopProps) {
  const [draft, setDraft] = useState<CharacterWorkshopDraft>(() => seed);
  const [localNotice, setLocalNotice] = useState<string | null>(null);
  const [runtimeCapabilities, setRuntimeCapabilities] = useState<AvatarRuntimeCapabilities | null>(null);
  const [runtimeCapabilitiesAssetUrl, setRuntimeCapabilitiesAssetUrl] = useState<
    string | null | undefined
  >(undefined);
  const [runtimeMode, setRuntimeMode] = useState<AvatarRuntimeMode>("loading");
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const avatarFileInputRef = useRef<HTMLInputElement | null>(null);
  const motionFileInputRef = useRef<HTMLInputElement | null>(null);
  const pendingMotionStateRef = useRef<CharacterPreviewState>("idle");
  const hasAttachedModel = Boolean(attachedModelLabel);
  const configuredMotionCount = PREVIEW_STATES.filter(
    ({ value }) => typeof draft.recipe.motions[value] === "string"
      && draft.recipe.motions[value].toLowerCase().endsWith(".vrma"),
  ).length;

  useEffect(() => {
    setDraft(seed);
    setLocalNotice(null);
  }, [seed, seedKey]);

  useEffect(() => {
    if (assetLoading || assetPreviewStale) {
      setRuntimeCapabilities(null);
      setRuntimeCapabilitiesAssetUrl(undefined);
      setRuntimeMode("loading");
    }
  }, [assetLoading, assetPreviewStale]);

  const handleCapabilitiesChange = useCallback(
    (capabilities: AvatarRuntimeCapabilities | null) => {
      setRuntimeCapabilities(capabilities);
      setRuntimeCapabilitiesAssetUrl(capabilities ? assetUrl : undefined);
    },
    [assetUrl],
  );

  const mergedNotice = notice ?? localNotice;
  const adultRelationshipBlockedReason = useMemo(
    () => getAdultRelationshipBlockedReason(draft.recipe, adultRelationshipsEnabled),
    [adultRelationshipsEnabled, draft.recipe],
  );
  const relationOptions = useMemo(
    () =>
      RELATION_OPTIONS.map((option) =>
        option.value === "lover" && !adultRelationshipsEnabled
          ? {
              ...option,
              disabled: true,
              disabledReason:
                "成人关系模式当前关闭。先到 Settings 完成本机拥有者 18+ 确认，再启用该关系。",
            }
          : option,
      ),
    [adultRelationshipsEnabled],
  );
  const previewProps = useMemo(() => previewPropsJson(draft.recipe), [draft.recipe]);
  const selectedPreviewSpace = useMemo(
    () => previewSpaces.find((space) => space.id === previewSpaceId) ?? null,
    [previewSpaceId, previewSpaces],
  );
  const defaultCharacterSpaceIdSet = useMemo(
    () => new Set(defaultCharacterSpaceIds),
    [defaultCharacterSpaceIds],
  );
  const selectedSpaceIsDefaultCharacter = selectedPreviewSpace
    ? defaultCharacterSpaceIdSet.has(selectedPreviewSpace.id)
    : false;
  const selectedVoiceProviderIsKnown = VOICE_PROVIDER_OPTIONS.some(
    (option) => option.value === draft.recipe.voice_provider,
  );
  const selectedLocalNeuralVoiceIsKnown = LOCAL_NEURAL_VOICES.some(
    (voice) => voice.value === draft.recipe.voice_id,
  );
  const runtimeRecipe = useMemo(
    () => ({
      ...workshopRecipeToCharacterRecipe(draft.recipe),
      display_name: draft.name,
      relationship_label: relationDisplay(draft.recipe),
      ...(assetUrl ? { vrm_asset_url: assetUrl } : {}),
    }),
    [assetUrl, draft.name, draft.recipe],
  );
  const runtimeRecipeView = useMemo(() => getRuntimeRecipeView(runtimeRecipe), [runtimeRecipe]);
  const spriteRuntimeDefinition = runtimeRecipeView.spriteDefinition;
  const portraitRuntimeDefinition = runtimeRecipeView.portraitDefinition;
  const builtIn2dRuntimeReady = (
    runtimeRecipeView.runtimeKind === "sprite_2d"
    || runtimeRecipeView.runtimeKind === "portrait_2d"
  ) && runtimeMode === "ready";
  const attachedModelPath = manifestText(assetManifest, "model_path");
  const displayedModelFilename = manifestText(assetManifest, "source_filename")
    ?? assetFilename(attachedModelPath)
    ?? assetFilename(runtimeRecipeView.vrmAssetUrl)
    ?? "Built-in model";
  const isAiriPersonaImport = manifestText(assetManifest, "source_format") === "airi-character-card";
  const sourceDisplayModelFormat = manifestText(assetManifest, "source_display_model_format");
  const sourceDisplayModelName = manifestText(assetManifest, "source_display_model_name");
  const hasSourceDisplayModel = Boolean(sourceDisplayModelFormat || sourceDisplayModelName);
  const sourceDisplayModelWasImported = assetManifest?.source_display_model_imported === true;
  const sourceDisplayModelWasSkipped = assetManifest?.source_display_model_imported === false;
  const inspectedCapabilities = assetLoading
    || assetPreviewStale
    || runtimeCapabilitiesAssetUrl !== assetUrl
    ? null
    : runtimeCapabilities;
  const recognizedAppearanceSlots = inspectedCapabilities
    ? Object.values(inspectedCapabilities.appearance.slots).reduce(
        (total, slot) => total + slot.recognized,
        0,
      )
    : 0;
  const selectedAppearanceSlots = inspectedCapabilities
    ? Object.values(inspectedCapabilities.appearance.slots).reduce(
        (total, slot) => total + slot.selected,
        0,
      )
    : 0;
  const safeExpressions = inspectedCapabilities?.expressions
    .filter((expression) => expression.status === "safe")
    .map((expression) => expression.name) ?? [];
  const previewBlocked = hasAttachedModel && !assetUrl && !licensedRuntimeAsset;
  const runtimeFailed = runtimeMode === "fallback" || runtimeMode === "blocked" || runtimeMode === "error";
  const hasAssetLicenseFacts = hasManifestLicenseFacts(assetManifest);
  const capabilitySource = assetLoading
    ? "loading"
    : assetPreviewStale
      ? "previous-preview"
      : inspectedCapabilities
        ? "runtime"
        : builtIn2dRuntimeReady
          ? "runtime"
        : licensedRuntimeAsset && runtimeMode === "ready"
          ? "runtime"
          : assetError || previewBlocked || runtimeFailed
          ? "error"
          : "pending";
  const capabilityStatus = assetLoading
    ? "Reading assets"
    : assetPreviewStale
      ? "Previous preview"
      : inspectedCapabilities
        ? inspectedCapabilities.motionMode === "loading"
          ? "Checking motions"
          : "Runtime inspected"
        : builtIn2dRuntimeReady
          ? `${portraitRuntimeDefinition?.displayName ?? spriteRuntimeDefinition?.displayName ?? "2D"} runtime ready`
        : licensedRuntimeAsset && runtimeMode === "ready"
          ? "Licensed runtime ready"
          : assetError || previewBlocked || runtimeFailed
          ? "Preview unavailable"
          : "Waiting for runtime";
  const persistedPreviewFailed = mode === "edit"
    && (assetPreviewStale || previewBlocked || runtimeFailed);

  function patchRecipe(patch: Partial<CharacterWorkshopRecipeDraft>) {
    setDraft((current) => ({
      ...current,
      recipe: {
        ...current.recipe,
        ...patch,
      },
    }));
  }

  function selectVoiceProvider(voiceProvider: string) {
    if (voiceProvider !== "local-neural") {
      patchRecipe({ voice_provider: voiceProvider });
      return;
    }
    patchRecipe({
      voice_provider: voiceProvider,
      voice_model: LOCAL_NEURAL_VOICE_MODEL,
      voice_id: "Serena",
    });
  }

  function replaceAvatar(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !onReplaceAvatar) {
      return;
    }
    const confirmed = window.confirm(
      "替换会覆盖当前导入的 VRM 资产层，角色包内的 VRMA 动作将回退。单独上传的本地动作会保留，但可能因骨架不同而降级。未保存编辑会丢失并恢复到已保存值。人格、声音、关系和学习空间绑定会保留。继续吗？",
    );
    if (confirmed) {
      void onReplaceAvatar(file);
    }
  }

  function removeAvatar() {
    if (!onRemoveAvatar) {
      return;
    }
    const confirmed = window.confirm(
      "恢复内置模型会移除当前导入的 VRM 资产层，角色包内的 VRMA 动作将回退。单独上传的本地动作会保留，但可能因骨架不同而降级。未保存编辑会丢失并恢复到已保存值。人格、声音、关系和学习空间绑定会保留。继续吗？",
    );
    if (confirmed) {
      void onRemoveAvatar();
    }
  }

  function managedMotionEntry(state: CharacterPreviewState) {
    const managedMotions = assetManifest?.managed_motions;
    if (!managedMotions || typeof managedMotions !== "object" || Array.isArray(managedMotions)) {
      return null;
    }
    const entry = (managedMotions as Record<string, unknown>)[state];
    return entry && typeof entry === "object" && !Array.isArray(entry)
      ? entry as Record<string, unknown>
      : null;
  }

  function chooseMotion(state: CharacterPreviewState) {
    pendingMotionStateRef.current = state;
    motionFileInputRef.current?.click();
  }

  function replaceMotion(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !onReplaceMotion) {
      return;
    }
    const state = pendingMotionStateRef.current;
    if (window.confirm(
      `Uploading ${state} resets unsaved editor changes to the saved character. Continue?`,
    )) {
      void onReplaceMotion(state, file);
    }
  }

  function removeMotion(state: CharacterPreviewState) {
    if (onRemoveMotion && window.confirm(
      `Removing ${state} resets unsaved editor changes and reveals the packaged, bundled, or procedural fallback. Continue?`,
    )) {
      void onRemoveMotion(state);
    }
  }

  function patchPalette(
    key: keyof CharacterWorkshopRecipeDraft["palette"],
    value: string,
  ) {
    patchRecipe({
      palette: {
        ...draft.recipe.palette,
        [key]: value,
      },
    });
  }

  function toggleAccessory(accessoryId: string) {
    const next = new Set(draft.recipe.accessory_ids);
    if (next.has(accessoryId)) {
      next.delete(accessoryId);
    } else {
      next.add(accessoryId);
    }
    patchRecipe({ accessory_ids: Array.from(next) });
  }

  function applyPreset(presetId: string) {
    const preset = TEMPLATE_PRESETS.find((item) => item.id === presetId);
    if (!preset) {
      return;
    }
    setDraft(preset.draft);
    setLocalNotice(`已应用 ${preset.title} 模板。`);
  }

  function exportRecipe() {
    const payload: CharacterWorkshopDocument = createCharacterWorkshopDocument({
      name: draft.name,
      description: draft.description,
      recipe: workshopRecipeToCharacterRecipe(draft.recipe),
      preview_state: draft.recipe.preview_state,
      voice_preview_text: draft.recipe.voice_preview_text,
    });
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${draft.name.toLowerCase().replace(/\s+/g, "-") || "character"}-recipe.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    setLocalNotice("已导出统一 CharacterRecipe JSON。");
  }

  function importRecipe(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result));
        setDraft(parseImportedDraft(parsed));
        setLocalNotice(`已导入 ${file.name}。`);
      } catch (importError) {
        setLocalNotice(importError instanceof Error ? importError.message : "导入失败。");
      } finally {
        event.target.value = "";
      }
    };
    reader.readAsText(file);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (adultRelationshipBlockedReason) {
      return;
    }
    await onSubmit({
      ...draft,
      name: draft.name.trim(),
      description: draft.description.trim(),
    });
  }

  const canSubmit =
    draft.name.trim().length > 0 &&
    draft.recipe.voice_model.trim().length > 0 &&
    draft.recipe.voice_id.trim().length > 0 &&
    (draft.recipe.relation_mode !== "custom" || draft.recipe.relation_custom.trim().length > 0) &&
    !adultRelationshipBlockedReason;

  return (
    <section className={styles.shell}>
      <div className={styles.hero}>
        <div className={styles.heroCopy}>
          <p className={styles.eyebrow}>Character Workshop</p>
          <h2>{title}</h2>
          <p>{description}</p>
          <div className={styles.statusRow}>
            <span className={styles.statusPill}>
              {statusLabel ?? (mode === "create" ? "Unsaved Draft" : "Live Character")}
            </span>
            <span className={styles.statusText}>
              {draft.name} / {personaDisplay(draft.recipe)} / {relationDisplay(draft.recipe)}
            </span>
          </div>
        </div>
        <div className={styles.heroMetrics}>
          <article>
            <span>Voice</span>
            <strong>{draft.recipe.voice_provider}</strong>
            <p>{draft.recipe.voice_model}</p>
          </article>
          <article>
            <span>Relation</span>
            <strong>{relationDisplay(draft.recipe)}</strong>
            <p>{draft.recipe.relation_mode === "custom" ? "Custom script" : "Preset role"}</p>
          </article>
          <article>
            <span>Preview</span>
            <strong>{previewLabel(draft.recipe.preview_state)}</strong>
            <p>{configuredMotionCount ? `VRMA ${configuredMotionCount}/4` : "Procedural fallback"}</p>
          </article>
        </div>
      </div>

      {mergedNotice ? <div className={styles.notice}>{mergedNotice}</div> : null}
      {[error, assetError, adultRelationshipBlockedReason].filter(Boolean).map((message) => (
        <div key={message} className={styles.error}>
          {message}
        </div>
      ))}

      <section className={styles.researchShowcase} aria-labelledby="companion-catalog-title">
        <Image
          className={styles.researchShowcaseImage}
          src="/assets/characters/art/original-study-companions.png"
          alt="三位原创二次元学习伙伴，分别呈现温柔、元气与沉静的陪伴氛围"
          width={2172}
          height={724}
          sizes="(max-width: 760px) 100vw, 1200px"
        />
        <div className={styles.researchShowcaseCopy}>
          <p className={styles.eyebrow}>Original companion directions</p>
          <h2 id="companion-catalog-title">选形象，也选相处节奏</h2>
          <p>四主角共学舞台使用本项目 painted-blender 原创 3D（绘制贴图，不是 VRoid Hub 精模）；卡面插画仍是原创。第三方 VRM 只作为许可样本，不是主角外观。</p>
        </div>
      </section>

      <section className={styles.rosterSection} aria-labelledby="featured-companion-roster">
        <div className={styles.rosterHeader}>
          <div>
            <p className={styles.eyebrow}>Starpath study roster</p>
            <h3 id="featured-companion-roster">四种学习状态，四名真实可选伙伴</h3>
          </div>
          <p>澄羽、曜柚、凛序、弦灯的共学 3D 是 painted-blender 原创人体，不是许可样本。2D 卡面与 Mori/Yuzu 仍是备用；许可样本可选手动加载，不再作为主预设。</p>
        </div>
        <div className={styles.templateRail}>
          {TEMPLATE_PRESETS.filter((preset) => preset.art).map((preset) => (
            <button
              key={preset.id}
              type="button"
              className={`${styles.templateButton} ${styles.templateButtonFeatured}`}
              aria-label={`${preset.title}，${preset.rosterRole}。${preset.blurb}`}
              data-testid={`companion-preset-${preset.id}`}
              onClick={() => applyPreset(preset.id)}
            >
              {preset.art ? (
                <span className={styles.templateArtwork}>
                  <Image
                    src={preset.art.src}
                    alt={preset.art.alt}
                    fill
                    sizes="(max-width: 760px) 78vw, 280px"
                    style={{ objectPosition: preset.art.position }}
                  />
                </span>
              ) : null}
              <span className={styles.templateCopy}>
                <small>{preset.rosterRole}</small>
                <strong>{preset.title}</strong>
                <span>{preset.blurb}</span>
              </span>
            </button>
          ))}
        </div>
      </section>

      <details className={styles.legacyTemplates}>
        <summary>更多节奏模板</summary>
        <div className={`${styles.templateRail} ${styles.templateRailCompact}`}>
          {TEMPLATE_PRESETS.filter((preset) => !preset.art).map((preset) => (
            <button key={preset.id} type="button" className={styles.templateButton} onClick={() => applyPreset(preset.id)}>
              <strong>{preset.title}</strong>
              <span>{preset.blurb}</span>
            </button>
          ))}
        </div>
      </details>

      <form className={styles.layout} onSubmit={handleSubmit}>
        <div className={styles.main}>
          <section className={styles.card}>
            <div className={styles.cardHeader}>
              <div>
                <p className={styles.eyebrow}>Identity</p>
                <h3>Base Profile</h3>
              </div>
            </div>
            <div className={styles.formGrid}>
              <label className={styles.field}>
                <span>Name</span>
                <input value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} />
              </label>
              <label className={styles.field}>
                <span>Voice Preview</span>
                <input
                  value={draft.recipe.voice_preview_text}
                  onChange={(event) => patchRecipe({ voice_preview_text: event.target.value })}
                />
              </label>
              <label className={`${styles.field} ${styles.fieldFull}`}>
                <span>Description</span>
                <textarea
                  rows={4}
                  value={draft.description}
                  onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))}
                />
              </label>
            </div>
          </section>

          <section className={styles.card}>
            <div className={styles.cardHeader}>
              <div>
                <p className={styles.eyebrow}>Shape</p>
                <h3>Body, Face, Hair, Outfit</h3>
              </div>
            </div>
            <div className={styles.choiceStack}>
              <ChoiceGroup
                label={hasAttachedModel ? "Attached model" : "Built-in avatar"}
                value={draft.recipe.avatar_model}
                options={AVATAR_MODEL_OPTIONS}
                disabled={hasAttachedModel}
                disabledReason={
                  hasAttachedModel
                    ? `${attachedModelLabel} 正在作为实际渲染源。替换或恢复内置模型会更换整个导入资产层。`
                    : undefined
                }
                onSelect={(value) => patchRecipe({ avatar_model: value })}
              />
              {mode === "edit" && onReplaceAvatar ? (
                <div className={styles.avatarLifecycle}>
                  <p className={styles.choiceHint}>
                    替换会覆盖导入的模型、角色包动作与许可层；包内 VRMA 会回退。单独上传的本地动作会保留，但可能因骨架不同而降级。人格、声音、关系和学习空间绑定保留。
                  </p>
                  <div className={styles.actionCluster}>
                    <button
                      type="button"
                      className={styles.secondaryButton}
                      disabled={busy}
                      onClick={() => avatarFileInputRef.current?.click()}
                    >
                      替换 VRM
                    </button>
                    {hasAttachedModel && onRemoveAvatar ? (
                      <button
                        type="button"
                        className={styles.dangerButton}
                        disabled={busy}
                        onClick={removeAvatar}
                      >
                        恢复内置模型
                      </button>
                    ) : null}
                  </div>
                  <input
                    ref={avatarFileInputRef}
                    hidden
                    type="file"
                    accept=".vrm,model/gltf-binary"
                    aria-label="替换 VRM 文件"
                    onChange={replaceAvatar}
                  />
                </div>
              ) : null}
              {mode === "edit" && onReplaceMotion ? (
                <div className={styles.motionLifecycle}>
                  <div>
                    <strong>Managed VRMA overlays</strong>
                    <p className={styles.choiceHint}>
                      Direct upload is local-only, license unverified, and export blocked until removed.
                      They override runtime motion without changing the saved recipe. Replacing or removing the VRM
                      keeps these overlays, but a different skeleton may retarget poorly or degrade to fallback.
                    </p>
                  </div>
                  <div className={styles.motionRows}>
                    {MANAGED_MOTION_STATES.map(({ state, label }) => {
                      const entry = managedMotionEntry(state);
                      const sourceFilename = typeof entry?.source_filename === "string"
                        ? entry.source_filename
                        : null;
                      return (
                        <div className={styles.motionRow} key={state}>
                          <div>
                            <strong>{label}</strong>
                            <span>{sourceFilename ?? "No managed overlay"}</span>
                            {sourceFilename ? <small>Local only · export blocked</small> : null}
                          </div>
                          <div className={styles.actionCluster}>
                            <button
                              type="button"
                              className={styles.secondaryButton}
                              disabled={busy}
                              aria-label={`${sourceFilename ? "Replace" : "Upload"} ${label} VRMA`}
                              onClick={() => chooseMotion(state)}
                            >
                              {sourceFilename ? "Replace" : "Upload"}
                            </button>
                            {sourceFilename && onRemoveMotion ? (
                              <button
                                type="button"
                                className={styles.dangerButton}
                                disabled={busy}
                                aria-label={`Remove ${label} VRMA`}
                                onClick={() => removeMotion(state)}
                              >
                                Remove
                              </button>
                            ) : null}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <input
                    ref={motionFileInputRef}
                    hidden
                    type="file"
                    accept=".vrma,application/octet-stream"
                    aria-label="Managed VRMA file"
                    onChange={replaceMotion}
                  />
                </div>
              ) : null}
              <ChoiceGroup label="Body Presets" value={draft.recipe.body_base} options={BODY_OPTIONS} onSelect={(value) => patchRecipe({ body_base: value })} />
              <ChoiceGroup
                label="Camera Framing"
                value={draft.recipe.avatar_framing}
                options={CAMERA_FRAMING_OPTIONS}
                onSelect={(value) => patchRecipe({ avatar_framing: value as AvatarFraming })}
              />
              <ChoiceGroup
                label="Stage Background"
                value={draft.recipe.stage_background}
                options={STAGE_BACKGROUND_OPTIONS}
                onSelect={(value) => patchRecipe({ stage_background: value as AvatarStageBackground })}
              />
              <ChoiceGroup label="Face" value={draft.recipe.face_shape} options={FACE_OPTIONS} onSelect={(value) => patchRecipe({ face_shape: value })} />
              <ChoiceGroup label="Hair" value={draft.recipe.hair_style} options={HAIR_OPTIONS} onSelect={(value) => patchRecipe({ hair_style: value })} />
              <ChoiceGroup label="Outfit" value={draft.recipe.outfit_style} options={OUTFIT_OPTIONS} onSelect={(value) => patchRecipe({ outfit_style: value })} />
            </div>
            <div className={styles.accessoryHeader}>
              <span>Accessories</span>
              <p>6 个配饰可多选，直接作用于预览 props。</p>
            </div>
            <div className={styles.accessoryGrid} role="group" aria-label="Accessories">
              {ACCESSORY_OPTIONS.map((option) => {
                const active = draft.recipe.accessory_ids.includes(option.value);
                return (
                  <button
                    key={option.value}
                    type="button"
                    aria-pressed={active}
                    className={styles.accessoryChip}
                    data-active={active}
                    onClick={() => toggleAccessory(option.value)}
                  >
                    <strong>{option.label}</strong>
                    <span>{option.blurb}</span>
                  </button>
                );
              })}
            </div>
          </section>

          <section className={styles.card}>
            <div className={styles.cardHeader}>
              <div>
                <p className={styles.eyebrow}>Tone</p>
                <h3>Palette and Persona</h3>
              </div>
            </div>
            <div className={styles.colorGrid}>
              {COLOR_FIELDS.map((item) => (
                <label key={item.key} className={styles.colorField}>
                  <span>{item.label}</span>
                  <input
                    type="color"
                    value={draft.recipe.palette[item.key]}
                    onChange={(event) => patchPalette(item.key, event.target.value)}
                  />
                </label>
              ))}
            </div>
            <ChoiceGroup label="Persona Presets" value={draft.recipe.persona_preset} options={PERSONA_OPTIONS} onSelect={(value) => patchRecipe({ persona_preset: value })} />
            <div className={styles.sliderGrid}>
              <SliderField label="Warmth" value={draft.recipe.warmth} onChange={(value) => patchRecipe({ warmth: value })} />
              <SliderField label="Initiative" value={draft.recipe.initiative} onChange={(value) => patchRecipe({ initiative: value })} />
              <SliderField label="Humor" value={draft.recipe.humor} onChange={(value) => patchRecipe({ humor: value })} />
              <SliderField label="Challenge" value={draft.recipe.challenge} onChange={(value) => patchRecipe({ challenge: value })} />
            </div>
          </section>

          <section className={styles.card}>
            <div className={styles.cardHeader}>
              <div>
                <p className={styles.eyebrow}>Relation + Voice</p>
                <h3>Conversation Posture</h3>
              </div>
            </div>
            <ChoiceGroup
              label="Relation"
              value={draft.recipe.relation_mode}
              options={relationOptions}
              onSelect={(value) => patchRecipe({ relation_mode: value, relation_custom: value === "custom" ? draft.recipe.relation_custom : "" })}
            />
            {draft.recipe.relation_mode === "custom" ? (
              <label className={styles.field}>
                <span>Custom Relation</span>
                <input
                  value={draft.recipe.relation_custom}
                  onChange={(event) => patchRecipe({ relation_custom: event.target.value })}
                  placeholder="例如：夜间督学 / 项目搭档 / 复习哨兵"
                />
                {!adultRelationshipsEnabled && usesAdultRelationship(draft.recipe.relation_custom) ? (
                  <small className={styles.fieldHint}>
                    这段自定义关系会被视为成人关系。前端会提示，真正的拦截由服务端执行。
                  </small>
                ) : null}
              </label>
            ) : null}
            <div className={styles.formGrid}>
              <label className={styles.field}>
                <span>Voice Provider</span>
                <select value={draft.recipe.voice_provider} onChange={(event) => selectVoiceProvider(event.target.value)}>
                  {!selectedVoiceProviderIsKnown ? (
                    <option value={draft.recipe.voice_provider}>
                      当前配方：{draft.recipe.voice_provider}
                    </option>
                  ) : null}
                  {VOICE_PROVIDER_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                {draft.recipe.voice_provider === "local-neural" ? (
                  <small className={styles.fieldHint}>
                    默认走 builtin-neural-tts（Qwen3-TTS 固定声线）。sidecar ready 时新空间会自动接上；旧 Mock 空间请到该空间「默认模型分配」把 TTS 改成 Built-in Neural TTS。不克隆声音，也不上传音频。
                  </small>
                ) : null}
              </label>
              <label className={styles.field}>
                <span>Voice Model</span>
                <input value={draft.recipe.voice_model} onChange={(event) => patchRecipe({ voice_model: event.target.value })} />
              </label>
              <label className={styles.field}>
                <span>Voice ID</span>
                {draft.recipe.voice_provider === "local-neural" ? (
                  <select value={draft.recipe.voice_id} onChange={(event) => patchRecipe({ voice_id: event.target.value })}>
                    {!selectedLocalNeuralVoiceIsKnown ? (
                      <option value={draft.recipe.voice_id}>
                        当前配方（未映射）：{draft.recipe.voice_id}
                      </option>
                    ) : null}
                    {LOCAL_NEURAL_VOICES.map((voice) => (
                      <option key={voice.value} value={voice.value}>
                        {voice.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input value={draft.recipe.voice_id} onChange={(event) => patchRecipe({ voice_id: event.target.value })} />
                )}
              </label>
              <label className={styles.field}>
                <span>Voice Rate {draft.recipe.voice_rate.toFixed(2)}x</span>
                <input type="range" min={0.8} max={1.2} step={0.02} value={draft.recipe.voice_rate} onChange={(event) => patchRecipe({ voice_rate: Number(event.target.value) })} />
              </label>
            </div>
          </section>
        </div>

        <aside className={styles.aside}>
          <section className={styles.previewCard}>
            <div className={styles.previewHeader}>
              <div>
                <p className={styles.eyebrow}>Realtime Preview</p>
                <h3>{draft.name}</h3>
              </div>
              <span className={styles.previewStatus}>{previewLabel(draft.recipe.preview_state)}</span>
            </div>
            <div className={styles.runtimePreview}>
              {assetLoading && hasAttachedModel && !assetUrl && !licensedRuntimeAsset ? (
                <div className={styles.assetLoading} role="status">
                  Reading the attached model and declared local assets…
                </div>
              ) : previewBlocked ? (
                <div className={styles.assetLoading} role="status">
                  The character was imported, but its attached model preview is unavailable.
                  The saved recipe and asset manifest remain intact.
                </div>
              ) : (
                <AvatarRuntime
                  compact
                  licensedRuntimeAsset={licensedRuntimeAsset}
                  motionAssetUrls={motionAssetUrls}
                  onCapabilitiesChange={handleCapabilitiesChange}
                  onRuntimeModeChange={setRuntimeMode}
                  recipe={runtimeRecipe}
                  speechController={speechController}
                  state={draft.recipe.preview_state}
                />
              )}
            </div>
            <div className={styles.previewStateRow} role="group" aria-label="Preview State">
              {PREVIEW_STATES.map((state) => (
                <button
                  key={state.value}
                  type="button"
                  data-active={draft.recipe.preview_state === state.value}
                  onClick={() => patchRecipe({ preview_state: state.value })}
                >
                  {state.label}
                </button>
              ))}
            </div>
            <div className={styles.previewSpeech}>
              <div className={styles.previewSpeechTopline}>
                <strong>Voice Preview</strong>
                {onVoicePreview ? (
                  <button
                    type="button"
                    className={styles.previewVoiceButton}
                    disabled={busy || !draft.recipe.voice_preview_text.trim()}
                    onClick={() => void onVoicePreview(draft)}
                  >
                    试听声音
                  </button>
                ) : null}
              </div>
              <p>{draft.recipe.voice_preview_text}</p>
            </div>
            {onVoicePreview ? (
              <div className={styles.previewSpacePanel}>
                <label className={styles.field}>
                  <span>TTS Preview Space</span>
                  <select
                    aria-label="TTS 试听学习空间"
                    value={previewSpaceId}
                    onChange={(event) => onPreviewSpaceChange?.(event.target.value)}
                  >
                    <option value="">选择一个学习空间</option>
                    {previewSpaces.map((space) => {
                      const ttsAssignment = space.model_assignments?.find(
                        (assignment) => assignment.capability === "tts",
                      );
                      const status = ttsAssignment?.status ?? "missing";
                      return (
                        <option key={space.id} value={space.id}>
                          {space.title} · TTS {status}
                        </option>
                      );
                    })}
                  </select>
                  <small className={styles.fieldHint}>
                    试听始终使用这里选中的学习空间能力位；仅当前角色的默认空间会自动预选。
                  </small>
                </label>
                {onSetDefaultSpace ? (
                  <div className={styles.defaultBindingPanel}>
                    <button
                      type="button"
                      className={styles.secondaryButton}
                      disabled={busy || !selectedPreviewSpace || selectedSpaceIsDefaultCharacter}
                      aria-label="设为该空间默认角色"
                      onClick={() => void onSetDefaultSpace()}
                    >
                      {selectedSpaceIsDefaultCharacter ? "已是该空间默认角色" : "设为该空间默认角色"}
                    </button>
                    <small className={styles.fieldHint}>
                      {selectedPreviewSpace
                        ? selectedSpaceIsDefaultCharacter
                          ? `当前角色已经是「${selectedPreviewSpace.title}」的默认角色。`
                          : `把当前角色绑定为「${selectedPreviewSpace.title}」的默认角色；该操作不会改变试听选择之外的其他空间。`
                        : "先选择一个学习空间，再显式绑定默认角色。"}
                    </small>
                  </div>
                ) : null}
              </div>
            ) : null}
            <dl className={styles.previewMeta}>
              <div>
                <dt>Persona</dt>
                <dd>{personaDisplay(draft.recipe)}</dd>
              </div>
              <div>
                <dt>Relation</dt>
                <dd>{relationDisplay(draft.recipe)}</dd>
              </div>
              <div>
                <dt>Voice</dt>
                <dd>{draft.recipe.voice_provider} / {draft.recipe.voice_model}</dd>
              </div>
              <div>
                <dt>Rate</dt>
                <dd>{draft.recipe.voice_rate.toFixed(2)}x</dd>
              </div>
            </dl>
          </section>

          <section
            aria-label="Avatar Asset Readiness"
            aria-live="polite"
            className={`${styles.previewCard} ${styles.capabilityCard}`}
            data-capability-source={capabilitySource}
          >
            <div className={styles.previewHeader}>
              <div>
                <p className={styles.eyebrow}>Import to Runtime</p>
                <h3>Avatar Asset Readiness</h3>
              </div>
              <span className={styles.previewStatus}>{capabilityStatus}</span>
            </div>

            {isAiriPersonaImport ? (
              <p className={styles.capabilityWarning} data-testid="airi-import-provenance">
                {hasSourceDisplayModel ? (
                  <>
                    来源记录：AIRI 角色包人格已导入；
                    {sourceDisplayModelWasImported
                      ? sourceDisplayModelFormat === "live2d-zip" || sourceDisplayModelFormat === "spine-zip"
                        ? "包内显示模型已通过本地归档与引用校验并导入；渲染需要你提供同源的已许可运行时 bridge。未配置或校验失败时仅阻止形象渲染，文字会话仍可继续。该校验不证明使用或再分发授权。"
                        : "包内声明的 VRM 已通过格式与内嵌元数据校验并导入；该校验不证明使用或再分发授权，请自行确认模型许可。它不会自动替换任何学习空间，需在上方明确选择空间并将当前角色设为默认角色。"
                      : sourceDisplayModelWasSkipped
                        ? "这是旧版人格导入记录，未保存包内显示模型；重新导入原 AIRI 角色包后可保存本地模型，并通过同源的已许可运行时 bridge 渲染。"
                        : "显示模型导入状态未经 Companion Space 验证。"}
                    声明：{sourceDisplayModelFormat ?? "unknown format"} · {sourceDisplayModelName ?? "unnamed model"}。
                    来源字段仅记录原包格式；实际渲染仍以本地资产校验与许可 bridge 状态为准。
                  </>
                ) : (
                  <>来源记录：AIRI 角色包人格-only 导入；包内未声明显示模型，当前使用内置 VRM。</>
                )}
              </p>
            ) : null}

            {hasAttachedModel ? (
              <p className={styles.capabilitySummary}>
                Attached model: <strong>{displayedModelFilename}</strong>
              </p>
            ) : (
              <p className={styles.capabilityWarning}>
                No attached model. This character uses the selected built-in {runtimeRecipeView.runtimeKind === "vrm" ? "VRM" : "2D avatar"}. Remote model or
                motion URLs from Character Cards are never fetched; local assets declared by an
                imported CharacterPack may still run.
              </p>
            )}

            {persistedPreviewFailed && !assetLoading ? (
              <p className={styles.capabilityWarning}>
                {assetPreviewStale
                  ? "The new attached asset failed to load. The previous preview remains visible, but its runtime capabilities do not describe the saved manifest. The saved character and new asset manifest remain available for repair or export."
                  : "Preview failed after import. The saved character recipe and asset manifest remain available for repair or export."}
              </p>
            ) : null}

            {inspectedCapabilities ? (
              <>
                <dl className={styles.previewMeta}>
                  <div>
                    <dt>Model</dt>
                    <dd>{displayedModelFilename}</dd>
                  </div>
                  <div>
                    <dt>Format</dt>
                    <dd>{inspectedCapabilities.modelVersion}</dd>
                  </div>
                  <div>
                    <dt>Motion readiness</dt>
                    <dd>
                      {inspectedCapabilities.readyMotionStates.length} / 4 ready ·{" "}
                      {inspectedCapabilities.configuredMotionStates.length} configured ·{" "}
                      {inspectedCapabilities.motionMode}
                    </dd>
                  </div>
                  <div>
                    <dt>Safe expressions</dt>
                    <dd>{safeExpressions.length ? safeExpressions.join(", ") : "none"}</dd>
                  </div>
                  <div>
                    <dt>Appearance slots</dt>
                    <dd>{selectedAppearanceSlots} selected / {recognizedAppearanceSlots} recognized</dd>
                  </div>
                  <div>
                    <dt>Palette materials</dt>
                    <dd>
                      {inspectedCapabilities.appearance.colorMaterialCount} matched
                      {inspectedCapabilities.appearance.colorMaterialSemantics.length
                        ? ` · ${inspectedCapabilities.appearance.colorMaterialSemantics.join(", ")}`
                        : ""}
                    </dd>
                  </div>
                </dl>

                <div className={styles.capabilityList}>
                  <p>
                    <strong>Motion states:</strong>{" "}
                    {inspectedCapabilities.readyMotionStates.length
                      ? inspectedCapabilities.readyMotionStates.join(", ")
                      : "procedural fallback for all states"}
                  </p>
                  <p>
                    <strong>Expression checks:</strong>{" "}
                    {inspectedCapabilities.expressions
                      .map((expression) =>
                        `${expression.name}: ${EXPRESSION_STATUS_LABELS[expression.status]}`,
                      )
                      .join(" · ")}
                  </p>
                  <p>
                    <strong>Recognized parts:</strong>{" "}
                    {(Object.keys(APPEARANCE_SLOT_LABELS) as Array<keyof typeof APPEARANCE_SLOT_LABELS>)
                      .map((slot) => {
                        const counts = inspectedCapabilities.appearance.slots[slot];
                        return `${APPEARANCE_SLOT_LABELS[slot]} ${counts.selected}/${counts.recognized}`;
                      })
                      .join(" · ")}
                  </p>
                </div>

                {recognizedAppearanceSlots === 0 ? (
                  <p className={styles.capabilityWarning}>
                    No recognizable appearance slots. Body, face, hair, outfit, and accessory choices
                    are saved, but this model cannot apply those mesh swaps. Recognized palette
                    materials can still change color.
                  </p>
                ) : null}

                {inspectedCapabilities.motionMode === "reduced" ? (
                  <p className={styles.capabilityWarning}>
                    Reduced-motion mode intentionally leaves VRMA playback inactive while preserving
                    low-frequency blink and speech lip sync.
                  </p>
                ) : inspectedCapabilities.readyMotionStates.length !== 4 ? (
                  <p className={styles.capabilityWarning}>
                    Missing or unusable motion states use the procedural fallback; the avatar remains
                    available for preview and calls.
                  </p>
                ) : null}
              </>
            ) : (
              <p className={styles.capabilitySummary}>
                {assetLoading
                  ? "Reading the imported asset declaration before starting WebGL."
                  : builtIn2dRuntimeReady
                    ? portraitRuntimeDefinition
                      ? `${portraitRuntimeDefinition.displayName} portrait runtime is ready with session-state, emotion, and gesture reactions and no WebGL dependency.`
                      : `${spriteRuntimeDefinition?.displayName ?? "2D avatar"} sprite runtime is ready with ${spriteRuntimeDefinition?.gaze.directions ?? 16} pointer-gaze directions and no WebGL dependency.`
                  : licensedRuntimeAsset && runtimeMode === "ready"
                    ? "Licensed runtime bridge reported a rendered canvas."
                    : previewBlocked || runtimeFailed
                    ? "Runtime inspection could not start in this browser."
                    : "Waiting for the browser VRM runtime to report actual capabilities."}
              </p>
            )}

            {hasAssetLicenseFacts ? (
              <dl className={styles.previewMeta}>
                <div>
                  <dt>License</dt>
                  <dd>{manifestText(assetManifest, "license") ?? "not declared"}</dd>
                </div>
                <div>
                  <dt>Author</dt>
                  <dd>{manifestText(assetManifest, "author") ?? "not declared"}</dd>
                </div>
                <div>
                  <dt>Source</dt>
                  <dd>{manifestText(assetManifest, "source_url") ?? "not declared"}</dd>
                </div>
                <div>
                  <dt>Redistribution</dt>
                  <dd>{manifestBoolean(assetManifest, "redistribution_allowed")}</dd>
                </div>
                <div>
                  <dt>Modification</dt>
                  <dd>{manifestBoolean(assetManifest, "modification_allowed")}</dd>
                </div>
                <div>
                  <dt>Attribution required</dt>
                  <dd>{manifestBoolean(assetManifest, "attribution_required")}</dd>
                </div>
              </dl>
            ) : null}
          </section>

          <section className={styles.previewCard}>
            <div className={styles.previewHeader}>
              <div>
                <p className={styles.eyebrow}>Props</p>
                <h3>Runtime Shape</h3>
              </div>
            </div>
            <pre className={styles.codeBlock}>{previewProps}</pre>
          </section>
        </aside>

        <div className={styles.actionBar}>
          <div className={styles.actionCluster}>
            <button type="submit" className={styles.primaryButton} disabled={busy || !canSubmit}>
              {busy ? "处理中..." : submitLabel}
            </button>
            {onCopy ? (
              <button type="button" className={styles.secondaryButton} disabled={busy} onClick={() => void onCopy(draft)}>
                复制角色
              </button>
            ) : null}
            <button type="button" className={styles.secondaryButton} disabled={busy} onClick={exportRecipe}>
              导出配方
            </button>
            <button type="button" className={styles.secondaryButton} disabled={busy} onClick={() => fileInputRef.current?.click()}>
              导入配方
            </button>
            <input ref={fileInputRef} hidden type="file" accept="application/json" onChange={importRecipe} />
            {onExportPack ? (
              <button type="button" className={styles.secondaryButton} disabled={busy} onClick={() => void onExportPack()}>
                导出角色包
              </button>
            ) : null}
          </div>
          {onDelete ? (
            <button type="button" className={styles.dangerButton} disabled={busy} onClick={() => void onDelete()}>
              删除角色
            </button>
          ) : null}
        </div>
      </form>
    </section>
  );
}

function ChoiceGroup({
  label,
  value,
  options,
  disabled = false,
  disabledReason,
  onSelect,
}: {
  label: string;
  value: string;
  options: ChoiceOption[];
  disabled?: boolean;
  disabledReason?: string;
  onSelect: (value: string) => void;
}) {
  const selectedOption = options.find((option) => option.value === value) ?? null;
  const disabledOption = options.find((option) => option.disabled) ?? null;
  const hint = disabledReason ?? selectedOption?.disabledReason ?? disabledOption?.disabledReason;
  return (
    <fieldset className={styles.choiceGroup}>
      <legend>{label}</legend>
      <div className={styles.choiceGrid}>
        {options.map((option) => {
          const active = value === option.value;
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={active}
              className={styles.choiceButton}
              data-active={active}
              disabled={disabled || option.disabled}
              onClick={() => onSelect(option.value)}
            >
              <strong>{option.label}</strong>
              <span>{option.blurb}</span>
            </button>
          );
        })}
      </div>
      {hint ? <p className={styles.choiceHint}>{hint}</p> : null}
    </fieldset>
  );
}

function SliderField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className={styles.sliderField}>
      <span>
        {label}
        <strong>{value}</strong>
      </span>
      <input type="range" min={0} max={100} value={value} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  );
}
