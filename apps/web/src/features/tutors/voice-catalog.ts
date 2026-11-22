export interface VoiceChoice {
  id: string;
  label: string;
  note: string;
}

export const EDGE_VOICE_CHOICES: readonly VoiceChoice[] = [
  { id: "zh-CN-YunxiNeural", label: "云希 · 清朗男声", note: "雪川默认 · 温柔清晰" },
  { id: "zh-CN-YunjianNeural", label: "云健 · 沉稳男声", note: "沈砚默认 · 笃定干练" },
  { id: "zh-CN-XiaoyiNeural", label: "晓伊 · 温润女声", note: "岚玥默认 · 典雅柔和" },
  { id: "zh-CN-XiaoxiaoNeural", label: "晓晓 · 清新女声", note: "初棠默认 · 温暖亲切" },
  { id: "zh-CN-YunyangNeural", label: "云扬 · 儒雅男声", note: "青衡默认 · 播音沉静" },
  { id: "zh-TW-HsiaoChenNeural", label: "晓臻 · 干练女声", note: "澜音默认 · 清晰明快" },
  { id: "zh-TW-HsiaoYuNeural", label: "晓雨 · 轻柔女声", note: "亲和自然" },
  { id: "zh-CN-YunxiaNeural", label: "云夏 · 少年男声", note: "轻快活泼" },
  { id: "zh-CN-liaoning-XiaobeiNeural", label: "晓北 · 爽朗女声", note: "东北特色" },
  { id: "zh-CN-shaanxi-XiaoniNeural", label: "晓妮 · 温和女声", note: "陕西特色" },
];

export const TUTOR_THEME_CHOICES = [
  { id: "default", label: "青黛" },
  { id: "xuechuan", label: "星蓝" },
  { id: "shenyan", label: "墨灰蓝" },
  { id: "lanyue", label: "暮紫" },
  { id: "chutang", label: "棠红" },
  { id: "qingheng", label: "竹青" },
  { id: "lanyin", label: "海青" },
  { id: "neutral", label: "静灰" },
] as const;

export type TutorThemeChoice = (typeof TUTOR_THEME_CHOICES)[number]["id"];
