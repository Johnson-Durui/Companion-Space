import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import { api, bodyOf, type Character } from "../../app/api";
import { Loading, Problem } from "../../app/ui";
import { EmptyState, TutorAvatar } from "../../ui";
import { fetchLesson, fetchLessonEvents } from "../classroom/lesson-api";
import { captionDelay, type LessonEvent } from "../classroom/timeline";
import { useActiveTutor } from "../tutors/use-active-tutor";
import t from "../../locales/zh-CN.json";
import { ReplayStage } from "./replay-stage";

const copy = t.history;
const dateFormat = new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" });

export function LessonRecording({
  events,
  title,
  backTo,
  teacher,
}: {
  events: LessonEvent[];
  title: string;
  backTo: string;
  teacher?: Character | null;
}) {
  const [index, setIndex] = useState(0);
  const [running, setRunning] = useState(false);
  const [speed, setSpeed] = useState(1);
  const ordered = useMemo(() => [...events].sort((a, b) => a.seq - b.seq), [events]);
  const current = ordered[index - 1];
  const playing = running && index < ordered.length;

  useEffect(() => {
    if (!playing) return;
    const isSay = current?.type === "say";
    const text = isSay ? String(current.data.text ?? "") : "";
    const dwell = isSay
      ? Math.round(captionDelay(text, teacher?.voice.rate) / speed)
      : Math.round(220 / speed);
    const timer = window.setTimeout(() => setIndex((position) => position + 1), dwell);
    return () => window.clearTimeout(timer);
  }, [current, playing, speed, teacher?.voice.rate]);

  function toggle() {
    if (playing) {
      setRunning(false);
      return;
    }
    if (index >= ordered.length) setIndex(0);
    setRunning(true);
  }

  return (
    <ReplayStage
      title={title}
      backTo={backTo}
      backLabel={copy.heading}
      events={ordered}
      position={index}
      playing={playing}
      speed={speed}
      speaking={playing && current?.type === "say"}
      teacher={teacher}
      onTogglePlay={toggle}
      onSeekPosition={(nextIdx) => {
        setRunning(false);
        setIndex(nextIdx);
      }}
      onSpeedChange={setSpeed}
    />
  );
}

export function LessonHistoryPage() {
  const { lessonId } = useParams();
  const lesson = useQuery({
    queryKey: ["lesson-history", lessonId],
    queryFn: () => fetchLesson(lessonId!),
    enabled: Boolean(lessonId),
  });
  const history = useQuery({
    queryKey: ["lesson-events", lessonId],
    queryFn: () => fetchLessonEvents(lessonId!),
    enabled: Boolean(lessonId),
  });

  if (history.isPending || lesson.isPending) {
    return (
      <main id="main" className="mx-auto max-w-[640px] p-8">
        <h1 className="sr-only">{t.app.titles.lessonHistory}</h1>
        <Loading />
      </main>
    );
  }
  if (history.isError || lesson.isError) {
    return (
      <main id="main" className="mx-auto max-w-[640px] p-8">
        <h1 className="sr-only">{t.app.titles.lessonHistory}</h1>
        <Problem
          error={history.error ?? lesson.error}
          onRetry={() => {
            void history.refetch();
            void lesson.refetch();
          }}
        />
      </main>
    );
  }
  return (
    <LessonRecording
      events={history.data}
      title={lesson.data.title}
      backTo={`/courses/${lesson.data.course_id}/history`}
      teacher={lesson.data.teacher}
    />
  );
}

export function CourseHistoryPage({ embedded = false }: { embedded?: boolean } = {}) {
  const { courseId } = useParams();
  const { tutor } = useActiveTutor();
  const history = useQuery({
    queryKey: ["course-history", courseId],
    enabled: Boolean(courseId),
    queryFn: () =>
      api
        .GET("/api/v2/courses/{course_id}/history", { params: { path: { course_id: courseId! } } })
        .then(bodyOf),
  });
  if (history.isPending) return <Loading />;
  if (history.isError) return <Problem error={history.error} onRetry={() => void history.refetch()} />;
  return (
    <div className="lesson-recap">
      {!embedded ? (
        <>
          <Link className="text-link" to={`/courses/${courseId}`}>
            {history.data.title}
          </Link>
          <h1>{copy.heading}</h1>
        </>
      ) : null}
      <section className="settings-section">
        <h2>{copy.classroomRecords}</h2>
        {history.data.lessons.length ? (
          <ul>
            {history.data.lessons.map((lesson) => (
              <li key={lesson.id}>
                <Link className="text-link" to={`/lessons/${lesson.id}/history`}>
                  {lesson.title}
                </Link>{" "}
                · {dateFormat.format(new Date(lesson.updated_at))}
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            visual={tutor ? <TutorAvatar src={tutor.appearance.src} name={tutor.name} size="lg" /> : undefined}
            title={copy.emptyLessons}
            description={t.tutorsGallery.emptyHistoryLine}
          />
        )}
      </section>
      <section className="settings-section">
        <h2>{copy.legacy}</h2>
        {history.data.legacy.length ? (
          <ul>
            {history.data.legacy.map((session) => (
              <li key={session.id}>
                {dateFormat.format(new Date(session.updated_at))} ·{" "}
                <a
                  className="text-link"
                  href={`/api/v2/courses/${encodeURIComponent(courseId!)}/legacy/${encodeURIComponent(session.id)}/markdown`}
                >
                  {copy.exportLegacy}
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <p className="hint">{copy.emptyLegacy}</p>
        )}
      </section>
    </div>
  );
}
