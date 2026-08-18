export interface BuiltinPortraitDefinition {
  accentColor: string;
  alt: string;
  assetUrl: string;
  displayName: string;
  modelId: string;
  objectPosition: string;
  pickerBlurb: string;
  pickerLabel: string;
}

export const BUILTIN_PORTRAIT_DEFINITIONS = [
  {
    accentColor: "#d6644a",
    alt: "原创学习伙伴澄羽，身穿雾白与深海青短斗篷，手托发光的学习记录页",
    assetUrl: "/assets/characters/art/roster/mira.png",
    displayName: "澄羽 · MIRA",
    modelId: "mira_2d",
    objectPosition: "50% 36%",
    pickerBlurb: "2D 卡面备用；共学主舞台请用同名 painted-blender 3D。",
    pickerLabel: "澄羽 · MIRA · Original 2D",
  },
  {
    accentColor: "#f2c84b",
    alt: "原创学习伙伴曜柚，身穿柚黄与松石绿运动夹克，向前做倒数手势",
    assetUrl: "/assets/characters/art/roster/kite.png",
    displayName: "曜柚 · KITE",
    modelId: "kite_2d",
    objectPosition: "50% 30%",
    pickerBlurb: "2D 卡面备用；共学主舞台请用同名 painted-blender 3D。",
    pickerLabel: "曜柚 · KITE · Original 2D",
  },
  {
    accentColor: "#86dce3",
    alt: "原创学习伙伴凛序，身穿墨蓝长风衣，在观测书室指出冰青色约束图形",
    assetUrl: "/assets/characters/art/roster/cael.png",
    displayName: "凛序 · CAEL",
    modelId: "cael_2d",
    objectPosition: "50% 28%",
    pickerBlurb: "2D 卡面备用；共学主舞台请用同名 painted-blender 3D。",
    pickerLabel: "凛序 · CAEL · Original 2D",
  },
  {
    accentColor: "#e78745",
    alt: "原创学习伙伴弦灯，身穿炭紫与灯橙创作服，在暖灯工作室展开故事卡片",
    assetUrl: "/assets/characters/art/roster/lyra.png",
    displayName: "弦灯 · LYRA",
    modelId: "lyra_2d",
    objectPosition: "50% 34%",
    pickerBlurb: "2D 卡面备用；共学主舞台请用同名 painted-blender 3D。",
    pickerLabel: "弦灯 · LYRA · Original 2D",
  },
] as const satisfies readonly BuiltinPortraitDefinition[];

const BUILTIN_PORTRAITS_BY_MODEL_ID = new Map<string, BuiltinPortraitDefinition>(
  BUILTIN_PORTRAIT_DEFINITIONS.map((definition) => [definition.modelId, definition]),
);

export function getBuiltinPortraitDefinition(modelId: string) {
  return BUILTIN_PORTRAITS_BY_MODEL_ID.get(modelId) ?? null;
}
