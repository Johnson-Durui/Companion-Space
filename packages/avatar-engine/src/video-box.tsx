import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from "react";
import { VideoDriverManager } from "./driver-manager";
import type {
  DecodedSpeechChunk,
  InstantAction,
  LessonPhase,
  SidecarSessionConnector,
  TutorEmotion,
  TutorPose,
  VideoAvatarRuntimeConfig,
  VideoAvatarTier,
  VideoDriverCostEvent,
  VideoDriverDegradedCode,
  VideoDriverStatusEvent,
} from "./types";

export interface TutorVideoBoxLabels {
  tiers: Record<VideoAvatarTier, string>;
  toggleCaption: string;
  switchToFree: string;
  degradedPrefix: string;
  degradedReasons?: Partial<Record<VideoDriverDegradedCode, string>>;
  degradedFallback?: string;
  dismissNotice: string;
}

export interface TutorVideoBoxHandle {
  pushSpeechLevel: (level: number) => void;
  pushSpeechChunk: (chunk: DecodedSpeechChunk) => void;
  triggerInstantAction: (action: InstantAction, gen: number) => void;
  interrupt: (gen: number) => void;
  switchToFreeTier: () => Promise<void>;
}

export interface TutorVideoBoxProps {
  ref?: Ref<TutorVideoBoxHandle>;
  config: VideoAvatarRuntimeConfig;
  pose: TutorPose;
  emotion: TutorEmotion;
  gen: number;
  statusLabel: string;
  phase?: LessonPhase;
  caption?: string;
  captionVisible?: boolean;
  showSoundBars?: boolean;
  stageMode?: boolean;
  showOverlay?: boolean;
  compact?: boolean;
  cost?: VideoDriverCostEvent | null;
  labels: TutorVideoBoxLabels;
  sidecarConnector?: SidecarSessionConnector;
  onTierChange?: (tier: VideoAvatarTier) => void;
  onDegraded?: (info: { code?: VideoDriverDegradedCode; message: string }) => void;
  onQualityInfoClick?: () => void;
}

function formatDuration(totalSec: number): string {
  const sec = Math.max(0, Math.floor(totalSec));
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return `${String(min).padStart(2, "0")}:${String(rem).padStart(2, "0")}`;
}

export function TutorVideoBox({
  ref,
  config,
  pose,
  emotion,
  gen,
  statusLabel,
  phase,
  caption = "",
  captionVisible: captionVisibleProp,
  showSoundBars = false,
  stageMode = false,
  showOverlay = true,
  compact = false,
  cost = null,
  labels,
  sidecarConnector,
  onTierChange,
  onDegraded,
  onQualityInfoClick,
}: TutorVideoBoxProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const managerRef = useRef<VideoDriverManager | null>(null);
  const onTierChangeRef = useRef(onTierChange);
  onTierChangeRef.current = onTierChange;
  const onDegradedRef = useRef(onDegraded);
  onDegradedRef.current = onDegraded;
  const sidecarConnectorRef = useRef(sidecarConnector);
  sidecarConnectorRef.current = sidecarConnector;

  const [activeTier, setActiveTier] = useState<VideoAvatarTier>(config.preferredTier);
  const [notice, setNotice] = useState<string>("");
  const [localCaptionVisible, setLocalCaptionVisible] = useState(true);
  const captionVisible = captionVisibleProp ?? localCaptionVisible;

  const configKey = JSON.stringify({
    characterId: config.characterId,
    aspectRatio: config.aspectRatio,
    preferredTier: config.preferredTier,
    anchorImage: config.anchorImage,
    loopPack: config.loopPack,
    localSidecar: config.localSidecar,
    reducedMotion: config.reducedMotion,
  });

  useImperativeHandle(
    ref,
    () => ({
      pushSpeechLevel(level: number) {
        managerRef.current?.pushSpeechLevel(level);
      },
      pushSpeechChunk(chunk: DecodedSpeechChunk) {
        managerRef.current?.pushSpeechChunk(chunk);
      },
      triggerInstantAction(action: InstantAction, actionGen: number) {
        managerRef.current?.triggerInstantAction(action, actionGen);
      },
      interrupt(interruptGen: number) {
        managerRef.current?.interrupt(interruptGen);
      },
      async switchToFreeTier() {
        await managerRef.current?.switchToFreeTier();
      },
    }),
    [],
  );

  useEffect(() => {
    const container = hostRef.current;
    if (!container) return;
    setNotice("");
    const manager = new VideoDriverManager({
      sidecarConnector: sidecarConnectorRef.current,
      onStatusChange: (event: VideoDriverStatusEvent) => {
        if (event.state === "degraded") {
          const fallback = event.fallbackTier ?? "static";
          setActiveTier(fallback);
          onTierChangeRef.current?.(fallback);
          const mapped = (event.code && labels.degradedReasons?.[event.code])
            || labels.degradedFallback
            || "";
          if (mapped) {
            setNotice(mapped);
            onDegradedRef.current?.({ code: event.code, message: mapped });
          }
          return;
        }
        if (event.state === "ready" || event.state === "connecting") {
          setActiveTier(event.tier);
          onTierChangeRef.current?.(event.tier);
          if (event.code) {
            const mapped = labels.degradedReasons?.[event.code] || labels.degradedFallback || "";
            if (mapped) {
              setNotice(mapped);
              onDegradedRef.current?.({ code: event.code, message: mapped });
            }
          }
        }
      },
    });
    managerRef.current = manager;
    void manager.mount(container, config);
    return () => {
      if (managerRef.current === manager) managerRef.current = null;
      void manager.unmount();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configKey]);

  useLayoutEffect(() => {
    managerRef.current?.setMood(emotion, 1, gen);
  }, [emotion, gen]);

  useLayoutEffect(() => {
    managerRef.current?.setPose(pose, gen);
  }, [pose, gen]);

  const showFreeSwitch = !stageMode && (activeTier === "local_sidecar" || activeTier === "cloud_live");
  const isThinkingPhase = phase === "thinking" || phase === "buffering" || phase === "preparing";
  const hasVisibleCaption = captionVisible && Boolean(caption.trim());
  const isBasicDegraded = Boolean(notice) || (activeTier === "static" && config.preferredTier !== "static");

  return (
    <div
      className={`tvb-frame ${stageMode ? "tvb-stage-fill" : ""} ${compact ? "tvb-compact" : ""}`.trim()}
      data-testid="tutor-video-box"
      data-aspect={config.aspectRatio}
      data-pose={pose}
      data-emotion={emotion}
      data-tier={activeTier}
      data-phase={phase}
      data-stage-mode={stageMode ? "true" : undefined}
      data-has-caption={hasVisibleCaption ? "true" : undefined}
      role="region"
      aria-label={config.name}
    >
      <div className="tvb-media-host" ref={hostRef} />
      {showOverlay ? (
        <>
          <div className="tvb-top-bar">
            <div className="tvb-top-left">
              <span className="tvb-status-pill" data-pose={pose} data-phase={phase}>
                {showSoundBars ? (
                  <span className="tvb-bars" aria-hidden="true">
                    <i />
                    <i />
                    <i />
                    <i />
                  </span>
                ) : isThinkingPhase ? (
                  <span className="tvb-dots" aria-hidden="true">
                    <i />
                    <i />
                    <i />
                  </span>
                ) : (
                  <span className="tvb-status-dot" aria-hidden="true" />
                )}
                <span>{statusLabel}</span>
                {!stageMode ? <span className="tvb-tier-tag">{labels.tiers[activeTier]}</span> : null}
              </span>
              {stageMode && isBasicDegraded ? (
                <button
                  type="button"
                  className="tvb-quality-icon"
                  title={notice || labels.degradedFallback}
                  aria-label={notice || labels.degradedFallback || labels.tiers[activeTier]}
                  onClick={onQualityInfoClick}
                >
                  !
                </button>
              ) : null}
            </div>
            {!stageMode && (cost || showFreeSwitch) ? (
              <div className="tvb-top-actions">
                {cost ? (
                  <span className="tvb-cost-pill">
                    {formatDuration(cost.activeSec)}
                    {typeof cost.estimatedCostCny === "number" ? ` · ¥${cost.estimatedCostCny.toFixed(1)}` : ""}
                  </span>
                ) : null}
                {showFreeSwitch ? (
                  <button
                    type="button"
                    className="tvb-chip-btn"
                    onClick={() => void managerRef.current?.switchToFreeTier()}
                  >
                    {labels.switchToFree}
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>

          {!stageMode && notice ? (
            <div className="tvb-degraded-banner" role="status">
              <span>{labels.degradedPrefix} {notice}</span>
              <button type="button" className="tvb-chip-btn" onClick={() => setNotice("")}>
                {labels.dismissNotice}
              </button>
            </div>
          ) : null}

          <div className="tvb-bottom-bar">
            {stageMode ? (
              <>
                <strong className="tvb-speaker-name">{config.name}</strong>
                {captionVisible ? (
                  <p className="tvb-caption" aria-live="polite">
                    {caption || (isThinkingPhase ? "…" : "")}
                  </p>
                ) : null}
              </>
            ) : (
              <>
                {captionVisible ? (
                  <p className="tvb-caption" aria-live="polite">{caption}</p>
                ) : null}
                <div className="tvb-speaker-row">
                  <strong className="tvb-speaker-name">{config.name}</strong>
                  <button
                    type="button"
                    className="tvb-chip-btn"
                    aria-pressed={captionVisible}
                    onClick={() => setLocalCaptionVisible((value) => !value)}
                  >
                    {labels.toggleCaption}
                  </button>
                </div>
              </>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}
