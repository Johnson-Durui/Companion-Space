"use client";

import dynamic from "next/dynamic";
import NextImage from "next/image";
import type { CSSProperties, KeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import styles from "@/components/avatar/avatar-runtime.module.css";
import {
  AVATAR_MOTION_STATES,
  getRuntimeRecipeView,
  type AvatarMotionStatus,
} from "@/components/avatar/vrm-recipe";
import type { AvatarSpeechController } from "@/components/avatar/vrm-speech-controller";
import type { CharacterLicensedRuntimeAssets } from "@/components/avatar/character-runtime-assets";
import {
  LicensedRuntimeStage,
  licensedRuntimeAssetIdentity,
  type LicensedRuntimeStatus,
} from "@/components/avatar/licensed-runtime-stage";
import type {
  AvatarGazeInput,
  AvatarRuntimeCapabilities,
} from "@/components/avatar/vrm-stage";
import type {
  CharacterRecipe,
  CharacterPreviewState,
  CompanionEmotion,
} from "@/lib/types";

const LazyVrmStage = dynamic(
  () => import("@/components/avatar/vrm-stage").then((module) => module.VrmStage),
  {
    ssr: false,
  },
);

interface RuntimeStatus {
  assetUrl?: string;
  mode: "loading" | "ready" | "fallback" | "blocked" | "error";
  detail: string;
  missing?: string[];
  reason?: string;
}

function spriteGazeDirection(x: number, y: number, directions: number) {
  const fullCircle = Math.PI * 2;
  // Atlas directions advance clockwise from 000 = screen-up.
  const angle = (Math.atan2(x, y) + fullCircle) % fullCircle;
  return Math.round(angle / (fullCircle / directions)) % directions;
}

export type AvatarRuntimeMode = RuntimeStatus["mode"];

export interface AvatarRuntimeVisualBlock {
  detail: string;
  kind: "character";
  mode: "loading" | "blocked";
  reason: string;
}

function stateLabel(state: CharacterPreviewState) {
  switch (state) {
    case "idle":
      return "Idle";
    case "listening":
      return "Listening";
    case "thinking":
      return "Thinking";
    case "speaking":
      return "Speaking";
    default:
      return state;
  }
}

function expressionLabel(emotion: CompanionEmotion) {
  switch (emotion) {
    case "neutral":
      return "平静";
    case "warm":
      return "温柔";
    case "cheerful":
      return "开心";
    case "curious":
      return "好奇";
    case "focused":
      return "专注";
    case "playful":
      return "俏皮";
    case "concerned":
      return "关切";
    default:
      return emotion;
  }
}

function supportsWebGL() {
  if (typeof document === "undefined") {
    return false;
  }
  const canvas = document.createElement("canvas");
  return Boolean(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
}

function detectMissingDependencies(error: Error) {
  const message = error.message.toLowerCase();
  const missing: string[] = [];
  if (message.includes("three")) {
    missing.push("three");
  }
  if (message.includes("@react-three/fiber") || message.includes("fiber")) {
    missing.push("@react-three/fiber");
  }
  if (message.includes("@pixiv/three-vrm") || message.includes("three-vrm")) {
    missing.push("@pixiv/three-vrm");
  }
  return missing.length ? Array.from(new Set(missing)) : undefined;
}

export function AvatarRuntime({
  compact = false,
  emotion = "neutral",
  recipe,
  reactionKey,
  sessionId,
  state,
  speechController,
  motionAssetUrls,
  builtinRuntimeReady = false,
  licensedRuntimeAsset,
  visualBlock,
  onCapabilitiesChange,
  onRuntimeModeChange,
}: {
  compact?: boolean;
  builtinRuntimeReady?: boolean;
  emotion?: CompanionEmotion;
  motionAssetUrls?: Partial<Record<CharacterPreviewState, string>>;
  licensedRuntimeAsset?: CharacterLicensedRuntimeAssets | null;
  visualBlock?: AvatarRuntimeVisualBlock | null;
  onCapabilitiesChange?: (capabilities: AvatarRuntimeCapabilities | null) => void;
  onRuntimeModeChange?: (mode: AvatarRuntimeMode) => void;
  recipe: CharacterRecipe | Record<string, unknown>;
  reactionKey?: string | null;
  sessionId?: string | null;
  state: CharacterPreviewState;
  speechController?: AvatarSpeechController;
}) {
  const runtimeRecipe = getRuntimeRecipeView(recipe);
  const portraitDefinition = runtimeRecipe.portraitDefinition;
  const spriteDefinition = runtimeRecipe.spriteDefinition;
  const isPortraitRuntime = runtimeRecipe.runtimeKind === "portrait_2d" && Boolean(portraitDefinition);
  const isSpriteRuntime = runtimeRecipe.runtimeKind === "sprite_2d" && Boolean(spriteDefinition);
  const isUnsupportedRuntime = runtimeRecipe.runtimeKind === "unsupported";
  const portraitDisplayName = portraitDefinition?.displayName ?? "2D portrait";
  const spriteDisplayName = spriteDefinition?.displayName ?? "2D 伙伴";
  const authorizedAssetMotionUrls = Object.fromEntries(
    AVATAR_MOTION_STATES.flatMap((motionState) => {
      const value = motionAssetUrls?.[motionState];
      return typeof value === "string" && value.startsWith("blob:")
        ? [[motionState, value]]
        : [];
    }),
  );
  const effectiveMotionUrls = {
    ...runtimeRecipe.motionUrls,
    ...authorizedAssetMotionUrls,
  };
  const [prefersReducedMotion, setPrefersReducedMotion] = useState<boolean | null>(null);
  const [webglAvailable, setWebglAvailable] = useState<boolean | null>(null);
  const [status, setStatus] = useState<RuntimeStatus>({
    mode: "loading",
    detail: "正在检测浏览器图形能力。",
  });
  const [motionStatus, setMotionStatus] = useState<AvatarMotionStatus>({
    mode: "procedural",
    state,
    detail: "Using the built-in procedural motion fallback.",
  });
  const [licensedStatus, setLicensedStatus] = useState<LicensedRuntimeStatus | null>(null);
  const [gestureSequence, setGestureSequence] = useState(0);
  const [gestureActive, setGestureActive] = useState(false);
  const [spriteFrame, setSpriteFrame] = useState(0);
  const [spriteDirection, setSpriteDirection] = useState<number | null>(null);
  const [spriteAssetStatus, setSpriteAssetStatus] = useState<RuntimeStatus>({
    mode: "loading",
    detail: `正在加载 ${spriteDisplayName} 2D 动态角色。`,
    reason: "loading",
  });
  const [portraitAssetStatus, setPortraitAssetStatus] = useState<RuntimeStatus>({
    mode: "loading",
    detail: `Loading ${portraitDisplayName} portrait.`,
    reason: "loading",
  });
  const gestureTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastReactionKeyRef = useRef<string | null | undefined>(reactionKey);
  const gazeInputRef = useRef<AvatarGazeInput>({ active: false, x: 0, y: 0 });
  const viewportRef = useRef<HTMLDivElement>(null);

  const updateGazeInput = useCallback((active: boolean, x = 0, y = 0) => {
    const source = prefersReducedMotion === true ? "reduced" : active ? "pointer" : "idle";
    const appliedX = source === "pointer" ? x : 0;
    const appliedY = source === "pointer" ? y : 0;
    gazeInputRef.current.active = source === "pointer";
    gazeInputRef.current.x = appliedX;
    gazeInputRef.current.y = appliedY;

    if (spriteDefinition) {
      const nextDirection = source === "pointer"
        ? spriteGazeDirection(appliedX, appliedY, spriteDefinition.gaze.directions)
        : null;
      setSpriteDirection((current) => current === nextDirection ? current : nextDirection);
    }

    const viewport = viewportRef.current;
    if (viewport) {
      viewport.dataset.avatarGazeSource = source;
      viewport.dataset.avatarGazeInput = `${appliedX.toFixed(3)},${appliedY.toFixed(3)}`;
      viewport.style.setProperty("--avatar-gaze-eye-x", `${appliedX * 3}px`);
      viewport.style.setProperty("--avatar-gaze-eye-y", `${appliedY * -2}px`);
    }
  }, [prefersReducedMotion, spriteDefinition]);

  const handlePointerInput = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!event.isPrimary) {
      return;
    }
    const bounds = event.currentTarget.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) {
      updateGazeInput(false);
      return;
    }
    const clamp = (value: number) => Math.max(-1, Math.min(1, value));
    updateGazeInput(
      true,
      clamp(((event.clientX - bounds.left) / bounds.width) * 2 - 1),
      clamp(1 - ((event.clientY - bounds.top) / bounds.height) * 2),
    );
  }, [updateGazeInput]);

  const handlePointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.isPrimary && event.pointerType !== "mouse") {
      updateGazeInput(false);
    }
  }, [updateGazeInput]);

  const handlePointerReset = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.isPrimary) {
      updateGazeInput(false);
    }
  }, [updateGazeInput]);

  useEffect(() => {
    setLicensedStatus(null);
  }, [licensedRuntimeAsset]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const syncMotionPreference = () => {
      setPrefersReducedMotion(mediaQuery.matches);
    };

    syncMotionPreference();
    setWebglAvailable(isPortraitRuntime || isSpriteRuntime ? false : supportsWebGL());

    mediaQuery.addEventListener("change", syncMotionPreference);
    return () => {
      mediaQuery.removeEventListener("change", syncMotionPreference);
    };
  }, [isPortraitRuntime, isSpriteRuntime]);

  useEffect(() => {
    if (!isPortraitRuntime) {
      return;
    }

    const assetUrl = runtimeRecipe.portraitAssetUrl;
    if (!assetUrl) {
      setPortraitAssetStatus({
        assetUrl,
        mode: "error",
        detail: `${portraitDisplayName} portrait asset is not configured.`,
        reason: "missing_portrait_asset",
      });
      return;
    }

    setPortraitAssetStatus({
      assetUrl,
      mode: "loading",
      detail: `Loading ${portraitDisplayName} portrait.`,
      reason: "loading",
    });
  }, [isPortraitRuntime, portraitDisplayName, runtimeRecipe.portraitAssetUrl]);

  useEffect(() => {
    if (!isSpriteRuntime) {
      return;
    }

    const assetUrl = runtimeRecipe.spriteAssetUrl;
    if (!assetUrl) {
      setSpriteAssetStatus({
        mode: "error",
        detail: `${spriteDisplayName} 2D 动态角色资源未配置。`,
        reason: "missing_sprite_asset",
      });
      return;
    }

    let cancelled = false;
    const image = new Image();
    setSpriteAssetStatus({
      assetUrl,
      mode: "loading",
      detail: `正在加载 ${spriteDisplayName} 2D 动态角色。`,
      reason: "loading",
    });

    image.onload = async () => {
      try {
        await image.decode();
        if (!cancelled) {
          setSpriteAssetStatus({
            assetUrl,
            mode: "ready",
            detail: `${spriteDisplayName} 2D 动态角色已就绪。`,
            reason: "ready",
          });
        }
      } catch (error) {
        if (!cancelled) {
          setSpriteAssetStatus({
            assetUrl,
            mode: "error",
            detail: error instanceof Error
              ? `${spriteDisplayName} 2D 动态角色解码失败：${error.message}`
              : `${spriteDisplayName} 2D 动态角色解码失败。`,
            reason: "sprite_decode_failed",
          });
        }
      }
    };
    image.onerror = () => {
      if (!cancelled) {
        setSpriteAssetStatus({
          assetUrl,
          mode: "error",
          detail: `${spriteDisplayName} 2D 动态角色资源加载失败。`,
          reason: "sprite_load_failed",
        });
      }
    };
    image.src = assetUrl;

    return () => {
      cancelled = true;
      image.onload = null;
      image.onerror = null;
    };
  }, [isSpriteRuntime, runtimeRecipe.spriteAssetUrl, spriteDisplayName]);

  useEffect(() => {
    if (licensedRuntimeAsset) {
      setStatus({
        mode: "loading",
        detail: `正在加载 ${licensedRuntimeAsset.format} 已许可运行时桥接。`,
      });
    }
  }, [licensedRuntimeAsset]);

  useEffect(() => {
    if (licensedRuntimeAsset) {
      return;
    }
    if (isPortraitRuntime || isSpriteRuntime) {
      return;
    }
    if (isUnsupportedRuntime) {
      setStatus({
        mode: "error",
        detail: `未识别形象模型「${runtimeRecipe.modelId}」，已停止渲染以避免显示错误角色。`,
        reason: "unsupported_avatar_model",
      });
      return;
    }
    if (!runtimeRecipe.vrmAssetUrl) {
      setStatus({
        mode: "fallback",
        detail: "未配置 VRM 资产 URL，当前展示 2D 立绘兜底。",
      });
      return;
    }

    if (webglAvailable === false) {
      setStatus({
        mode: "fallback",
        detail: "当前设备不支持 WebGL，已回退到 2D 立绘模式。",
      });
      return;
    }

    if (webglAvailable === true) {
      setStatus({
        mode: "loading",
        detail: prefersReducedMotion
          ? "正在以低动态模式准备角色形象…"
          : "正在准备角色形象…",
      });
      return;
    }

    setStatus({
      mode: "loading",
      detail: "正在检测浏览器图形能力。",
    });
  }, [isPortraitRuntime, isSpriteRuntime, isUnsupportedRuntime, licensedRuntimeAsset, prefersReducedMotion, runtimeRecipe.modelId, runtimeRecipe.vrmAssetUrl, webglAvailable]);

  const currentLicensedIdentity = licensedRuntimeAsset
    ? licensedRuntimeAssetIdentity(licensedRuntimeAsset)
    : null;
  const motionPreferenceReady = prefersReducedMotion !== null;
  const reducedMotion = prefersReducedMotion === true;
  const activeLicensedStatus = licensedStatus?.assetIdentity === currentLicensedIdentity
    ? licensedStatus
    : null;
  const spriteStatusMatches = spriteAssetStatus.assetUrl === runtimeRecipe.spriteAssetUrl;
  const portraitStatusMatches = portraitAssetStatus.assetUrl === runtimeRecipe.portraitAssetUrl;
  const runtimeStatus: RuntimeStatus = visualBlock
    ? visualBlock
    : licensedRuntimeAsset
      ? activeLicensedStatus
        ? {
            mode: activeLicensedStatus.mode,
            detail: activeLicensedStatus.detail,
            reason: activeLicensedStatus.reason,
          }
        : {
            mode: "loading",
            detail: `正在加载 ${licensedRuntimeAsset.format} 已许可运行时桥接。`,
            reason: "loading",
          }
      : isPortraitRuntime
        ? portraitStatusMatches
          ? portraitAssetStatus
          : {
              mode: "loading",
              detail: `Loading ${portraitDisplayName} portrait.`,
              reason: "loading",
            }
      : isSpriteRuntime
        ? spriteStatusMatches
          ? spriteAssetStatus
          : {
              mode: "loading",
              detail: `正在加载 ${spriteDisplayName} 2D 动态角色。`,
              reason: "loading",
            }
      : isUnsupportedRuntime
        ? status
      : builtinRuntimeReady && !runtimeRecipe.vrmAssetUrl
        ? {
            mode: "ready",
            detail: "当前角色的内置形象已就绪。",
            reason: "ready",
          }
        : status;
  const showVisualBlock = Boolean(visualBlock);
  const awaitingRuntimePreference = !showVisualBlock
    && !motionPreferenceReady
    && Boolean(licensedRuntimeAsset || runtimeRecipe.vrmAssetUrl);
  const showLicensedRuntime = !showVisualBlock
    && motionPreferenceReady
    && Boolean(licensedRuntimeAsset);
  const showSprite = !showVisualBlock
    && !showLicensedRuntime
    && isSpriteRuntime
    && spriteStatusMatches
    && spriteAssetStatus.mode === "ready";
  const mountPortrait = !showVisualBlock
    && !showLicensedRuntime
    && isPortraitRuntime
    && portraitStatusMatches
    && portraitAssetStatus.mode !== "error";
  const show3dRuntime = !showVisualBlock && !showLicensedRuntime
    && !isPortraitRuntime
    && !isSpriteRuntime
    && !isUnsupportedRuntime
    && motionPreferenceReady
    && Boolean(runtimeRecipe.vrmAssetUrl)
    && webglAvailable === true
    && runtimeStatus.mode !== "fallback";
  const runtimeKind = visualBlock?.kind
    ?? licensedRuntimeAsset?.format
    ?? (isPortraitRuntime ? "portrait_2d" : isSpriteRuntime ? "sprite_2d" : isUnsupportedRuntime ? "unsupported" : show3dRuntime ? "vrm" : builtinRuntimeReady ? "builtin" : "fallback");
  const isRuntimeInteractive = runtimeStatus.mode === "ready"
    || (!isPortraitRuntime && runtimeStatus.mode === "fallback");

  useEffect(() => {
    if (!show3dRuntime) {
      onCapabilitiesChange?.(null);
    }
  }, [onCapabilitiesChange, show3dRuntime]);

  useEffect(() => {
    onRuntimeModeChange?.(runtimeStatus.mode);
  }, [onRuntimeModeChange, runtimeStatus.mode]);

  const handleStageFailure = useCallback((error: Error) => {
    onCapabilitiesChange?.(null);
    setStatus({
      mode: "fallback",
      detail: error.message || "VRM 加载失败，已回退到 2D 立绘模式。",
      missing: detectMissingDependencies(error),
    });
  }, [onCapabilitiesChange]);

  const handleStageReady = useCallback((detail: string) => {
    setStatus({
      mode: "ready",
      detail,
    });
  }, []);

  const handleStageStatusChange = useCallback((detail: string) => {
    setStatus((current) => ({
      mode: current.mode === "fallback" ? "fallback" : "loading",
      detail,
      missing: current.missing,
    }));
  }, []);

  const handleLicensedStatusChange = useCallback((nextStatus: LicensedRuntimeStatus) => {
    setLicensedStatus(nextStatus);
  }, []);

  useEffect(() => {
    updateGazeInput(false);
    const resetOnWindowBlur = () => updateGazeInput(false);
    window.addEventListener("blur", resetOnWindowBlur);
    return () => window.removeEventListener("blur", resetOnWindowBlur);
  }, [updateGazeInput]);

  useEffect(() => () => {
    if (gestureTimerRef.current) {
      clearTimeout(gestureTimerRef.current);
    }
  }, []);
  const handleMotionStatusChange = useCallback((nextStatus: AvatarMotionStatus) => {
    setMotionStatus(nextStatus);
  }, []);

  const activateGesture = useCallback(() => {
    if (!isRuntimeInteractive) {
      return;
    }
    setGestureSequence((current) => current + 1);
    setGestureActive(true);
    if (gestureTimerRef.current) {
      clearTimeout(gestureTimerRef.current);
    }
    gestureTimerRef.current = setTimeout(() => {
      setGestureActive(false);
      gestureTimerRef.current = null;
    }, spriteDefinition?.gesture.durationMs ?? 700);
  }, [isRuntimeInteractive, spriteDefinition]);

  useEffect(() => {
    if (!isRuntimeInteractive || !reactionKey || reactionKey === lastReactionKeyRef.current) {
      return;
    }
    lastReactionKeyRef.current = reactionKey;
    activateGesture();
  }, [activateGesture, isRuntimeInteractive, reactionKey]);

  const handleGestureKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    if (event.key === " ") {
      event.preventDefault();
    }
    if (!event.repeat) {
      activateGesture();
    }
  }, [activateGesture]);

  const spriteExpression = spriteDefinition?.emotionReactions[emotion] ?? "calm";
  const spriteRow = spriteDefinition
    ? gestureActive
      ? spriteDefinition.gesture.row
      : spriteDirection !== null
        ? spriteDefinition.gaze.rows[Math.floor(spriteDirection / spriteDefinition.gaze.framesPerRow)]
        : spriteDefinition.stateRows[state]
    : 0;
  const spriteFrameCount = spriteDefinition
    ? gestureActive
      ? spriteDefinition.gesture.frameCount
      : spriteDefinition.stateFrameCounts[state]
    : 1;
  const spriteIsGazing = !gestureActive && spriteDirection !== null;
  const activeSpriteFrame = spriteIsGazing
    ? spriteDirection % (spriteDefinition?.gaze.framesPerRow ?? 1)
    : spriteFrame;

  useEffect(() => {
    setSpriteFrame(0);
    if (!showSprite || reducedMotion || spriteIsGazing || !spriteDefinition) {
      return;
    }
    const timer = window.setInterval(() => {
      setSpriteFrame((current) => (current + 1) % spriteFrameCount);
    }, spriteDefinition.frameIntervalMs);
    return () => window.clearInterval(timer);
  }, [reducedMotion, showSprite, spriteDefinition, spriteFrameCount, spriteIsGazing, spriteRow]);

  return (
    <div className={`${styles.runtimeCard} ${compact ? styles.compact : ""}`}>
      {!compact ? (
        <div className={styles.runtimeTopline}>
          <div>
            <p className="eyebrow">Avatar Runtime</p>
            <strong>
              {licensedRuntimeAsset
                ? `${licensedRuntimeAsset.format} Licensed Runtime`
                : isPortraitRuntime
                  ? `${portraitDisplayName} 2D Portrait Runtime`
                : isSpriteRuntime
                  ? `${spriteDisplayName} 2D Sprite Runtime`
                : runtimeStatus.mode === "ready"
                  ? "WebGL / VRM Runtime"
                  : "2D Fallback / Loader"}
            </strong>
          </div>
          <span className={styles.stateBadge} data-state={state}>
            {stateLabel(state)}
          </span>
        </div>
      ) : null}

      <div
        ref={viewportRef}
        aria-disabled={!isRuntimeInteractive}
        aria-label="让角色回应"
        className={styles.runtimeViewport}
        data-avatar-gesture-offset={gestureActive && !reducedMotion ? "5.000" : "0.000"}
        data-avatar-gesture-progress={gestureActive ? "0.500" : "0.000"}
        data-avatar-gesture-sequence={gestureSequence}
        data-avatar-gesture-state={gestureActive ? "active" : "idle"}
        data-avatar-reaction-key={reactionKey ?? "none"}
        data-avatar-reaction-sequence={gestureSequence}
        data-avatar-reaction-state={reducedMotion && gestureActive ? "reduced" : gestureActive ? "active" : "idle"}
        data-avatar-reduced-motion={reducedMotion}
        data-avatar-state={state}
        data-avatar-emotion={emotion}
        data-avatar-state-mapped="true"
        data-avatar-framing={runtimeRecipe.avatarFraming}
        data-avatar-stage-background={runtimeRecipe.stageBackground}
        data-avatar-motion-mode={isPortraitRuntime ? "portrait" : isSpriteRuntime ? "sprite" : motionStatus.mode}
        data-avatar-motion-state={isPortraitRuntime || isSpriteRuntime ? state : motionStatus.state}
        data-avatar-runtime-kind={runtimeKind}
        data-runtime-kind={runtimeKind}
        data-ready={runtimeStatus.mode === "ready"}
        data-runtime-mode={runtimeStatus.mode}
        data-runtime-detail={runtimeStatus.detail}
        data-runtime-reason={runtimeStatus.reason ?? runtimeStatus.detail}
        data-avatar-sprite-row={showSprite ? spriteRow : undefined}
        data-avatar-sprite-frame={showSprite ? activeSpriteFrame : undefined}
        data-avatar-sprite-direction={showSprite ? spriteDirection ?? "none" : undefined}
        data-avatar-sprite-expression={showSprite && spriteDirection === null && !gestureActive ? spriteExpression : undefined}
        data-runtime-instance={activeLicensedStatus?.instance ?? (isPortraitRuntime || isSpriteRuntime || isUnsupportedRuntime ? runtimeRecipe.modelId : show3dRuntime ? "vrm" : "none")}
        data-runtime-canvas-count={activeLicensedStatus?.canvasCount ?? (show3dRuntime ? 1 : 0)}
        onClick={activateGesture}
        onBlur={() => updateGazeInput(false)}
        onKeyDown={handleGestureKeyDown}
        onPointerCancel={handlePointerReset}
        onPointerDown={handlePointerInput}
        onPointerLeave={handlePointerReset}
        onPointerMove={handlePointerInput}
        onPointerUp={handlePointerUp}
        role="button"
        tabIndex={isRuntimeInteractive ? 0 : -1}
      >
        {showVisualBlock && visualBlock ? (
          <div
            className={styles.loadingOverlay}
            role={visualBlock.mode === "blocked" ? "alert" : "status"}
          >
            <div className={styles.loadingCard}>
              {visualBlock.mode === "loading" ? <div className={styles.loadingPulse} /> : null}
              <strong>{visualBlock.mode === "loading" ? "正在加载角色形象" : "角色形象不可用"}</strong>
              <p>{visualBlock.detail}</p>
            </div>
          </div>
        ) : awaitingRuntimePreference ? (
          <div className={styles.loadingOverlay} role="status">
            <div className={styles.loadingCard}>
              <div className={styles.loadingPulse} />
              <p>正在读取系统的低动态偏好。</p>
            </div>
          </div>
        ) : showLicensedRuntime && licensedRuntimeAsset ? (
          <>
            <LicensedRuntimeStage
              asset={licensedRuntimeAsset}
              emotion={emotion}
              onStatusChange={handleLicensedStatusChange}
              reducedMotion={reducedMotion}
              speechController={speechController}
              state={state}
            />
            {runtimeStatus.mode === "loading" ? (
              <div className={styles.loadingOverlay}>
                <div className={styles.loadingCard}>
                  <div className={styles.loadingPulse} />
                  <p>{runtimeStatus.detail}</p>
                </div>
              </div>
            ) : null}
            {runtimeStatus.mode === "blocked" || runtimeStatus.mode === "error" ? (
              <div className={styles.loadingOverlay} role="alert">
                <div className={styles.loadingCard}>
                  <strong>{licensedRuntimeAsset.format} 形象渲染不可用</strong>
                  <p>{runtimeStatus.detail}</p>
                </div>
              </div>
            ) : null}
          </>
        ) : isPortraitRuntime ? (
          <>
            {mountPortrait && portraitDefinition ? (
              <div
                aria-label={`${portraitDisplayName} 2D character portrait`}
                className={styles.portraitStage}
                data-avatar-emotion={emotion}
                data-avatar-state={state}
                data-emotion={emotion}
                data-expression={emotion}
                data-gesture={gestureActive ? "active" : "idle"}
                data-gesture-active={gestureActive}
                data-model-id={portraitDefinition.modelId}
                data-state={state}
                key={`portrait-${portraitDefinition.modelId}-${gestureSequence}`}
                style={
                  {
                    ["--portrait-accent" as string]: portraitDefinition.accentColor,
                    ["--portrait-object-position" as string]: portraitDefinition.objectPosition,
                  } as CSSProperties
                }
              >
                <NextImage
                  alt={portraitDefinition.alt}
                  className={styles.portraitImage}
                  data-testid="companion-portrait"
                  fill
                  priority={false}
                  sizes={compact ? "(max-width: 640px) 100vw, 384px" : "(max-width: 640px) 88vw, 384px"}
                  src={portraitDefinition.assetUrl}
                  unoptimized
                  onError={() => {
                    const assetUrl = portraitDefinition.assetUrl;
                    setPortraitAssetStatus((current) => current.assetUrl === assetUrl
                      ? {
                          assetUrl,
                          mode: "error",
                          detail: `${portraitDisplayName} portrait could not be rendered.`,
                          reason: "portrait_render_failed",
                        }
                      : current);
                  }}
                  onLoad={(event) => {
                    if (event.currentTarget.naturalWidth <= 0 || event.currentTarget.naturalHeight <= 0) {
                      return;
                    }
                    const assetUrl = portraitDefinition.assetUrl;
                    setPortraitAssetStatus((current) => current.assetUrl === assetUrl
                      ? {
                          assetUrl,
                          mode: "ready",
                          detail: `${portraitDisplayName} portrait is ready.`,
                          reason: "ready",
                        }
                      : current);
                  }}
                />
                <span
                  aria-hidden="true"
                  className={styles.portraitStateCue}
                  data-testid="portrait-state-cue"
                />
              </div>
            ) : null}
            {runtimeStatus.mode === "loading" || runtimeStatus.mode === "error" ? (
              <div
                className={styles.loadingOverlay}
                role={runtimeStatus.mode === "error" ? "alert" : "status"}
              >
                <div className={styles.loadingCard}>
                  {runtimeStatus.mode === "loading" ? <div className={styles.loadingPulse} /> : null}
                  <p>{runtimeStatus.detail}</p>
                </div>
              </div>
            ) : null}
          </>
        ) : isSpriteRuntime ? (
          <>
            {showSprite && spriteDefinition ? (
              <div
                className={styles.spriteStage}
                aria-label={`${spriteDisplayName} 2D character`}
                data-expression={spriteExpression}
              >
                <div
                  className={styles.sprite}
                  data-testid={`${runtimeRecipe.modelId.replace(/_2d$/, "")}-sprite`}
                  data-row={spriteRow}
                  data-frame={activeSpriteFrame}
                  data-frame-count={spriteIsGazing ? 1 : spriteFrameCount}
                  data-direction={spriteDirection ?? "none"}
                  data-expression={spriteDirection === null && !gestureActive ? spriteExpression : undefined}
                  style={
                    {
                      ["--sprite-cell-height" as string]: `${spriteDefinition.atlas.cellHeight}px`,
                      ["--sprite-cell-width" as string]: `${spriteDefinition.atlas.cellWidth}px`,
                      ["--sprite-frame" as string]: activeSpriteFrame,
                      ["--sprite-row" as string]: spriteRow,
                      ["--sprite-sheet-height" as string]: `${spriteDefinition.atlas.rows * spriteDefinition.atlas.cellHeight}px`,
                      ["--sprite-sheet-width" as string]: `${spriteDefinition.atlas.columns * spriteDefinition.atlas.cellWidth}px`,
                      backgroundImage: `url(${runtimeRecipe.spriteAssetUrl})`,
                    } as CSSProperties
                  }
                />
                {!spriteIsGazing && !gestureActive ? (
                  <span className={styles.spriteExpressionCue} data-expression={spriteExpression}>
                    {expressionLabel(emotion)}
                  </span>
                ) : null}
              </div>
            ) : null}
            {runtimeStatus.mode === "loading" || runtimeStatus.mode === "error" ? (
              <div
                className={styles.loadingOverlay}
                role={runtimeStatus.mode === "error" ? "alert" : "status"}
              >
                <div className={styles.loadingCard}>
                  {runtimeStatus.mode === "loading" ? <div className={styles.loadingPulse} /> : null}
                  <p>{runtimeStatus.detail}</p>
                </div>
              </div>
            ) : null}
          </>
        ) : show3dRuntime ? (
          <>
            <LazyVrmStage
              emotion={emotion}
              gazeInputRef={gazeInputRef}
              gestureSequence={gestureSequence}
              reactionKey={reactionKey}
              onCapabilitiesChange={onCapabilitiesChange}
              recipe={recipe}
              motionAssetUrls={effectiveMotionUrls}
              sessionId={sessionId}
              state={state}
              reducedMotion={reducedMotion}
              speechController={speechController}
              onFailure={handleStageFailure}
              onMotionStatusChange={handleMotionStatusChange}
              onReady={handleStageReady}
              onStatusChange={handleStageStatusChange}
            />
            {runtimeStatus.mode !== "ready" ? (
              <div className={styles.loadingOverlay}>
                <div className={styles.loadingCard}>
                  <div className={styles.loadingPulse} />
                  <p>{runtimeStatus.detail}</p>
                </div>
              </div>
            ) : null}
          </>
        ) : isUnsupportedRuntime ? (
          <div className={styles.loadingOverlay} role="alert">
            <div className={styles.loadingCard}>
              <strong>角色形象不可用</strong>
              <p>{runtimeStatus.detail}</p>
            </div>
          </div>
        ) : (
          <div
            key={`fallback-${gestureSequence}`}
            className={styles.fallbackPortrait}
            data-testid="avatar-fallback"
            style={
              {
                ["--avatar-accent" as string]: runtimeRecipe.accentColor,
                ["--avatar-hair" as string]: runtimeRecipe.hairColor,
                ["--avatar-skin" as string]: runtimeRecipe.skinTone,
                ["--avatar-eye" as string]: runtimeRecipe.eyeColor,
                ["--avatar-outfit" as string]: runtimeRecipe.outfitColor,
              } as CSSProperties
            }
          >
            <div className={styles.fallbackHalo} />
            <div className={styles.fallbackHair} />
            <div className={styles.fallbackFace}>
              <span />
              <span />
            </div>
            <div className={styles.fallbackBody} />
          </div>
        )}
      </div>

      {!compact ? (
        <>
          <p className={styles.runtimeMeta}>{runtimeStatus.detail}</p>
          <p className={styles.runtimeHint} data-avatar-motion-detail>
            {motionStatus.detail}
          </p>
          {prefersReducedMotion ? (
            <p className={styles.runtimeHint}>已遵循系统“减少动态效果”偏好：身体与视线动作已停用，仅保留低频眨眼和语音口型。</p>
          ) : null}
          {status.missing?.length ? (
            <p className={styles.runtimeHint}>缺失依赖: {status.missing.join(", ")}。安装后这里会直接加载真实 VRM 角色。</p>
          ) : null}
          {licensedRuntimeAsset ? (
            <p className={styles.runtimeHint}>
              本地 {licensedRuntimeAsset.format} 归档已导入；渲染仅通过同源的已许可桥接执行。
            </p>
          ) : isPortraitRuntime ? (
            <p className={styles.runtimeHint}>2D portrait: {runtimeRecipe.portraitAssetUrl}</p>
          ) : isSpriteRuntime ? (
            <p className={styles.runtimeHint}>2D sprite: {runtimeRecipe.spriteAssetUrl}</p>
          ) : runtimeRecipe.vrmAssetUrl ? (
            <p className={styles.runtimeHint}>VRM 资产入口: {runtimeRecipe.vrmAssetUrl}</p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
