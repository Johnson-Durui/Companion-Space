"use client";

import type { ChangeEvent, FormEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { LOCAL_NEURAL_VOICE_MODEL, LOCAL_NEURAL_VOICES } from "@/lib/voice-presets";

import {
  AvatarRuntime,
  type AvatarRuntimeMode,
} from "@/components/avatar/avatar-runtime";
import type {
  AvatarExpressionCapabilityStatus,
  AvatarRuntimeCapabilities,
} from "@/components/avatar/vrm-stage";
import { getRuntimeRecipeView } from "@/components/avatar/vrm-recipe";
import type { AvatarSpeechController } from "@/components/avatar/vrm-speech-controller";
import type { CharacterLicensedRuntimeAssets } from "@/components/avatar/character-runtime-assets";
import { createCharacterWorkshopDocument } from "@/lib/api";
import type {
  AvatarFraming,
  AvatarStageBackground,
  CharacterAssetManifest,
  CharacterPreviewState,
  CharacterWorkshopDocument,
  StudySpaceSummary,
  CompanionEmotion,
} from "@/lib/types";
import styles from "@/components/character-workshop.module.css";


import {
  ACCESSORY_OPTIONS,
  AVATAR_MODEL_OPTIONS,
  BODY_OPTIONS,
  CAMERA_FRAMING_OPTIONS,
  COLOR_FIELDS,
  FACE_OPTIONS,
  HAIR_OPTIONS,
  MANAGED_MOTION_STATES,
  OUTFIT_OPTIONS,
  PERSONA_OPTIONS,
  PREVIEW_EMOTIONS,
  PREVIEW_STATES,
  RELATION_OPTIONS,
  STAGE_BACKGROUND_OPTIONS,
  TEMPLATE_PRESETS,
  VOICE_PROVIDER_OPTIONS,
  createCharacterWorkshopSeed,
  workshopRecipeToCharacterRecipe,
  type CharacterVoicePreviewState,
  type CharacterWorkshopDraft,
  type CharacterWorkshopRecipeDraft,
  type ChoiceOption,
} from "@/components/character-workshop-config";
import {
  APPEARANCE_SLOT_LABELS,
  EXPRESSION_STATUS_LABELS,
  assetFilename,
  getAdultRelationshipBlockedReason,
  hasManifestLicenseFacts,
  manifestBoolean,
  manifestText,
  parseImportedDraft,
  personaDisplay,
  previewLabel,
  previewPropsJson,
  relationDisplay,
  usesAdultRelationship,
} from "@/components/character-workshop-helpers";

export {
  characterPackToWorkshopSeed,
  characterRecipeToWorkshopDraft,
  createCharacterWorkshopSeed,
  workshopRecipeToCharacterRecipe,
} from "@/components/character-workshop-config";
export type {
  CharacterVoicePreviewState,
  CharacterWorkshopDraft,
  CharacterWorkshopRecipeDraft,
} from "@/components/character-workshop-config";
export { characterStatusLabel } from "@/components/character-workshop-helpers";

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
  voicePreviewState?: CharacterVoicePreviewState;
  voicePreviewMessage?: string | null;
  onStopVoicePreview?: () => void;
  onSetDefaultSpace?: () => Promise<void> | void;
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
  voicePreviewState = "idle",
  voicePreviewMessage,
  onStopVoicePreview,
  onSetDefaultSpace,
}: CharacterWorkshopProps) {
  const [draft, setDraft] = useState<CharacterWorkshopDraft>(() => seed);
  const [localNotice, setLocalNotice] = useState<string | null>(null);
  const [runtimeCapabilities, setRuntimeCapabilities] = useState<AvatarRuntimeCapabilities | null>(null);
  const [runtimeCapabilitiesAssetUrl, setRuntimeCapabilitiesAssetUrl] = useState<
    string | null | undefined
  >(undefined);
  const [runtimeMode, setRuntimeMode] = useState<AvatarRuntimeMode>("loading");
  const [previewEmotion, setPreviewEmotion] = useState<CompanionEmotion>("neutral");
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const avatarFileInputRef = useRef<HTMLInputElement | null>(null);
  const motionFileInputRef = useRef<HTMLInputElement | null>(null);
  const pendingMotionStateRef = useRef<CharacterPreviewState>("idle");
  const hasAttachedModel = Boolean(attachedModelLabel);
  const voicePreviewActive = voicePreviewState !== "idle";
  const effectivePreviewState = voicePreviewState === "loading"
    ? "thinking"
    : voicePreviewState === "playing"
      ? "speaking"
      : draft.recipe.preview_state;
  const configuredMotionCount = PREVIEW_STATES.filter(
    ({ value }) => typeof draft.recipe.motions[value] === "string"
      && draft.recipe.motions[value].toLowerCase().endsWith(".vrma"),
  ).length;

  useEffect(() => {
    setDraft(seed);
    setPreviewEmotion("neutral");
    setLocalNotice(null);
  }, [seed, seedKey]);

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
  const usesBuiltIn2dRuntime = (
    runtimeRecipeView.runtimeKind === "sprite_2d"
    || runtimeRecipeView.runtimeKind === "portrait_2d"
  );
  const builtIn2dRuntimeReady = usesBuiltIn2dRuntime && runtimeMode === "ready";

  useEffect(() => {
    // Loading a character's optional local assets does not change the public 2D
    // sprite/portrait. Resetting this state after that runtime was already ready
    // loses the ready notification because AvatarRuntime has no new mode change
    // to publish.
    if (!usesBuiltIn2dRuntime && (assetLoading || assetPreviewStale)) {
      setRuntimeCapabilities(null);
      setRuntimeCapabilitiesAssetUrl(undefined);
      setRuntimeMode("loading");
    }
  }, [assetLoading, assetPreviewStale, usesBuiltIn2dRuntime]);
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
    onStopVoicePreview?.();
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
    onStopVoicePreview?.();
    setDraft(preset.draft);
    setPreviewEmotion("neutral");
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
        const importedDraft = parseImportedDraft(parsed);
        onStopVoicePreview?.();
        setDraft(importedDraft);
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

      {mergedNotice ? <div className={styles.notice} role="status">{mergedNotice}</div> : null}
      {[error, assetError, adultRelationshipBlockedReason].filter(Boolean).map((message) => (
        <div key={message} className={styles.error} role="alert">
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
          <p>有人陪你整理思绪，有人帮你迈出第一步。六位原创伙伴，六种学习节奏，找到适合今天的那一位。</p>
        </div>
      </section>

      <section className={styles.rosterSection} aria-labelledby="featured-companion-roster">
        <div className={styles.rosterHeader}>
          <div>
            <p className={styles.eyebrow}>Starpath study roster</p>
            <h3 id="featured-companion-roster">六种学习状态，六名真实可选伙伴</h3>
          </div>
          <p>先选一位，再调整声音、性格和相处方式。每位都提供动态 2D 卡面与 3D 形象，可在下方预览中切换。</p>
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
                <small>{preset.rosterRole} · 3D VRM</small>
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
              <span className={styles.previewStatus}>{previewLabel(effectivePreviewState)}</span>
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
                  emotion={previewEmotion}
                  speechController={speechController}
                  state={effectivePreviewState}
                />
              )}
            </div>
            <div className={styles.previewStateRow} role="group" aria-label="Preview State">
              {PREVIEW_STATES.map((state) => (
                <button
                  key={state.value}
                  type="button"
                  data-active={effectivePreviewState === state.value}
                  disabled={voicePreviewActive}
                  onClick={() => patchRecipe({ preview_state: state.value })}
                >
                  {state.label}
                </button>
              ))}
            </div>
            <div className={styles.previewEmotionRow} role="group" aria-label="Preview Emotion">
              {PREVIEW_EMOTIONS.map((emotion) => (
                <button
                  key={emotion.value}
                  type="button"
                  aria-label={`预览情绪：${emotion.label}`}
                  aria-pressed={previewEmotion === emotion.value}
                  data-active={previewEmotion === emotion.value}
                  data-testid={`preview-emotion-${emotion.value}`}
                  onClick={() => setPreviewEmotion(emotion.value)}
                >
                  {emotion.label}
                </button>
              ))}
            </div>
            <div className={styles.previewSpeech}>
              <div className={styles.previewSpeechTopline}>
                <strong>Voice Preview</strong>
                {voicePreviewActive && onStopVoicePreview ? (
                  <button
                    type="button"
                    className={styles.previewVoiceButton}
                    onClick={onStopVoicePreview}
                  >
                    停止试听
                  </button>
                ) : onVoicePreview ? (
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
              {voicePreviewMessage ? <p role="status">{voicePreviewMessage}</p> : null}
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
                      return (
                        <option key={space.id} value={space.id}>
                          {space.title}{ttsAssignment?.status ? ` · TTS ${ttsAssignment.status}` : ""}
                        </option>
                      );
                    })}
                  </select>
                  <small className={styles.fieldHint}>
                    试听使用所选空间的语音服务，仅角色的默认空间会自动预选。
                    Mock 会播放测试音；要试听真实声线，请在空间设置中绑定可用的语音服务。
                    <Link href="/providers#voice-service"> 配置语音接口</Link>
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
