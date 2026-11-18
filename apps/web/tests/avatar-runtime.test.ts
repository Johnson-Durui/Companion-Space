import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AVATAR_LOW_FPS_LIMIT_SECONDS,
  avatarFrameLoop,
  installWebGlRecovery,
  nextLowFrameRateSeconds,
} from "@companion-space/avatar-engine/runtime-health";
import { createAvatarSpeechController } from "@companion-space/avatar-engine/speech-controller";
import { measuredVisemeWeights } from "@companion-space/avatar-engine/viseme";

describe("M6 avatar runtime", () => {
  afterEach(() => vi.useRealTimers());

  it("pauses rendering while hidden and only degrades after sustained visible low FPS", () => {
    expect(avatarFrameLoop(true)).toBe("never");
    let seconds = 0;
    for (let index = 0; index < AVATAR_LOW_FPS_LIMIT_SECONDS; index += 1) {
      seconds = nextLowFrameRateSeconds(seconds, 12, true);
    }
    expect(seconds).toBe(AVATAR_LOW_FPS_LIMIT_SECONDS);
    expect(nextLowFrameRateSeconds(seconds, 12, false)).toBe(seconds);
    expect(nextLowFrameRateSeconds(seconds, 30, true)).toBe(0);
  });

  it("falls back after an unrestored WebGL context loss and cancels on restoration", () => {
    vi.useFakeTimers();
    const canvas = new EventTarget() as HTMLCanvasElement;
    const fail = vi.fn();
    const cleanup = installWebGlRecovery(canvas, fail, 3000);
    canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
    vi.advanceTimersByTime(2999);
    expect(fail).not.toHaveBeenCalled();
    canvas.dispatchEvent(new Event("webglcontextrestored"));
    vi.advanceTimersByTime(1);
    expect(fail).not.toHaveBeenCalled();
    canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
    vi.advanceTimersByTime(3000);
    expect(fail).toHaveBeenCalledOnce();
    cleanup();
  });

  it("passes measured phonemes outside React state and closes them on reset", () => {
    const controller = createAvatarSpeechController();
    controller.publishVisemes({ aa: 0.8, ih: 0.1, ou: 0, ee: 0.2, oh: 0 });
    expect(controller.peekVisemes()?.aa).toBe(0.8);
    expect(measuredVisemeWeights(controller.peekVisemes()!, 0.5, "warm")).toEqual({
      aa: 0.4,
      ih: 0.05,
      ou: 0,
      ee: 0.1,
      oh: 0,
    });
    controller.reset();
    expect(controller.peekVisemes()).toBeNull();
  });
});
