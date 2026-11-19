import { useMemo, type Ref } from "react";
import type { TutorEmotion, TutorPose } from "@companion-space/avatar-engine/types";
import { TutorVideoBox, type TutorVideoBoxHandle } from "@companion-space/avatar-engine/video-box";
import type { Character } from "../../app/api";
import t from "../../locales/zh-CN.json";
import { toVideoAvatarConfig, videoBoxLabels } from "./video-config";
import { createSidecarConnector } from "./sidecar-connector";
import "../classroom/classroom.css";

export function TeacherPreview({
  character,
  pose = "idle_companion",
  emotion = "warm",
  gen = 1,
  videoRef,
}: {
  character: Character;
  pose?: TutorPose;
  emotion?: TutorEmotion;
  gen?: number;
  videoRef?: Ref<TutorVideoBoxHandle>;
}) {
  const config = useMemo(() => toVideoAvatarConfig(character), [character]);
  const labels = useMemo(() => videoBoxLabels(), []);
  const sidecarConnector = useMemo(() => createSidecarConnector(), []);
  return (
    <TutorVideoBox
      ref={videoRef}
      config={config}
      pose={pose}
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
