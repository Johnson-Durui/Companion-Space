import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import { api, bodyOf, type Character } from "../../app/api";
import { Loading, Problem } from "../../app/ui";
import { Badge, Card, Clock, EmptyState, Play, TutorAvatar } from "../../ui";
import { fetchLesson, fetchLessonEvents } from "../classroom/lesson-api";
import { captionDelay, type LessonEvent } from "../classroom/timeline";
import { useActiveTutor } from "../tutors/use-active-tutor";
import t from "../../locales/zh-CN.json";
import { resolveCharacterStill } from "../characters/video-config";
import { ReplayStage } from "./replay-stage";

const copy = t.history;
const viz = t.loopViz;
const dateTimeFmt = new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" });
const timeOnlyFmt = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" });
const dayGroupFmt = new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "short" });

function dayGroupLabel(iso: string, today = new Date()): string {
  const date = new Date(iso);
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((startOfDay(today) - startOfDay(date)) / 86_400_000);
  if (diffDays === 0) return viz.historyToday;
  if (diffDays === 1) return viz.historyYesterday;
  return dayGroupFmt.format(date);
}

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

  const lessonRows = history.data?.lessons;
  const groupedLessons = useMemo(() => {
    const groups: Array<{ dayKey: string; label: string; lessons: NonNullable<typeof lessonRows> }> = [];
    const byKey = new Map<string, (typeof groups)[number]>();
    for (const lesson of lessonRows ?? []) {
      const dayKey = String(lesson.updated_at).slice(0, 10);
      let group = byKey.get(dayKey);
      if (!group) {
        group = { dayKey, label: dayGroupLabel(lesson.updated_at), lessons: [] };
        byKey.set(dayKey, group);
        groups.push(group);
      }
      group.lessons.push(lesson);
    }
    return groups;
  }, [lessonRows]);

  if (history.isPending) return <Loading />;
  if (history.isError) return <Problem error={history.error} onRetry={() => void history.refetch()} />;

  return (
    <div className="grid min-w-0 gap-5" data-testid="course-history-page">
      {!embedded ? (
        <div className="grid gap-1">
          <Link className="text-caption font-medium text-fg-secondary hover:text-fg-primary" to={`/courses/${courseId}`}>
            {history.data.title}
          </Link>
          <h1 className="text-headline font-semibold text-fg-primary">{copy.heading}</h1>
        </div>
      ) : null}

      <section className="grid gap-4">
        {groupedLessons.length > 0 ? (
          groupedLessons.map((group) => (
            <div key={group.dayKey} className="grid gap-2.5">
              <h2 className="text-caption font-semibold text-fg-secondary">{group.label}</h2>
              <ol className="grid gap-3">
                {group.lessons.map((lesson) => {
                  const mins = lesson.active_ms > 0 ? Math.max(1, Math.round(lesson.active_ms / 60_000)) : null;
                  const doneStatus = lesson.status === "done";
                  return (
                    <li key={lesson.id} data-testid="history-lesson-card">
                      <Card padding="md" className="flex flex-wrap items-start justify-between gap-4">
                        <div className="grid min-w-0 flex-1 gap-1.5">
                          <div className="flex flex-wrap items-center gap-2 text-caption text-fg-tertiary">
                            <Badge tone={doneStatus ? "ok" : "warn"}>
                              {doneStatus ? viz.historyStatusDone : viz.historyStatusAbandoned}
                            </Badge>
                            <time>{timeOnlyFmt.format(new Date(lesson.updated_at))}</time>
                            {mins ? (
                              <span className="inline-flex items-center gap-1 tabular-nums">
                                <Clock size={12} aria-hidden="true" />
                                <span>{viz.historyMinutes.replace("{min}", String(mins))}</span>
                              </span>
                            ) : null}
                            {lesson.keypoints_total > 0 ? (
                              <span className="tabular-nums">
                                {viz.historyKeypoints
                                  .replace("{done}", String(lesson.keypoints_done))
                                  .replace("{total}", String(lesson.keypoints_total))}
                              </span>
                            ) : null}
                          </div>
                          <h3 className="text-body font-semibold text-fg-primary">{lesson.title}</h3>
                          {lesson.summary_first_line ? (
                            <p className="line-clamp-2 text-ui text-fg-secondary">
                              {lesson.summary_first_line}
                            </p>
                          ) : null}
                        </div>
                        <Link
                          className="button quiet shrink-0"
                          to={`/lessons/${lesson.id}/history`}
                        >
                          <Play size={14} aria-hidden="true" />
                          <span>{viz.historyReplay}</span>
                        </Link>
                      </Card>
                    </li>
                  );
                })}
              </ol>
            </div>
          ))
        ) : (
          <Card padding="lg">
            <EmptyState
              visual={
                tutor ? (() => {
                  const emptyStill = resolveCharacterStill(tutor, "empty_state");
                  return (
                    <TutorAvatar
                      src={emptyStill.url}
                      still={emptyStill.still}
                      name={tutor.name}
                      size="lg"
                    />
                  );
                })() : undefined
              }
              title={copy.emptyLessons}
              description={t.tutorsGallery.emptyHistoryLine}
            />
          </Card>
        )}
      </section>

      {/* Hide legacy conversations completely when there are none (U5 §5.8) */}
      {history.data.legacy.length > 0 ? (
        <Card padding="lg" className="grid gap-3" data-testid="legacy-history-section">
          <h2 className="text-title font-semibold text-fg-primary">{copy.legacy}</h2>
          <ul className="grid gap-2 text-ui text-fg-secondary">
            {history.data.legacy.map((session) => (
              <li key={session.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-surface-page px-3 py-2">
                <span>{dateTimeFmt.format(new Date(session.updated_at))}</span>
                <a
                  className="font-medium text-accent-strong hover:underline"
                  href={`/api/v2/courses/${encodeURIComponent(courseId!)}/legacy/${encodeURIComponent(session.id)}/markdown`}
                >
                  {copy.exportLegacy}
                </a>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
