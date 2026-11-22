import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearchParams } from "react-router";
import { charactersKey, fetchCharacters, fetchSettings, settingsKey } from "../../app/api";
import { Loading, Problem } from "../../app/ui";
import {
  ArrowRight,
  Button,
  Card,
  ConfirmDialog,
  Dialog,
  EmptyState,
  Field,
  Menu,
  MoreHorizontal,
  Pencil,
  Plus,
  Settings,
  TextInput,
  Textarea,
  Trash2,
  TutorAvatar,
  toast,
} from "../../ui";
import t from "../../locales/zh-CN.json";
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

  return (
    <div className="grid min-w-0 gap-6 py-6 sm:py-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="grid gap-1">
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

      {courses.isPending ? <Loading /> : null}
      {courses.isError ? <Problem error={courses.error} onRetry={() => void courses.refetch()} /> : null}
      {dashboard.isError ? <Problem error={dashboard.error} onRetry={() => void dashboard.refetch()} /> : null}

      {courses.data?.length === 0 ? (
        <EmptyState
          visual={
            teacher ? (
              <TutorAvatar src={teacher.appearance.src} name={teacher.name} size="lg" />
            ) : (
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

            return (
              <li
                key={course.id}
                data-testid="course-card"
                data-stage={action.stage}
                className="min-w-0"
              >
                <Card padding="lg" className="grid h-full content-between gap-4">
                  <div className="grid gap-3">
                    <div className="flex items-start justify-between gap-3">
                      <Link to={`/courses/${course.id}`} className="grid min-w-0 gap-1">
                        <h2 className="truncate text-title font-semibold text-fg-primary hover:text-accent-strong">
                          {course.name}
                        </h2>
                        <p className="line-clamp-2 text-ui text-fg-secondary">
                          {course.goal || t.courses.goalEmpty}
                        </p>
                      </Link>
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
                      className="rounded-md bg-surface-sunken/70 px-3 py-2 text-ui font-medium text-fg-primary"
                    >
                      {action.statusText}
                    </p>

                    <dl className="grid grid-cols-3 gap-2 border-t border-line-subtle pt-3 text-caption">
                      <div className="grid gap-0.5">
                        <dt className="text-fg-tertiary">{t.courses.kps}</dt>
                        <dd className="text-ui font-semibold text-fg-primary">
                          {course.brief?.knowledge_point_count ?? summary?.journey?.kps_total ?? "—"}
                        </dd>
                      </div>
                      <div className="grid gap-0.5">
                        <dt className="text-fg-tertiary">{t.courses.questions}</dt>
                        <dd className="text-ui font-semibold text-fg-primary">
                          {course.brief?.item_count ?? "—"}
                        </dd>
                      </div>
                      <div className="grid gap-0.5">
                        <dt className="text-fg-tertiary">{t.learner.examDate.replace("（可选）", "")}</dt>
                        <dd className="text-ui font-semibold text-fg-primary">{daysText}</dd>
                      </div>
                    </dl>
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                    {summary && summary.due_review_count > 0 ? (
                      <Link
                        className="text-ui font-medium text-fg-secondary hover:text-accent-strong"
                        to={`/courses/${course.id}/review`}
                      >
                        {t.courses.dueReviews.replace("{count}", String(summary.due_review_count))}
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
