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
