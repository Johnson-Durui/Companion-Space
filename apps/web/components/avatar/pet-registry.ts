import type {
  CharacterPreviewState,
  CompanionEmotion,
} from "@/lib/types";

export interface BuiltinPetDefinition {
  assetUrl: string;
  atlas: {
    cellHeight: number;
    cellWidth: number;
    columns: number;
    rows: number;
  };
  displayName: string;
  emotionReactions: Record<CompanionEmotion, "calm" | "soft" | "wave" | "lift" | "attentive" | "bounce" | "failed">;
  frameIntervalMs: number;
  gaze: {
    clockwise: true;
    directions: 16;
    framesPerRow: 8;
    rows: readonly [number, number];
    zeroDirection: "up";
  };
  gesture: {
    durationMs: number;
    frameCount: number;
    row: number;
  };
  modelId: string;
  pickerBlurb: string;
  pickerLabel: string;
  stateFrameCounts: Record<CharacterPreviewState, number>;
  stateRows: Record<CharacterPreviewState, number>;
}

const MORI_PET = {
  assetUrl: "/assets/characters/pets/mori/spritesheet.webp",
  atlas: {
    cellHeight: 208,
    cellWidth: 192,
    columns: 8,
    rows: 11,
  },
  displayName: "Mori",
  emotionReactions: {
    neutral: "calm",
    warm: "soft",
    cheerful: "wave",
    curious: "lift",
    focused: "attentive",
    playful: "bounce",
    concerned: "failed",
  },
  frameIntervalMs: 160,
  gaze: {
    clockwise: true,
    directions: 16,
    framesPerRow: 8,
    rows: [9, 10],
    zeroDirection: "up",
  },
  gesture: {
    durationMs: 700,
    frameCount: 5,
    row: 4,
  },
  modelId: "mori_2d",
  pickerBlurb: "原创动态学习伙伴；无需 WebGL，并会随聆听、思考、表达和情绪切换动作。",
  pickerLabel: "Mori · Original 2D",
  stateFrameCounts: {
    idle: 6,
    listening: 6,
    thinking: 6,
    speaking: 6,
  },
  stateRows: {
    idle: 0,
    listening: 6,
    thinking: 7,
    speaking: 8,
  },
} as const satisfies BuiltinPetDefinition;

const YUZU_PET = {
  assetUrl: "/assets/characters/pets/yuzu/spritesheet.webp",
  atlas: {
    cellHeight: 208,
    cellWidth: 192,
    columns: 8,
    rows: 11,
  },
  displayName: "Yuzu",
  emotionReactions: {
    neutral: "calm",
    warm: "soft",
    cheerful: "wave",
    curious: "lift",
    focused: "attentive",
    playful: "bounce",
    concerned: "failed",
  },
  frameIntervalMs: 160,
  gaze: {
    clockwise: true,
    directions: 16,
    framesPerRow: 8,
    rows: [9, 10],
    zeroDirection: "up",
  },
  gesture: {
    durationMs: 700,
    frameCount: 4,
    row: 3,
  },
  modelId: "yuzu_2d",
  pickerBlurb: "原创橘金小狐学习伙伴；会挥手、倾听、思考、复盘，并用 16 个方向回应你的注视。",
  pickerLabel: "Yuzu · Original 2D",
  stateFrameCounts: {
    idle: 6,
    listening: 6,
    thinking: 6,
    speaking: 6,
  },
  stateRows: {
    idle: 0,
    listening: 6,
    thinking: 7,
    speaking: 8,
  },
} as const satisfies BuiltinPetDefinition;

export const BUILTIN_PET_DEFINITIONS = [MORI_PET, YUZU_PET] as const;

const BUILTIN_PETS_BY_MODEL_ID = new Map<string, BuiltinPetDefinition>(
  BUILTIN_PET_DEFINITIONS.map((definition) => [definition.modelId, definition]),
);

export function getBuiltinPetDefinition(modelId: string) {
  return BUILTIN_PETS_BY_MODEL_ID.get(modelId) ?? null;
}
