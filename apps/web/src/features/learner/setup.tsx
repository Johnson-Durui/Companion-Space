import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import { Loading, Problem } from "../../app/ui";
import t from "../../locales/zh-CN.json";
import {
  adjustPlanItem, answerInterview, answerPlacement, createPlan, finishPlacement, getEnrollment, getInterview,
  getLearnerProfile, getPlacement, getPlan, learnerKeys, saveEnrollment, saveLearnerProfile, skipInterview,
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

const topicValues = (topic: string, profile: LearnerProfile, enrollment: CourseEnrollment) => {
  if (topic === "identity") return { nickname: profile.nickname, level: profile.level };
  if (topic === "goal") return { goal_type: enrollment.goal_type, exam_name: enrollment.exam_name, exam_date: enrollment.exam_date, target_score: enrollment.target_score };
  if (topic === "schedule") return { weekly_days: enrollment.weekly_days, session_minutes: enrollment.session_minutes };
  if (topic === "starting_point") return { self_level: enrollment.self_level };
  if (topic === "hard_parts") return { hard_units: enrollment.hard_units, teacher_hints: enrollment.teacher_hints };
  return { preferred_style_id: profile.preferred_style_id, approach_order: profile.approach_order, pace: profile.pace, encouragement: profile.encouragement };
};

function LearningJourney({ courseId, profile, enrollment }: { courseId: string; profile: LearnerProfile; enrollment: CourseEnrollment }) {
  const queries = useQueryClient();
  const interview = useQuery({ queryKey: learnerKeys.interview(courseId), queryFn: () => getInterview(courseId) });
  const placement = useQuery({ queryKey: learnerKeys.placement(courseId), queryFn: () => getPlacement(courseId), enabled: interview.data?.status === "done" || interview.data?.status === "skipped" });
  const plan = useQuery({ queryKey: learnerKeys.plan(courseId), queryFn: () => getPlan(courseId) });
  const [answer, setAnswer] = useState<string | string[]>("");
  const [interviewText, setInterviewText] = useState("");
  const interviewStep = useMutation({
    mutationFn: (useSaved: boolean) => answerInterview(
      courseId, interview.data!.current!,
      useSaved ? topicValues(interview.data!.current!, profile, enrollment) : {},
      useSaved ? "" : interviewText,
    ),
    onSuccess: (result) => { if (!result.fallback_to_chips) setInterviewText(""); queries.setQueryData(learnerKeys.interview(courseId), result); },
  });
  const skip = useMutation({ mutationFn: () => skipInterview(courseId), onSuccess: (result) => queries.setQueryData(learnerKeys.interview(courseId), result) });
  const submitAnswer = useMutation({
    mutationFn: (dontKnow: boolean) => answerPlacement(courseId, { item_id: placement.data!.question!.item_id, answer: dontKnow ? undefined : answer, dont_know: dontKnow }),
    onSuccess: (result) => { setAnswer(""); queries.setQueryData(learnerKeys.placement(courseId), result); },
  });
  const finish = useMutation({ mutationFn: () => finishPlacement(courseId), onSuccess: (result) => queries.setQueryData(learnerKeys.placement(courseId), result) });
  const generate = useMutation({ mutationFn: () => createPlan(courseId), onSuccess: (result) => queries.setQueryData(learnerKeys.plan(courseId), result) });
  const adjust = useMutation({
    mutationFn: ({ itemId, action }: { itemId: string; action: "first" | "later" | "unpin" }) => adjustPlanItem(
      itemId, action === "unpin" ? { pinned: false } : { direction: action },
    ),
    onSuccess: (result) => queries.setQueryData(learnerKeys.plan(courseId), result),
  });
  const question = placement.data?.question;
  const options = question ? (Array.isArray(question.options) ? question.options : Object.entries(question.options).map(([key, text]) => ({ key, text }))) : [];
  const speakQuestion = () => {
    if (!interview.data?.question || !("speechSynthesis" in window)) return;
    const utterance = new SpeechSynthesisUtterance(interview.data.question);
    utterance.lang = "zh-CN";
    utterance.rate = interview.data.tutor?.voice.rate ?? 1;
    utterance.pitch = 1 + (interview.data.tutor?.voice.pitch ?? 0) / 100;
    const preferred = window.speechSynthesis.getVoices().find((voice) => voice.name === interview.data?.tutor?.voice.voice_id);
    if (preferred) utterance.voice = preferred;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  };
  return (
    <section className="learner-journey">
      <h3>{t.learner.journeyHeading}</h3>
      {interview.isPending ? <Loading /> : null}
      {interview.data?.current ? <div className="journey-step"><strong>{interview.data.question ?? t.learner.interviewTopics[interview.data.current as keyof typeof t.learner.interviewTopics]}</strong>{interview.data.question ? <button className="button quiet" onClick={speakQuestion}>{t.learner.readQuestion}</button> : null}<label>{t.learner.freeAnswer}<textarea rows={2} value={interviewText} onChange={(event) => setInterviewText(event.target.value)} /></label>{interview.data.fallback_to_chips ? <p className="hint">{t.learner.interviewFallback}</p> : null}<p className="hint">{t.learner.interviewSavedValues}</p><div className="actions"><button className="button primary" disabled={!interviewText.trim() || interviewStep.isPending} onClick={() => interviewStep.mutate(false)}>{t.learner.interviewNext}</button><button className="button quiet" disabled={interviewStep.isPending} onClick={() => interviewStep.mutate(true)}>{t.learner.useSavedValues}</button><button className="button quiet" disabled={skip.isPending} onClick={() => skip.mutate()}>{t.learner.interviewSkip}</button></div></div> : null}
      {question ? <div className="journey-step"><strong>{t.learner.placementHeading}</strong><p>{question.stem}</p>{question.type === "numeric" ? <input aria-label={t.learner.answer} type="number" value={answer} onChange={(event) => setAnswer(event.target.value)} /> : <div className="diagnostic-options">{options.map((option) => <label key={option.key}><input type={question.type === "multi" ? "checkbox" : "radio"} name="diagnostic-answer" value={option.key} checked={Array.isArray(answer) ? answer.includes(option.key) : answer === option.key} onChange={(event) => setAnswer((current) => question.type === "multi" ? (event.target.checked ? [...(Array.isArray(current) ? current : []), option.key] : (Array.isArray(current) ? current.filter((key) => key !== option.key) : [])) : option.key)} />{option.text}</label>)}</div>}<div className="actions"><button className="button primary" disabled={!answer.length || submitAnswer.isPending} onClick={() => submitAnswer.mutate(false)}>{t.learner.submitAnswer}</button><button className="button quiet" disabled={submitAnswer.isPending} onClick={() => submitAnswer.mutate(true)}>{t.learner.dontKnow}</button><button className="button quiet" disabled={finish.isPending} onClick={() => finish.mutate()}>{t.learner.enough}</button></div></div> : null}
      {placement.data?.status === "unavailable" ? <div className="journey-step"><strong>{t.learner.placementHeading}</strong><p className="hint">{placement.data.unavailable_reason === "materials_not_ready" ? t.learner.placementWaitMaterials : t.learner.placementNoQuestions}</p></div> : null}
      {placement.data?.mastery.length ? <div className="starting-map"><strong>{t.learner.startingMap}</strong>{placement.data.mastery.map((point) => <div key={point.kp_id}><span>{point.name}{point.inferred ? ` · ${t.learner.inferred}` : ""}</span><progress max="1" value={point.probability}>{Math.round(point.probability * 100)}%</progress><small>{Math.round(point.probability * 100)}%</small></div>)}</div> : null}
      {placement.data?.summary ? <p className="hint">{t.learner.placementSummary.replace("{strongest}", placement.data.summary.strongest_name).replace("{priority}", placement.data.summary.priority_name).replace("{inferred}", String(placement.data.summary.inferred_count))}</p> : null}
      {(placement.data?.status === "done" || placement.data?.status === "skipped" || (placement.data?.status === "unavailable" && placement.data.unavailable_reason === "no_questions")) ? <button className="button primary" disabled={generate.isPending} onClick={() => generate.mutate()}>{plan.data?.items.length ? t.learner.rebuildPlan : t.learner.buildPlan}</button> : null}
      {plan.data?.params?.hints_mapping === "unavailable" ? <p className="hint" role="status">{t.learner.hintsMappingUnavailable}</p> : null}
      {plan.data?.items.length ? <><p className="hint">{t.learner.planProgress.replace("{done}", String(plan.data.items.filter((item) => item.status === "done" || item.status === "skipped").length)).replace("{total}", String(plan.data.items.length))}</p><ol className="plan-timeline">{plan.data.items.map((item) => <li key={item.id}><span>{item.scheduled_date ?? t.learner.unscheduled}{item.pinned ? ` · ${t.learner.pinned}` : ""}</span><strong>{item.title}</strong><small>{item.est_minutes} {t.learner.minutes} · {(item.kind === "lesson" || item.kind === "practice") ? t.learner.planKinds[item.kind] : t.learner.planKinds.practiceExam}</small>{item.kind === "practice" || item.kind === "mock" ? <Link className="button quiet" to={`/plan-items/${item.id}/practice`}>{t.practice.open}</Link> : null}{item.why.length ? <p>{t.learner.why.replace("{weight}", String(Math.round(item.why[0].weight * 100))).replace("{mastery}", String(Math.round(item.why[0].mastery * 100)))}</p> : null}{item.status === "todo" ? <div className="actions">{item.kind === "lesson" ? <Link className="button primary" to={`/courses/${courseId}/review?plan=${item.id}`}>{t.learner.startLesson}</Link> : null}<button className="button quiet" disabled={adjust.isPending} onClick={() => adjust.mutate({ itemId: item.id, action: item.pinned ? "unpin" : "first" })}>{item.pinned ? t.learner.unpin : t.learner.pinFirst}</button><button className="button quiet" disabled={adjust.isPending} onClick={() => adjust.mutate({ itemId: item.id, action: "later" })}>{t.learner.moveLater}</button></div> : null}</li>)}</ol></> : null}
      {interview.isError || placement.isError || plan.isError || interviewStep.isError || submitAnswer.isError || generate.isError ? <Problem error={interview.error ?? placement.error ?? plan.error ?? interviewStep.error ?? submitAnswer.error ?? generate.error} /> : null}
    </section>
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
      {profile.data && enrollment.data ? <LearningJourney courseId={courseId} profile={profile.data} enrollment={enrollment.data} /> : null}
    </details>
  );
}
