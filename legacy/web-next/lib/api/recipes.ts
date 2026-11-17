import { asAvatarStageBackground, asCharacterRecipeDefaults } from "./character-codec";
import defaultCharacterRecipeSeed from "../../../../libs/schemas/default_character_recipe.json";
import defaultNovaCharacterRecipeSeed from "../../../../libs/schemas/default_nova_character_recipe.json";
import type { CharacterRecipe, CharacterWorkshopDocument } from "@/lib/types";

export const DEFAULT_CHARACTER_RECIPE = asCharacterRecipeDefaults(
  defaultCharacterRecipeSeed,
  "默认角色配方",
);

const DEFAULT_NOVA_CHARACTER_RECIPE = asCharacterRecipeDefaults(
  defaultNovaCharacterRecipeSeed,
  "默认 Nova 角色配方",
);

export function createDefaultCharacterRecipe(
  seed: Partial<CharacterRecipe> = {},
): CharacterRecipe {
  return {
    ...DEFAULT_CHARACTER_RECIPE,
    avatar_model: seed.avatar_model ?? DEFAULT_CHARACTER_RECIPE.avatar_model,
    avatar_framing: seed.avatar_framing ?? DEFAULT_CHARACTER_RECIPE.avatar_framing,
    stage_background: asAvatarStageBackground(
      seed.stage_background,
      "角色配方.stage_background",
    ),
    base_model: seed.base_model ?? DEFAULT_CHARACTER_RECIPE.base_model,
    face_style: seed.face_style ?? DEFAULT_CHARACTER_RECIPE.face_style,
    hairstyle: seed.hairstyle ?? DEFAULT_CHARACTER_RECIPE.hairstyle,
    outfit: seed.outfit ?? DEFAULT_CHARACTER_RECIPE.outfit,
    accessories: [...(seed.accessories ?? DEFAULT_CHARACTER_RECIPE.accessories)],
    personality: seed.personality ?? DEFAULT_CHARACTER_RECIPE.personality,
    relationship_role: seed.relationship_role ?? DEFAULT_CHARACTER_RECIPE.relationship_role,
    warmth: seed.warmth ?? DEFAULT_CHARACTER_RECIPE.warmth,
    initiative: seed.initiative ?? DEFAULT_CHARACTER_RECIPE.initiative,
    humor: seed.humor ?? DEFAULT_CHARACTER_RECIPE.humor,
    challenge: seed.challenge ?? DEFAULT_CHARACTER_RECIPE.challenge,
    voice_provider: seed.voice_provider ?? DEFAULT_CHARACTER_RECIPE.voice_provider,
    voice_model: seed.voice_model ?? DEFAULT_CHARACTER_RECIPE.voice_model,
    voice_id: seed.voice_id ?? DEFAULT_CHARACTER_RECIPE.voice_id,
    speaking_rate: seed.speaking_rate ?? DEFAULT_CHARACTER_RECIPE.speaking_rate,
    palette: {
      ...DEFAULT_CHARACTER_RECIPE.palette,
      ...(seed.palette ?? {}),
    },
    motions: { ...(seed.motions ?? DEFAULT_CHARACTER_RECIPE.motions) },
  };
}

export function createDefaultNovaCharacterRecipe(): CharacterRecipe {
  return createDefaultCharacterRecipe(DEFAULT_NOVA_CHARACTER_RECIPE);
}

export function createCharacterWorkshopDocument(input: {
  name: string;
  description?: string | null;
  recipe: CharacterRecipe;
  preview_state?: CharacterWorkshopDocument["preview_state"];
  voice_preview_text?: CharacterWorkshopDocument["voice_preview_text"];
}): CharacterWorkshopDocument {
  return {
    schema_version: "character_recipe_v1",
    exported_at: new Date().toISOString(),
    name: input.name,
    description: input.description ?? "",
    recipe: createDefaultCharacterRecipe(input.recipe),
    preview_state: input.preview_state ?? "idle",
    voice_preview_text: input.voice_preview_text ?? "",
  };
}
