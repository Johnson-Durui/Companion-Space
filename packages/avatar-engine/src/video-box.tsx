import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { VideoDriverManager } from "./driver-manager";
import type {
  DecodedSpeechChunk,
  InstantAction,
  SidecarSessionConnector,
  TutorEmotion,
  TutorPose,
  VideoAvatarRuntimeConfig,
  VideoAvatarTier,
  VideoDriverCostEvent,
  VideoDriverStatusEvent,
} from "./types";

export interface TutorVideoBoxLabels {
  tiers: Record<VideoAvatarTier, string>;
  toggleCaption: string;
  switchToFree: string;
  degradedPrefix: string;
  dismissNotice: string;
}

export interface TutorVideoBoxHandle {
  pushSpeechLevel: (level: number) => void;
  pushSpeechChunk: (chunk: DecodedSpeechChunk) => void;
  triggerInstantAction: (action: InstantAction, gen: number) => void;
  interrupt: (gen: number) => void;
}

export interface TutorVideoBoxProps {
  ref?: Ref<TutorVideoBoxHandle>;
  config: VideoAvatarRuntimeConfig;
  pose: TutorPose;
  emotion: TutorEmotion;
  gen: number;
  statusLabel: string;
  caption?: string;
  showOverlay?: boolean;
  compact?: boolean;
  cost?: VideoDriverCostEvent | null;
  labels: TutorVideoBoxLabels;
  sidecarConnector?: SidecarSessionConnector;
  onTierChange?: (tier: VideoAvatarTier) => void;
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
  caption = "",
  showOverlay = true,
  compact = false,
  cost = null,
  labels,
  sidecarConnector,
  onTierChange,
}: TutorVideoBoxProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const managerRef = useRef<VideoDriverManager | null>(null);
  const onTierChangeRef = useRef(onTierChange);
  onTierChangeRef.current = onTierChange;
  const sidecarConnectorRef = useRef(sidecarConnector);
  sidecarConnectorRef.current = sidecarConnector;

  const [activeTier, setActiveTier] = useState<VideoAvatarTier>(config.preferredTier);
  const [notice, setNotice] = useState<string>("");
  const [captionVisible, setCaptionVisible] = useState(true);

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
          if (event.reason) setNotice(event.reason);
          return;
        }
        if (event.state === "ready" || event.state === "connecting") {
          setActiveTier(event.tier);
          onTierChangeRef.current?.(event.tier);
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

  useEffect(() => {
    managerRef.current?.setMood(emotion, 1, gen);
  }, [emotion, gen]);

  useEffect(() => {
    managerRef.current?.setPose(pose, gen);
  }, [pose, gen]);

  const showFreeSwitch = activeTier === "local_sidecar" || activeTier === "cloud_live";

  return (
    <div
      className={`tvb-frame ${compact ? "tvb-compact" : ""}`}
      data-aspect={config.aspectRatio}
      data-pose={pose}
      data-emotion={emotion}
      data-tier={activeTier}
      role="region"
      aria-label={config.name}
    >
      <div className="tvb-media-host" ref={hostRef} />
      {showOverlay ? (
        <>
          <div className="tvb-top-bar">
            <span className="tvb-status-pill" data-pose={pose}>
              <span className="tvb-status-dot" aria-hidden="true" />
              <span>{statusLabel}</span>
              <span className="tvb-tier-tag">{labels.tiers[activeTier]}</span>
            </span>
            {cost || showFreeSwitch ? (
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

          {notice ? (
            <div className="tvb-degraded-banner" role="status">
              <span>{labels.degradedPrefix} {notice}</span>
              <button type="button" className="tvb-chip-btn" onClick={() => setNotice("")}>
                {labels.dismissNotice}
              </button>
            </div>
          ) : null}

          <div className="tvb-bottom-bar">
            {captionVisible ? (
              <p className="tvb-caption" aria-live="polite">{caption}</p>
            ) : null}
            <div className="tvb-speaker-row">
              <strong className="tvb-speaker-name">{config.name}</strong>
              <button
                type="button"
                className="tvb-chip-btn"
                aria-pressed={captionVisible}
                onClick={() => setCaptionVisible((value) => !value)}
              >
                {labels.toggleCaption}
              </button>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
