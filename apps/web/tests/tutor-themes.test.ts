import { describe, expect, it } from "vitest";
import {
  BUILTIN_TUTOR_THEME_IDS,
  SURFACE_PALETTES,
  TUTOR_THEME_IDS,
  TUTOR_THEMES,
} from "../src/styles/tutor-themes";

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace("#", "");
  if (clean.length !== 6) throw new Error(`Expected 6-digit hex color, got ${hex}`);
  return [
    parseInt(clean.slice(0, 2), 16) / 255,
    parseInt(clean.slice(2, 4), 16) / 255,
    parseInt(clean.slice(4, 6), 16) / 255,
  ];
}

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map(srgbToLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(fgHex: string, bgHex: string): number {
  const l1 = relativeLuminance(fgHex);
  const l2 = relativeLuminance(bgHex);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

function hexToOklab(hex: string): [number, number, number] {
  const [r, g, b] = hexToRgb(hex).map(srgbToLinear);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function oklabDistance(aHex: string, bHex: string): number {
  const [l1, a1, b1] = hexToOklab(aHex);
  const [l2, a2, b2] = hexToOklab(bHex);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

function blendHex(fgHex: string, fgAlpha: number, bgHex: string): string {
  const fg = hexToRgb(fgHex);
  const bg = hexToRgb(bgHex);
  const mix = fg.map((v, i) => Math.round((v * fgAlpha + bg[i] * (1 - fgAlpha)) * 255));
  return `#${mix.map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}

const STAGE_CARD_BG = "#171B22";

describe("tutor theme WCAG contrast and distinguishability", () => {
  it("keeps white-on-accent, accent-strong-on-soft, and accent-on-dark >= 4.5:1 across all 8 themes", () => {
    expect(TUTOR_THEME_IDS).toHaveLength(8);
    for (const id of TUTOR_THEME_IDS) {
      const theme = TUTOR_THEMES[id];
      expect(theme.onAccent).toBe("#FFFFFF");
      expect(contrastRatio(theme.onAccent, theme.accent), `${id} onAccent/accent`).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(theme.accentStrong, theme.accentSoft), `${id} strong/soft`).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(theme.accentOnDark, STAGE_CARD_BG), `${id} onDark/stage`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps all 6 built-in tutor accents pairwise OKLab distance >= 0.07", () => {
    expect(BUILTIN_TUTOR_THEME_IDS).toHaveLength(6);
    for (let i = 0; i < BUILTIN_TUTOR_THEME_IDS.length; i++) {
      for (let j = i + 1; j < BUILTIN_TUTOR_THEME_IDS.length; j++) {
        const a = BUILTIN_TUTOR_THEME_IDS[i];
        const b = BUILTIN_TUTOR_THEME_IDS[j];
        const dist = oklabDistance(TUTOR_THEMES[a].accent, TUTOR_THEMES[b].accent);
        expect(dist, `OKLab(${a}, ${b})`).toBeGreaterThanOrEqual(0.07);
      }
    }
  });

  it("satisfies text >= 4.5:1 and control border >= 3.0:1 across desk, stage, and both paper surfaces", () => {
    for (const surface of SURFACE_PALETTES) {
      for (const bg of [surface.surfacePage, surface.surfaceCard]) {
        expect(contrastRatio(surface.textPrimary, bg), `${surface.name} primary/${bg}`).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(surface.textSecondary, bg), `${surface.name} secondary/${bg}`).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(surface.textTertiary, bg), `${surface.name} tertiary/${bg}`).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(surface.borderControl, bg), `${surface.name} borderControl/${bg}`).toBeGreaterThanOrEqual(3.0);
      }
      for (const st of surface.statuses) {
        const effectiveBg = surface.name === "stage" ? blendHex(st.fg, 0.16, st.bg) : st.bg;
        expect(contrastRatio(st.fg, effectiveBg), `${surface.name} status ${st.name}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
