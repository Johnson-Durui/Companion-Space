import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import { browserApiFetch } from "@companion-space/api-client";
import { ensureOK } from "../../app/api";
import { Loading, Problem } from "../../app/ui";
import { ChevronRight } from "../../ui/icons";
import t from "../../locales/zh-CN.json";
import "./progress.css";

type Progress = { studied_minutes: number; secured_score: number; score_scale: number; points: Array<{ id: string; name: string; probability: number; status: string }>; trend: Array<{ day: string; probability: number; evidence_count: number }> };
async function load(courseId: string) { const response = await browserApiFetch(`/api/v2/courses/${courseId}/progress`); const body = await response.json(); ensureOK(response, body); return body as Progress; }
export default function ProgressPage({ embedded = false }: { embedded?: boolean } = {}) {
  const courseId = useParams().courseId ?? ""; const query = useQuery({ queryKey: ["courses", courseId, "progress"], queryFn: () => load(courseId), enabled: Boolean(courseId) });
  if (query.isPending) return <Loading />; if (query.isError) return <Problem error={query.error} onRetry={() => void query.refetch()} />;
  return <div className="progress-page">{!embedded ? <><div className="course-breadcrumb"><Link to={`/courses/${courseId}`}>{t.progress.course}</Link><ChevronRight size={14} aria-hidden="true" /><span>{t.progress.heading}</span></div><div className="page-title"><div><h1>{t.progress.heading}</h1><p>{t.progress.lead}</p></div></div></> : null}<section className="progress-summary"><article><strong>{query.data.studied_minutes}</strong><span>{t.progress.minutes}</span></article><article><strong>{query.data.secured_score} / {query.data.score_scale || "—"}</strong><span>{t.progress.secured}</span></article><article><strong>{query.data.points.filter((point) => point.status === "mastered").length}</strong><span>{t.progress.mastered}</span></article></section><section className="course-panel"><h2>{t.progress.map}</h2><div className="mastery-map">{query.data.points.map((point) => <div key={point.id}><span>{point.name}</span><progress max="1" value={point.probability} /><small>{Math.round(point.probability * 100)}%</small></div>)}</div></section><section className="course-panel"><h2>{t.progress.trend}</h2><div className="trend-list">{query.data.trend.map((entry) => <div key={entry.day}><time>{entry.day}</time><span style={{ width: `${Math.round(entry.probability * 100)}%` }} /><small>{Math.round(entry.probability * 100)}% · {entry.evidence_count}</small></div>)}</div></section></div>;
}
