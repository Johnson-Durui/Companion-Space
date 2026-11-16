"use client";

import { useEffect, useState } from "react";
import { CitationExcerpts } from "@companion-space/lesson-board";
import { confirmFlashcard, listFlashcards, rateFlashcard, type Flashcard } from "@/lib/classroom-api";
import { formatDateTime } from "@/lib/format";
import { ErrorCallout, LoadingState, SectionCard } from "@/components/ui";

const ratings = [
  [1, "忘记"], [2, "困难"], [3, "记得"], [4, "轻松"],
] as const;

export function ClassroomFlashcards({ spaceId }: { spaceId: string }) {
  const [proposed, setProposed] = useState<Flashcard[]>([]);
  const [due, setDue] = useState<Flashcard[]>([]);
  const [revealed, setRevealed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const current = due[0];

  useEffect(() => {
    const request = new AbortController();
    void Promise.all([
      listFlashcards(spaceId, "proposed", request.signal),
      listFlashcards(spaceId, "due", request.signal),
    ]).then(([candidates, active]) => {
      if (request.signal.aborted) return;
      setProposed(candidates);
      setDue(active);
    }).catch((cause: unknown) => {
      if (!request.signal.aborted) setError(cause instanceof Error ? cause.message : "无法读取闪卡");
    }).finally(() => {
      if (!request.signal.aborted) setLoading(false);
    });
    return () => request.abort();
  }, [spaceId]);

  async function run(operation: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await operation();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "闪卡操作失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <SectionCard title="课堂闪卡" hint="确认课堂提炼的知识点，按 FSRS 到期时间复习。">
      {loading ? <LoadingState /> : null}
      {error ? <ErrorCallout message={error} /> : null}
      {notice ? <p role="status">{notice}</p> : null}
      {current ? (
        <article className="info-card" aria-label="当前到期闪卡">
          <strong>{current.prompt}</strong>
          {revealed ? (
            <>
              <p>{current.answer}</p>
              <CitationExcerpts citations={current.citations ?? []} />
              <div className="inline-actions">
                {ratings.map(([rating, label]) => (
                  <button key={rating} className="ghost-button" type="button" disabled={busy} onClick={() => void run(async () => {
                    const updated = await rateFlashcard(spaceId, current.id, rating);
                    setDue((cards) => cards.filter((card) => card.id !== current.id));
                    setRevealed(false);
                    setNotice(updated.due_at ? `下次复习 ${formatDateTime(updated.due_at)}` : "已记录本次复习。");
                  })}>{label}</button>
                ))}
              </div>
            </>
          ) : <div className="inline-actions"><button className="primary-button" type="button" onClick={() => setRevealed(true)}>查看答案</button></div>}
        </article>
      ) : !loading && !error ? <p className="muted">当前没有到期闪卡。</p> : null}
      {proposed.length ? (
        <div className="card-grid">
          {proposed.map((card) => (
            <article className="info-card" key={card.id}>
              <strong>{card.prompt}</strong>
              <p>{card.answer}</p>
              <CitationExcerpts citations={card.citations ?? []} />
              <button className="ghost-button" type="button" disabled={busy} onClick={() => void run(async () => {
                const confirmed = await confirmFlashcard(spaceId, card.id);
                setProposed((cards) => cards.filter((item) => item.id !== card.id));
                if (confirmed.due_at && Date.parse(confirmed.due_at) <= Date.now()) {
                  setDue((cards) => [...cards, confirmed]);
                }
                setNotice("已加入每日复习。");
              })}>确认加入复习</button>
            </article>
          ))}
        </div>
      ) : null}
    </SectionCard>
  );
}
