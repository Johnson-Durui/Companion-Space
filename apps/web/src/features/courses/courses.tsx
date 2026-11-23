import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearchParams } from "react-router";
import { charactersKey, fetchCharacters, fetchSettings, settingsKey } from "../../app/api";
import { Loading, Problem } from "../../app/ui";
import {
  ArrowRight,
  Badge,
  BookOpen,
  Button,
  Calendar,
  Card,
  ConfirmDialog,
  Dialog,
  EmptyState,
  Field,
  GraduationCap,
  Layers,
  Menu,
  MoreHorizontal,
  Pencil,
  Plus,
  Settings,
  Sparkles,
  TextInput,
  Textarea,
  Trash2,
  TutorAvatar,
  toast,
} from "../../ui";
import t from "../../locales/zh-CN.json";
import { resolveCharacterStill } from "../characters/video-config";
import { tutorLine } from "../tutors/use-active-tutor";
import {
  courseKeys,
  createCourse,
  deleteCourse,
  listCourseDashboard,
  listCourses,
  updateCourse,
} from "./api";
import { resolveCoursePrimaryAction } from "./journey-helpers";
import type { Course } from "./types";

export default function Courses() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();

  const courses = useQuery({ queryKey: courseKeys.all, queryFn: listCourses });
  const dashboard = useQuery({ queryKey: courseKeys.dashboard, queryFn: listCourseDashboard });
  const settings = useQuery({ queryKey: settingsKey, queryFn: fetchSettings });
  const characters = useQuery({ queryKey: charactersKey, queryFn: fetchCharacters });

  const [createOpen, setCreateOpen] = useState(searchParams.get("new") === "1");
  const [newName, setNewName] = useState("");
  const [newGoal, setNewGoal] = useState("");

  const [renameTarget, setRenameTarget] = useState<Course | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameGoal, setRenameGoal] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<Course | null>(null);

  const summaries = new Map(dashboard.data?.map((summary) => [summary.course_id, summary]));
  const teacher =
    characters.data?.find((entry) => entry.id === settings.data?.default_character_id) ??
    characters.data?.[0];

  const create = useMutation({
    mutationFn: createCourse,
    onSuccess: (course) => {
      setCreateOpen(false);
      setNewName("");
      setNewGoal("");
      void queryClient.invalidateQueries({ queryKey: courseKeys.all });
      navigate(`/courses/${course.id}/setup`);
    },
  });

  const rename = useMutation({
    mutationFn: ({ id, name, goal }: { id: string; name: string; goal?: string }) =>
      updateCourse(id, { name, goal }),
    onSuccess: () => {
      setRenameTarget(null);
      toast.success(t.common.saved);
      void queryClient.invalidateQueries({ queryKey: courseKeys.all });
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteCourse(id),
    onSuccess: () => {
      setDeleteTarget(null);
      toast.success(t.common.saved);
      void queryClient.invalidateQueries({ queryKey: courseKeys.all });
    },
  });

  function openCreateDialog() {
    create.reset();
    setCreateOpen(true);
  }

  function closeCreateDialog(open: boolean) {
    setCreateOpen(open);
    if (!open && searchParams.has("new")) {
      const next = new URLSearchParams(searchParams);
      next.delete("new");
      setSearchParams(next, { replace: true });
    }
  }

  function submitCreate(event: FormEvent) {
    event.preventDefault();
    if (!newName.trim()) return;
    create.mutate({ name: newName.trim(), goal: newGoal.trim() || undefined });
  }

  function submitRename(event: FormEvent) {
    event.preventDefault();
    if (!renameTarget || !renameValue.trim()) return;
    rename.mutate({
      id: renameTarget.id,
      name: renameValue.trim(),
      goal: renameGoal.trim(),
    });
  }

  const courseCount = courses.data?.length ?? 0;
  const dueLessonCount = dashboard.data?.filter((entry) => Boolean(entry.today_lesson)).length ?? 0;
  const dueReviewTotal = dashboard.data?.reduce((sum, entry) => sum + entry.due_review_count, 0) ?? 0;

  return (
    <div className="grid min-w-0 gap-6 py-6 sm:py-8">
      <section className="cs-hero-stage cs-enter-1 rounded-xl p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="grid gap-2">
            <div className="flex flex-wrap items-center gap-2 text-caption">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-accent-soft px-2.5 py-0.5 font-semibold text-accent-strong">
                <GraduationCap size={13} aria-hidden="true" />
                <span>{t.richUi.statActiveCourses}</span>
              </span>
              {courseCount > 0 ? (
                <>
                  <span className="inline-flex items-center gap-1 rounded-full border border-line-subtle bg-surface-card/85 px-2.5 py-0.5 font-medium tabular-nums text-fg-secondary">
                    <BookOpen size={12} aria-hidden="true" />
                    <span>
                      {t.richUi.statDueLessons} {dueLessonCount}
                    </span>
                  </span>
                  <span className="inline-flex items-center gap-1 rounded-full border border-line-subtle bg-surface-card/85 px-2.5 py-0.5 font-medium tabular-nums text-fg-secondary">
                    <Layers size={12} aria-hidden="true" />
                    <span>
                      {t.richUi.statDueReviews} {dueReviewTotal}
                    </span>
                  </span>
                </>
              ) : null}
            </div>
            <h1 className="text-headline font-semibold text-fg-primary">{t.courses.heading}</h1>
            <p className="text-ui text-fg-secondary">{t.courses.lead}</p>
          </div>
          <Button
            variant="primary"
            leftIcon={<Plus size={16} aria-hidden="true" />}
            onClick={openCreateDialog}
          >
            {t.courses.new}
          </Button>
        </div>
      </section>

      {courses.isPending ? <Loading /> : null}
      {courses.isError ? <Problem error={courses.error} onRetry={() => void courses.refetch()} /> : null}
      {dashboard.isError ? <Problem error={dashboard.error} onRetry={() => void dashboard.refetch()} /> : null}

      {courses.data?.length === 0 ? (
        <EmptyState
          visual={
            teacher ? (() => {
              const emptyStill = resolveCharacterStill(teacher, "empty_state");
              return (
                <TutorAvatar
                  src={emptyStill.url}
                  still={emptyStill.still}
                  name={teacher.name}
                  size="lg"
                />
              );
            })() : (
              <Plus size={36} strokeWidth={1.75} />
            )
          }
          title={t.courses.empty}
          description={teacher ? `${teacher.name}：${tutorLine(teacher, "empty", t.tutorsGallery.emptyCoursesLine)}` : t.courses.emptyHint}
          action={
            <Button variant="primary" onClick={openCreateDialog}>
              {t.courses.new}
            </Button>
          }
        />
      ) : null}

      {courses.data?.length ? (
        <ul className="grid gap-4 md:grid-cols-2">
          {courses.data.map((course) => {
            const summary = summaries.get(course.id);
            const action = resolveCoursePrimaryAction(
              summary ?? { course_id: course.id, has_plan: false },
            );
            const daysText =
              summary?.remaining_days === 0
                ? t.today.examToday
                : summary?.remaining_days != null
                  ? t.courses.remainingDays.replace("{count}", String(summary.remaining_days))
                  : summary?.journey?.exam_passed
                    ? t.today.examPassed
                    : "—";

            const kpsTotal = course.brief?.knowledge_point_count ?? summary?.journey?.kps_total ?? null;
            const kpsLearned = summary?.journey?.kps_learned ?? 0;

            return (
              <li
                key={course.id}
                data-testid="course-card"
                data-stage={action.stage}
                className="min-w-0"
              >
                <Card padding="lg" className="cs-bento-card grid h-full content-between gap-4">
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-accent via-accent/65 to-transparent"
                  />
                  <div className="grid gap-3.5">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex min-w-0 items-start gap-3">
                        <span className="mt-0.5 inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent-strong shadow-1">
                          <BookOpen size={18} aria-hidden="true" />
                        </span>
                        <Link to={`/courses/${course.id}`} className="grid min-w-0 gap-1">
                          <h2 className="truncate text-title font-semibold text-fg-primary hover:text-accent-strong">
                            {course.name}
                          </h2>
                          <p className="line-clamp-2 text-ui text-fg-secondary">
                            {course.goal || t.courses.goalEmpty}
                          </p>
                        </Link>
                      </div>
                      <Menu
                        trigger={
                          <span
                            aria-label={t.courseHub.more}
                            className="inline-flex h-9 w-9 items-center justify-center rounded-md text-fg-secondary hover:bg-surface-sunken hover:text-fg-primary"
                          >
                            <MoreHorizontal size={18} aria-hidden="true" />
                          </span>
                        }
                        items={[
                          {
                            id: "rename",
                            label: t.courseHub.rename,
                            icon: <Pencil size={15} aria-hidden="true" />,
                            onSelect: () => {
                              rename.reset();
                              setRenameTarget(course);
                              setRenameValue(course.name);
                              setRenameGoal(course.goal ?? "");
                            },
                          },
                          {
                            id: "settings",
                            label: t.courseHub.courseSettings,
                            icon: <Settings size={15} aria-hidden="true" />,
                            onSelect: () => navigate(`/courses/${course.id}?settings=1`),
                          },
                          {
                            id: "delete",
                            label: t.courseHub.deleteCourse,
                            icon: <Trash2 size={15} aria-hidden="true" />,
                            danger: true,
                            onSelect: () => {
                              remove.reset();
                              setDeleteTarget(course);
                            },
                          },
                        ]}
                      />
                    </div>

                    <p
                      data-testid="course-stage-status"
                      className="flex items-center gap-2 rounded-md border border-line-subtle/80 bg-surface-sunken/70 px-3 py-2 text-ui font-medium text-fg-primary"
                    >
                      <span
                        aria-hidden="true"
                        className={
                          action.stage === "learning"
                            ? "h-2 w-2 shrink-0 rounded-full bg-accent"
                            : action.stage === "today_done" || action.stage === "all_done"
                              ? "h-2 w-2 shrink-0 rounded-full bg-ok"
                              : "h-2 w-2 shrink-0 rounded-full bg-warn"
                        }
                      />
                      <span className="min-w-0 truncate">{action.statusText}</span>
                    </p>

                    {kpsTotal && kpsTotal > 0 ? (
                      <div className="grid gap-1">
                        <div className="flex justify-between text-caption text-fg-tertiary tabular-nums">
                          <span>{t.richUi.courseProgressLabel}</span>
                          <span>
                            {kpsLearned} / {kpsTotal}
                          </span>
                        </div>
                        <div className="h-1.5 overflow-hidden rounded-full bg-surface-sunken">
                          <div
                            className="h-full rounded-full bg-accent"
                            style={{ width: `${Math.min(100, Math.round((kpsLearned / kpsTotal) * 100))}%` }}
                          />
                        </div>
                      </div>
                    ) : null}

                    <dl className="grid grid-cols-3 gap-2 text-caption">
                      <div className="grid gap-0.5 rounded-md bg-surface-sunken/55 px-2.5 py-2">
                        <dt className="flex items-center gap-1 text-fg-tertiary">
                          <Sparkles size={11} aria-hidden="true" />
                          <span className="truncate">{t.courses.kps}</span>
                        </dt>
                        <dd className="text-ui font-semibold tabular-nums text-fg-primary">
                          {kpsTotal ?? "—"}
                        </dd>
                      </div>
                      <div className="grid gap-0.5 rounded-md bg-surface-sunken/55 px-2.5 py-2">
                        <dt className="flex items-center gap-1 text-fg-tertiary">
                          <Layers size={11} aria-hidden="true" />
                          <span className="truncate">{t.courses.questions}</span>
                        </dt>
                        <dd className="text-ui font-semibold tabular-nums text-fg-primary">
                          {course.brief?.item_count ?? "—"}
                        </dd>
                      </div>
                      <div className="grid gap-0.5 rounded-md bg-surface-sunken/55 px-2.5 py-2">
                        <dt className="flex items-center gap-1 text-fg-tertiary">
                          <Calendar size={11} aria-hidden="true" />
                          <span className="truncate">{t.learner.examDate.replace("（可选）", "")}</span>
                        </dt>
                        <dd className="truncate text-ui font-semibold tabular-nums text-fg-primary">
                          {daysText}
                        </dd>
                      </div>
                    </dl>
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line-subtle/80 pt-3">
                    {summary && summary.due_review_count > 0 ? (
                      <Link
                        className="inline-flex items-center gap-1.5 text-ui font-medium text-accent-strong hover:underline"
                        to={`/courses/${course.id}/review`}
                      >
                        <Badge tone="accent">
                          {t.courses.dueReviews.replace("{count}", String(summary.due_review_count))}
                        </Badge>
                      </Link>
                    ) : (
                      <Link
                        className="text-ui font-medium text-fg-secondary hover:text-accent-strong"
                        to={`/courses/${course.id}`}
                      >
                        {t.courses.open}
                      </Link>
                    )}

                    <Link className="button quiet" to={action.to}>
                      <span>{action.ctaLabel}</span>
                      <ArrowRight size={15} aria-hidden="true" />
                    </Link>
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
      ) : null}

      {/* New Course Dialog */}
      <Dialog open={createOpen} onOpenChange={closeCreateDialog} title={t.courses.new} size="md">
        <form className="grid gap-4" onSubmit={submitCreate}>
          <Field label={t.courses.name} required>
            <TextInput
              name="name"
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              placeholder={t.onboarding.courseNamePlaceholder}
              maxLength={120}
              required
              autoFocus
            />
          </Field>
          <Field label={t.courses.goal}>
            <Textarea
              name="goal"
              rows={2}
              value={newGoal}
              onChange={(event) => setNewGoal(event.target.value)}
              placeholder={t.onboarding.courseGoalPlaceholder}
              maxLength={500}
            />
          </Field>
          {create.isError ? <Problem error={create.error} /> : null}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={() => closeCreateDialog(false)}>
              {t.common.cancel}
            </Button>
            <Button type="submit" variant="primary" pending={create.isPending} disabled={!newName.trim()}>
              {t.courses.create}
            </Button>
          </div>
        </form>
      </Dialog>

      {/* Rename Course Dialog (B11) */}
      <Dialog
        open={Boolean(renameTarget)}
        onOpenChange={(open) => {
          if (!open) setRenameTarget(null);
        }}
        title={t.courseHub.renameTitle}
        size="sm"
      >
        <form className="grid gap-4" onSubmit={submitRename}>
          <Field label={t.courses.name} required>
            <TextInput
              name="rename"
              value={renameValue}
              onChange={(event) => setRenameValue(event.target.value)}
              maxLength={120}
              required
              autoFocus
            />
          </Field>
          <Field label={t.courses.goal}>
            <Textarea
              name="rename_goal"
              rows={2}
              value={renameGoal}
              onChange={(event) => setRenameGoal(event.target.value)}
              maxLength={500}
            />
          </Field>
          {rename.isError ? <Problem error={rename.error} /> : null}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={() => setRenameTarget(null)}>
              {t.common.cancel}
            </Button>
            <Button type="submit" variant="primary" pending={rename.isPending} disabled={!renameValue.trim()}>
              {t.common.save}
            </Button>
          </div>
        </form>
      </Dialog>

      {/* Delete Course Confirm Dialog (B11) */}
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title={t.courseHub.deleteCourseTitle.replace("{name}", deleteTarget?.name ?? "")}
        description={t.courseHub.deleteCourseBody}
        confirmLabel={t.courses.confirmDelete}
        cancelLabel={t.common.keep}
        pending={remove.isPending}
        onConfirm={() => {
          if (deleteTarget) remove.mutate(deleteTarget.id);
        }}
      />
    </div>
  );
}
