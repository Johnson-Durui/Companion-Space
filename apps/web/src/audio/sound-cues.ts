export type SoundCueName =
  | "connect"
  | "your_turn"
  | "rec_start"
  | "rec_end"
  | "correct"
  | "retry"
  | "lesson_end";

export interface SoundCuePrefs {
  enabled: boolean;
  volume: number;
}

const ENABLED_KEY = "cs:sound-cues:enabled";
const VOLUME_KEY = "cs:sound-cues:volume";
const DEFAULT_VOLUME = 0.25;
const MAX_GAIN = 0.16;
export const SOUND_CUE_DEDUP_MS = 40;

type ToneStep = { freq: number; duration: number; delay?: number; type?: OscillatorType; gainScale?: number };

// All synthesized cues are < 300ms, 600 Hz - 2 kHz, gentle volume (design-system §9).
const CUE_RECIPES: Record<SoundCueName, readonly ToneStep[]> = {
  connect: [
    { freq: 660, duration: 0.09, delay: 0, type: "sine", gainScale: 0.85 },
    { freq: 990, duration: 0.13, delay: 0.08, type: "sine", gainScale: 0.9 },
  ],
  your_turn: [
    { freq: 880, duration: 0.08, delay: 0, type: "sine", gainScale: 0.8 },
    { freq: 1046, duration: 0.09, delay: 0.06, type: "sine", gainScale: 0.75 },
  ],
  rec_start: [
    { freq: 740, duration: 0.05, delay: 0, type: "sine", gainScale: 0.75 },
    { freq: 988, duration: 0.05, delay: 0.04, type: "sine", gainScale: 0.7 },
  ],
  rec_end: [
    { freq: 988, duration: 0.05, delay: 0, type: "sine", gainScale: 0.7 },
    { freq: 660, duration: 0.06, delay: 0.04, type: "sine", gainScale: 0.65 },
  ],
  correct: [
    { freq: 784, duration: 0.09, delay: 0, type: "sine", gainScale: 0.9 },
    { freq: 1175, duration: 0.14, delay: 0.08, type: "sine", gainScale: 0.95 },
  ],
  retry: [
    { freq: 660, duration: 0.09, delay: 0, type: "triangle", gainScale: 0.6 },
    { freq: 622, duration: 0.1, delay: 0.08, type: "triangle", gainScale: 0.55 },
  ],
  lesson_end: [
    { freq: 1046, duration: 0.08, delay: 0, type: "sine", gainScale: 0.85 },
    { freq: 784, duration: 0.09, delay: 0.08, type: "sine", gainScale: 0.8 },
    { freq: 659, duration: 0.11, delay: 0.16, type: "sine", gainScale: 0.75 },
  ],
};

function clampVolume(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_VOLUME;
  return Math.max(0, Math.min(1, value));
}

export function readSoundCuePrefs(): SoundCuePrefs {
  try {
    const rawEnabled = window.localStorage.getItem(ENABLED_KEY);
    const rawVolume = window.localStorage.getItem(VOLUME_KEY);
    return {
      enabled: rawEnabled === null ? true : rawEnabled !== "0",
      volume: rawVolume === null ? DEFAULT_VOLUME : clampVolume(Number(rawVolume)),
    };
  } catch {
    return { enabled: true, volume: DEFAULT_VOLUME };
  }
}

export function writeSoundCuePrefs(next: Partial<SoundCuePrefs>): SoundCuePrefs {
  const current = readSoundCuePrefs();
  const merged: SoundCuePrefs = {
    enabled: next.enabled ?? current.enabled,
    volume: next.volume !== undefined ? clampVolume(next.volume) : current.volume,
  };
  try {
    window.localStorage.setItem(ENABLED_KEY, merged.enabled ? "1" : "0");
    window.localStorage.setItem(VOLUME_KEY, String(merged.volume));
  } catch {
    // Ignore storage failures
  }
  return merged;
}

export interface SoundCuePlayerOptions {
  isSuppressed?: () => boolean;
  now?: () => number;
}

export class SoundCuePlayer {
  private context: AudioContext | null = null;
  private unlocked = false;
  private lastPlayed = new Map<SoundCueName, number>();
  private readonly isSuppressed: () => boolean;
  private readonly now: () => number;
  private prefs: SoundCuePrefs;

  constructor(options: SoundCuePlayerOptions = {}) {
    this.isSuppressed = options.isSuppressed ?? (() => false);
    this.now = options.now ?? (() => Date.now());
    this.prefs = readSoundCuePrefs();
  }

  getPrefs(): SoundCuePrefs {
    return { ...this.prefs };
  }

  setPrefs(next: Partial<SoundCuePrefs>): SoundCuePrefs {
    this.prefs = writeSoundCuePrefs(next);
    return { ...this.prefs };
  }

  /** Must be called inside a user gesture handler (e.g. clicking Start Lesson). */
  unlock(): void {
    this.unlocked = true;
    const ctx = this.ensureContext();
    if (ctx && ctx.state === "suspended") {
      void ctx.resume().catch(() => undefined);
    }
  }

  play(cue: SoundCueName, options?: { ignoreSuppression?: boolean }): boolean {
    if (!this.unlocked) return false;
    if (!this.prefs.enabled || this.prefs.volume <= 0) return false;
    if (!options?.ignoreSuppression && this.isSuppressed()) return false;

    const timestamp = this.now();
    const prev = this.lastPlayed.get(cue);
    if (prev !== undefined && timestamp - prev < SOUND_CUE_DEDUP_MS) {
      return false;
    }
    this.lastPlayed.set(cue, timestamp);

    const ctx = this.ensureContext();
    if (!ctx) return false;
    if (ctx.state === "suspended") {
      void ctx.resume().catch(() => undefined);
    }

    const recipe = CUE_RECIPES[cue];
    const baseGain = clampVolume(this.prefs.volume) * MAX_GAIN;
    const startAt = ctx.currentTime + 0.005;

    for (const step of recipe) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = step.type ?? "sine";
      osc.frequency.setValueAtTime(step.freq, startAt + (step.delay ?? 0));

      const t0 = startAt + (step.delay ?? 0);
      const tEnd = t0 + step.duration;
      const peak = baseGain * (step.gainScale ?? 1);

      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t0 + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, tEnd);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t0);
      osc.stop(tEnd + 0.01);
    }
    return true;
  }

  async close(): Promise<void> {
    const ctx = this.context;
    this.context = null;
    this.unlocked = false;
    if (ctx && ctx.state !== "closed") {
      await ctx.close().catch(() => undefined);
    }
  }

  private ensureContext(): AudioContext | null {
    if (typeof AudioContext === "undefined") return null;
    if (!this.context || this.context.state === "closed") {
      try {
        this.context = new AudioContext();
      } catch {
        return null;
      }
    }
    return this.context;
  }
}
