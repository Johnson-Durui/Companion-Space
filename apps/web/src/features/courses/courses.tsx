import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router";
import { Loading, Problem } from "../../app/ui";
import t from "../../locales/zh-CN.json";
import { courseKeys, createCourse, listCourseDashboard, listCourses } from "./api";

export default function Courses() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const courses = useQuery({ queryKey: courseKeys.all, queryFn: listCourses });
  const dashboard = useQuery({ queryKey: [...courseKeys.all, "dashboard"], queryFn: listCourseDashboard });
  const summaries = new Map(dashboard.data?.map((summary) => [summary.course_id, summary]));
  const [creating, setCreating] = useState(false);
  const create = useMutation({
    mutationFn: createCourse,
    onSuccess: (course) => {
      void queryClient.invalidateQueries({ queryKey: courseKeys.all });
      navigate(`/courses/${course.id}`);
    },
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    create.mutate({ name: String(data.get("name") ?? "").trim(), goal: String(data.get("goal") ?? "").trim() || undefined });
  }

  return (
    <div className="courses-page">
      <div className="page-title title-actions">
        <div><h1>{t.courses.heading}</h1><p>{t.courses.lead}</p></div>
        <button className="button primary" onClick={() => setCreating((value) => !value)}>{t.courses.new}</button>
      </div>
      {creating ? (
        <form className="course-create fields" onSubmit={submit}>
          <label>{t.courses.name}<input name="name" maxLength={120} autoComplete="off" required /></label>
          <label>{t.courses.goal}<textarea name="goal" rows={2} maxLength={500} autoComplete="off" /></label>
          <div className="actions">
            <button className="button primary" disabled={create.isPending} aria-busy={create.isPending || undefined}>{create.isPending ? t.common.saving : t.courses.create}</button>
            <button className="button quiet" type="button" onClick={() => setCreating(false)}>{t.common.cancel}</button>
          </div>
          {create.isError ? <Problem error={create.error} /> : null}
        </form>
      ) : null}
      {courses.isPending ? <Loading /> : null}
      {courses.isError ? <Problem error={courses.error} onRetry={() => void courses.refetch()} /> : null}
      {dashboard.isError ? <Problem error={dashboard.error} onRetry={() => void dashboard.refetch()} /> : null}
      {courses.data?.length === 0 ? (
        <section className="course-empty">
          <span aria-hidden="true">＋</span><h2>{t.courses.empty}</h2><p>{t.courses.emptyHint}</p>
          <button className="button primary" onClick={() => setCreating(true)}>{t.courses.new}</button>
        </section>
      ) : null}
      {courses.data?.length ? (
        <ul className="course-list">
          {courses.data.map((course) => {
            const summary = summaries.get(course.id);
            const lesson = summary?.today_lesson;
            return (
            <li key={course.id}>
              <Link className="course-main" to={`/courses/${course.id}`}>
                <div><h2>{course.name}</h2><p>{course.goal || t.courses.goalEmpty}</p></div>
                <dl>
                  <div><dt>{t.courses.kps}</dt><dd>{course.brief?.knowledge_point_count ?? "—"}</dd></div>
                  <div><dt>{t.courses.questions}</dt><dd>{course.brief?.item_count ?? "—"}</dd></div>
                  <div><dt>{t.courses.pages}</dt><dd>{course.brief?.page_count ?? "—"}</dd></div>
                </dl>
                <span className="course-open">{t.courses.open}<span aria-hidden="true"> →</span></span>
              </Link>
              {summary ? <aside className="course-today" aria-label={t.courses.today}>
                <div>
                  <strong>{lesson ? t.courses.today : summary.has_plan ? t.courses.todayClear : t.courses.noPlan}</strong>
                  {lesson ? <span>{lesson.title} · {lesson.est_minutes} {t.courses.minutes}</span> : null}
                  <small>{t.courses.dueReviews.replace("{count}", String(summary.due_review_count))}</small>
                  {summary.remaining_days !== null || summary.secured_score !== null ? <small>
                    {summary.remaining_days !== null ? t.courses.remainingDays.replace("{count}", String(summary.remaining_days)) : ""}
                    {summary.remaining_days !== null && summary.secured_score !== null ? " · " : ""}
                    {summary.secured_score !== null && summary.score_scale !== null
                      ? t.courses.securedScore.replace("{score}", String(summary.secured_score)).replace("{scale}", String(summary.score_scale))
                      : ""}
                  </small> : null}
                </div>
                <div className="actions">
                  {lesson?.status === "active" && lesson.lesson_id
                    ? <Link className="button primary" to={`/lessons/${lesson.lesson_id}`}>{t.courses.continueLesson}</Link>
                    : lesson ? <Link className="button primary" to={`/courses/${course.id}/review?plan=${lesson.id}`}>{t.courses.warmup}</Link> : null}
                  {summary.due_review_count > 0 ? <Link className="button quiet" to={`/courses/${course.id}/review`}>{t.courses.reviewDue}</Link> : null}
                </div>
              </aside> : null}
            </li>
          );})}
        </ul>
      ) : null}
    </div>
  );
}
