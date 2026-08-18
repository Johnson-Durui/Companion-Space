"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import {
  deleteCharacter,
  downloadCharacterPack,
  duplicateCharacter,
  getCharacter,
  getOwnerPreferences,
  listSpaces,
  previewCharacterVoice,
  removeCharacterAvatar,
  removeCharacterMotion,
  replaceCharacterAvatar,
  replaceCharacterMotion,
  setSpaceDefaultCharacter,
  updateCharacter,
} from "@/lib/api";
import type {
  CharacterPackDetail,
  CharacterPreviewState,
  StudySpaceSummary,
} from "@/lib/types";
import {
  loadCharacterRuntimeAssetUrls,
  type CharacterLicensedRuntimeAssets,
  type CharacterRuntimeAssetUrls,
} from "@/components/avatar/character-runtime-assets";
import { createAvatarSpeechController } from "@/components/avatar/vrm-speech-controller";
import { Pcm16PlaybackQueue, OUTPUT_PCM16_SAMPLE_RATE } from "@/components/realtime/realtime-audio";
import {
  CharacterWorkshop,
  characterPackToWorkshopSeed,
  characterStatusLabel,
  createCharacterWorkshopSeed,
  workshopRecipeToCharacterRecipe,
  type CharacterWorkshopDraft,
} from "@/components/character-workshop";
import { EmptyState, ErrorCallout, LoadingState } from "@/components/ui";

export function CharacterEditor({ characterId }: { characterId: string }) {
  const router = useRouter();
  const [character, setCharacter] = useState<CharacterPackDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [previewingVoice, setPreviewingVoice] = useState(false);
  const [bindingDefaultSpace, setBindingDefaultSpace] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [assetError, setAssetError] = useState<string | null>(null);
  const [assetLoading, setAssetLoading] = useState(true);
  const [assetPreviewStale, setAssetPreviewStale] = useState(false);
  const [assetUrl, setAssetUrl] = useState<string | null>(null);
  const [licensedRuntimeAsset, setLicensedRuntimeAsset] = useState<
    CharacterLicensedRuntimeAssets | null
  >(null);
  const [motionAssetUrls, setMotionAssetUrls] = useState<
    Partial<Record<CharacterPreviewState, string>>
  >({});
  const [notice, setNotice] = useState<string | null>(null);
  const [previewSpaces, setPreviewSpaces] = useState<StudySpaceSummary[]>([]);
  const [previewSpaceId, setPreviewSpaceId] = useState<string>("");
  const [adultRelationshipsEnabled, setAdultRelationshipsEnabled] = useState(false);
  const voiceQueueRef = useRef<Pcm16PlaybackQueue | null>(null);
  const activeAssetsRef = useRef<CharacterRuntimeAssetUrls | null>(null);
  const assetRequestIdRef = useRef(0);
  const previewSpeechController = useMemo(
    () => createAvatarSpeechController(),
    [],
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [next, spaces, preferences] = await Promise.all([
        getCharacter(characterId),
        listSpaces(),
        getOwnerPreferences(),
      ]);
      setCharacter(next);
      setPreviewSpaces(spaces);
      setAdultRelationshipsEnabled(preferences.adult_relationships_enabled);
      setPreviewSpaceId((current) => {
        if (current && spaces.some((space) => space.id === current)) {
          return current;
        }
        const defaultSpace = spaces.find(
          (space) => space.default_character_id === characterId,
        );
        return defaultSpace?.id ?? "";
      });
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "角色详情加载失败");
    } finally {
      setLoading(false);
    }
  }, [characterId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!character) {
      assetRequestIdRef.current += 1;
      activeAssetsRef.current?.revoke();
      activeAssetsRef.current = null;
      setAssetUrl(null);
      setLicensedRuntimeAsset(null);
      setMotionAssetUrls({});
      setAssetError(null);
      setAssetLoading(false);
      setAssetPreviewStale(false);
      return;
    }

    const requestId = assetRequestIdRef.current + 1;
    assetRequestIdRef.current = requestId;
    setAssetPreviewStale(activeAssetsRef.current !== null);
    setAssetError(null);
    setAssetLoading(true);
    void loadCharacterRuntimeAssetUrls(character)
      .then((assets) => {
        if (assetRequestIdRef.current !== requestId) {
          assets.revoke();
          return;
        }
        const previousAssets = activeAssetsRef.current;
        activeAssetsRef.current = assets;
        setAssetUrl(assets.kind === "vrm" ? assets.modelUrl : null);
        setLicensedRuntimeAsset(assets.kind === "licensed" ? assets : null);
        setMotionAssetUrls(assets.motionUrls);
        setAssetPreviewStale(false);
        previousAssets?.revoke();
        setAssetError(
          assets.warnings.length
            ? `部分角色动作读取失败：${assets.warnings.join("；")}`
            : null,
        );
      })
      .catch((loadError: unknown) => {
        if (assetRequestIdRef.current === requestId) {
          setAssetError(
            loadError instanceof Error
              ? `角色模型读取失败：${loadError.message}`
              : "角色模型读取失败。",
          );
        }
      })
      .finally(() => {
        if (assetRequestIdRef.current === requestId) {
          setAssetLoading(false);
        }
      });
  }, [character]);

  useEffect(
    () => () => {
      assetRequestIdRef.current += 1;
      activeAssetsRef.current?.revoke();
      activeAssetsRef.current = null;
    },
    [],
  );

  useEffect(
    () => () => {
      const queue = voiceQueueRef.current;
      voiceQueueRef.current = null;
      if (queue) {
        void queue.close().catch((closeError: unknown) => {
          console.error("关闭角色试听音频失败", closeError);
        });
      }
      previewSpeechController.reset();
    },
    [previewSpeechController],
  );

  async function handleSave(draft: CharacterWorkshopDraft) {
    setBusy(true);
    try {
      const updated = await updateCharacter(characterId, {
        name: draft.name,
        description: draft.description,
        recipe: workshopRecipeToCharacterRecipe(draft.recipe),
      });
      setCharacter(updated);
      setNotice("角色已保存，预览 props 与后端配方已同步。");
      setError(null);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "保存角色失败");
    } finally {
      setBusy(false);
    }
  }

  async function handleReplaceAvatar(file: File) {
    setBusy(true);
    try {
      const updated = await replaceCharacterAvatar(characterId, file);
      setAssetLoading(true);
      setAssetPreviewStale(activeAssetsRef.current !== null);
      setAssetError(null);
      setCharacter(updated);
      setNotice("已替换 VRM；人格、声音、关系和学习空间绑定保持不变。");
      setError(null);
    } catch (replaceError) {
      const message = replaceError instanceof Error ? replaceError.message : "未知错误";
      setError(`替换角色模型失败：${message}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleRemoveAvatar() {
    setBusy(true);
    try {
      const updated = await removeCharacterAvatar(characterId);
      setAssetLoading(true);
      setAssetPreviewStale(activeAssetsRef.current !== null);
      setAssetError(null);
      setCharacter(updated);
      setNotice("已恢复内置模型；角色身份、人格、声音、关系和学习空间绑定保持不变。");
      setError(null);
    } catch (removeError) {
      const message = removeError instanceof Error ? removeError.message : "未知错误";
      setError(`恢复内置模型失败：${message}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleReplaceMotion(state: CharacterPreviewState, file: File) {
    setBusy(true);
    try {
      const updated = await replaceCharacterMotion(characterId, state, file);
      setAssetLoading(true);
      setAssetPreviewStale(activeAssetsRef.current !== null);
      setAssetError(null);
      setCharacter(updated);
      setNotice(`${state} now uses the local-only managed motion ${file.name}.`);
      setError(null);
    } catch (replaceError) {
      setError(replaceError instanceof Error ? replaceError.message : "Motion upload failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleRemoveMotion(state: CharacterPreviewState) {
    setBusy(true);
    try {
      const updated = await removeCharacterMotion(characterId, state);
      setAssetLoading(true);
      setAssetPreviewStale(activeAssetsRef.current !== null);
      setAssetError(null);
      setCharacter(updated);
      setNotice(`${state} now uses its packaged, bundled, or procedural fallback.`);
      setError(null);
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : "Motion removal failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleCopy(draft: CharacterWorkshopDraft) {
    setBusy(true);
    let copyId: string | null = null;
    try {
      const copy = await duplicateCharacter(characterId, {
        name: `${draft.name} Copy`,
      });
      copyId = copy.id;
      await updateCharacter(copy.id, {
        name: copy.name,
        description: draft.description,
        recipe: workshopRecipeToCharacterRecipe(draft.recipe),
      });
      setNotice(`已复制为 ${copy.name}。`);
      setError(null);
      router.push(`/characters/${copy.id}`);
    } catch (copyError) {
      let message = copyError instanceof Error ? copyError.message : "复制角色失败";
      if (copyId) {
        try {
          await deleteCharacter(copyId);
        } catch (cleanupError) {
          const cleanupMessage =
            cleanupError instanceof Error ? cleanupError.message : "未知清理错误";
          message = `${message}；未能清理未完成的副本：${cleanupMessage}`;
        }
      }
      setError(message);
    } finally {
      setBusy(false);
    }
  }

  async function handleVoicePreview(draft: CharacterWorkshopDraft) {
    setPreviewingVoice(true);
    try {
      const space = previewSpaces.find((candidate) => candidate.id === previewSpaceId);
      if (!space) {
        throw new Error("请先在角色工作室里明确选择一个学习空间，再使用该空间的 TTS 能力试听。");
      }

      let queue = voiceQueueRef.current;
      if (!queue) {
        queue = new Pcm16PlaybackQueue(
          OUTPUT_PCM16_SAMPLE_RATE,
          undefined,
          previewSpeechController.publishLevel,
        );
        voiceQueueRef.current = queue;
      }
      queue.clear();
      await queue.prepare();
      const preview = await previewCharacterVoice({
        characterId,
        spaceId: space.id,
        text: draft.recipe.voice_preview_text.trim(),
        voiceId: draft.recipe.voice_id,
        speakingRate: draft.recipe.voice_rate,
      });
      if (preview.sampleRate !== OUTPUT_PCM16_SAMPLE_RATE) {
        throw new Error(
          `服务端返回 ${preview.sampleRate} Hz，当前试听仅接受 ${OUTPUT_PCM16_SAMPLE_RATE} Hz PCM16。`,
        );
      }
      queue.enqueue(preview.pcm16);
      setNotice(`正在使用「${space.title}」的 TTS 能力试听。`);
      setError(null);
    } catch (previewError) {
      setError(previewError instanceof Error ? previewError.message : "声音试听失败");
    } finally {
      setPreviewingVoice(false);
    }
  }

  async function handleBindDefaultSpace() {
    const space = previewSpaces.find((candidate) => candidate.id === previewSpaceId);
    if (!space) {
      setError("请先选择一个学习空间，再把当前角色设为该空间默认角色。");
      return;
    }

    setBindingDefaultSpace(true);
    try {
      await setSpaceDefaultCharacter(space.id, characterId);
      await refresh();
      setNotice(`已将「${character?.name ?? "当前角色"}」设为「${space.title}」的默认角色。`);
      setError(null);
    } catch (bindError) {
      setError(bindError instanceof Error ? bindError.message : "更新空间默认角色失败");
    } finally {
      setBindingDefaultSpace(false);
    }
  }

  async function handleDelete() {
    setBusy(true);
    try {
      await deleteCharacter(characterId);
      router.push("/characters");
      router.refresh();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "删除角色失败");
      setBusy(false);
    }
  }

  async function handleExportPack() {
    setBusy(true);
    try {
      const blob = await downloadCharacterPack(characterId);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${character?.name ?? "character"}.zip`;
      anchor.click();
      URL.revokeObjectURL(url);
      setNotice("角色包已导出。若后端资产许可不足，这里会直接显示接口报错。");
      setError(null);
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : "导出角色包失败");
    } finally {
      setBusy(false);
    }
  }

  const workshopSeed = useMemo(
    () => (character ? characterPackToWorkshopSeed(character) : createCharacterWorkshopSeed()),
    [character],
  );
  const attachedModelLabel = useMemo(() => {
    const modelPath = character?.asset_manifest?.model_path;
    if (typeof modelPath !== "string" || !modelPath.trim()) {
      return null;
    }
    const sourceFilename = character?.asset_manifest?.source_filename;
    const filename = typeof sourceFilename === "string" && sourceFilename.trim()
      ? sourceFilename.trim()
      : modelPath.split("/").pop() ?? modelPath;
    const format = character?.asset_manifest?.format;
    const label = format === "live2d-zip"
      ? "Live2D"
      : format === "spine-zip"
        ? "Spine"
        : "VRM";
    return `Attached ${label} · ${filename}`;
  }, [character]);

  if (loading) {
    return <LoadingState label="正在读取角色详情..." />;
  }

  if (error && !character) {
    return <ErrorCallout message={error} />;
  }

  if (!character) {
    return (
      <EmptyState
        title="角色不存在"
        description="角色详情接口还没返回数据，或者该角色已经被删除。"
      />
    );
  }

  return (
    <section className="page-stack">
      <CharacterWorkshop
        mode="edit"
        seed={workshopSeed}
        seedKey={`${character.id}:${character.updated_at ?? ""}`}
        adultRelationshipsEnabled={adultRelationshipsEnabled}
        busy={busy || previewingVoice || bindingDefaultSpace}
        notice={notice}
        error={error}
        assetError={assetError}
        assetLoading={assetLoading}
        assetPreviewStale={assetPreviewStale}
        assetManifest={character.asset_manifest}
        assetUrl={assetUrl}
        licensedRuntimeAsset={licensedRuntimeAsset}
        motionAssetUrls={motionAssetUrls}
        previewSpaces={previewSpaces}
        previewSpaceId={previewSpaceId}
        onPreviewSpaceChange={setPreviewSpaceId}
        defaultCharacterSpaceIds={previewSpaces
          .filter((space) => space.default_character_id === character.id)
          .map((space) => space.id)}
        onSetDefaultSpace={handleBindDefaultSpace}
        attachedModelLabel={attachedModelLabel}
        speechController={previewSpeechController}
        title={character.name}
        description={character.description || "角色详情页负责统一外观、人格、关系、声音和导入导出控制。"}
        submitLabel="保存角色"
        statusLabel={`${characterStatusLabel(character)} · ${character.license_summary || "No license note"}`}
        onSubmit={handleSave}
        onCopy={handleCopy}
        onDelete={handleDelete}
        onExportPack={handleExportPack}
        onReplaceAvatar={handleReplaceAvatar}
        onRemoveAvatar={handleRemoveAvatar}
        onReplaceMotion={handleReplaceMotion}
        onRemoveMotion={handleRemoveMotion}
        onVoicePreview={handleVoicePreview}
      />
    </section>
  );
}
