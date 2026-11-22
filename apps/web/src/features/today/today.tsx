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
  Badge,
  Button,
  Card,
  CheckCircle2,
  Flame,
  MasteryBar,
  Play,
  Volume2,
  WeightBar,
} from "../../ui";
import t from "../../locales/zh-CN.json";
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

function WhyBarsRow({ entry }: { entry: NonNullable<CourseDashboard["today_lesson_why"]>[number] }) {
  return (
    <div className="grid gap-2.5 border-t border-line-subtle pt-4 text-ui text-fg-secondary sm:grid-cols-[auto_auto_1fr] sm:items-center sm:gap-x-6">
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
      <p className="text-ui text-fg-secondary">{buildPlanWhySentence(entry)}</p>
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

  return (
    <div className="grid min-w-0 gap-5 py-6 sm:py-8" data-testid="today-page">
      {/* Hero Greeting */}
      <section className="grid min-w-0 items-center gap-5 sm:grid-cols-[auto_1fr] sm:gap-7">
        {teacher ? (
          <div className="h-36 w-[81px] sm:h-[210px] sm:w-[118px] overflow-hidden rounded-xl bg-surface-sunken shadow-2 ring-4 ring-surface-card">
            <img
              src={teacher.appearance.src}
              alt={teacher.name}
              className="h-full w-full object-cover object-[center_20%]"
            />
          </div>
        ) : null}
        <div className="grid min-w-0 gap-2">
          <h1 className="text-headline font-semibold text-fg-primary">{greetingHeading}</h1>
          <p className="text-body text-fg-secondary">{summaryLine}</p>
          {teacher && teacherQuote ? (
            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2">
              <div className="inline-flex max-w-full flex-wrap items-center gap-2.5 rounded-tl-sm rounded-tr-lg rounded-br-lg rounded-bl-lg bg-surface-card px-4 py-2.5 text-ui text-fg-secondary shadow-1">
                <strong className="font-medium text-fg-primary">{teacher.name}</strong>
                <span className="min-w-0 break-words">{teacherQuote}</span>
                <button
                  type="button"
                  aria-label={t.speech.replay}
                  onClick={() => void speech.speak({ characterId: teacher.id, text: teacherQuote })}
                  className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-fg-secondary hover:bg-surface-sunken hover:text-fg-primary"
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
      </section>

      {/* First-use Checklist Mode when no course has a plan yet */}
      {!primaryEntry ? (
        <Card padding="lg" className="grid gap-5 shadow-2" data-testid="today-checklist">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="grid gap-1">
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

          <ol className="grid gap-2.5">
            {checklist.map((item, idx) => {
              const isCurrent = idx === currentChecklistIndex;
              return (
                <li
                  key={item.id}
                  data-done={item.done}
                  className={clsx(
                    "flex flex-wrap items-center justify-between gap-3 rounded-md border px-4 py-3",
                    isCurrent
                      ? "border-accent/40 bg-accent-soft/40"
                      : "border-line-subtle bg-surface-page/70",
                  )}
                >
                  <span className="inline-flex items-center gap-3 text-ui">
                    {item.done ? (
                      <CheckCircle2 size={18} className="text-ok shrink-0" aria-hidden="true" />
                    ) : (
                      <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-line-control text-caption font-semibold text-fg-secondary">
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
            className="grid gap-5 shadow-2"
          >
            {primaryAction.stage === "learning" && primarySummary.today_lesson ? (
              <>
                <div className="grid min-w-0 items-center gap-4 sm:grid-cols-[1fr_auto] sm:gap-8">
                  <div className="grid min-w-0 gap-1.5">
                    <div className="flex min-w-0 flex-wrap items-center gap-2 text-caption font-medium text-fg-tertiary">
                      <span className="shrink-0">{copy.todayLesson}</span>
                      <Badge tone="neutral">{primaryEntry.course.name}</Badge>
                    </div>
                    <h2 className="break-words text-title font-semibold text-fg-primary">
                      {primarySummary.today_lesson.title}
                    </h2>
                    <p className="text-ui text-fg-secondary">
                      {copy.estMinutes.replace("{min}", String(primarySummary.today_lesson.est_minutes))}
                      {primarySummary.lesson_index && primarySummary.lesson_total
                        ? ` · ${copy.lessonOrder
                            .replace("{index}", String(primarySummary.lesson_index))
                            .replace("{total}", String(primarySummary.lesson_total))}`
                        : ""}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {!readiness.readyForLessons ? (
                      <Button variant="primary" size="lg" onClick={() => setConnectOpen(true)}>
                        {copy.connectFirst}
                      </Button>
                    ) : (
                      <Link className="button primary" to={primaryAction.to}>
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
                <div className="grid gap-1.5">
                  <div className="flex flex-wrap items-center gap-2 text-caption font-medium text-fg-tertiary">
                    <span>{copy.todayPractice}</span>
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

          {/* Secondary Row: Due Reviews + Exam Countdown / Mastery */}
          <section className="grid min-w-0 gap-5 md:grid-cols-[1fr_1.4fr]">
            <Card padding="lg" className="grid content-between gap-4">
              <div className="grid gap-1.5">
                <span className="text-caption font-medium text-fg-tertiary">{copy.dueReviews}</span>
                {primarySummary.due_review_count > 0 ? (
                  <h3 className="text-title font-semibold text-fg-primary">
                    {copy.cardsCount.replace("{count}", String(primarySummary.due_review_count))}{" "}
                    <span className="text-ui font-normal text-fg-secondary">
                      · {copy.estMinutes.replace("{min}", String(Math.max(1, Math.ceil(primarySummary.due_review_count * 0.8))))}
                    </span>
                  </h3>
                ) : (
                  <p className="text-ui text-fg-secondary">{copy.reviewEmpty}</p>
                )}
              </div>
              <div>
                <Link className="button quiet" to={`/courses/${primaryEntry.course.id}/review`}>
                  {copy.startReview}
                </Link>
              </div>
            </Card>

            <Card padding="lg" className="grid content-between gap-4">
              {primarySummary.exam_date && !primaryJourney?.exam_passed ? (
                <>
                  <div className="grid gap-1.5">
                    <span className="text-caption font-medium text-fg-tertiary">
                      {primarySummary.remaining_days === 0
                        ? copy.examToday
                        : primarySummary.exam_name
                          ? copy.daysLeft
                              .replace("{exam}", primarySummary.exam_name)
                              .replace("{days}", String(primarySummary.remaining_days ?? 0))
                          : copy.daysLeftPlain.replace("{days}", String(primarySummary.remaining_days ?? 0))}
                    </span>
                    {primarySummary.secured_score !== null && primarySummary.score_scale !== null ? (
                      <h3 className="text-title font-semibold text-fg-primary">
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
                  {primarySummary.secured_score !== null && primarySummary.score_scale ? (
                    <div className="grid gap-2">
                      <div
                        role="img"
                        aria-label={copy.securedLabel
                          .replace("{score}", String(primarySummary.secured_score))
                          .replace("{scale}", String(primarySummary.score_scale))}
                        className="relative h-2.5 rounded-full bg-surface-sunken"
                      >
                        <span
                          className="absolute inset-y-0 left-0 rounded-full bg-accent"
                          style={{
                            width: `${Math.min(100, Math.round((primarySummary.secured_score / primarySummary.score_scale) * 100))}%`,
                          }}
                        />
                        {primarySummary.target_score ? (
                          <span
                            aria-hidden="true"
                            className="absolute -top-1 -bottom-1 w-0.5 rounded-full bg-fg-primary"
                            style={{
                              left: `${Math.min(100, Math.round((primarySummary.target_score / primarySummary.score_scale) * 100))}%`,
                            }}
                          />
                        ) : null}
                      </div>
                      <div className="flex justify-between text-caption text-fg-tertiary">
                        <span>{copy.nowScore.replace("{score}", String(primarySummary.secured_score))}</span>
                        {primarySummary.target_score ? (
                          <span>{copy.targetScore.replace("{score}", String(primarySummary.target_score))}</span>
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                </>
              ) : (
                <>
                  <div className="grid gap-1.5">
                    <span className="text-caption font-medium text-fg-tertiary">{primaryEntry.course.name}</span>
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

          {/* This week strip (U5) */}
          {weekSummary.data ? (
            <Card
              padding="md"
              data-testid="today-week-row"
              className="flex flex-wrap items-center justify-between gap-4"
            >
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-caption font-semibold text-fg-secondary">
                  {t.loopViz.todayWeekTitle}
                </span>
                <div className="flex items-center gap-1.5" aria-label={t.loopViz.todayWeekTitle}>
                  {weekSummary.data.days.map((entry) => (
                    <span
                      key={entry.day}
                      title={`${entry.day}: ${entry.minutes} ${t.learner.minutes}`}
                      className={clsx(
                        "inline-block h-3.5 w-3.5 rounded-[4px] border transition-colors",
                        entry.active
                          ? "border-accent bg-accent"
                          : "border-line-subtle bg-surface-sunken",
                      )}
                    />
                  ))}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-caption text-fg-secondary">
                {weekSummary.data.total_minutes > 0 || weekSummary.data.lessons_completed > 0 || weekSummary.data.streak_days > 0 ? (
                  <>
                    <span className="tabular-nums font-medium text-fg-primary">
                      {t.loopViz.todayWeekMinutes.replace("{min}", String(weekSummary.data.total_minutes))}
                    </span>
                    <span className="tabular-nums">
                      {t.loopViz.todayWeekLessons.replace("{count}", String(weekSummary.data.lessons_completed))}
                    </span>
                    {weekSummary.data.streak_days > 0 ? (
                      <span className="inline-flex items-center gap-1 font-medium text-accent-strong">
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
          <h2 className="text-ui font-semibold text-fg-secondary">{copy.moreCourses}</h2>
          <div className="grid min-w-0 gap-3 md:grid-cols-2">
            {secondaryEntries.map(({ course, summary }) => {
              const action = resolveCoursePrimaryAction(
                summary ?? { course_id: course.id, has_plan: false },
              );
              return (
                <Card
                  key={course.id}
                  padding="md"
                  data-testid="today-course-row"
                  data-stage={action.stage}
                  className="flex min-w-0 flex-wrap items-center justify-between gap-3"
                >
                  <div className="grid min-w-0 flex-1 gap-0.5">
                    <Link
                      to={`/courses/${course.id}`}
                      className="truncate text-body font-semibold text-fg-primary hover:text-accent-strong"
                    >
                      {course.name}
                    </Link>
                    <span className="truncate text-ui text-fg-secondary">{action.statusText}</span>
                  </div>
                  <Link className="button quiet shrink-0" to={action.to}>
                    <span>{action.ctaLabel}</span>
                    <ArrowRight size={15} aria-hidden="true" />
                  </Link>
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
