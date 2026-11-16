import type { AvatarFraming, AvatarStageBackground, CharacterPackDetail, CharacterPackSummary, CharacterPackWire, CharacterRecipe } from "@/lib/types";
import { contractError, expectNullableString, expectNumber, expectRecord, expectString, expectStringArray } from "./transport";

export function asCharacterRecipeDefaults(payload: unknown, context: string): CharacterRecipe {
  const record = expectRecord(payload, context);
  const palette = expectRecord(record.palette, `${context}.palette`);
  const motions = expectRecord(record.motions, `${context}.motions`);
  return {
    avatar_model: expectString(record.avatar_model, `${context}.avatar_model`),
    avatar_framing: asAvatarFraming(record.avatar_framing, `${context}.avatar_framing`),
    stage_background: asAvatarStageBackground(
      record.stage_background,
      `${context}.stage_background`,
    ),
    base_model: expectString(record.base_model, `${context}.base_model`),
    face_style: expectString(record.face_style, `${context}.face_style`),
    hairstyle: expectString(record.hairstyle, `${context}.hairstyle`),
    outfit: expectString(record.outfit, `${context}.outfit`),
    accessories: expectStringArray(record.accessories, `${context}.accessories`),
    palette: Object.fromEntries(
      Object.entries(palette).map(([key, value]) => [
        key,
        expectString(value, `${context}.palette.${key}`),
      ]),
    ),
    personality: expectString(record.personality, `${context}.personality`),
    warmth: expectNumber(record.warmth, `${context}.warmth`),
    initiative: expectNumber(record.initiative, `${context}.initiative`),
    humor: expectNumber(record.humor, `${context}.humor`),
    challenge: expectNumber(record.challenge, `${context}.challenge`),
    relationship_role: expectString(record.relationship_role, `${context}.relationship_role`),
    voice_provider: expectString(record.voice_provider, `${context}.voice_provider`),
    voice_model: expectString(record.voice_model, `${context}.voice_model`),
    voice_id: expectString(record.voice_id, `${context}.voice_id`),
    speaking_rate: expectNumber(record.speaking_rate, `${context}.speaking_rate`),
    motions: Object.fromEntries(
      Object.entries(motions).map(([key, value]) => [
        key,
        expectString(value, `${context}.motions.${key}`),
      ]),
    ),
  };
}

export function expectOptionalNullableString(
  value: unknown,
  context: string,
): string | null | undefined {
  return value === undefined ? undefined : expectNullableString(value, context);
}

function asAvatarFraming(value: unknown, context: string): AvatarFraming {
  if (value === undefined) {
    return "full_body";
  }
  if (value === "full_body" || value === "portrait") {
    return value;
  }
  throw contractError(context, "must be full_body or portrait");
}

export function asAvatarStageBackground(value: unknown, context: string): AvatarStageBackground {
  if (value === undefined) {
    return "neutral";
  }
  if (value === "neutral" || value === "study" || value === "midnight") {
    return value;
  }
  throw contractError(context, "must be neutral, study, or midnight");
}

function asApiCharacterRecipe(recipe: unknown, context: string): CharacterRecipe {
  const record = expectRecord(recipe, context);
  return {
    ...(record as unknown as CharacterRecipe),
    stage_background: asAvatarStageBackground(
      record.stage_background,
      `${context}.stage_background`,
    ),
  };
}

export function toCharacterSummary(character: CharacterPackWire): CharacterPackSummary {
  const recipe = asApiCharacterRecipe(character.recipe, "角色接口.recipe");
  return {
    id: character.id,
    name: character.name,
    avatar_model: recipe.avatar_model,
    has_custom_avatar_asset:
      typeof character.asset_manifest?.model_path === "string"
      && character.asset_manifest.model_path.trim().length > 0,
    archetype: recipe.relationship_role,
    style: recipe.personality,
    updated_at: character.updated_at,
  };
}

export function toCharacterDetail(character: CharacterPackWire): CharacterPackDetail {
  const assetManifest = character.asset_manifest;
  const licenseSummary = [
    assetManifest.license_summary,
    assetManifest.redistribution_note,
    assetManifest.license,
    assetManifest.render_mode,
  ].find((value): value is string => typeof value === "string" && value.trim().length > 0);
  return {
    ...toCharacterSummary(character),
    description: character.description,
    recipe: asApiCharacterRecipe(character.recipe, "角色详情接口.recipe"),
    asset_manifest: assetManifest,
    license_summary: licenseSummary ?? null,
  };
}
