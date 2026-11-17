import type { AvatarExpressionCapabilityStatus } from "@/components/avatar/vrm-stage";
import type {
  CharacterAssetManifest,
  CharacterPackDetail,
  CharacterPreviewState,
} from "@/lib/types";
import {
  ADULT_RELATIONSHIP_PATTERN,
  ADULT_RELATIONSHIP_TERMS,
  DEFAULT_VOICE_PREVIEW_TEXT,
  PERSONA_OPTIONS,
  PREVIEW_STATES,
  RELATION_OPTIONS,
  characterRecipeToWorkshopDraft,
  createCharacterWorkshopSeed,
  workshopRecipeToCharacterRecipe,
  type CharacterWorkshopDraft,
  type CharacterWorkshopRecipeDraft,
} from "@/components/character-workshop-config";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function readStringRecord(value: unknown) {
  if (!isRecord(value)) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

export function relationDisplay(recipe: CharacterWorkshopRecipeDraft) {
  const actualValue =
    recipe.relation_mode === "custom"
      ? recipe.relation_custom.trim()
      : recipe.relation_mode;
  const option = RELATION_OPTIONS.find((item) => item.value === actualValue);
  return option?.label ?? (actualValue || "Unset");
}

export function normalizeRelationshipText(value: string) {
  return value.trim().toLowerCase();
}

export function usesAdultRelationship(text: string) {
  const normalized = normalizeRelationshipText(text);
  if (!normalized) {
    return false;
  }
  return (
    ADULT_RELATIONSHIP_PATTERN.test(normalized) ||
    ADULT_RELATIONSHIP_TERMS.some((term) => normalized.includes(term))
  );
}

export function getAdultRelationshipBlockedReason(
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

export function personaDisplay(recipe: CharacterWorkshopRecipeDraft) {
  return PERSONA_OPTIONS.find((item) => item.value === recipe.persona_preset)?.label ?? recipe.persona_preset;
}

export function previewLabel(state: CharacterPreviewState) {
  return PREVIEW_STATES.find((item) => item.value === state)?.label ?? state;
}

export function previewPropsJson(recipe: CharacterWorkshopRecipeDraft) {
  return JSON.stringify(
    {
      state: recipe.preview_state,
      recipe: workshopRecipeToCharacterRecipe(recipe),
    },
    null,
    2,
  );
}

export function parseImportedDraft(payload: unknown): CharacterWorkshopDraft {
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

export const APPEARANCE_SLOT_LABELS = {
  body: "Body",
  face: "Face",
  hairstyle: "Hair",
  outfit: "Outfit",
  accessory: "Accessory",
} as const;

export const EXPRESSION_STATUS_LABELS: Record<AvatarExpressionCapabilityStatus, string> = {
  safe: "safe",
  binary: "binary; skipped",
  "blink-override": "overrides blink; skipped",
  "mouth-override": "overrides mouth; skipped",
  "blink-mouth-override": "overrides blink and mouth; skipped",
  "unsafe-metadata": "metadata incomplete; skipped",
  missing: "missing",
};

export function manifestText(manifest: CharacterAssetManifest | null | undefined, key: string) {
  const value = manifest?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function manifestBoolean(manifest: CharacterAssetManifest | null | undefined, key: string) {
  const value = manifest?.[key];
  if (typeof value === "boolean") {
    return value ? "yes" : "no";
  }
  return typeof value === "string" && value.trim() ? value.trim() : "not declared";
}

export function hasManifestLicenseFacts(manifest: CharacterAssetManifest | null | undefined) {
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

export function assetFilename(value: string | null) {
  return value?.split("/").pop() ?? value;
}

