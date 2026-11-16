import { LOCAL_NEURAL_VOICE_MODEL, LOCAL_NEURAL_VOICES } from "@/lib/voice-presets";
import { COMPANION_CC0_MOTION_URLS } from "@/components/avatar/vrm-recipe";
import { BUILTIN_PET_DEFINITIONS } from "@/components/avatar/pet-registry";
import { BUILTIN_PORTRAIT_DEFINITIONS } from "@/components/avatar/portrait-registry";
import { createCharacterWorkshopDocument, createDefaultCharacterRecipe } from "@/lib/api";
import type {
  AvatarFraming,
  AvatarStageBackground,
  CharacterPackDetail,
  CharacterPreviewState,
  CharacterRecipe,
  CharacterWorkshopDocument,
  CompanionEmotion,
} from "@/lib/types";

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

export type CharacterVoicePreviewState = "idle" | "loading" | "playing";

export type ChoiceOption = {
  value: string;
  label: string;
  blurb: string;
  disabled?: boolean;
  disabledReason?: string;
};

export const RELATION_PRESET_VALUES = new Set(["friend", "senior", "lover", "rival", "partner"]);
export const MANAGED_MOTION_STATES: Array<{ state: CharacterPreviewState; label: string }> = [
  { state: "idle", label: "Idle" },
  { state: "listening", label: "Listening" },
  { state: "thinking", label: "Thinking" },
  { state: "speaking", label: "Speaking" },
];
export const PREVIEW_EMOTIONS: Array<{ value: CompanionEmotion; label: string }> = [
  { value: "neutral", label: "平静" },
  { value: "warm", label: "温柔" },
  { value: "cheerful", label: "开心" },
  { value: "curious", label: "好奇" },
  { value: "focused", label: "专注" },
  { value: "playful", label: "俏皮" },
  { value: "concerned", label: "关切" },
];
export const DEFAULT_VOICE_PREVIEW_TEXT = "今晚先从最难的那一页开始，我会把节奏陪你稳住。";
export const ADULT_RELATIONSHIP_PATTERN =
  /\b(?:lover|romantic(?:\s+partner)?|girlfriend|boyfriend|spouse|husband|wife)\b/i;
export const ADULT_RELATIONSHIP_TERMS = [
  "恋人",
  "情侣",
  "男友",
  "女友",
  "爱人",
  "伴侣",
  "亲密关系",
  "浪漫关系",
] as const;

export const AVATAR_MODEL_OPTIONS: ChoiceOption[] = [
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
  {
    value: "nova",
    label: "星澜 · NOVA · original-vrm",
    blurb: "观测与系统思考型伙伴的原创 VRM：墨紫长发、星图风长外套与冰青光环。",
  },
  {
    value: "echo",
    label: "沐音 · ECHO · original-vrm",
    blurb: "语言与写作型伙伴的原创 VRM：栗色短发、陶土红与苔绿工作室外套。",
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
    blurb: "pixiv 许可样本，独立于原创伙伴阵容，适合验证完整驱动链路。",
  },
  {
    value: "seed_san",
    label: "Seed-san Sample",
    blurb: "VirtualCast 许可样本，独立于原创伙伴阵容；导出时必须保留署名。",
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

export const BODY_OPTIONS: ChoiceOption[] = [
  { value: "mini", label: "Mini Body", blurb: "更轻巧，表情和配饰会显得更亲近。" },
  { value: "tall", label: "Tall Body", blurb: "线条更利落，适合冷感或前辈型角色。" },
];

export const CAMERA_FRAMING_OPTIONS: ChoiceOption[] = [
  { value: "full_body", label: "Full Body", blurb: "Keep the complete character visible." },
  { value: "portrait", label: "Portrait", blurb: "Move closer for a face-first stage view." },
];

export const STAGE_BACKGROUND_OPTIONS: ChoiceOption[] = [
  { value: "neutral", label: "Neutral", blurb: "Warm neutral light for everyday study." },
  { value: "study", label: "Study", blurb: "A cool structured backdrop for focused sessions." },
  { value: "midnight", label: "Midnight", blurb: "A darker cyan-lit stage for late sessions." },
];

export const FACE_OPTIONS: ChoiceOption[] = [
  { value: "soft", label: "Soft", blurb: "柔和、容易建立安全感。" },
  { value: "sharp", label: "Sharp", blurb: "更果断，适合高压冲刺节奏。" },
  { value: "round", label: "Round", blurb: "显得元气，适合轻快陪练。" },
  { value: "serene", label: "Serene", blurb: "安静克制，适合夜读和长时陪伴。" },
];

export const HAIR_OPTIONS: ChoiceOption[] = [
  { value: "short_bob", label: "Short Bob", blurb: "整洁稳定，适合通用日常搭子。" },
  { value: "long_wave", label: "Long Wave", blurb: "更柔和，也更具陪伴感。" },
  { value: "twin_tail", label: "Twin Tail", blurb: "活泼，适合高能提醒。" },
  { value: "wolf_cut", label: "Wolf Cut", blurb: "利落，适合强节奏反馈。" },
  { value: "hime_cut", label: "Hime Cut", blurb: "静气更足，适合专注环境。" },
  { value: "high_ponytail", label: "High Ponytail", blurb: "动作感强，适合挑战模式。" },
];

export const OUTFIT_OPTIONS: ChoiceOption[] = [
  { value: "academy", label: "Academy", blurb: "学院制服，稳定且不分心。" },
  { value: "street", label: "Street", blurb: "日常休闲，更贴近轻量复习。" },
  { value: "studio", label: "Studio", blurb: "录音棚风格，强调语音陪伴。" },
  { value: "techwear", label: "Techwear", blurb: "冷感机能，更像夜间指挥台。" },
];

export const ACCESSORY_OPTIONS: ChoiceOption[] = [
  { value: "headphones", label: "Headphones", blurb: "强化语音陪伴氛围。" },
  { value: "hair_clip", label: "Hair Clip", blurb: "轻量点缀，不抢主视觉。" },
  { value: "ribbon", label: "Ribbon", blurb: "偏可爱和柔和的提示。" },
  { value: "glasses", label: "Glasses", blurb: "强调理性与专注感。" },
  { value: "ear_cuff", label: "Ear Cuff", blurb: "增加一点冷感层次。" },
  { value: "badge", label: "Badge", blurb: "适合做空间主题标识。" },
];

export const PERSONA_OPTIONS: ChoiceOption[] = [
  { value: "cute", label: "Cute", blurb: "亲昵灵动，用轻松语气降低开始学习的阻力。" },
  { value: "gentle", label: "Gentle", blurb: "先接住情绪，再慢慢推进。" },
  { value: "cool", label: "Cool", blurb: "反馈利落，适合冲刺与纠错。" },
  { value: "spark", label: "Spark", blurb: "元气更足，适合低能量恢复。" },
  { value: "sharp_tongue", label: "Sharp Tongue", blurb: "会吐槽，但不羞辱、不越过用户边界。" },
];

export const RELATION_OPTIONS: ChoiceOption[] = [
  { value: "friend", label: "Friend", blurb: "平视、轻松、适合日常复习。" },
  { value: "senior", label: "Senior", blurb: "更会追问，适合系统化学习。" },
  { value: "lover", label: "Lover", blurb: "更亲密的成人关系语气，仍以学习与尊重边界为先。" },
  { value: "rival", label: "Rival", blurb: "适合目标驱动和闯关式节奏。" },
  { value: "partner", label: "Partner", blurb: "更协作，适合长期项目搭档。" },
  { value: "custom", label: "Custom", blurb: "关系文案完全由你定义。" },
];

export const VOICE_PROVIDER_OPTIONS: ChoiceOption[] = [
  { value: "mock", label: "Mock", blurb: "本地占位，适合无密钥闭环。" },
  { value: "local-neural", label: "本地神经语音", blurb: "使用内置 Qwen3-TTS 固定声线。" },
  { value: "openai_compatible", label: "OpenAI-compatible", blurb: "通过空间的 TTS 能力位调用。" },
  { value: "elevenlabs", label: "ElevenLabs", blurb: "使用已连接的 ElevenLabs 语音。" },
  { value: "local", label: "Local", blurb: "为可选本地合成器保留槽位。" },
];

export const PREVIEW_STATES: Array<{ value: CharacterPreviewState; label: string }> = [
  { value: "idle", label: "Idle" },
  { value: "listening", label: "Listening" },
  { value: "thinking", label: "Thinking" },
  { value: "speaking", label: "Speaking" },
];

export const COLOR_FIELDS = [
  { key: "skin_tone", label: "Skin" },
  { key: "hair_color", label: "Hair" },
  { key: "eye_color", label: "Eye" },
  { key: "outfit_color", label: "Outfit" },
  { key: "accent_color", label: "Accent" },
] as const;

export function relationToDraft(relationshipRole: string) {
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

export const TEMPLATE_PRESETS: Array<{
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
    id: "observatory-signal",
    title: "星澜 · NOVA",
    rosterRole: "观测思考者",
    blurb: "冷静、敏锐、耐心。把复杂系统拆成可观测的信号，再陪你找到下一步。",
    art: {
      src: "/assets/characters/art/roster/nova.png",
      alt: "原创学习伙伴星澜，身穿缀有星图的墨紫观测外套，在天文书室托起一枚轨道光环",
      position: "50% 34%",
    },
    draft: createCharacterWorkshopSeed({
      name: "星澜",
      description: "观测与系统思考型学习伙伴。擅长把复杂问题拆成可验证的信号，先建立坐标，再陪你沿着证据推进。",
      recipe: characterRecipeToWorkshopDraft(
        {
          avatar_model: "nova",
          avatar_framing: "full_body",
          stage_background: "midnight",
          base_model: "tall",
          face_style: "sharp",
          hairstyle: "long_wave",
          outfit: "techwear",
          accessories: ["glasses", "badge"],
          personality: "cool",
          relationship_role: "senior",
          warmth: 58,
          initiative: 72,
          humor: 28,
          challenge: 74,
          motions: COMPANION_CC0_MOTION_URLS,
          voice_provider: "local-neural",
          voice_model: LOCAL_NEURAL_VOICE_MODEL,
          voice_id: "Dylan",
          speaking_rate: 0.96,
          palette: {
            skin_tone: "#ead0c4",
            hair_color: "#2f2b49",
            eye_color: "#88cfe0",
            outfit_color: "#27263d",
            accent_color: "#88cfe0",
          },
        },
        { voice_preview_text: "先把现象写下来，我们一起找出其中最稳定的信号。" },
      ),
    }),
  },
  {
    id: "studio-echo",
    title: "沐音 · ECHO",
    rosterRole: "语言教练",
    blurb: "温暖、灵巧、会讲故事。把难懂的内容换一种说法，让表达重新流动起来。",
    art: {
      src: "/assets/characters/art/roster/echo.png",
      alt: "原创学习伙伴沐音，身穿陶土红与苔绿短外套，在阳光工作室用笔记和光带整理故事",
      position: "50% 34%",
    },
    draft: createCharacterWorkshopSeed({
      name: "沐音",
      description: "语言与写作型学习伙伴。会把抽象概念换成清楚的例子，陪你把零散的想法整理成自然、有力量的表达。",
      recipe: characterRecipeToWorkshopDraft(
        {
          avatar_model: "echo",
          avatar_framing: "full_body",
          stage_background: "study",
          base_model: "mini",
          face_style: "serene",
          hairstyle: "short_bob",
          outfit: "studio",
          accessories: ["ribbon", "badge"],
          personality: "gentle",
          relationship_role: "partner",
          warmth: 88,
          initiative: 64,
          humor: 68,
          challenge: 34,
          motions: COMPANION_CC0_MOTION_URLS,
          voice_provider: "local-neural",
          voice_model: LOCAL_NEURAL_VOICE_MODEL,
          voice_id: "Vivian",
          speaking_rate: 1.02,
          palette: {
            skin_tone: "#f0d3c7",
            hair_color: "#7a493a",
            eye_color: "#e58a61",
            outfit_color: "#5b6546",
            accent_color: "#e58a61",
          },
        },
        { voice_preview_text: "把这句话先说得像你自己，清楚以后，故事就会开始流动。" },
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

