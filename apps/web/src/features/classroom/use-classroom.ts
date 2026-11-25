import { useCallback, useEffect, useRef, useState } from "react";
import type { DecodedSpeechChunk } from "@companion-space/avatar-engine/types";
import { SpeechOutput, parseCsa1Frame, type BrowserVoice, type SpeechFormat } from "../../audio";
import { ApiError, bootstrapSession, classroomErrorMessage } from "../../app/api";
import t from "../../locales/zh-CN.json";
import { fetchLesson, fetchLessonEvents, openLessonSocket } from "./lesson-api";
import { reconnectDelayMs, TAB_AWAY_PAUSE_MS } from "./lesson-phase";
import { advanceClassroom, initialClassroom, restoreClassroom, type Prefill, type SpokenEntry } from "./lesson-state";
import { captionDelay, Timeline, type LessonEvent } from "./timeline";

type Format = SpeechFormat | "text" | "browser";
type AudioMeta = { format: Format; rate: number; browserVoice?: BrowserVoice };
type Room = Awaited<ReturnType<typeof fetchLesson>>;
type Command = (type: string, data?: Record<string, unknown>) => boolean;
export type ClassroomConflict = "other_tab" | "taken_over" | null;
type Connection = {
  start: (audio: boolean) => Promise<void>;
  reconnect: (options?: { takeover?: boolean }) => Promise<void>;
  send: Command;
  interrupt: () => boolean;
  pause: (fromTabAway?: boolean) => void;
  upload: (frame: ArrayBuffer) => void;
  setVolume: (v: number) => void;
  setMuted: (m: boolean) => void;
  skipTextWait: () => void;
  setTextHold: (hold: boolean) => void;
};

const copy = t.classroom;

function readRememberedAudio(lessonId: string): boolean {
  try {
    const perLesson = window.localStorage.getItem(`cs:lesson:audio:${lessonId}`);
    if (perLesson === "0") return false;
    if (perLesson === "1") return true;
    const global = window.localStorage.getItem("cs:lesson:lastAudio");
    if (global === "0") return false;
  } catch {
    // Ignore storage access errors.
  }
  return true;
}

function writeRememberedAudio(lessonId: string, withAudio: boolean) {
  try {
    window.localStorage.setItem(`cs:lesson:audio:${lessonId}`, withAudio ? "1" : "0");
    window.localStorage.setItem("cs:lesson:lastAudio", withAudio ? "1" : "0");
  } catch {
    // Ignore storage access errors.
  }
}

export function useClassroom(
  id: string,
  onSpeechLevel?: (level: number) => void,
  onSpeechChunk?: (chunk: DecodedSpeechChunk) => void,
  onJudgePreview?: (verdict: string, gen: number) => void,
) {
  const connection = useRef<Connection>(null);
  const onSpeechLevelRef = useRef(onSpeechLevel);
  onSpeechLevelRef.current = onSpeechLevel;
  const onSpeechChunkRef = useRef(onSpeechChunk);
  onSpeechChunkRef.current = onSpeechChunk;
  const onJudgePreviewRef = useRef(onJudgePreview);
  onJudgePreviewRef.current = onJudgePreview;

  const [room, setRoom] = useState<Room>();
  const [classroom, setClassroom] = useState(initialClassroom);
  const [connected, setConnected] = useState(false);
  const [started, setStarted] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [audioSpeaking, setAudioSpeaking] = useState(false);
  const [audioBuffering, setAudioBuffering] = useState(false);
  const [lastAudio, setLastAudio] = useState(() => readRememberedAudio(id));
  const [error, setError] = useState("");
  const [errorSeq, setErrorSeq] = useState(0);
  const [fatalError, setFatalError] = useState(false);
  const [conflict, setConflict] = useState<ClassroomConflict>(null);
  const [vaultLocked, setVaultLocked] = useState(false);
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const [fallback, setFallback] = useState("");
  const [prefill, setPrefill] = useState<Prefill>();
  const [previewVerdict, setPreviewVerdict] = useState<{ askSeq: number; verdict: string } | null>(null);
  const [transcript, setTranscript] = useState("");
  const [studentEntries, setStudentEntries] = useState<SpokenEntry[]>([]);
  const [echoProtected, setEchoProtected] = useState(false);
  const [recap, setRecap] = useState<Record<string, unknown>>();
  const [latency, setLatency] = useState<number>();
  const [tabPaused, setTabPaused] = useState(false);
  const [textHold, setTextHoldState] = useState(false);
  const [ending, setEnding] = useState(false);
  const [hasFirstBeat, setHasFirstBeat] = useState(false);

  const askSeqRef = useRef<number | undefined>(undefined);
  askSeqRef.current = classroom.askSeq;
  const lastSeqRef = useRef<number>(0);
  const studentSubOrderRef = useRef<number>(0);
  const latestTeacherSeq = classroom.spokenLog.reduce((max, entry) => Math.max(max, entry.seq ?? 0), 0);
  if (latestTeacherSeq > lastSeqRef.current) {
    lastSeqRef.current = latestTeacherSeq;
    studentSubOrderRef.current = 0;
  }

  const appendStudentEntry = useCallback(
    (text: string, badge: "voice" | "text" | "quick", quickLabel?: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      studentSubOrderRef.current += 1;
      const order = lastSeqRef.current * 1000 + studentSubOrderRef.current;
      setStudentEntries((prev) => [
        ...prev.slice(-199),
        {
          id: `s:${Date.now()}:${prev.length}`,
          role: "student",
          text: trimmed,
          badge,
          quickLabel,
          order,
        },
      ]);
    },
    [],
  );

  useEffect(() => {
    let socket: WebSocket | undefined;
    let timeline: Timeline | undefined;
    let current: Room | undefined;
    let closed = false;
    let timer = 0;
    let tabTimer = 0;
    let hiddenAt = 0;
    let offline = 0;
    let active = false;
    let audio = readRememberedAudio(id);
    let firstSound = 0;
    let currentCaption: LessonEvent | undefined;
    let previewGen: number | undefined;
    let previewTail = Promise.resolve();
    let seq = 0;
    let textHoldFlag = false;
    let resolveTextWait: (() => void) | null = null;
    const events: LessonEvent[] = [];
    const cancelled = new Set<number>();
    const formats = new Map<string, AudioMeta>();
    const previewControllers = new Map<number, AbortController>();
    const previews = new Map<string, Promise<void>>();
    const previewVisuals = new Map<number, string[]>();
    const waiting = new Map<string, () => void>();

    const output = new SpeechOutput({
      onLevel: (level) => onSpeechLevelRef.current?.(level),
      onSpeechChunk: (chunk) => onSpeechChunkRef.current?.(chunk),
      onSegmentStart: (gen, seg) => {
        setAudioBuffering(false);
        setAudioSpeaking(true);
        if (firstSound) {
          setLatency(Math.round(performance.now() - firstSound));
          firstSound = 0;
        }
        if (currentCaption?.gen === gen && currentCaption.data.seg === seg) {
          const event = currentCaption;
          setClassroom((state) => advanceClassroom(state, event));
        }
      },
      onSegmentEnd: () => {
        setAudioSpeaking(false);
      },
    });

    const send: Command = (type, data = {}) => {
      if (socket?.readyState !== WebSocket.OPEN) return false;
      socket.send(JSON.stringify({ type, data }));
      return true;
    };

    function waitForTextDwell(ms: number, signal: AbortSignal): Promise<void> {
      if (signal.aborted) return Promise.resolve();
      return new Promise<void>((resolve) => {
        let elapsed = 0;
        let lastTick = performance.now();
        let finished = false;
        const done = () => {
          if (finished) return;
          finished = true;
          window.clearInterval(interval);
          signal.removeEventListener("abort", done);
          if (resolveTextWait === done) resolveTextWait = null;
          resolve();
        };
        resolveTextWait = done;
        const interval = window.setInterval(() => {
          const now = performance.now();
          if (!textHoldFlag) elapsed += now - lastTick;
          lastTick = now;
          if (elapsed >= ms) done();
        }, 60);
        signal.addEventListener("abort", done, { once: true });
      });
    }

    function stop(gen?: number) {
      if (gen !== undefined) {
        cancelled.add(gen);
        timeline?.cancel(gen);
        previewControllers.get(gen)?.abort();
        previewControllers.delete(gen);
        if (previewVisuals.delete(gen)) setClassroom(restoreClassroom(events, seq));
        if (previewGen === gen) previewGen = undefined;
      } else {
        for (const controller of previewControllers.values()) controller.abort();
        previewControllers.clear();
        previewGen = undefined;
        previewVisuals.clear();
      }
      resolveTextWait?.();
      output.stop(gen);
      setAudioSpeaking(false);
      setAudioBuffering(false);
    }

    function interrupt() {
      const gen = timeline?.playingGen ?? previewGen;
      if (gen === undefined || !timeline) return false;
      const heard_seq = timeline.heardSeq;
      stop(gen);
      return send("student.interrupt", { gen, heard_seq });
    }

    function pause(fromTabAway = false) {
      window.clearTimeout(tabTimer);
      tabTimer = 0;
      active = false;
      timeline?.dispose();
      stop();
      setStarted(false);
      setResuming(false);
      if (fromTabAway) setTabPaused(true);
      if (send("lesson.control", { action: "pause" })) {
        setClassroom((state) => ({ ...state, paused: true }));
      }
    }

    async function history() {
      const lesson = await fetchLesson(id);
      const latest = await fetchLessonEvents(id, seq);
      if (closed) return;
      current = lesson;
      for (const event of latest) {
        if (event.seq > seq) {
          events.push(event);
          seq = event.seq;
        }
      }
      setRoom(lesson);
      if (lesson.seq > 0) setHasFirstBeat(true);
      if (lesson.recap) {
        setEnding(false);
        setRecap(lesson.recap);
      }
      const after = lesson.status === "done" ? lesson.seq : lesson.playback_after_seq ?? lesson.seq;
      timeline?.dispose();
      formats.clear();
      previews.clear();
      previewVisuals.clear();
      previewControllers.clear();
      previewGen = undefined;
      previewTail = Promise.resolve();
      cancelled.clear();
      output.stop();
      output.resetGeneration(lesson.gen);
      const restored = restoreClassroom(events, after);
      setClassroom({
        ...restored,
        paused: lesson.status === "paused",
        segIdx: lesson.progress?.seg_idx ?? restored.segIdx,
        kpCursor: lesson.progress?.kp_cursor ?? restored.kpCursor,
        lastStyle: restored.lastStyle ?? lesson.style_id ?? undefined,
      });
      timeline = new Timeline(after, execute, () => {
        setError(copy.actionError);
        setErrorSeq((count) => count + 1);
      });
    }

    function formatOf(key: string, signal: AbortSignal) {
      if (formats.has(key) || signal.aborted) return Promise.resolve(formats.get(key));
      return new Promise<AudioMeta | undefined>((resolve) => {
        const limit = window.setTimeout(done, 20_000);
        function done() {
          window.clearTimeout(limit);
          signal.removeEventListener("abort", done);
          waiting.delete(key);
          resolve(formats.get(key));
        }
        waiting.set(key, done);
        signal.addEventListener("abort", done, { once: true });
      });
    }

    async function playSay(event: LessonEvent, signal: AbortSignal) {
      setAudioBuffering(true);
      try {
        const text = String(event.data.text ?? "");
        const seg = Number(event.data.seg);
        const meta = audio ? await formatOf(`${event.gen}:${seg}`, signal) : undefined;
        if (signal.aborted) return;
        if (meta && meta.format !== "text") {
          currentCaption = event;
          const browserVoice = meta.format === "browser" ? meta.browserVoice ?? { lang: "zh-CN" } : undefined;
          try {
            // Note: setAudioSpeaking(true) fires ONLY inside output.onSegmentStart once audio is audible!
            if (browserVoice) await output.useBrowser(event.gen, seg, text, browserVoice, signal);
            else await output.play(event.gen, seg, {}, signal);
            return;
          } catch {
            if (signal.aborted) return;
            setFallback(copy.textFallback);
          }
        } else if (audio) {
          setFallback(copy.textFallback);
        }
        // Text mode (or audio fallback): immediately display sentence and mark speaking during dwell.
        setAudioBuffering(false);
        setAudioSpeaking(true);
        setClassroom((state) => advanceClassroom(state, event));
        await waitForTextDwell(captionDelay(text, current?.teacher?.voice.rate), signal);
      } finally {
        currentCaption = undefined;
        setAudioBuffering(false);
        setAudioSpeaking(false);
      }
    }

    async function execute(event: LessonEvent, signal: AbortSignal) {
      if (event.type === "say") {
        const preview = previews.get(`${event.gen}:${Number(event.data.seg)}`);
        if (preview) {
          await preview;
          if (!signal.aborted) setClassroom((state) => advanceClassroom(state, event));
          return;
        }
        return playSay(event, signal);
      }
      if (event.type === "beat.start") {
        setHasFirstBeat(true);
        output.setGeneration(event.gen);
        for (const key of formats.keys()) if (!key.startsWith(`${event.gen}:`)) formats.delete(key);
        setPrefill(undefined);
      }
      if (event.type === "ask") {
        setPreviewVerdict(null);
      }
      if (event.type === "board" || event.type === "mark" || event.type === "board_param") {
        const pending = previewVisuals.get(event.gen);
        const index = pending?.indexOf(JSON.stringify([event.type, event.data])) ?? -1;
        if (pending && index >= 0) {
          pending.splice(index, 1);
          if (!pending.length) previewVisuals.delete(event.gen);
          return;
        }
      }
      setClassroom((state) => advanceClassroom(state, event));
      if (event.type === "beat.end" && !signal.aborted) send("playback.done", { gen: event.gen });
      if (event.type === "state" && event.data.paused === true) {
        active = false;
        setStarted(false);
      }
    }

    function receive(packet: MessageEvent) {
      if (closed) return;
      if (packet.data instanceof ArrayBuffer) {
        try {
          const frame = parseCsa1Frame(packet.data);
          if (cancelled.has(frame.gen)) return;
          const meta = formats.get(`${frame.gen}:${frame.seg}`);
          if (meta?.format === "mp3" || meta?.format === "pcm_s16le") {
            output.pushFrame(packet.data, { format: meta.format, sampleRate: meta.rate });
          }
        } catch {
          setFallback(copy.textFallback);
        }
        return;
      }
      const event: LessonEvent = JSON.parse(packet.data);
      if (event.lesson_id !== id) return;
      switch (event.type) {
        case "judge.preview": {
          if (cancelled.has(event.gen)) return;
          const verdict = typeof event.data.verdict === "string" ? event.data.verdict : "";
          if (verdict) {
            if (askSeqRef.current !== undefined) {
              setPreviewVerdict({ askSeq: askSeqRef.current, verdict });
            }
            onJudgePreviewRef.current?.(verdict, event.gen);
          }
          return;
        }
        case "board.preview": {
          if (!audio || cancelled.has(event.gen)) return;
          const type = String(event.data.type);
          if (type !== "board" && type !== "mark" && type !== "board_param") return;
          const data = event.data.event as Record<string, unknown>;
          const signature = JSON.stringify([type, data]);
          const pending = previewVisuals.get(event.gen) ?? [];
          pending.push(signature);
          previewVisuals.set(event.gen, pending);
          setClassroom((state) => advanceClassroom(state, { ...event, type, data }));
          return;
        }
        case "say.preview": {
          if (!audio || cancelled.has(event.gen)) return;
          if (previewGen !== event.gen) {
            if (previewGen !== undefined) previewControllers.get(previewGen)?.abort();
            previewGen = event.gen;
            output.setGeneration(event.gen);
          }
          const controller = previewControllers.get(event.gen) ?? new AbortController();
          previewControllers.set(event.gen, controller);
          const key = `${event.gen}:${Number(event.data.seg)}`;
          const playback = previewTail.catch(() => undefined).then(() => playSay(event, controller.signal));
          previewTail = playback;
          previews.set(key, playback);
          return;
        }
        case "audio": {
          if (cancelled.has(event.gen)) return;
          const seg = Number(event.data.seg);
          const format = event.data.format as Format;
          const key = `${event.gen}:${seg}`;
          formats.set(key, {
            format,
            rate: Number(event.data.sample_rate),
            browserVoice: event.data.browser_voice as BrowserVoice | undefined,
          });
          waiting.get(key)?.();
          if (event.data.last) {
            if (format === "mp3" || format === "pcm_s16le") output.finishSegment(event.gen, seg);
            else output.skipSegment(event.gen, seg);
          }
          return;
        }
        case "voice.fallback":
          if (!cancelled.has(event.gen)) {
            const engine = event.data.engine;
            setFallback(
              engine === "browser"
                ? copy.browserFallback
                : engine === "text"
                  ? copy.textFallback
                  : copy.engineFallback,
            );
          }
          return;
        case "voice.transcript": {
          const spoken = String(event.data.text ?? "");
          setTranscript(spoken);
          if (spoken.trim()) {
            studentSubOrderRef.current += 1;
            const order = Math.max(lastSeqRef.current, seq) * 1000 + studentSubOrderRef.current;
            setStudentEntries((prev) => [
              ...prev.slice(-199),
              {
                id: `v:${Date.now()}:${prev.length}`,
                role: "student",
                text: spoken,
                badge: "voice",
                order,
              },
            ]);
          }
          return;
        }
        case "voice.discarded":
          setTranscript(copy.noSpeech);
          if (event.data.protect) setEchoProtected(true);
          return;
        case "prefill":
          setPrefill(event.data as Prefill);
          return;
        case "recap":
          setEnding(false);
          setRecap(event.data);
          return;
        case "error":
          setResuming(false);
          setEnding(false);
          setError(classroomErrorMessage(event.data, copy.actionError));
          setErrorSeq((count) => count + 1);
          return;
        case "state":
          if (active) setResuming(false);
          break;
        case "beat.cancelled":
          stop(event.gen);
          break;
      }
      if (event.seq > seq) {
        events.push(event);
        seq = event.seq;
      }
      if (active) timeline?.append(event);
    }

    async function connect(options?: { takeover?: boolean }) {
      try {
        await history();
        if (closed || !current || current.status === "done" || current.status === "abandoned") return;
        const next = await openLessonSocket(id, options);
        if (closed) {
          next.addEventListener("open", () => next.close(), { once: true });
          return;
        }
        socket = next;
        next.onmessage = receive;
        next.onopen = () => {
          setConnected(true);
          setFatalError(false);
          setConflict(null);
          setVaultLocked(false);
          setError("");
          offline = 0;
          setReconnectAttempt(0);
          if (active && !document.hidden) {
            setResuming(true);
            send("lesson.control", { action: "resume", audio });
          }
        };
        next.onclose = (event) => {
          if (closed) return;
          setConnected(false);
          timeline?.dispose();
          stop();
          if (event.code === 4409) {
            const taken = event.reason === "taken_over";
            setFatalError(true);
            setConflict(taken ? "taken_over" : "other_tab");
            setError(taken ? copy.takenOver : copy.otherTab);
            return;
          }
          // Unbounded exponential backoff capped at 15 seconds (§5.6.12)
          offline += 1;
          setReconnectAttempt(offline);
          timer = window.setTimeout(() => void connect(), reconnectDelayMs(offline));
        };
      } catch (cause) {
        if (closed) return;
        if (cause instanceof ApiError && cause.status === 401) {
          try {
            const session = await bootstrapSession();
            if (closed) return;
            if (session.state === "ready") {
              await connect(options);
              return;
            }
            setVaultLocked(true);
            setFatalError(true);
            setError(copy.serviceRestartLocked);
            return;
          } catch {
            // Fall through to backoff retry if backend is still restarting
          }
        }
        if (cause instanceof ApiError && cause.status === 404) {
          setFatalError(true);
          setError(classroomErrorMessage(cause, copy.connectionError));
          return;
        }
        offline += 1;
        setReconnectAttempt(offline);
        setError(classroomErrorMessage(cause, copy.connectionError));
        timer = window.setTimeout(() => void connect(), reconnectDelayMs(offline));
      }
    }

    connection.current = {
      send(type, data) {
        setError("");
        if (type === "lesson.control" && data?.action === "end") {
          setEnding(true);
        }
        if (type !== "student.activity") firstSound = performance.now();
        return send(type, data);
      },
      async start(withAudio) {
        setError("");
        setFallback("");
        setTabPaused(false);
        audio = withAudio;
        setLastAudio(withAudio);
        writeRememberedAudio(id, withAudio);
        if (withAudio) {
          try {
            await output.prepare();
          } catch {
            audio = false;
            setFallback(copy.textFallback);
          }
        }
        try {
          await history();
          if (closed) return;
          active = send("lesson.control", { action: "resume", audio });
          if (active) {
            setResuming(true);
            setStarted(true);
            setClassroom((state) => ({ ...state, paused: false }));
          }
        } catch {
          setError(copy.connectionError);
        }
      },
      async reconnect(options?: { takeover?: boolean }) {
        window.clearTimeout(timer);
        offline = 0;
        setReconnectAttempt(0);
        setFatalError(false);
        setConflict(null);
        setVaultLocked(false);
        setError("");
        if (!options?.takeover && socket?.readyState === WebSocket.OPEN) {
          await connection.current?.start(audio);
          return;
        }
        if (socket && socket.readyState !== WebSocket.CLOSED) {
          socket.onclose = null;
          socket.close();
          socket = undefined;
        }
        await connect(options);
      },
      interrupt,
      pause,
      upload: (frame) => {
        if (socket?.readyState === WebSocket.OPEN && socket.bufferedAmount < 128_000) socket.send(frame);
      },
      setVolume: (v) => output.setVolume(v),
      setMuted: (m) => output.setMuted(m),
      skipTextWait: () => resolveTextWait?.(),
      setTextHold: (hold) => {
        textHoldFlag = hold;
        setTextHoldState(hold);
      },
    };

    // D4 / §4.5: 30-second tab-switch rule
    const onVisibility = () => {
      if (document.hidden) {
        if (!active) return;
        hiddenAt = Date.now();
        output.stop();
        setAudioSpeaking(false);
        window.clearTimeout(tabTimer);
        tabTimer = window.setTimeout(() => {
          if (document.hidden && active) {
            pause(true);
          }
        }, TAB_AWAY_PAUSE_MS);
      } else {
        window.clearTimeout(tabTimer);
        tabTimer = 0;
        if (hiddenAt && active && Date.now() - hiddenAt < TAB_AWAY_PAUSE_MS) {
          hiddenAt = 0;
          if (socket?.readyState === WebSocket.OPEN) {
            send("lesson.control", { action: "resume", audio });
          }
        }
        hiddenAt = 0;
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    void connect();
    return () => {
      closed = true;
      connection.current = null;
      window.clearTimeout(timer);
      window.clearTimeout(tabTimer);
      document.removeEventListener("visibilitychange", onVisibility);
      const currentSocket = socket;
      if (currentSocket?.readyState === WebSocket.CONNECTING) {
        currentSocket.onopen = () => currentSocket.close();
      } else currentSocket?.close();
      timeline?.dispose();
      void output.close();
    };
  }, [id]);

  return {
    room,
    classroom,
    connected,
    started,
    resuming,
    speaking: audioSpeaking,
    audioSpeaking,
    audioBuffering,
    lastAudio,
    error,
    errorSeq,
    fatalError,
    conflict,
    vaultLocked,
    reconnectAttempt,
    fallback,
    prefill,
    previewVerdict,
    transcript,
    studentEntries,
    appendStudentEntry,
    echoProtected,
    recap,
    latency,
    tabPaused,
    textHold,
    ending,
    hasFirstBeat,
    start: (audio: boolean) => connection.current?.start(audio),
    reconnect: (options?: { takeover?: boolean }) => connection.current?.reconnect(options),
    send: (type: string, data?: Record<string, unknown>) => connection.current?.send(type, data) ?? false,
    pause: () => connection.current?.pause(false),
    interrupt: () => connection.current?.interrupt() ?? false,
    upload: (frame: ArrayBuffer) => connection.current?.upload(frame),
    setVolume: (v: number) => connection.current?.setVolume(v),
    setMuted: (m: boolean) => connection.current?.setMuted(m),
    skipTextWait: () => connection.current?.skipTextWait(),
    setTextHold: (hold: boolean) => connection.current?.setTextHold(hold),
  };
}
