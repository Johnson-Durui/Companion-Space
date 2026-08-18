export type AvatarSpeechLevelListener = (level: number) => void;

export interface AvatarSpeechController {
  peek: () => number;
  publishLevel: (level: number) => void;
  reset: () => void;
  subscribe: (listener: AvatarSpeechLevelListener) => () => void;
}

function clampLevel(level: number) {
  if (!Number.isFinite(level)) {
    return 0;
  }
  return Math.max(0, Math.min(1, level));
}

export function createAvatarSpeechController(initialLevel = 0): AvatarSpeechController {
  let currentLevel = clampLevel(initialLevel);
  const listeners = new Set<AvatarSpeechLevelListener>();

  const emit = () => {
    for (const listener of listeners) {
      listener(currentLevel);
    }
  };

  return {
    peek: () => currentLevel,
    publishLevel: (level) => {
      const nextLevel = clampLevel(level);
      if (Math.abs(nextLevel - currentLevel) < 0.001) {
        return;
      }
      currentLevel = nextLevel;
      emit();
    },
    reset: () => {
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
