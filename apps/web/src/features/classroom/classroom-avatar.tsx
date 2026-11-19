import { Component, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AvatarSpeechController } from "@companion-space/avatar-engine/speech-controller";
import type { AvatarGazeInput } from "@companion-space/avatar-engine/vrm-stage";
import type { CharacterPreviewState, CompanionEmotion } from "@companion-space/avatar-engine/runtime-types";

type Appearance = { kind: "portrait" | "vrm"; src: string };

export type ClassroomAvatarProps = {
  appearance?: Appearance;
  emotion: CompanionEmotion;
  gaze: AvatarGazeInput;
  gestureSequence: number;
  name: string;
  reactionKey: string | null;
  speechController: AvatarSpeechController;
  state: CharacterPreviewState;
};

function canRenderVrm() {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2") || canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

function useReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return reduced;
}

function PortraitFallback({ appearance, emotion, name, state }: Pick<ClassroomAvatarProps, "appearance" | "emotion" | "name" | "state">) {
  return <div className="lesson-avatar-fallback" data-emotion={emotion} data-state={state} role="img" aria-label={name}>
    <span className="lesson-avatar-halo" />
    {appearance?.kind === "portrait" ? <img alt="" src={appearance.src} /> : <span className="lesson-avatar-initial">{name.slice(0, 1)}</span>}
    <span className="lesson-avatar-light" />
  </div>;
}

function snapshotKey(src: string) {
  return `companion-space:avatar-snapshot:${src}`;
}

function readSnapshot(src?: string) {
  if (!src) return undefined;
  try {
    return localStorage.getItem(snapshotKey(src)) ?? undefined;
  } catch {
    return undefined;
  }
}

class AvatarBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

const ignore = () => undefined;
const VrmStage = lazy(() => import("@companion-space/avatar-engine/vrm-stage").then((module) => ({ default: module.VrmStage })));

export default function ClassroomAvatar(props: ClassroomAvatarProps) {
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const reducedMotion = useReducedMotion();
  const appearance = props.appearance;
  const [snapshot, setSnapshot] = useState(() => ({
    source: appearance?.kind === "vrm" ? appearance.src : undefined,
    value: readSnapshot(appearance?.kind === "vrm" ? appearance.src : undefined),
  }));
  const vrmAvailable = useMemo(() => appearance?.kind === "vrm" && canRenderVrm(), [appearance]);
  const gazeInputRef = useRef(props.gaze);
  useEffect(() => { gazeInputRef.current = props.gaze; }, [props.gaze]);
  const handleFailure = useCallback(() => setFailed(true), []);
  const handleReady = useCallback(() => setReady(true), []);
  const handleSnapshot = useCallback((dataUrl: string) => {
    if (!appearance || appearance.kind !== "vrm") return;
    setSnapshot({ source: appearance.src, value: dataUrl });
    try {
      localStorage.setItem(snapshotKey(appearance.src), dataUrl);
    } catch {
      // Keep the in-memory fallback when storage is unavailable or full.
    }
  }, [appearance]);
  const cachedSnapshot = appearance?.kind === "vrm" && snapshot.source === appearance.src
    ? snapshot.value
    : readSnapshot(appearance?.kind === "vrm" ? appearance.src : undefined);
  const fallbackAppearance: Appearance | undefined = cachedSnapshot
    ? { kind: "portrait", src: cachedSnapshot }
    : props.appearance;
  const fallback = <PortraitFallback appearance={fallbackAppearance} emotion={props.emotion} name={props.name} state={props.state} />;
  if (!vrmAvailable || !appearance || appearance.kind !== "vrm" || failed) return fallback;

  return <div className="lesson-avatar-canvas" aria-busy={!ready}><AvatarBoundary fallback={fallback}>
    <Suspense fallback={fallback}><VrmStage
      className="lesson-avatar-canvas"
      emotion={props.emotion}
      gazeInputRef={gazeInputRef}
      gestureSequence={props.gestureSequence}
      onFailure={handleFailure}
      onMotionStatusChange={ignore}
      onReady={handleReady}
      onSnapshot={handleSnapshot}
      onStatusChange={ignore}
      reactionKey={props.reactionKey}
      recipe={{
        name: props.name,
        vrm_asset_url: appearance.src,
        avatar_framing: "portrait",
        stage_background: "neutral",
      }}
      reducedMotion={reducedMotion}
      speechController={props.speechController}
      state={props.state}
    /></Suspense>
  </AvatarBoundary></div>;
}
