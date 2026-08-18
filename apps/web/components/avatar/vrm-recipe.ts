import type {
  AvatarFraming,
  AvatarStageBackground,
  CharacterPreviewState,
  CharacterRecipe,
} from "@/lib/types";
import {
  getBuiltinPetDefinition,
  type BuiltinPetDefinition,
} from "@/components/avatar/pet-registry";
import {
  getBuiltinPortraitDefinition,
  type BuiltinPortraitDefinition,
} from "@/components/avatar/portrait-registry";

export const AVATAR_MOTION_STATES = [
  "idle",
  "listening",
  "thinking",
  "speaking",
] as const satisfies readonly CharacterPreviewState[];

export const COMPANION_CC0_MOTION_URLS: Record<CharacterPreviewState, string> = {
  idle: "/assets/characters/motions/companion-idle.vrma",
  listening: "/assets/characters/motions/companion-listening.vrma",
  thinking: "/assets/characters/motions/companion-thinking.vrma",
  speaking: "/assets/characters/motions/companion-speaking.vrma",
};

export type AvatarMotionMode = "loading" | "vrma" | "procedural";

export interface AvatarMotionStatus {
  detail: string;
  mode: AvatarMotionMode;
  state: CharacterPreviewState;
}

export interface RuntimeRecipeView {
  accentColor: string;
  accessories: string[];
  avatarFraming: AvatarFraming;
  stageBackground: AvatarStageBackground;
  body: string;
  eyeColor: string;
  face: string;
  hairColor: string;
  hairstyle: string;
  modelId: string;
  motionUrls: Partial<Record<CharacterPreviewState, string>>;
  name: string;
  outfit: string;
  outfitColor: string;
  relationshipLabel: string;
  portraitAssetUrl: string;
  portraitDefinition: BuiltinPortraitDefinition | null;
  runtimeKind: "portrait_2d" | "sprite_2d" | "unsupported" | "vrm";
  skinTone: string;
  spriteAssetUrl: string;
  spriteDefinition: BuiltinPetDefinition | null;
  vrmAssetUrl: string;
}

type LooseRecipe = CharacterRecipe & Record<string, unknown>;

const BUILTIN_MODEL_URLS: Record<string, string> = {
  cael: "/assets/characters/models/Cael.vrm",
  kite: "/assets/characters/models/Kite.vrm",
  lyra: "/assets/characters/models/Lyra.vrm",
  mira: "/assets/characters/models/Mira.vrm",
  sakurada_fumiriya: "/assets/characters/models/Sakurada-Fumiriya.vrm",
  seed_san: "/assets/characters/models/Seed-san.vrm",
  sendagaya_shino: "/assets/characters/models/Sendagaya-Shino.vrm",
  vrm1_constraint_twist_sample: "/assets/characters/models/VRM1_Constraint_Twist_Sample.vrm",
};

const BUILTIN_MODEL_ALIASES: Record<string, string> = {
  cael: "cael",
  constraint: "vrm1_constraint_twist_sample",
  constraint_sample: "vrm1_constraint_twist_sample",
  default: "mira",
  fumiriya: "sakurada_fumiriya",
  kite: "kite",
  lyra: "lyra",
  mira: "mira",
  rei: "sakurada_fumiriya",
  seed: "seed_san",
  seed_san: "seed_san",
  shino: "sendagaya_shino",
  twist: "vrm1_constraint_twist_sample",
  vrm1_constraint_twist_sample: "vrm1_constraint_twist_sample",
};

function readString(recipe: LooseRecipe, keys: string[], fallback: string) {
  for (const key of keys) {
    const value = recipe[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return fallback;
}

function readStringArray(recipe: LooseRecipe, keys: string[]) {
  for (const key of keys) {
    const value = recipe[key];
    if (Array.isArray(value)) {
      return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
    }
    if (typeof value === "string" && value.trim()) {
      return value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
    }
  }
  return [];
}

function readPaletteColor(palette: Record<string, unknown>, keys: string[], fallback: string) {
  for (const key of keys) {
    const value = palette[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return fallback;
}

function normalizeModelId(modelId: string) {
  const normalized = modelId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_");
  return BUILTIN_MODEL_ALIASES[normalized] ?? normalized;
}

function normalizeAvatarFraming(recipe: LooseRecipe): AvatarFraming {
  const framing = recipe.avatar_framing ?? recipe.avatarFraming;
  return framing === "portrait" ? "portrait" : "full_body";
}

function normalizeStageBackground(recipe: LooseRecipe): AvatarStageBackground {
  const background = recipe.stage_background ?? recipe.stageBackground;
  return background === "study" || background === "midnight" ? background : "neutral";
}

const FEATURED_ORIGINAL_MODEL_IDS = new Set(["cael", "kite", "lyra", "mira"]);

function readBundledMotionUrls(
  recipe: LooseRecipe,
  modelId: string,
): Partial<Record<CharacterPreviewState, string>> {
  const motions =
    recipe.motions && typeof recipe.motions === "object" && !Array.isArray(recipe.motions)
      ? (recipe.motions as Record<string, unknown>)
      : {};
  const selected = Object.fromEntries(
    AVATAR_MOTION_STATES.flatMap((state) => {
      const value = motions[state];
      return value === COMPANION_CC0_MOTION_URLS[state]
        ? [[state, value]]
        : [];
    }),
  ) as Partial<Record<CharacterPreviewState, string>>;
  if (Object.keys(selected).length > 0) {
    return selected;
  }
  return FEATURED_ORIGINAL_MODEL_IDS.has(modelId) ? { ...COMPANION_CC0_MOTION_URLS } : {};
}

export function getRuntimeRecipeView(recipe: CharacterRecipe | Record<string, unknown>): RuntimeRecipeView {
  const looseRecipe = recipe as LooseRecipe;
  const directAssetUrl = readString(looseRecipe, ["vrmAssetUrl", "vrm_asset_url"], "");
  const rawBaseModel = readString(looseRecipe, ["baseModel", "base_model"], "mini");
  const avatarModel = readString(
    looseRecipe,
    ["avatarModel", "avatar_model"],
    rawBaseModel,
  );
  const modelId = normalizeModelId(
    avatarModel === "mini" || avatarModel === "tall"
      ? "mira"
      : avatarModel,
  );
  const portraitDefinition = directAssetUrl ? null : getBuiltinPortraitDefinition(modelId);
  const spriteDefinition = directAssetUrl || portraitDefinition ? null : getBuiltinPetDefinition(modelId);
  const mappedAssetUrl = BUILTIN_MODEL_URLS[modelId] ?? "";
  const runtimeKind = portraitDefinition
    ? "portrait_2d"
    : spriteDefinition
      ? "sprite_2d"
      : directAssetUrl || mappedAssetUrl
        ? "vrm"
        : "unsupported";
  const palette =
    looseRecipe.palette && typeof looseRecipe.palette === "object"
      ? (looseRecipe.palette as Record<string, unknown>)
      : {};

  return {
    accentColor:
      readPaletteColor(
        palette,
        ["accent", "accent_color", "trim", "trim_color"],
        readString(looseRecipe, ["accentColor", "accent_color", "trim_color"], "#4c88ff"),
      ),
    accessories: readStringArray(looseRecipe, ["accessories", "accessory_ids"]),
    avatarFraming: normalizeAvatarFraming(looseRecipe),
    stageBackground: normalizeStageBackground(looseRecipe),
    body:
      rawBaseModel === "mini" || rawBaseModel === "tall"
        ? rawBaseModel === "mini"
          ? "petite"
          : rawBaseModel
        : readString(looseRecipe, ["body", "body_base"], "petite"),
    eyeColor:
      readPaletteColor(
        palette,
        ["eye", "eye_color", "eyes", "iris", "iris_color"],
        readString(looseRecipe, ["eyeColor", "eye_color", "iris_color"], "#3bbeb2"),
      ),
    face: readString(looseRecipe, ["face", "face_shape", "face_style"], "soft"),
    hairColor:
      readPaletteColor(
        palette,
        ["hair", "hair_color"],
        readString(looseRecipe, ["hairColor", "hair_color"], "#ff8e9d"),
      ),
    hairstyle: readString(looseRecipe, ["hairstyle"], "twintail"),
    modelId,
    motionUrls: readBundledMotionUrls(looseRecipe, modelId),
    name: readString(looseRecipe, ["name", "display_name"], "Avatar"),
    outfit: readString(looseRecipe, ["outfit"], "uniform"),
    outfitColor:
      readPaletteColor(
        palette,
        ["outfit", "outfit_color", "cloth", "cloth_color"],
        readString(looseRecipe, ["outfitColor", "outfit_color", "cloth_color"], "#f3efe7"),
      ),
    relationshipLabel: readString(
      looseRecipe,
      ["relationshipLabel", "relationship_label", "relation_label", "relationship_role"],
      "",
    ),
    runtimeKind,
    skinTone:
      readPaletteColor(
        palette,
        ["skin", "skin_tone", "skin_color"],
        readString(looseRecipe, ["skinTone", "skin_tone", "skin_color"], "#f5d3c8"),
      ),
    portraitAssetUrl: portraitDefinition?.assetUrl ?? "",
    portraitDefinition,
    spriteAssetUrl: spriteDefinition?.assetUrl ?? "",
    spriteDefinition,
    vrmAssetUrl: portraitDefinition || spriteDefinition ? "" : directAssetUrl || mappedAssetUrl,
  };
}
