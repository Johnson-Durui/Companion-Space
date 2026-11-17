import type { CharacterPackDetail, CharacterPackWire, CharacterPreviewState, CharacterRecipe } from "@/lib/types";
import { ApiError, apiClient, apiData, expectArrayField, request, requestBinary } from "./transport";
import { toCharacterDetail, toCharacterSummary } from "./character-codec";
import { DEFAULT_CHARACTER_RECIPE, createDefaultCharacterRecipe } from "./recipes";
import { encodeFilenameHeaderValue } from "./space-codec";

const MAX_CHARACTER_PACK_SIZE_BYTES = 200 * 1024 * 1024;

const MAX_CHARACTER_CARD_SIZE_BYTES = 1_000_000;

export interface CharacterCreateInput {
  name: string;
  description?: string;
  recipe?: CharacterRecipe;
}

interface LegacyCharacterCreateInput {
  name: string;
  style?: string;
  archetype?: string;
}

export async function listCharacters() {
  const payload = apiData(await apiClient().GET("/api/v1/characters"), "无法读取导师目录");
  return expectArrayField<CharacterPackWire>(payload, "items", "角色列表接口").map(
    toCharacterSummary,
  );
}

export async function createCharacter(input: CharacterCreateInput | LegacyCharacterCreateInput) {
  const recipe =
    "recipe" in input && input.recipe
      ? createDefaultCharacterRecipe(input.recipe)
      : createDefaultCharacterRecipe({
          face_style: "style" in input && input.style ? input.style : DEFAULT_CHARACTER_RECIPE.face_style,
          personality:
            "style" in input && input.style ? input.style : DEFAULT_CHARACTER_RECIPE.personality,
          relationship_role:
            "archetype" in input && input.archetype
              ? input.archetype
              : DEFAULT_CHARACTER_RECIPE.relationship_role,
        });
  const payload = await request<CharacterPackWire>("/api/v1/characters", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: input.name,
      description: "description" in input ? input.description ?? "" : "",
      recipe,
    }),
  });
  return toCharacterSummary(payload);
}

export async function getCharacter(characterId: string) {
  const payload = apiData(await apiClient().GET("/api/v1/characters/{character_id}", { params: { path: { character_id: characterId } } }), "无法读取导师");
  return toCharacterDetail(payload as CharacterPackWire);
}

export async function updateCharacter(
  characterId: string,
  input: Partial<CharacterPackDetail>,
) {
  const payload = await request<CharacterPackWire>(`/api/v1/characters/${characterId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: input.name,
      description: input.description,
      recipe: input.recipe ? createDefaultCharacterRecipe(input.recipe) : undefined,
    }),
  });
  return toCharacterDetail(payload);
}

export async function duplicateCharacter(characterId: string, input: { name?: string } = {}) {
  const payload = await request<CharacterPackWire>(
    `/api/v1/characters/${characterId}/duplicate`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  return toCharacterSummary(payload);
}

export async function deleteCharacter(characterId: string) {
  return request<null>(`/api/v1/characters/${characterId}`, { method: "DELETE" });
}

export async function importCharacter(file: File) {
  const isCharacterCard = file.name.toLowerCase().endsWith(".json");
  const sizeLimit = isCharacterCard
    ? MAX_CHARACTER_CARD_SIZE_BYTES
    : MAX_CHARACTER_PACK_SIZE_BYTES;
  if (file.size > sizeLimit) {
    throw new ApiError(
      isCharacterCard ? "角色卡 JSON 超过 1 MB 上限" : "角色包超过 200 MiB 上限",
      413,
      {
        size: file.size,
        limit: sizeLimit,
      },
    );
  }
  const payload = await request<CharacterPackWire>("/api/v1/characters/import", {
    method: "POST",
    headers: {
      "Content-Type": file.type || "application/octet-stream",
      "X-Filename": encodeFilenameHeaderValue(file.name),
    },
    body: file,
  });
  return toCharacterDetail(payload);
}

export async function replaceCharacterAvatar(characterId: string, file: File) {
  if (!file.name.toLowerCase().endsWith(".vrm")) {
    throw new ApiError("请选择 .vrm 模型文件", 400, { filename: file.name });
  }
  if (file.size > MAX_CHARACTER_PACK_SIZE_BYTES) {
    throw new ApiError("角色模型超过 200 MiB 上限", 413, {
      size: file.size,
      limit: MAX_CHARACTER_PACK_SIZE_BYTES,
    });
  }
  const payload = await request<CharacterPackWire>(
    `/api/v1/characters/${characterId}/avatar`,
    {
      method: "PUT",
      headers: {
        "Content-Type": file.type || "application/octet-stream",
        "X-Filename": encodeFilenameHeaderValue(file.name),
      },
      body: file,
    },
  );
  return toCharacterDetail(payload);
}

export async function removeCharacterAvatar(characterId: string) {
  const payload = await request<CharacterPackWire>(
    `/api/v1/characters/${characterId}/avatar`,
    { method: "DELETE" },
  );
  return toCharacterDetail(payload);
}

export async function replaceCharacterMotion(
  characterId: string,
  state: CharacterPreviewState,
  file: File,
) {
  if (!file.name.toLowerCase().endsWith(".vrma")) {
    throw new ApiError("Please select a .vrma motion file", 400, { filename: file.name });
  }
  if (file.size > MAX_CHARACTER_PACK_SIZE_BYTES) {
    throw new ApiError("Character motion exceeds the 200 MiB limit", 413, {
      size: file.size,
      limit: MAX_CHARACTER_PACK_SIZE_BYTES,
    });
  }
  const payload = await request<CharacterPackWire>(
    `/api/v1/characters/${characterId}/motions/${state}`,
    {
      method: "PUT",
      headers: {
        "Content-Type": file.type || "application/octet-stream",
        "X-Filename": encodeFilenameHeaderValue(file.name),
      },
      body: file,
    },
  );
  return toCharacterDetail(payload);
}

export async function removeCharacterMotion(
  characterId: string,
  state: CharacterPreviewState,
) {
  const payload = await request<CharacterPackWire>(
    `/api/v1/characters/${characterId}/motions/${state}`,
    { method: "DELETE" },
  );
  return toCharacterDetail(payload);
}

export async function downloadCharacterPack(characterId: string) {
  const response = await requestBinary(
    `/api/v1/characters/${characterId}/export`,
    { method: "GET" },
    "导出角色包失败",
  );
  return response.blob();
}

export async function downloadCharacterAsset(characterId: string, assetPath: string) {
  const encodedPath = assetPath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const response = await requestBinary(
    `/api/v1/characters/${characterId}/assets/${encodedPath}`,
    { method: "GET" },
    "读取角色资产失败",
  );
  return response.blob();
}

export async function previewCharacterVoice(input: {
  characterId: string;
  spaceId: string;
  text: string;
  voiceId?: string;
  speakingRate?: number;
  signal?: AbortSignal;
}) {
  const response = await requestBinary(
    `/api/v1/characters/${input.characterId}/voice-preview`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        space_id: input.spaceId,
        text: input.text,
        voice_id: input.voiceId,
        speaking_rate: input.speakingRate,
      }),
      signal: input.signal,
    },
    "角色声音试听失败",
  );
  return {
    pcm16: await response.arrayBuffer(),
    sampleRate: Number(response.headers.get("x-audio-sample-rate") ?? "24000"),
  };
}
