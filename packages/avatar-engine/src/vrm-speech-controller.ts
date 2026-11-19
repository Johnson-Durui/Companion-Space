import type { VisemeWeights } from "./viseme";

export type AvatarSpeechLevelListener = (level: number) => void;

export interface AvatarSpeechController {
  peek: () => number;
  peekVisemes: () => VisemeWeights | null;
  publishLevel: (level: number) => void;
  publishVisemes: (weights: VisemeWeights | null) => void;
  reset: () => void;
  subscribe: (listener: AvatarSpeechLevelListener) => () => void;
}

function clampLevel(level: number): number {
  if (!Number.isFinite(level)) {
    return 0;
  }
  return Math.max(0, Math.min(1, level));
}

export function createAvatarSpeechController(initialLevel = 0): AvatarSpeechController {
  let currentLevel = clampLevel(initialLevel);
  let currentVisemes: VisemeWeights | null = null;
  const listeners = new Set<AvatarSpeechLevelListener>();

  const emit = () => {
    for (const listener of listeners) {
      listener(currentLevel);
    }
  };

  return {
    peek: () => currentLevel,
    peekVisemes: () => currentVisemes,
    publishLevel: (level) => {
      const nextLevel = clampLevel(level);
      if (Math.abs(nextLevel - currentLevel) < 0.001) {
        return;
      }
      currentLevel = nextLevel;
      emit();
    },
    publishVisemes: (weights) => {
      currentVisemes = weights;
    },
    reset: () => {
      currentVisemes = null;
      if (currentLevel === 0) {
        return;
      }
      currentLevel = 0;
      emit();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      listener(currentLevel);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
