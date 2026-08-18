"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  AvatarRuntime,
  type AvatarRuntimeVisualBlock,
} from "@/components/avatar/avatar-runtime";
import { LessonBoard, resolveBoardFrame } from "@/components/lesson/lesson-board";
import { LessonPlayer } from "@/components/lesson/lesson-player";
import { createAvatarSpeechController } from "@/components/avatar/vrm-speech-controller";
import {
  loadCharacterRuntimeAssetUrls,
  type CharacterLicensedRuntimeAssets,
  type CharacterRuntimeAssetUrls,
} from "@/components/avatar/character-runtime-assets";
import {
  useRealtimeSession,
  type BuiltInVoiceProfile,
  type TtsPlaybackPolicy,
} from "@/components/realtime/use-realtime-session";
import {
  createDefaultCharacterRecipe,
  getCharacter,
  getSpace,
  listCharacters,
} from "@/lib/api";
import type {
  CharacterPackDetail,
  CharacterPackSummary,
  CharacterPreviewState,
  CompanionEmotion,
} from "@/lib/types";
import styles from "@/components/realtime/realtime-call-shell.module.css";

const quickPrompts = [
  "把今天的知识点复习成 3 句短口诀。",
  "先安抚一下，再把这个概念讲清楚。",
  "根据刚才的回答，给我一道检查理解的小题。",
];

const MOBILE_LAYOUT_QUERY = "(max-width: 760px)";

function useMobileLayout() {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const query = window.matchMedia(MOBILE_LAYOUT_QUERY);
    const sync = () => setIsMobile(query.matches);

    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  return isMobile;
}

const realtimeAvatarSpeechController = createAvatarSpeechController();
const emptyMotionAssetUrls: Partial<Record<CharacterPreviewState, string>> = {};
const BUILT_IN_VOICE_PRESETS: Array<BuiltInVoiceProfile & { label: string }> = [
  {
    id: "genki",
    label: "明亮（系统）",
    pitch: 1.24,
    rate: 1.08,
    voiceIndex: 0,
    preferredVoiceNames: ["Yaoyao", "Xiaoyou", "Xiaoyi"],
  },
  {
    id: "soft",
    label: "柔和（系统）",
    pitch: 1.12,
    rate: 0.9,
    voiceIndex: 1,
    preferredVoiceNames: ["Huihui", "Xiaoxiao"],
  },
  {
    id: "sweet",
    label: "偏甜（系统）",
    pitch: 1.34,
    rate: 0.98,
    voiceIndex: 2,
    preferredVoiceNames: ["Yaoyao", "Hanhan", "Yating"],
  },
  {
    id: "healing",
    label: "舒缓（系统）",
    pitch: 1.04,
    rate: 0.86,
    voiceIndex: 1,
    preferredVoiceNames: ["Huihui", "Xiaoxiao", "Yating"],
  },
  {
    id: "youth",
    label: "青年（系统）",
    pitch: 1.08,
    rate: 1,
    voiceIndex: 0,
    preferredVoiceNames: ["Kangkang", "Yunxi", "Zhiwei"],
  },
  { id: "off", label: "关闭声音（保留文字）", pitch: 1, rate: 1, voiceIndex: 0 },
];

const defaultAvatarProfile = {
  ...createDefaultCharacterRecipe(),
  display_name: "澄羽",
  relationship_label: "陪你学习的二次元搭子",
  vrm_asset_url: "",
};

function roleLabel(role: string | null | undefined) {
  switch (role) {
    case "friend":
      return "朋友";
    case "senior":
      return "前辈";
    case "partner":
      return "搭档";
    case "rival":
      return "对手";
    case "lover":
      return "恋人";
    default:
      return role && role.trim() ? role : "陪你学习的二次元搭子";
  }
}

function readModelPath(character: CharacterPackDetail | null) {
  const manifest = character?.asset_manifest;
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return null;
  }
  const path = manifest.model_path;
  return typeof path === "string" && path.trim() ? path : null;
}

function mapAvatarState(sessionState: ReturnType<typeof useRealtimeSession>["sessionState"]) {
  if (sessionState === "listening") {
    return "listening";
  }
  if (sessionState === "thinking") {
    return "thinking";
  }
  if (sessionState === "speaking") {
    return "speaking";
  }
  return "idle";
}

function mapAvatarEmotion(
  sessionState: ReturnType<typeof useRealtimeSession>["sessionState"],
  llmEmotion: CompanionEmotion,
): CompanionEmotion {
  switch (sessionState) {
    case "listening":
      return "curious";
    case "thinking":
      return "focused";
    case "interrupted":
    case "error":
      return "concerned";
    case "closed":
      return "neutral";
    case "idle":
    case "speaking":
    default:
      return llmEmotion;
  }
}

function sessionStateLabel(sessionState: ReturnType<typeof useRealtimeSession>["sessionState"]) {
  switch (sessionState) {
    case "listening":
      return "我在听";
    case "thinking":
      return "让我想想";
    case "speaking":
      return "正在回答";
    case "interrupted":
      return "已经停下来";
    case "error":
      return "这次没接上";
    default:
      return "等你开口";
  }
}

function connectionStatusLabel(
  connectionStatus: ReturnType<typeof useRealtimeSession>["connectionStatus"],
) {
  switch (connectionStatus) {
    case "connecting":
      return "正在连接语音";
    case "connected":
      return "语音已连接";
    case "error":
      return "语音未连上，文字仍可用";
    case "ended":
      return "本次共学已结束";
    case "text":
      return "文字陪伴已就绪";
    default:
      return "准备好后就开始";
  }
}

export function RealtimeCallShell({
  initialSessionId,
  spaceId,
}: {
  initialSessionId?: string | null;
  spaceId: string;
}) {
  const requestedSessionId = initialSessionId?.trim() ?? "";
  const requestedSessionResume = Boolean(requestedSessionId);
  const isMobileLayout = useMobileLayout();
  const disclosureOpen = isMobileLayout ? undefined : true;
  const [selectedCharacterId, setSelectedCharacterId] = useState("");
  const [builtInVoiceId, setBuiltInVoiceId] = useState<BuiltInVoiceProfile["id"]>("genki");
  const [ttsPlaybackPolicy, setTtsPlaybackPolicy] = useState<TtsPlaybackPolicy | null>(null);
  const [voicePolicyStatus, setVoicePolicyStatus] = useState<"loading" | "ready" | "error">("loading");
  const [voicePolicyError, setVoicePolicyError] = useState<string | null>(null);
  const [voicePolicyRequest, setVoicePolicyRequest] = useState(0);
  const voicePolicyReady = voicePolicyStatus === "ready";
  const builtInVoiceProfile =
    BUILT_IN_VOICE_PRESETS.find((preset) => preset.id === builtInVoiceId) ??
    BUILT_IN_VOICE_PRESETS[0];
  const session = useRealtimeSession(
    spaceId,
    initialSessionId,
    selectedCharacterId,
    builtInVoiceProfile,
  );
  const activeTtsPlaybackPolicy = session.ttsPlaybackPolicy ?? ttsPlaybackPolicy;
  const [draft, setDraft] = useState("");
  const [characters, setCharacters] = useState<CharacterPackSummary[]>([]);
  const [avatarCharacter, setAvatarCharacter] = useState<CharacterPackDetail | null>(null);
  const [avatarAssetUrl, setAvatarAssetUrl] = useState<string | null>(null);
  const [avatarLicensedRuntimeAsset, setAvatarLicensedRuntimeAsset] = useState<
    CharacterLicensedRuntimeAssets | null
  >(null);
  const [avatarMotionAssetUrls, setAvatarMotionAssetUrls] = useState<
    Partial<Record<CharacterPreviewState, string>>
  >({});
  const [catalogErrors, setCatalogErrors] = useState<string[]>([]);
  const [spaceName, setSpaceName] = useState("当前学习空间");
  const [spaceDefaultCharacterId, setSpaceDefaultCharacterId] = useState<string | null>(null);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const [avatarStatus, setAvatarStatus] = useState("正在读取空间默认角色。");
  const [avatarVisualState, setAvatarVisualState] = useState<{
    characterId: string;
    detail: string;
    mode: "loading" | "ready" | "blocked";
    reason: string;
  }>({ characterId: "", detail: "", mode: "ready", reason: "ready" });
  const [avatarReactionKey, setAvatarReactionKey] = useState<string | null>(null);
  const seenAssistantFinalTurnIdsRef = useRef(new Set<string>());
  const reactionBaselineReadyRef = useRef(!requestedSessionResume);

  useEffect(() => {
    setSelectedCharacterId("");
    setCharacters([]);
    setCatalogErrors([]);
    setSpaceName("当前学习空间");
    setSpaceDefaultCharacterId(null);
    setTtsPlaybackPolicy(null);
    setVoicePolicyStatus("loading");
    setVoicePolicyError(null);
    setAvatarReactionKey(null);
    seenAssistantFinalTurnIdsRef.current.clear();
    reactionBaselineReadyRef.current = !requestedSessionResume;
  }, [requestedSessionId, requestedSessionResume, spaceId]);

  useEffect(() => {
    let active = true;

    setTtsPlaybackPolicy(null);
    setVoicePolicyStatus("loading");
    setVoicePolicyError(null);

    void getSpace(spaceId)
      .then((space) => {
        if (!active) {
          return;
        }
        setSpaceName(space.title);
        setSpaceDefaultCharacterId(space.default_character_id ?? null);
        const ttsAssignment = space.model_assignments?.find(
          (assignment) => assignment.capability === "tts",
        );
        setTtsPlaybackPolicy(
          ttsAssignment?.connection_id === "builtin-mock"
            ? "browser-compat"
            : ttsAssignment?.connection_id === "builtin-neural-tts"
              ? "server-neural"
              : "server",
        );
        setVoicePolicyStatus("ready");
      })
      .catch((error) => {
        if (!active) {
          return;
        }
        const message = error instanceof Error ? error.message : "读取空间失败";
        setVoicePolicyError(`读取空间语音配置失败：${message}`);
        setVoicePolicyStatus("error");
      });

    return () => {
      active = false;
    };
  }, [spaceId, voicePolicyRequest]);

  useEffect(() => {
    let active = true;

    void listCharacters()
      .then((nextCharacters) => {
        if (!active) {
          return;
        }
        setCharacters(nextCharacters);
      })
      .catch((error) => {
        if (!active) {
          return;
        }
        const message = error instanceof Error ? error.message : "读取角色列表失败";
        setCatalogErrors((current) => [...current, `读取角色列表失败：${message}`]);
      });

    return () => {
      active = false;
    };
  }, [spaceId]);

  const sessionResumeFailed = requestedSessionResume
    && !session.isSessionHydrating
    && !session.sessionId;
  const avatarCharacterId = session.isSessionHydrating || sessionResumeFailed
    ? null
    : session.sessionId
      ? session.sessionCharacterId
      : selectedCharacterId || spaceDefaultCharacterId;
  const displayedAvatarCharacter = avatarCharacter?.id === avatarCharacterId
    ? avatarCharacter
    : null;
  const missingSessionCharacterId = session.sessionId
    && session.sessionCharacterId
    && !characters.some((character) => character.id === session.sessionCharacterId)
    ? session.sessionCharacterId
    : null;
  const avatarVisualBlock: AvatarRuntimeVisualBlock | null = session.isSessionHydrating
    ? {
        detail: "正在恢复会话快照与角色绑定。",
        kind: "character",
        mode: "loading",
        reason: "session-hydrating",
      }
    : sessionResumeFailed
      ? {
          detail: session.error || "会话恢复失败，未加载任何角色形象。",
          kind: "character",
          mode: "blocked",
          reason: "session-resume-failed",
        }
      : avatarCharacterId
        ? avatarVisualState.characterId !== avatarCharacterId || avatarVisualState.mode === "loading"
          ? {
              detail: avatarVisualState.characterId === avatarCharacterId
                ? avatarVisualState.detail
                : "正在读取目标角色及其受保护形象资产。",
              kind: "character",
              mode: "loading",
              reason: "character-loading",
            }
          : avatarVisualState.mode === "blocked"
            ? {
                detail: avatarVisualState.detail,
                kind: "character",
                mode: "blocked",
                reason: avatarVisualState.reason,
              }
            : null
        : null;
  const displayedAvatarName = displayedAvatarCharacter?.name
    ?? characters.find((character) => character.id === avatarCharacterId)?.name
    ?? (session.isSessionHydrating
      ? "正在恢复会话"
      : sessionResumeFailed
        ? "会话恢复失败"
        : avatarCharacterId
          ? "正在加载角色"
          : "澄羽");

  useEffect(() => {
    let active = true;
    let nextAssets: CharacterRuntimeAssetUrls | null = null;
    let resolvedCharacter: CharacterPackDetail | null = null;

    setAvatarCharacter(null);
    setAvatarError(null);
    setAvatarStatus("正在读取角色。");
    setAvatarAssetUrl(null);
    setAvatarLicensedRuntimeAsset(null);
    setAvatarMotionAssetUrls({});
    setAvatarVisualState({
      characterId: avatarCharacterId ?? "",
      detail: avatarCharacterId ? "正在读取目标角色及其受保护形象资产。" : "",
      mode: avatarCharacterId ? "loading" : "ready",
      reason: avatarCharacterId ? "character-loading" : "ready",
    });

    if (session.isSessionHydrating) {
      setAvatarStatus("正在恢复会话与角色绑定。");
      return;
    }

    if (sessionResumeFailed) {
      setAvatarStatus("会话恢复失败，未加载任何角色形象。");
      return;
    }

    const loadAvatar = async () => {
      try {
        if (!avatarCharacterId) {
          setAvatarStatus("当前未绑定可用角色，已使用内置角色澄羽。");
          return;
        }

        setAvatarStatus("正在加载角色形象。");
        const character = await getCharacter(avatarCharacterId);
        resolvedCharacter = character;
        if (!active) {
          return;
        }

        const modelPath = readModelPath(character);
        setAvatarStatus(
          modelPath
            ? "正在读取受保护的角色模型与动作资产。"
            : "正在读取角色动作资产。",
        );
        const assets = await loadCharacterRuntimeAssetUrls(character);
        if (!active) {
          assets.revoke();
          return;
        }
        nextAssets = assets;
        setAvatarAssetUrl(assets.kind === "vrm" ? assets.modelUrl : null);
        setAvatarLicensedRuntimeAsset(assets.kind === "licensed" ? assets : null);
        setAvatarMotionAssetUrls(assets.motionUrls);
        if (assets.warnings.length) {
          setAvatarError(`部分角色动作不可用：${assets.warnings.join("；")}`);
        }

        setAvatarCharacter(character);
        setAvatarStatus(`当前角色：${character.name}`);
        setAvatarVisualState({
          characterId: avatarCharacterId,
          detail: `当前角色：${character.name}`,
          mode: "ready",
          reason: "ready",
        });
      } catch (error) {
        if (!active) {
          return;
        }
        const message = error instanceof Error ? error.message : "读取角色失败";
        setAvatarCharacter(resolvedCharacter);
        setAvatarAssetUrl(null);
        setAvatarLicensedRuntimeAsset(null);
        setAvatarMotionAssetUrls({});
        setAvatarError(`角色形象加载失败：${message}。文字会话仍可继续，且不会切换角色。`);
        setAvatarStatus(resolvedCharacter ? `当前角色：${resolvedCharacter.name}（形象不可用）` : "角色资料不可用。");
        setAvatarVisualState({
          characterId: avatarCharacterId ?? "",
          detail: `角色形象加载失败：${message}。文字会话仍可继续。`,
          mode: "blocked",
          reason: "character-asset-invalid",
        });
      }
    };

    void loadAvatar();

    return () => {
      active = false;
      nextAssets?.revoke();
    };
  }, [avatarCharacterId, session.isSessionHydrating, sessionResumeFailed]);

  const previewRecipe = useMemo(() => {
    if (!displayedAvatarCharacter) {
      return defaultAvatarProfile;
    }

    return {
      ...createDefaultCharacterRecipe(displayedAvatarCharacter.recipe),
      display_name: displayedAvatarCharacter.name,
      relationship_label: roleLabel(displayedAvatarCharacter.recipe.relationship_role),
      vrm_asset_url: avatarAssetUrl ?? "",
    };
  }, [avatarAssetUrl, displayedAvatarCharacter]);

  const liveBoardFrame = useMemo(
    () => resolveBoardFrame(session.currentBoardActions),
    [session.currentBoardActions],
  );
  useEffect(() => {
    const finalAssistantTurnIds = session.transcript.flatMap((turn) =>
      turn.role === "assistant" && turn.status === "final" ? [turn.id] : [],
    );
    if (!reactionBaselineReadyRef.current) {
      if (session.isSessionHydrating) {
        return;
      }
      finalAssistantTurnIds.forEach((turnId) => {
        seenAssistantFinalTurnIdsRef.current.add(turnId);
      });
      reactionBaselineReadyRef.current = true;
      return;
    }

    let latestNewTurnId: string | null = null;
    finalAssistantTurnIds.forEach((turnId) => {
      if (!seenAssistantFinalTurnIdsRef.current.has(turnId)) {
        seenAssistantFinalTurnIdsRef.current.add(turnId);
        latestNewTurnId = turnId;
      }
    });
    if (latestNewTurnId) {
      setAvatarReactionKey(latestNewTurnId);
    }
  }, [session.isSessionHydrating, session.transcript]);
  const demoRequestHint = !session.sessionId
    ? "先开始一次对话，再让角色为你画图讲解。"
    : session.hasRemoteTurn || session.isSendingText
      ? "角色正在回复；等这一轮结束或先打断，再开始新的分步演示。"
      : "选一个想看懂的主题，角色会把它拆成可暂停、可重播的分步演示。";
  const narrationCharacterId = session.sessionId ? session.sessionCharacterId : null;
  const avatarEmotion = mapAvatarEmotion(session.sessionState, session.avatarEmotion);
  const characterSelectionLocked = Boolean(session.sessionId)
    || session.isSessionHydrating
    || session.isSendingText
    || session.connectionStatus === "connecting";

  useEffect(() => {
    realtimeAvatarSpeechController.publishLevel(session.playbackAudioLevel);
  }, [session.playbackAudioLevel]);

  useEffect(() => () => {
    realtimeAvatarSpeechController.reset();
  }, []);

  const pushToTalkStatus = session.pushToTalkStatus === "recording"
    ? "正在听你说话，松开后发送。"
    : session.pushToTalkStatus === "sent"
      ? "按住说话已发送"
      : session.isMuted
        ? "麦克风已静音；取消静音后才能按住说话。"
        : "按住按钮说话，松开后发送。";
  const companionStateLabel = sessionStateLabel(session.sessionState);
  const friendlyConnectionStatus = connectionStatusLabel(session.connectionStatus);

  return (
    <section className={`panel ${styles.shell}`}>
      <div className={styles.hero}>
        <div className={styles.heroCopy}>
          <p className="eyebrow">和 {displayedAvatarName} 一起</p>
          <h1>{spaceName}</h1>
          <p className={styles.heroLead}>{friendlyConnectionStatus}</p>
        </div>
        <details className={styles.heroMetaDisclosure} open={disclosureOpen}>
          <summary>连接详情</summary>
          <div className={styles.heroMeta}>
            <div>
              <span>连接</span>
              <strong>{session.connectionStatus}</strong>
            </div>
            <div>
              <span>状态</span>
              <strong>{session.sessionState}</strong>
            </div>
            <div>
              <span>会话 ID</span>
              <strong>{session.sessionId ? session.sessionId.slice(0, 8) : "未创建"}</strong>
            </div>
          </div>
        </details>
      </div>

      <div className={styles.layout}>
        <div className={styles.stageColumn}>
          <div className={`panel ${styles.stage}`}>
            <div className={styles.stageVisual}>
              <AvatarRuntime
                builtinRuntimeReady={Boolean(
                  displayedAvatarCharacter
                  && !avatarAssetUrl
                  && !avatarLicensedRuntimeAsset
                )}
                compact
                emotion={avatarEmotion}
                licensedRuntimeAsset={
                  displayedAvatarCharacter ? avatarLicensedRuntimeAsset : null
                }
                motionAssetUrls={
                  displayedAvatarCharacter ? avatarMotionAssetUrls : emptyMotionAssetUrls
                }
                recipe={previewRecipe}
                reactionKey={avatarReactionKey}
                sessionId={session.sessionId}
                state={mapAvatarState(session.sessionState)}
                speechController={realtimeAvatarSpeechController}
                visualBlock={avatarVisualBlock}
              />
              <div className={styles.stagePresence} role="status" aria-live="polite">
                <span className={styles.presenceDot} aria-hidden="true" />
                <div>
                  <strong>{displayedAvatarName}</strong>
                  <span>{companionStateLabel}</span>
                </div>
              </div>
            </div>
            <div className={styles.stageControls}>
              <div className={styles.controlBar}>
                <button
                  type="button"
                  className={styles.primaryButton}
                  aria-label="开始语音"
                  disabled={
                    session.isSessionHydrating ||
                    !voicePolicyReady ||
                    session.connectionStatus === "connecting" ||
                    session.connectionStatus === "connected"
                  }
                  onClick={() => void session.connect()}
                >
                  {!voicePolicyReady
                    ? voicePolicyStatus === "error"
                      ? "语音配置不可用"
                      : "正在读取语音配置…"
                    : session.isSessionHydrating
                    ? "正在恢复会话…"
                    : session.connectionStatus === "connecting"
                      ? "正在连接…"
                      : "开始语音"}
                </button>
                <button
                  type="button"
                  className={`${styles.secondaryButton} ${styles.pttButton}`}
                  aria-label="按住说话"
                  aria-pressed={session.isPushToTalkActive}
                  disabled={!session.canPushToTalk}
                  onBlur={() => {
                    if (session.isPushToTalkActive) {
                      session.cancelPushToTalk();
                    }
                  }}
                  onKeyDown={(event) => {
                    if (
                      event.repeat ||
                      ![" ", "Space", "Spacebar", "Enter"].includes(event.key)
                    ) {
                      return;
                    }
                    event.preventDefault();
                    session.startPushToTalk();
                  }}
                  onKeyUp={(event) => {
                    if (![" ", "Space", "Spacebar", "Enter"].includes(event.key)) {
                      return;
                    }
                    event.preventDefault();
                    session.stopPushToTalk();
                  }}
                  onPointerCancel={session.cancelPushToTalk}
                  onLostPointerCapture={(event) => {
                    if (event.buttons !== 0) {
                      session.cancelPushToTalk();
                    }
                  }}
                  onPointerDown={(event) => {
                    event.preventDefault();
                    if (!session.startPushToTalk()) {
                      return;
                    }
                    event.currentTarget.setPointerCapture(event.pointerId);
                  }}
                  onPointerUp={(event) => {
                    session.stopPushToTalk();
                    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                      event.currentTarget.releasePointerCapture(event.pointerId);
                    }
                  }}
                >
                  按住说话
                </button>
                <details className={styles.callActions} open={disclosureOpen}>
                  <summary>通话控制</summary>
                  <div>
                    <button
                      type="button"
                      className={styles.secondaryButton}
                      disabled={session.connectionStatus !== "connected"}
                      onClick={session.toggleMute}
                    >
                      {session.isMuted ? "取消静音" : "静音麦克风"}
                    </button>
                    <button
                      type="button"
                      className={styles.secondaryButton}
                      disabled={session.connectionStatus !== "connected"}
                      onClick={session.interrupt}
                    >
                      立即打断
                    </button>
                    <button
                      type="button"
                      className={styles.secondaryButton}
                      disabled={
                        !session.sessionId ||
                        session.connectionStatus === "ended" ||
                        session.isSendingText
                      }
                      onClick={() => void session.disconnect()}
                    >
                      结束会话
                    </button>
                  </div>
                </details>
              </div>
            </div>
            <details className={styles.stageSettings} open={disclosureOpen}>
              <summary>角色与语音设置</summary>
              <div className={styles.stageSettingsBody}>
              <p className={styles.helperText}>{avatarStatus}</p>
              {catalogErrors.length ? (
                <p className={styles.errorText}>{catalogErrors.join("；")}</p>
              ) : null}
              {avatarError ? <p className={styles.errorText}>{avatarError}</p> : null}
              <label className={styles.characterField}>
              <span>本次会话角色</span>
              <select
                aria-label="本次会话角色"
                disabled={characterSelectionLocked}
                value={
                  session.sessionId ? session.sessionCharacterId ?? "" : selectedCharacterId
                }
                onChange={(event) => setSelectedCharacterId(event.target.value)}
              >
                <option value="">使用空间默认角色</option>
                {missingSessionCharacterId ? (
                  <option disabled value={missingSessionCharacterId}>
                    {displayedAvatarCharacter?.name
                      ?? `当前会话角色（${missingSessionCharacterId.slice(0, 8)}，角色库中不可用）`}
                  </option>
                ) : null}
                {characters.map((character) => (
                  <option key={character.id} value={character.id}>
                    {character.name}
                  </option>
                ))}
              </select>
              <small>
                {session.sessionId
                  ? "当前会话已固定该角色；结束会话后才能换。"
                  : session.isSessionHydrating
                    ? "正在恢复持久化的会话角色，不能改写。"
                    : session.isSendingText || session.connectionStatus === "connecting"
                      ? "正在创建会话，角色选择已锁定。"
                      : "只决定下一次新会话，不会改变空间默认角色。"}
              </small>
            </label>
            {activeTtsPlaybackPolicy === "browser-compat" ? (
              <label className={styles.characterField}>
                <span>兼容系统朗读</span>
                <select
                  aria-label="兼容系统朗读"
                  disabled={Boolean(session.sessionId) || session.isSessionHydrating || session.hasRemoteTurn}
                  value={builtInVoiceId}
                  onChange={(event) => setBuiltInVoiceId(event.target.value as BuiltInVoiceProfile["id"])}
                >
                  {BUILT_IN_VOICE_PRESETS.map((preset) => (
                    <option key={preset.id} value={preset.id}>
                      {preset.label}
                    </option>
                  ))}
                </select>
                <small>
                  {session.sessionId
                    ? "当前会话已固定该声音；结束会话后可以更换。"
                    : "旧 Mock 空间的浏览器系统朗读兼容项，可能带明显合成感；新本地神经语音不会走这里。"}
                </small>
              </label>
            ) : null}
            {activeTtsPlaybackPolicy === "server-neural" ? (
              <div className={styles.characterField} role="status">
                <span>本地神经语音</span>
                <small>声线由当前角色配方决定；回复使用服务端 PCM，不调用浏览器系统朗读。</small>
              </div>
            ) : null}
            {voicePolicyStatus === "error" ? (
              <div className={styles.controlBar} role="alert">
                <p className={styles.errorText}>
                  {voicePolicyError ?? "读取空间语音配置失败。"}
                </p>
                <button
                  type="button"
                  className={styles.secondaryButton}
                  onClick={() => setVoicePolicyRequest((current) => current + 1)}
                >
                  重试语音配置
                </button>
              </div>
            ) : null}
            <div className={styles.meterCard}>
              <div
                className={styles.meterLabel}
                data-playback-level={Math.round(session.playbackAudioLevel * 1000) / 1000}
              >
                <span>麦克风音量</span>
                <strong>{Math.round(session.audioLevel * 100)}%</strong>
              </div>
              <div className={styles.meterTrack}>
                <div className={styles.meterFill} style={{ width: `${Math.min(100, Math.round(session.audioLevel * 1000) / 10)}%` }} />
              </div>
              <label className={styles.sliderField}>
                <span>静音后自动提交 {session.commitSilenceMs}ms</span>
                <input
                  type="range"
                  min={400}
                  max={1500}
                  step={50}
                  value={session.commitSilenceMs}
                  onChange={(event) => session.setCommitSilenceMs(Number(event.target.value))}
                />
              </label>
              <p className={styles.helperText}>
                仅在实时连接成功后采集麦克风；文字模式不会请求设备权限。
              </p>
              <p className={styles.helperText}>{pushToTalkStatus}</p>
            </div>
              </div>
            </details>
          </div>

          <details
            className={`${styles.mobileDisclosure} ${styles.boardDisclosure}`}
            open={disclosureOpen}
          >
            <summary>当前板书</summary>
            <div className={`panel ${styles.boardPanel}`}>
            <div className={styles.panelTopline}>
              <div>
                <p className="eyebrow">学习板书</p>
                <h3>当前板书</h3>
              </div>
              <span>
                {session.currentBoardActions.length
                  ? `${session.currentBoardActions.length} 条`
                  : "等待新的板书"}
              </span>
            </div>
            <LessonBoard
              compact
              action={liveBoardFrame.action}
              baseAction={liveBoardFrame.baseAction}
            />
            <p className={styles.helperText}>
              这里展示当前对话里最新的一张板书。高亮步骤会叠加在上一张板书上。
            </p>
            </div>
          </details>

          <details
            className={`${styles.mobileDisclosure} ${styles.demoDisclosure}`}
            open={disclosureOpen}
          >
            <summary>互动演示</summary>
            <div>
              <LessonPlayer
                canRequestDemo={
                  Boolean(session.sessionId) &&
                  session.connectionStatus !== "ended" &&
                  !session.hasRemoteTurn &&
                  !session.isSendingText
                }
                characterId={narrationCharacterId}
                demo={session.demo}
                demoAudioStopToken={session.demoAudioStopToken}
                demoError={session.demoError}
                isDemoLoading={session.isDemoLoading}
                onAskQuestion={async (question) => {
                  await session.stopDemoNarration();
                  return session.sendText(question);
                }}
                onClearDemo={session.clearDemo}
                onPlayNarration={session.playDemoNarration}
                onRequestDemo={session.requestDemo}
                onStopNarration={session.stopDemoNarration}
                requestHint={demoRequestHint}
                speakingRate={avatarCharacter?.recipe.speaking_rate}
                voiceId={avatarCharacter?.recipe.voice_id}
              />
            </div>
          </details>

          <div className={`panel ${styles.composer}`} data-testid="realtime-composer">
            <div className={styles.quickRow}>
              {quickPrompts.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  className={styles.quickButton}
                  disabled={!voicePolicyReady || session.isSessionHydrating || session.isSendingText}
                  onClick={() => void session.sendText(prompt)}
                >
                  {prompt}
                </button>
              ))}
            </div>
            <form
              className={styles.form}
              onSubmit={async (event) => {
                event.preventDefault();
                if (
                  !voicePolicyReady ||
                  !draft.trim() ||
                  session.isSessionHydrating ||
                  session.isSendingText
                ) {
                  return;
                }
                const submittedDraft = draft;
                const sent = await session.sendText(submittedDraft);
                if (!sent) {
                  return;
                }
                setDraft((current) => (current === submittedDraft ? "" : current));
              }}
            >
              <textarea
                aria-label="发送文字消息"
                autoComplete="off"
                name="message"
                rows={4}
                value={draft}
                disabled={!voicePolicyReady || session.isSessionHydrating}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="输入消息…"
              />
              <button
                type="submit"
                className={styles.primaryButton}
                aria-label="发送文本"
                disabled={
                  !voicePolicyReady ||
                  session.isSessionHydrating ||
                  session.isSendingText ||
                  !draft.trim()
                }
              >
                {!voicePolicyReady
                  ? voicePolicyStatus === "error"
                    ? "语音配置不可用"
                    : "正在读取语音配置…"
                  : session.isSessionHydrating
                    ? "正在恢复会话…"
                    : session.isSendingText
                      ? "发送中…"
                      : "发送"}
              </button>
            </form>
          </div>
        </div>

        <aside className={styles.sideColumn}>
          <div className={`panel ${styles.captionPanel}`}>
            <p className="eyebrow">伙伴正在说</p>
            <h3>实时字幕</h3>
            <p className={styles.captionText}>{session.partialCaption || "文字模式已就绪；连上实时通话后，这里会显示边听边说的字幕。"}</p>
            {session.error ? <p className={styles.errorText}>{session.error}</p> : null}
          </div>

          <details
            className={`${styles.mobileDisclosure} ${styles.transcriptDisclosure}`}
            open={disclosureOpen}
          >
            <summary>会话记录 · {session.transcript.length} 条</summary>
            <div className={`panel ${styles.transcriptPanel}`}>
            <div className={styles.panelTopline}>
              <p className="eyebrow">会话记录</p>
              {session.sessionId ? (
                <Link href={`/sessions/${session.sessionId}`}>{session.transcript.length} 条 · 查看复盘</Link>
              ) : (
                <span>{session.transcript.length} 条</span>
              )}
            </div>
            <div className={styles.transcriptList}>
              {session.transcript.length ? (
                session.transcript.map((turn) => (
                  <article key={turn.id} className={styles.turn} data-role={turn.role}>
                    <div className={styles.turnTopline}>
                      <strong>{turn.role === "user" ? "你" : turn.role === "assistant" ? displayedAvatarName : "提示"}</strong>
                      {turn.status ? <span>{turn.status}</span> : null}
                    </div>
                    <p>{turn.text}</p>
                    {turn.citations?.length ? (
                      <div className={styles.citationRow}>
                        {turn.citations.map((citation) => (
                          <span key={`${citation.title}-${citation.locator}`}>{citation.title}</span>
                        ))}
                      </div>
                    ) : null}
                  </article>
                ))
              ) : (
                <p className="muted">发送第一条文字后，这里会显示当前会话的最终用户输入与服务端回复。</p>
              )}
            </div>
            </div>
          </details>

          <details
            className={`${styles.mobileDisclosure} ${styles.noteDisclosure}`}
            open={disclosureOpen}
          >
            <summary>使用说明</summary>
            <div className={`panel ${styles.notePanel}`}>
            <p className="eyebrow">使用提示</p>
            <ul>
              <li>没有连上实时通话时，仍然可以继续使用真实的文字对话，不会伪造回复。</li>
              <li>语音能力失败时会明确降级到文字模式，不会悄悄切到别的能力或 Mock。</li>
              <li>浏览器不支持 AudioWorklet 时回退 ScriptProcessor。</li>
              <li>麦克风权限拒绝时仍可纯文本通话。</li>
            </ul>
            </div>
          </details>
        </aside>
      </div>
    </section>
  );
}
