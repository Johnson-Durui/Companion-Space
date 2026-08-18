export const VISEME_NAMES = ["aa", "ih", "ou", "ee", "oh"] as const;

export type VisemeName = (typeof VISEME_NAMES)[number];

export type VisemeWeights = Record<VisemeName, number>;

const CLOSED_VISEMES: VisemeWeights = {
  aa: 0,
  ih: 0,
  ou: 0,
  ee: 0,
  oh: 0,
};

const VISEME_CYCLE: readonly VisemeWeights[] = [
  { aa: 1, ih: 0.08, ou: 0, ee: 0, oh: 0.12 },
  { aa: 0.18, ih: 0.92, ou: 0, ee: 0.28, oh: 0 },
  { aa: 0.22, ih: 0, ou: 0.95, ee: 0, oh: 0.38 },
  { aa: 0.12, ih: 0.36, ou: 0, ee: 1, oh: 0 },
  { aa: 0.42, ih: 0, ou: 0.22, ee: 0, oh: 1 },
];

function clamp01(value: number) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

export function speechEnergy(speechLevel: number) {
  return clamp01(speechLevel * 4.8);
}

function lerpVisemes(left: VisemeWeights, right: VisemeWeights, amount: number): VisemeWeights {
  const t = clamp01(amount);
  return {
    aa: left.aa + (right.aa - left.aa) * t,
    ih: left.ih + (right.ih - left.ih) * t,
    ou: left.ou + (right.ou - left.ou) * t,
    ee: left.ee + (right.ee - left.ee) * t,
    oh: left.oh + (right.oh - left.oh) * t,
  };
}

function scaleVisemes(weights: VisemeWeights, energy: number): VisemeWeights {
  return {
    aa: clamp01(weights.aa * energy),
    ih: clamp01(weights.ih * energy),
    ou: clamp01(weights.ou * energy),
    ee: clamp01(weights.ee * energy),
    oh: clamp01(weights.oh * energy),
  };
}

export function dominantViseme(weights: VisemeWeights): VisemeName | "none" {
  let name: VisemeName | "none" = "none";
  let highest = 0.04;
  for (const viseme of VISEME_NAMES) {
    const value = weights[viseme];
    if (value > highest) {
      highest = value;
      name = viseme;
    }
  }
  return name;
}

export type VisemeEmotion =
  | "neutral"
  | "warm"
  | "cheerful"
  | "curious"
  | "focused"
  | "playful"
  | "concerned";

const EMOTION_MOUTH_SCALE: Record<VisemeEmotion, number> = {
  neutral: 0.96,
  warm: 1,
  cheerful: 1.08,
  curious: 1.04,
  focused: 0.86,
  playful: 1.14,
  concerned: 0.8,
};

export function nextSpeakingEnvelope(input: {
  current: number;
  speaking: boolean;
  speechLevel: number;
  deltaSeconds: number;
}): number {
  const measured = speechEnergy(input.speechLevel);
  const target = input.speaking ? Math.max(measured, 0.28) : measured * 0.12;
  const rising = target > input.current;
  const rate = input.speaking ? (rising ? 14 : 7) : 9;
  const amount = 1 - Math.exp(-rate * Math.max(0, input.deltaSeconds));
  return clamp01(input.current + (target - input.current) * amount);
}

export function visemeWeights(input: {
  elapsedSeconds: number;
  speaking: boolean;
  speechLevel: number;
  envelope?: number;
  emotion?: VisemeEmotion;
}): VisemeWeights {
  const measured = speechEnergy(input.speechLevel);
  const envelope = input.envelope ?? (input.speaking ? Math.max(measured, 0.2) : measured);
  const emotionScale = EMOTION_MOUTH_SCALE[input.emotion ?? "neutral"];
  const energy = clamp01(envelope * emotionScale);
  if (energy <= 0.01) {
    return CLOSED_VISEMES;
  }

  const phase = Math.max(0, input.elapsedSeconds) * 9.4;
  const index = Math.floor(phase) % VISEME_CYCLE.length;
  const nextIndex = (index + 1) % VISEME_CYCLE.length;
  const blended = lerpVisemes(
    VISEME_CYCLE[index] ?? CLOSED_VISEMES,
    VISEME_CYCLE[nextIndex] ?? CLOSED_VISEMES,
    phase - Math.floor(phase),
  );
  const flutter = 0.78 + 0.22 * (0.5 + 0.5 * Math.sin(input.elapsedSeconds * 21.3));
  return scaleVisemes(blended, energy * flutter);
}
