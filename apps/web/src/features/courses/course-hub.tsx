import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import clsx from "clsx";
import { Loading, Problem } from "../../app/ui";
import {
  ArrowRight,
  Badge,
  Button,
  Card,
  Checkbox,
  ChevronRight,
  ConfirmDialog,
  Dialog,
  DifficultyDots,
  Field,
  FileDropzone,
  Menu,
  MoreHorizontal,
  Pencil,
  Play,
  RouteTabs,
  Select,
  Settings,
  Stepper,
  TextInput,
  Textarea,
  Trash2,
  toast,
} from "../../ui";
import t from "../../locales/zh-CN.json";
import { createPointPlanItem } from "../classroom/lesson-api";
import { getPlan, learnerKeys } from "../learner/api";
import { isLessonItem, planItemDisplayTitle, planItemKindLabel } from "../plan/item-kind";
import { buildPlanWhySentence, masteryLabel, masteryLevel, weightLabel } from "../plan/why-sentence";
import { ConnectWizardDialog } from "../settings/connect-wizard";
import { useReadiness } from "../settings/use-readiness";
import {
  courseKeys,
  deleteCourse,
  deleteMaterial,
  getAnalysis,
  getCourse,
  getCourseJourney,
  getCourseMap,
  getMaterialPage,
  listCourseDashboard,
  listExamItems,
  listMaterials,
  listUnmappedExamItems,
  materialPageImage,
  pasteMaterial,
  startAnalysis,
  updateCourse,
  updateKnowledgePoint,
  updateMaterial,
  uploadMaterials,
} from "./api";
import { formatFileSize } from "./analysis-stages";
import { CourseSettingsDialog } from "./course-settings-dialog";
import { resolveCoursePrimaryAction } from "./journey-helpers";
import { inferMaterial } from "./materials";
import type { ExamItem, KnowledgePoint, Material, MaterialRole } from "./types";

const roles = Object.keys(t.courses.roles) as MaterialRole[];
type PendingFile = { file: File; role: MaterialRole; year?: number; exam_name?: string; has_answers?: boolean };

function warningText(value: string) {
  return t.courses.warnings[value as keyof typeof t.courses.warnings] ?? value;
}

export function CourseHubLayout({ children }: { children: ReactNode }) {
  const courseId = useParams().courseId ?? "";
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const queries = useQueryClient();

  const course = useQuery({
    queryKey: courseKeys.one(courseId),
    queryFn: () => getCourse(courseId),
    enabled: Boolean(courseId),
  });
  const dashboard = useQuery({
    queryKey: courseKeys.dashboard,
    queryFn: listCourseDashboard,
  });
  const journey = useQuery({
    queryKey: courseKeys.journey(courseId),
    queryFn: () => getCourseJourney(courseId),
    enabled: Boolean(courseId),
  });

  const [settingsOpen, setSettingsOpen] = useState(searchParams.get("settings") === "1");
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameName, setRenameName] = useState("");
  const [renameGoal, setRenameGoal] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);

  const renameMutation = useMutation({
    mutationFn: () =>
      updateCourse(courseId, { name: renameName.trim(), goal: renameGoal.trim() }),
    onSuccess: (updated) => {
      queries.setQueryData(courseKeys.one(courseId), updated);
      void queries.invalidateQueries({ queryKey: courseKeys.all });
      setRenameOpen(false);
      toast.success(t.common.saved);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteCourse(courseId),
    onSuccess: () => {
      void queries.invalidateQueries({ queryKey: courseKeys.all });
      setDeleteOpen(false);
      toast.success(t.common.saved);
      navigate("/courses", { replace: true });
    },
  });

  function setSettingsDialogOpen(next: boolean) {
    setSettingsOpen(next);
    if (!next && searchParams.has("settings")) {
      const updated = new URLSearchParams(searchParams);
      updated.delete("settings");
      setSearchParams(updated, { replace: true });
    }
  }

  if (course.isPending) return <Loading />;
  if (course.isError) return <Problem error={course.error} onRetry={() => void course.refetch()} />;

  const summary = dashboard.data?.find((entry) => entry.course_id === courseId);
  const j = journey.data ?? summary?.journey;
  const base = `/courses/${courseId}`;

  const tabs = [
    { to: base, label: t.courseHub.tabs.today, active: location.pathname === base },
    { to: `${base}/plan`, label: t.courseHub.tabs.plan, active: location.pathname === `${base}/plan` },
    { to: `${base}/map`, label: t.courseHub.tabs.map, active: location.pathname === `${base}/map` },
    {
      to: `${base}/review`,
      label: t.courseHub.tabs.review,
      active: location.pathname.startsWith(`${base}/review`),
      badge: summary && summary.due_review_count > 0 ? <Badge tone="accent">{summary.due_review_count}</Badge> : undefined,
    },
    { to: `${base}/progress`, label: t.courseHub.tabs.progress, active: location.pathname === `${base}/progress` },
    { to: `${base}/history`, label: t.courseHub.tabs.history, active: location.pathname === `${base}/history` },
    { to: `${base}/materials`, label: t.courseHub.tabs.materials, active: location.pathname === `${base}/materials` },
  ];

  const headerMeta = (() => {
    if (summary?.exam_date && !j?.exam_passed) {
      const countdown =
        summary.remaining_days === 0
          ? t.today.examToday
          : summary.exam_name
            ? t.today.daysLeft.replace("{exam}", summary.exam_name).replace("{days}", String(summary.remaining_days ?? 0))
            : t.today.daysLeftPlain.replace("{days}", String(summary.remaining_days ?? 0));
      const score =
        summary.secured_score !== null && summary.score_scale !== null
          ? ` · ${t.today.securedLabel.replace("{score}", String(summary.secured_score)).replace("{scale}", String(summary.score_scale))}`
          : "";
      return `${countdown}${score}`;
    }
    if (j && j.kps_total > 0) {
      return t.today.learnedKps
        .replace("{learned}", String(j.kps_learned))
        .replace("{total}", String(j.kps_total));
    }
    return course.data.goal || t.courses.goalEmpty;
  })();

  return (
    <div className="grid min-w-0 gap-5 py-5 sm:py-7" data-testid="course-hub">
      <div className="grid min-w-0 gap-3">
        <div className="flex min-w-0 items-center gap-1.5 text-caption text-fg-secondary">
          <Link to="/courses" className="shrink-0 hover:text-fg-primary">{t.courses.heading}</Link>
          <ChevronRight size={14} className="shrink-0" aria-hidden="true" />
          <span className="truncate text-fg-primary">{course.data.name}</span>
        </div>

        <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
          <div className="grid min-w-0 flex-1 gap-1">
            <h1 className="break-words text-headline font-semibold text-fg-primary">{course.data.name}</h1>
            <p className="text-ui text-fg-secondary">{headerMeta}</p>
          </div>

          <Menu
            trigger={
              <span className="inline-flex min-h-10 items-center gap-1.5 rounded-md border border-line-control bg-surface-card px-3 text-ui font-medium text-fg-primary hover:bg-surface-sunken">
                <MoreHorizontal size={16} aria-hidden="true" />
                <span>{t.courseHub.more}</span>
              </span>
            }
            items={[
              {
                id: "settings",
                label: t.courseHub.courseSettings,
                icon: <Settings size={15} aria-hidden="true" />,
                onSelect: () => setSettingsDialogOpen(true),
              },
              {
                id: "rename",
                label: t.courseHub.rename,
                icon: <Pencil size={15} aria-hidden="true" />,
                onSelect: () => {
                  setRenameName(course.data.name);
                  setRenameGoal(course.data.goal ?? "");
                  setRenameOpen(true);
                },
              },
              {
                id: "delete",
                label: t.courseHub.deleteCourse,
                icon: <Trash2 size={15} aria-hidden="true" />,
                danger: true,
                onSelect: () => setDeleteOpen(true),
              },
            ]}
          />
        </div>

        <RouteTabs items={tabs} aria-label={course.data.name} />
      </div>

      <div className="min-w-0">{children}</div>

      <CourseSettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsDialogOpen}
        course={course.data}
      />

      <Dialog open={renameOpen} onOpenChange={setRenameOpen} title={t.courseHub.renameTitle} size="sm">
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (renameName.trim()) renameMutation.mutate();
          }}
        >
          <Field label={t.courses.name} required>
            <TextInput
              value={renameName}
              onChange={(event) => setRenameName(event.target.value)}
              maxLength={120}
              required
              autoFocus
            />
          </Field>
          <Field label={t.courses.goal}>
            <Textarea
              rows={2}
              value={renameGoal}
              onChange={(event) => setRenameGoal(event.target.value)}
              maxLength={500}
            />
          </Field>
          {renameMutation.isError ? <Problem error={renameMutation.error} /> : null}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={() => setRenameOpen(false)}>{t.common.cancel}</Button>
            <Button type="submit" variant="primary" pending={renameMutation.isPending} disabled={!renameName.trim()}>
              {t.common.save}
            </Button>
          </div>
        </form>
      </Dialog>

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={t.courseHub.deleteCourseTitle.replace("{name}", course.data.name)}
        description={t.courseHub.deleteCourseBody}
        confirmLabel={t.courses.confirmDelete}
        cancelLabel={t.common.keep}
        pending={deleteMutation.isPending}
        onConfirm={() => deleteMutation.mutate()}
      />
    </div>
  );
}

export function CourseTodayTab() {
  const courseId = useParams().courseId ?? "";
  const navigate = useNavigate();
  const readiness = useReadiness();
  const [connectOpen, setConnectOpen] = useState(false);
  const [mountNow] = useState(() => Date.now());

  const journey = useQuery({
    queryKey: courseKeys.journey(courseId),
    queryFn: () => getCourseJourney(courseId),
    enabled: Boolean(courseId),
  });
  const dashboard = useQuery({
    queryKey: courseKeys.dashboard,
    queryFn: listCourseDashboard,
  });
  const plan = useQuery({
    queryKey: learnerKeys.plan(courseId),
    queryFn: () => getPlan(courseId),
    enabled: Boolean(courseId),
  });

  if (journey.isPending || dashboard.isPending) return <Loading />;
  if (journey.isError) return <Problem error={journey.error} onRetry={() => void journey.refetch()} />;
  if (dashboard.isError) return <Problem error={dashboard.error} onRetry={() => void dashboard.refetch()} />;

  const j = journey.data;
  const summary = dashboard.data.find((entry) => entry.course_id === courseId);
  const action = resolveCoursePrimaryAction(summary ?? { course_id: courseId, has_plan: j.has_plan, journey: j });

  // Mode 1: Preparing (no plan yet)
  if (!j.has_plan) {
    const stepLabels = t.setup.steps;
    const steps = [
      { id: "materials", label: stepLabels[0], status: j.steps.materials },
      { id: "analysis", label: stepLabels[1], status: j.steps.analysis },
      { id: "interview", label: stepLabels[2], status: j.steps.interview },
      {
        id: "placement",
        label: stepLabels[3],
        status: j.steps.placement,
        hint: j.steps.placement === "waiting" ? t.learner.placementWaitMaterials : undefined,
      },
      { id: "plan", label: stepLabels[4], status: j.steps.plan },
    ];
    return (
      <Card padding="lg" className="grid gap-6 shadow-1" data-testid="course-today-preparing" data-stage={j.stage}>
        <div className="grid gap-1.5">
          <h2 className="text-title font-semibold text-fg-primary">{t.courseHub.prepareHeading}</h2>
          <p className="text-ui text-fg-secondary">{action.statusText}</p>
        </div>
        <Stepper
          steps={steps}
          currentId={j.next_step}
          onSelect={(stepId) => navigate(`/courses/${courseId}/setup?step=${stepId}`)}
        />
        <div className="flex flex-wrap items-center gap-3">
          <Link className="button primary" to={`/courses/${courseId}/setup`}>
            <span>{t.courseHub.continueSetup}</span>
            <ArrowRight size={15} aria-hidden="true" />
          </Link>
        </div>
      </Card>
    );
  }

  // Mode 4: All Done / Exam Passed
  if (j.stage === "all_done" || j.stage === "exam_passed") {
    return (
      <Card padding="lg" className="grid gap-5 shadow-1" data-testid="course-today-finished" data-stage={j.stage}>
        <div className="grid gap-1.5">
          <h2 className="text-title font-semibold text-fg-primary">
            {j.stage === "exam_passed" ? t.courseHub.examPassedTitle : t.courseHub.allDoneTitle}
          </h2>
          <p className="text-ui text-fg-secondary">
            {summary?.secured_score !== null && summary?.secured_score !== undefined
              ? t.courseHub.finishSummaryScore
                  .replace("{lessons}", String(j.lessons_completed))
                  .replace("{mastered}", String(j.kps_mastered))
                  .replace("{total}", String(j.kps_total))
                  .replace("{score}", String(summary.secured_score))
              : t.courseHub.finishSummary
                  .replace("{lessons}", String(j.lessons_completed))
                  .replace("{mastered}", String(j.kps_mastered))
                  .replace("{total}", String(j.kps_total))}
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          {j.deferred_count > 0 ? (
            <Link className="button primary" to={`/courses/${courseId}/plan`}>
              {t.courseHub.catchupDeferred.replace("{count}", String(j.deferred_count))}
            </Link>
          ) : null}
          <Link className="button quiet" to={`/courses/${courseId}/review`}>
            {t.courseHub.continueDueReviews}
          </Link>
          <Link className="button quiet" to={`/courses/${courseId}?settings=1`}>
            {t.courseHub.setNewExamDate}
          </Link>
        </div>
      </Card>
    );
  }

  const nextThree = (plan.data?.items ?? [])
    .filter((item) => item.status === "todo" || item.status === "active")
    .slice(0, 3);
  const planUpdatedRecently = Boolean(
    plan.data &&
      plan.data.version > 1 &&
      plan.data.created_at &&
      mountNow - Date.parse(plan.data.created_at) < 7 * 86_400_000,
  );
  const why = summary?.today_lesson_why?.[0];

  // Mode 3: Today Done
  if (j.stage === "today_done") {
    return (
      <div className="grid gap-5" data-testid="course-today-done" data-stage="today_done">
        <Card padding="lg" className="grid gap-4">
          <h2 className="text-title font-semibold text-fg-primary">{t.courseHub.todayDoneTitle}</h2>
          <p className="text-ui text-fg-secondary">{t.courseHub.todayDoneHint}</p>
          <div className="flex flex-wrap gap-2.5">
            {nextThree[0] && isLessonItem(nextThree[0].kind) ? (
              <Link className="button quiet" to={`/plan-items/${nextThree[0].id}/lesson`}>
                {t.courseHub.learnNextEarly}
              </Link>
            ) : (
              <Link className="button quiet" to={`/courses/${courseId}/plan`}>
                {t.courseHub.learnNextEarly}
              </Link>
            )}
            <Link className="button quiet" to={`/courses/${courseId}/review`}>
              {t.courseHub.goReview}
            </Link>
            <Link className="button quiet" to={`/courses/${courseId}/progress`}>
              {t.courseHub.viewProgress}
            </Link>
          </div>
        </Card>
      </div>
    );
  }

  // Mode 2: Learning
  return (
    <div className="grid gap-5" data-testid="course-today-learning" data-stage="learning">
      {planUpdatedRecently ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-accent/30 bg-accent-soft/50 px-4 py-2.5 text-ui text-fg-primary">
          <span>{t.courseHub.planAdjustedNotice}</span>
          <Link className="font-medium text-accent-strong hover:underline" to={`/courses/${courseId}/plan`}>
            {t.courseHub.viewFullPlan}
          </Link>
        </div>
      ) : null}

      <Card padding="lg" className="grid gap-5 shadow-2">
        <div className="grid items-center gap-4 sm:grid-cols-[1fr_auto]">
          <div className="grid gap-1.5">
            <span className="text-caption font-medium text-fg-tertiary">{t.today.todayLesson}</span>
            <h2 className="text-title font-semibold text-fg-primary">
              {summary?.today_lesson?.title ?? action.statusText}
            </h2>
            {summary?.today_lesson ? (
              <p className="text-ui text-fg-secondary">
                {t.today.estMinutes.replace("{min}", String(summary.today_lesson.est_minutes))}
                {summary.lesson_index && summary.lesson_total
                  ? ` · ${t.today.lessonOrder
                      .replace("{index}", String(summary.lesson_index))
                      .replace("{total}", String(summary.lesson_total))}`
                  : ""}
              </p>
            ) : null}
          </div>
          {!readiness.readyForLessons && action.requiresAi ? (
            <Button variant="primary" size="lg" onClick={() => setConnectOpen(true)}>
              {t.today.connectFirst}
            </Button>
          ) : (
            <Link className="button primary" to={action.to}>
              <Play size={15} aria-hidden="true" />
              <span>{action.ctaLabel}</span>
            </Link>
          )}
        </div>
        {why ? (
          <div className="grid gap-2 border-t border-line-subtle pt-4 text-caption text-fg-secondary sm:grid-cols-[auto_auto_1fr] sm:items-center sm:gap-x-6">
            <span className="inline-flex items-center gap-2">
              <span>{t.today.weightLabel}</span>
              <span className="block h-1.5 w-20 overflow-hidden rounded-full bg-surface-sunken">
                <span className="block h-full rounded-full bg-accent" style={{ width: `${Math.min(100, Math.max(8, Math.round(why.weight * 100)))}%` }} />
              </span>
              <strong className="text-fg-primary">{weightLabel(why.weight)}</strong>
            </span>
            <span className="inline-flex items-center gap-2">
              <span>{t.today.masteryLabel}</span>
              <span className="block h-1.5 w-20 overflow-hidden rounded-full bg-surface-sunken">
                <span
                  className={clsx(
                    "block h-full rounded-full",
                    masteryLevel(why.mastery) === "mastered"
                      ? "bg-mastery-mastered"
                      : masteryLevel(why.mastery) === "shaky"
                        ? "bg-mastery-fragile"
                        : "bg-mastery-learning",
                  )}
                  style={{ width: `${Math.min(100, Math.max(5, Math.round(why.mastery * 100)))}%` }}
                />
              </span>
              <strong className="text-fg-primary">{masteryLabel(why.mastery)}</strong>
            </span>
            <p className="text-ui text-fg-secondary">{buildPlanWhySentence(why)}</p>
          </div>
        ) : null}
      </Card>

      <div className="grid gap-5 md:grid-cols-2">
        <Card padding="lg" className="grid content-between gap-4">
          <div className="grid gap-1">
            <span className="text-caption font-medium text-fg-tertiary">{t.today.dueReviews}</span>
            <h3 className="text-title font-semibold text-fg-primary">
              {summary?.due_review_count
                ? t.today.cardsCount.replace("{count}", String(summary.due_review_count))
                : t.today.reviewEmpty}
            </h3>
          </div>
          <div>
            <Link className="button quiet" to={`/courses/${courseId}/review`}>
              {t.today.startReview}
            </Link>
          </div>
        </Card>

        <Card padding="lg" className="grid gap-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-ui font-semibold text-fg-primary">{t.courseHub.nextThree}</h3>
            <Link className="text-caption font-medium text-accent-strong hover:underline" to={`/courses/${courseId}/plan`}>
              {t.courseHub.viewFullPlan}
            </Link>
          </div>
          <ol className="grid gap-2">
            {nextThree.map((item) => (
              <li
                key={item.id}
                className="flex items-center justify-between gap-2 rounded-md bg-surface-page px-3 py-2 text-ui"
              >
                <span className="truncate font-medium text-fg-primary">{planItemDisplayTitle(item)}</span>
                <span className="shrink-0 text-caption text-fg-tertiary">
                  {planItemKindLabel(item.kind)} · {item.est_minutes} {t.learner.minutes}
                </span>
              </li>
            ))}
          </ol>
        </Card>
      </div>

      <ConnectWizardDialog open={connectOpen} onOpenChange={setConnectOpen} />
    </div>
  );
}

function SourcePage({ courseId, reference }: { courseId: string; reference: { material_id: string; page_no: number } }) {
  const page = useQuery({
    queryKey: courseKeys.page(reference.material_id, reference.page_no),
    queryFn: () => getMaterialPage(reference.material_id, reference.page_no),
  });
  const materials = useQuery({ queryKey: courseKeys.materials(courseId), queryFn: () => listMaterials(courseId) });
  if (page.isPending) return <Loading />;
  if (page.isError) return <Problem error={page.error} onRetry={() => void page.refetch()} />;
  const material = materials.data?.find((entry) => entry.id === reference.material_id);
  return (
    <div className="source-page" data-testid="source-page">
      <strong>
        {material?.title || material?.filename || t.courses.source} · {t.courses.page.replace("{page}", String(reference.page_no))}
      </strong>
      {page.data.has_image ? (
        <img
          src={materialPageImage(reference.material_id, reference.page_no)}
          width="1600"
          height="1200"
          loading="lazy"
          alt={t.courses.sourceImage.replace("{page}", String(reference.page_no))}
        />
      ) : null}
      <pre>{page.data.markdown}</pre>
      <small>
        {t.courses.pageSource[page.data.source as keyof typeof t.courses.pageSource] ?? page.data.source} ·{" "}
        {Math.round(page.data.quality * 100)}%
      </small>
    </div>
  );
}

function ExamItems({ items }: { items: ExamItem[] }) {
  return (
    <>
      {items.map((item) => (
        <article key={item.id} data-testid="exam-item">
          <div>
            <strong>{item.no}</strong>
            <span className="answer-status">
              {t.courses.answerStatus[item.answer_status as keyof typeof t.courses.answerStatus] ?? item.answer_status}
            </span>
          </div>
          <p>{item.stem}</p>
          {Object.entries(item.options).map(([key, value]) => (
            <p key={key}>{key}. {value}</p>
          ))}
          {item.answer ? (
            <details>
              <summary>{t.courses.answer}</summary>
              <p>{item.answer}</p>
              {item.solution ? <p>{item.solution}</p> : null}
            </details>
          ) : null}
        </article>
      ))}
    </>
  );
}

function KnowledgePointDetail({
  courseId,
  point,
  allPoints,
  hasPlan,
  onChanged,
}: {
  courseId: string;
  point: KnowledgePoint;
  allPoints: KnowledgePoint[];
  hasPlan: boolean;
  onChanged: () => void;
}) {
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [source, setSource] = useState(point.source_refs[0]);
  const [examOpen, setExamOpen] = useState(false);

  const exams = useQuery({
    queryKey: courseKeys.exams(courseId, point.id),
    queryFn: () => listExamItems(courseId, point.id),
    enabled: examOpen,
  });
  const revise = useMutation({
    mutationFn: (body: Parameters<typeof updateKnowledgePoint>[2]) => updateKnowledgePoint(courseId, point.id, body),
    onSuccess: () => {
      setEditing(false);
      setDeleteOpen(false);
      toast.success(t.common.saved);
      onChanged();
    },
  });
  const lesson = useMutation({
    mutationFn: () => createPointPlanItem(courseId, point.id),
    onSuccess: (result) => navigate(`/plan-items/${result.plan_item_id}/lesson`),
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    revise.mutate({
      name: String(data.get("name")),
      importance: String(data.get("importance")),
      prerequisite_ids: data.getAll("prerequisite").map(String),
    });
  }

  return (
    <article className="kp-detail">
      <div className="kp-heading">
        <div>
          <span className="kp-kind">{t.courses.kinds[point.kind as keyof typeof t.courses.kinds] ?? point.kind}</span>
          <h3>{point.name}</h3>
        </div>
        <button className="button quiet revise-button" onClick={() => setEditing((value) => !value)}>
          {t.courses.revise}
        </button>
      </div>
      {point.assumed ? <div className="notice"><p>{t.courses.assumed}</p></div> : null}
      <p>{point.summary}</p>

      {/* D5: Demoted KP entry — never primary; when no plan yet, guide to setup first */}
      {hasPlan ? (
        <div className="actions">
          <Button variant="secondary" pending={lesson.isPending} onClick={() => lesson.mutate()}>
            {t.courseHub.mapStudyPoint}
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line-subtle bg-surface-sunken/70 px-3.5 py-2.5 text-ui text-fg-secondary">
          <span>{t.courseHub.mapNeedSetupHint}</span>
          <Link className="button quiet" to={`/courses/${courseId}/setup`}>
            {t.courseHub.mapGoSetup}
          </Link>
        </div>
      )}

      {lesson.isError ? <Problem error={lesson.error} /> : null}
      {point.formula ? <pre className="formula">{point.formula}</pre> : null}

      <dl className="kp-stats">
        <div><dt>{t.courses.importance}</dt><dd>{t.courses.importanceValue[point.importance]}</dd></div>
        <div><dt>{t.courses.difficulty}</dt><dd><DifficultyDots value={point.difficulty} label={`${t.courses.difficulty} ${point.difficulty}/3`} /></dd></div>
        <div><dt>{t.courses.examCount}</dt><dd>{point.stats?.n_items ?? 0}</dd></div>
        <div><dt>{t.courses.scoreShare}</dt><dd>{point.stats ? `${(point.stats.score_share * 100).toFixed(1)}%` : "—"}</dd></div>
        <div><dt>{t.courses.trend}</dt><dd>{point.stats ? (t.courses.trendValue[point.stats.trend as keyof typeof t.courses.trendValue] ?? point.stats.trend) || "—" : "—"}</dd></div>
      </dl>

      {editing ? (
        <form className="kp-edit fields" onSubmit={submit}>
          <label>{t.courses.kpName}<input name="name" defaultValue={point.name} required /></label>
          <label>{t.courses.importance}<select name="importance" defaultValue={point.importance}>{Object.entries(t.courses.importanceValue).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <fieldset><legend>{t.courses.prerequisites}</legend>{allPoints.filter((candidate) => candidate.id !== point.id).map((candidate) => <label key={candidate.id}><input type="checkbox" name="prerequisite" value={candidate.id} defaultChecked={point.prerequisite_ids.includes(candidate.id)} />{candidate.name}</label>)}</fieldset>
          <div className="actions"><button className="button primary" disabled={revise.isPending} aria-busy={revise.isPending || undefined}>{t.common.save}</button><button type="button" className="button quiet" onClick={() => setEditing(false)}>{t.common.cancel}</button></div>
          <details className="danger-zone"><summary>{t.courses.moreRevisions}</summary><label>{t.courses.mergeInto}<select name="merge"><option value="">{t.courses.chooseKp}</option>{allPoints.filter((candidate) => candidate.id !== point.id).map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}</select></label><div className="actions"><button className="button quiet" type="button" onClick={(event) => { const select = event.currentTarget.closest("details")?.querySelector("select"); if (select?.value) revise.mutate({ merge_into: select.value }); }}>{t.courses.merge}</button><Button variant="danger" onClick={() => setDeleteOpen(true)}>{t.common.remove}</Button></div></details>
          <ConfirmDialog
            open={deleteOpen}
            onOpenChange={setDeleteOpen}
            title={t.courses.deleteTitle}
            description={t.courses.deleteConfirm}
            confirmLabel={t.courses.confirmDelete}
            cancelLabel={t.common.keep}
            pending={revise.isPending}
            onConfirm={() => revise.mutate({ deleted: true })}
          />
          {revise.isError ? <Problem error={revise.error} /> : null}
        </form>
      ) : null}

      <section className="provenance">
        <h3>{t.courses.provenance}</h3>
        {point.source_refs.length ? (
          <div className="source-tabs">
            {point.source_refs.map((reference) => (
              <button
                className="button quiet"
                aria-pressed={source?.material_id === reference.material_id && source.page_no === reference.page_no}
                key={`${reference.material_id}:${reference.page_no}`}
                onClick={() => setSource(reference)}
              >
                {t.courses.page.replace("{page}", String(reference.page_no))}
              </button>
            ))}
          </div>
        ) : (
          <p className="hint">{t.courses.noSource}</p>
        )}
        {source ? <SourcePage courseId={courseId} reference={source} /> : null}
      </section>

      <section className="exam-browser">
        <button className="button quiet" onClick={() => setExamOpen((value) => !value)}>
          {examOpen ? t.courses.hideQuestions : t.courses.showQuestions.replace("{count}", String(point.stats?.n_items ?? 0))}
        </button>
        {examOpen && exams.isPending ? <Loading /> : null}
        {exams.isError ? <Problem error={exams.error} onRetry={() => void exams.refetch()} /> : null}
        {exams.data ? <ExamItems items={exams.data} /> : null}
      </section>
    </article>
  );
}

export function CourseMapTab() {
  const courseId = useParams().courseId ?? "";
  const [searchParams, setSearchParams] = useSearchParams();
  const analysis = useQuery({ queryKey: courseKeys.analysis(courseId), queryFn: () => getAnalysis(courseId) });
  const map = useQuery({ queryKey: courseKeys.map(courseId), queryFn: () => getCourseMap(courseId) });
  const journey = useQuery({ queryKey: courseKeys.journey(courseId), queryFn: () => getCourseJourney(courseId) });
  const unmapped = useQuery({ queryKey: courseKeys.unmappedExams(courseId), queryFn: () => listUnmappedExamItems(courseId) });

  const selectedId = searchParams.get("kp") ?? undefined;
  const allPoints = useMemo(() => map.data?.units.flatMap((unit) => unit.knowledge_points) ?? [], [map.data]);
  const selected = allPoints.find((point) => point.id === selectedId) ?? allPoints[0];
  const showUnmapped = selectedId === "unmapped" && Boolean(unmapped.data?.length);

  function selectPoint(id: string) {
    const next = new URLSearchParams(searchParams);
    next.set("kp", id);
    setSearchParams(next, { replace: true });
  }

  if (map.isPending) return <Loading />;
  if (map.isError) return <Problem error={map.error} onRetry={() => void map.refetch()} />;
  if (!allPoints.length && !unmapped.data?.length) {
    if (unmapped.isError) return <Problem error={unmapped.error} onRetry={() => void unmapped.refetch()} />;
    return (
      <Card padding="lg" className="grid gap-3">
        <p className="text-ui text-fg-secondary">
          {!map.data.brief && analysis.data?.status !== "completed" ? t.courses.mapPending : t.courses.mapEmpty}
        </p>
        <div>
          <Link className="button quiet" to={`/courses/${courseId}/setup`}>
            {t.courseHub.continueSetup}
          </Link>
        </div>
      </Card>
    );
  }

  const support = map.data.brief?.summary_support;
  const hasPlan = Boolean(journey.data?.has_plan);

  return (
    <section className="course-panel map-panel" aria-labelledby="map-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">{t.courses.map}</p>
          <h2 id="map-title">{t.courses.mapHeading}</h2>
        </div>
        <span>{allPoints.length} {t.courses.kpUnit}</span>
      </div>
      {support && support.checked > 0 ? (
        <p className="hint">
          {t.courses.summarySupport.replace("{supported}", String(support.supported)).replace("{checked}", String(support.checked))}
        </p>
      ) : null}
      {map.data.warnings.map((warning) => (
        <div className="notice" key={warning}><p>{warningText(warning)}</p></div>
      ))}
      <div className="map-layout">
        <nav className="unit-map" aria-label={t.courses.mapHeading}>
          {map.data.units.map((unit) => (
            <section key={unit.id}>
              <h3>{unit.title}</h3>
              {unit.knowledge_points.map((point) => (
                <button
                  key={point.id}
                  aria-current={!showUnmapped && selected?.id === point.id ? "true" : undefined}
                  onClick={() => selectPoint(point.id)}
                >
                  <span data-importance={point.importance} />
                  {point.name}
                  <small>{point.stats?.n_items ? `${point.stats.n_items} ${t.courses.questionUnit}` : ""}</small>
                </button>
              ))}
            </section>
          ))}
          {unmapped.data?.length ? (
            <section>
              <h3>{t.courses.unmapped}</h3>
              <button aria-current={showUnmapped ? "true" : undefined} onClick={() => selectPoint("unmapped")}>
                <span />
                {t.courses.unmapped}
                <small>{unmapped.data.length} {t.courses.questionUnit}</small>
              </button>
            </section>
          ) : null}
        </nav>
        {showUnmapped ? (
          <article className="kp-detail">
            <div className="kp-heading"><div><h3>{t.courses.unmapped}</h3></div></div>
            <p>{t.courses.unmappedHint}</p>
            <section className="exam-browser"><ExamItems items={unmapped.data ?? []} /></section>
          </article>
        ) : selected ? (
          <KnowledgePointDetail
            key={selected.id}
            courseId={courseId}
            point={selected}
            allPoints={allPoints}
            hasPlan={hasPlan}
            onChanged={() => void map.refetch()}
          />
        ) : null}
      </div>
    </section>
  );
}

export function CourseMaterialsTab() {
  const courseId = useParams().courseId ?? "";
  const navigate = useNavigate();
  const queries = useQueryClient();
  const [pending, setPending] = useState<PendingFile[]>([]);
  const [deleteTarget, setDeleteTarget] = useState<Material | null>(null);

  const materials = useQuery({
    queryKey: courseKeys.materials(courseId),
    queryFn: () => listMaterials(courseId),
    enabled: Boolean(courseId),
  });
  const analysis = useQuery({
    queryKey: courseKeys.analysis(courseId),
    queryFn: () => getAnalysis(courseId),
    enabled: Boolean(courseId),
  });

  const analyzing = analysis.data?.status === "queued" || analysis.data?.status === "running";

  const upload = useMutation({
    mutationFn: () =>
      uploadMaterials(
        courseId,
        pending.map((entry) => entry.file),
        pending.map((entry) => ({
          role: entry.role,
          year: entry.year,
          exam_name: entry.exam_name,
          has_answers: entry.has_answers,
        })),
      ),
    onSuccess: () => {
      setPending([]);
      toast.success(t.common.saved);
      void queries.invalidateQueries({ queryKey: courseKeys.materials(courseId) });
      void queries.invalidateQueries({ queryKey: courseKeys.journey(courseId) });
    },
  });

  const paste = useMutation({
    mutationFn: (body: { title: string; content: string; role: MaterialRole }) => pasteMaterial(courseId, body),
    onSuccess: () => {
      toast.success(t.common.saved);
      void queries.invalidateQueries({ queryKey: courseKeys.materials(courseId) });
      void queries.invalidateQueries({ queryKey: courseKeys.journey(courseId) });
    },
  });

  const revise = useMutation({
    mutationFn: ({
      materialId,
      body,
    }: {
      materialId: string;
      body: Partial<Pick<Material, "role" | "year" | "exam_name" | "has_answers">>;
    }) => updateMaterial(courseId, materialId, body),
    onSuccess: () => {
      void queries.invalidateQueries({ queryKey: courseKeys.materials(courseId) });
    },
  });

  const removeMaterialMutation = useMutation({
    mutationFn: (materialId: string) => deleteMaterial(courseId, materialId),
    onSuccess: () => {
      setDeleteTarget(null);
      toast.success(t.common.saved);
      void queries.invalidateQueries({ queryKey: courseKeys.materials(courseId) });
      void queries.invalidateQueries({ queryKey: courseKeys.journey(courseId) });
    },
  });

  const triggerRead = useMutation({
    mutationFn: () => startAnalysis(courseId, false),
    onSuccess: (res) => {
      if (res.job) queries.setQueryData(courseKeys.analysis(courseId), res.job);
      navigate(`/courses/${courseId}/setup?step=analysis`);
    },
  });

  function appendFiles(files: File[]) {
    const additions = files.map((file) => ({ file, ...inferMaterial(file.name) }));
    setPending((current) => [...current, ...additions]);
  }

  function submitPaste(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    paste.mutate(
      {
        title: String(data.get("title")),
        content: String(data.get("content")),
        role: String(data.get("role")) as MaterialRole,
      },
      { onSuccess: () => form.reset() },
    );
  }

  const examMaterials = (materials.data ?? []).filter((m) => m.role === "exam");

  return (
    <div className="grid gap-5" data-testid="course-materials-tab">
      <Card padding="lg" className="grid gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-title font-semibold text-fg-primary">{t.courses.importHeading}</h2>
          {(materials.data?.length ?? 0) > 0 ? (
            <Button
              variant="secondary"
              pending={triggerRead.isPending}
              disabled={analyzing}
              onClick={() => triggerRead.mutate()}
            >
              {t.courseHub.readNewMaterials}
            </Button>
          ) : null}
        </div>

        <FileDropzone
          onFiles={appendFiles}
          accept=".pdf,.pptx,.docx,.md,.txt,.png,.jpg,.jpeg,.webp"
          disabled={analyzing}
          title={t.courses.drop}
          description={t.courses.formats}
          buttonLabel={t.courses.choose}
        />

        {pending.length > 0 ? (
          <div className="grid gap-3">
            {pending.map((entry, index) => (
              <div
                key={`${entry.file.name}:${entry.file.lastModified}:${index}`}
                data-testid="pending-file"
                className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-line-subtle bg-surface-page p-3"
              >
                <div className="grid min-w-0">
                  <strong className="truncate text-ui font-medium text-fg-primary">{entry.file.name}</strong>
                  <small className="text-caption text-fg-tertiary">{formatFileSize(entry.file.size)}</small>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Select
                    aria-label={t.courses.role}
                    value={entry.role}
                    onValueChange={(value) =>
                      setPending((items) =>
                        items.map((item, idx) => (idx === index ? { ...item, role: value as MaterialRole } : item)),
                      )
                    }
                    options={roles.map((role) => ({ value: role, label: t.courses.roles[role] }))}
                    className="w-36"
                  />
                  {entry.role === "exam" ? (
                    <>
                      <TextInput
                        type="number"
                        min="1900"
                        max="2100"
                        placeholder={t.courses.year}
                        value={entry.year ?? ""}
                        onChange={(e) =>
                          setPending((items) =>
                            items.map((item, idx) =>
                              idx === index ? { ...item, year: e.target.value ? Number(e.target.value) : undefined } : item,
                            ),
                          )
                        }
                        className="w-24"
                      />
                      <Checkbox
                        label={t.courses.hasAnswers}
                        checked={entry.has_answers ?? false}
                        onChange={(e) =>
                          setPending((items) =>
                            items.map((item, idx) => (idx === index ? { ...item, has_answers: e.target.checked } : item)),
                          )
                        }
                      />
                    </>
                  ) : null}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setPending((items) => items.filter((_, idx) => idx !== index))}
                  >
                    {t.common.remove}
                  </Button>
                </div>
              </div>
            ))}
            <div>
              <Button variant="primary" pending={upload.isPending} onClick={() => upload.mutate()}>
                {t.courses.upload}
              </Button>
            </div>
          </div>
        ) : null}

        <details className="rounded-md border border-line-subtle bg-surface-page px-4 py-3">
          <summary className="cursor-pointer text-ui font-medium text-fg-secondary select-none">
            {t.courses.paste}
          </summary>
          <form className="mt-3 grid gap-3" onSubmit={submitPaste}>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t.courses.pasteTitle} required>
                <TextInput name="title" maxLength={120} required />
              </Field>
              <label className="grid gap-1 text-ui font-medium text-fg-primary">
                <span>{t.courses.role}</span>
                <select name="role" defaultValue="notes" className="min-h-10 rounded-md border border-line-control bg-surface-card px-3 text-ui">
                  {roles.map((role) => (
                    <option key={role} value={role}>{t.courses.roles[role]}</option>
                  ))}
                </select>
              </label>
            </div>
            <Field label={t.courses.pasteContent} required>
              <Textarea name="content" rows={5} required />
            </Field>
            <div>
              <Button type="submit" variant="secondary" pending={paste.isPending}>
                {t.courses.addPaste}
              </Button>
            </div>
            {paste.isError ? <Problem error={paste.error} /> : null}
          </form>
        </details>

        {upload.isError ? <Problem error={upload.error} /> : null}
        {triggerRead.isError ? <Problem error={triggerRead.error} /> : null}
      </Card>

      <Card padding="lg" className="grid gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-title font-semibold text-fg-primary">{t.courseHub.materialsCard}</h2>
          {analyzing ? <Badge tone="warn">{t.courseHub.removeDisabledAnalyzing}</Badge> : null}
        </div>
        {materials.isPending ? <Loading /> : null}
        {materials.isError ? <Problem error={materials.error} onRetry={() => void materials.refetch()} /> : null}
        {revise.isError ? <Problem error={revise.error} /> : null}
        {removeMaterialMutation.isError ? <Problem error={removeMaterialMutation.error} /> : null}
        {!materials.isPending && !materials.data?.length ? (
          <p className="text-ui text-fg-secondary">{t.courses.noMaterials}</p>
        ) : null}
        {materials.data?.length ? (
          <ul className="grid gap-3">
            {materials.data.map((material) => (
              <li
                key={material.id}
                data-testid="material-item"
                data-state={material.parse_status}
                className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-line-subtle bg-surface-page p-3.5"
              >
                <div className="grid min-w-0 gap-0.5">
                  <strong className="truncate text-ui font-medium text-fg-primary">
                    {material.title || material.filename}
                  </strong>
                  <span className="text-caption text-fg-tertiary">
                    {material.page_count ? `${material.page_count} ${t.courses.pageUnit}` : material.filename} ·{" "}
                    {t.courses.materialStatus[material.parse_status]}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Select
                    aria-label={t.courses.role}
                    value={material.role}
                    disabled={revise.isPending || analyzing}
                    onValueChange={(value) =>
                      revise.mutate({ materialId: material.id, body: { role: value as MaterialRole } })
                    }
                    options={roles.map((role) => ({ value: role, label: t.courses.roles[role] }))}
                    className="w-36"
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={analyzing}
                    title={analyzing ? t.courseHub.removeDisabledAnalyzing : undefined}
                    leftIcon={<Trash2 size={14} aria-hidden="true" />}
                    onClick={() => setDeleteTarget(material)}
                  >
                    {t.courseHub.removeMaterial}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        ) : null}
      </Card>

      {/* Exam Papers Section */}
      <Card padding="lg" className="grid gap-3">
        <h2 className="text-title font-semibold text-fg-primary">{t.courseHub.examPapersSection}</h2>
        {examMaterials.length ? (
          <ul className="grid gap-2">
            {examMaterials.map((exam) => (
              <li
                key={exam.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line-subtle bg-surface-page px-3.5 py-2.5"
              >
                <span className="text-ui font-medium text-fg-primary">
                  {exam.year ? `${exam.year} · ` : ""}
                  {exam.exam_name || exam.title || exam.filename}
                </span>
                <Link className="text-caption font-medium text-accent-strong hover:underline" to={`/courses/${courseId}/map`}>
                  {t.courseHub.tabs.map}
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-ui text-fg-secondary">{t.courseHub.examPapersEmpty}</p>
        )}
      </Card>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title={t.courseHub.removeMaterialTitle}
        description={t.courseHub.removeMaterialBody.replace(
          "{name}",
          deleteTarget?.title || deleteTarget?.filename || "",
        )}
        confirmLabel={t.courseHub.removeMaterial}
        cancelLabel={t.common.keep}
        pending={removeMaterialMutation.isPending}
        onConfirm={() => {
          if (deleteTarget) removeMaterialMutation.mutate(deleteTarget.id);
        }}
      />
    </div>
  );
}
