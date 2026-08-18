import type { CompanionEmotion } from "@/lib/types";

export interface EmotionVoiceTuning {
  pitch: number;
  rate: number;
}

// Small, deliberately restrained offsets: the selected speaker remains unchanged.
export const EMOTION_VOICE_TUNING: Record<CompanionEmotion, EmotionVoiceTuning> = {
  neutral: { pitch: 0, rate: 0 },
  warm: { pitch: 0.04, rate: -0.03 },
  cheerful: { pitch: 0.1, rate: 0.04 },
  curious: { pitch: 0.08, rate: 0.02 },
  focused: { pitch: -0.04, rate: -0.02 },
  playful: { pitch: 0.14, rate: 0.06 },
  concerned: { pitch: -0.08, rate: -0.06 },
};

export function tuneBuiltInVoice(
  profile: { pitch: number; rate: number },
  emotion: CompanionEmotion,
): EmotionVoiceTuning {
  const tuning = EMOTION_VOICE_TUNING[emotion];
  return {
    pitch: Math.max(0.5, Math.min(2, profile.pitch + tuning.pitch)),
    rate: Math.max(0.5, Math.min(2, profile.rate + tuning.rate)),
  };
}
