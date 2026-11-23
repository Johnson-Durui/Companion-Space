import { useEffect, useMemo, useState, type Ref } from "react";
import type { Situation, TutorEmotion, TutorPose } from "@companion-space/avatar-engine/types";
import { TutorVideoBox, type TutorVideoBoxHandle } from "@companion-space/avatar-engine/video-box";
import type { Character } from "../../app/api";
import t from "../../locales/zh-CN.json";
import { toVideoAvatarConfig, videoBoxLabels } from "./video-config";
import { createSidecarConnector } from "./sidecar-connector";
import "@companion-space/avatar-engine/video-box.css";

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return reduced;
}

export function TeacherPreview({
  character,
  pose = "idle_companion",
  situation,
  emotion = "warm",
  gen = 1,
  disableIdleScheduler = true,
  videoRef,
}: {
  character: Character;
  pose?: TutorPose;
  situation?: Situation;
  emotion?: TutorEmotion;
  gen?: number;
  disableIdleScheduler?: boolean;
  videoRef?: Ref<TutorVideoBoxHandle>;
}) {
  const reducedMotion = usePrefersReducedMotion();
  const config = useMemo(
    () => toVideoAvatarConfig(character, reducedMotion, { disableIdleScheduler }),
    [character, reducedMotion, disableIdleScheduler],
  );
  const labels = useMemo(() => videoBoxLabels(), []);
  const sidecarConnector = useMemo(() => createSidecarConnector(), []);
  return (
    <TutorVideoBox
      ref={videoRef}
      config={config}
      pose={pose}
      situation={situation}
      emotion={emotion}
      gen={gen}
      statusLabel={t.classroom.waiting}
      showOverlay={false}
      compact
      labels={labels}
      sidecarConnector={sidecarConnector}
    />
  );
}
