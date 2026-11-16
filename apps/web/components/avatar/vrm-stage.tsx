"use client";

import {
  VrmStage as AvatarEngineVrmStage,
  type VrmStageProps as AvatarEngineVrmStageProps,
} from "@companion-space/avatar-engine/vrm-stage";

import styles from "@/components/avatar/avatar-runtime.module.css";
import { postLocalMetricSignalSafe } from "@/lib/api";

export type {
  AvatarExpressionCapability,
  AvatarExpressionCapabilityStatus,
  AvatarGazeInput,
  AvatarMetricSignal,
  AvatarRuntimeCapabilities,
} from "@companion-space/avatar-engine/vrm-stage";

export type VrmStageProps = Omit<
  AvatarEngineVrmStageProps,
  "className" | "onMetricSignal"
>;

export function VrmStage(props: VrmStageProps) {
  return (
    <AvatarEngineVrmStage
      {...props}
      className={styles.runtimeStage}
      onMetricSignal={postLocalMetricSignalSafe}
    />
  );
}
