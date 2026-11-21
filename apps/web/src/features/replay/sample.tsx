import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { LessonText } from "@companion-space/board";
import { Loading, Problem } from "../../app/ui";
import { BoardBlock } from "../classroom/board-block";
import { restoreClassroom } from "../classroom/lesson-state";
import t from "../../locales/zh-CN.json";
import { fetchSample, sampleKey, type Sample } from "./sample-api";
import "../classroom/classroom.css";

const copy = t.sample;

function SampleRecording({ sample }: { sample: Sample }) {
  const events = useMemo(() => [...sample.events].sort((a, b) => a.seq - b.seq), [sample.events]);
  const [position, setPosition] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [choice, setChoice] = useState<string>();
  const row = events[position - 1];
  const finished = position >= events.length;
  const question = row?.type === "ask";
  const state = useMemo(() => restoreClassroom(events, row?.seq ?? 0), [events, row?.seq]);
  const options = question ? sample.branches[String(row.seq)] : undefined;
  const advancing = playing && !finished && !question;
  const feedback = choice ? options?.[choice] : undefined;

  useEffect(() => {
    if (!advancing) return;
    const delay = row?.type === "say" ? Math.min(6500, Math.max(850, state.caption.length * 65)) : 200;
    const timer = window.setTimeout(() => setPosition((index) => index + 1), delay);
    return () => window.clearTimeout(timer);
  }, [advancing, row, state.caption.length]);

  function continueLesson() {
    const answerBeat = feedback && row ? events.findIndex((event, index) => index >= position && event.type === "beat.end" && event.gen > row.gen) : -1;
    setPosition(answerBeat >= 0 ? answerBeat + 1 : position + 1);
    setChoice(undefined);
    setPlaying(true);
  }

  return <>
    <div className="actions">
      <button className="button primary" type="button" disabled={question} onClick={() => {
        if (finished) { setPosition(0); setChoice(undefined); setPlaying(true); }
        else setPlaying(!playing);
      }}>{finished ? copy.restart : playing && !question ? t.history.pause : t.history.play}</button>
      <Link className="button quiet" to="/settings#models">{copy.connect}</Link>
    </div>
    <section className="lesson-board" aria-label={t.classroom.board}>
      <p className="state-note" aria-live="polite">{state.caption || t.history.emptyCaption}</p>
      {state.board.map((block) => <BoardBlock key={block.id} block={block} />)}
      {question ? <div className="lesson-question">
        {state.ask?.widget ? <LessonText source={state.ask.widget.stem} /> : null}
        {options && !feedback ? <div className="actions">
          {state.ask?.widget?.options.map((option) => <button key={option.key} type="button" className="button quiet"
            onClick={() => setChoice(option.key)}>{option.key}. {option.text}</button>)}
        </div> : <>
          {feedback ? <div data-testid="sample-feedback" aria-live="polite">{feedback.map((line, index) => <LessonText key={index} source={line} />)}</div> : null}
          <button className="button primary" type="button" onClick={continueLesson}>{copy.continue}</button>
        </>}
      </div> : null}
    </section>
    {finished ? <section className="settings-section"><h2>{t.classroom.recap}</h2>
      {sample.recap?.summary ? <LessonText source={sample.recap.summary} /> : null}
    </section> : null}
  </>;
}

export default function SampleLesson() {
  const sample = useQuery({ queryKey: sampleKey, queryFn: fetchSample, staleTime: Infinity });
  if (sample.isPending) return <Loading />;
  if (sample.isError) return <Problem error={sample.error} onRetry={() => void sample.refetch()} />;
  if (!sample.data) return <section className="lesson-recap"><h1>{copy.open}</h1><p className="notice">{copy.unavailable}</p></section>;
  return <section className="lesson-recap">
    <Link className="text-link" to="/welcome">{t.welcome.heading}</Link>
    <h1>{sample.data.title}</h1>
    <p className="hint">{copy.recording} · {sample.data.model} · {sample.data.recorded_at}</p>
    <p className="hint">{copy.freeQuestions}</p>
    <SampleRecording sample={sample.data} />
  </section>;
}
