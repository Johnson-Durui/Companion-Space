import { useEffect, useRef, useState } from "react";
import { SpeechOutput, parseCsa1Frame, type BrowserVoice, type SpeechFormat } from "../../audio";
import { publicMessage } from "../../app/api";
import t from "../../locales/zh-CN.json";
import { fetchLesson, fetchLessonEvents, openLessonSocket } from "./lesson-api";
import { advanceClassroom, initialClassroom, restoreClassroom, type Prefill } from "./lesson-state";
import { captionDelay, Timeline, waitFor, type LessonEvent } from "./timeline";

type Format = SpeechFormat | "text" | "browser";
type AudioMeta = { format: Format; rate: number; browserVoice?: BrowserVoice };
type Room = Awaited<ReturnType<typeof fetchLesson>>;
type Command = (type: string, data?: Record<string, unknown>) => boolean;
type Connection = { start: (audio: boolean) => Promise<void>; send: Command; interrupt: () => boolean;
  pause: () => void; upload: (frame: ArrayBuffer) => void };
const copy = t.classroom;

export function useClassroom(id: string) {
  const connection = useRef<Connection>(null);
  const [room, setRoom] = useState<Room>();
  const [classroom, setClassroom] = useState(initialClassroom);
  const [connected, setConnected] = useState(false);
  const [started, setStarted] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [error, setError] = useState("");
  const [fallback, setFallback] = useState("");
  const [prefill, setPrefill] = useState<Prefill>();
  const [transcript, setTranscript] = useState("");
  const [echoProtected, setEchoProtected] = useState(false);
  const [recap, setRecap] = useState<Record<string, unknown>>();
  const [latency, setLatency] = useState<number>();

  useEffect(() => {
    let socket: WebSocket | undefined;
    let timeline: Timeline | undefined;
    let current: Room | undefined;
    let closed = false;
    let timer = 0;
    let offline = 0;
    let active = false;
    let audio = false;
    let firstSound = 0;
    let currentCaption: LessonEvent | undefined;
    let seq = 0;
    const events: LessonEvent[] = [];
    const cancelled = new Set<number>();
    const formats = new Map<string, AudioMeta>();
    const waiting = new Map<string, () => void>();
    const output = new SpeechOutput({
      onSegmentStart: (gen, seg) => {
        if (firstSound) {
          setLatency(Math.round(performance.now() - firstSound));
          firstSound = 0;
        }
        if (currentCaption?.gen === gen && currentCaption.data.seg === seg) {
          const event = currentCaption;
          setClassroom((state) => advanceClassroom(state, event));
        }
      },
    });
    const send: Command = (type, data = {}) => {
      if (socket?.readyState !== WebSocket.OPEN) return false;
      socket.send(JSON.stringify({ type, data }));
      return true;
    };

    function stop(gen?: number) {
      if (gen !== undefined) {
        cancelled.add(gen);
        timeline?.cancel(gen);
      }
      output.stop(gen);
      setSpeaking(false);
    }
    function interrupt() {
      const gen = timeline?.playingGen;
      if (gen === undefined || !timeline) return false;
      const heard_seq = timeline.heardSeq;
      stop(gen);
      return send("student.interrupt", { gen, heard_seq });
    }
    function pause() {
      active = false;
      timeline?.dispose();
      stop();
      setStarted(false);
      setResuming(false);
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
        if (event.seq > seq) { events.push(event); seq = event.seq; }
      }
      setRoom(lesson);
      if (lesson.recap) setRecap(lesson.recap);
      const after = lesson.status === "done" ? lesson.seq : lesson.playback_after_seq ?? lesson.seq;
      timeline?.dispose();
      formats.clear();
      cancelled.clear();
      output.stop();
      output.resetGeneration(lesson.gen);
      setClassroom({ ...restoreClassroom(events, after), paused: lesson.status === "paused" });
      timeline = new Timeline(after, execute, () => setError(copy.actionError));
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

    async function execute(event: LessonEvent, signal: AbortSignal) {
      if (event.type === "say") {
        setSpeaking(true);
        try {
          const text = String(event.data.text ?? "");
          const seg = Number(event.data.seg);
          const meta = audio ? await formatOf(`${event.gen}:${seg}`, signal) : undefined;
          if (signal.aborted) return;
          if (meta && meta.format !== "text") {
            currentCaption = event;
            const browserVoice = meta.format === "browser" ? meta.browserVoice ?? { lang: "zh-CN" } : undefined;
            try {
              if (browserVoice) await output.useBrowser(event.gen, seg, text, browserVoice, signal);
              else await output.play(event.gen, seg, {}, signal);
              return;
            } catch {
              if (signal.aborted) return;
              setFallback(copy.textFallback);
            }
          } else if (audio) setFallback(copy.textFallback);
          setClassroom((state) => advanceClassroom(state, event));
          await waitFor(captionDelay(text, current?.teacher?.voice.rate), signal);
        } finally {
          currentCaption = undefined;
          setSpeaking(false);
        }
        return;
      }
      if (event.type === "beat.start") {
        output.setGeneration(event.gen);
        for (const key of formats.keys()) if (!key.startsWith(`${event.gen}:`)) formats.delete(key);
        setPrefill(undefined);
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
        } catch { setFallback(copy.textFallback); }
        return;
      }
      const event: LessonEvent = JSON.parse(packet.data);
      if (event.lesson_id !== id) return;
      switch (event.type) {
        case "audio": {
          if (cancelled.has(event.gen)) return;
          const seg = Number(event.data.seg), format = event.data.format as Format;
          const key = `${event.gen}:${seg}`;
          formats.set(key, {
            format, rate: Number(event.data.sample_rate), browserVoice: event.data.browser_voice as BrowserVoice | undefined,
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
            setFallback(engine === "browser" ? copy.browserFallback : engine === "text" ? copy.textFallback : copy.engineFallback);
          }
          return;
        case "voice.transcript":
          setTranscript(String(event.data.text));
          return;
        case "voice.discarded":
          setTranscript(copy.noSpeech);
          if (event.data.protect) setEchoProtected(true);
          return;
        case "prefill":
          setPrefill(event.data as Prefill);
          return;
        case "recap":
          setRecap(event.data);
          return;
        case "error":
          setResuming(false);
          setError(publicMessage(event.data) ?? copy.actionError);
          return;
        case "state":
          if (active) setResuming(false);
          break;
        case "beat.cancelled":
          stop(event.gen);
          break;
      }
      if (event.seq > seq) { events.push(event); seq = event.seq; }
      if (active) timeline?.append(event);
    }

    async function connect() {
      try {
        await history();
        if (closed || !current || current.status === "done" || current.status === "abandoned") return;
        const next = await openLessonSocket(id);
        if (closed) { next.addEventListener("open", () => next.close(), { once: true }); return; }
        socket = next;
        next.onmessage = receive;
        next.onopen = () => {
          setConnected(true);
          offline = 0;
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
          if (event.code === 4409) { setError(copy.otherTab); return; }
          if (++offline > 5) { setError(copy.connectionError); return; }
          timer = window.setTimeout(() => void connect(), Math.min(2400, offline * 400));
        };
      } catch (cause) {
        if (!closed) setError(cause instanceof Error ? cause.message : copy.connectionError);
      }
    }

    connection.current = {
      send(type, data) {
        setError("");
        if (type !== "student.activity") firstSound = performance.now();
        return send(type, data);
      },
      async start(withAudio) {
        setError("");
        setFallback("");
        audio = withAudio;
        if (withAudio) {
          try { await output.prepare(); }
          catch { audio = false; setFallback(copy.textFallback); }
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
        } catch { setError(copy.connectionError); }
      },
      interrupt,
      pause,
      upload: (frame) => { if (socket?.readyState === WebSocket.OPEN && socket.bufferedAmount < 128_000) socket.send(frame); },
    };
    const hidden = () => { if (document.hidden && active) pause(); };
    document.addEventListener("visibilitychange", hidden);
    void connect();
    return () => {
      closed = true;
      connection.current = null;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", hidden);
      const currentSocket = socket;
      if (currentSocket?.readyState === WebSocket.CONNECTING) {
        currentSocket.onopen = () => currentSocket.close();
      } else currentSocket?.close();
      timeline?.dispose();
      void output.close();
    };
  }, [id]);

  return { room, classroom, connected, started, resuming, speaking, error, fallback, prefill, transcript, echoProtected, recap, latency,
    start: (audio: boolean) => connection.current?.start(audio),
    send: (type: string, data?: Record<string, unknown>) => connection.current?.send(type, data) ?? false,
    pause: () => connection.current?.pause(),
    interrupt: () => connection.current?.interrupt() ?? false,
    upload: (frame: ArrayBuffer) => connection.current?.upload(frame) };
}
