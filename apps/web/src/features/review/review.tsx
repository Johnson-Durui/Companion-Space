import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Navigate, useNavigate, useParams, useSearchParams } from "react-router";
import { charactersKey, fetchCharacters, fetchSettings, settingsKey } from "../../app/api";
import { Loading, Problem } from "../../app/ui";
import { Button, ChevronRight, EmptyState, TutorAvatar } from "../../ui";
import { VoicePreview } from "../onboarding/voice-preview";
import { useActiveTutor } from "../tutors/use-active-tutor";
import t from "../../locales/zh-CN.json";
import { answerCard, getMistakes, getReview, mistakesKey, rateCard, reviewKey, startPlannedLesson, type ReviewCard } from "./api";
import "./review.css";

function options(card: ReviewCard) {
  const raw = card.item?.options;
  if (!raw) return [];
  return Array.isArray(raw) ? raw : Object.entries(raw).map(([key, text]) => ({ key, text }));
}

export default function Review({ embedded = false }: { embedded?: boolean } = {}) {
  const courseId = useParams().courseId ?? "";
  const [params] = useSearchParams();
  const plan = params.get("plan");
  const navigate = useNavigate();
  const queries = useQueryClient();
  const [revealed, setRevealed] = useState(false);
  const [kpId, setKpId] = useState("");
  const [since, setSince] = useState("");
  const [archived, setArchived] = useState(false);
  const [reviewed, setReviewed] = useState(0);
  const [expired, setExpired] = useState(false);
  const limitReached = Boolean(plan && (reviewed >= 5 || expired));
  useEffect(() => {
    if (!plan) return;
    const timer = window.setTimeout(() => setExpired(true), 5 * 60_000);
    return () => window.clearTimeout(timer);
  }, [plan]);
  const queue = useQuery({ queryKey: reviewKey(courseId, plan), queryFn: () => getReview(courseId, plan), enabled: Boolean(courseId) && !limitReached });
  const mistakes = useQuery({ queryKey: mistakesKey(courseId, kpId, since, archived), queryFn: () => getMistakes(courseId, kpId, since, archived), enabled: Boolean(courseId) && !plan });
  const settings = useQuery({ queryKey: settingsKey, queryFn: fetchSettings, enabled: Boolean(plan) });
  const roster = useQuery({ queryKey: charactersKey, queryFn: fetchCharacters, enabled: Boolean(plan) });
  const { tutor: activeTutor } = useActiveTutor();
  const preferred = roster.data?.find((entry) => entry.id === settings.data?.default_character_id) ?? roster.data?.[0] ?? activeTutor;
  const start = useMutation({ mutationFn: startPlannedLesson, onSuccess: (lesson) => navigate(`/lessons/${lesson.id}`) });
  const advance = () => {
    setRevealed(false);
    setReviewed((count) => count + 1);
    void queries.invalidateQueries({ queryKey: ["courses", courseId, "review"] });
    void queries.invalidateQueries({ queryKey: ["courses", courseId, "mistakes"] });
  };
  const rate = useMutation({ mutationFn: ({ id, rating }: { id: string; rating: string }) => rateCard(id, rating), onSuccess: advance });
  const answer = useMutation({ mutationFn: ({ id, value, dontKnow }: { id: string; value: unknown; dontKnow?: boolean }) => answerCard(id, value, dontKnow), onSuccess: advance });
  const card = limitReached ? undefined : queue.data?.cards[0];
  const points = Array.from(new Map((mistakes.data?.cards ?? []).filter((entry) => entry.kp_id).map((entry) => [entry.kp_id, entry.kp_name])).entries());

  if (plan) {
    return <Navigate to={`/plan-items/${encodeURIComponent(plan)}/lesson`} replace />;
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!card) return;
    const data = new FormData(event.currentTarget);
    const selected = data.getAll("answer");
    answer.mutate({ id: card.id, value: card.item?.type === "multi" ? selected : selected[0] ?? data.get("text") });
  }

  return (
    <div className="review-page">
      {!embedded ? (
        <>
          <div className="course-breadcrumb"><Link to={`/courses/${courseId}`}>{t.review.course}</Link><ChevronRight size={14} aria-hidden="true" /><span>{t.review.heading}</span></div>
          <div className="page-title"><div><h1>{plan ? t.review.warmup : t.review.heading}</h1><p>{plan ? t.review.warmupIntro : t.review.lead}</p></div></div>
        </>
      ) : null}
      {plan ? <div className="actions">
        {preferred && card ? <VoicePreview id={preferred.id} text={`${t.review.warmupCue} ${card.front}`.slice(0, 240)} /> : null}
        <Button variant="primary" pending={start.isPending} onClick={() => start.mutate(plan)}>{t.review.startLesson}</Button>
        {start.isError ? <Problem error={start.error} /> : null}
      </div> : null}
      <section className="review-card course-panel" aria-labelledby="daily-review">
        <div className="section-heading"><div><p className="eyebrow">{t.review.daily}</p><h2 id="daily-review">{t.review.queue}</h2></div><span>{queue.data?.cards.length ?? 0} {t.review.cards}</span></div>
        {queue.isPending ? <Loading /> : null}
        {queue.isError ? <Problem error={queue.error} onRetry={() => void queue.refetch()} /> : null}
        {!queue.isPending && !card ? (
          <EmptyState
            visual={preferred ? <TutorAvatar src={preferred.appearance.src} name={preferred.name} size="lg" /> : undefined}
            title={limitReached ? t.review.warmupDone : t.review.empty}
            description={t.tutorsGallery.emptyReviewLine}
          />
        ) : null}
        {card?.kind === "flashcard" ? <article className="review-prompt"><h3>{card.front}</h3>{revealed ? <><p className="review-answer">{card.back}</p><div className="rating-row">{(["again", "hard", "good", "easy"] as const).map((value) => <button className="button quiet" disabled={rate.isPending} aria-busy={rate.isPending || undefined} key={value} onClick={() => rate.mutate({ id: card.id, rating: value })}>{t.review.ratings[value]}</button>)}</div></> : <button className="button primary" onClick={() => setRevealed(true)}>{t.review.reveal}</button>}</article> : null}
        {card?.kind === "item" ? <form className="review-prompt" onSubmit={submit}><h3>{card.item?.stem || card.front}</h3>{options(card).map((option) => <label className="review-option" key={option.key}><input type={card.item?.type === "multi" ? "checkbox" : "radio"} name="answer" value={option.key} required={card.item?.type !== "multi"} /> <strong>{option.key}</strong> {option.text}</label>)}{!options(card).length ? <input name="text" aria-label={t.review.answer} required /> : null}<div className="actions"><button className="button primary" disabled={answer.isPending} aria-busy={answer.isPending || undefined}>{t.review.submit}</button><button type="button" className="button quiet" disabled={answer.isPending} aria-busy={answer.isPending || undefined} onClick={() => answer.mutate({ id: card.id, value: null, dontKnow: true })}>{t.review.dontKnow}</button></div></form> : null}
        {rate.isError ? <Problem error={rate.error} /> : null}{answer.isError ? <Problem error={answer.error} /> : null}
      </section>
      {!plan ? <section className="course-panel" aria-labelledby="mistakes-title">
        <div className="section-heading"><div><p className="eyebrow">{t.review.history}</p><h2 id="mistakes-title">{t.review.mistakes}</h2></div></div>
        <div className="review-filters"><label>{t.review.knowledgePoint}<select value={kpId} onChange={(event) => setKpId(event.target.value)}><option value="">{t.review.all}</option>{points.map(([id, name]) => <option key={id} value={id ?? ""}>{name}</option>)}</select></label><label>{t.review.since}<input type="date" value={since} onChange={(event) => setSince(event.target.value)} /></label><label className="check-field"><input type="checkbox" checked={archived} onChange={(event) => setArchived(event.target.checked)} />{t.review.archived}</label></div>
        {mistakes.isPending ? <Loading /> : null}{mistakes.isError ? <Problem error={mistakes.error} onRetry={() => void mistakes.refetch()} /> : null}
        <div className="mistake-list">{mistakes.data?.cards.map((entry) => <article key={entry.id}><small>{entry.kp_name}</small><h3>{entry.front}</h3><p>{t.review.original}: {String(entry.original_mistake?.detail.answer ?? t.review.unknown)}</p>{entry.original_mistake?.detail.gap ? <p>{t.review.reason}: {entry.original_mistake.detail.gap}</p> : null}</article>)}</div>
      </section> : null}
    </div>
  );
}
