import { useCallback, useEffect, useRef, useState } from "react";
import { api, bodyOf } from "../../app/api";

export interface SpeakResult {
  kind: "audio" | "unavailable";
  text: string;
  engine: string;
  format?: "pcm_s16le" | "mp3" | null;
  sample_rate_hz?: number | null;
  audio_b64?: string | null;
  warning?: string | null;
  reason_code?: string | null;
}

export interface SpeakCallbacks {
  onStart?: () => void;
  onEnd?: () => void;
}

export async function requestTutorSpeech(params: {
  characterId?: string;
  text?: string;
  voiceId?: string;
}): Promise<SpeakResult> {
  return bodyOf(
    await api.POST("/api/v2/voice/speak", {
      body: {
        character_id: params.characterId ?? null,
        text: params.text ? params.text.slice(0, 240) : null,
        voice_id: params.voiceId ?? null,
      },
    }),
  ) as SpeakResult;
}

function decodeBase64Bytes(b64: string): Uint8Array {
  const binary = window.atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function playEncodedSpeech(
  result: SpeakResult,
  options?: {
    playbackRate?: number;
    onStart?: () => void;
    onEnd?: () => void;
    onError?: () => void;
  },
): () => void {
  if (result.kind !== "audio" || !result.audio_b64) {
    options?.onError?.();
    return () => {};
  }

  let stopped = false;
  let started = false;
  const notifyStart = () => {
    if (stopped || started) return;
    started = true;
    options?.onStart?.();
  };

  if (result.format === "pcm_s16le") {
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) {
      options?.onError?.();
      return () => {};
    }
    const ctx = new AudioCtx();
    const bytes = decodeBase64Bytes(result.audio_b64);
    const sampleCount = Math.floor(bytes.byteLength / 2);
    const view = new DataView(bytes.buffer, bytes.byteOffset, sampleCount * 2);
    const sampleRate = result.sample_rate_hz || 24000;
    const buffer = ctx.createBuffer(1, Math.max(1, sampleCount), sampleRate);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < sampleCount; i += 1) {
      channel[i] = view.getInt16(i * 2, true) / 32768;
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    if (options?.playbackRate) source.playbackRate.value = options.playbackRate;
    source.connect(ctx.destination);
    source.onended = () => {
      if (!stopped) options?.onEnd?.();
      void ctx.close().catch(() => {});
    };
    const startPcm = async () => {
      try {
        if (ctx.state === "suspended") {
          await ctx.resume();
        }
        if (stopped) return;
        source.start();
        notifyStart();
      } catch {
        void ctx.close().catch(() => {});
        if (!stopped) options?.onError?.();
      }
    };
    void startPcm();
    return () => {
      stopped = true;
      try {
        source.stop();
      } catch {
        // already stopped
      }
      void ctx.close().catch(() => {});
    };
  }

  const audio = new Audio(`data:audio/mpeg;base64,${result.audio_b64}`);
  if (options?.playbackRate) audio.playbackRate = options.playbackRate;
  audio.onplaying = notifyStart;
  audio.onended = () => {
    if (!stopped) options?.onEnd?.();
  };
  audio.onerror = () => {
    if (!stopped) options?.onError?.();
  };
  void audio.play().then(notifyStart).catch(() => {
    if (!stopped) options?.onError?.();
  });
  return () => {
    stopped = true;
    audio.onplaying = null;
    audio.onended = null;
    audio.onerror = null;
    audio.pause();
    audio.src = "";
  };
}

export interface UseTutorSpeechReturn {
  speak: (
    params: { characterId?: string; text?: string; voiceId?: string },
    callbacks?: SpeakCallbacks,
  ) => Promise<boolean>;
  stop: () => void;
  loading: boolean;
  speaking: boolean;
  unavailable: boolean;
  warning: string | null;
}

/**
 * B13 unified out-of-classroom tutor speech hook.
 * Marks `speaking = true` strictly when audible playback begins (`onStart`),
 * never prematurely while waiting for server TTS synthesis or media buffering.
 */
export function useTutorSpeech(): UseTutorSpeechReturn {
  const [loading, setLoading] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);
  const stopRef = useRef<(() => void) | null>(null);
  const seqRef = useRef(0);

  const stop = useCallback(() => {
    seqRef.current += 1;
    stopRef.current?.();
    stopRef.current = null;
    setLoading(false);
    setSpeaking(false);
  }, []);

  useEffect(() => stop, [stop]);

  const speak = useCallback(
    async (
      params: { characterId?: string; text?: string; voiceId?: string },
      callbacks?: SpeakCallbacks,
    ) => {
      stop();
      const mySeq = seqRef.current;
      setLoading(true);
      setUnavailable(false);
      setWarning(null);
      try {
        const result = await requestTutorSpeech(params);
        if (seqRef.current !== mySeq) return false;
        if (result.warning) setWarning(result.warning);
        if (result.kind !== "audio" || !result.audio_b64) {
          setLoading(false);
          setUnavailable(true);
          return false;
        }
        return await new Promise<boolean>((resolve) => {
          let settled = false;
          const settle = (ok: boolean) => {
            if (settled) return;
            settled = true;
            resolve(ok);
          };
          const cleanup = playEncodedSpeech(result, {
            onStart: () => {
              if (seqRef.current !== mySeq) {
                settle(false);
                return;
              }
              setLoading(false);
              setSpeaking(true);
              callbacks?.onStart?.();
              settle(true);
            },
            onEnd: () => {
              if (seqRef.current === mySeq) {
                setLoading(false);
                setSpeaking(false);
                callbacks?.onEnd?.();
              }
              settle(true);
            },
            onError: () => {
              if (seqRef.current === mySeq) {
                setLoading(false);
                setSpeaking(false);
                setUnavailable(true);
              }
              settle(false);
            },
          });
          stopRef.current = () => {
            cleanup();
            settle(false);
          };
        });
      } catch {
        if (seqRef.current !== mySeq) return false;
        setLoading(false);
        setSpeaking(false);
        setUnavailable(true);
        return false;
      }
    },
    [stop],
  );

  return { speak, stop, loading, speaking, unavailable, warning };
}
