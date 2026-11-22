export type TutorThemeId =
  | "default"
  | "xuechuan"
  | "shenyan"
  | "lanyue"
  | "chutang"
  | "qingheng"
  | "lanyin"
  | "neutral";

export interface TutorThemePalette {
  id: TutorThemeId;
  tutorId: string;
  label: string;
  accent: string;
  accentStrong: string;
  accentSoft: string;
  accentOnDark: string;
  onAccent: string;
}

export const TUTOR_THEMES: Record<TutorThemeId, TutorThemePalette> = {
  default: {
    id: "default",
    tutorId: "default",
    label: "默认（品牌青）",
    accent: "#1F7A6E",
    accentStrong: "#17625A",
    accentSoft: "#E3F1EE",
    accentOnDark: "#8FD9CC",
    onAccent: "#FFFFFF",
  },
  xuechuan: {
    id: "xuechuan",
    tutorId: "tutor-xuechuan",
    label: "雪川（湛蓝）",
    accent: "#3F66D8",
    accentStrong: "#3355BC",
    accentSoft: "#E7ECFB",
    accentOnDark: "#A9BCF7",
    onAccent: "#FFFFFF",
  },
  shenyan: {
    id: "shenyan",
    tutorId: "tutor-shenyan",
    label: "沈砚（墨色）",
    accent: "#4A5B73",
    accentStrong: "#3A495E",
    accentSoft: "#E9EDF2",
    accentOnDark: "#B4C2D6",
    onAccent: "#FFFFFF",
  },
  lanyue: {
    id: "lanyue",
    tutorId: "tutor-lanyue",
    label: "岚玥（藤紫）",
    accent: "#8A55C4",
    accentStrong: "#7443AE",
    accentSoft: "#F1EAFA",
    accentOnDark: "#D0B5F2",
    onAccent: "#FFFFFF",
  },
  chutang: {
    id: "chutang",
    tutorId: "tutor-chutang",
    label: "初棠（樱粉）",
    accent: "#C4497A",
    accentStrong: "#A93A66",
    accentSoft: "#FBE9F0",
    accentOnDark: "#F3A9C4",
    onAccent: "#FFFFFF",
  },
  qingheng: {
    id: "qingheng",
    tutorId: "tutor-qingheng",
    label: "青衡（竹青）",
    accent: "#66752A",
    accentStrong: "#525F1F",
    accentSoft: "#F0F2DF",
    accentOnDark: "#C6D48A",
    onAccent: "#FFFFFF",
  },
  lanyin: {
    id: "lanyin",
    tutorId: "tutor-lanyin",
    label: "澜音（湖蓝）",
    accent: "#1B79A8",
    accentStrong: "#14628A",
    accentSoft: "#E3F1F8",
    accentOnDark: "#8FCBEA",
    onAccent: "#FFFFFF",
  },
  neutral: {
    id: "neutral",
    tutorId: "neutral",
    label: "中性灰蓝",
    accent: "#5B6472",
    accentStrong: "#474F5B",
    accentSoft: "#ECEEF1",
    accentOnDark: "#BFC6D0",
    onAccent: "#FFFFFF",
  },
};

export const TUTOR_THEME_IDS: TutorThemeId[] = [
  "default",
  "xuechuan",
  "shenyan",
  "lanyue",
  "chutang",
  "qingheng",
  "lanyin",
  "neutral",
];

export const BUILTIN_TUTOR_THEME_IDS: TutorThemeId[] = [
  "xuechuan",
  "shenyan",
  "lanyue",
  "chutang",
  "qingheng",
  "lanyin",
];

export interface SurfacePalette {
  name: string;
  surfacePage: string;
  surfaceCard: string;
  textPrimary: string;
  textSecondary: string;
  textTertiary: string;
  borderControl: string;
  statuses: Array<{ name: string; fg: string; bg: string }>;
}

export const SURFACE_PALETTES: SurfacePalette[] = [
  {
    name: "desk",
    surfacePage: "#F6F5F2",
    surfaceCard: "#FFFFFF",
    textPrimary: "#1B2126",
    textSecondary: "#55606A",
    textTertiary: "#66707A",
    borderControl: "#868D94",
    statuses: [
      { name: "ok", fg: "#1E7B4D", bg: "#E6F4EC" },
      { name: "retry", fg: "#A8480F", bg: "#FDEEE3" },
      { name: "warn", fg: "#8A5A00", bg: "#FFF4D6" },
      { name: "danger", fg: "#B3261E", bg: "#FCEBEA" },
      { name: "info", fg: "#1F5FA8", bg: "#E7F0FB" },
    ],
  },
  {
    name: "stage",
    surfacePage: "#0E1116",
    surfaceCard: "#171B22",
    textPrimary: "#F3F5F7",
    textSecondary: "#A7B0BA",
    textTertiary: "#8C96A1",
    borderControl: "#6B7480",
    statuses: [
      { name: "ok", fg: "#5FCB93", bg: "#171B22" },
      { name: "retry", fg: "#F0A06A", bg: "#171B22" },
      { name: "warn", fg: "#E8B84A", bg: "#171B22" },
      { name: "danger", fg: "#F28B82", bg: "#171B22" },
      { name: "info", fg: "#7FB2F0", bg: "#171B22" },
    ],
  },
  {
    name: "paper-desk",
    surfacePage: "#FFFDF6",
    surfaceCard: "#FFFDF6",
    textPrimary: "#1F2A30",
    textSecondary: "#5A656C",
    textTertiary: "#606A71",
    borderControl: "#7D848B",
    statuses: [
      { name: "ok", fg: "#1E7B4D", bg: "#E6F4EC" },
      { name: "retry", fg: "#A8480F", bg: "#FDEEE3" },
      { name: "warn", fg: "#8A5A00", bg: "#FFF4D6" },
      { name: "danger", fg: "#B3261E", bg: "#FCEBEA" },
      { name: "info", fg: "#1F5FA8", bg: "#E7F0FB" },
    ],
  },
  {
    name: "paper-stage",
    surfacePage: "#F6F2E6",
    surfaceCard: "#F6F2E6",
    textPrimary: "#1F2A30",
    textSecondary: "#5A656C",
    textTertiary: "#606A71",
    borderControl: "#7D848B",
    statuses: [
      { name: "ok", fg: "#1E7B4D", bg: "#E6F4EC" },
      { name: "retry", fg: "#A8480F", bg: "#FDEEE3" },
      { name: "warn", fg: "#8A5A00", bg: "#FFF4D6" },
      { name: "danger", fg: "#B3261E", bg: "#FCEBEA" },
      { name: "info", fg: "#1F5FA8", bg: "#E7F0FB" },
    ],
  },
];

export function resolveTutorThemeId(theme?: string | null): TutorThemeId {
  if (theme && theme in TUTOR_THEMES) {
    return theme as TutorThemeId;
  }
  return "default";
}

export function applyTutorTheme(themeId: TutorThemeId, tutorId?: string, root?: HTMLElement): void {
  const target = root ?? (typeof document !== "undefined" ? document.documentElement : null);
  if (!target) return;
  const palette = TUTOR_THEMES[themeId] ?? TUTOR_THEMES.default;
  target.dataset.theme = palette.id;
  target.dataset.tutor = tutorId ?? palette.tutorId;
  target.style.setProperty("--accent", palette.accent);
  target.style.setProperty("--accent-strong", palette.accentStrong);
  target.style.setProperty("--accent-soft", palette.accentSoft);
  target.style.setProperty("--theme-accent-strong", palette.accentStrong);
  target.style.setProperty("--theme-accent-soft", palette.accentSoft);
  target.style.setProperty("--accent-on-dark", palette.accentOnDark);
  target.style.setProperty("--on-accent", palette.onAccent);
}
