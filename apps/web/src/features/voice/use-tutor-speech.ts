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
  options?: { playbackRate?: number; onEnd?: () => void; onError?: () => void },
): () => void {
  if (result.kind !== "audio" || !result.audio_b64) {
    options?.onError?.();
    return () => {};
  }

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
    let stopped = false;
    source.onended = () => {
      if (!stopped) options?.onEnd?.();
      void ctx.close().catch(() => {});
    };
    try {
      source.start();
    } catch {
      void ctx.close().catch(() => {});
      options?.onError?.();
    }
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
  let stopped = false;
  audio.onended = () => {
    if (!stopped) options?.onEnd?.();
  };
  audio.onerror = () => {
    if (!stopped) options?.onError?.();
  };
  void audio.play().catch(() => {
    if (!stopped) options?.onError?.();
  });
  return () => {
    stopped = true;
    audio.pause();
    audio.src = "";
  };
}

export interface UseTutorSpeechReturn {
  speak: (params: { characterId?: string; text?: string; voiceId?: string }) => Promise<boolean>;
  stop: () => void;
  loading: boolean;
  speaking: boolean;
  unavailable: boolean;
  warning: string | null;
}

/**
 * B13 unified out-of-classroom tutor speech hook.
 * On failure/unavailable, marks `unavailable = true` (UI shows "声音暂时用不了" and keeps text)
 * without falling back to robotic browser speechSynthesis.
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

  const speak = useCallback(async (params: { characterId?: string; text?: string; voiceId?: string }) => {
    stop();
    const mySeq = seqRef.current;
    setLoading(true);
    setUnavailable(false);
    setWarning(null);
    try {
      const result = await requestTutorSpeech(params);
      if (seqRef.current !== mySeq) return false;
      setLoading(false);
      if (result.warning) setWarning(result.warning);
      if (result.kind !== "audio" || !result.audio_b64) {
        setUnavailable(true);
        return false;
      }
      setSpeaking(true);
      stopRef.current = playEncodedSpeech(result, {
        onEnd: () => {
          if (seqRef.current === mySeq) setSpeaking(false);
        },
        onError: () => {
          if (seqRef.current === mySeq) {
            setSpeaking(false);
            setUnavailable(true);
          }
        },
      });
      return true;
    } catch {
      if (seqRef.current !== mySeq) return false;
      setLoading(false);
      setSpeaking(false);
      setUnavailable(true);
      return false;
    }
  }, [stop]);

  return { speak, stop, loading, speaking, unavailable, warning };
}
