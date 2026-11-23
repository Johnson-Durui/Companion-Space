import {
  CLIP_ENTRY_BY_ID,
  ONE_SHOT_CLIPS,
  PREFETCH_TIER1_GROUPS,
} from "./catalog";
import {
  actionToClipSlot,
  legacyPoseActionToStill,
  oneShotToInstantAction,
  poseToClipSlot,
  resolveDesiredStill,
  resolveStillUrl,
  situationToTutorPose,
} from "./choreographer";
import { tutorVideoCoordinator, type VideoPlaybackOwner } from "./video-coordinator";
import type {
  ClipMeta,
  ClipSlot,
  InstantAction,
  ITutorVideoDriver,
  OneShotKind,
  Situation,
  StillSlot,
  TutorEmotion,
  TutorPose,
  VideoAvatarRuntimeConfig,
  VideoDriverCapabilities,
  VideoDriverStatusEvent,
} from "./types";

const ALL_ACTIONS: readonly InstantAction[] = [
  "greet",
  "empathy_nod",
  "think_chin",
  "praise_thumbs_up",
  "praise_clap",
  "gentle_encourage",
  "board_point",
  "farewell",
];

/** Maximum time to wait for a video frame decode before falling back to showing the clip anyway. */
const DECODE_SAFETY_TIMEOUT_MS = 3000;
/** Extra margin after clip media duration for one-shot safety timer (§4.4). */
const ONE_SHOT_SAFETY_MARGIN_MS = 400;
/** Fallback safety timeout when media metadata duration is unavailable. */
const ONE_SHOT_FALLBACK_DURATION_MS = 9000;
/** Max extra time a reaction clip may hold after teacher speech begins (§4.4). */
const REACTION_SPEECH_MAX_WAIT_MS = 1500;
const IDLE_GLANCE_MIN_MS = 12_000;
const IDLE_GLANCE_SPAN_MS = 8_000;
const IDLE_FIDGET_MIN_MS = 45_000;
const IDLE_FIDGET_SPAN_MS = 30_000;

const SPEAK_WEIGHTS: Record<"speak_calm" | "speak_explain_a" | "speak_explain_b", number> = {
  speak_calm: 2,
  speak_explain_a: 1,
  speak_explain_b: 1,
};

export function resolveClipUrl(
  clips: Partial<Record<ClipSlot, string>>,
  desired: ClipSlot,
): { slot: ClipSlot; url: string } | null {
  const direct = clips[desired];
  if (direct) return { slot: desired, url: direct };
  const entry = CLIP_ENTRY_BY_ID.get(desired);
  if (!entry) return null;
  for (const candidate of entry.fallback) {
    const url = clips[candidate];
    if (url) return { slot: candidate, url };
  }
  return null;
}

export class LoopPackVideoDriver implements ITutorVideoDriver {
  readonly id = "loop-pack-video";
  private root: HTMLDivElement | null = null;
  private stillImgs: [HTMLImageElement, HTMLImageElement] | null = null;
  private activeImgIndex: 0 | 1 = 0;
  private players: [HTMLVideoElement, HTMLVideoElement] | null = null;
  private activeSlotIndex: 0 | 1 = 0;
  private currentUrl = "";
  private currentSlot: ClipSlot | null = null;
  private currentStill: StillSlot | "anchor" = "anchor";
  private anchorImage = "";
  private basePose: TutorPose = "idle_companion";
  private lectureVariant: 0 | 1 = 0;
  private currentSituation: Situation = "idle";
  private currentSentenceSeq = 0;
  private useSituationMode = false;
  private currentGen = 0;
  private crossfadeMs = 180;
  private reducedMotion = false;
  private disableIdleScheduler = false;
  private random: () => number = Math.random;
  private clips: Partial<Record<ClipSlot, string>> = {};
  private clipMeta: Partial<Record<ClipSlot, ClipMeta>> = {};
  private stills: Partial<Record<StillSlot, string>> = {};
  private listeners = new Set<(event: VideoDriverStatusEvent) => void>();

  // Timers & transitions
  private fadeTimer: number | null = null;
  private oneShotTimer: number | null = null;
  private revealTimer: number | null = null;
  private speechSettleTimer: number | null = null;
  private reducedStillTimer: number | null = null;
  private prefetchTimer: number | null = null;
  private prefetchIdleId: number | null = null;
  private prefetchControllers: AbortController[] = [];
  private prefetchedUrls = new Set<string>();
  private transitionSeq = 0;

  // Rotation & one-shot state
  private activeOneShotSlot: ClipSlot | null = null;
  private activeOneShotKind: OneShotKind | null = null;
  private activeOneShotStartMs = 0;
  private activeOneShotPostAction: (() => void) | null = null;
  private pendingSpeechSituation: { situation: "speaking" | "speaking_board"; sentenceSeq: number } | null = null;
  private inSpeakTurn = false;
  private lastSpeakSentenceSeq = -1;
  private lastSpeakSlot: ClipSlot | null = null;
  private lastPraiseSlot: ClipSlot | null = null;
  private lastListenSlot: ClipSlot | null = null;
  private lastThinkSlot: ClipSlot | null = null;
  private groupRoundCount = 0;

  // Idle scheduler state (§4.2)
  private idleScheduleActive = false;
  private idleMustCompleteBreathe = false;
  private nextGlanceAtMs = 0;
  private nextFidgetAtMs = 0;

  // Visibility & single-video coordinator
  private visible = true;
  private frozen = false;
  private showingStillOverride = false;
  private observer: IntersectionObserver | null = null;
  private readonly playbackOwner: VideoPlaybackOwner = {
    pause: () => this.pausePlayers(),
    resume: () => this.resumeActivePlayer(),
    isVisible: () => this.visible && !this.reducedMotion && !this.frozen && !this.showingStillOverride && Boolean(this.root),
  };

  getCapabilities(): VideoDriverCapabilities {
    return {
      tier: "loop_pack",
      lipSyncQuality: "ambient",
      supportsInstantActions: ALL_ACTIONS,
      supportsCustomActionPrompt: false,
      hasMeteredCost: false,
    };
  }

  async mount(container: HTMLElement, config: VideoAvatarRuntimeConfig): Promise<void> {
    await this.unmount();
    this.clips = { ...config.loopPack.clips };
    this.clipMeta = { ...(config.loopPack.clipMeta ?? {}) };
    this.stills = { ...(config.loopPack.stills ?? {}) };
    this.anchorImage = config.anchorImage;
    this.crossfadeMs = config.reducedMotion ? 0 : Math.max(0, Math.min(600, config.loopPack.crossfadeMs));
    this.reducedMotion = Boolean(config.reducedMotion);
    this.disableIdleScheduler = Boolean(config.disableIdleScheduler);
    this.random = config.random ?? Math.random;
    this.currentUrl = "";
    this.currentSlot = null;
    this.currentStill = "anchor";
    this.currentSituation = "idle";
    this.currentSentenceSeq = 0;
    this.useSituationMode = false;
    this.activeOneShotSlot = null;
    this.activeOneShotKind = null;
    this.activeOneShotPostAction = null;
    this.pendingSpeechSituation = null;
    this.inSpeakTurn = false;
    this.lastSpeakSentenceSeq = -1;
    this.lastSpeakSlot = null;
    this.lastPraiseSlot = null;
    this.lastListenSlot = null;
    this.lastThinkSlot = null;
    this.groupRoundCount = 0;
    this.idleScheduleActive = false;
    this.idleMustCompleteBreathe = false;
    this.frozen = false;
    this.showingStillOverride = false;

    const root = document.createElement("div");
    root.className = "tvb-surface tvb-loop";
    root.dataset.tier = "loop_pack";
    root.dataset.pose = this.basePose;
    root.dataset.emotion = "neutral";
    root.dataset.still = "anchor";
    root.style.setProperty("--speech-level", "0");
    root.style.setProperty("--tvb-fade-ms", `${this.crossfadeMs}ms`);

    const anchorA = document.createElement("img");
    anchorA.className = "tvb-anchor tvb-still-layer";
    anchorA.src = config.anchorImage;
    anchorA.alt = config.name;
    anchorA.decoding = "async";
    anchorA.style.opacity = "1";
    anchorA.style.zIndex = "1";

    const anchorB = document.createElement("img");
    anchorB.className = "tvb-anchor tvb-still-layer";
    anchorB.src = config.anchorImage;
    anchorB.alt = "";
    anchorB.setAttribute("aria-hidden", "true");
    anchorB.decoding = "async";
    anchorB.style.opacity = "0";
    anchorB.style.zIndex = "1";

    const videoA = this.createVideoElement();
    const videoB = this.createVideoElement();

    const halo = document.createElement("span");
    halo.className = "tvb-halo";
    halo.setAttribute("aria-hidden", "true");

    root.append(anchorA, anchorB, videoA, videoB, halo);
    container.replaceChildren(root);

    this.root = root;
    this.stillImgs = [anchorA, anchorB];
    this.activeImgIndex = 0;
    this.players = [videoA, videoB];
    this.activeSlotIndex = 0;
    this.visible = true;
    this.attachVisibilityObserver(root);

    if (!resolveClipUrl(this.clips, "idle_breathe")) {
      this.emitStatus({
        state: "degraded",
        tier: "loop_pack",
        code: "loop_pack_empty",
        reason: "No playable video clips in loop pack.",
        fallbackTier: "static",
      });
      return;
    }

    if (!this.reducedMotion) {
      this.enterIdlePlayback(false);
      this.scheduleTwoTierPrefetch();
    }
    this.emitStatus({ state: "ready", tier: "loop_pack" });
  }

  async unmount(): Promise<void> {
    this.transitionSeq += 1;
    this.clearTimers();
    this.cancelPrefetch();
    this.observer?.disconnect();
    this.observer = null;
    this.visible = false;
    this.idleScheduleActive = false;
    this.activeOneShotSlot = null;
    this.activeOneShotKind = null;
    this.activeOneShotPostAction = null;
    this.pendingSpeechSituation = null;
    tutorVideoCoordinator.unregister(this.playbackOwner);
    if (this.players) {
      for (const video of this.players) {
        video.onended = null;
        video.onerror = null;
        video.pause();
        video.removeAttribute("src");
        video.load();
      }
      this.players = null;
    }
    this.stillImgs = null;
    if (this.root) {
      this.root.remove();
      this.root = null;
    }
  }

  pushSpeechLevel(level: number): void {
    if (!this.root) return;
    const clamped = Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : 0;
    this.root.style.setProperty("--speech-level", clamped.toFixed(3));
  }

  setPose(pose: TutorPose, gen: number): void {
    if (gen > 0 && gen < this.currentGen) return;
    this.currentGen = Math.max(this.currentGen, gen);
    if (pose === "lecturing" && this.basePose === "lecturing") {
      this.lectureVariant = this.lectureVariant === 0 ? 1 : 0;
    }
    this.basePose = pose;
    if (this.root) this.root.dataset.pose = pose;
    if (this.reducedMotion) {
      if (!this.useSituationMode) {
        this.applyStill(legacyPoseActionToStill(pose, null));
      }
      return;
    }
    if (this.useSituationMode) return;
    if (pose === "feedback_reaction") return;
    this.showingStillOverride = false;
    this.frozen = false;
    this.exitIdleScheduler();
    const target = poseToClipSlot(pose, this.lectureVariant);
    if (target === this.currentSlot && ONE_SHOT_CLIPS.has(target)) return;
    this.switchToClip(target, ONE_SHOT_CLIPS.has(target));
  }

  setMood(emotion: TutorEmotion, _intensity: number, gen: number): void {
    if (gen > 0 && gen < this.currentGen) return;
    this.currentGen = Math.max(this.currentGen, gen);
    if (this.root) this.root.dataset.emotion = emotion;
  }

  triggerInstantAction(action: InstantAction, gen: number): void {
    if (gen > 0 && gen < this.currentGen) return;
    this.currentGen = Math.max(this.currentGen, gen);
    if (this.root) this.root.dataset.action = action;
    if (this.reducedMotion) {
      this.applyStill(legacyPoseActionToStill(this.basePose, action));
      this.armReducedStillReset();
      return;
    }
    this.showingStillOverride = false;
    this.frozen = false;
    this.clearSpeechSettleTimer();
    this.exitIdleScheduler();
    const slot = actionToClipSlot(action);
    this.switchToClip(slot, ONE_SHOT_CLIPS.has(slot));
  }

  setSituation(situation: Situation, sentenceSeq: number, gen: number): void {
    if (gen > 0 && gen < this.currentGen) return;
    this.currentGen = Math.max(this.currentGen, gen);
    const wasSituationMode = this.useSituationMode;
    this.useSituationMode = true;

    const prevSituation = this.currentSituation;
    const prevSentenceSeq = this.currentSentenceSeq;
    this.currentSituation = situation;
    this.currentSentenceSeq = sentenceSeq;

    const legacyPose = situationToTutorPose(situation);
    this.basePose = legacyPose;
    if (this.root) {
      this.root.dataset.situation = situation;
      this.root.dataset.pose = legacyPose;
    }

    if (this.reducedMotion) {
      if (situation === "paused" || situation === "frozen" || situation === "loading") {
        this.activeOneShotKind = null;
      }
      this.applyStill(resolveDesiredStill(situation, this.activeOneShotKind));
      return;
    }

    this.showingStillOverride = false;

    // Special immediate situations that always cancel active one-shots (§4.4)
    if (situation === "loading") {
      this.frozen = false;
      this.clearActiveOneShotState();
      this.exitIdleScheduler();
      this.inSpeakTurn = false;
      this.hideVideosForStill("anchor");
      return;
    }

    if (situation === "frozen") {
      this.frozen = true;
      this.clearActiveOneShotState();
      this.exitIdleScheduler();
      this.pausePlayers();
      return;
    }

    this.frozen = false;

    if (situation === "paused") {
      this.clearActiveOneShotState();
      this.exitIdleScheduler();
      this.inSpeakTurn = false;
      this.switchToClip("idle_breathe", false);
      return;
    }

    // Reaction-to-speech smooth settle_ms handover (§4.4, I19b)
    if (
      (situation === "speaking" || situation === "speaking_board") &&
      this.activeOneShotSlot !== null
    ) {
      this.pendingSpeechSituation = { situation, sentenceSeq };
      if (this.speechSettleTimer === null) {
        const elapsed = Date.now() - this.activeOneShotStartMs;
        const settleMs = this.resolveSettleMs(this.activeOneShotSlot);
        const remainingToSettle = Math.max(0, settleMs - elapsed);
        const waitMs = Math.min(remainingToSettle, REACTION_SPEECH_MAX_WAIT_MS);
        if (waitMs <= 0) {
          this.flushPendingSpeechTransition();
        } else {
          this.speechSettleTimer = window.setTimeout(() => {
            this.speechSettleTimer = null;
            this.flushPendingSpeechTransition();
          }, waitMs);
        }
      }
      return;
    }

    // Non-interrupting continuous situations (idle/wait/listening/thinking/review/preparing/ended)
    // let the active one-shot finish and then transition to the latest `this.currentSituation` (§4.4).
    if (this.activeOneShotSlot !== null) {
      return;
    }

    // Avoid re-selecting the same non-speaking situation redundantly
    if (
      wasSituationMode &&
      this.activeOneShotSlot === null &&
      prevSituation === situation &&
      (situation !== "speaking" && situation !== "speaking_board"
        ? true
        : prevSentenceSeq === sentenceSeq)
    ) {
      return;
    }

    this.applyContinuousSituation(situation, sentenceSeq);
  }

  triggerOneShot(kind: OneShotKind, gen: number): void {
    if (gen > 0 && gen < this.currentGen) return;
    this.currentGen = Math.max(this.currentGen, gen);
    this.useSituationMode = true;
    const legacy = oneShotToInstantAction(kind);
    if (this.root && legacy) {
      this.root.dataset.action = legacy;
    }

    if (this.reducedMotion) {
      this.activeOneShotKind = kind;
      this.applyStill(resolveDesiredStill(this.currentSituation, kind));
      this.armReducedStillReset();
      return;
    }

    this.showingStillOverride = false;
    this.frozen = false;
    this.clearSpeechSettleTimer();
    this.exitIdleScheduler();
    this.inSpeakTurn = false;

    const chosen = this.chooseOneShotClip(kind);
    if (!chosen) {
      // Missing behavior for hint_finger: enter think group immediately (§2)
      if (kind === "hint") {
        this.clearActiveOneShotState();
        this.applyContinuousSituation("thinking", this.currentSentenceSeq);
      }
      return;
    }

    this.activeOneShotKind = kind;
    this.activeOneShotPostAction =
      kind === "hint"
        ? () => this.applyContinuousSituation("thinking", this.currentSentenceSeq)
        : null;
    this.playOneShotSlot(chosen);
  }

  playClip(slot: ClipSlot, gen: number): void {
    if (gen > 0 && gen < this.currentGen) return;
    this.currentGen = Math.max(this.currentGen, gen);
    if (this.reducedMotion) return;
    if (!this.clips[slot]) return;
    this.showingStillOverride = false;
    this.frozen = false;
    this.clearActiveOneShotState();
    this.exitIdleScheduler();
    const isOneShot = ONE_SHOT_CLIPS.has(slot);
    if (isOneShot) {
      this.playOneShotSlot(slot);
    } else {
      this.switchToClip(slot, false);
    }
  }

  showStill(still: StillSlot | "anchor"): void {
    this.clearActiveOneShotState();
    this.exitIdleScheduler();
    this.hideVideosForStill(still);
  }

  interrupt(gen: number): void {
    this.currentGen = Math.max(this.currentGen, gen);
    this.clearActiveOneShotState();
    this.exitIdleScheduler();
    this.inSpeakTurn = false;
    this.frozen = false;
    this.showingStillOverride = false;
    this.basePose = "listening_empathy";
    if (this.useSituationMode) {
      this.currentSituation = "listening";
    }
    if (this.root) {
      delete this.root.dataset.action;
      this.root.dataset.pose = "listening_empathy";
      if (this.useSituationMode) this.root.dataset.situation = "listening";
      this.root.style.setProperty("--speech-level", "0");
    }
    if (this.reducedMotion) {
      this.applyStill("anchor");
      return;
    }
    if (this.useSituationMode) {
      this.applyContinuousSituation("listening", this.currentSentenceSeq);
    } else {
      this.switchToClip("listen_nod", false);
    }
  }

  onStatusChange(cb: (event: VideoDriverStatusEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  getActiveClipSlot(): ClipSlot | null {
    return this.currentSlot;
  }

  getActiveStill(): StillSlot | "anchor" {
    return this.currentStill;
  }

  private resolveSettleMs(slot: ClipSlot): number {
    const metaSettle = this.clipMeta[slot]?.settleMs;
    if (typeof metaSettle === "number" && Number.isFinite(metaSettle) && metaSettle >= 0) {
      return metaSettle;
    }
    const active = this.players?.[this.activeSlotIndex];
    if (active && Number.isFinite(active.duration) && active.duration > 0) {
      return Math.round(active.duration * 1000);
    }
    const metaDuration = this.clipMeta[slot]?.durationMs;
    if (typeof metaDuration === "number" && Number.isFinite(metaDuration) && metaDuration > 0) {
      return metaDuration;
    }
    return REACTION_SPEECH_MAX_WAIT_MS;
  }

  private flushPendingSpeechTransition(): void {
    const pending = this.pendingSpeechSituation;
    this.clearActiveOneShotState();
    if (!pending) return;
    if (this.currentSituation === "speaking" || this.currentSituation === "speaking_board") {
      this.applyContinuousSituation(this.currentSituation, this.currentSentenceSeq);
    }
  }

  private chooseOneShotClip(kind: OneShotKind): ClipSlot | null {
    switch (kind) {
      case "greet":
        return this.clips.greet_wave ? "greet_wave" : null;
      case "farewell":
        return this.clips.farewell_wave ? "farewell_wave" : null;
      case "board_glance":
        return this.clips.board_glance ? "board_glance" : null;
      case "board_point":
        return resolveClipUrl(this.clips, "board_point")?.slot ?? null;
      case "ack":
        return this.clips.nod_yes ? "nod_yes" : null;
      case "hint":
        return this.clips.hint_finger ? "hint_finger" : null;
      case "surprise":
        if (this.clips.react_surprise) {
          this.lastPraiseSlot = "react_surprise";
          return "react_surprise";
        }
        return this.choosePraiseClip();
      case "praise":
        return this.choosePraiseClip();
      case "comfort":
        return resolveClipUrl(this.clips, "react_comfort")?.slot ?? null;
      case "encourage":
        return resolveClipUrl(this.clips, "react_encourage")?.slot ?? null;
      case "celebrate":
        return resolveClipUrl(this.clips, "react_celebrate")?.slot ?? null;
    }
  }

  private choosePraiseClip(): ClipSlot | null {
    const pool = (["react_praise", "react_clap"] as const).filter((slot) => Boolean(this.clips[slot]));
    if (pool.length === 0) {
      return resolveClipUrl(this.clips, "react_praise")?.slot ?? null;
    }
    if (pool.length === 1) {
      this.lastPraiseSlot = pool[0];
      return pool[0];
    }
    const candidates = pool.filter((slot) => slot !== this.lastPraiseSlot);
    const picked = candidates[Math.floor(this.random() * candidates.length)] ?? pool[0];
    this.lastPraiseSlot = picked;
    return picked;
  }

  private chooseSpeakClip(sentenceSeq: number): ClipSlot | null {
    const isFirstSentence = !this.inSpeakTurn;
    this.inSpeakTurn = true;
    this.lastSpeakSentenceSeq = sentenceSeq;

    const pool = (["speak_calm", "speak_explain_a", "speak_explain_b"] as const).filter(
      (slot) => Boolean(this.clips[slot]),
    );
    if (pool.length === 0) {
      return resolveClipUrl(this.clips, "speak_calm")?.slot ?? null;
    }
    if (pool.length === 1) {
      this.lastSpeakSlot = pool[0];
      return pool[0];
    }
    if (isFirstSentence) {
      const first: ClipSlot = this.clips.speak_calm
        ? "speak_calm"
        : (this.clips.speak_explain_a ? "speak_explain_a" : pool[0]);
      this.lastSpeakSlot = first;
      return first;
    }
    const candidates = pool.filter((slot) => slot !== this.lastSpeakSlot);
    if (candidates.length === 1) {
      this.lastSpeakSlot = candidates[0];
      return candidates[0];
    }
    const totalWeight = candidates.reduce((acc, slot) => acc + SPEAK_WEIGHTS[slot], 0);
    let r = this.random() * totalWeight;
    for (const slot of candidates) {
      r -= SPEAK_WEIGHTS[slot];
      if (r < 0) {
        this.lastSpeakSlot = slot;
        return slot;
      }
    }
    const fallback = candidates[candidates.length - 1];
    this.lastSpeakSlot = fallback;
    return fallback;
  }

  private applyContinuousSituation(situation: Situation, sentenceSeq: number): void {
    this.clearSpeechSettleTimer();
    this.clearOneShotTimer();
    this.activeOneShotSlot = null;
    this.activeOneShotKind = null;
    this.activeOneShotPostAction = null;

    if (situation !== "speaking" && situation !== "speaking_board") {
      this.inSpeakTurn = false;
    }

    switch (situation) {
      case "loading":
        this.exitIdleScheduler();
        this.hideVideosForStill("anchor");
        return;
      case "idle":
        this.enterIdlePlayback(!this.disableIdleScheduler);
        return;
      case "paused":
      case "ended":
        this.exitIdleScheduler();
        this.switchToClip("idle_breathe", false);
        return;
      case "frozen":
        this.exitIdleScheduler();
        this.pausePlayers();
        return;
      case "preparing":
        this.exitIdleScheduler();
        this.switchToClip("prepare_notes", false);
        return;
      case "wait":
        this.exitIdleScheduler();
        this.switchToClip("wait_gentle", false);
        return;
      case "review":
        this.exitIdleScheduler();
        this.switchToClip("read_answer", false);
        return;
      case "listening":
        this.exitIdleScheduler();
        this.enterRotatingGroup("listen", ["listen_nod", "listen_tilt"], "listen_nod");
        return;
      case "thinking":
        this.exitIdleScheduler();
        this.enterRotatingGroup("think", ["think_gaze", "think_chin"], "think_gaze");
        return;
      case "speaking": {
        this.exitIdleScheduler();
        if (this.inSpeakTurn && sentenceSeq === this.lastSpeakSentenceSeq && this.currentSlot && this.lastSpeakSlot === this.currentSlot) {
          return;
        }
        const speakSlot = this.chooseSpeakClip(sentenceSeq);
        if (speakSlot) this.switchToClip(speakSlot, false);
        return;
      }
      case "speaking_board": {
        this.exitIdleScheduler();
        if (this.clips.speak_board) {
          this.inSpeakTurn = true;
          this.lastSpeakSentenceSeq = sentenceSeq;
          this.switchToClip("speak_board", false);
        } else if (this.clips.board_point) {
          // §2 table: speak_board missing -> play board_point once, then return to speak group
          this.activeOneShotPostAction = () => {
            if (this.currentSituation === "speaking" || this.currentSituation === "speaking_board") {
              const nextSpeak = this.chooseSpeakClip(this.currentSentenceSeq);
              if (nextSpeak) this.switchToClip(nextSpeak, false);
            }
          };
          this.playOneShotSlot("board_point");
        } else {
          const speakSlot = this.chooseSpeakClip(sentenceSeq);
          if (speakSlot) this.switchToClip(speakSlot, false);
        }
        return;
      }
    }
  }

  private enterRotatingGroup(
    group: "listen" | "think",
    members: readonly ClipSlot[],
    fallbackPrimary: ClipSlot,
  ): void {
    const available = members.filter((slot) => Boolean(this.clips[slot]));
    if (available.length <= 1) {
      const target = available[0] ?? fallbackPrimary;
      this.switchToClip(target, false);
      return;
    }
    const last = group === "listen" ? this.lastListenSlot : this.lastThinkSlot;
    const initial = available.find((slot) => slot !== last) ?? available[0];
    if (group === "listen") this.lastListenSlot = initial;
    else this.lastThinkSlot = initial;
    this.groupRoundCount = 0;

    const playMember = (slot: ClipSlot) => {
      this.switchToClip(slot, false, {
        forceNonLoop: true,
        onLoopEnded: () => {
          const expectedSit: Situation = group === "listen" ? "listening" : "thinking";
          if (this.currentSituation !== expectedSit || this.activeOneShotSlot !== null) return;
          this.groupRoundCount += 1;
          if (this.groupRoundCount >= 2) {
            this.groupRoundCount = 0;
            const next = available.find((candidate) => candidate !== slot) ?? available[0];
            if (group === "listen") this.lastListenSlot = next;
            else this.lastThinkSlot = next;
            playMember(next);
          } else {
            this.replayActiveVideo();
          }
        },
      });
    };
    playMember(initial);
  }

  private enterIdlePlayback(allowInserts: boolean): void {
    const hasGlance = Boolean(this.clips.idle_glance);
    const hasFidget = Boolean(this.clips.idle_fidget);
    if (!allowInserts || (!hasGlance && !hasFidget)) {
      this.idleScheduleActive = false;
      this.switchToClip("idle_breathe", false);
      return;
    }

    const now = Date.now();
    this.idleScheduleActive = true;
    this.idleMustCompleteBreathe = false;
    this.nextGlanceAtMs = now + IDLE_GLANCE_MIN_MS + Math.round(this.random() * IDLE_GLANCE_SPAN_MS);
    this.nextFidgetAtMs = now + IDLE_FIDGET_MIN_MS + Math.round(this.random() * IDLE_FIDGET_SPAN_MS);
    this.playIdleBreatheRound();
  }

  private playIdleBreatheRound(): void {
    this.switchToClip("idle_breathe", false, {
      forceNonLoop: true,
      onLoopEnded: () => {
        if (!this.idleScheduleActive || this.currentSituation !== "idle" || this.activeOneShotSlot !== null) return;
        const now = Date.now();
        if (this.idleMustCompleteBreathe) {
          // One full breathe round has just finished since the previous insert; now eligible on next check
          this.idleMustCompleteBreathe = false;
        }
        if (this.clips.idle_fidget && now >= this.nextFidgetAtMs) {
          this.playIdleInsert("idle_fidget");
          return;
        }
        if (this.clips.idle_glance && now >= this.nextGlanceAtMs) {
          this.playIdleInsert("idle_glance");
          return;
        }
        this.replayActiveVideo();
      },
    });
  }

  private playIdleInsert(slot: "idle_glance" | "idle_fidget"): void {
    this.switchToClip(slot, false, {
      forceNonLoop: true,
      onLoopEnded: () => {
        if (!this.idleScheduleActive || this.currentSituation !== "idle" || this.activeOneShotSlot !== null) return;
        const now = Date.now();
        if (slot === "idle_fidget") {
          this.nextFidgetAtMs = now + IDLE_FIDGET_MIN_MS + Math.round(this.random() * IDLE_FIDGET_SPAN_MS);
        } else {
          this.nextGlanceAtMs = now + IDLE_GLANCE_MIN_MS + Math.round(this.random() * IDLE_GLANCE_SPAN_MS);
        }
        this.idleMustCompleteBreathe = true;
        this.playIdleBreatheRound();
      },
    });
  }

  private exitIdleScheduler(): void {
    this.idleScheduleActive = false;
    this.idleMustCompleteBreathe = false;
  }

  private playOneShotSlot(slot: ClipSlot): void {
    this.activeOneShotSlot = slot;
    this.activeOneShotStartMs = Date.now();
    this.switchToClip(slot, true);
  }

  private clearActiveOneShotState(): void {
    this.clearOneShotTimer();
    this.clearSpeechSettleTimer();
    this.activeOneShotSlot = null;
    this.activeOneShotKind = null;
    this.activeOneShotPostAction = null;
    this.pendingSpeechSituation = null;
  }

  private createVideoElement(): HTMLVideoElement {
    const video = document.createElement("video");
    video.className = "tvb-video";
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.setAttribute("aria-hidden", "true");
    video.style.opacity = "0";
    return video;
  }

  private scheduleTwoTierPrefetch(): void {
    if (typeof fetch !== "function" || typeof AbortController === "undefined") return;

    const tier1: string[] = [];
    const tier2: string[] = [];
    for (const [slot, url] of Object.entries(this.clips)) {
      if (typeof url !== "string" || !url || this.prefetchedUrls.has(url)) continue;
      const entry = CLIP_ENTRY_BY_ID.get(slot as ClipSlot);
      if (entry && PREFETCH_TIER1_GROUPS.has(entry.group)) {
        tier1.push(url);
      } else {
        tier2.push(url);
      }
    }
    for (const url of Object.values(this.stills)) {
      if (typeof url === "string" && url && !this.prefetchedUrls.has(url)) {
        tier2.push(url);
      }
    }

    const fetchBatch = (urls: string[]) => {
      if (!this.root) return;
      for (const url of new Set(urls)) {
        if (this.prefetchedUrls.has(url)) continue;
        this.prefetchedUrls.add(url);
        const controller = new AbortController();
        this.prefetchControllers.push(controller);
        void fetch(url, { signal: controller.signal, credentials: "same-origin" }).catch(() => {
          this.prefetchedUrls.delete(url);
        });
      }
    };

    // Tier 1: immediate prefetch of core classroom groups (§4.5)
    if (tier1.length) {
      fetchBatch(tier1);
    }

    // Tier 2: idle prefetch of remaining clips & stills
    if (!tier2.length) return;
    const runTier2 = () => {
      this.prefetchTimer = null;
      this.prefetchIdleId = null;
      fetchBatch(tier2);
    };

    const idle = (window as Window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout?: number }) => number;
    }).requestIdleCallback;
    if (typeof idle === "function") {
      this.prefetchIdleId = idle(runTier2, { timeout: 1500 });
    } else {
      this.prefetchTimer = window.setTimeout(runTier2, 400);
    }
  }

  private cancelPrefetch(): void {
    if (this.prefetchTimer !== null) {
      window.clearTimeout(this.prefetchTimer);
      this.prefetchTimer = null;
    }
    if (this.prefetchIdleId !== null) {
      const cancelIdle = (window as Window & { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback;
      if (typeof cancelIdle === "function") cancelIdle(this.prefetchIdleId);
      this.prefetchIdleId = null;
    }
    for (const controller of this.prefetchControllers) {
      controller.abort();
    }
    this.prefetchControllers = [];
  }

  private replayActiveVideo(): void {
    if (!this.players) return;
    const active = this.players[this.activeSlotIndex];
    if (!active) return;
    try {
      active.currentTime = 0;
    } catch {
      // Ignore seek errors on unloaded buffers.
    }
    if (this.visible && !this.frozen && (typeof document === "undefined" || !document.hidden)) {
      const playResult = active.play?.();
      if (playResult && typeof playResult.catch === "function") {
        playResult.catch(() => undefined);
      }
    }
  }

  private hideVideosForStill(still: StillSlot | "anchor"): void {
    this.showingStillOverride = true;
    this.applyStill(still);
    if (this.players) {
      for (const video of this.players) {
        video.pause?.();
        video.style.opacity = "0";
      }
    }
    tutorVideoCoordinator.release(this.playbackOwner);
  }

  private applyStill(desired: StillSlot | "anchor"): void {
    if (!this.root || !this.stillImgs) return;
    const resolved = resolveStillUrl(this.stills, this.anchorImage, desired);
    this.root.dataset.still = resolved.still;
    if (resolved.still === this.currentStill) return;
    this.currentStill = resolved.still;

    const prevIndex = this.activeImgIndex;
    const nextIndex: 0 | 1 = prevIndex === 0 ? 1 : 0;
    const prevImg = this.stillImgs[prevIndex];
    const nextImg = this.stillImgs[nextIndex];
    if (nextImg.getAttribute("src") !== resolved.url) {
      nextImg.src = resolved.url;
    }
    nextImg.style.zIndex = "2";
    prevImg.style.zIndex = "1";
    nextImg.style.opacity = "1";
    prevImg.style.opacity = "0";
    this.activeImgIndex = nextIndex;
  }

  private armReducedStillReset(): void {
    if (this.reducedStillTimer !== null) window.clearTimeout(this.reducedStillTimer);
    this.reducedStillTimer = window.setTimeout(() => {
      this.reducedStillTimer = null;
      this.activeOneShotKind = null;
      if (this.useSituationMode) {
        this.applyStill(resolveDesiredStill(this.currentSituation, null));
      } else {
        this.applyStill(legacyPoseActionToStill(this.basePose, null));
      }
    }, 2600);
  }

  private armOneShotSafetyTimer(video: HTMLVideoElement, slot: ClipSlot, onTimeout: () => void): void {
    this.clearOneShotTimer();
    const durationMs =
      Number.isFinite(video.duration) && video.duration > 0
        ? Math.round(video.duration * 1000)
        : (this.clipMeta[slot]?.durationMs ?? ONE_SHOT_FALLBACK_DURATION_MS);
    const elapsed = Math.max(0, Date.now() - this.activeOneShotStartMs);
    const remaining = Math.max(0, durationMs - elapsed) + ONE_SHOT_SAFETY_MARGIN_MS;
    this.oneShotTimer = window.setTimeout(onTimeout, remaining);
  }

  private switchToClip(
    desired: ClipSlot,
    oneShot: boolean,
    opts?: { forceNonLoop?: boolean; onLoopEnded?: () => void },
  ): void {
    if (!this.players || !this.root) return;
    const resolved = resolveClipUrl(this.clips, desired);
    if (!resolved) return;

    this.clearOneShotTimer();
    this.clearRevealTimer();

    const shouldLoop = !oneShot && !opts?.forceNonLoop;
    if (resolved.url === this.currentUrl && !oneShot && !opts?.forceNonLoop && !this.showingStillOverride) {
      const currentVideo = this.players[this.activeSlotIndex];
      currentVideo.loop = shouldLoop;
      currentVideo.onended = null;
      this.currentSlot = resolved.slot;
      this.root.dataset.clip = resolved.slot;
      return;
    }

    const seq = ++this.transitionSeq;
    this.currentSlot = resolved.slot;
    this.root.dataset.clip = resolved.slot;
    const nextIndex: 0 | 1 = this.activeSlotIndex === 0 ? 1 : 0;
    const prevVideo = this.players[this.activeSlotIndex];
    const nextVideo = this.players[nextIndex];

    nextVideo.onended = null;
    nextVideo.onerror = () => {
      if (seq !== this.transitionSeq) return;
      this.clearRevealTimer();
      if (desired !== "idle_breathe") {
        this.clearActiveOneShotState();
        this.switchToClip("idle_breathe", false);
      } else {
        this.emitStatus({
          state: "degraded",
          tier: "loop_pack",
          code: "loop_pack_playback_failed",
          reason: "Video clip playback failed.",
          fallbackTier: "static",
        });
      }
    };

    nextVideo.loop = shouldLoop;
    // Allow audio only for intro_voice if ever explicitly played (§2)
    nextVideo.muted = !CLIP_ENTRY_BY_ID.get(resolved.slot)?.allow_audio;

    if (nextVideo.getAttribute("src") !== resolved.url) {
      nextVideo.src = resolved.url;
      nextVideo.load();
    } else {
      try {
        nextVideo.currentTime = 0;
      } catch {
        // Ignore seek errors before metadata loads.
      }
    }

    let revealed = false;
    const reveal = () => {
      if (revealed || seq !== this.transitionSeq || !this.players || !this.root) return;
      revealed = true;
      this.clearRevealTimer();
      nextVideo.style.zIndex = "3";
      prevVideo.style.zIndex = "2";
      nextVideo.style.opacity = "1";
      prevVideo.style.opacity = "0";
      this.activeSlotIndex = nextIndex;
      this.currentUrl = resolved.url;
      this.currentSlot = resolved.slot;
      this.root.dataset.clip = resolved.slot;
      if (this.visible && !this.frozen && (typeof document === "undefined" || !document.hidden)) {
        tutorVideoCoordinator.claim(this.playbackOwner, { primary: true });
        const playResult = nextVideo.play?.();
        if (playResult && typeof playResult.catch === "function") {
          playResult.catch(() => undefined);
        }
      }

      if (this.fadeTimer !== null) window.clearTimeout(this.fadeTimer);
      this.fadeTimer = window.setTimeout(() => {
        if (seq !== this.transitionSeq) return;
        prevVideo.pause();
        try {
          prevVideo.currentTime = 0;
        } catch {
          // Ignore reset errors on unloaded buffers.
        }
        this.fadeTimer = null;
      }, this.crossfadeMs + 20);

      if (oneShot) {
        if (!this.activeOneShotStartMs) {
          this.activeOneShotStartMs = Date.now();
        }
        const returnToBase = () => {
          if (seq !== this.transitionSeq) return;
          const postAction = this.activeOneShotPostAction;
          this.clearActiveOneShotState();
          if (this.root) delete this.root.dataset.action;
          if (postAction) {
            postAction();
            return;
          }
          if (this.useSituationMode) {
            this.applyContinuousSituation(this.currentSituation, this.currentSentenceSeq);
          } else {
            const baseSlot = poseToClipSlot(
              this.basePose === "board_guiding" || this.basePose === "feedback_reaction"
                ? "idle_companion"
                : this.basePose,
              this.lectureVariant,
            );
            this.switchToClip(baseSlot, false);
          }
        };
        nextVideo.onended = returnToBase;
        this.armOneShotSafetyTimer(nextVideo, resolved.slot, returnToBase);
        const onMeta = () => {
          if (seq !== this.transitionSeq) return;
          this.armOneShotSafetyTimer(nextVideo, resolved.slot, returnToBase);
        };
        nextVideo.addEventListener("loadedmetadata", onMeta, { once: true });
        nextVideo.addEventListener("durationchange", onMeta, { once: true });
      } else if (opts?.onLoopEnded) {
        const handler = opts.onLoopEnded;
        nextVideo.onended = () => {
          if (seq !== this.transitionSeq) return;
          handler();
        };
      }
    };

    if (nextVideo.readyState >= 2) {
      reveal();
      return;
    }
    const onReady = () => {
      nextVideo.removeEventListener("loadeddata", onReady);
      nextVideo.removeEventListener("canplay", onReady);
      reveal();
    };
    nextVideo.addEventListener("loadeddata", onReady, { once: true });
    nextVideo.addEventListener("canplay", onReady, { once: true });
    this.revealTimer = window.setTimeout(() => {
      nextVideo.removeEventListener("loadeddata", onReady);
      nextVideo.removeEventListener("canplay", onReady);
      reveal();
    }, DECODE_SAFETY_TIMEOUT_MS);
  }

  private clearRevealTimer(): void {
    if (this.revealTimer !== null) {
      window.clearTimeout(this.revealTimer);
      this.revealTimer = null;
    }
  }

  private clearOneShotTimer(): void {
    if (this.oneShotTimer !== null) {
      window.clearTimeout(this.oneShotTimer);
      this.oneShotTimer = null;
    }
  }

  private clearSpeechSettleTimer(): void {
    if (this.speechSettleTimer !== null) {
      window.clearTimeout(this.speechSettleTimer);
      this.speechSettleTimer = null;
    }
  }

  private clearTimers(): void {
    this.clearOneShotTimer();
    this.clearRevealTimer();
    this.clearSpeechSettleTimer();
    if (this.reducedStillTimer !== null) {
      window.clearTimeout(this.reducedStillTimer);
      this.reducedStillTimer = null;
    }
    if (this.fadeTimer !== null) {
      window.clearTimeout(this.fadeTimer);
      this.fadeTimer = null;
    }
  }

  private attachVisibilityObserver(target: HTMLElement): void {
    if (typeof IntersectionObserver === "undefined") return;
    this.observer?.disconnect();
    this.observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry) return;
        const nextVisible = entry.isIntersecting;
        if (nextVisible === this.visible) return;
        this.visible = nextVisible;
        if (!nextVisible) {
          this.pausePlayers();
          tutorVideoCoordinator.release(this.playbackOwner);
        } else if (!this.reducedMotion && !this.frozen && !this.showingStillOverride) {
          tutorVideoCoordinator.claim(this.playbackOwner, { primary: true });
          this.resumeActivePlayer();
        }
      },
      { threshold: 0.05 },
    );
    this.observer.observe(target);
  }

  private pausePlayers(): void {
    if (!this.players) return;
    for (const video of this.players) {
      video.pause?.();
    }
  }

  private resumeActivePlayer(): void {
    if (!this.players || !this.visible || this.reducedMotion || this.frozen || this.showingStillOverride) return;
    const active = this.players[this.activeSlotIndex];
    if (!active || !active.getAttribute("src")) return;
    const playResult = active.play?.();
    if (playResult && typeof playResult.catch === "function") {
      playResult.catch(() => undefined);
    }
  }

  private emitStatus(event: VideoDriverStatusEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
