import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loading, Problem } from "../../app/ui";
import { Button, Chip, Dialog, Field, Select, TextInput, Textarea, toast } from "../../ui";
import t from "../../locales/zh-CN.json";
import { getEnrollment, learnerKeys, replan, saveEnrollment, type CourseEnrollment } from "../learner/api";
import { courseKeys, updateCourse } from "./api";
import type { Course } from "./types";

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;

export interface CourseSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  course: Course;
}

export function CourseSettingsDialog({ open, onOpenChange, course }: CourseSettingsDialogProps) {
  const queries = useQueryClient();
  const enrollment = useQuery({
    queryKey: learnerKeys.enrollment(course.id),
    queryFn: () => getEnrollment(course.id),
    enabled: open,
  });

  const [savedNotice, setSavedNotice] = useState(false);

  const rebuild = useMutation({
    mutationFn: () => replan(course.id),
    onSuccess: (nextPlan) => {
      queries.setQueryData(learnerKeys.plan(course.id), nextPlan);
      void queries.invalidateQueries({ queryKey: courseKeys.all });
      void queries.invalidateQueries({ queryKey: courseKeys.journey(course.id) });
      toast.success(t.common.saved);
      setSavedNotice(false);
      onOpenChange(false);
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setSavedNotice(false);
        onOpenChange(next);
      }}
      title={t.courseHub.settingsTitle}
      size="lg"
    >
      {enrollment.isPending ? <Loading /> : null}
      {enrollment.isError ? <Problem error={enrollment.error} onRetry={() => void enrollment.refetch()} /> : null}
      {enrollment.data ? (
        <CourseSettingsForm
          key={`${course.id}:${enrollment.dataUpdatedAt}`}
          course={course}
          enrollment={enrollment.data}
          savedNotice={savedNotice}
          rebuilding={rebuild.isPending}
          onSaved={() => setSavedNotice(true)}
          onReplan={() => rebuild.mutate()}
          onClose={() => onOpenChange(false)}
        />
      ) : null}
    </Dialog>
  );
}

function CourseSettingsForm({
  course,
  enrollment,
  savedNotice,
  rebuilding,
  onSaved,
  onReplan,
  onClose,
}: {
  course: Course;
  enrollment: CourseEnrollment;
  savedNotice: boolean;
  rebuilding: boolean;
  onSaved: () => void;
  onReplan: () => void;
  onClose: () => void;
}) {
  const queries = useQueryClient();
  const [name, setName] = useState(course.name);
  const [goal, setGoal] = useState(course.goal ?? "");
  const [goalType, setGoalType] = useState<CourseEnrollment["goal_type"]>(enrollment.goal_type);
  const [examName, setExamName] = useState(enrollment.exam_name ?? "");
  const [examDate, setExamDate] = useState(enrollment.exam_date ?? "");
  const [targetScore, setTargetScore] = useState(
    enrollment.target_score != null ? String(enrollment.target_score) : "",
  );
  const [fullScore, setFullScore] = useState(String(enrollment.full_score ?? 100));
  const [weeklyDays, setWeeklyDays] = useState<number[]>(enrollment.weekly_days ?? [1, 2, 3, 4, 5, 6, 7]);
  const [sessionMinutes, setSessionMinutes] = useState(String(enrollment.session_minutes ?? 30));
  const [selfLevel, setSelfLevel] = useState<CourseEnrollment["self_level"]>(enrollment.self_level);
  const [teacherHints, setTeacherHints] = useState(enrollment.teacher_hints ?? "");

  const save = useMutation({
    mutationFn: async () => {
      if (name.trim() !== course.name || (goal.trim() || null) !== (course.goal ?? null)) {
        await updateCourse(course.id, { name: name.trim(), goal: goal.trim() || null });
      }
      return saveEnrollment(course.id, {
        goal_type: goalType,
        exam_name: examName.trim(),
        exam_date: examDate.trim() || null,
        target_score: targetScore.trim() === "" ? null : Number(targetScore),
        full_score: Number(fullScore) || 100,
        weekly_days: weeklyDays.length ? [...weeklyDays].sort((a, b) => a - b) : [1, 2, 3, 4, 5],
        session_minutes: Math.max(5, Math.min(1440, Number(sessionMinutes) || 30)),
        self_level: selfLevel,
        hard_units: enrollment.hard_units ?? [],
        teacher_hints: teacherHints.trim(),
      });
    },
    onSuccess: (updated) => {
      queries.setQueryData(learnerKeys.enrollment(course.id), updated);
      void queries.invalidateQueries({ queryKey: courseKeys.all });
      void queries.invalidateQueries({ queryKey: courseKeys.one(course.id) });
      void queries.invalidateQueries({ queryKey: courseKeys.journey(course.id) });
      void queries.invalidateQueries({ queryKey: learnerKeys.plan(course.id) });
      toast.success(t.common.saved);
      onSaved();
    },
  });

  function toggleDay(day: number) {
    setWeeklyDays((prev) =>
      prev.includes(day) ? (prev.length > 1 ? prev.filter((d) => d !== day) : prev) : [...prev, day],
    );
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    save.mutate();
  }

  return (
    <form className="grid gap-4" onSubmit={submit}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t.courses.name} required>
          <TextInput value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required />
        </Field>
        <Field label={t.learner.goalType}>
          <Select
            value={goalType}
            onValueChange={(val) => setGoalType(val as CourseEnrollment["goal_type"])}
            options={Object.entries(t.learner.goals).map(([value, label]) => ({ value, label }))}
          />
        </Field>
      </div>

      <Field label={t.courses.goal}>
        <Textarea rows={2} value={goal} onChange={(e) => setGoal(e.target.value)} maxLength={500} />
      </Field>

      {goalType === "exam" ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t.learner.examName}>
            <TextInput value={examName} onChange={(e) => setExamName(e.target.value)} maxLength={120} />
          </Field>
          <Field label={t.learner.examDate}>
            <TextInput type="date" value={examDate} onChange={(e) => setExamDate(e.target.value)} />
          </Field>
          <Field label={t.learner.targetScore}>
            <TextInput
              type="number"
              min="0"
              max={fullScore || undefined}
              step="any"
              value={targetScore}
              onChange={(e) => setTargetScore(e.target.value)}
            />
          </Field>
          <Field label={t.learner.fullScore}>
            <TextInput
              type="number"
              min="1"
              step="any"
              value={fullScore}
              onChange={(e) => setFullScore(e.target.value)}
              required
            />
          </Field>
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t.learner.selfLevel}>
          <Select
            value={selfLevel}
            onValueChange={(val) => setSelfLevel(val as CourseEnrollment["self_level"])}
            options={Object.entries(t.learner.selfLevels).map(([value, label]) => ({ value, label }))}
          />
        </Field>
        <Field label={t.learner.sessionMinutes}>
          <TextInput
            type="number"
            min="5"
            max="1440"
            value={sessionMinutes}
            onChange={(e) => setSessionMinutes(e.target.value)}
            required
          />
        </Field>
      </div>

      <div className="grid gap-1.5">
        <span className="text-ui font-medium text-fg-primary">{t.learner.weeklyDays}</span>
        <div className="flex flex-wrap gap-2">
          {WEEKDAYS.map((day) => (
            <Chip
              key={day}
              selected={weeklyDays.includes(day)}
              onClick={() => toggleDay(day)}
            >
              {t.learner.weekdays[day - 1]}
            </Chip>
          ))}
        </div>
      </div>

      <Field label={t.learner.teacherHints}>
        <Textarea rows={2} value={teacherHints} onChange={(e) => setTeacherHints(e.target.value)} maxLength={2000} />
      </Field>

      {savedNotice ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-ok/30 bg-ok-soft px-3.5 py-2.5 text-ui text-ok-text">
          <span>{t.courseHub.settingsSavedHint}</span>
          <Button variant="secondary" size="sm" pending={rebuilding} onClick={onReplan}>
            {t.courseHub.replanNow}
          </Button>
        </div>
      ) : null}

      {save.isError ? <Problem error={save.error} /> : null}

      <div className="flex justify-end gap-2 pt-2">
        <Button variant="secondary" onClick={onClose}>
          {t.common.cancel}
        </Button>
        <Button type="submit" variant="primary" pending={save.isPending}>
          {t.learner.saveCourse}
        </Button>
      </div>
    </form>
  );
}
