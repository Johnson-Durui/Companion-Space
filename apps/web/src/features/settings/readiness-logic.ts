export interface ReadinessState {
  canTeach: boolean;
  canAnalyze: boolean;
  canCheck: boolean;
  canSeeImages: boolean;
  canUseVoice: boolean;
  readyForLessons: boolean;
  missingCore: Array<"live" | "analysis">;
}

export function deriveReadiness(
  roles?: Record<string, unknown> | null,
  sttConfigured?: boolean,
): ReadinessState {
  const canTeach = Boolean(roles?.live);
  const canAnalyze = Boolean(roles?.analysis);
  const canCheck = Boolean(roles?.checker || roles?.analysis);
  const canSeeImages = Boolean(roles?.vision);
  const canUseVoice = Boolean(sttConfigured);
  const missingCore: Array<"live" | "analysis"> = [];
  if (!canTeach) missingCore.push("live");
  if (!canAnalyze) missingCore.push("analysis");
  return {
    canTeach,
    canAnalyze,
    canCheck,
    canSeeImages,
    canUseVoice,
    readyForLessons: canTeach && canAnalyze,
    missingCore,
  };
}
