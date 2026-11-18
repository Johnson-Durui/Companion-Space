export type AvatarFraming = "full_body" | "portrait";
export type AvatarStageBackground = "neutral" | "study" | "midnight";
export type CharacterPreviewState = "idle" | "listening" | "thinking" | "speaking";
export type CompanionEmotion =
  | "neutral"
  | "warm"
  | "cheerful"
  | "curious"
  | "focused"
  | "playful"
  | "concerned";

export type CharacterRecipeLike = {
  avatar_model?: string;
  avatar_framing?: AvatarFraming;
  stage_background?: AvatarStageBackground;
  base_model?: string;
  motions?: Record<string, string>;
  palette?: Record<string, string>;
};
