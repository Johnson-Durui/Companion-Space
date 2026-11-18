export const AVATAR_LOW_FPS_THRESHOLD = 18;
export const AVATAR_LOW_FPS_LIMIT_SECONDS = 8;

export function nextLowFrameRateSeconds(
  current: number,
  framesPerSecond: number,
  visible: boolean,
) {
  if (!visible || !Number.isFinite(framesPerSecond)) return current;
  return framesPerSecond < AVATAR_LOW_FPS_THRESHOLD ? current + 1 : 0;
}

export function avatarFrameLoop(hidden: boolean): "always" | "never" {
  return hidden ? "never" : "always";
}

export function installWebGlRecovery(
  canvas: HTMLCanvasElement,
  onFailure: () => void,
  timeoutMs = 3000,
) {
  let restoreTimer: ReturnType<typeof setTimeout> | undefined;
  const lost = (event: Event) => {
    event.preventDefault();
    clearTimeout(restoreTimer);
    restoreTimer = setTimeout(onFailure, timeoutMs);
  };
  const restored = () => clearTimeout(restoreTimer);
  canvas.addEventListener("webglcontextlost", lost);
  canvas.addEventListener("webglcontextrestored", restored);
  return () => {
    clearTimeout(restoreTimer);
    canvas.removeEventListener("webglcontextlost", lost);
    canvas.removeEventListener("webglcontextrestored", restored);
  };
}
