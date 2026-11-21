import { useEffect, useRef, useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import { browserApiFetch } from "@companion-space/api-client";
import { ensureOK, publicMessage } from "../../app/api";
import { Problem } from "../../app/ui";
import t from "../../locales/zh-CN.json";
import "./practice.css";

type Item = { id: string; type: string; stem: string; options?: Record<string, string> | Array<{ key: string; text: string }> };
type Move = "SHOW_SOLUTION" | "REEXPLAIN" | "CHECK";
type Debrief = { item_id: string; verdict: string; score: number; max_score: number; answer: unknown; solution: string; moves: Move[] };
type Commentary = { available: boolean; commentary: string | null; code?: string | null; reason: string | null; browser_voice?: { lang?: string; voice_id?: string; rate?: number; pitch?: number } };
type Run = { id: string; space_id: string; kind: "practice" | "mock"; status: string; deadline_at: string; score?: number; max_score?: number; items: Item[]; debrief?: Debrief[] };
async function request<T>(path: string, init?: RequestInit) { const response = await browserApiFetch(path, { ...init, headers: { "Content-Type": "application/json", ...init?.headers } }); const body = await response.json(); ensureOK(response, body); return body as T; }
function options(item: Item) { return !item.options ? [] : Array.isArray(item.options) ? item.options : Object.entries(item.options).map(([key, text]) => ({ key, text })); }
function speak(text: string, voice?: Commentary["browser_voice"]) {
  if (!("speechSynthesis" in window) || typeof SpeechSynthesisUtterance === "undefined") return;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = voice?.lang ?? "zh-CN";
  utterance.rate = voice?.rate ?? 1;
  utterance.pitch = voice?.pitch === undefined ? 1 : Math.max(0, Math.min(2, 1 + voice.pitch / 100));
  utterance.voice = window.speechSynthesis.getVoices().find((candidate) => candidate.name === voice?.voice_id) ?? null;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utterance);
}

export default function Practice() {
  const itemId = useParams().itemId ?? "";
  const autoSubmitted = useRef(false);
  const [run, setRun] = useState<Run>(); const [answers, setAnswers] = useState<Record<string, string | string[]>>({}); const [seconds, setSeconds] = useState(-1);
  const [saveErrors, setSaveErrors] = useState<Record<string, unknown>>({});
  const [commentary, setCommentary] = useState<Record<string, Commentary>>({});
  const [commentaryError, setCommentaryError] = useState<Record<string, string>>({});
  const start = useMutation({ mutationFn: () => request<Run>(`/api/v2/plan-items/${itemId}/practice`, { method: "POST", body: "{}" }), onSuccess: setRun });
  const submit = useMutation({ mutationFn: async () => { if (!run) throw new Error(t.common.error); if (seconds !== 0) await Promise.all(Object.entries(answers).map(([item_id, answer]) => persist(item_id, answer))); return request<Run>(`/api/v2/practice/${run.id}/submit`, { method: "POST", body: "{}" }); }, onSuccess: setRun });
  useEffect(() => { if (!run || run.status !== "active") return; const tick = () => setSeconds(Math.max(0, Math.ceil((Date.parse(run.deadline_at) - Date.now()) / 1000))); tick(); const timer = window.setInterval(tick, 1000); return () => window.clearInterval(timer); }, [run]);
  useEffect(() => { if (run?.status === "active" && seconds === 0 && !autoSubmitted.current) { autoSubmitted.current = true; submit.mutate(); } }, [run?.status, seconds, submit]);
  function persist(item_id: string, answer: string | string[]) { if (!run) return Promise.resolve(); return request(`/api/v2/practice/${run.id}/answer`, { method: "PUT", body: JSON.stringify({ item_id, answer }) }); }
  async function saveAnswer(item_id: string, next: string | string[]) {
    setSaveErrors((current) => {
      if (!(item_id in current)) return current;
      const copy = { ...current };
      delete copy[item_id];
      return copy;
    });
    try {
      await persist(item_id, next);
    } catch (cause) {
      setSaveErrors((current) => ({ ...current, [item_id]: cause }));
    }
  }
  function select(item: Item, value: string, checked = true) { const saved = answers[item.id]; const values: string[] = Array.isArray(saved) ? saved : []; const next = item.type === "multi" ? (checked ? [...values, value] : values.filter((entry) => entry !== value)) : value; setAnswers((current) => ({ ...current, [item.id]: next })); void saveAnswer(item.id, next); }
  function finish(event: FormEvent) { event.preventDefault(); submit.mutate(); }
  const explain = useMutation({
    mutationFn: ({ itemId, move }: { itemId: string; move: Move }) => request<Commentary>(`/api/v2/practice/${run?.id}/debrief/${itemId}`, { method: "POST", body: JSON.stringify({ move }) }),
    onSuccess: (result, variables) => {
      setCommentary((current) => ({ ...current, [variables.itemId]: result }));
      setCommentaryError((current) => ({
        ...current,
        [variables.itemId]: result.available ? "" : (publicMessage({ code: result.code }) ?? t.practice.debriefUnavailable),
      }));
      if (result.commentary) speak(result.commentary, result.browser_voice);
    },
    onError: (error, variables) => setCommentaryError((current) => ({ ...current, [variables.itemId]: error instanceof Error ? error.message : t.common.error })),
  });
  if (!run) return <div className="practice-page"><h1>{t.practice.heading}</h1><p>{t.practice.ready}</p><button className="button primary" disabled={start.isPending} aria-busy={start.isPending || undefined} onClick={() => start.mutate()}>{t.practice.start}</button>{start.isError ? <Problem error={start.error} /> : null}</div>;
  if (run.status === "submitted") return <div className="practice-page"><div className="page-title"><div><h1>{t.practice.result}</h1><p>{run.score} / {run.max_score}</p></div><Link className="button quiet" to={`/courses/${run.space_id}/progress`}>{t.practice.progress}</Link></div><div className="debrief-list">{run.debrief?.map((entry, index) => <article key={entry.item_id}><span>{index + 1}. {t.practice.verdicts[entry.verdict as keyof typeof t.practice.verdicts] ?? entry.verdict} · {entry.score}/{entry.max_score}</span><p><strong>{t.practice.answer}</strong> {String(entry.answer)}</p><p>{entry.solution}</p><div className="debrief-actions">{entry.moves.map((move) => <button className="button quiet" key={move} disabled={explain.isPending && explain.variables?.itemId === entry.item_id} aria-busy={(explain.isPending && explain.variables?.itemId === entry.item_id) || undefined} onClick={() => explain.mutate({ itemId: entry.item_id, move })}>{t.practice.moves[move]}</button>)}</div>{commentary[entry.item_id]?.commentary ? <div className="notice"><strong>{t.practice.teacherCommentary}</strong><p aria-live="polite">{commentary[entry.item_id].commentary}</p><button className="button quiet" onClick={() => speak(commentary[entry.item_id].commentary ?? "", commentary[entry.item_id].browser_voice)}>{t.practice.speakAgain}</button></div> : null}{commentaryError[entry.item_id] ? <div className="notice danger" role="alert"><p>{commentaryError[entry.item_id]}</p><p>{t.practice.solutionSafe}</p></div> : null}</article>)}</div></div>;
  return <form className="practice-page" onSubmit={finish}><header className="practice-header"><div><p className="eyebrow">{run.kind === "mock" ? t.practice.mock : t.practice.practice}</p><h1>{t.practice.heading}</h1></div><strong aria-live="polite">{Math.floor(Math.max(seconds, 0) / 60)}:{String(Math.max(seconds, 0) % 60).padStart(2, "0")}</strong></header>{run.items.map((item, index) => <fieldset className="practice-question" key={item.id}><legend>{index + 1}. {item.stem}</legend>{options(item).map((option) => <label key={option.key}><input type={item.type === "multi" ? "checkbox" : "radio"} name={item.id} value={option.key} onChange={(event) => select(item, option.key, event.target.checked)} /> <strong>{option.key}</strong> {option.text}</label>)}{!options(item).length ? <input aria-label={t.practice.answer} value={String(answers[item.id] ?? "")} onChange={(event) => select(item, event.target.value)} /> : null}{saveErrors[item.id] ? <Problem error={saveErrors[item.id]} onRetry={() => void saveAnswer(item.id, answers[item.id] ?? "")} /> : null}</fieldset>)}<button className="button primary" disabled={submit.isPending} aria-busy={submit.isPending || undefined}>{t.practice.submit}</button>{submit.isError ? <Problem error={submit.error} /> : null}</form>;
}
