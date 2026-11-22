/**
 * Global single-active-video coordinator ensuring I16:
 * at most one tutor <video> plays at any instant on any page,
 * and hidden tabs pause playback cleanly.
 */
export interface VideoPlaybackOwner {
  pause: () => void;
  resume?: () => void;
  isVisible?: () => boolean;
}

class TutorVideoCoordinator {
  private active: VideoPlaybackOwner | null = null;
  private primary: VideoPlaybackOwner | null = null;
  private visibilityBound = false;

  private ensureVisibilityHook(): void {
    if (this.visibilityBound || typeof document === "undefined" || typeof document.addEventListener !== "function") return;
    this.visibilityBound = true;
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        this.active?.pause();
      } else if (this.active && (this.active.isVisible?.() ?? true)) {
        this.active.resume?.();
      } else if (this.primary && (this.primary.isVisible?.() ?? true)) {
        this.active = this.primary;
        this.primary.resume?.();
      }
    });
  }

  claim(owner: VideoPlaybackOwner, options: { primary?: boolean } = {}): void {
    this.ensureVisibilityHook();
    if (options.primary) {
      this.primary = owner;
    }
    if (this.active && this.active !== owner) {
      this.active.pause();
    }
    this.active = owner;
  }

  release(owner: VideoPlaybackOwner): void {
    if (this.active !== owner) return;
    this.active = null;
    if (
      this.primary &&
      this.primary !== owner &&
      (this.primary.isVisible?.() ?? true) &&
      (typeof document === "undefined" || !document.hidden)
    ) {
      this.active = this.primary;
      this.primary.resume?.();
    }
  }

  unregister(owner: VideoPlaybackOwner): void {
    if (this.primary === owner) {
      this.primary = null;
    }
    if (this.active === owner) {
      this.active = null;
      if (
        this.primary &&
        (this.primary.isVisible?.() ?? true) &&
        (typeof document === "undefined" || !document.hidden)
      ) {
        this.active = this.primary;
        this.primary.resume?.();
      }
    }
  }

  getActiveOwner(): VideoPlaybackOwner | null {
    return this.active;
  }
}

export const tutorVideoCoordinator = new TutorVideoCoordinator();
