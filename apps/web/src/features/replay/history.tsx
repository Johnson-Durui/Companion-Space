import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import { LessonText } from "@companion-space/board";
import { api, bodyOf } from "../../app/api";
import { Loading, Problem } from "../../app/ui";
import { BoardBlock } from "../classroom/board-block";
import { boardMarkdown } from "../classroom/board";
import { fetchLesson, fetchLessonEvents } from "../classroom/lesson-api";
import { restoreClassroom } from "../classroom/lesson-state";
import type { LessonEvent } from "../classroom/timeline";
import t from "../../locales/zh-CN.json";
import "../classroom/classroom.css";

const copy = t.history;
const dateFormat = new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" });

export function LessonRecording({ events, title }: { events: LessonEvent[]; title: string }) {
  const [index, setIndex] = useState(0);
  const [running, setRunning] = useState(false);
  const ordered = useMemo(() => [...events].sort((a, b) => a.seq - b.seq), [events]);
  const current = ordered[index - 1];
  const state = useMemo(() => restoreClassroom(ordered, current?.seq ?? 0), [current?.seq, ordered]);
  const finalBoard = useMemo(() => restoreClassroom(ordered, Infinity).board, [ordered]);
  const playing = running && index < ordered.length;

  useEffect(() => {
    if (!playing) return;
    const dwell = current?.type === "say" ? Math.min(6000, Math.max(700, state.caption.length * 65)) : 220;
    const timer = window.setTimeout(() => setIndex((position) => position + 1), dwell);
    return () => window.clearTimeout(timer);
  }, [current, playing, state.caption.length]);

  function toggle() {
    if (playing) { setRunning(false); return; }
    if (index >= ordered.length) setIndex(0);
    setRunning(true);
  }

  function download() {
    const url = URL.createObjectURL(new Blob([boardMarkdown(finalBoard)], { type: "text/markdown;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${title.replace(/[\\/:*?"<>|]/g, "-").slice(0, 80) || "lesson"}.md`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return <>
    <div className="actions">
      <button className="button primary" type="button" onClick={toggle} disabled={!ordered.length}>{playing ? copy.pause : copy.play}</button>
      <button className="button quiet" type="button" onClick={download} disabled={!finalBoard.length}>{copy.exportBoard}</button>
    </div>
    <label className="field">{copy.position} · {index}/{ordered.length}
      <input type="range" min={0} max={Math.max(1, ordered.length)} value={index} disabled={!ordered.length}
        onChange={(event) => { setRunning(false); setIndex(Number(event.target.value)); }} />
    </label>
    <section className="lesson-board" aria-label={t.classroom.board}>
      <p className="state-note" aria-live="polite">{state.caption || copy.emptyCaption}</p>
      {state.board.map((block) => <BoardBlock key={block.id} block={block} />)}
      {state.ask?.widget ? <div className="lesson-block">
        <LessonText source={state.ask.widget.stem} />
        <ul>{state.ask.widget.options.map(({ key, text }) => <li key={key}>{key}. {text}</li>)}</ul>
      </div> : null}
    </section>
  </>;
}

export function LessonHistoryPage() {
  const { lessonId } = useParams();
  const lesson = useQuery({ queryKey: ["lesson-history", lessonId], queryFn: () => fetchLesson(lessonId!), enabled: Boolean(lessonId) });
  const history = useQuery({ queryKey: ["lesson-events", lessonId], queryFn: () => fetchLessonEvents(lessonId!), enabled: Boolean(lessonId) });
  if (history.isPending || lesson.isPending) return <Loading />;
  if (history.isError || lesson.isError) return <Problem error={history.error ?? lesson.error} />;
  return <section className="lesson-recap">
    <Link className="text-link" to={`/courses/${lesson.data.course_id}/history`}>{copy.heading}</Link>
    <h1>{lesson.data.title}</h1>
    <LessonRecording events={history.data} title={lesson.data.title} />
  </section>;
}

export function CourseHistoryPage() {
  const { courseId } = useParams();
  const history = useQuery({
    queryKey: ["course-history", courseId], enabled: Boolean(courseId),
    queryFn: () => api.GET("/api/v2/courses/{course_id}/history", { params: { path: { course_id: courseId! } } }).then(bodyOf),
  });
  if (history.isPending) return <Loading />;
  if (history.isError) return <Problem error={history.error} onRetry={() => void history.refetch()} />;
  return <div className="lesson-recap">
    <Link className="text-link" to={`/courses/${courseId}`}>{history.data.title}</Link>
    <h1>{copy.heading}</h1>
    <section className="settings-section">
      <h2>{copy.classroomRecords}</h2>
      {history.data.lessons.length ? <ul>{history.data.lessons.map((lesson) => <li key={lesson.id}>
        <Link className="text-link" to={`/lessons/${lesson.id}/history`}>{lesson.title}</Link> · {dateFormat.format(new Date(lesson.updated_at))}
      </li>)}</ul> : <p className="hint">{copy.emptyLessons}</p>}
    </section>
    <section className="settings-section">
      <h2>{copy.legacy}</h2>
      {history.data.legacy.length ? <ul>{history.data.legacy.map((session) => <li key={session.id}>
        {dateFormat.format(new Date(session.updated_at))} · <a className="text-link"
          href={`/api/v2/courses/${encodeURIComponent(courseId!)}/legacy/${encodeURIComponent(session.id)}/markdown`}>{copy.exportLegacy}</a>
      </li>)}</ul> : <p className="hint">{copy.emptyLegacy}</p>}
    </section>
  </div>;
}
