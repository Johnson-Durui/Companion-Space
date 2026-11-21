import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type PointerEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import { LessonText } from "@companion-space/board";
import {
  IDLE_COMPANION_MS,
  quickActionToInstantAction,
  verdictToInstantAction,
} from "@companion-space/avatar-engine/choreographer";
import type { DecodedSpeechChunk, InstantAction } from "@companion-space/avatar-engine/types";
import { TutorVideoBox, type TutorVideoBoxHandle } from "@companion-space/avatar-engine/video-box";
import { api, bodyOf } from "../../app/api";
import { Loading } from "../../app/ui";
import { MicrophoneCapture, Pcm16Framer, type HandsFreeVad } from "../../audio";
import t from "../../locales/zh-CN.json";
import { toVideoAvatarConfig, videoBoxLabels } from "../characters/video-config";
import { createSidecarConnector } from "../characters/sidecar-connector";
import { BoardBlock } from "./board-block";
import { resolveClassroomDisplay, type Ask, type Prefill } from "./lesson-state";
import { useClassroom } from "./use-classroom";
import "./classroom.css";

const copy = t.classroom;
const quick = ["confused", "example", "hint", "show_answer"] as const;
const more = ["repeat", "slower", "faster", "skip", "break"] as const;

function useReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return reduced;
}

function Question({ ask, prefill, submitted, submit, onActivity }: {
  ask: Ask;
  prefill?: Prefill;
  submitted: boolean;
  submit: (value: string | string[], via: "text" | "voice" | "control", unknown?: boolean) => void;
  onActivity: () => void;
}) {
  const widget = ask.widget!;
  const [edited, setEdited] = useState<string | string[]>();
  const value = edited ?? prefill?.value ?? (widget.type === "multi" ? [] : "");
  const via = edited === undefined && prefill ? prefill.via : "control";
  const choose = (key: string) => {
    onActivity();
    const selected = Array.isArray(value) ? value : [];
    setEdited(widget.type !== "multi" ? key : selected.includes(key) ? selected.filter((item) => item !== key) : [...selected, key]);
  };
  return <form className="lesson-question" onSubmit={(event) => { event.preventDefault(); submit(value, via); }}>
    <fieldset disabled={submitted}>
      <legend>{copy.question}</legend>
      <LessonText source={widget.stem} />
      {via === "voice" || via === "text" ? <p className="hint" role="status">{copy.confirmPrefill}</p> : null}
      {widget.options.length ? <div className="lesson-choices">
        {widget.options.map((option) => <label key={option.key}>
          <input type={widget.type === "multi" ? "checkbox" : "radio"} name={ask.item_id}
            checked={Array.isArray(value) ? value.includes(option.key) : value === option.key} onChange={() => choose(option.key)} />
          <span><strong>{option.key}</strong> {option.text}</span>
        </label>)}
      </div> : <label className="lesson-answer-label">{copy.answer}
        <textarea rows={2} value={String(value)} maxLength={3000} onFocus={onActivity} onChange={(event) => { onActivity(); setEdited(event.target.value); }} />
      </label>}
      <div className="actions">
        <button className="button primary" disabled={!value.length}>{copy.submitAnswer}</button>
        <button className="button quiet" type="button" onClick={() => { submit("", "control", true); }}>{copy.dontKnow}</button>
      </div>
    </fieldset>
  </form>;
}

function Lesson({ id }: { id: string }) {
  const videoRef = useRef<TutorVideoBoxHandle>(null);
  const reducedMotion = useReducedMotion();
  const [quietCompanion, setQuietCompanion] = useState(false);
  const [instantOverride, setInstantOverride] = useState<{ action: InstantAction; until: number } | null>(null);
  const lastActivityRef = useRef<number>(0);
  const previewJudgeGenRef = useRef<number>(-1);

  const onSpeechLevel = useCallback((level: number) => {
    videoRef.current?.pushSpeechLevel(level);
  }, []);
  const onSpeechChunk = useCallback((chunk: DecodedSpeechChunk) => {
    videoRef.current?.pushSpeechChunk(chunk);
  }, []);
  const triggerFastAction = useCallback((action: InstantAction, gen: number) => {
    lastActivityRef.current = Date.now();
    setQuietCompanion(false);
    setInstantOverride({ action, until: Date.now() + 2600 });
    videoRef.current?.triggerInstantAction(action, gen);
  }, []);
  const onJudgePreview = useCallback((verdict: string, gen: number) => {
    previewJudgeGenRef.current = gen;
    const action = verdictToInstantAction(verdict);
    if (action) triggerFastAction(action, gen);
  }, [triggerFastAction]);

  const live = useClassroom(id, onSpeechLevel, onSpeechChunk, onJudgePreview);
  const [text, setText] = useState("");
  const [recording, setRecording] = useState(false);
  const [handsFree, setHandsFree] = useState(false);
  const [micMessage, setMicMessage] = useState("");
  const [submission, setSubmission] = useState<{ askSeq: number; errorSeq: number } | null>(null);
  const capture = useRef<MicrophoneCapture>(null);
  const vad = useRef<HandsFreeVad>(null);
  const vadRequest = useRef(0);
  const down = useRef(false);
  const meter = useRef<HTMLMeterElement>(null);
  const micStarted = useRef(false);
  const echoProtected = useRef(false);
  const voice = useQuery({
    queryKey: ["voice-status"],
    queryFn: async () => bodyOf(await api.GET("/api/v2/voice/status")),
  });

  const markLearnerActivity = useCallback(() => {
    lastActivityRef.current = Date.now();
    setQuietCompanion(false);
  }, []);

  useEffect(() => {
    echoProtected.current = live.echoProtected;
  }, [live.echoProtected]);

  useEffect(() => {
    if (!instantOverride) return;
    const delay = Math.max(0, instantOverride.until - Date.now());
    const timer = window.setTimeout(() => setInstantOverride(null), delay);
    return () => window.clearTimeout(timer);
  }, [instantOverride]);

  const submitted = Boolean(
    submission
    && live.classroom.askSeq !== undefined
    && submission.askSeq === live.classroom.askSeq
    && submission.errorSeq === live.errorSeq,
  );
  const display = resolveClassroomDisplay({
    connected: live.connected,
    started: live.started,
    roomSeq: live.room?.seq ?? 0,
    recording,
    speaking: live.speaking,
    quietCompanion,
    submitted,
    instantAction: instantOverride?.action ?? null,
    classroom: live.classroom,
  });

  useEffect(() => {
    const waitingForStudent = live.started && !live.speaking && !recording && display.awaitingAnswer;
    if (!waitingForStudent) return;
    lastActivityRef.current = Date.now();
    const timer = window.setInterval(() => {
      if (Date.now() - lastActivityRef.current >= IDLE_COMPANION_MS) {
        setQuietCompanion(true);
      }
    }, 1000);
    return () => {
      window.clearInterval(timer);
      setQuietCompanion(false);
    };
  }, [live.started, live.speaking, recording, display.awaitingAnswer, live.classroom.askSeq]);

  useEffect(() => {
    const action = live.classroom.avatar.instantAction;
    if (!action) return;
    if (live.classroom.avatar.gen === previewJudgeGenRef.current && live.classroom.judge) return;
    videoRef.current?.triggerInstantAction(action, live.classroom.avatar.gen);
  }, [live.classroom.avatar.gestureSequence, live.classroom.avatar.instantAction, live.classroom.avatar.gen, live.classroom.judge]);

  useEffect(() => {
    const release = () => {
      if (!document.hidden) return;
      vadRequest.current += 1;
      down.current = false;
      micStarted.current = false;
      void capture.current?.stop();
      void vad.current?.destroy();
      capture.current = null;
      vad.current = null;
      setRecording(false);
      setHandsFree(false);
    };
    document.addEventListener("visibilitychange", release);
    return () => {
      document.removeEventListener("visibilitychange", release);
      vadRequest.current += 1;
      down.current = false;
      void capture.current?.stop();
      void vad.current?.destroy();
    };
  }, []);

  const currentGen = live.classroom.avatar.gen;
  const interruptAll = useCallback(() => {
    markLearnerActivity();
    setInstantOverride(null);
    videoRef.current?.interrupt(currentGen);
    return live.interrupt();
  }, [currentGen, live, markLearnerActivity]);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!text.trim()) return;
    interruptAll();
    const ask = live.classroom.ask;
    const sent = ask && !ask.widget
      ? live.send("student.reply", { purpose: ask.purpose, value: text.trim() })
      : live.send("student.text", { text: text.trim() });
    if (sent) setText("");
  }
  function action(kind: string) {
    markLearnerActivity();
    live.interrupt();
    const instant = quickActionToInstantAction(kind);
    if (instant) {
      triggerFastAction(instant, currentGen);
    }
    live.send("student.quick", instant ? { kind, recent_avatar_action: instant } : { kind });
  }
  async function startMic() {
    if (down.current || !live.connected || handsFree) return;
    down.current = true;
    setMicMessage("");
    const interrupted = interruptAll();
    setRecording(true);
    const mic = new MicrophoneCapture();
    capture.current = mic;
    try {
      await mic.start(({ pcm16, level }) => {
        if (!down.current || capture.current !== mic) return;
        if (!micStarted.current) micStarted.current = live.send("microphone.start", { interrupted });
        if (meter.current) meter.current.value = level;
        if (micStarted.current) live.upload(pcm16);
      });
      if (!down.current || capture.current !== mic) await mic.stop();
    } catch {
      if (capture.current !== mic) return;
      setMicMessage(copy.micError);
      down.current = false;
      setRecording(false);
    }
  }
  function finishMic() {
    if (!down.current) return;
    down.current = false;
    setRecording(false);
    if (meter.current) meter.current.value = 0;
    void capture.current?.stop();
    capture.current = null;
    if (micStarted.current) live.send("microphone.end");
    micStarted.current = false;
  }
  function beginPress(event: PointerEvent<HTMLButtonElement>) {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    void startMic();
  }
  function keyPress(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== " " && event.key !== "Enter") return;
    event.preventDefault();
    if (event.type === "keyup") finishMic();
    else if (!event.repeat) void startMic();
  }
  async function stopVad() {
    vadRequest.current += 1;
    const instance = vad.current;
    vad.current = null;
    setHandsFree(false);
    setRecording(false);
    if (instance) await instance.destroy();
    live.send("microphone.cancel");
  }
  async function toggleVad() {
    if (handsFree) {
      await stopVad();
      return;
    }
    const request = ++vadRequest.current;
    setHandsFree(true);
    setMicMessage("");
    try {
      const { HandsFreeVad } = await import("../../audio/vad");
      if (request !== vadRequest.current) return;
      let framer = new Pcm16Framer(16_000);
      const instance = new HandsFreeVad({
        onSpeechStart: () => {
          if (document.hidden || vad.current !== instance) return;
          markLearnerActivity();
          framer = new Pcm16Framer(16_000);
          setRecording(true);
          live.send("microphone.start");
        },
        onFrame: (samples) => {
          if (document.hidden || vad.current !== instance) return;
          for (const frame of framer.push(samples)) {
            if (meter.current) meter.current.value = frame.level;
            live.upload(frame.pcm16);
          }
        },
        onInterrupt: () => {
          if (vad.current === instance && !document.hidden && !echoProtected.current && interruptAll()) {
            live.send("microphone.interrupted");
          }
        },
        onSpeechEnd: () => {
          if (vad.current !== instance) return;
          setRecording(false);
          if (meter.current) meter.current.value = 0;
          live.send("microphone.end");
        },
        onMisfire: () => {
          if (vad.current !== instance) return;
          setRecording(false);
          if (meter.current) meter.current.value = 0;
          live.send("microphone.cancel");
        },
      });
      vad.current = instance;
      await instance.start();
    } catch {
      if (request !== vadRequest.current) return;
      await stopVad();
      setMicMessage(copy.micError);
    }
  }

  const labels = useMemo(() => videoBoxLabels(), []);
  const sidecarConnector = useMemo(() => createSidecarConnector(), []);
  const { room, classroom, started, connected, recap, speaking, error } = live;
  const teacher = room?.teacher;
  const teacherConfig = useMemo(
    () => (teacher ? toVideoAvatarConfig(teacher, reducedMotion) : null),
    [teacher, reducedMotion],
  );

  if (!room) return error ? <div className="notice danger" role="alert">{error}</div> : <Loading />;
  if (recap || room.status === "done" || room.status === "abandoned") return <section className="lesson-recap">
    <Link className="text-link" to={`/courses/${room.course_id}`}>{copy.back}</Link>
    <h1>{room.title}</h1>
    <h2>{copy.recap}</h2>
    {typeof recap?.summary === "string" ? <LessonText source={recap.summary} /> : null}
    <Link className="button quiet" to={`/lessons/${id}/history`}>{t.history.replay}</Link>
    <details><summary>{copy.board}</summary>
      {classroom.board.map((block) => <BoardBlock key={block.id} block={block} />)}
    </details>
  </section>;

  const ask = classroom.ask;
  const ready = started && connected && !live.resuming;
  const enabled = ready && voice.data?.stt_configured;
  const status = copy[display.statusKey];
  const resolvedPose = display.pose;

  return <section className="lesson-room">
    <header className="lesson-header">
      <div><Link className="text-link" to={`/courses/${room.course_id}`}>{copy.back}</Link><h1>{room.title}</h1></div>
      <div className="actions">
        <label>{copy.style}
          <select defaultValue="guided" disabled={!ready} onChange={(event) => action(`style:${event.target.value}`)}>
            {Object.entries(copy.styles).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select>
        </label>
        <button className="button quiet" disabled={!ready} onClick={() => { finishMic(); void stopVad(); live.pause(); }}>{copy.pause}</button>
        <button className="button quiet" disabled={!ready} onClick={() => {
          if (window.confirm(copy.endConfirm)) {
            finishMic(); void stopVad(); interruptAll(); live.send("lesson.control", { action: "end" });
          }
        }}>{copy.end}</button>
      </div>
    </header>
    {error ? <div className="notice danger" role="alert">{error} <button className="button quiet" disabled={!connected}
      onClick={() => void live.start(true)}>{copy.retry}</button></div> : null}
    {live.fallback ? <div className="notice" role="status">{live.fallback}<Link className="text-link" to="/settings#voice">{copy.voiceSettings}</Link></div> : null}
    <div className="lesson-surface">
      <aside className="lesson-stage">
        {teacherConfig ? (
          <TutorVideoBox
            ref={videoRef}
            config={teacherConfig}
            pose={resolvedPose}
            emotion={classroom.avatar.emotion}
            gen={classroom.avatar.gen}
            statusLabel={status}
            caption={classroom.caption}
            labels={labels}
            sidecarConnector={sidecarConnector}
          />
        ) : (
          <div className="lesson-stage-copy">
            <p className="lesson-caption" aria-live="polite">{classroom.caption}</p>
            <p className="lesson-speaker">{copy.teacher}<span>{status}</span></p>
          </div>
        )}
      </aside>
      <section className="lesson-board" aria-label={copy.board}>
        <header className="lesson-board-title"><h2>{copy.board}</h2><span>{copy.stages[classroom.stage as keyof typeof copy.stages]}</span></header>
        {!started && <div className="lesson-start"><p>{classroom.paused || room.seq > 0 ? copy.waitingResume : copy.ready}</p>
          <div className="actions">
            <button className="button primary" disabled={!connected} onClick={() => void live.start(true)}>{copy.startVoice}</button>
            <button className="button quiet" disabled={!connected} onClick={() => void live.start(false)}>{copy.startText}</button>
          </div>
        </div>}
        {classroom.board.map((block) => <BoardBlock key={block.id} block={block} locate={(target) => ready && action(`locate:${target}`)} />)}
        {ready && ask?.widget ? <Question key={classroom.askSeq} ask={ask} prefill={live.prefill?.item_id === ask.item_id ? live.prefill : undefined}
          submitted={submitted}
          onActivity={markLearnerActivity}
          submit={(value, via, dont_know) => {
            markLearnerActivity();
            if (dont_know) triggerFastAction("gentle_encourage", currentGen);
            if (live.send("student.answer", { item_id: ask.item_id, value, via, dont_know }) && classroom.askSeq !== undefined) {
              setSubmission({ askSeq: classroom.askSeq, errorSeq: live.errorSeq });
            }
          }} /> : null}
        {ready && ask?.kind === "ack" ? <div className="actions">
          {(["continue", "easier", "end"] as const).map((value) => <button className="button quiet" key={value}
            onClick={() => {
              markLearnerActivity();
              if (value === "easier") triggerFastAction("gentle_encourage", currentGen);
              live.send("student.reply", { purpose: ask.purpose, value });
            }}>{copy.ack[value]}</button>)}
        </div> : null}
        {classroom.judge ? <p className="hint lesson-verdict" role="status">{copy.verdicts[classroom.judge as keyof typeof copy.verdicts]}</p> : null}
      </section>
    </div>
    {started ? <footer className="lesson-controls">
      <div className="lesson-mic">
        <button className="button primary lesson-hold" aria-pressed={recording && !handsFree}
          disabled={!enabled || handsFree} onPointerDown={beginPress} onPointerUp={finishMic}
          onBlur={finishMic} onPointerCancel={finishMic} onKeyDown={keyPress} onKeyUp={keyPress}>{copy.holdToSpeak}</button>
        <button className="button quiet" type="button" aria-pressed={handsFree} disabled={!handsFree && (!enabled || live.echoProtected)}
          onClick={() => void toggleVad()}>{copy.handsFree}</button>
        <meter ref={meter} min={0} max={0.3} value={0} aria-label={copy.level} />
        {!voice.data?.stt_configured ? <Link className="text-link" to="/settings#voice">{copy.configureMic}</Link> : null}
        {speaking ? <button className="button quiet" type="button" onClick={interruptAll}>{copy.interrupt}</button> : null}
      </div>
      {micMessage || live.echoProtected || live.transcript ? <p className="hint" role="status">{micMessage || (live.echoProtected ? copy.echo : live.transcript)}</p> : null}
      <form className="lesson-compose" onSubmit={submit}>
        <input value={text} onChange={(event) => { markLearnerActivity(); setText(event.target.value); }} maxLength={3000} placeholder={copy.typeHere}
          aria-label={copy.typeHere} onFocus={() => { markLearnerActivity(); live.send("student.activity"); }} disabled={!ready} />
        <button className="button primary" disabled={!ready || !text.trim()}>{copy.send}</button>
      </form>
      <div className="lesson-quick">
        {quick.map((kind) => <button className="button quiet" disabled={!ready || (!ask?.widget && kind === "show_answer")}
          key={kind} onClick={() => action(kind)}>{copy.quick[kind]}</button>)}
        <details><summary>{copy.more}</summary><div className="actions">{more.map((kind) =>
          <button className="button quiet" disabled={!ready} key={kind} onClick={() => action(kind)}>{copy.quick[kind]}</button>)}</div></details>
      </div>
    </footer> : null}
    {import.meta.env.DEV && live.latency !== undefined ? <output className="lesson-latency">{copy.latency} {live.latency} ms</output> : null}
  </section>;
}

export default function Classroom() {
  const { lessonId = "" } = useParams();
  return <Lesson key={lessonId} id={lessonId} />;
}
