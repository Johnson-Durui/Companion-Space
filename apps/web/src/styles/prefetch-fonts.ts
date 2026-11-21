const FONT_PREFETCH_SPECS = [
  '400 16px "Geist Variable"',
  '500 16px "Geist Variable"',
  '600 16px "Geist Variable"',
  '400 16px "Noto Sans SC Variable"',
  '500 16px "Noto Sans SC Variable"',
  '600 16px "Noto Sans SC Variable"',
];

const PREFETCH_SAMPLE = "伴学空间课程老师设置今天计划进度复习练习开始上课继续回答正确再想想0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

let scheduled = false;

export function scheduleFontPrefetch(): void {
  if (scheduled || typeof document === "undefined" || !("fonts" in document)) return;
  scheduled = true;

  const run = () => {
    if (document.documentElement.dataset.font === "system") return;
    for (const spec of FONT_PREFETCH_SPECS) {
      void document.fonts.load(spec, PREFETCH_SAMPLE).catch(() => {});
    }
    document.fonts.forEach((face) => {
      if (
        (face.family.includes("Geist Variable") || face.family.includes("Noto Sans SC Variable"))
        && face.status === "unloaded"
      ) {
        void face.load().catch(() => {});
      }
    });
  };

  const idle = (globalThis as {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
  }).requestIdleCallback;
  if (typeof idle === "function") {
    idle(run, { timeout: 3000 });
  } else {
    globalThis.setTimeout(run, 1200);
  }
}
