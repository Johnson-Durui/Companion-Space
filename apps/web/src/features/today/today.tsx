import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, Navigate } from "react-router";
import clsx from "clsx";
import {
  charactersKey,
  fetchCharacters,
  fetchSettings,
  settingsKey,
} from "../../app/api";
import { Loading, Problem } from "../../app/ui";
import {
  ArrowRight,
  Award,
  Badge,
  BookOpen,
  Button,
  Calendar,
  Card,
  CheckCircle2,
  Clock,
  Compass,
  Flame,
  GraduationCap,
  Layers,
  MasteryBar,
  Play,
  RotateCcw,
  Sparkles,
  Target,
  Volume2,
  WeightBar,
} from "../../ui";
import t from "../../locales/zh-CN.json";
import { TeacherPreview } from "../characters/teacher-preview";
import { resolveCharacterStill } from "../characters/video-config";
import { courseKeys, listCourseDashboard, listCourses } from "../courses/api";
import { resolveCoursePrimaryAction } from "../courses/journey-helpers";
import type { Course, CourseDashboard } from "../courses/types";
import { getLearnerProfile, learnerKeys } from "../learner/api";
import { resolveLearnerNickname } from "../learner/nickname";
import { buildPlanWhySentence, masteryLabel, masteryLevel, weightLabel } from "../plan/why-sentence";
import { fetchLearnerWeekSummary, progressKeys } from "../progress/api";
import { fetchSample, sampleKey } from "../replay/sample-api";
import { ConnectWizardDialog } from "../settings/connect-wizard";
import { useReadiness } from "../settings/use-readiness";
import { tutorGreeting, tutorLine } from "../tutors/use-active-tutor";
import { useTutorSpeech } from "../voice/use-tutor-speech";

const copy = t.today;

function timePeriodKey(): "morning" | "afternoon" | "evening" {
  const hour = new Date().getHours();
  if (hour < 12) return "morning";
  if (hour < 18) return "afternoon";
  return "evening";
}

function timePeriodGreeting(): string {
  const key = timePeriodKey();
  return copy[key];
}

function sortByExamDate(
  entries: Array<{ course: Course; summary?: CourseDashboard }>,
): Array<{ course: Course; summary?: CourseDashboard }> {
  return [...entries].sort((a, b) => {
    const aDays = a.summary?.remaining_days;
    const bDays = b.summary?.remaining_days;
    if (aDays != null && bDays != null) return aDays - bDays;
    if (aDays != null) return -1;
    if (bDays != null) return 1;
    const aHasToday = Boolean(a.summary?.today_lesson);
    const bHasToday = Boolean(b.summary?.today_lesson);
    if (aHasToday !== bHasToday) return aHasToday ? -1 : 1;
    return 0;
  });
}

const todayDateFmt = new Intl.DateTimeFormat("zh-CN", {
  month: "short",
  day: "numeric",
  weekday: "short",
});

function weekdayShortLabel(isoDate: string): string {
  const parsed = new Date(`${isoDate}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return "";
  const idx = (parsed.getDay() + 6) % 7;
  return t.richUi.weekDaysShort[idx] ?? "";
}

function WhyBarsRow({ entry }: { entry: NonNullable<CourseDashboard["today_lesson_why"]>[number] }) {
  return (
    <div className="grid gap-3 rounded-lg border border-line-subtle/90 bg-surface-sunken/55 p-3.5 text-ui text-fg-secondary">
      <div className="flex items-center gap-2 text-caption font-semibold text-fg-secondary">
        <span className="inline-flex h-5 w-5 items-center justify-center rounded-sm bg-accent-soft text-accent-strong">
          <Compass size={13} aria-hidden="true" />
        </span>
        <span>{t.richUi.whyHeader}</span>
      </div>
      <div className="grid gap-2.5 sm:grid-cols-[auto_auto_1fr] sm:items-center sm:gap-x-6">
        <WeightBar
          weight={entry.weight}
          label={copy.weightLabel}
          valueText={weightLabel(entry.weight)}
        />
        <MasteryBar
          probability={entry.mastery}
          status={masteryLevel(entry.mastery)}
          label={copy.masteryLabel}
          valueText={masteryLabel(entry.mastery)}
        />
        <p className="text-ui font-medium text-fg-primary">{buildPlanWhySentence(entry)}</p>
      </div>
    </div>
  );
}

export default function TodayPage() {
  const [connectOpen, setConnectOpen] = useState(false);
  const settings = useQuery({ queryKey: settingsKey, queryFn: fetchSettings });
  const courses = useQuery({ queryKey: courseKeys.all, queryFn: listCourses });
  const dashboard = useQuery({ queryKey: courseKeys.dashboard, queryFn: listCourseDashboard });
  const characters = useQuery({ queryKey: charactersKey, queryFn: fetchCharacters });
  const profile = useQuery({ queryKey: learnerKeys.profile, queryFn: getLearnerProfile });
  const weekSummary = useQuery({ queryKey: progressKeys.weekSummary, queryFn: fetchLearnerWeekSummary });
  const sample = useQuery({ queryKey: sampleKey, queryFn: fetchSample, staleTime: Infinity });
  const readiness = useReadiness();
  const speech = useTutorSpeech();

  if (settings.isPending || courses.isPending || dashboard.isPending) {
    return <Loading />;
  }
  if (settings.isError) return <Problem error={settings.error} onRetry={() => void settings.refetch()} />;
  if (courses.isError) return <Problem error={courses.error} onRetry={() => void courses.refetch()} />;
  if (dashboard.isError) return <Problem error={dashboard.error} onRetry={() => void dashboard.refetch()} />;

  // §4.1 First-use rule: onboarding not completed AND no courses -> /welcome
  const onboardingCompleted = Boolean(settings.data.onboarding_completed_at);
  if (!onboardingCompleted && courses.data.length === 0) {
    return <Navigate to="/welcome" replace />;
  }

  const allCharacters = characters.data ?? [];
  const teacher =
    allCharacters.find((entry) => entry.id === settings.data.default_character_id) ?? allCharacters[0] ?? null;

  const nickname = resolveLearnerNickname(profile.data?.nickname, teacher?.persona.address_user_as);
  const period = timePeriodGreeting();
  const greetingHeading = nickname
    ? copy.greetingWithName.replace("{period}", period).replace("{name}", nickname)
    : copy.greetingPlain.replace("{period}", period);

  const summaryByCourse = new Map(dashboard.data.map((entry) => [entry.course_id, entry]));
  const combined = courses.data.map((course) => ({
    course,
    summary: summaryByCourse.get(course.id),
  }));
  const plannedCourses = sortByExamDate(combined.filter((entry) => entry.summary?.has_plan));
  const primaryEntry = plannedCourses[0] ?? null;
  const secondaryEntries = combined.filter((entry) => entry.course.id !== primaryEntry?.course.id);

  const totalDueLessons = dashboard.data.filter((entry) => Boolean(entry.today_lesson)).length;
  const totalDueReviews = dashboard.data.reduce((sum, entry) => sum + entry.due_review_count, 0);

  const summaryLine = !primaryEntry
    ? copy.summarySetup
    : totalDueLessons > 0 && totalDueReviews > 0
      ? copy.summaryBoth
          .replace("{lessons}", String(totalDueLessons))
          .replace("{reviews}", String(totalDueReviews))
      : totalDueLessons > 0
        ? copy.summaryLessons.replace("{lessons}", String(totalDueLessons))
        : totalDueReviews > 0
          ? copy.summaryReviews.replace("{reviews}", String(totalDueReviews))
          : copy.summaryClear;

  const firstCourse = courses.data[0] ?? null;
  const firstSummary = firstCourse ? summaryByCourse.get(firstCourse.id) : undefined;
  const hasMaterials = Boolean(firstSummary?.journey?.has_materials);
  const interviewDone = firstSummary?.journey?.steps.interview === "done";
  const hasAnyPlan = plannedCourses.length > 0;

  const checklist = [
    {
      id: "tutor",
      label: copy.checkTutor,
      done: Boolean(settings.data.default_character_id),
      to: "/tutors",
      action: undefined as (() => void) | undefined,
    },
    {
      id: "ai",
      label: copy.checkAi,
      done: readiness.readyForLessons,
      to: undefined,
      action: () => setConnectOpen(true),
    },
    {
      id: "materials",
      label: copy.checkMaterials,
      done: hasMaterials,
      to: firstCourse ? `/courses/${firstCourse.id}/setup` : "/courses?new=1",
      action: undefined,
    },
    {
      id: "interview",
      label: copy.checkInterview,
      done: interviewDone,
      to: firstCourse ? `/courses/${firstCourse.id}/setup?step=interview` : "/courses?new=1",
      action: undefined,
    },
    {
      id: "lesson",
      label: copy.checkFirstLesson,
      done: hasAnyPlan,
      to: firstCourse ? `/courses/${firstCourse.id}/setup` : "/courses?new=1",
      action: undefined,
    },
  ];
  const currentChecklistIndex = checklist.findIndex((item) => !item.done);

  const primaryAction = primaryEntry?.summary ? resolveCoursePrimaryAction(primaryEntry.summary) : null;
  const primarySummary = primaryEntry?.summary;
  const primaryWhy = primarySummary?.today_lesson_why?.[0];
  const primaryJourney = primarySummary?.journey;

  const teacherQuote = tutorGreeting(teacher) || tutorLine(teacher, timePeriodKey(), "");
  const doneChecklistCount = checklist.filter((item) => item.done).length;
  const weekMinutes = weekSummary.data?.total_minutes ?? 0;
  const streakDays = weekSummary.data?.streak_days ?? 0;
  const maxDayMinutes = Math.max(
    30,
    ...(weekSummary.data?.days.map((d) => d.minutes) ?? [30]),
  );

  return (
    <div className="grid min-w-0 gap-6 py-6 sm:py-8" data-testid="today-page">
      {/* Companion Studio Hero Stage */}
      <section className="cs-hero-stage cs-enter-1 rounded-xl p-5 sm:p-7">
        {/* Decorative orbital rings & coordinate stars (independent atmospheric layer) */}
        <svg
          aria-hidden="true"
          viewBox="0 0 420 260"
          fill="none"
          className="pointer-events-none absolute -top-6 -right-8 hidden h-[280px] w-[440px] opacity-50 md:block"
        >
          <circle cx="310" cy="130" r="118" stroke="var(--accent)" strokeOpacity="0.16" strokeDasharray="4 6" />
          <circle cx="310" cy="130" r="78" stroke="var(--accent)" strokeOpacity="0.22" />
          <circle cx="310" cy="130" r="40" stroke="var(--border-default)" strokeOpacity="0.45" strokeDasharray="2 5" />
          <path d="M168 190 C230 142 276 168 352 72" stroke="var(--accent)" strokeOpacity="0.22" strokeDasharray="3 5" />
          <circle cx="232" cy="86" r="3" fill="var(--accent)" fillOpacity="0.45" />
          <circle cx="352" cy="72" r="4" fill="var(--accent)" fillOpacity="0.6" />
          <circle cx="268" cy="176" r="2.5" fill="var(--accent)" fillOpacity="0.38" />
        </svg>

        <div className="relative z-10 grid min-w-0 items-center gap-5 sm:grid-cols-[auto_1fr] lg:grid-cols-[auto_1fr_auto] sm:gap-7">
          {teacher ? (
            <div className="relative mx-auto sm:mx-0">
              <div aria-hidden="true" className="cs-stage-aura" />
              <div
                className="relative aspect-[9/16] w-[96px] sm:w-[126px] overflow-hidden rounded-xl bg-surface-sunken shadow-2 ring-4 ring-surface-card"
                data-still={resolveCharacterStill(teacher, "today_greeting").still}
              >
                <TeacherPreview
                  key={teacher.id}
                  character={teacher}
                  pose={speech.speaking ? "lecturing" : "greeting"}
                  emotion="cheerful"
                  gen={speech.speaking ? 2 : 1}
                  disableIdleScheduler
                />
              </div>
              <span className="absolute -bottom-2 left-1/2 -translate-x-1/2 inline-flex items-center gap-1 rounded-full border border-line-subtle bg-surface-card/95 px-2.5 py-0.5 text-[11px] font-semibold whitespace-nowrap text-fg-primary shadow-1">
                <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-ok" />
                <span>{t.richUi.companionOnline}</span>
              </span>
            </div>
          ) : null}

          <div className="grid min-w-0 gap-2.5">
            <div className="flex flex-wrap items-center gap-2 text-caption">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-accent-soft/85 px-2.5 py-0.5 font-semibold text-accent-strong">
                <Sparkles size={12} aria-hidden="true" />
                <span>{t.richUi.todayStudioKicker}</span>
              </span>
              <span className="inline-flex items-center gap-1 rounded-full border border-line-subtle bg-surface-card/75 px-2.5 py-0.5 text-fg-secondary">
                <Calendar size={12} aria-hidden="true" />
                <span>{todayDateFmt.format(new Date())}</span>
              </span>
              {streakDays > 0 ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-warn-soft px-2.5 py-0.5 font-semibold text-warn-text">
                  <Flame size={12} aria-hidden="true" />
                  <span>{t.loopViz.todayWeekStreak.replace("{days}", String(streakDays))}</span>
                </span>
              ) : null}
            </div>

            <h1 className="text-headline sm:text-display font-semibold tracking-tight text-fg-primary">
              {greetingHeading}
            </h1>
            <p className="text-body text-fg-secondary">{summaryLine}</p>

            {teacher && teacherQuote ? (
              <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2.5">
                <div className="inline-flex max-w-full flex-wrap items-center gap-2.5 rounded-tl-sm rounded-tr-xl rounded-br-xl rounded-bl-xl border border-line-subtle/90 bg-surface-card/92 px-4 py-2.5 text-ui text-fg-secondary shadow-1 backdrop-blur-sm">
                  <span className="inline-flex items-center gap-1.5 rounded-sm bg-accent-soft px-2 py-0.5 text-caption font-semibold text-accent-strong">
                    {teacher.name}
                  </span>
                  <span className="min-w-0 break-words text-fg-primary">{teacherQuote}</span>
                  {speech.speaking ? (
                    <span className="inline-flex h-3.5 items-end gap-0.5 px-1" aria-hidden="true">
                      <span className="cs-eq-bar h-2 w-0.5 rounded-full bg-accent" />
                      <span className="cs-eq-bar h-3.5 w-0.5 rounded-full bg-accent" />
                      <span className="cs-eq-bar h-2.5 w-0.5 rounded-full bg-accent" />
                    </span>
                  ) : null}
                  <button
                    type="button"
                    aria-label={t.speech.replay}
                    onClick={() => void speech.speak({ characterId: teacher.id, text: teacherQuote })}
                    className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent-soft/75 text-accent-strong transition-transform duration-fast hover:scale-105 hover:bg-accent-soft active:scale-95"
                  >
                    <Volume2 size={15} aria-hidden="true" />
                  </button>
                </div>
                {speech.unavailable ? (
                  <span role="status" className="text-caption text-fg-tertiary">
                    {t.speech.unavailable}
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>

          {/* Right-side Telemetry Cluster (Talvex-inspired balanced stat blocks) */}
          <div className="grid grid-cols-3 gap-2.5 sm:col-span-2 lg:col-span-1 lg:w-[306px]">
            <div className="grid gap-1.5 rounded-lg border border-line-subtle/85 bg-surface-card/88 p-3 shadow-1 backdrop-blur-sm">
              <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-accent-soft text-accent-strong">
                <BookOpen size={14} aria-hidden="true" />
              </span>
              <div className="flex items-baseline gap-1">
                <strong className="text-title font-semibold tabular-nums text-fg-primary">
                  {totalDueLessons}
                </strong>
                <span className="text-caption text-fg-tertiary">{t.richUi.statUnitLesson}</span>
              </div>
              <span className="truncate text-caption text-fg-secondary">{t.richUi.statDueLessons}</span>
            </div>

            <div className="grid gap-1.5 rounded-lg border border-line-subtle/85 bg-surface-card/88 p-3 shadow-1 backdrop-blur-sm">
              <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-info-soft text-info">
                <Layers size={14} aria-hidden="true" />
              </span>
              <div className="flex items-baseline gap-1">
                <strong className="text-title font-semibold tabular-nums text-fg-primary">
                  {totalDueReviews}
                </strong>
                <span className="text-caption text-fg-tertiary">{t.richUi.statUnitCard}</span>
              </div>
              <span className="truncate text-caption text-fg-secondary">{t.richUi.statDueReviews}</span>
            </div>

            <div className="grid gap-1.5 rounded-lg border border-line-subtle/85 bg-surface-card/88 p-3 shadow-1 backdrop-blur-sm">
              <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-ok-soft text-ok">
                <Clock size={14} aria-hidden="true" />
              </span>
              <div className="flex items-baseline gap-1">
                <strong className="text-title font-semibold tabular-nums text-fg-primary">
                  {weekMinutes}
                </strong>
                <span className="text-caption text-fg-tertiary">{t.richUi.statUnitMin}</span>
              </div>
              <span className="truncate text-caption text-fg-secondary">{t.richUi.statWeekFocus}</span>
            </div>
          </div>
        </div>
      </section>

      {/* First-use Checklist Mode when no course has a plan yet */}
      {!primaryEntry ? (
        <Card padding="lg" className="cs-featured-card cs-enter-2 grid gap-5" data-testid="today-checklist">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="grid gap-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="accent">
                  {t.richUi.checklistProgress
                    .replace("{done}", String(doneChecklistCount))
                    .replace("{total}", String(checklist.length))}
                </Badge>
              </div>
              <h2 className="text-title font-semibold text-fg-primary">{copy.checklistTitle}</h2>
              <p className="text-ui text-fg-secondary">{copy.checklistHint}</p>
            </div>
            {sample.data ? (
              <Link className="button quiet" to="/sample-lesson">
                <Play size={15} aria-hidden="true" />
                <span>{copy.trySample}</span>
              </Link>
            ) : null}
          </div>

          <div
            aria-hidden="true"
            className="h-2 w-full overflow-hidden rounded-full bg-surface-sunken"
          >
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-base ease-out"
              style={{ width: `${Math.round((doneChecklistCount / checklist.length) * 100)}%` }}
            />
          </div>

          <ol className="grid gap-2.5">
            {checklist.map((item, idx) => {
              const isCurrent = idx === currentChecklistIndex;
              return (
                <li
                  key={item.id}
                  data-done={item.done}
                  className={clsx(
                    "flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3.5 transition-colors duration-fast",
                    isCurrent
                      ? "border-accent/45 bg-surface-card shadow-1"
                      : "border-line-subtle bg-surface-card/75",
                  )}
                >
                  <span className="inline-flex items-center gap-3 text-ui">
                    {item.done ? (
                      <CheckCircle2 size={18} className="text-ok shrink-0" aria-hidden="true" />
                    ) : (
                      <span
                        className={clsx(
                          "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-caption font-semibold tabular-nums",
                          isCurrent
                            ? "border-accent bg-accent text-on-accent"
                            : "border-line-control text-fg-secondary",
                        )}
                      >
                        {idx + 1}
                      </span>
                    )}
                    <span className={item.done ? "text-fg-secondary line-through" : "font-medium text-fg-primary"}>
                      {item.label}
                    </span>
                  </span>
                  {item.done ? (
                    <Badge tone="ok">{copy.stepDone}</Badge>
                  ) : isCurrent ? (
                    item.action ? (
                      <Button variant="primary" size="sm" onClick={item.action}>
                        {copy.stepContinue}
                      </Button>
                    ) : (
                      <Link className="button primary" to={item.to ?? "/courses"}>
                        {copy.stepContinue}
                      </Link>
                    )
                  ) : null}
                </li>
              );
            })}
          </ol>
        </Card>
      ) : null}

      {/* Active Learning Mode */}
      {primaryEntry && primarySummary && primaryAction ? (
        <>
          <Card
            padding="lg"
            data-testid="today-primary-card"
            data-stage={primaryAction.stage}
            className="cs-featured-card cs-enter-2 grid gap-5"
          >
            {primaryAction.stage === "learning" && primarySummary.today_lesson ? (
              <>
                <div className="grid min-w-0 items-center gap-4 sm:grid-cols-[1fr_auto] sm:gap-8">
                  <div className="grid min-w-0 gap-2">
                    <div className="flex min-w-0 flex-wrap items-center gap-2 text-caption font-medium text-fg-secondary">
                      <span className="inline-flex items-center gap-1.5 rounded-sm bg-accent-soft px-2 py-0.5 font-semibold text-accent-strong">
                        <GraduationCap size={13} aria-hidden="true" />
                        <span>{copy.todayLesson}</span>
                      </span>
                      <Badge tone="neutral">{primaryEntry.course.name}</Badge>
                    </div>
                    <h2 className="break-words text-title sm:text-headline font-semibold text-fg-primary">
                      {primarySummary.today_lesson.title}
                    </h2>
                    <div className="flex flex-wrap items-center gap-3 text-ui text-fg-secondary">
                      <span className="inline-flex items-center gap-1.5 tabular-nums">
                        <Clock size={14} className="text-fg-tertiary" aria-hidden="true" />
                        <span>
                          {copy.estMinutes.replace("{min}", String(primarySummary.today_lesson.est_minutes))}
                        </span>
                      </span>
                      {primarySummary.lesson_index && primarySummary.lesson_total ? (
                        <span className="inline-flex items-center gap-2 tabular-nums">
                          <span aria-hidden="true" className="text-line-default">·</span>
                          <span>
                            {copy.lessonOrder
                              .replace("{index}", String(primarySummary.lesson_index))
                              .replace("{total}", String(primarySummary.lesson_total))}
                          </span>
                          <span aria-hidden="true" className="hidden sm:inline-flex items-center gap-1">
                            {Array.from(
                              { length: Math.min(8, primarySummary.lesson_total) },
                              (_, stepIdx) => (
                                <span
                                  key={stepIdx}
                                  className={clsx(
                                    "h-1.5 rounded-full",
                                    stepIdx + 1 < (primarySummary.lesson_index ?? 1)
                                      ? "w-3 bg-accent/65"
                                      : stepIdx + 1 === primarySummary.lesson_index
                                        ? "w-5 bg-accent"
                                        : "w-2 bg-line-default",
                                  )}
                                />
                              ),
                            )}
                          </span>
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {!readiness.readyForLessons ? (
                      <Button variant="primary" size="lg" onClick={() => setConnectOpen(true)}>
                        {copy.connectFirst}
                      </Button>
                    ) : (
                      <Link className="button primary min-h-12 px-6 text-body shadow-1" to={primaryAction.to}>
                        <Play size={16} aria-hidden="true" />
                        <span>{primaryAction.ctaLabel}</span>
                      </Link>
                    )}
                  </div>
                </div>
                {primaryWhy ? <WhyBarsRow entry={primaryWhy} /> : null}
              </>
            ) : primaryAction.stage === "learning" && primarySummary.today_practice ? (
              <div className="grid items-center gap-4 sm:grid-cols-[1fr_auto] sm:gap-8">
                <div className="grid gap-2">
                  <div className="flex flex-wrap items-center gap-2 text-caption font-medium text-fg-tertiary">
                    <span className="inline-flex items-center gap-1.5 rounded-sm bg-accent-soft px-2 py-0.5 font-semibold text-accent-strong">
                      <Target size={13} aria-hidden="true" />
                      <span>{copy.todayPractice}</span>
                    </span>
                    <Badge tone="neutral">{primaryEntry.course.name}</Badge>
                  </div>
                  <h2 className="text-title font-semibold text-fg-primary">
                    {primaryAction.statusText}
                  </h2>
                  <p className="text-ui text-fg-secondary">
                    {copy.estMinutes.replace("{min}", String(primarySummary.today_practice.est_minutes))}
                  </p>
                </div>
                <Link className="button primary" to={primaryAction.to}>
                  <Play size={16} aria-hidden="true" />
                  <span>{primaryAction.ctaLabel}</span>
                </Link>
              </div>
            ) : primaryAction.stage === "all_done" || primaryAction.stage === "exam_passed" ? (
              <div className="grid gap-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="ok">{primaryEntry.course.name}</Badge>
                  <Badge tone="neutral">
                    {primaryAction.stage === "exam_passed" ? copy.examPassed : t.courseHub.stageLabels.all_done}
                  </Badge>
                </div>
                <h2 className="text-title font-semibold text-fg-primary">
                  {primaryAction.stage === "exam_passed"
                    ? t.courseHub.examPassedTitle
                    : t.courseHub.allDoneTitle}
                </h2>
                <p className="text-ui text-fg-secondary">
                  {primarySummary.secured_score !== null
                    ? t.courseHub.finishSummaryScore
                        .replace("{lessons}", String(primaryJourney?.lessons_completed ?? 0))
                        .replace("{mastered}", String(primaryJourney?.kps_mastered ?? 0))
                        .replace("{total}", String(primaryJourney?.kps_total ?? 0))
                        .replace("{score}", String(primarySummary.secured_score))
                    : t.courseHub.finishSummary
                        .replace("{lessons}", String(primaryJourney?.lessons_completed ?? 0))
                        .replace("{mastered}", String(primaryJourney?.kps_mastered ?? 0))
                        .replace("{total}", String(primaryJourney?.kps_total ?? 0))}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Link className="button quiet" to={`/courses/${primaryEntry.course.id}/review`}>
                    {t.courseHub.continueDueReviews}
                  </Link>
                  <Link className="button quiet" to={`/courses/${primaryEntry.course.id}?settings=1`}>
                    {t.courseHub.setNewExamDate}
                  </Link>
                </div>
              </div>
            ) : (
              <div className="grid gap-4">
                <div className="flex items-center gap-2">
                  <Badge tone="ok">{primaryEntry.course.name}</Badge>
                </div>
                <h2 className="text-title font-semibold text-fg-primary">{t.courseHub.todayDoneTitle}</h2>
                <p className="text-ui text-fg-secondary">{t.courseHub.todayDoneHint}</p>
                <div className="flex flex-wrap gap-2">
                  <Link className="button quiet" to={`/courses/${primaryEntry.course.id}/plan`}>
                    {t.courseHub.learnNextEarly}
                  </Link>
                  <Link className="button quiet" to={`/courses/${primaryEntry.course.id}/review`}>
                    {t.courseHub.goReview}
                  </Link>
                  <Link className="button quiet" to={`/courses/${primaryEntry.course.id}/progress`}>
                    {t.courseHub.viewProgress}
                  </Link>
                </div>
              </div>
            )}
          </Card>

          {/* Secondary Bento Row: Due Reviews + Exam Countdown / Mastery */}
          <section className="cs-enter-3 grid min-w-0 gap-5 md:grid-cols-[1fr_1.45fr]">
            <Card padding="lg" className="cs-bento-card grid content-between gap-4">
              <div className="flex items-start justify-between gap-3">
                <div className="grid gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-info-soft text-info">
                      <RotateCcw size={16} aria-hidden="true" />
                    </span>
                    <span className="text-caption font-semibold text-fg-secondary">{copy.dueReviews}</span>
                    <Badge tone="info">{t.richUi.reviewMemoryTag}</Badge>
                  </div>
                  {primarySummary.due_review_count > 0 ? (
                    <h3 className="text-headline font-semibold tabular-nums text-fg-primary">
                      {copy.cardsCount.replace("{count}", String(primarySummary.due_review_count))}{" "}
                      <span className="text-ui font-normal text-fg-secondary">
                        · {copy.estMinutes.replace("{min}", String(Math.max(1, Math.ceil(primarySummary.due_review_count * 0.8))))}
                      </span>
                    </h3>
                  ) : (
                    <p className="text-ui text-fg-secondary">{copy.reviewEmpty}</p>
                  )}
                </div>

                {/* Decorative stacked flashcard deck visual */}
                <div aria-hidden="true" className="relative hidden sm:block h-14 w-12 shrink-0">
                  <span className="absolute top-1 left-2 h-11 w-9 rotate-6 rounded-sm border border-line-default bg-surface-sunken" />
                  <span className="absolute top-0.5 left-1 h-11 w-9 -rotate-3 rounded-sm border border-accent/30 bg-accent-soft/60" />
                  <span className="absolute top-2 left-0 grid h-11 w-9 place-items-center rounded-sm border border-line-default bg-surface-card shadow-1 text-accent-strong">
                    <Sparkles size={13} />
                  </span>
                </div>
              </div>
              <div>
                <Link className="button quiet" to={`/courses/${primaryEntry.course.id}/review`}>
                  <Play size={14} aria-hidden="true" />
                  <span>{copy.startReview}</span>
                </Link>
              </div>
            </Card>

            <Card padding="lg" className="cs-bento-card grid content-between gap-4">
              {primarySummary.exam_date && !primaryJourney?.exam_passed ? (
                <>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="grid gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-accent-soft text-accent-strong">
                          <Target size={16} aria-hidden="true" />
                        </span>
                        <span className="text-caption font-semibold text-fg-secondary">
                          {primarySummary.remaining_days === 0
                            ? copy.examToday
                            : primarySummary.exam_name
                              ? copy.daysLeft
                                  .replace("{exam}", primarySummary.exam_name)
                                  .replace("{days}", String(primarySummary.remaining_days ?? 0))
                              : copy.daysLeftPlain.replace("{days}", String(primarySummary.remaining_days ?? 0))}
                        </span>
                      </div>
                      {primarySummary.secured_score !== null && primarySummary.score_scale !== null ? (
                        <h3 className="text-headline font-semibold tabular-nums text-fg-primary">
                          {copy.securedLabel
                            .replace("{score}", String(primarySummary.secured_score))
                            .replace("{scale}", String(primarySummary.score_scale))}
                        </h3>
                      ) : (
                        <h3 className="text-title font-semibold text-fg-primary">
                          {copy.learnedKps
                            .replace("{learned}", String(primaryJourney?.kps_learned ?? 0))
                            .replace("{total}", String(primaryJourney?.kps_total ?? 0))}
                        </h3>
                      )}
                    </div>
                    <Badge tone="accent">{t.richUi.examTargetTag}</Badge>
                  </div>
                  {primarySummary.secured_score !== null && primarySummary.score_scale ? (
                    <div className="grid gap-2 rounded-md border border-line-subtle/80 bg-surface-sunken/45 p-3">
                      <div
                        role="img"
                        aria-label={copy.securedLabel
                          .replace("{score}", String(primarySummary.secured_score))
                          .replace("{scale}", String(primarySummary.score_scale))}
                        className="relative h-3 rounded-full bg-surface-sunken"
                      >
                        <span
                          className="absolute inset-y-0 left-0 rounded-full bg-accent transition-[width] duration-base ease-out"
                          style={{
                            width: `${Math.min(100, Math.round((primarySummary.secured_score / primarySummary.score_scale) * 100))}%`,
                          }}
                        />
                        {primarySummary.target_score ? (
                          <span
                            aria-hidden="true"
                            className="absolute -top-1.5 -bottom-1.5 w-0.5 rounded-full bg-fg-primary"
                            style={{
                              left: `${Math.min(100, Math.round((primarySummary.target_score / primarySummary.score_scale) * 100))}%`,
                            }}
                          />
                        ) : null}
                      </div>
                      <div className="flex justify-between text-caption font-medium tabular-nums text-fg-secondary">
                        <span>{copy.nowScore.replace("{score}", String(primarySummary.secured_score))}</span>
                        {primarySummary.target_score ? (
                          <span className="text-accent-strong">
                            {copy.targetScore.replace("{score}", String(primarySummary.target_score))}
                          </span>
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                </>
              ) : (
                <>
                  <div className="grid gap-2">
                    <div className="flex items-center gap-2">
                      <span className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-ok-soft text-ok">
                        <Award size={16} aria-hidden="true" />
                      </span>
                      <span className="text-caption font-semibold text-fg-secondary">{primaryEntry.course.name}</span>
                    </div>
                    <h3 className="text-title font-semibold text-fg-primary">
                      {copy.learnedKps
                        .replace("{learned}", String(primaryJourney?.kps_learned ?? 0))
                        .replace("{total}", String(primaryJourney?.kps_total ?? 0))}
                    </h3>
                  </div>
                  <div>
                    <Link className="button quiet" to={`/courses/${primaryEntry.course.id}?settings=1`}>
                      {copy.addExamDate}
                    </Link>
                  </div>
                </>
              )}
            </Card>
          </section>

          {/* This week rhythm strip (U5 + Vitalis bar rhythm) */}
          {weekSummary.data ? (
            <Card
              padding="md"
              data-testid="today-week-row"
              className="cs-bento-card flex flex-wrap items-center justify-between gap-5"
            >
              <div className="flex flex-wrap items-center gap-4">
                <div className="inline-flex items-center gap-2">
                  <span className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-accent-soft text-accent-strong">
                    <Calendar size={15} aria-hidden="true" />
                  </span>
                  <span className="text-ui font-semibold text-fg-primary">
                    {t.loopViz.todayWeekTitle}
                  </span>
                </div>
                <div className="flex items-end gap-2" aria-label={t.loopViz.todayWeekTitle}>
                  {weekSummary.data.days.map((entry) => {
                    const barHeight = entry.active
                      ? Math.max(10, Math.round((entry.minutes / maxDayMinutes) * 24))
                      : 6;
                    return (
                      <div
                        key={entry.day}
                        title={`${entry.day}: ${entry.minutes} ${t.learner.minutes}`}
                        className="grid justify-items-center gap-1"
                      >
                        <span className="flex h-6 w-5 items-end justify-center rounded-sm bg-surface-sunken/80 p-0.5">
                          <span
                            className={clsx(
                              "w-full rounded-[3px] transition-colors",
                              entry.active ? "bg-accent" : "bg-line-default/60",
                            )}
                            style={{ height: `${barHeight}px` }}
                          />
                        </span>
                        <span
                          className={clsx(
                            "text-[11px] leading-none font-medium",
                            entry.active ? "text-accent-strong font-semibold" : "text-fg-tertiary",
                          )}
                        >
                          {weekdayShortLabel(entry.day)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-caption text-fg-secondary">
                {weekSummary.data.total_minutes > 0 || weekSummary.data.lessons_completed > 0 || weekSummary.data.streak_days > 0 ? (
                  <>
                    <span className="inline-flex items-center rounded-full border border-line-subtle bg-surface-page px-3 py-1 tabular-nums font-medium text-fg-primary">
                      {t.loopViz.todayWeekMinutes.replace("{min}", String(weekSummary.data.total_minutes))}
                    </span>
                    <span className="inline-flex items-center rounded-full border border-line-subtle bg-surface-page px-3 py-1 tabular-nums">
                      {t.loopViz.todayWeekLessons.replace("{count}", String(weekSummary.data.lessons_completed))}
                    </span>
                    {weekSummary.data.streak_days > 0 ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-accent-soft px-3 py-1 font-semibold text-accent-strong">
                        <Flame size={13} aria-hidden="true" />
                        <span>{t.loopViz.todayWeekStreak.replace("{days}", String(weekSummary.data.streak_days))}</span>
                      </span>
                    ) : null}
                  </>
                ) : (
                  <span>{t.loopViz.todayWeekEmpty}</span>
                )}
              </div>
            </Card>
          ) : null}
        </>
      ) : null}

      {/* Other courses */}
      {secondaryEntries.length > 0 ? (
        <section className="grid min-w-0 gap-3">
          <div className="flex items-center gap-2">
            <BookOpen size={15} className="text-fg-tertiary" aria-hidden="true" />
            <h2 className="text-ui font-semibold text-fg-secondary">{copy.moreCourses}</h2>
          </div>
          <div className="grid min-w-0 gap-3.5 md:grid-cols-2">
            {secondaryEntries.map(({ course, summary }) => {
              const action = resolveCoursePrimaryAction(
                summary ?? { course_id: course.id, has_plan: false },
              );
              const kpTotal = summary?.journey?.kps_total ?? 0;
              const kpLearned = summary?.journey?.kps_learned ?? 0;
              return (
                <Card
                  key={course.id}
                  padding="md"
                  data-testid="today-course-row"
                  data-stage={action.stage}
                  className="cs-bento-card grid min-w-0 gap-3"
                >
                  <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
                    <div className="flex min-w-0 flex-1 items-center gap-3">
                      <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-accent-soft/80 text-accent-strong">
                        <BookOpen size={18} aria-hidden="true" />
                      </span>
                      <div className="grid min-w-0 flex-1 gap-0.5">
                        <Link
                          to={`/courses/${course.id}`}
                          className="truncate text-body font-semibold text-fg-primary hover:text-accent-strong"
                        >
                          {course.name}
                        </Link>
                        <span className="truncate text-ui text-fg-secondary">{action.statusText}</span>
                      </div>
                    </div>
                    <Link className="button quiet shrink-0" to={action.to}>
                      <span>{action.ctaLabel}</span>
                      <ArrowRight size={15} aria-hidden="true" />
                    </Link>
                  </div>
                  {kpTotal > 0 ? (
                    <div className="grid gap-1 border-t border-line-subtle/80 pt-2.5">
                      <div className="flex justify-between text-caption text-fg-tertiary tabular-nums">
                        <span>{t.richUi.courseProgressLabel}</span>
                        <span>
                          {kpLearned} / {kpTotal}
                        </span>
                      </div>
                      <div className="h-1.5 overflow-hidden rounded-full bg-surface-sunken">
                        <div
                          className="h-full rounded-full bg-accent"
                          style={{ width: `${Math.min(100, Math.round((kpLearned / kpTotal) * 100))}%` }}
                        />
                      </div>
                    </div>
                  ) : null}
                </Card>
              );
            })}
          </div>
        </section>
      ) : null}

      <ConnectWizardDialog open={connectOpen} onOpenChange={setConnectOpen} />
    </div>
  );
}
