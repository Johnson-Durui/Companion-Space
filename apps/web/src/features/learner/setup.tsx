import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Loading, Problem } from "../../app/ui";
import t from "../../locales/zh-CN.json";
import {
  getEnrollment, getLearnerProfile, learnerKeys, saveEnrollment, saveLearnerProfile,
  type CourseEnrollment, type LearnerProfile,
} from "./api";
import "./setup.css";

const weekdays = [1, 2, 3, 4, 5, 6, 7] as const;

function list(value: FormDataEntryValue | null) {
  return String(value ?? "").split(/[，,]/).map((part) => part.trim()).filter(Boolean);
}

function ProfileForm({ profile }: { profile: LearnerProfile }) {
  const queries = useQueryClient();
  const save = useMutation({
    mutationFn: saveLearnerProfile,
    onSuccess: (result) => queries.setQueryData(learnerKeys.profile, result),
  });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    save.mutate({
      nickname: String(data.get("nickname")),
      level: String(data.get("level")) as LearnerProfile["level"],
      pace: String(data.get("pace")) as LearnerProfile["pace"],
      encouragement: String(data.get("encouragement")) as LearnerProfile["encouragement"],
      preferred_style_id: String(data.get("preferred_style_id")) as LearnerProfile["preferred_style_id"],
      interests: list(data.get("interests")),
      approach_order: profile.approach_order,
    });
  }
  return (
    <form className="fields" onSubmit={submit}>
      <h3>{t.learner.profileHeading}</h3>
      <p className="hint">{t.learner.profileHint}</p>
      <label>{t.learner.nickname}<input name="nickname" defaultValue={profile.nickname} maxLength={80} /></label>
      <div className="field-row">
        <label>{t.learner.level}<select name="level" defaultValue={profile.level}>{Object.entries(t.learner.levels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label>{t.learner.style}<select name="preferred_style_id" defaultValue={profile.preferred_style_id}>{Object.entries(t.learner.styles).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      </div>
      <div className="field-row">
        <label>{t.learner.pace}<select name="pace" defaultValue={profile.pace}>{Object.entries(t.learner.paces).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label>{t.learner.encouragement}<select name="encouragement" defaultValue={profile.encouragement}>{Object.entries(t.learner.encouragements).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      </div>
      <label>{t.learner.interests}<input name="interests" defaultValue={(profile.interests ?? []).join("，")} placeholder={t.learner.interestsPlaceholder} /></label>
      <div className="actions">
        <button className="button quiet" disabled={save.isPending}>{save.isPending ? t.common.saving : t.learner.saveProfile}</button>
        {save.isSuccess ? <p className="form-success" role="status">{t.common.saved}</p> : null}
      </div>
      {save.isError ? <Problem error={save.error} /> : null}
    </form>
  );
}

function EnrollmentForm({ courseId, enrollment }: { courseId: string; enrollment: CourseEnrollment }) {
  const queries = useQueryClient();
  const [goalType, setGoalType] = useState(enrollment.goal_type);
  const [fullScore, setFullScore] = useState(String(enrollment.full_score ?? 100));
  const save = useMutation({
    mutationFn: (body: Parameters<typeof saveEnrollment>[1]) => saveEnrollment(courseId, body),
    onSuccess: (result) => queries.setQueryData(learnerKeys.enrollment(courseId), result),
  });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const examName = data.get("exam_name");
    const examDate = data.get("exam_date");
    const targetScore = data.get("target_score");
    save.mutate({
      goal_type: String(data.get("goal_type")) as CourseEnrollment["goal_type"],
      exam_name: examName === null ? (enrollment.exam_name ?? "") : String(examName),
      exam_date: examDate === null ? (enrollment.exam_date ?? null) : String(examDate) || null,
      target_score: targetScore === null ? (enrollment.target_score ?? null) : targetScore === "" ? null : Number(targetScore),
      full_score: goalType === "exam" ? Number(data.get("full_score")) : enrollment.full_score,
      weekly_days: data.getAll("weekly_days").map(Number),
      session_minutes: Number(data.get("session_minutes")),
      self_level: String(data.get("self_level")) as CourseEnrollment["self_level"],
      hard_units: enrollment.hard_units,
      teacher_hints: String(data.get("teacher_hints")),
    });
  }
  return (
    <form className="fields" onSubmit={submit}>
      <h3>{t.learner.courseHeading}</h3>
      <p className="hint">{t.learner.courseHint}</p>
      <div className="field-row">
        <label>{t.learner.goalType}<select name="goal_type" value={goalType} onChange={(event) => setGoalType(event.target.value as CourseEnrollment["goal_type"])}>{Object.entries(t.learner.goals).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label>{t.learner.selfLevel}<select name="self_level" defaultValue={enrollment.self_level}>{Object.entries(t.learner.selfLevels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      </div>
      {goalType === "exam" ? <>
        <label>{t.learner.examName}<input name="exam_name" defaultValue={enrollment.exam_name} maxLength={120} /></label>
        <div className="field-row"><label>{t.learner.examDate}<input name="exam_date" type="date" defaultValue={enrollment.exam_date ?? ""} /></label><label>{t.learner.targetScore}<input name="target_score" type="number" min="0" max={fullScore || undefined} step="any" defaultValue={enrollment.target_score ?? ""} /></label></div>
        <label>{t.learner.fullScore}<input name="full_score" type="number" min="0.01" step="any" value={fullScore} onChange={(event) => setFullScore(event.target.value)} required /></label>
      </> : null}
      <label>{t.learner.sessionMinutes}<input name="session_minutes" type="number" min="1" max="1440" step="1" defaultValue={enrollment.session_minutes} required /></label>
      <fieldset className="weekday-options"><legend>{t.learner.weeklyDays}</legend>{weekdays.map((day) => <label key={day}><input name="weekly_days" type="checkbox" value={day} defaultChecked={(enrollment.weekly_days ?? []).includes(day)} />{t.learner.weekdays[day - 1]}</label>)}</fieldset>
      <label>{t.learner.teacherHints}<textarea name="teacher_hints" rows={3} defaultValue={enrollment.teacher_hints} maxLength={2000} /></label>
      <div className="actions">
        <button className="button primary" disabled={save.isPending}>{save.isPending ? t.common.saving : t.learner.saveCourse}</button>
        {save.isSuccess ? <p className="form-success" role="status">{t.common.saved}</p> : null}
      </div>
      {save.isError ? <Problem error={save.error} /> : null}
    </form>
  );
}

export function LearnerSetup({ courseId }: { courseId: string }) {
  const [open, setOpen] = useState(false);
  const profile = useQuery({ queryKey: learnerKeys.profile, queryFn: getLearnerProfile, enabled: open });
  const enrollment = useQuery({ queryKey: learnerKeys.enrollment(courseId), queryFn: () => getEnrollment(courseId), enabled: open });
  return (
    <details className="course-panel learner-setup" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary><span role="heading" aria-level={2}>{t.learner.heading}</span><small>{t.learner.intro}</small></summary>
      {profile.isPending || enrollment.isPending ? <Loading /> : null}
      {profile.isError ? <Problem error={profile.error} onRetry={() => void profile.refetch()} /> : null}
      {enrollment.isError ? <Problem error={enrollment.error} onRetry={() => void enrollment.refetch()} /> : null}
      {profile.data ? <ProfileForm profile={profile.data} /> : null}
      {enrollment.data ? <EnrollmentForm courseId={courseId} enrollment={enrollment.data} /> : null}
    </details>
  );
}
