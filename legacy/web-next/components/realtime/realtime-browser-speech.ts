import { tuneBuiltInVoice } from "@/components/avatar/emotion-profile";
import type { CompanionEmotion } from "@/lib/types";

const VOICE_LOAD_TIMEOUT_MS = 1200;

export interface BuiltInVoiceProfile {
  id: "genki" | "soft" | "sweet" | "healing" | "youth" | "off";
  pitch: number;
  preferredVoiceNames?: readonly string[];
  rate: number;
  voiceIndex: number;
}

export interface BrowserSpeechCallbacks {
  onComplete: () => void;
  onError: (message: string) => void;
  onLevel: (level: number) => void;
  onStart: () => void;
}

function selectBuiltInVoice(voices: SpeechSynthesisVoice[], profile: BuiltInVoiceProfile) {
  const candidates = voices
    .filter((voice) => voice.localService)
    .filter((voice) => /^zh(?:-|_)/i.test(voice.lang));
  for (const preferredName of profile.preferredVoiceNames ?? []) {
    const normalized = preferredName.trim().toLowerCase();
    const match = candidates.find((voice) =>
      voice.name.toLowerCase().includes(normalized)
      || voice.voiceURI.toLowerCase().includes(normalized)
    );
    if (match) return match;
  }
  return candidates.length ? candidates[profile.voiceIndex % candidates.length] : null;
}

export class RealtimeBrowserSpeech {
  private generation = 0;
  private mouthTimer: number | null = null;
  private pendingVoiceCleanup: (() => void) | null = null;
  private utterance: SpeechSynthesisUtterance | null = null;

  constructor(private readonly callbacks: BrowserSpeechCallbacks) {}

  hasPending() {
    return this.utterance !== null || this.pendingVoiceCleanup !== null;
  }

  cancel() {
    this.generation += 1;
    const cleanup = this.pendingVoiceCleanup;
    this.pendingVoiceCleanup = null;
    cleanup?.();
    this.stopMouthEnvelope();
    const hadSpeech = this.utterance !== null;
    this.utterance = null;
    if (hadSpeech && typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    if (cleanup || hadSpeech) this.callbacks.onLevel(0);
    return Boolean(cleanup || hadSpeech);
  }

  speak(text: string, profile: BuiltInVoiceProfile, emotion: CompanionEmotion = "neutral") {
    this.cancel();
    const generation = this.generation;
    if (profile.id === "off") return;
    if (
      typeof window === "undefined"
      || !("speechSynthesis" in window)
      || typeof window.SpeechSynthesisUtterance !== "function"
    ) {
      this.callbacks.onLevel(0);
      this.callbacks.onError("当前浏览器不支持本机语音，已保留文字回复且不会播放测试提示音。");
      return;
    }

    const start = (voice: SpeechSynthesisVoice) => this.start(text, profile, voice, generation, emotion);
    const initialVoice = selectBuiltInVoice(window.speechSynthesis.getVoices(), profile);
    if (initialVoice) {
      start(initialVoice);
      return;
    }

    let timeoutId: number | null = null;
    const cleanup = () => {
      window.speechSynthesis.removeEventListener("voiceschanged", handleVoicesChanged);
      if (timeoutId !== null) window.clearTimeout(timeoutId);
      if (this.pendingVoiceCleanup === cleanup) this.pendingVoiceCleanup = null;
    };
    const handleVoicesChanged = () => {
      if (generation !== this.generation) {
        cleanup();
        return;
      }
      const voice = selectBuiltInVoice(window.speechSynthesis.getVoices(), profile);
      if (!voice) return;
      cleanup();
      start(voice);
    };
    this.pendingVoiceCleanup = cleanup;
    window.speechSynthesis.addEventListener("voiceschanged", handleVoicesChanged);
    timeoutId = window.setTimeout(() => {
      if (generation !== this.generation) {
        cleanup();
        return;
      }
      cleanup();
      this.callbacks.onLevel(0);
      this.callbacks.onError("没有检测到本机语音，已保留文字回复且不会播放测试提示音。");
      this.callbacks.onComplete();
    }, VOICE_LOAD_TIMEOUT_MS);
    handleVoicesChanged();
  }

  private start(
    text: string,
    profile: BuiltInVoiceProfile,
    voice: SpeechSynthesisVoice,
    generation: number,
    emotion: CompanionEmotion,
  ) {
    if (generation !== this.generation) return;
    const utterance = new window.SpeechSynthesisUtterance(text);
    const tuning = tuneBuiltInVoice(profile, emotion);
    utterance.voice = voice;
    utterance.lang = voice.lang;
    utterance.pitch = tuning.pitch;
    utterance.rate = tuning.rate;
    utterance.volume = 1;
    utterance.onstart = () => {
      if (this.utterance !== utterance) return;
      this.callbacks.onStart();
      this.startMouthEnvelope();
    };
    utterance.onend = () => this.finish(utterance);
    utterance.onerror = (event) => {
      if (this.utterance !== utterance) return;
      const interrupted = event.error === "canceled" || event.error === "interrupted";
      this.finish(utterance);
      if (!interrupted) this.callbacks.onError("本机语音播放失败，文字回复仍然可用。");
    };
    this.utterance = utterance;
    try {
      window.speechSynthesis.speak(utterance);
    } catch {
      this.finish(utterance);
      this.callbacks.onError("本机语音播放失败，文字回复仍然可用。");
    }
  }

  private finish(utterance: SpeechSynthesisUtterance) {
    if (this.utterance !== utterance) return;
    this.utterance = null;
    this.stopMouthEnvelope();
    this.callbacks.onLevel(0);
    this.callbacks.onComplete();
  }

  private startMouthEnvelope() {
    this.stopMouthEnvelope();
    const startedAt = window.performance.now();
    const pulse = () => {
      const elapsed = (window.performance.now() - startedAt) / 1000;
      this.callbacks.onLevel(
        0.2
        + 0.14 * (0.5 + 0.5 * Math.sin(elapsed * 11.3))
        + 0.08 * (0.5 + 0.5 * Math.sin(elapsed * 17.7)),
      );
    };
    pulse();
    this.mouthTimer = window.setInterval(pulse, 50);
  }

  private stopMouthEnvelope() {
    if (this.mouthTimer === null) return;
    window.clearInterval(this.mouthTimer);
    this.mouthTimer = null;
  }
}
