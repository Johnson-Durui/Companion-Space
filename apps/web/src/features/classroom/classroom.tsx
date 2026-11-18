import { lazy, Suspense, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type PointerEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import { LessonText } from "@companion-space/board";
import { createAvatarSpeechController } from "@companion-space/avatar-engine/speech-controller";
import type { CharacterPreviewState } from "@companion-space/avatar-engine/runtime-types";
import { api, bodyOf } from "../../app/api";
import { Loading } from "../../app/ui";
import { MicrophoneCapture, Pcm16Framer, type HandsFreeVad } from "../../audio";
import t from "../../locales/zh-CN.json";
import { BoardBlock } from "./board-block";
import type { Ask, Prefill } from "./lesson-state";
import { useClassroom } from "./use-classroom";
import "./classroom.css";

const copy = t.classroom;
const quick = ["confused", "example", "hint", "show_answer"] as const;
const more = ["repeat", "slower", "faster", "skip", "break"] as const;
const ClassroomAvatar = lazy(() => import("./classroom-avatar"));

function Question({ ask, prefill, submit }: {
  ask: Ask; prefill?: Prefill;
  submit: (value: string | string[], via: "text" | "voice" | "control", unknown?: boolean) => void;
}) {
  const widget = ask.widget!;
  const [edited, setEdited] = useState<string | string[]>();
  const [submitted, setSubmitted] = useState(false);
  const value = edited ?? prefill?.value ?? (widget.type === "multi" ? [] : "");
  const via = edited === undefined && prefill ? prefill.via : "control";
  const choose = (key: string) => {
    const selected = Array.isArray(value) ? value : [];
    setEdited(widget.type !== "multi" ? key : selected.includes(key) ? selected.filter((item) => item !== key) : [...selected, key]);
  };
  return <form className="lesson-question" onSubmit={(event) => { event.preventDefault(); submit(value, via); setSubmitted(true); }}>
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
        <textarea rows={2} value={String(value)} maxLength={3000} onChange={(event) => setEdited(event.target.value)} />
      </label>}
      <div className="actions">
        <button className="button primary" disabled={!value.length}>{copy.submitAnswer}</button>
        <button className="button quiet" type="button" onClick={() => { submit("", "control", true); setSubmitted(true); }}>{copy.dontKnow}</button>
      </div>
    </fieldset>
  </form>;
}

function Lesson({ id }: { id: string }) {
  const speechController = useMemo(() => createAvatarSpeechController(), []);
  const live = useClassroom(id, speechController.publishLevel, speechController.publishVisemes);
  const [text, setText] = useState("");
  const [recording, setRecording] = useState(false);
  const [handsFree, setHandsFree] = useState(false);
  const [micMessage, setMicMessage] = useState("");
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

  useEffect(() => {
    echoProtected.current = live.echoProtected;
  }, [live.echoProtected]);

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

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!text.trim()) return;
    live.interrupt();
    const ask = live.classroom.ask;
    const sent = ask && !ask.widget
      ? live.send("student.reply", { purpose: ask.purpose, value: text.trim() })
      : live.send("student.text", { text: text.trim() });
    if (sent) setText("");
  }
  function action(kind: string) {
    live.interrupt();
    live.send("student.quick", { kind });
  }
  async function startMic() {
    if (down.current || !live.connected || handsFree) return;
    down.current = true;
    setMicMessage("");
    const interrupted = live.interrupt();
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
    if (handsFree) { await stopVad(); return; }
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
          if (vad.current === instance && !document.hidden && !echoProtected.current && live.interrupt()) {
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

  const { room, classroom, started, connected, recap, speaking, error } = live;
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
  const status = !connected ? copy.connecting : !started ? copy.paused : recording ? copy.listening : speaking ? copy.speaking : ask ? copy.waiting : copy.thinking;
  const avatarState: CharacterPreviewState = recording ? "listening" : speaking ? "speaking" : ask ? "listening" : started ? "thinking" : "idle";
  const avatarFallback = room.teacher?.appearance.kind === "portrait" ? <img alt="" src={room.teacher.appearance.src} /> : null;
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
            finishMic(); void stopVad(); live.interrupt(); live.send("lesson.control", { action: "end" });
          }
        }}>{copy.end}</button>
      </div>
    </header>
    {error ? <div className="notice danger" role="alert">{error} <button className="button quiet" disabled={!connected}
      onClick={() => void live.start(true)}>{copy.retry}</button></div> : null}
    {live.fallback ? <div className="notice" role="status">{live.fallback}<Link className="text-link" to="/settings#voice">{copy.voiceSettings}</Link></div> : null}
    <div className="lesson-surface">
      <aside className="lesson-stage">
        <Suspense fallback={avatarFallback}>
          <ClassroomAvatar
            appearance={room.teacher?.appearance}
            emotion={classroom.avatar.emotion}
            gaze={classroom.avatar.gaze}
            gestureSequence={classroom.avatar.gestureSequence}
            name={room.teacher?.name ?? copy.teacher}
            reactionKey={classroom.avatar.reactionKey}
            speechController={speechController}
            state={avatarState}
          />
        </Suspense>
        <div className="lesson-stage-copy">
          <p className="lesson-caption" aria-live="polite">{classroom.caption}</p>
          <p className="lesson-speaker">{room.teacher?.name ?? copy.teacher}<span>{status}</span></p>
        </div>
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
          submit={(value, via, dont_know) => live.send("student.answer", { item_id: ask.item_id, value, via, dont_know })} /> : null}
        {ready && ask?.kind === "ack" ? <div className="actions">
          {(["continue", "easier", "end"] as const).map((value) => <button className="button quiet" key={value}
            onClick={() => live.send("student.reply", { purpose: ask.purpose, value })}>{copy.ack[value]}</button>)}
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
        {speaking ? <button className="button quiet" type="button" onClick={live.interrupt}>{copy.interrupt}</button> : null}
      </div>
      {micMessage || live.echoProtected || live.transcript ? <p className="hint" role="status">{micMessage || (live.echoProtected ? copy.echo : live.transcript)}</p> : null}
      <form className="lesson-compose" onSubmit={submit}>
        <input value={text} onChange={(event) => setText(event.target.value)} maxLength={3000} placeholder={copy.typeHere}
          aria-label={copy.typeHere} onFocus={() => live.send("student.activity")} disabled={!ready} />
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
