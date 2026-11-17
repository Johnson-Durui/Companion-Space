"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { EmptyState, ErrorCallout, LoadingState, StatusBadge } from "@/components/ui";
import { endSession, listSessions } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import type { SessionSummary } from "@/lib/types";

import styles from "./sessions-panel.module.css";

const SESSION_STATE_LABELS: Record<SessionSummary["state"], string> = {
  idle: "待开始",
  listening: "正在聆听",
  thinking: "正在思考",
  speaking: "正在回应",
  interrupted: "已中断",
  error: "异常",
  closed: "已结束",
};

function sessionActivityTimestamp(session: SessionSummary) {
  const value = session.updated_at || session.created_at;
  if (!value) {
    return 0;
  }
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

export function SessionsPanel() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    try {
      const next = await listSessions();
      setSessions([...next].sort((left, right) => sessionActivityTimestamp(right) - sessionActivityTimestamp(left)));
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "会话列表加载失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function handleEnd(sessionId: string) {
    setBusyId(sessionId);
    try {
      await endSession(sessionId);
      await refresh();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "结束会话失败");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className={`${styles.page} page-stack`}>
      <header className={styles.intro}>
        <div>
          <span className={styles.kicker}>MEMORY TRAIL · 共同回忆</span>
          <h1>最近会话</h1>
        </div>
        <p>上一段对话仍停在这里。继续未完成的章节，或沿着时间轨迹回看文字、引用与复盘。</p>
      </header>

      <section className={styles.taskHub} aria-labelledby="companion-task-heading">
        <div className={styles.taskHubHeading}>
          <div>
            <span className={styles.kicker}>CHAPTER SELECT · 同行任务</span>
            <h2 id="companion-task-heading">选择下一段旅程</h2>
          </div>
          <p>会话留下轨迹，记忆负责校准，复习把重要内容带回今天。</p>
        </div>

        <nav className={styles.chapterGrid} aria-label="同行任务章节">
          <Link href="/sessions" className={`${styles.chapterCard} ${styles.trailChapter}`} aria-current="page">
            <span className={styles.chapterNumber}>01</span>
            <span className={styles.chapterArt} aria-hidden="true" />
            <span className={styles.chapterCopy}>
              <span className={styles.chapterState}>CURRENT · 当前章节</span>
              <strong>会话轨迹</strong>
              <span>回到最近对话，续写未完成的章节。</span>
            </span>
            <span className={styles.chapterAction}>进入轨迹 <span aria-hidden="true">→</span></span>
          </Link>

          <Link href="/memory" className={`${styles.chapterCard} ${styles.memoryChapter}`}>
            <span className={styles.chapterNumber}>02</span>
            <span className={styles.chapterArt} aria-hidden="true" />
            <span className={styles.chapterCopy}>
              <span className={styles.chapterState}>ARCHIVE · 记忆回廊</span>
              <strong>记忆校准</strong>
              <span>确认、修正或清除伙伴记住的片段。</span>
            </span>
            <span className={styles.chapterAction}>前往校准 <span aria-hidden="true">→</span></span>
          </Link>

          <Link href="/review-items" className={`${styles.chapterCard} ${styles.reviewChapter}`}>
            <span className={styles.chapterNumber}>03</span>
            <span className={styles.chapterArt} aria-hidden="true" />
            <span className={styles.chapterCopy}>
              <span className={styles.chapterState}>TRAINING · 今日训练</span>
              <strong>复习试炼</strong>
              <span>领取到期题目，把零散知识练成答案。</span>
            </span>
            <span className={styles.chapterAction}>开始试炼 <span aria-hidden="true">→</span></span>
          </Link>
        </nav>
      </section>

      {error ? <ErrorCallout message={error} /> : null}

      <section className={styles.history} aria-labelledby="session-history-heading">
        <div className={styles.sectionHeading}>
          <h2 id="session-history-heading">会话记录</h2>
          {!loading && sessions.length ? <span>{sessions.length} 场</span> : null}
        </div>

        {loading ? (
          <LoadingState label="正在读取会话..." />
        ) : sessions.length ? (
          <div className={styles.timeline}>
            {sessions.map((session, index) => (
              <article key={session.id} className={`${styles.sessionRow} ${index === 0 ? styles.latest : ""} info-card`}>
                {index === 0 ? (
                  <div className={styles.memoryStage} aria-hidden="true">
                    <span className={`app-pet-portrait ${styles.heroPet}`} />
                    <span className={styles.chapterStamp}>PREVIOUS CHAPTER</span>
                  </div>
                ) : (
                  <span className={styles.memoryNode} aria-hidden="true">{String(index).padStart(2, "0")}</span>
                )}
                <time className={styles.time} dateTime={session.updated_at || session.created_at || undefined}>
                  {formatDateTime(session.updated_at || session.created_at)}
                </time>

                <div className={styles.sessionMain}>
                  {index === 0 ? <span className={styles.currentLabel}>上一章</span> : null}
                  <div className={styles.titleRow}>
                    <Link href={`/sessions/${session.id}`} className={styles.sessionTitle}>
                      <strong>{session.title}</strong>
                    </Link>
                    <StatusBadge
                      label={SESSION_STATE_LABELS[session.state]}
                      tone={session.state === "closed" ? "muted" : session.state === "error" || session.state === "interrupted" ? "warn" : "good"}
                    />
                  </div>
                  <p>{session.space_title || `空间 ${session.space_id}`}</p>
                  {session.character_name ? <span className={styles.character}>{session.character_name}</span> : null}
                </div>

                <div className={styles.actions}>
                  {index === 0 && session.state !== "closed" ? (
                    <Link href={`/spaces/${session.space_id}/call?session=${encodeURIComponent(session.id)}`} className="primary-button">
                      继续这一章
                    </Link>
                  ) : (
                    <Link href={`/sessions/${session.id}`} className={index === 0 ? "primary-button" : "ghost-button subtle-link"}>
                      查看复盘
                    </Link>
                  )}
                  {index === 0 && session.state !== "closed" ? (
                    <Link href={`/sessions/${session.id}`} className="ghost-button subtle-link">
                      查看复盘
                    </Link>
                  ) : null}
                  {session.state !== "closed" ? (
                    <details className={styles.moreActions}>
                      <summary aria-label={`${session.title}的更多操作`}>更多</summary>
                      <div>
                        {index !== 0 ? (
                          <Link href={`/spaces/${session.space_id}/call?session=${encodeURIComponent(session.id)}`} className="ghost-button subtle-link">
                            继续会话
                          </Link>
                        ) : null}
                        <button type="button" className="ghost-button danger-button" disabled={busyId === session.id} onClick={() => void handleEnd(session.id)}>
                          结束会话
                        </button>
                      </div>
                    </details>
                  ) : null}
                </div>
              </article>
            ))}
          </div>
        ) : (
          <EmptyState title="还没有复盘可看" description="从空间里发起一场文字会话后，这里会出现可追溯的会话记录。" />
        )}
      </section>
    </section>
  );
}
