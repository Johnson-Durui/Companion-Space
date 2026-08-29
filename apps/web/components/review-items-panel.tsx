"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { deleteReviewItem, listReviewItems, listSpaces, updateReviewItem } from "@/lib/api";
import { formatDate, formatDateTime, fromDateTimeLocalValue, toDateTimeLocalValue } from "@/lib/format";
import type { ReviewItem, StudySpaceSummary } from "@/lib/types";
import { EmptyState, ErrorCallout, LoadingState, StatusBadge } from "@/components/ui";

import styles from "./reflection-task-panel.module.css";

function isCompleted(item: ReviewItem) {
  return item.status === "completed" || item.status === "done";
}

function reviewTimestamp(item: ReviewItem) {
  if (!item.due_at) {
    return Number.POSITIVE_INFINITY;
  }
  const value = Date.parse(item.due_at);
  return Number.isNaN(value) ? Number.POSITIVE_INFINITY : value;
}

export function ReviewItemsPanel({ initialSpaceId }: { initialSpaceId?: string }) {
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [spaces, setSpaces] = useState<StudySpaceSummary[]>([]);
  const [selectedSpaceId, setSelectedSpaceId] = useState("");
  const [revealedReviewId, setRevealedReviewId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refreshRequestRef = useRef(0);
  const actionRequestRef = useRef(0);
  const selectedSpaceIdRef = useRef("");

  const refresh = useCallback(async (spaceId: string) => {
    const requestId = refreshRequestRef.current + 1;
    refreshRequestRef.current = requestId;
    setLoading(true);
    try {
      const next = await listReviewItems(spaceId);
      if (next.some((item) => item.space_id !== spaceId)) {
        throw new Error("复习项接口返回了其他空间的数据，已拒绝展示。");
      }
      if (requestId !== refreshRequestRef.current) {
        return;
      }
      setItems(next);
      setError(null);
    } catch (loadError) {
      if (requestId !== refreshRequestRef.current) {
        return;
      }
      setItems([]);
      setError(loadError instanceof Error ? loadError.message : "复习项加载失败");
    } finally {
      if (requestId === refreshRequestRef.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    async function loadInitialSpace() {
      setLoading(true);
      try {
        const nextSpaces = await listSpaces();
        const firstSpaceId = nextSpaces.find((space) => space.id === initialSpaceId)?.id ?? nextSpaces[0]?.id ?? "";
        setSpaces(nextSpaces);
        setSelectedSpaceId(firstSpaceId);
        selectedSpaceIdRef.current = firstSpaceId;
        if (firstSpaceId) {
          await refresh(firstSpaceId);
        } else {
          setItems([]);
          setError(null);
          setLoading(false);
        }
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : "空间列表加载失败");
        setLoading(false);
      }
    }

    void loadInitialSpace();
  }, [initialSpaceId, refresh]);

  async function run(itemId: string, action: () => Promise<unknown>) {
    const requestId = actionRequestRef.current + 1;
    actionRequestRef.current = requestId;
    const spaceId = selectedSpaceIdRef.current;
    setBusyId(itemId);
    try {
      await action();
      if (requestId !== actionRequestRef.current || selectedSpaceIdRef.current !== spaceId) {
        return;
      }
      setRevealedReviewId(null);
      await refresh(spaceId);
    } catch (actionError) {
      if (requestId === actionRequestRef.current && selectedSpaceIdRef.current === spaceId) {
        setError(actionError instanceof Error ? actionError.message : "复习项操作失败");
      }
    } finally {
      if (requestId === actionRequestRef.current) {
        setBusyId(null);
      }
    }
  }

  const pendingItems = items.filter((item) => !isCompleted(item)).sort((left, right) => reviewTimestamp(left) - reviewTimestamp(right));
  const completedItems = items.filter(isCompleted);
  const dueItems = pendingItems.filter((item) => reviewTimestamp(item) <= Date.now());
  const activeItem = dueItems[0] ?? pendingItems[0];
  const activeIndex = activeItem ? pendingItems.findIndex((item) => item.id === activeItem.id) + 1 : 0;
  const answerRevealed = activeItem?.id === revealedReviewId;
  const selectedSpace = spaces.find((space) => space.id === selectedSpaceId);
  const completionRate = items.length ? Math.round((completedItems.length / items.length) * 100) : 0;

  return (
    <section className={`${styles.page} page-stack`}>
      <header className={`${styles.hero} ${styles.reviewHero}`}>
        <div className={styles.heroCopy}>
          <div className={styles.chapterLine}>
            <span>REFLECTION TASK 03</span>
            <span>{dueItems.length ? `${dueItems.length} 题已到期` : pendingItems.length ? "下一题已准备" : "今日试炼完成"}</span>
          </div>
          <p className={styles.kicker}>DAILY TRAINING · 复习试炼</p>
          <h1>不是重读，是再答一次。</h1>
          <p>先独立回答，再翻开答案。每次只完成一题，让上一次会话真正变成下一次能用的知识。</p>
          <dl className={styles.heroStats} aria-label="复习摘要">
            <div>
              <dt>等待作答</dt>
              <dd>{pendingItems.length}</dd>
            </div>
            <div>
              <dt>今日到期</dt>
              <dd>{dueItems.length}</dd>
            </div>
            <div>
              <dt>完成度</dt>
              <dd>{completionRate}%</dd>
            </div>
          </dl>
        </div>
        <div className={styles.characterStage} aria-hidden="true">
          <span className={styles.orbitOne} />
          <span className={styles.orbitTwo} />
          <Image
            src="/assets/characters/art/roster/mira.png"
            alt=""
            fill
            priority
            sizes="(max-width: 720px) 72vw, 420px"
            className={styles.characterImage}
          />
          <span className={styles.characterName}>MIRA · KEEPER OF QUESTIONS</span>
        </div>
      </header>

      <nav className={styles.chapterNav} aria-label="复盘章节">
        <Link href="/sessions"><span>01</span>会话轨迹</Link>
        <Link href="/memory"><span>02</span>记忆校准</Link>
        <Link href="/review-items" aria-current="page"><span>03</span>复习试炼</Link>
      </nav>

      <section className={styles.controlDeck} aria-label="任务控制">
        <div>
          <span className={styles.controlEyebrow}>CURRENT STAGE</span>
          <strong>{selectedSpace?.title || "等待空间"}</strong>
          <p>{pendingItems.length ? "答案默认隐藏；想好以后再翻面。" : "本关已清空，可以检查记录或切换空间。"}</p>
        </div>
        {spaces.length ? (
          <label className={styles.spacePicker}>
            <span>切换空间</span>
            <select
              value={selectedSpaceId}
              disabled={busyId !== null}
              onChange={(event) => {
                const nextSpaceId = event.target.value;
                selectedSpaceIdRef.current = nextSpaceId;
                setSelectedSpaceId(nextSpaceId);
                setRevealedReviewId(null);
                setItems([]);
                void refresh(nextSpaceId);
              }}
            >
              {spaces.map((space) => (
                <option key={space.id} value={space.id}>{space.title}</option>
              ))}
            </select>
          </label>
        ) : null}
      </section>

      {error ? <ErrorCallout message={error} /> : null}

      {loading ? (
        <div className={styles.statePanel}><LoadingState label="正在准备今日试炼…" /></div>
      ) : !spaces.length ? (
        <div className={styles.statePanel}>
          <EmptyState title="还没有学习空间" description="先创建空间，复习题会留在它所属的学习边界里。" action={<Link href="/spaces" className="primary-button">创建空间</Link>} />
        </div>
      ) : activeItem ? (
        <section className={styles.trialSection} aria-labelledby="active-trial-heading">
          <div className={styles.trialProgress}>
            <span>{String(activeIndex).padStart(2, "0")} / {String(pendingItems.length).padStart(2, "0")}</span>
            <span className={styles.progressTrack} aria-hidden="true"><i style={{ width: `${Math.max(8, completionRate)}%` }} /></span>
            <span>{activeItem.due_at ? `到期 ${formatDate(activeItem.due_at)}` : "自由练习"}</span>
          </div>
          <article className={`${styles.trialCard} ${answerRevealed ? styles.answerRevealed : ""}`}>
            <div className={styles.questionFace}>
              <span className={styles.sequence}>QUESTION</span>
              <h2 id="active-trial-heading">{activeItem.prompt}</h2>
              {activeItem.source_session_id ? <Link href={`/sessions/${activeItem.source_session_id}`}>回到这道题的来源会话</Link> : null}
            </div>
            <div className={styles.answerFace} aria-live="polite">
              {answerRevealed ? (
                <>
                  <span className={styles.sequence}>ANSWER</span>
                  <p>{activeItem.answer || "这道题还没有参考答案。你可以在下方题库里补充。"}</p>
                </>
              ) : (
                <div className={styles.hiddenAnswer}>
                  <span aria-hidden="true">?</span>
                  <p>先在心里说出答案，再翻开对照。</p>
                </div>
              )}
            </div>
            <footer className={styles.trialActions}>
              {!answerRevealed ? (
                <button type="button" className="primary-button" onClick={() => setRevealedReviewId(activeItem.id)}>
                  查看答案
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    className="primary-button"
                    disabled={busyId !== null}
                    onClick={() => void run(activeItem.id, () => updateReviewItem(activeItem.id, { status: "completed" }, selectedSpaceId))}
                  >
                    {busyId === activeItem.id ? "正在记录…" : "记住了"}
                  </button>
                  <button
                    type="button"
                    className="ghost-button"
                    disabled={busyId !== null}
                    onClick={() => void run(activeItem.id, () => updateReviewItem(activeItem.id, { due_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() }, selectedSpaceId))}
                  >
                    明天再来
                  </button>
                </>
              )}
            </footer>
          </article>
        </section>
      ) : (
        <div className={styles.completionState}>
          <span aria-hidden="true">✓</span>
          <div>
            <strong>今日试炼完成</strong>
            <p>这个空间没有待复习题目。你可以查看下方记录，或去开启一场新会话。</p>
          </div>
          <Link href="/study" className="primary-button">开始新的共学</Link>
        </div>
      )}

      {!loading && spaces.length ? (
        <section className={`${styles.taskSection} ${styles.questionBank}`} aria-labelledby="review-bank-heading">
          <div className={styles.sectionHeading}>
            <div>
              <span>TRAINING LOG</span>
              <h2 id="review-bank-heading">题库与排程</h2>
            </div>
            <strong>{String(items.length).padStart(2, "0")}</strong>
          </div>
          {items.length ? (
            <div className={styles.fragmentList}>
              {items.map((item, index) => {
                const completed = isCompleted(item);
                return (
                  <article key={item.id} className={`${styles.fragmentCard} ${styles.reviewEditor} editable-row`}>
                    <div className={styles.fragmentMeta}>
                      <div>
                        <span className={styles.sequence}>CARD {String(index + 1).padStart(2, "0")}</span>
                        <strong>{item.prompt}</strong>
                      </div>
                      <StatusBadge label={completed ? "已完成" : reviewTimestamp(item) <= Date.now() ? "已到期" : "待复习"} tone={completed ? "good" : reviewTimestamp(item) <= Date.now() ? "warn" : "muted"} />
                    </div>
                    <details className={styles.editorDisclosure}>
                      <summary>编辑题目与排程 <span aria-hidden="true">＋</span></summary>
                      <div className={styles.editorBody}>
                        <div className={styles.editorGrid}>
                          <label>
                            <span>题干</span>
                            <textarea
                              aria-label={`复习列表题干-${item.id}`}
                              rows={3}
                              defaultValue={item.prompt}
                              placeholder="补一版更适合你自己的题干"
                              disabled={busyId !== null}
                              onBlur={(event) => {
                                const nextValue = event.target.value.trim();
                                if (nextValue && nextValue !== item.prompt) {
                                  void run(item.id, () => updateReviewItem(item.id, { prompt: nextValue }, selectedSpaceId));
                                }
                              }}
                            />
                          </label>
                          <label>
                            <span>参考答案</span>
                            <textarea
                              aria-label={`复习列表答案-${item.id}`}
                              rows={3}
                              defaultValue={item.answer || ""}
                              placeholder="补充答案或提醒"
                              disabled={busyId !== null}
                              onBlur={(event) => {
                                const nextValue = event.target.value;
                                if (nextValue !== (item.answer || "")) {
                                  void run(item.id, () => updateReviewItem(item.id, { answer: nextValue }, selectedSpaceId));
                                }
                              }}
                            />
                          </label>
                        </div>
                        <footer className={styles.fragmentFooter}>
                          <label className={styles.dateField}>
                            <span>下次复习</span>
                            <input
                              key={item.due_at ?? "unscheduled"}
                              type="datetime-local"
                              aria-label={`复习列表到期时间-${item.id}`}
                              defaultValue={toDateTimeLocalValue(item.due_at)}
                              disabled={busyId !== null}
                              onBlur={(event) => {
                                if (event.target.value === toDateTimeLocalValue(item.due_at)) {
                                  return;
                                }
                                void run(item.id, () => updateReviewItem(item.id, { due_at: fromDateTimeLocalValue(event.target.value) }, selectedSpaceId));
                              }}
                            />
                            <small>创建于 {formatDateTime(item.created_at)}</small>
                          </label>
                          <div className={styles.cardActions}>
                            <button
                              type="button"
                              className="ghost-button"
                              disabled={busyId !== null}
                              onClick={() => void run(item.id, () => updateReviewItem(item.id, { status: completed ? "pending" : "completed" }, selectedSpaceId))}
                            >
                              {completed ? "重新加入试炼" : "直接标记完成"}
                            </button>
                            <button
                              type="button"
                              className="ghost-button danger-button"
                              aria-label={`删除复习题：${item.prompt.slice(0, 28)}`}
                              disabled={busyId !== null}
                              onClick={() => void run(item.id, () => deleteReviewItem(item.id, selectedSpaceId))}
                            >
                              删除
                            </button>
                          </div>
                        </footer>
                      </div>
                    </details>
                  </article>
                );
              })}
            </div>
          ) : (
            <EmptyState title="还没有任何复习项" description="会话复盘生成题目后，这里会自动承接下一次练习。" />
          )}
        </section>
      ) : null}
    </section>
  );
}
