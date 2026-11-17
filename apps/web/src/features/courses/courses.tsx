import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router";
import { Loading, Problem } from "../../app/ui";
import t from "../../locales/zh-CN.json";
import { courseKeys, createCourse, listCourses } from "./api";

export default function Courses() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const courses = useQuery({ queryKey: courseKeys.all, queryFn: listCourses });
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
            <button className="button primary" disabled={create.isPending}>{create.isPending ? t.common.saving : t.courses.create}</button>
            <button className="button quiet" type="button" onClick={() => setCreating(false)}>{t.common.cancel}</button>
          </div>
          {create.isError ? <Problem error={create.error} /> : null}
        </form>
      ) : null}
      {courses.isPending ? <Loading /> : null}
      {courses.isError ? <Problem error={courses.error} onRetry={() => void courses.refetch()} /> : null}
      {courses.data?.length === 0 ? (
        <section className="course-empty">
          <span aria-hidden="true">＋</span><h2>{t.courses.empty}</h2><p>{t.courses.emptyHint}</p>
          <button className="button primary" onClick={() => setCreating(true)}>{t.courses.new}</button>
        </section>
      ) : null}
      {courses.data?.length ? (
        <ul className="course-list">
          {courses.data.map((course) => (
            <li key={course.id}>
              <Link to={`/courses/${course.id}`}>
                <div><h2>{course.name}</h2><p>{course.goal || t.courses.goalEmpty}</p></div>
                <dl>
                  <div><dt>{t.courses.kps}</dt><dd>{course.brief?.knowledge_point_count ?? "—"}</dd></div>
                  <div><dt>{t.courses.questions}</dt><dd>{course.brief?.item_count ?? "—"}</dd></div>
                  <div><dt>{t.courses.pages}</dt><dd>{course.brief?.page_count ?? "—"}</dd></div>
                </dl>
                <span className="course-open">{t.courses.open}<span aria-hidden="true"> →</span></span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
