import { useEffect, useMemo, useState, type DragEvent, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router";
import { api, bodyOf, publicMessage } from "../../app/api";
import { Loading, Problem } from "../../app/ui";
import t from "../../locales/zh-CN.json";
import {
  courseKeys, getAnalysis, getCourse, getCourseMap, getMaterialPage, listExamItems, listMaterials,
  listUnmappedExamItems, materialPageImage, pasteMaterial, retryAnalysis, startAnalysis, updateKnowledgePoint, updateMaterial, uploadMaterials,
} from "./api";
import { inferMaterial } from "./materials";
import type { AnalysisStart, ExamItem, Job, KnowledgePoint, Material, MaterialRole } from "./types";
import { LearnerSetup } from "../learner/setup";

const roles = Object.keys(t.courses.roles) as MaterialRole[];
const stages = ["parse", "structure", "index", "kp_extract", "kp_reduce", "exam_extract", "item_verify", "exam_stats", "diag_pool", "brief"];
type PendingFile = { file: File; role: MaterialRole; year?: number; exam_name?: string; has_answers?: boolean };

function warningText(value: string) {
  return t.courses.warnings[value as keyof typeof t.courses.warnings] ?? value;
}

function statusText(status: Material["parse_status"]) {
  return t.courses.materialStatus[status];
}

function UploadPanel({ courseId }: { courseId: string }) {
  const queries = useQueryClient();
  const [pending, setPending] = useState<PendingFile[]>([]);
  const upload = useMutation({
    mutationFn: () => uploadMaterials(courseId, pending.map((entry) => entry.file), pending.map((entry) => ({
      role: entry.role, year: entry.year, exam_name: entry.exam_name, has_answers: entry.has_answers,
    }))),
    onSuccess: () => {
      setPending([]);
      void queries.invalidateQueries({ queryKey: courseKeys.materials(courseId) });
    },
  });
  const paste = useMutation({
    mutationFn: (body: { title: string; content: string; role: MaterialRole }) => pasteMaterial(courseId, body),
    onSuccess: () => void queries.invalidateQueries({ queryKey: courseKeys.materials(courseId) }),
  });
  function append(files: FileList | File[]) {
    const additions = Array.from(files).map((file) => ({ file, ...inferMaterial(file.name) }));
    setPending((current) => [...current, ...additions]);
  }
  function drop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    append(event.dataTransfer.files);
  }
  function submitPaste(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    paste.mutate({ title: String(data.get("title")), content: String(data.get("content")), role: String(data.get("role")) as MaterialRole }, { onSuccess: () => form.reset() });
  }
  return (
    <section className="course-panel" aria-labelledby="upload-title">
      <div className="section-heading"><div><p className="eyebrow">{t.courses.sources}</p><h2 id="upload-title">{t.courses.importHeading}</h2></div></div>
      <div className="drop-zone" onDragOver={(event) => event.preventDefault()} onDrop={drop}>
        <strong>{t.courses.drop}</strong><p>{t.courses.formats}</p>
        <label className="button quiet">{t.courses.choose}<input type="file" multiple accept=".pdf,.pptx,.docx,.md,.txt,.png,.jpg,.jpeg,.webp" onChange={(event) => event.target.files && append(event.target.files)} /></label>
      </div>
      {pending.length ? (
        <div className="pending-files">
          {pending.map((entry, index) => (
            <div className="pending-file" key={`${entry.file.name}:${entry.file.lastModified}:${index}`}>
              <div><strong>{entry.file.name}</strong><small>{(entry.file.size / 1024 / 1024).toFixed(1)} MB</small></div>
              <label>{t.courses.role}<select name={`role-${index}`} value={entry.role} onChange={(event) => setPending((items) => items.map((item, itemIndex) => itemIndex === index ? { ...item, role: event.target.value as MaterialRole } : item))}>{roles.map((role) => <option key={role} value={role}>{t.courses.roles[role]}</option>)}</select></label>
              {entry.role === "exam" ? <div className="exam-metadata"><label>{t.courses.year}<input name={`year-${index}`} type="number" min="1900" max="2100" value={entry.year ?? ""} onChange={(event) => setPending((items) => items.map((item, itemIndex) => itemIndex === index ? { ...item, year: event.target.value ? Number(event.target.value) : undefined } : item))} /></label><label>{t.courses.examName}<input name={`exam-name-${index}`} autoComplete="off" value={entry.exam_name ?? ""} onChange={(event) => setPending((items) => items.map((item, itemIndex) => itemIndex === index ? { ...item, exam_name: event.target.value || undefined } : item))} /></label><label className="check-field"><input name={`has-answers-${index}`} type="checkbox" checked={entry.has_answers ?? false} onChange={(event) => setPending((items) => items.map((item, itemIndex) => itemIndex === index ? { ...item, has_answers: event.target.checked } : item))} />{t.courses.hasAnswers}</label></div> : null}
              <button className="button quiet" type="button" onClick={() => setPending((items) => items.filter((_, itemIndex) => itemIndex !== index))}>{t.common.remove}</button>
            </div>
          ))}
          <button className="button primary" disabled={upload.isPending} onClick={() => upload.mutate()}>{upload.isPending ? t.courses.uploading : t.courses.upload}</button>
        </div>
      ) : null}
      <details className="paste-material">
        <summary>{t.courses.paste}</summary>
        <form className="fields" onSubmit={submitPaste}>
          <label>{t.courses.pasteTitle}<input name="title" maxLength={120} autoComplete="off" required /></label>
          <label>{t.courses.role}<select name="role" defaultValue="notes">{roles.map((role) => <option key={role} value={role}>{t.courses.roles[role]}</option>)}</select></label>
          <label>{t.courses.pasteContent}<textarea name="content" rows={8} required /></label>
          <button className="button primary" disabled={paste.isPending}>{paste.isPending ? t.common.saving : t.courses.addPaste}</button>
          {paste.isError ? <Problem error={paste.error} /> : null}
        </form>
      </details>
      {upload.isError ? <Problem error={upload.error} /> : null}
    </section>
  );
}

function Materials({ courseId }: { courseId: string }) {
  const queries = useQueryClient();
  const materials = useQuery({ queryKey: courseKeys.materials(courseId), queryFn: () => listMaterials(courseId) });
  const revise = useMutation({
    mutationFn: ({ materialId, body }: { materialId: string; body: Partial<Pick<Material, "role" | "year" | "exam_name" | "has_answers">> }) => updateMaterial(courseId, materialId, body),
    onSuccess: () => void queries.invalidateQueries({ queryKey: courseKeys.materials(courseId) }),
  });
  if (materials.isPending) return <Loading />;
  if (materials.isError) return <Problem error={materials.error} onRetry={() => void materials.refetch()} />;
  if (!materials.data.length) return <p className="hint">{t.courses.noMaterials}</p>;
  return (
    <div className="material-list">
      {materials.data.map((material) => (
        <article key={material.id} data-state={material.parse_status}>
          <div className="material-main"><strong>{material.title || material.filename}</strong><small>{material.page_count ? `${material.page_count} ${t.courses.pageUnit}` : material.filename}</small></div>
          <label>{t.courses.role}<select name={`role-${material.id}`} value={material.role} disabled={revise.isPending} onChange={(event) => revise.mutate({ materialId: material.id, body: { role: event.target.value as MaterialRole } })}>{roles.map((role) => <option key={role} value={role}>{t.courses.roles[role]}</option>)}</select></label>
          <span className="status-label">{statusText(material.parse_status)}</span>
          {material.role === "exam" ? <div className="material-exam-meta"><label>{t.courses.year}<input name={`year-${material.id}`} type="number" min="1900" max="2100" defaultValue={material.year ?? ""} onBlur={(event) => revise.mutate({ materialId: material.id, body: { year: event.target.value ? Number(event.target.value) : null } })} /></label><label>{t.courses.examName}<input name={`exam-name-${material.id}`} autoComplete="off" defaultValue={material.exam_name ?? ""} onBlur={(event) => revise.mutate({ materialId: material.id, body: { exam_name: event.target.value || null } })} /></label><label className="check-field"><input name={`has-answers-${material.id}`} type="checkbox" defaultChecked={material.has_answers ?? false} onChange={(event) => revise.mutate({ materialId: material.id, body: { has_answers: event.target.checked } })} />{t.courses.hasAnswers}</label></div> : null}
          {material.scanned_pages ? <p className="material-warning">{t.courses.scanned.replace("{count}", String(material.scanned_pages))}</p> : null}
          {material.error ? <p role="alert" className="material-error">{material.error}</p> : null}
        </article>
      ))}
    </div>
  );
}

function useAnalysisEvents(courseId: string, job: Job | null | undefined) {
  const queries = useQueryClient();
  const jobId = job?.id;
  const terminal = job?.status === "completed" || job?.status === "failed";
  useEffect(() => {
    if (!jobId || terminal) return;
    const source = new EventSource(`/api/v2/courses/${courseId}/analysis/events`);
    source.addEventListener("job", (event) => {
      const next = JSON.parse((event as MessageEvent<string>).data) as Job;
      queries.setQueryData(courseKeys.analysis(courseId), next);
      if (next.status === "completed" || next.status === "failed") {
        source.close();
        void queries.invalidateQueries({ queryKey: courseKeys.map(courseId) });
        void queries.invalidateQueries({ queryKey: courseKeys.materials(courseId) });
      }
    });
    source.onerror = () => void queries.invalidateQueries({ queryKey: courseKeys.analysis(courseId) });
    return () => source.close();
  }, [courseId, jobId, queries, terminal]);
}

function AnalysisPanel({ courseId }: { courseId: string }) {
  const queries = useQueryClient();
  const [estimate, setEstimate] = useState<AnalysisStart>();
  const analysis = useQuery({ queryKey: courseKeys.analysis(courseId), queryFn: () => getAnalysis(courseId), refetchInterval: (query) => query.state.data?.status === "running" ? 3000 : false });
  const start = useMutation({
    mutationFn: (confirmed: boolean) => startAnalysis(courseId, confirmed),
    onSuccess: (result) => {
      setEstimate(result);
      if (result.job) queries.setQueryData(courseKeys.analysis(courseId), result.job);
    },
  });
  const retry = useMutation({
    mutationFn: (stage: string) => retryAnalysis(courseId, stage),
    onSuccess: (job) => queries.setQueryData(courseKeys.analysis(courseId), job),
  });
  useAnalysisEvents(courseId, analysis.data);
  const job = analysis.data;
  const currentIndex = Math.max(0, stages.indexOf(job?.stage ?? "parse"));
  return (
    <section className="course-panel" aria-labelledby="analysis-title">
      <div className="section-heading"><div><p className="eyebrow">{t.courses.analysis}</p><h2 id="analysis-title">{t.courses.analysisHeading}</h2></div>
        {!job || job.status === "completed" ? <button className="button primary" disabled={start.isPending} onClick={() => start.mutate(false)}>{start.isPending ? t.courses.estimating : job ? t.courses.refresh : t.courses.start}</button> : null}
      </div>
      {estimate?.requires_confirmation && !estimate.job ? <div className="notice"><p>{t.courses.confirmTokens.replace("{tokens}", estimate.estimated_tokens.toLocaleString())}</p><button className="button primary" onClick={() => start.mutate(true)}>{t.courses.confirmStart}</button></div> : null}
      {job ? (
        <div className="analysis-progress">
          <div className="analysis-summary"><strong>{t.courses.jobStatus[job.status]}</strong><span>{Math.round(job.progress * 100)}%</span><span>{(job.tokens_in + job.tokens_out).toLocaleString()} token</span></div>
          <progress max="1" value={job.progress}>{Math.round(job.progress * 100)}%</progress>
          <ol className="stage-rail">
            {stages.map((stage, index) => <li key={stage} data-state={index < currentIndex || job.status === "completed" ? "done" : index === currentIndex ? job.status : "waiting"}><span>{index + 1}</span>{t.courses.stages[stage as keyof typeof t.courses.stages]}</li>)}
          </ol>
          <p className="analysis-detail" role="status">{job.detail ?? (job.status === "queued" ? t.courses.queued : "")}</p>
          {job.status === "failed" ? <div className="notice danger"><p role="alert">{job.error ? publicMessage({ code: job.error }) ?? job.error : t.courses.analysisFailed}</p><button className="button quiet" disabled={retry.isPending} onClick={() => retry.mutate(job.stage || "parse")}>{t.common.retry}</button></div> : null}
        </div>
      ) : <p className="hint">{t.courses.analysisEmpty}</p>}
      {analysis.isError ? <Problem error={analysis.error} onRetry={() => void analysis.refetch()} /> : null}
      {start.isError ? <Problem error={start.error} /> : null}
    </section>
  );
}

function SourcePage({ courseId, reference }: { courseId: string; reference: { material_id: string; page_no: number } }) {
  const page = useQuery({ queryKey: courseKeys.page(reference.material_id, reference.page_no), queryFn: () => getMaterialPage(reference.material_id, reference.page_no) });
  const materials = useQuery({ queryKey: courseKeys.materials(courseId), queryFn: () => listMaterials(courseId) });
  if (page.isPending) return <Loading />;
  if (page.isError) return <Problem error={page.error} onRetry={() => void page.refetch()} />;
  const material = materials.data?.find((entry) => entry.id === reference.material_id);
  return <div className="source-page"><strong>{material?.title || material?.filename || t.courses.source} · {t.courses.page.replace("{page}", String(reference.page_no))}</strong>{page.data.has_image ? <img src={materialPageImage(reference.material_id, reference.page_no)} width="1600" height="1200" loading="lazy" alt={t.courses.sourceImage.replace("{page}", String(reference.page_no))} /> : null}<pre>{page.data.markdown}</pre><small>{t.courses.pageSource[page.data.source as keyof typeof t.courses.pageSource] ?? page.data.source} · {Math.round(page.data.quality * 100)}%</small></div>;
}

function ExamItems({ items }: { items: ExamItem[] }) {
  return <>{items.map((item) => <article key={item.id}><div><strong>{item.no}</strong><span className="answer-status">{t.courses.answerStatus[item.answer_status as keyof typeof t.courses.answerStatus] ?? item.answer_status}</span></div><p>{item.stem}</p>{Object.entries(item.options).map(([key, value]) => <p key={key}>{key}. {value}</p>)}{item.answer ? <details><summary>{t.courses.answer}</summary><p>{item.answer}</p>{item.solution ? <p>{item.solution}</p> : null}</details> : null}</article>)}</>;
}

function KnowledgePointDetail({ courseId, point, allPoints, onChanged }: { courseId: string; point: KnowledgePoint; allPoints: KnowledgePoint[]; onChanged: () => void }) {
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [source, setSource] = useState(point.source_refs[0]);
  const [examOpen, setExamOpen] = useState(false);
  const exams = useQuery({ queryKey: courseKeys.exams(courseId, point.id), queryFn: () => listExamItems(courseId, point.id), enabled: examOpen });
  const revise = useMutation({ mutationFn: (body: Parameters<typeof updateKnowledgePoint>[2]) => updateKnowledgePoint(courseId, point.id, body), onSuccess: () => { setEditing(false); onChanged(); } });
  const lesson = useMutation({
    mutationFn: async () => bodyOf(await api.POST("/api/v2/courses/{course_id}/lessons", {
      params: { path: { course_id: courseId } }, body: { kp_id: point.id },
    })),
    onSuccess: (result) => navigate(`/lessons/${result.id}`),
  });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    revise.mutate({ name: String(data.get("name")), importance: String(data.get("importance")), prerequisite_ids: data.getAll("prerequisite").map(String) });
  }
  return (
    <article className="kp-detail">
      <div className="kp-heading"><div><span className="kp-kind">{t.courses.kinds[point.kind as keyof typeof t.courses.kinds] ?? point.kind}</span><h3>{point.name}</h3></div><button className="button quiet revise-button" onClick={() => setEditing((value) => !value)}>{t.courses.revise}</button></div>
      {point.assumed ? <div className="notice"><p>{t.courses.assumed}</p></div> : null}
      <p>{point.summary}</p>
      <div className="actions">
        <button className="button primary" disabled={lesson.isPending} onClick={() => lesson.mutate()}>
          {lesson.isPending ? t.classroom.preparing : t.classroom.openLesson}
        </button>
      </div>
      {lesson.isError ? <Problem error={lesson.error} /> : null}
      {point.formula ? <pre className="formula">{point.formula}</pre> : null}
      <dl className="kp-stats">
        <div><dt>{t.courses.importance}</dt><dd>{t.courses.importanceValue[point.importance]}</dd></div>
        <div><dt>{t.courses.difficulty}</dt><dd>{"●".repeat(point.difficulty)}{"○".repeat(3 - point.difficulty)}</dd></div>
        <div><dt>{t.courses.examCount}</dt><dd>{point.stats?.n_items ?? 0}</dd></div>
        <div><dt>{t.courses.scoreShare}</dt><dd>{point.stats ? `${(point.stats.score_share * 100).toFixed(1)}%` : "—"}</dd></div>
        <div><dt>{t.courses.trend}</dt><dd>{point.stats ? (t.courses.trendValue[point.stats.trend as keyof typeof t.courses.trendValue] ?? point.stats.trend) || "—" : "—"}</dd></div>
      </dl>
      {editing ? (
        <form className="kp-edit fields" onSubmit={submit}>
          <label>{t.courses.kpName}<input name="name" defaultValue={point.name} required /></label>
          <label>{t.courses.importance}<select name="importance" defaultValue={point.importance}>{Object.entries(t.courses.importanceValue).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <fieldset><legend>{t.courses.prerequisites}</legend>{allPoints.filter((candidate) => candidate.id !== point.id).map((candidate) => <label key={candidate.id}><input type="checkbox" name="prerequisite" value={candidate.id} defaultChecked={point.prerequisite_ids.includes(candidate.id)} />{candidate.name}</label>)}</fieldset>
          <div className="actions"><button className="button primary" disabled={revise.isPending}>{t.common.save}</button><button type="button" className="button quiet" onClick={() => setEditing(false)}>{t.common.cancel}</button></div>
          <details className="danger-zone"><summary>{t.courses.moreRevisions}</summary><label>{t.courses.mergeInto}<select name="merge"><option value="">{t.courses.chooseKp}</option>{allPoints.filter((candidate) => candidate.id !== point.id).map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}</select></label><div className="actions"><button className="button quiet" type="button" onClick={(event) => { const select = event.currentTarget.closest("details")?.querySelector("select"); if (select?.value) revise.mutate({ merge_into: select.value }); }}>{t.courses.merge}</button><button className="button danger-action" type="button" onClick={() => window.confirm(t.courses.deleteConfirm) && revise.mutate({ deleted: true })}>{t.common.remove}</button></div></details>
          {revise.isError ? <Problem error={revise.error} /> : null}
        </form>
      ) : null}
      <section className="provenance"><h3>{t.courses.provenance}</h3>{point.source_refs.length ? <div className="source-tabs">{point.source_refs.map((reference) => <button className="button quiet" aria-pressed={source?.material_id === reference.material_id && source.page_no === reference.page_no} key={`${reference.material_id}:${reference.page_no}`} onClick={() => setSource(reference)}>{t.courses.page.replace("{page}", String(reference.page_no))}</button>)}</div> : <p className="hint">{t.courses.noSource}</p>}{source ? <SourcePage courseId={courseId} reference={source} /> : null}</section>
      <section className="exam-browser"><button className="button quiet" onClick={() => setExamOpen((value) => !value)}>{examOpen ? t.courses.hideQuestions : t.courses.showQuestions.replace("{count}", String(point.stats?.n_items ?? 0))}</button>{examOpen && exams.isPending ? <Loading /> : null}{exams.isError ? <Problem error={exams.error} /> : null}{exams.data ? <ExamItems items={exams.data} /> : null}</section>
    </article>
  );
}

function CourseMapView({ courseId }: { courseId: string }) {
  const map = useQuery({ queryKey: courseKeys.map(courseId), queryFn: () => getCourseMap(courseId), retry: false });
  const unmapped = useQuery({ queryKey: courseKeys.unmappedExams(courseId), queryFn: () => listUnmappedExamItems(courseId), retry: false });
  const [selectedId, setSelectedId] = useState<string>();
  const allPoints = useMemo(() => map.data?.units.flatMap((unit) => unit.knowledge_points) ?? [], [map.data]);
  const selected = allPoints.find((point) => point.id === selectedId) ?? allPoints[0];
  const showUnmapped = selectedId === "unmapped" && Boolean(unmapped.data?.length);
  if (map.isPending) return <Loading />;
  if (map.isError) return <p className="hint">{t.courses.mapPending}</p>;
  if (!allPoints.length && !unmapped.data?.length) return <p className="hint">{t.courses.mapEmpty}</p>;
  const support = map.data.brief?.summary_support;
  return (
    <section className="course-panel map-panel" aria-labelledby="map-title">
      <div className="section-heading"><div><p className="eyebrow">{t.courses.map}</p><h2 id="map-title">{t.courses.mapHeading}</h2></div><span>{allPoints.length} {t.courses.kpUnit}</span></div>
      {support && support.checked > 0 ? <p className="hint">{t.courses.summarySupport.replace("{supported}", String(support.supported)).replace("{checked}", String(support.checked))}</p> : null}
      {map.data.warnings.map((warning) => <div className="notice" key={warning}><p>{warningText(warning)}</p></div>)}
      <div className="map-layout">
        <nav className="unit-map" aria-label={t.courses.mapHeading}>{map.data.units.map((unit) => <section key={unit.id}><h3>{unit.title}</h3>{unit.knowledge_points.map((point) => <button key={point.id} aria-current={!showUnmapped && selected?.id === point.id ? "true" : undefined} onClick={() => setSelectedId(point.id)}><span data-importance={point.importance} />{point.name}<small>{point.stats?.n_items ? `${point.stats.n_items} ${t.courses.questionUnit}` : ""}</small></button>)}</section>)}{unmapped.data?.length ? <section><h3>{t.courses.unmapped}</h3><button aria-current={showUnmapped ? "true" : undefined} onClick={() => setSelectedId("unmapped")}><span />{t.courses.unmapped}<small>{unmapped.data.length} {t.courses.questionUnit}</small></button></section> : null}</nav>
        {showUnmapped ? <article className="kp-detail"><div className="kp-heading"><div><h3>{t.courses.unmapped}</h3></div></div><p>{t.courses.unmappedHint}</p><section className="exam-browser"><ExamItems items={unmapped.data ?? []} /></section></article> : selected ? <KnowledgePointDetail key={selected.id} courseId={courseId} point={selected} allPoints={allPoints} onChanged={() => void map.refetch()} /> : null}
      </div>
    </section>
  );
}

export default function CourseWorkspace() {
  const courseId = useParams().courseId ?? "";
  const course = useQuery({ queryKey: courseKeys.one(courseId), queryFn: () => getCourse(courseId), enabled: Boolean(courseId) });
  if (course.isPending) return <Loading />;
  if (course.isError) return <Problem error={course.error} onRetry={() => void course.refetch()} />;
  return (
    <div className="course-workspace">
      <div className="course-breadcrumb"><Link to="/courses">{t.courses.heading}</Link><span aria-hidden="true">/</span><span>{course.data.name}</span></div>
      <div className="page-title course-title"><div><p className="eyebrow">{t.courses.workspace}</p><h1>{course.data.name}</h1><p>{course.data.goal || t.courses.goalEmpty}</p><div className="actions"><Link className="button quiet" to={`/courses/${courseId}/review`}>{t.review.open}</Link><Link className="button quiet" to={`/courses/${courseId}/progress`}>{t.progress.open}</Link><Link className="button quiet" to={`/courses/${courseId}/history`}>{t.history.heading}</Link></div></div>{course.data.brief?.overview || course.data.brief?.summary ? <p className="course-overview">{course.data.brief.overview || course.data.brief.summary}</p> : null}</div>
      <LearnerSetup key={courseId} courseId={courseId} />
      <UploadPanel courseId={courseId} />
      <Materials courseId={courseId} />
      <AnalysisPanel courseId={courseId} />
      <CourseMapView courseId={courseId} />
    </div>
  );
}
