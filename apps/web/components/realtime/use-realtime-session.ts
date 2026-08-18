"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import * as api from "@/lib/api";
import {
  INPUT_PCM16_FRAME_BYTES,
  OUTPUT_PCM16_SAMPLE_RATE,
  Pcm16MonoFramer,
  Pcm16PlaybackQueue,
  measureLevel,
} from "@/components/realtime/realtime-audio";
import {
  decodeBoardUpdatePayload,
  decodeDemoReadyPayload,
} from "@/components/realtime/realtime-types";
import { tuneBuiltInVoice } from "@/components/avatar/emotion-profile";
import {
  decodeCompanionTurn,
  toTranscriptTurn,
  type RealtimeEvent,
  type SessionState,
  type TranscriptTurn,
  decodeRealtimeEvent,
} from "@/components/realtime/realtime-types";
import {
  clearOwnerSessionToken,
  subscribeOwnerSession,
} from "@/lib/owner-session";
import {
  resolveRuntimeConfig,
  resolveRealtimeWsUrl,
  RuntimeConfigError,
} from "@/lib/runtime-config";
import type {
  BoardAction,
  CompanionEmotion,
  CompanionTurn,
  LocalTextFallbackReason,
  SessionDemoResponseWire,
  TtsPlaybackPolicy,
} from "@/lib/types";

export type { TtsPlaybackPolicy } from "@/lib/types";

const DEFAULT_COMMIT_SILENCE_MS = 700;
const BARGE_IN_MS = 250;
const DEFAULT_VAD_THRESHOLD = 0.035;
const REALTIME_CONNECT_TIMEOUT_MS = 5000;
const REALTIME_INTERRUPT_ACK_TIMEOUT_MS = 3000;
const BUILT_IN_VOICE_LOAD_TIMEOUT_MS = 1200;
const SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RESUMABLE_SESSION_STATES: ReadonlySet<string> = new Set([
  "idle",
  "listening",
  "thinking",
  "speaking",
  "interrupted",
  "error",
]);

type ConnectionStatus = "idle" | "connecting" | "connected" | "text" | "error" | "ended";

class RealtimeAuthError extends Error {}

class RealtimeSessionMissingError extends Error {}

class RealtimeCharacterUnavailableError extends Error {}

class MicPermissionDeniedError extends Error {}

function isMicrophonePermissionError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "NotAllowedError"
  );
}

type StreamTurnFn = (
  sessionId: string,
  text: string,
  onEvent: (event: RealtimeEvent) => void,
) => Promise<unknown>;

export type DemoNarrationResult = "completed" | "stopped";

export interface BuiltInVoiceProfile {
  id: "genki" | "soft" | "sweet" | "healing" | "youth" | "off";
  pitch: number;
  preferredVoiceNames?: readonly string[];
  rate: number;
  voiceIndex: number;
}

interface DemoNarrationRequest {
  characterId: string;
  text: string;
  voiceId?: string;
  speakingRate?: number;
}

interface UseRealtimeSessionResult {
  audioLevel: number;
  avatarEmotion: CompanionEmotion;
  canPushToTalk: boolean;
  connectionStatus: ConnectionStatus;
  currentBoardActions: BoardAction[];
  error: string | null;
  demo: SessionDemoResponseWire | null;
  demoAudioStopToken: number;
  demoError: string | null;
  hasRemoteTurn: boolean;
  isDemoLoading: boolean;
  isMuted: boolean;
  isPushToTalkActive: boolean;
  isSessionHydrating: boolean;
  isSendingText: boolean;
  partialCaption: string;
  playbackAudioLevel: number;
  pushToTalkStatus: "idle" | "recording" | "sent";
  sessionCharacterId: string | null;
  sessionId: string | null;
  sessionState: SessionState;
  transcript: TranscriptTurn[];
  ttsPlaybackPolicy: TtsPlaybackPolicy | null;
  commitSilenceMs: number;
  setCommitSilenceMs: (value: number) => void;
  connect: () => Promise<void>;
  clearDemo: () => Promise<void>;
  disconnect: () => Promise<void>;
  interrupt: () => void;
  cancelPushToTalk: () => void;
  playDemoNarration: (input: DemoNarrationRequest) => Promise<DemoNarrationResult>;
  requestDemo: (topic: string) => Promise<boolean>;
  sendText: (message: string) => Promise<boolean>;
  startPushToTalk: () => boolean;
  stopDemoNarration: () => Promise<void>;
  stopPushToTalk: () => void;
  toggleMute: () => void;
}

function selectBuiltInVoice(voices: SpeechSynthesisVoice[], profile: BuiltInVoiceProfile) {
  const localVoices = voices.filter((voice) => voice.localService);
  const candidates = localVoices.filter((voice) => /^zh(?:-|_)/i.test(voice.lang));
  for (const preferredName of profile.preferredVoiceNames ?? []) {
    const normalized = preferredName.trim().toLowerCase();
    const matchingVoice = candidates.find((voice) =>
      voice.name.toLowerCase().includes(normalized) ||
      voice.voiceURI.toLowerCase().includes(normalized)
    );
    if (matchingVoice) {
      return matchingVoice;
    }
  }
  return candidates.length ? candidates[profile.voiceIndex % candidates.length] : null;
}

function payloadText(event: RealtimeEvent) {
  return typeof event.payload.text === "string" ? event.payload.text : "";
}

function payloadMessage(event: RealtimeEvent) {
  if (typeof event.payload.message === "string") {
    return event.payload.message;
  }
  if (typeof event.payload.detail === "string") {
    return event.payload.detail;
  }
  return payloadText(event);
}

function payloadCode(event: RealtimeEvent) {
  return typeof event.payload.code === "string" ? event.payload.code : null;
}

function formatErrorMessage(message: string, code?: string | null) {
  return code ? `${message}（${code}）` : message;
}

function formatSpeechFallbackMessage(message: string) {
  return `${message} 语音已降级为文字模式，不会静默切换到其他 provider 或 Mock。`;
}

function formatMicDeniedMessage() {
  return formatSpeechFallbackMessage(
    "麦克风权限被拒绝，请在浏览器站点设置中允许麦克风后重试；当前仍可输入文字。",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function formatRequestError(error: unknown, fallback: string) {
  if (error instanceof api.ApiError) {
    const details = error.details;
    if (isRecord(details)) {
      const detail =
        typeof details.detail === "string"
          ? details.detail
          : typeof details.message === "string"
            ? details.message
            : error.message;
      const code = typeof details.code === "string" ? details.code : null;
      return formatErrorMessage(detail, code);
    }
    return error.message;
  }
  return error instanceof Error ? error.message : fallback;
}

function getStreamTurn() {
  return (api as unknown as { streamTurn?: StreamTurnFn }).streamTurn ?? null;
}

function createAudioWorkletModuleSource() {
  return `
    class PulseProcessor extends AudioWorkletProcessor {
      constructor() {
        super();
        const renderQuantumSamples = 128;
        const targetSamples = sampleRate * 0.02;
        this.batchSamples = Math.max(
          renderQuantumSamples,
          Math.ceil(targetSamples / renderQuantumSamples) * renderQuantumSamples,
        );
        this.pcm = new Float32Array(this.batchSamples);
        this.offset = 0;
        this.sum = 0;
      }

      process(inputs) {
        const channel = inputs[0]?.[0];
        if (!channel || channel.length === 0) {
          return true;
        }

        for (let index = 0; index < channel.length; index += 1) {
          const sample = channel[index];
          this.sum += sample * sample;
          this.pcm[this.offset] = sample;
          this.offset += 1;

          if (this.offset === this.batchSamples) {
            const pcm = this.pcm;
            const level = Math.sqrt(this.sum / this.batchSamples);
            this.pcm = new Float32Array(this.batchSamples);
            this.offset = 0;
            this.sum = 0;
            this.port.postMessage({ level, pcm }, [pcm.buffer]);
          }
        }
        return true;
      }
    }
    registerProcessor("pulse-processor", PulseProcessor);
  `;
}

function useEventCallback<TArgs extends unknown[], TResult>(
  callback: (...args: TArgs) => TResult,
): (...args: TArgs) => TResult {
  const callbackRef = useRef(callback);

  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  return useCallback((...args: TArgs) => callbackRef.current(...args), []);
}

export function useRealtimeSession(
  spaceId: string,
  initialSessionId?: string | null,
  selectedCharacterId?: string,
  builtInVoiceProfile?: BuiltInVoiceProfile | null,
): UseRealtimeSessionResult {
  const [audioLevel, setAudioLevel] = useState(0);
  const [avatarEmotion, setAvatarEmotion] = useState<CompanionEmotion>("neutral");
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("idle");
  const [currentBoardActions, setCurrentBoardActions] = useState<BoardAction[]>([]);
  const [demo, setDemo] = useState<SessionDemoResponseWire | null>(null);
  const [demoAudioStopToken, setDemoAudioStopToken] = useState(0);
  const [demoError, setDemoError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hasRemoteTurn, setHasRemoteTurn] = useState(false);
  const [isDemoLoading, setIsDemoLoading] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [isPushToTalkActive, setIsPushToTalkActive] = useState(false);
  const [isPushToTalkAwaitingInterrupt, setIsPushToTalkAwaitingInterrupt] = useState(false);
  const [isSessionHydrating, setIsSessionHydrating] = useState(
    Boolean(initialSessionId?.trim()),
  );
  const [isSendingText, setIsSendingText] = useState(false);
  const [partialCaption, setPartialCaption] = useState("");
  const [playbackAudioLevel, setPlaybackAudioLevel] = useState(0);
  const [pushToTalkStatus, setPushToTalkStatus] = useState<"idle" | "recording" | "sent">("idle");
  const [sessionCharacterId, setSessionCharacterId] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionState, setSessionState] = useState<SessionState>("idle");
  const [transcript, setTranscript] = useState<TranscriptTurn[]>([]);
  const [ttsPlaybackPolicy, setTtsPlaybackPolicy] = useState<TtsPlaybackPolicy | null>(null);
  const [commitSilenceMs, setCommitSilenceMs] = useState(DEFAULT_COMMIT_SILENCE_MS);

  const captureContextRef = useRef<AudioContext | null>(null);
  const captureNodeRef = useRef<AudioWorkletNode | ScriptProcessorNode | null>(null);
  const bargeInStartedAtRef = useRef<number | null>(null);
  const bargeInTriggeredRef = useRef(false);
  const demoFetchAbortControllerRef = useRef<AbortController | null>(null);
  const demoPlaybackResolverRef = useRef<((result: DemoNarrationResult) => void) | null>(null);
  const firstAudioStartedAtRef = useRef<number | null>(null);
  const intentionallyClosedSocketsRef = useRef(new WeakSet<WebSocket>());
  const connectionStatusRef = useRef<ConnectionStatus>("idle");
  const lastVoiceAtRef = useRef<number | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const partialAssistantRef = useRef("");
  const pendingTtsChunkRef = useRef(false);
  const pageLifecycleActiveRef = useRef(
    typeof document === "undefined" || document.visibilityState !== "hidden",
  );
  const pageLifecycleGenerationRef = useRef(0);
  const remoteTurnActiveRef = useRef(false);
  const playbackQueueRef = useRef<Pcm16PlaybackQueue | null>(null);
  const builtInSpeechRef = useRef<SpeechSynthesisUtterance | null>(null);
  const builtInMouthTimerRef = useRef<number | null>(null);
  const configuredBuiltInVoiceProfileRef = useRef(builtInVoiceProfile);
  const serverTtsPlaybackPolicyRef = useRef<TtsPlaybackPolicy | null>(null);
  const builtInSpeechGenerationRef = useRef(0);
  const pendingBuiltInVoiceCleanupRef = useRef<(() => void) | null>(null);
  const discardServerTtsChunkCountRef = useRef(0);
  const serverTtsFinishedRef = useRef(true);
  const pcmFramerRef = useRef<Pcm16MonoFramer | null>(null);
  const deferredPushToTalkCommitRef = useRef<(() => void) | null>(null);
  const pushToTalkActiveRef = useRef(false);
  const pushToTalkAwaitingInterruptRef = useRef(false);
  const pushToTalkInterruptTimeoutRef = useRef<number | null>(null);
  const requiresFreshSessionRef = useRef(false);
  const sessionCreationRef = useRef<Promise<string> | null>(null);
  const sessionGenerationRef = useRef(0);
  const sessionHydrationRef = useRef<Promise<void> | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const selectedCharacterIdRef = useRef(selectedCharacterId);
  const socketRef = useRef<WebSocket | null>(null);
  const speechFrameCountRef = useRef(0);
  const speechStartedAtRef = useRef<number | null>(null);
  const stateRef = useRef<SessionState>("idle");
  const localMetricSignalsRef = useRef(new Map<string, Set<string>>());
  const textRequestInFlightRef = useRef(false);
  const waitingForTtsDrainRef = useRef(false);

  selectedCharacterIdRef.current = selectedCharacterId;
  configuredBuiltInVoiceProfileRef.current = builtInVoiceProfile;

  const activeBuiltInVoiceProfile = () =>
    serverTtsPlaybackPolicyRef.current === "browser-compat"
      ? configuredBuiltInVoiceProfileRef.current
      : null;

  useEffect(() => {
    if (
      !builtInVoiceProfile ||
      builtInVoiceProfile.id === "off" ||
      typeof window === "undefined" ||
      !("speechSynthesis" in window)
    ) {
      return;
    }
    window.speechSynthesis.getVoices();
  }, [builtInVoiceProfile]);

  useEffect(() => {
    connectionStatusRef.current = connectionStatus;
  }, [connectionStatus]);

  const updateConnectionStatus = useCallback((status: ConnectionStatus) => {
    connectionStatusRef.current = status;
    setConnectionStatus(status);
  }, []);

  const updateRemoteTurnActive = useCallback((active: boolean) => {
    remoteTurnActiveRef.current = active;
    setHasRemoteTurn(active);
  }, []);

  const updatePushToTalkActive = useCallback((active: boolean) => {
    pushToTalkActiveRef.current = active;
    setIsPushToTalkActive(active);
  }, []);

  const updatePushToTalkAwaitingInterrupt = useCallback((waiting: boolean) => {
    pushToTalkAwaitingInterruptRef.current = waiting;
    setIsPushToTalkAwaitingInterrupt(waiting);
  }, []);

  const resolvePushToTalkInterrupt = useEventCallback(() => {
    if (pushToTalkInterruptTimeoutRef.current !== null) {
      window.clearTimeout(pushToTalkInterruptTimeoutRef.current);
      pushToTalkInterruptTimeoutRef.current = null;
    }
    updatePushToTalkAwaitingInterrupt(false);
    const deferredCommit = deferredPushToTalkCommitRef.current;
    deferredPushToTalkCommitRef.current = null;
    if (deferredCommit) {
      deferredCommit();
      return;
    }
    if (pushToTalkActiveRef.current) {
      stateRef.current = "listening";
      setSessionState("listening");
    }
  });

  useEffect(() => {
    stateRef.current = sessionState;
  }, [sessionState]);

  const hasRecordedLocalMetricSignal = useEventCallback(
    (
      sessionIdentifier: string,
      event: "interrupt_latency_ms" | "first_audio_latency_ms" | "avatar_fps" | "text_fallback_used",
    ) =>
      localMetricSignalsRef.current.get(sessionIdentifier)?.has(event) ?? false,
  );

  const recordLocalMetricSignal = useEventCallback(
    (
      signal:
        | { event: "interrupt_latency_ms" | "first_audio_latency_ms" | "avatar_fps"; session_id: string; value: number }
        | { event: "audio_residue_scan"; session_id: string; residue_found: boolean }
        | { event: "text_fallback_used"; session_id: string; code: LocalTextFallbackReason },
    ) => {
      const sessionIdentifier = signal.session_id.trim();
      if (!sessionIdentifier) {
        return;
      }
      if (
        signal.event === "interrupt_latency_ms" ||
        signal.event === "first_audio_latency_ms" ||
        signal.event === "avatar_fps" ||
        signal.event === "text_fallback_used"
      ) {
        const existing = localMetricSignalsRef.current.get(sessionIdentifier) ?? new Set<string>();
        if (existing.has(signal.event)) {
          return;
        }
        existing.add(signal.event);
        localMetricSignalsRef.current.set(sessionIdentifier, existing);
      }
      void api.postLocalMetricSignalSafe(signal);
    },
  );

  const recordTextFallbackSignal = useEventCallback(
    (sessionIdentifier: string, code: LocalTextFallbackReason) => {
      if (!sessionIdentifier.trim()) {
        return;
      }
      if (hasRecordedLocalMetricSignal(sessionIdentifier, "text_fallback_used")) {
        return;
      }
      recordLocalMetricSignal({
        event: "text_fallback_used",
        session_id: sessionIdentifier,
        code,
      });
    },
  );

  const clearFirstAudioMeasurement = useEventCallback(() => {
    firstAudioStartedAtRef.current = null;
  });

  const beginFirstAudioMeasurement = useEventCallback(() => {
    const currentSessionId = sessionIdRef.current;
    if (!currentSessionId || hasRecordedLocalMetricSignal(currentSessionId, "first_audio_latency_ms")) {
      return;
    }
    firstAudioStartedAtRef.current = performance.now();
  });

  const maybeRecordFirstAudioLatency = useEventCallback((scheduledDelayMs: number = 0) => {
    const startedAt = firstAudioStartedAtRef.current;
    const currentSessionId = sessionIdRef.current;
    if (
      startedAt === null ||
      !currentSessionId ||
      hasRecordedLocalMetricSignal(currentSessionId, "first_audio_latency_ms")
    ) {
      return;
    }
    clearFirstAudioMeasurement();
    recordLocalMetricSignal({
      event: "first_audio_latency_ms",
      session_id: currentSessionId,
      value: Math.max(0, Math.round(performance.now() - startedAt + scheduledDelayMs)),
    });
  });

  const recordInterruptLatencyAfterStop = useEventCallback((startedAt: number) => {
    const currentSessionId = sessionIdRef.current;
    if (!currentSessionId || hasRecordedLocalMetricSignal(currentSessionId, "interrupt_latency_ms")) {
      return;
    }
    const poll = () => {
      if (playbackQueueRef.current?.hasPendingAudio()) {
        window.requestAnimationFrame(poll);
        return;
      }
      recordLocalMetricSignal({
        event: "interrupt_latency_ms",
        session_id: currentSessionId,
        value: Math.max(0, Math.round(performance.now() - startedAt)),
      });
    };
    window.requestAnimationFrame(poll);
  });

  const stopPlaybackForUserInterrupt = useEventCallback(() => {
    const currentSessionId = sessionIdRef.current;
    const shouldMeasure =
      Boolean(currentSessionId) &&
      !hasRecordedLocalMetricSignal(currentSessionId ?? "", "interrupt_latency_ms") &&
      (
        playbackQueueRef.current?.hasPendingAudio() === true ||
        demoFetchAbortControllerRef.current !== null ||
        demoPlaybackResolverRef.current !== null ||
        stateRef.current === "speaking"
      );
    const startedAt = shouldMeasure ? performance.now() : null;
    stopPlayback();
    clearFirstAudioMeasurement();
    if (startedAt !== null) {
      recordInterruptLatencyAfterStop(startedAt);
    }
  });

  const appendTurn = useEventCallback((turn: TranscriptTurn) => {
    setTranscript((current) => {
      const existingIndex = current.findIndex((item) => item.id === turn.id);
      if (existingIndex < 0) {
        return [...current, turn];
      }
      return current.map((item, index) => (index === existingIndex ? turn : item));
    });
  });

  const finishInterruptedAssistantTurn = useEventCallback(() => {
    const text = partialAssistantRef.current.trim();
    if (text) {
      appendTurn({
        id: `assistant-interrupted-${Date.now()}`,
        role: "assistant",
        text,
        status: "interrupted",
      });
    }
    partialAssistantRef.current = "";
    setPartialCaption("");
  });

  const resetVoiceTracking = useEventCallback(() => {
    bargeInStartedAtRef.current = null;
    bargeInTriggeredRef.current = false;
    lastVoiceAtRef.current = null;
    speechFrameCountRef.current = 0;
    speechStartedAtRef.current = null;
    pcmFramerRef.current?.reset();
  });

  const cancelPushToTalk = useEventCallback(() => {
    if (
      !pushToTalkActiveRef.current &&
      !pushToTalkAwaitingInterruptRef.current &&
      deferredPushToTalkCommitRef.current === null
    ) {
      return;
    }
    if (speechFrameCountRef.current > 0) {
      const currentSessionId = sessionIdRef.current;
      const socket = socketRef.current;
      if (currentSessionId && socket?.readyState === WebSocket.OPEN) {
        socket.send(
          JSON.stringify({
            type: "turn.interrupt",
            session_id: currentSessionId,
            state: stateRef.current,
            payload: { clear_audio_buffer: true },
          }),
        );
      }
    }
    deferredPushToTalkCommitRef.current = null;
    if (pushToTalkInterruptTimeoutRef.current !== null) {
      window.clearTimeout(pushToTalkInterruptTimeoutRef.current);
      pushToTalkInterruptTimeoutRef.current = null;
    }
    updatePushToTalkAwaitingInterrupt(false);
    updatePushToTalkActive(false);
    setPushToTalkStatus("idle");
    resetVoiceTracking();
    setPartialCaption("");
    if (stateRef.current === "listening") {
      setSessionState("idle");
    }
  });

  const finalizeSpeakingIfDrained = useEventCallback(() => {
    if (!waitingForTtsDrainRef.current) {
      return;
    }
    if (playbackQueueRef.current?.hasPendingAudio()) {
      return;
    }
    waitingForTtsDrainRef.current = false;
    pendingTtsChunkRef.current = false;
    updateRemoteTurnActive(false);
    setPartialCaption("");
    if (stateRef.current === "speaking") {
      setSessionState("idle");
    }
  });

  const settleDemoNarration = useEventCallback((
    result: DemoNarrationResult,
    { bumpStopToken }: { bumpStopToken: boolean },
  ) => {
    demoFetchAbortControllerRef.current?.abort();
    demoFetchAbortControllerRef.current = null;
    demoPlaybackResolverRef.current?.(result);
    demoPlaybackResolverRef.current = null;
    if (bumpStopToken) {
      setDemoAudioStopToken((current) => current + 1);
    }
    if (!pendingTtsChunkRef.current) {
      setPlaybackAudioLevel(0);
      setPartialCaption("");
      if (stateRef.current === "speaking") {
        setSessionState("idle");
      }
    }
  });

  const finalizeDemoNarrationIfDrained = useEventCallback(() => {
    if (!demoPlaybackResolverRef.current) {
      return;
    }
    if (playbackQueueRef.current?.hasPendingAudio()) {
      return;
    }
    settleDemoNarration("completed", { bumpStopToken: false });
  });

  const ensurePlaybackQueue = useEventCallback(() => {
    if (!playbackQueueRef.current) {
      playbackQueueRef.current = new Pcm16PlaybackQueue(
        undefined,
        () => {
          finalizeSpeakingIfDrained();
          finalizeDemoNarrationIfDrained();
        },
        (level) => {
          setPlaybackAudioLevel(level);
        },
        (scheduledDelayMs: number) => {
          maybeRecordFirstAudioLatency(scheduledDelayMs);
        },
      );
    }
    return playbackQueueRef.current;
  });

  const finalizeBuiltInTurnIfComplete = useEventCallback(() => {
    if (
      !serverTtsFinishedRef.current ||
      builtInSpeechRef.current !== null ||
      pendingBuiltInVoiceCleanupRef.current !== null
    ) {
      return;
    }
    updateRemoteTurnActive(false);
    setPlaybackAudioLevel(0);
    setPartialCaption("");
    if (stateRef.current === "speaking" || stateRef.current === "thinking") {
      stateRef.current = "idle";
      setSessionState("idle");
    }
  });

  const stopBuiltInMouthEnvelope = useEventCallback(() => {
    if (builtInMouthTimerRef.current !== null) {
      window.clearInterval(builtInMouthTimerRef.current);
      builtInMouthTimerRef.current = null;
    }
  });

  const startBuiltInMouthEnvelope = useEventCallback(() => {
    stopBuiltInMouthEnvelope();
    if (typeof window === "undefined") {
      return;
    }
    const startedAt = window.performance.now();
    const pulse = () => {
      const elapsed = (window.performance.now() - startedAt) / 1000;
      const level = 0.2
        + 0.14 * (0.5 + 0.5 * Math.sin(elapsed * 11.3))
        + 0.08 * (0.5 + 0.5 * Math.sin(elapsed * 17.7));
      setPlaybackAudioLevel(level);
    };
    pulse();
    builtInMouthTimerRef.current = window.setInterval(pulse, 50);
  });

  const cancelBuiltInSpeech = useEventCallback(() => {
    builtInSpeechGenerationRef.current += 1;
    const pendingCleanup = pendingBuiltInVoiceCleanupRef.current;
    pendingBuiltInVoiceCleanupRef.current = null;
    pendingCleanup?.();
    stopBuiltInMouthEnvelope();

    const hadSpeech = builtInSpeechRef.current !== null;
    builtInSpeechRef.current = null;
    if (hadSpeech && typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    if (pendingCleanup || hadSpeech) {
      setPlaybackAudioLevel(0);
    }
    return Boolean(pendingCleanup || hadSpeech);
  });

  const finishBuiltInSpeech = useEventCallback((utterance: SpeechSynthesisUtterance) => {
    if (builtInSpeechRef.current !== utterance) {
      return;
    }
    builtInSpeechRef.current = null;
    stopBuiltInMouthEnvelope();
    setPlaybackAudioLevel(0);
    finalizeBuiltInTurnIfComplete();
  });

  const startBuiltInSpeech = useEventCallback((
    text: string,
    profile: BuiltInVoiceProfile,
    voice: SpeechSynthesisVoice,
    generation: number,
    emotion: CompanionEmotion = "neutral",
  ) => {
    if (
      generation !== builtInSpeechGenerationRef.current ||
      typeof window === "undefined" ||
      typeof window.SpeechSynthesisUtterance !== "function"
    ) {
      return;
    }

    const utterance = new window.SpeechSynthesisUtterance(text);
    utterance.voice = voice;
    utterance.lang = voice.lang;
    const tuning = tuneBuiltInVoice(profile, emotion);
    utterance.pitch = tuning.pitch;
    utterance.rate = tuning.rate;
    utterance.volume = 1;
    utterance.onstart = () => {
      if (builtInSpeechRef.current !== utterance) {
        return;
      }
      maybeRecordFirstAudioLatency(0);
      stateRef.current = "speaking";
      setSessionState("speaking");
      startBuiltInMouthEnvelope();
    };
    utterance.onend = () => finishBuiltInSpeech(utterance);
    utterance.onerror = (event) => {
      if (builtInSpeechRef.current !== utterance) {
        return;
      }
      const interrupted = event.error === "canceled" || event.error === "interrupted";
      finishBuiltInSpeech(utterance);
      if (!interrupted) {
        setError("本机语音播放失败，文字回复仍然可用。");
      }
    };

    builtInSpeechRef.current = utterance;
    updateRemoteTurnActive(true);
    stateRef.current = "speaking";
    setSessionState("speaking");
    try {
      window.speechSynthesis.speak(utterance);
    } catch {
      finishBuiltInSpeech(utterance);
      setError("本机语音播放失败，文字回复仍然可用。");
    }
  });

  const speakWithBuiltInVoice = useEventCallback((text: string, emotion: CompanionEmotion = "neutral") => {
    const profile = activeBuiltInVoiceProfile();
    if (!profile) {
      return false;
    }
    serverTtsFinishedRef.current = false;
    cancelBuiltInSpeech();
    const generation = builtInSpeechGenerationRef.current;
    if (profile.id === "off") {
      setPlaybackAudioLevel(0);
      clearFirstAudioMeasurement();
      return true;
    }
    if (
      typeof window === "undefined" ||
      !("speechSynthesis" in window) ||
      typeof window.SpeechSynthesisUtterance !== "function"
    ) {
      setPlaybackAudioLevel(0);
      clearFirstAudioMeasurement();
      setError("当前浏览器不支持本机语音，已保留文字回复且不会播放测试提示音。");
      return true;
    }

    const initialVoice = selectBuiltInVoice(
      window.speechSynthesis.getVoices(),
      profile,
    );
    if (initialVoice) {
      startBuiltInSpeech(text, profile, initialVoice, generation, emotion);
      return true;
    }

    let timeoutId: number | null = null;
    const cleanup = () => {
      window.speechSynthesis.removeEventListener("voiceschanged", handleVoicesChanged);
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
      if (pendingBuiltInVoiceCleanupRef.current === cleanup) {
        pendingBuiltInVoiceCleanupRef.current = null;
      }
    };
    const handleVoicesChanged = () => {
      if (generation !== builtInSpeechGenerationRef.current) {
        cleanup();
        return;
      }
      const voice = selectBuiltInVoice(
        window.speechSynthesis.getVoices(),
        profile,
      );
      if (!voice) {
        return;
      }
      cleanup();
      startBuiltInSpeech(text, profile, voice, generation, emotion);
    };

    pendingBuiltInVoiceCleanupRef.current = cleanup;
    window.speechSynthesis.addEventListener("voiceschanged", handleVoicesChanged);
    timeoutId = window.setTimeout(() => {
      if (generation !== builtInSpeechGenerationRef.current) {
        cleanup();
        return;
      }
      cleanup();
      setPlaybackAudioLevel(0);
      clearFirstAudioMeasurement();
      setError("没有检测到本机语音，已保留文字回复且不会播放测试提示音。");
      finalizeBuiltInTurnIfComplete();
    }, BUILT_IN_VOICE_LOAD_TIMEOUT_MS);
    handleVoicesChanged();
    return true;
  });

  const stopPlayback = useEventCallback(() => {
    waitingForTtsDrainRef.current = false;
    pendingTtsChunkRef.current = false;
    cancelBuiltInSpeech();
    playbackQueueRef.current?.clear();
    setPlaybackAudioLevel(0);
    clearFirstAudioMeasurement();
    setPushToTalkStatus("idle");
  });

  const stopAudioCapture = useEventCallback(() => {
    deferredPushToTalkCommitRef.current = null;
    if (pushToTalkInterruptTimeoutRef.current !== null) {
      window.clearTimeout(pushToTalkInterruptTimeoutRef.current);
      pushToTalkInterruptTimeoutRef.current = null;
    }
    updatePushToTalkAwaitingInterrupt(false);
    updatePushToTalkActive(false);
    setPushToTalkStatus("idle");
    captureNodeRef.current?.disconnect();
    captureNodeRef.current = null;
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;
    void captureContextRef.current?.close();
    captureContextRef.current = null;
    setAudioLevel(0);
    setPlaybackAudioLevel(0);
    resetVoiceTracking();
  });

  const stopRealtimeMedia = useEventCallback(() => {
    serverTtsFinishedRef.current = true;
    stopPlayback();
    stopAudioCapture();
  });

  useEffect(() => {
    const handleBackground = () => {
      if (!pageLifecycleActiveRef.current) {
        return;
      }
      pageLifecycleActiveRef.current = false;
      pageLifecycleGenerationRef.current += 1;

      const socket = socketRef.current;
      if (socket) {
        intentionallyClosedSocketsRef.current.add(socket);
        socket.close(1000, "Page moved to the background");
        socketRef.current = null;
      }
      stopRealtimeMedia();
      settleDemoNarration("stopped", { bumpStopToken: true });
      updateRemoteTurnActive(false);
      if (
        connectionStatusRef.current === "connected" ||
        connectionStatusRef.current === "connecting"
      ) {
        updateConnectionStatus("text");
        stateRef.current = "idle";
        setSessionState("idle");
      }
    };
    const handleForeground = () => {
      pageLifecycleActiveRef.current = true;
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        handleBackground();
      } else {
        handleForeground();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    document.addEventListener("freeze", handleBackground);
    document.addEventListener("resume", handleForeground);
    window.addEventListener("pagehide", handleBackground);
    window.addEventListener("pageshow", handleForeground);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      document.removeEventListener("freeze", handleBackground);
      document.removeEventListener("resume", handleForeground);
      window.removeEventListener("pagehide", handleBackground);
      window.removeEventListener("pageshow", handleForeground);
    };
  }, [
    settleDemoNarration,
    stopRealtimeMedia,
    updateConnectionStatus,
    updateRemoteTurnActive,
  ]);

  useEffect(() => {
    const requestedSessionId = initialSessionId?.trim() ?? "";
    const generation = sessionGenerationRef.current + 1;
    sessionGenerationRef.current = generation;
    let cancelled = false;

    sessionIdRef.current = null;
    serverTtsPlaybackPolicyRef.current = null;
    requiresFreshSessionRef.current = false;
    discardServerTtsChunkCountRef.current = 0;
    serverTtsFinishedRef.current = true;
    stateRef.current = "idle";
    setSessionId(null);
    setTtsPlaybackPolicy(null);
    setSessionCharacterId(null);
    setSessionState("idle");
    setTranscript([]);
    setCurrentBoardActions([]);
    setAvatarEmotion("neutral");
    setPartialCaption("");
    setError(null);
    setDemo(null);
    setDemoError(null);
    setIsDemoLoading(false);
    partialAssistantRef.current = "";
    updateRemoteTurnActive(false);
    updateConnectionStatus("idle");

    const socket = socketRef.current;
    if (socket) {
      intentionallyClosedSocketsRef.current.add(socket);
      socket.close();
      socketRef.current = null;
    }
    stopRealtimeMedia();
    settleDemoNarration("stopped", { bumpStopToken: true });

    if (!requestedSessionId) {
      sessionHydrationRef.current = null;
      setIsSessionHydrating(false);
      return () => {
        cancelled = true;
      };
    }

    if (!SESSION_ID_PATTERN.test(requestedSessionId)) {
      sessionHydrationRef.current = null;
      setIsSessionHydrating(false);
      setError("链接中的会话 ID 格式无效，已拒绝恢复。");
      return () => {
        cancelled = true;
      };
    }

    setIsSessionHydrating(true);
    const pending = (async () => {
      try {
        const restored = await api.getSession(requestedSessionId);
        if (cancelled || generation !== sessionGenerationRef.current) {
          return;
        }
        if (restored.id !== requestedSessionId) {
          throw new Error("服务端返回了不同的会话，已拒绝恢复。");
        }
        if (restored.space_id !== spaceId) {
          throw new Error("链接中的会话不属于当前空间，已拒绝恢复。");
        }
        if (restored.state === "closed") {
          throw new Error("链接中的会话已经结束，请从复盘页查看记录或开始新会话。");
        }
        if (!RESUMABLE_SESSION_STATES.has(restored.state)) {
          throw new Error("服务端返回了无效的会话状态，已拒绝恢复。");
        }
        if (
          restored.character_pack_id !== null &&
          (typeof restored.character_pack_id !== "string" ||
            restored.character_pack_id.trim() === "")
        ) {
          throw new Error("服务端返回了无效的会话角色绑定，已拒绝恢复。");
        }

        const decodedTurns: CompanionTurn[] = [];
        for (const value of restored.transcript) {
          const turn = decodeCompanionTurn(value);
          if (
            !turn ||
            turn.session_id !== restored.id ||
            turn.space_id !== spaceId
          ) {
            throw new Error("会话字幕包含不属于当前空间或会话的数据，已拒绝恢复。");
          }
          decodedTurns.push(turn);
        }

        let foundAssistant = false;
        let lastAssistantEmotion: CompanionEmotion = "neutral";
        let lastBoardActions: BoardAction[] = [];
        for (let index = decodedTurns.length - 1; index >= 0; index -= 1) {
          const turn = decodedTurns[index];
          if (!foundAssistant && turn.role === "assistant") {
            foundAssistant = true;
            lastAssistantEmotion = turn.emotion;
          }
          if (!lastBoardActions.length && turn.board_actions?.length) {
            lastBoardActions = turn.board_actions;
          }
          if (foundAssistant && lastBoardActions.length) {
            break;
          }
        }

        sessionIdRef.current = restored.id;
        serverTtsPlaybackPolicyRef.current = restored.tts_playback_policy ?? null;
        stateRef.current = restored.state;
        setSessionId(restored.id);
        setTtsPlaybackPolicy(restored.tts_playback_policy ?? null);
        setSessionCharacterId(restored.character_pack_id);
        setSessionState(restored.state);
        setTranscript(decodedTurns.map(toTranscriptTurn));
        setCurrentBoardActions(lastBoardActions);
        setAvatarEmotion(lastAssistantEmotion);
        updateConnectionStatus("text");
        setError(null);
      } catch (loadError) {
        if (cancelled || generation !== sessionGenerationRef.current) {
          return;
        }
        setError(formatRequestError(loadError, "会话恢复失败。"));
      } finally {
        if (generation === sessionGenerationRef.current) {
          if (!cancelled) {
            setIsSessionHydrating(false);
          }
          sessionHydrationRef.current = null;
        }
      }
    })();
    sessionHydrationRef.current = pending;

    return () => {
      cancelled = true;
    };
  }, [
    initialSessionId,
    settleDemoNarration,
    spaceId,
    stopRealtimeMedia,
    updateConnectionStatus,
    updateRemoteTurnActive,
  ]);

  const markFreshSessionRequired = useEventCallback(() => {
    requiresFreshSessionRef.current = true;
    setAvatarEmotion("neutral");
  });

  const ensureSession = useEventCallback(async (forceFresh = false) => {
    if (sessionHydrationRef.current) {
      await sessionHydrationRef.current;
    }
    if (!forceFresh && !requiresFreshSessionRef.current && sessionIdRef.current) {
      return sessionIdRef.current;
    }
    if (sessionCreationRef.current) {
      if (!forceFresh && !requiresFreshSessionRef.current) {
        return sessionCreationRef.current;
      }
      throw new Error("上一条会话仍在创建中，请稍后再试。");
    }

    const previousSessionId = sessionIdRef.current;
    const shouldRotate = forceFresh || requiresFreshSessionRef.current;
    const generation = sessionGenerationRef.current + 1;
    sessionGenerationRef.current = generation;
    requiresFreshSessionRef.current = false;
    sessionIdRef.current = null;
    serverTtsPlaybackPolicyRef.current = null;
    stateRef.current = "idle";
    setSessionId(null);
    setTtsPlaybackPolicy(null);
    setSessionCharacterId(null);
    setAvatarEmotion("neutral");
    updateRemoteTurnActive(false);
    setTranscript([]);
    setCurrentBoardActions([]);
    setDemo(null);
    setDemoError(null);
    setIsDemoLoading(false);
    setPartialCaption("");
    setPushToTalkStatus("idle");
    partialAssistantRef.current = "";
    clearFirstAudioMeasurement();

    const pending = (async () => {
      if (shouldRotate && previousSessionId) {
        try {
          await api.endSession(previousSessionId);
        } catch (cleanupError) {
          console.error("Failed to close the previous realtime session before rotation.", {
            sessionId: previousSessionId,
            error: cleanupError,
          });
        }
      }

      const requestedCharacterId = selectedCharacterIdRef.current?.trim();
      const created = await api.createSession({
        space_id: spaceId,
        ...(requestedCharacterId ? { character_pack_id: requestedCharacterId } : {}),
      });
      if (created.space_id !== spaceId) {
        throw new Error("服务端创建的会话不属于当前空间，已拒绝继续发送。");
      }
      if (generation !== sessionGenerationRef.current) {
        try {
          await api.endSession(created.id);
        } catch (cleanupError) {
          throw new Error("已取消的新会话无法在服务端关闭。", {
            cause: cleanupError,
          });
        }
        throw new Error("会话创建期间页面状态已变化，已取消使用该会话。");
      }
      sessionIdRef.current = created.id;
      serverTtsPlaybackPolicyRef.current = created.tts_playback_policy ?? null;
      stateRef.current = created.state;
      setSessionId(created.id);
      setTtsPlaybackPolicy(created.tts_playback_policy ?? null);
      setSessionCharacterId(created.character_pack_id);
      setSessionState(created.state);
      return created.id;
    })();

    sessionCreationRef.current = pending;
    try {
      return await pending;
    } finally {
      sessionCreationRef.current = null;
    }
  });

  const sendSocketEvent = useEventCallback((type: string, payload: Record<string, unknown> = {}) => {
    const currentSessionId = sessionIdRef.current;
    const socket = socketRef.current;
    if (!currentSessionId || !socket || socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    socket.send(
      JSON.stringify({
        type,
        session_id: currentSessionId,
        state: stateRef.current,
        payload,
      }),
    );
    return true;
  });

  const handleRealtimeBinaryMessage = useEventCallback((chunk: ArrayBuffer) => {
    if (discardServerTtsChunkCountRef.current > 0) {
      discardServerTtsChunkCountRef.current -= 1;
      return;
    }
    if (!pendingTtsChunkRef.current) {
      setError("实时服务返回了未声明的二进制音频帧，已丢弃。");
      return;
    }
    try {
      ensurePlaybackQueue().enqueue(chunk);
      pendingTtsChunkRef.current = false;
      setSessionState("speaking");
    } catch (playbackError) {
      setError(
        playbackError instanceof Error
          ? playbackError.message
          : "TTS 音频播放失败，已丢弃当前音频分片。",
      );
    }
  });

  const handleRealtimeEvent = useEventCallback((event: RealtimeEvent) => {
    const currentSessionId = sessionIdRef.current;
    if (!currentSessionId || event.session_id !== currentSessionId) {
      setError("实时事件的会话 ID 与当前会话不一致，已忽略该事件。");
      return;
    }
    if (event.type === "session.open") {
      const policy = event.payload.tts_playback_policy;
      if (
        policy === "browser-compat" ||
        policy === "server-neural" ||
        policy === "server"
      ) {
        serverTtsPlaybackPolicyRef.current = policy;
        setTtsPlaybackPolicy(policy);
      } else {
        serverTtsPlaybackPolicyRef.current = "server";
        setTtsPlaybackPolicy("server");
        setError("实时服务未返回有效的语音播放策略，已按服务端 PCM 安全处理。");
      }
    }
    if (event.state && !(activeBuiltInVoiceProfile() && event.type === "tts.chunk")) {
      setSessionState(event.state);
    }

    switch (event.type) {
      case "session.open":
        serverTtsFinishedRef.current = true;
        updateRemoteTurnActive(false);
        break;
      case "asr.partial": {
        const text = payloadText(event);
        const bufferedBytes = event.payload.buffered_audio_bytes;
        setPartialCaption(
          text
            ? `你：${text}`
            : typeof bufferedBytes === "number"
              ? `正在接收语音（${bufferedBytes} bytes）`
              : "正在接收语音…",
        );
        break;
      }
      case "asr.final": {
        const text = payloadText(event).trim();
        if (text) {
          appendTurn({
            id: `user-${Date.now()}`,
            role: "user",
            text,
            status: "final",
          });
        }
        setPartialCaption("");
        break;
      }
      case "llm.delta": {
        const text = payloadText(event);
        if (text) {
          partialAssistantRef.current += text;
          setPartialCaption(`伴学角色：${partialAssistantRef.current}`);
        }
        break;
      }
      case "llm.final": {
        const turn = decodeCompanionTurn(event.payload);
        if (!turn || turn.session_id !== currentSessionId || turn.space_id !== spaceId) {
          setSessionState("error");
          setError("实时回复不符合当前会话的 CompanionTurn 契约，已拒绝展示。");
          return;
        }
        if (turn.board_actions?.length) {
          setCurrentBoardActions(turn.board_actions);
        }
        appendTurn(toTranscriptTurn(turn));
        setAvatarEmotion(turn.emotion);
        partialAssistantRef.current = "";
        setPartialCaption("");
        speakWithBuiltInVoice(turn.spoken_text.trim() || turn.display_text.trim(), turn.emotion);
        break;
      }
      case "board.update": {
        const payload = decodeBoardUpdatePayload(event.payload);
        if (!payload) {
          setError("board.update 事件不符合前端约定的板书契约，已拒绝渲染。");
          return;
        }
        setCurrentBoardActions(payload.board_actions);
        break;
      }
      case "demo.ready": {
        const payload = decodeDemoReadyPayload(event.payload);
        if (!payload) {
          setDemoError("demo.ready 事件不符合 LessonScript 契约，已拒绝播放。");
          setError("demo.ready 事件不符合 LessonScript 契约，已拒绝播放。");
          setIsDemoLoading(false);
          return;
        }
        if (payload.session_id !== currentSessionId || payload.session_id !== event.session_id) {
          setDemoError("demo.ready 事件返回了与当前会话不匹配的 session_id，已拒绝播放。");
          setError("demo.ready 事件返回了与当前会话不匹配的 session_id，已拒绝播放。");
          setIsDemoLoading(false);
          return;
        }
        setDemo(payload);
        setDemoError(null);
        setIsDemoLoading(false);
        updateRemoteTurnActive(false);
        break;
      }
      case "tts.chunk": {
        const isFinalChunk = event.payload.final === true;
        if (activeBuiltInVoiceProfile()) {
          pendingTtsChunkRef.current = false;
          waitingForTtsDrainRef.current = false;
          if (isFinalChunk) {
            serverTtsFinishedRef.current = true;
            finalizeBuiltInTurnIfComplete();
          } else {
            discardServerTtsChunkCountRef.current += 1;
          }
          break;
        }
        if (isFinalChunk) {
          waitingForTtsDrainRef.current = true;
          if (playbackQueueRef.current?.hasPendingAudio()) {
            stateRef.current = "speaking";
            setSessionState("speaking");
          }
          finalizeSpeakingIfDrained();
          break;
        }
        pendingTtsChunkRef.current = true;
        waitingForTtsDrainRef.current = false;
        const previewText =
          typeof event.payload.preview_text === "string"
            ? event.payload.preview_text.trim()
            : "";
        if (previewText) {
          setPartialCaption(`伴学角色：${previewText}`);
        }
        setSessionState("speaking");
        break;
      }
      case "turn.interrupted":
        serverTtsFinishedRef.current = true;
        if (event.payload.active === false) {
          updateRemoteTurnActive(false);
          if (event.state) {
            stateRef.current = event.state;
          }
          resolvePushToTalkInterrupt();
          break;
        }
        updateRemoteTurnActive(false);
        stopPlayback();
        settleDemoNarration("stopped", { bumpStopToken: true });
        finishInterruptedAssistantTurn();
        stateRef.current = "interrupted";
        setSessionState("interrupted");
        resolvePushToTalkInterrupt();
        break;
      case "error":
        serverTtsFinishedRef.current = true;
        updateRemoteTurnActive(false);
        finishInterruptedAssistantTurn();
        {
          const socket = socketRef.current;
          if (socket) {
            intentionallyClosedSocketsRef.current.add(socket);
            socket.close(4000, "Realtime provider failed");
            socketRef.current = null;
          }
        }
        markFreshSessionRequired();
        stopRealtimeMedia();
        settleDemoNarration("stopped", { bumpStopToken: true });
        recordTextFallbackSignal(currentSessionId, "realtime_server_error");
        updateConnectionStatus("text");
        setSessionState("error");
        setError(
          formatSpeechFallbackMessage(
            formatErrorMessage(
              payloadMessage(event) || "实时服务返回了未说明的错误。",
              payloadCode(event),
            ),
          ),
        );
        break;
      case "heartbeat":
      case "user.commit":
        break;
      default:
        break;
    }
  });

  const interrupt = useEventCallback(() => {
    stopPlaybackForUserInterrupt();
    const hadLocalDemoNarration =
      demoFetchAbortControllerRef.current !== null || demoPlaybackResolverRef.current !== null;
    if (hadLocalDemoNarration) {
      settleDemoNarration("stopped", { bumpStopToken: true });
    }
    if (!remoteTurnActiveRef.current) {
      if (hadLocalDemoNarration) {
        setAvatarEmotion("neutral");
        stateRef.current = "idle";
        setSessionState("idle");
        return true;
      }
      setError("当前没有可打断的回复或演示。");
      return false;
    }
    const previousState = stateRef.current;
    stateRef.current = "interrupted";
    if (!sendSocketEvent("turn.interrupt")) {
      stateRef.current = previousState;
      updateRemoteTurnActive(false);
      if (hadLocalDemoNarration) {
        setAvatarEmotion("neutral");
        setSessionState("idle");
        return true;
      }
      setError("当前没有可打断的实时连接。");
      return false;
    }
    setAvatarEmotion("neutral");
    setSessionState("interrupted");
    return true;
  });

  const commitVoiceTurn = useEventCallback((source: "vad" | "ptt" = "vad") => {
    if (speechFrameCountRef.current > 0) {
      if (sendSocketEvent("user.commit")) {
        beginFirstAudioMeasurement();
        updateRemoteTurnActive(true);
        setSessionState("thinking");
        if (source === "ptt") {
          setPushToTalkStatus("sent");
          setPartialCaption("按住说话已发送");
        }
      } else {
        if (source === "ptt") {
          setPushToTalkStatus("idle");
        }
        setError("语音片段未提交：实时连接已经断开。");
      }
    } else if (source === "ptt") {
      setPushToTalkStatus("idle");
      setPartialCaption("");
    }
    resetVoiceTracking();
  });

  const stopPushToTalk = useEventCallback(() => {
    if (!pushToTalkActiveRef.current) {
      return;
    }
    updatePushToTalkActive(false);
    if (
      pushToTalkAwaitingInterruptRef.current &&
      speechFrameCountRef.current > 0
    ) {
      setPushToTalkStatus("sent");
      setPartialCaption("正在等待角色停下后发送…");
      deferredPushToTalkCommitRef.current = () => commitVoiceTurn("ptt");
      return;
    }
    commitVoiceTurn("ptt");
  });

  const startPushToTalk = useEventCallback(() => {
    if (pushToTalkActiveRef.current) {
      return true;
    }
    if (
      pushToTalkAwaitingInterruptRef.current ||
      deferredPushToTalkCommitRef.current !== null
    ) {
      setError("正在等待上一次打断完成，请稍后再试。");
      return false;
    }
    if (connectionStatusRef.current !== "connected") {
      setError("实时连接未就绪，暂时不能按住说话。");
      return false;
    }
    if (isMuted) {
      setError("麦克风已静音，先取消静音再按住说话。");
      return false;
    }
    if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) {
      setError("实时连接已经断开，无法开始按住说话。");
      return false;
    }
    const needsRemoteInterrupt = remoteTurnActiveRef.current;
    if (
      needsRemoteInterrupt ||
      demoFetchAbortControllerRef.current !== null ||
      demoPlaybackResolverRef.current !== null
    ) {
      if (!interrupt()) {
        return false;
      }
      if (needsRemoteInterrupt) {
        updatePushToTalkAwaitingInterrupt(true);
        pushToTalkInterruptTimeoutRef.current = window.setTimeout(() => {
          if (!pushToTalkAwaitingInterruptRef.current) {
            return;
          }
          cancelPushToTalk();
          setError("角色未在 3 秒内确认打断，本次语音未提交；请重试或改用文字。");
        }, REALTIME_INTERRUPT_ACK_TIMEOUT_MS);
      }
    }
    setError(null);
    setAvatarEmotion("neutral");
    updatePushToTalkActive(true);
    setPushToTalkStatus("recording");
    setPartialCaption("按住说话中…");
    stateRef.current = "listening";
    setSessionState("listening");
    return true;
  });

  const handleAudioFrame = useEventCallback((level: number, pcm: Float32Array) => {
    if (!pageLifecycleActiveRef.current) {
      return;
    }
    setAudioLevel(level);
    const now = performance.now();
    const forcedSpeech = pushToTalkActiveRef.current && !isMuted;
    const activeSpeech = forcedSpeech || level >= DEFAULT_VAD_THRESHOLD;

    if (activeSpeech) {
      lastVoiceAtRef.current = now;
      if (speechStartedAtRef.current === null) {
        setAvatarEmotion("neutral");
      }
      speechStartedAtRef.current ??= now;
      if (
        !pushToTalkAwaitingInterruptRef.current &&
        (stateRef.current === "speaking" || stateRef.current === "thinking")
      ) {
        bargeInStartedAtRef.current ??= now;
        if (
          !bargeInTriggeredRef.current &&
          now - (bargeInStartedAtRef.current ?? now) >= BARGE_IN_MS
        ) {
          bargeInTriggeredRef.current = true;
          interrupt();
        }
      } else {
        bargeInStartedAtRef.current = null;
        bargeInTriggeredRef.current = false;
        setSessionState("listening");
      }

      if (!isMuted && socketRef.current?.readyState === WebSocket.OPEN) {
        const frames = pcmFramerRef.current?.push(pcm) ?? [];
        speechFrameCountRef.current += frames.length;
        for (const frame of frames) {
          if (frame.byteLength !== INPUT_PCM16_FRAME_BYTES) {
            setError("生成的上行音频帧尺寸不符合 20ms / 640 bytes 契约。");
            continue;
          }
          socketRef.current.send(frame);
        }
      }
      return;
    }

    bargeInStartedAtRef.current = null;
    bargeInTriggeredRef.current = false;
    if (
      !pushToTalkActiveRef.current &&
      !pushToTalkAwaitingInterruptRef.current &&
      speechStartedAtRef.current &&
      lastVoiceAtRef.current &&
      now - lastVoiceAtRef.current >= commitSilenceMs
    ) {
      commitVoiceTurn("vad");
    }
  });

  useEffect(() => {
    if (process.env.NEXT_PUBLIC_E2E_AUDIO_HOOK !== "1") {
      return;
    }
    const testWindow = window as typeof window & {
      __companionInjectAudioFrame?: (level: number, pcm: Float32Array) => void;
    };
    testWindow.__companionInjectAudioFrame = (level, pcm) => {
      handleAudioFrame(level, new Float32Array(pcm));
    };
    return () => {
      delete testWindow.__companionInjectAudioFrame;
    };
  }, [handleAudioFrame]);

  const startAudioCapture = useEventCallback(async (lifecycleGeneration: number) => {
    if (typeof window === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      throw new Error("当前浏览器不支持麦克风采集；请改用文字模式。");
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      if (
        !pageLifecycleActiveRef.current ||
        lifecycleGeneration !== pageLifecycleGenerationRef.current
      ) {
        stream.getTracks().forEach((track) => track.stop());
        throw new Error("Page lifecycle changed before microphone capture started.");
      }
      mediaStreamRef.current = stream;
      const context = new window.AudioContext();
      captureContextRef.current = context;
      await context.resume();
      if (
        !pageLifecycleActiveRef.current ||
        lifecycleGeneration !== pageLifecycleGenerationRef.current
      ) {
        throw new Error("Page lifecycle changed while microphone capture was starting.");
      }
      if (context.state !== "running") {
        throw new Error("麦克风音频上下文未启动；请再点击一次开启实时。");
      }
      pcmFramerRef.current = new Pcm16MonoFramer(context.sampleRate);
      const source = context.createMediaStreamSource(stream);

      if (typeof AudioWorkletNode !== "undefined" && context.audioWorklet) {
        const blob = new Blob([createAudioWorkletModuleSource()], {
          type: "application/javascript",
        });
        const moduleUrl = URL.createObjectURL(blob);
        try {
          await context.audioWorklet.addModule(moduleUrl);
        } finally {
          URL.revokeObjectURL(moduleUrl);
        }

        const node = new AudioWorkletNode(context, "pulse-processor");
        node.port.onmessage = (event: MessageEvent<{ level: number; pcm: Float32Array }>) => {
          handleAudioFrame(event.data.level, event.data.pcm);
        };
        const sink = context.createGain();
        sink.gain.value = 0;
        source.connect(node);
        node.connect(sink);
        sink.connect(context.destination);
        captureNodeRef.current = node;
        return;
      }

      const legacyContext = context as AudioContext & {
        createScriptProcessor(
          bufferSize?: number,
          numberOfInputChannels?: number,
          numberOfOutputChannels?: number,
        ): ScriptProcessorNode;
      };
      const fallbackNode = legacyContext.createScriptProcessor(1024, 1, 1);
      fallbackNode.onaudioprocess = (event: AudioProcessingEvent) => {
        const channel = event.inputBuffer.getChannelData(0);
        handleAudioFrame(measureLevel(channel), new Float32Array(channel));
      };
      source.connect(fallbackNode);
      fallbackNode.connect(legacyContext.destination);
      captureNodeRef.current = fallbackNode;
    } catch (captureError) {
      stopAudioCapture();
      if (isMicrophonePermissionError(captureError)) {
        throw new MicPermissionDeniedError(formatMicDeniedMessage());
      }
      throw captureError;
    }
  });

  const connect = useEventCallback(async () => {
    if (
      connectionStatusRef.current === "connected" ||
      connectionStatusRef.current === "connecting"
    ) {
      return;
    }
    if (!pageLifecycleActiveRef.current) {
      return;
    }

    const lifecycleGeneration = pageLifecycleGenerationRef.current;

    setError(null);
    setAvatarEmotion("neutral");
    stopRealtimeMedia();
    updateConnectionStatus("connecting");
    setSessionState("idle");

    let currentSessionId: string | null = null;
    try {
      currentSessionId = await ensureSession(
        requiresFreshSessionRef.current || connectionStatusRef.current === "ended",
      );
      if (
        !pageLifecycleActiveRef.current ||
        lifecycleGeneration !== pageLifecycleGenerationRef.current
      ) {
        throw new Error("Page lifecycle changed while realtime was connecting.");
      }
      const activeSessionId = currentSessionId;
      if (!resolveRuntimeConfig().realtimeWsUrlTemplate) {
        recordTextFallbackSignal(activeSessionId, "realtime_url_missing");
        updateConnectionStatus("text");
        setError(
          formatSpeechFallbackMessage(
            "未配置实时地址模板，当前只会创建真实文字会话。",
          ),
        );
        return;
      }
      const realtimeUrl = resolveRealtimeWsUrl(activeSessionId);
      if (!realtimeUrl) {
        recordTextFallbackSignal(activeSessionId, "realtime_url_invalid");
        updateConnectionStatus("text");
        setSessionState("idle");
        setError(formatSpeechFallbackMessage("实时地址不可用，当前只保留文字会话。"));
        return;
      }

      const realtimeTicket = await api.createRealtimeTicket(activeSessionId);
      if (
        !pageLifecycleActiveRef.current ||
        lifecycleGeneration !== pageLifecycleGenerationRef.current
      ) {
        throw new Error("Page lifecycle changed while realtime was connecting.");
      }
      const expiresAt = Date.parse(realtimeTicket.expires_at);
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
        throw new Error("实时握手票据已过期，请重新连接。");
      }

      await ensurePlaybackQueue().prepare();
      if (
        !pageLifecycleActiveRef.current ||
        lifecycleGeneration !== pageLifecycleGenerationRef.current
      ) {
        throw new Error("Page lifecycle changed while realtime was connecting.");
      }
      const socket = new WebSocket(realtimeUrl, [
        "companion-v1",
        `ticket.${realtimeTicket.ticket}`,
      ]);
      socket.binaryType = "arraybuffer";
      socketRef.current = socket;

      socket.onmessage = (message) => {
        if (
          socketRef.current !== socket ||
          !pageLifecycleActiveRef.current ||
          lifecycleGeneration !== pageLifecycleGenerationRef.current
        ) {
          return;
        }
        if (typeof message.data === "string") {
          const decoded = decodeRealtimeEvent(message.data);
          if (!decoded) {
            setError("实时服务返回了无法识别的事件格式。");
            return;
          }
          handleRealtimeEvent(decoded);
          return;
        }
        if (message.data instanceof ArrayBuffer) {
          handleRealtimeBinaryMessage(message.data);
          return;
        }
        if (message.data instanceof Blob) {
          void message.data.arrayBuffer().then((buffer) => {
            if (
              socketRef.current === socket &&
              pageLifecycleActiveRef.current &&
              lifecycleGeneration === pageLifecycleGenerationRef.current
            ) {
              handleRealtimeBinaryMessage(buffer);
            }
          }).catch(() => {
            if (socketRef.current === socket && pageLifecycleActiveRef.current) {
              setError("实时服务返回的二进制音频帧无法读取。");
            }
          });
          return;
        }
        setError("实时服务返回了不支持的消息类型。");
      };

      socket.onclose = (closeEvent) => {
        if (socketRef.current === socket) {
          socketRef.current = null;
        }
        if (intentionallyClosedSocketsRef.current.has(socket)) {
          return;
        }
        stopRealtimeMedia();
        settleDemoNarration("stopped", { bumpStopToken: true });
        updateRemoteTurnActive(false);
        markFreshSessionRequired();
        if (closeEvent.code === 4401) {
          clearOwnerSessionToken();
          updateConnectionStatus("error");
          setSessionState("error");
          setError(
            formatSpeechFallbackMessage("实时鉴权失败，请重新解锁 vault。"),
          );
          return;
        }
        if (closeEvent.code === 4404) {
          recordTextFallbackSignal(activeSessionId, "realtime_disconnected");
          updateConnectionStatus("text");
          setSessionState("idle");
          setError(
            formatSpeechFallbackMessage("实时会话不存在或已经失效，已回退到文字模式并要求重建会话。"),
          );
          return;
        }
        if (closeEvent.code === 4409) {
          recordTextFallbackSignal(activeSessionId, "realtime_disconnected");
          updateConnectionStatus("text");
          setSessionState("idle");
          setError(
            formatSpeechFallbackMessage(
              "当前会话的角色包已不可用，已回退到文字模式；请重新选择角色。",
            ),
          );
          return;
        }
        recordTextFallbackSignal(activeSessionId, "realtime_disconnected");
        updateConnectionStatus("text");
        setSessionState("idle");
        setError(
          formatSpeechFallbackMessage(
            "实时连接已断开；如需恢复语音，将重新创建会话而不是复用旧音频。",
          ),
        );
      };

      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          window.clearTimeout(timeout);
          socket.removeEventListener("open", handleOpen);
          socket.removeEventListener("message", handleSessionOpen);
          socket.removeEventListener("close", handleClose);
        };
        const timeout = window.setTimeout(() => {
          cleanup();
          reject(
            new Error(
              formatSpeechFallbackMessage(
                "实时连接未收到 session.open 确认，仍可继续使用 REST 文字会话。",
              ),
            ),
          );
        }, REALTIME_CONNECT_TIMEOUT_MS);
        const handleOpen = () => {
          if (socket.protocol === "companion-v1") {
            return;
          }
          cleanup();
          reject(new Error("实时服务未确认 companion-v1 子协议，已拒绝连接。"));
        };
        const handleSessionOpen = (message: MessageEvent) => {
          if (typeof message.data !== "string") {
            return;
          }
          const event = decodeRealtimeEvent(message.data);
          if (
            event?.type !== "session.open" ||
            event.session_id !== activeSessionId
          ) {
            return;
          }
          cleanup();
          resolve();
        };
        const handleClose = (closeEvent: CloseEvent) => {
          cleanup();
          if (closeEvent.code === 4401) {
            clearOwnerSessionToken();
            reject(
              new RealtimeAuthError(
                formatSpeechFallbackMessage("实时鉴权失败，请重新解锁 vault。"),
              ),
            );
          } else if (closeEvent.code === 4404) {
            reject(
              new RealtimeSessionMissingError(
                formatSpeechFallbackMessage(
                  "实时会话不存在或已经失效，已回退到文字模式并要求重建会话。",
                ),
              ),
            );
          } else if (closeEvent.code === 4409) {
            reject(
              new RealtimeCharacterUnavailableError(
                formatSpeechFallbackMessage(
                  "当前会话的角色包已不可用，请重新选择角色。",
                ),
              ),
            );
          } else {
            reject(
              new Error(
                formatSpeechFallbackMessage("实时连接在初始化期间关闭，仍可继续使用 REST 文字会话。"),
              ),
            );
          }
        };
        socket.addEventListener("open", handleOpen, { once: true });
        socket.addEventListener("message", handleSessionOpen);
        socket.addEventListener("close", handleClose, { once: true });
        socket.onerror = () => {
          setError("WebSocket 建立失败，正在关闭实时连接。");
        };
      });

      if (socket.readyState !== WebSocket.OPEN) {
        throw new Error("实时连接在初始化期间关闭，仍可继续使用 REST 文字会话。");
      }

      if (
        !pageLifecycleActiveRef.current ||
        lifecycleGeneration !== pageLifecycleGenerationRef.current
      ) {
        throw new Error("Page lifecycle changed before microphone capture started.");
      }
      await startAudioCapture(lifecycleGeneration);
      updateConnectionStatus("connected");
    } catch (connectError) {
      const socket = socketRef.current;
      if (socket) {
        intentionallyClosedSocketsRef.current.add(socket);
        socket.close();
        socketRef.current = null;
        markFreshSessionRequired();
      }
      stopRealtimeMedia();
      settleDemoNarration("stopped", { bumpStopToken: true });
      updateRemoteTurnActive(false);

      if (
        !pageLifecycleActiveRef.current ||
        lifecycleGeneration !== pageLifecycleGenerationRef.current
      ) {
        updateConnectionStatus("text");
        setSessionState("idle");
        return;
      }

      if (connectError instanceof MicPermissionDeniedError) {
        if (currentSessionId) {
          recordTextFallbackSignal(currentSessionId, "microphone_denied");
        }
        updateConnectionStatus("text");
        setSessionState("idle");
        setError(connectError.message);
        return;
      }
      if (connectError instanceof RealtimeAuthError) {
        updateConnectionStatus("error");
        setSessionState("error");
        setError(connectError.message);
        return;
      }
      if (
        connectError instanceof RealtimeSessionMissingError ||
        connectError instanceof RealtimeCharacterUnavailableError
      ) {
        updateConnectionStatus("text");
        setSessionState("idle");
        setError(connectError.message);
        return;
      }
      if (connectError instanceof RuntimeConfigError) {
        if (currentSessionId) {
          recordTextFallbackSignal(currentSessionId, "realtime_url_invalid");
        }
        updateConnectionStatus("text");
        setSessionState("idle");
        setError(connectError.message);
        return;
      }
      if (connectError instanceof api.ApiError && connectError.status === 404) {
        markFreshSessionRequired();
        updateConnectionStatus("text");
        setSessionState("idle");
        setError(
          formatSpeechFallbackMessage(
            formatRequestError(
              connectError,
              "实时会话不存在或已经失效；下次连接会重建会话。",
            ),
          ),
        );
        return;
      }
      if (connectError instanceof api.ApiError && connectError.status === 424) {
        updateConnectionStatus("text");
        setSessionState("idle");
        setError(
          formatSpeechFallbackMessage(
            formatRequestError(connectError, "当前空间未绑定可用的 STT/TTS 能力。"),
          ),
        );
        return;
      }
      if (connectError instanceof api.ApiError && connectError.status === 409) {
        updateConnectionStatus("text");
        setSessionState("idle");
        setError(
          formatSpeechFallbackMessage(
            formatRequestError(
              connectError,
              "当前会话的角色包已不可用，请重新选择角色。",
            ),
          ),
        );
        return;
      }

      if (currentSessionId) {
        recordTextFallbackSignal(currentSessionId, "realtime_connect_failed");
      }
      updateConnectionStatus("text");
      setSessionState("idle");
      setError(connectError instanceof Error ? connectError.message : "实时连接失败");
    }
  });

  const sendText = useEventCallback(async (message: string) => {
    const trimmed = message.trim();
    if (!trimmed || textRequestInFlightRef.current) {
      return false;
    }
    if (remoteTurnActiveRef.current) {
      setError("先等待当前语音回复结束，或点击“立即打断”后再发送文字。");
      return false;
    }
    if (
      demoFetchAbortControllerRef.current !== null ||
      demoPlaybackResolverRef.current !== null
    ) {
      stopPlaybackForUserInterrupt();
      settleDemoNarration("stopped", { bumpStopToken: true });
    }

    textRequestInFlightRef.current = true;
    setIsSendingText(true);
    setError(null);
    setAvatarEmotion("neutral");
    let requestGeneration: number | null = null;
    let requestSessionId: string | null = null;
    let streamedAssistantText = "";
    let sawFinalReply = false;
    try {
      const currentSessionId = await ensureSession();
      const generation = sessionGenerationRef.current;
      requestGeneration = generation;
      requestSessionId = currentSessionId;
      const userTurnId = `user-${currentSessionId}-${Date.now()}`;
      appendTurn({
        id: userTurnId,
        role: "user",
        text: trimmed,
        status: "final",
      });
      setSessionState("thinking");
      setPartialCaption(`你：${trimmed}`);

      const streamTurn = getStreamTurn();
      if (!streamTurn) {
        const reply = decodeCompanionTurn(await api.createTurn(currentSessionId, trimmed));
        if (!reply) {
          throw new Error("服务端返回的文字回复不符合 CompanionTurn 契约，已拒绝展示。");
        }
        if (reply.session_id !== currentSessionId || reply.space_id !== spaceId) {
          throw new Error("文字回复不属于当前空间或会话，已拒绝展示。");
        }
        if (reply.board_actions?.length) {
          setCurrentBoardActions(reply.board_actions);
        }
        appendTurn(toTranscriptTurn(reply));
        setAvatarEmotion(reply.emotion);
        sawFinalReply = true;
      } else {
        let streamError: string | null = null;
        await streamTurn(currentSessionId, trimmed, (event) => {
          if (
            generation !== sessionGenerationRef.current ||
            sessionIdRef.current !== currentSessionId ||
            connectionStatusRef.current === "ended"
          ) {
            return;
          }
          if (event.session_id !== currentSessionId) {
            streamError = "流式文字事件的会话 ID 与当前会话不一致，已忽略该事件。";
            return;
          }
          if (event.state) {
            setSessionState(event.state);
          }

          switch (event.type) {
            case "llm.delta": {
              const text = payloadText(event);
              if (!text) {
                break;
              }
              streamedAssistantText += text;
              partialAssistantRef.current = streamedAssistantText;
              setPartialCaption(`伴学角色：${streamedAssistantText}`);
              break;
            }
            case "llm.final": {
              const reply = decodeCompanionTurn(event.payload);
              if (!reply || reply.session_id !== currentSessionId || reply.space_id !== spaceId) {
                streamError = "流式文字回复不符合当前会话的 CompanionTurn 契约，已拒绝展示。";
                return;
              }
              if (reply.board_actions?.length) {
                setCurrentBoardActions(reply.board_actions);
              }
              appendTurn(toTranscriptTurn(reply));
              setAvatarEmotion(reply.emotion);
              partialAssistantRef.current = "";
              setPartialCaption("");
              setSessionState("idle");
              sawFinalReply = true;
              break;
            }
            case "error":
              streamError = formatErrorMessage(
                payloadMessage(event) || "流式文字请求失败。",
                payloadCode(event),
              );
              setSessionState("error");
              break;
            default:
              break;
          }
        });
        if (streamError) {
          throw new Error(streamError);
        }
        if (!sawFinalReply) {
          throw new Error("流式文字响应在完成前中断，请重试。");
        }
      }
      if (
        generation !== sessionGenerationRef.current ||
        sessionIdRef.current !== currentSessionId ||
        connectionStatusRef.current === "ended"
      ) {
        return false;
      }
      partialAssistantRef.current = "";
      setPartialCaption("");
      setSessionState("idle");
      if (connectionStatusRef.current !== "connected") {
        updateConnectionStatus("text");
      }
      return true;
    } catch (sendError) {
      if (
        (requestGeneration !== null &&
          requestGeneration !== sessionGenerationRef.current) ||
        (requestSessionId !== null &&
          sessionIdRef.current !== requestSessionId) ||
        stateRef.current === "closed" ||
        connectionStatusRef.current === "ended"
      ) {
        return false;
      }
      setSessionState("error");
      if (!sessionIdRef.current) {
        updateConnectionStatus("error");
      }
      partialAssistantRef.current = streamedAssistantText;
      if (streamedAssistantText) {
        setPartialCaption(`伴学角色：${streamedAssistantText}`);
      }
      setError(formatRequestError(sendError, "文字消息发送失败"));
      return false;
    } finally {
      textRequestInFlightRef.current = false;
      setIsSendingText(false);
    }
  });

  const clearDemo = useEventCallback(async () => {
    if (
      demoFetchAbortControllerRef.current !== null ||
      demoPlaybackResolverRef.current !== null
    ) {
      stopPlayback();
      settleDemoNarration("stopped", { bumpStopToken: true });
    }
    setDemo(null);
    setDemoError(null);
    setIsDemoLoading(false);
  });

  const requestDemo = useEventCallback(async (topic: string) => {
    const trimmed = topic.trim();
    if (!trimmed) {
      setDemoError("请输入一个明确的演示主题，再请求 LessonScript。");
      return false;
    }
    if (!sessionIdRef.current) {
      setDemoError("请先创建会话，再请求“演示一下”。");
      return false;
    }
    if (remoteTurnActiveRef.current || textRequestInFlightRef.current) {
      setDemoError("先等当前回复结束或将它打断，再开始新的分步演示。");
      return false;
    }

    setDemo(null);
    setDemoError(null);
    setIsDemoLoading(true);
    try {
      const response = await api.createSessionDemo(sessionIdRef.current, { topic: trimmed });
      if (response.session_id !== sessionIdRef.current) {
        throw new Error("演示脚本返回了与当前会话不一致的 session_id，已拒绝展示。");
      }
      setDemo(response);
      setIsDemoLoading(false);
      return true;
    } catch (demoRequestError) {
      const message = formatRequestError(demoRequestError, "请求演示脚本失败");
      setDemoError(message);
      setIsDemoLoading(false);
      return false;
    }
  });

  const stopDemoNarration = useEventCallback(async () => {
    if (
      demoFetchAbortControllerRef.current === null &&
      demoPlaybackResolverRef.current === null
    ) {
      return;
    }
    stopPlaybackForUserInterrupt();
    settleDemoNarration("stopped", { bumpStopToken: true });
  });

  const playDemoNarration = useEventCallback(async (input: DemoNarrationRequest) => {
    const text = input.text.trim();
    if (!text) {
      return "completed" as DemoNarrationResult;
    }
    if (!input.characterId.trim()) {
      throw new Error("当前会话没有可用角色，无法使用 voice preview 播放演示讲解。");
    }
    if (remoteTurnActiveRef.current || textRequestInFlightRef.current) {
      throw new Error("先等当前回复结束或将它打断，再播放分步演示。");
    }

    stopPlayback();
    settleDemoNarration("stopped", { bumpStopToken: false });
    await ensurePlaybackQueue().prepare();

    const controller = new AbortController();
    demoFetchAbortControllerRef.current = controller;
    const completion = new Promise<DemoNarrationResult>((resolve) => {
      demoPlaybackResolverRef.current = resolve;
    });

    try {
      const preview = await api.previewCharacterVoice({
        characterId: input.characterId,
        spaceId,
        text,
        voiceId: input.voiceId,
        speakingRate: input.speakingRate,
        signal: controller.signal,
      });
      if (controller.signal.aborted) {
        return completion;
      }
      if (preview.sampleRate !== OUTPUT_PCM16_SAMPLE_RATE) {
        throw new Error(
          `演示配音返回 ${preview.sampleRate} Hz，前端只接受 ${OUTPUT_PCM16_SAMPLE_RATE} Hz PCM16。`,
        );
      }
      if (!preview.pcm16.byteLength) {
        throw new Error("演示配音返回了空 PCM 数据，已拒绝播放。");
      }
      if (demoFetchAbortControllerRef.current !== controller) {
        return completion;
      }
      setSessionState("speaking");
      setPartialCaption(`伴学角色：${text}`);
      ensurePlaybackQueue().enqueue(preview.pcm16);
      return completion;
    } catch (demoNarrationError) {
      if (
        demoNarrationError instanceof DOMException &&
        demoNarrationError.name === "AbortError"
      ) {
        return completion;
      }
      demoFetchAbortControllerRef.current = null;
      demoPlaybackResolverRef.current = null;
      if (stateRef.current === "speaking" && !pendingTtsChunkRef.current) {
        setSessionState("idle");
      }
      clearFirstAudioMeasurement();
      setPartialCaption("");
      throw demoNarrationError;
    }
  });

  const disconnect = useEventCallback(async () => {
    sessionGenerationRef.current += 1;
    requiresFreshSessionRef.current = false;
    setAvatarEmotion("neutral");
    const socket = socketRef.current;
    if (speechFrameCountRef.current > 0) {
      sendSocketEvent("turn.interrupt");
    }
    if (socket) {
      intentionallyClosedSocketsRef.current.add(socket);
      socket.close();
    }
    socketRef.current = null;
    stopRealtimeMedia();
    settleDemoNarration("stopped", { bumpStopToken: true });
    updateRemoteTurnActive(false);
    setPartialCaption("");
    setPushToTalkStatus("idle");
    partialAssistantRef.current = "";

    const currentSessionId = sessionIdRef.current;
    if (!currentSessionId) {
      updateConnectionStatus("ended");
      setSessionState("closed");
      return;
    }

    try {
      await api.endSession(currentSessionId);
      sessionIdRef.current = null;
      serverTtsPlaybackPolicyRef.current = null;
      setSessionId(null);
      setTtsPlaybackPolicy(null);
      setSessionCharacterId(null);
      updateConnectionStatus("ended");
      setSessionState("closed");
      setError(null);
    } catch (endError) {
      updateConnectionStatus("error");
      setSessionState("error");
      setError(endError instanceof Error ? endError.message : "结束会话失败");
    }
  });

  const toggleMute = useEventCallback(() => {
    if (!isMuted) {
      cancelPushToTalk();
    }
    setIsMuted((current) => !current);
  });

  useEffect(() => {
    return subscribeOwnerSession((token) => {
      if (token) {
        return;
      }
      const socket = socketRef.current;
      if (!socket) {
        return;
      }
      intentionallyClosedSocketsRef.current.add(socket);
      socket.close(4401, "Owner session cleared");
      socketRef.current = null;
      markFreshSessionRequired();
      stopRealtimeMedia();
      settleDemoNarration("stopped", { bumpStopToken: true });
      updateRemoteTurnActive(false);
      updateConnectionStatus("error");
      setSessionState("error");
      setError("Vault 已锁定或 owner session 已失效，实时连接已关闭。");
      setPushToTalkStatus("idle");
    });
  }, [
    markFreshSessionRequired,
    settleDemoNarration,
    stopRealtimeMedia,
    updateConnectionStatus,
    updateRemoteTurnActive,
  ]);

  useEffect(() => {
    const intentionallyClosedSockets = intentionallyClosedSocketsRef.current;
    return () => {
      sessionGenerationRef.current += 1;
      const socket = socketRef.current;
      if (socket) {
        intentionallyClosedSockets.add(socket);
        socket.close();
      }
      socketRef.current = null;
      stopRealtimeMedia();
      settleDemoNarration("stopped", { bumpStopToken: false });
      remoteTurnActiveRef.current = false;
      void playbackQueueRef.current?.close();
      cancelBuiltInSpeech();
    };
  }, [cancelBuiltInSpeech, settleDemoNarration, stopRealtimeMedia]);

  return {
    audioLevel,
    avatarEmotion,
    canPushToTalk:
      connectionStatus === "connected" &&
      !isSendingText &&
      !isMuted &&
      (!isPushToTalkAwaitingInterrupt || isPushToTalkActive),
    connectionStatus,
    currentBoardActions,
    demo,
    demoAudioStopToken,
    demoError,
    error,
    hasRemoteTurn,
    isDemoLoading,
    isMuted,
    isPushToTalkActive,
    isSessionHydrating,
    isSendingText,
    partialCaption,
    playbackAudioLevel,
    pushToTalkStatus,
    sessionCharacterId,
    sessionId,
    sessionState,
    transcript,
    ttsPlaybackPolicy,
    commitSilenceMs,
    setCommitSilenceMs,
    connect,
    clearDemo,
    cancelPushToTalk,
    disconnect,
    interrupt,
    playDemoNarration,
    requestDemo,
    sendText,
    startPushToTalk,
    stopDemoNarration,
    stopPushToTalk,
    toggleMute,
  };
}
