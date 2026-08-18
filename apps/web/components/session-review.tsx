"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  confirmMemoryItem,
  deleteMemoryItem,
  deleteReviewItem,
  endSession,
  getSession,
  saveSessionRecap,
  undoSessionRecap,
  updateMemoryItem,
  updateReviewItem,
} from "@/lib/api";
import {
  formatDate,
  formatDateTime,
  fromDateTimeLocalValue,
  toDateTimeLocalValue,
} from "@/lib/format";
import type { LearningArtifactsStatus, SessionDetail } from "@/lib/types";
import { CitationList } from "@/components/citation-list";
import { EmptyState, ErrorCallout, LoadingState, SectionCard, StatusBadge } from "@/components/ui";

type SaveState = "idle" | "saving" | "saved" | "error";

function artifactsTone(status: LearningArtifactsStatus | null | undefined) {
  if (status === "ready") {
    return "good";
  }
  if (status === "pending" || status === "running" || status === "error") {
    return "warn";
  }
  return "muted";
}

function artifactsLabel(status: LearningArtifactsStatus | null | undefined) {
  switch (status) {
    case "pending":
      return "正在整理复盘";
    case "running":
      return "正在生成记忆与复习";
    case "ready":
      return "复盘已就绪";
    case "error":
      return "复盘生成失败";
    default:
      return "等待生成";
  }
}

export function SessionReview({ sessionId }: { sessionId: string }) {
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summaryDraft, setSummaryDraft] = useState("");
  const [notesDraft, setNotesDraft] = useState("");
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [dirty, setDirty] = useState(false);
  const saveRequestRef = useRef(0);
  const editRevisionRef = useRef(0);

  const refresh = useCallback(async (options: { silent?: boolean } = {}) => {
    if (!options.silent) {
      setLoading(true);
    }
    try {
      const next = await getSession(sessionId);
      setSession(next);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "会话详情加载失败");
    } finally {
      if (!options.silent) {
        setLoading(false);
      }
    }
  }, [sessionId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!session || dirty) {
      return;
    }
    setSummaryDraft(session.summary ?? "");
    setNotesDraft(session.notes ?? "");
  }, [dirty, session]);

  useEffect(() => {
    if (!session || (session.artifacts_status !== "pending" && session.artifacts_status !== "running")) {
      return;
    }
    const timer = window.setTimeout(() => {
      void refresh({ silent: true });
    }, 1800);
    return () => window.clearTimeout(timer);
  }, [refresh, session]);

  useEffect(() => {
    if (!session || !dirty) {
      return;
    }
    const timer = window.setTimeout(() => {
      const requestId = saveRequestRef.current + 1;
      const editRevision = editRevisionRef.current;
      saveRequestRef.current = requestId;
      setSaveState("saving");
      void saveSessionRecap(session.id, { summary: summaryDraft, notes: notesDraft })
        .then((next) => {
          if (requestId !== saveRequestRef.current) {
            return;
          }
          setSession(next);
          if (editRevision === editRevisionRef.current) {
            setDirty(false);
            setSaveState("saved");
          } else {
            setSaveState("idle");
          }
          setError(null);
        })
        .catch((saveError) => {
          if (
            requestId !== saveRequestRef.current
            || editRevision !== editRevisionRef.current
          ) {
            return;
          }
          setSaveState("error");
          setError(saveError instanceof Error ? saveError.message : "复盘保存失败");
        });
    }, 700);
    return () => window.clearTimeout(timer);
  }, [dirty, notesDraft, session, summaryDraft]);

  const citationCount = useMemo(
    () => session?.transcript.reduce((count, turn) => count + turn.citations.length, 0) ?? 0,
    [session],
  );

  async function handleEnd() {
    if (!session) {
      return;
    }
    setBusy(true);
    try {
      await endSession(session.id, summaryDraft.trim());
      await refresh();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "结束会话失败");
    } finally {
      setBusy(false);
    }
  }

  async function handleUndoToGenerated() {
    if (!session) {
      return;
    }
    const hadDirtyDraft = dirty;
    setBusy(true);
    editRevisionRef.current += 1;
    saveRequestRef.current += 1;
    setDirty(false);
    try {
      const next = await undoSessionRecap(session.id);
      setSession(next);
      setSummaryDraft(next.summary ?? "");
      setNotesDraft(next.notes ?? "");
      setDirty(false);
      setSaveState("idle");
      setError(null);
    } catch (actionError) {
      setDirty(hadDirtyDraft);
      setError(actionError instanceof Error ? actionError.message : "恢复 AI 草稿失败");
    } finally {
      setBusy(false);
    }
  }

  async function runArtifactAction(action: () => Promise<unknown>) {
    setBusy(true);
    try {
      await action();
      await refresh();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "复盘条目操作失败");
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return <LoadingState label="正在读取会话复盘..." />;
  }

  if (error && !session) {
    return <ErrorCallout message={error} />;
  }

  if (!session) {
    return <EmptyState title="没有找到这场会话" description="可能会话接口还没实现，或该会话已经被删除。" />;
  }

  return (
    <section className="page-stack">
      <header className="chapter-head">
        <p className="chapter-kicker">会话复盘</p>
        <h1>{session.title}</h1>
        <p>把这场对话收成可改的复盘、待确认记忆和下次复习点。角色先给草稿，留下什么由你决定。</p>
        <dl className="chapter-facts" aria-label="复盘摘要">
          <div>
            <dt>状态</dt>
            <dd>{session.state}</dd>
          </div>
          <div>
            <dt>整理</dt>
            <dd>{artifactsLabel(session.artifacts_status)}</dd>
          </div>
          <div>
            <dt>回合</dt>
            <dd>{session.transcript.length}</dd>
          </div>
        </dl>
      </header>

      {error ? <ErrorCallout message={error} /> : null}

      <div className="content-grid two-up">
        <SectionCard eyebrow="会话概览" title="复盘状态" hint="摘要和候选条目由后台异步整理，期间页面会自动刷新。">
          <div className="stack-list">
            <div className="list-row compact">
              <div>
                <strong>所属空间</strong>
                <p>{session.space_title || session.space_id}</p>
              </div>
              <StatusBadge label={artifactsLabel(session.artifacts_status)} tone={artifactsTone(session.artifacts_status)} />
            </div>
            <div className="list-row compact">
              <div>
                <strong>会话时间</strong>
                <p>{formatDateTime(session.created_at)}</p>
              </div>
            </div>
            <div className="list-row compact">
              <div>
                <strong>最近整理</strong>
                <p>{session.artifacts_updated_at ? formatDateTime(session.artifacts_updated_at) : "还没有开始整理"}</p>
              </div>
            </div>
          </div>
          {session.artifacts_error ? <ErrorCallout message={session.artifacts_error} /> : null}
          {session.state !== "closed" ? (
            <div className="inline-actions">
              <button type="button" className="ghost-button" disabled={busy} onClick={() => void handleEnd()}>
                结束会话并生成候选
              </button>
            </div>
          ) : null}
        </SectionCard>

        <SectionCard eyebrow="可追溯结果" title="引用与学习触点" hint="引用只能来自服务端命中的空间资料，记忆与复习保持会话来源可追踪。">
          <div className="stack-list">
            <div className="list-row compact">
              <div>
                <strong>资料引用</strong>
                <p>{citationCount} 条</p>
              </div>
            </div>
            <div className="list-row compact">
              <div>
                <strong>记忆候选</strong>
                <p>{session.memory_candidates?.length ?? 0} 条</p>
              </div>
            </div>
            <div className="list-row compact">
              <div>
                <strong>复习项</strong>
                <p>{session.review_items?.length ?? 0} 条</p>
              </div>
            </div>
          </div>
          <div className="inline-actions">
            <Link href={`/memory?spaceId=${encodeURIComponent(session.space_id)}`} className="ghost-button subtle-link">
              查看空间记忆
            </Link>
            <Link href={`/review-items?spaceId=${encodeURIComponent(session.space_id)}`} className="ghost-button subtle-link">
              查看空间复习
            </Link>
          </div>
        </SectionCard>
      </div>

      <div className="content-grid two-up">
        <SectionCard eyebrow="可编辑复盘" title="陪学草稿" hint="这里会自动保存；你可以先改，再决定是否恢复成 AI 草稿。">
          <div className="field">
            <span>这次一起捋清了什么</span>
                    <textarea
              aria-label="复盘摘要"
              rows={6}
              value={summaryDraft}
              onChange={(event) => {
                editRevisionRef.current += 1;
                setSummaryDraft(event.target.value);
                setDirty(true);
                setSaveState("idle");
              }}
            />
          </div>
          <div className="field">
            <span>你的临时补充</span>
            <textarea
              aria-label="复盘备注"
              rows={4}
              value={notesDraft}
              placeholder="比如：下次先看反例、想让角色更快给练习题。"
              onChange={(event) => {
                editRevisionRef.current += 1;
                setNotesDraft(event.target.value);
                setDirty(true);
                setSaveState("idle");
              }}
            />
          </div>
          <div className="card-row">
            <span className="micro-copy">
              {saveState === "saving"
                ? "正在自动保存…"
                : saveState === "saved"
                  ? "已保存到本地空间"
                  : saveState === "error"
                    ? "保存失败，请查看错误信息"
                    : dirty
                      ? "检测到未保存修改"
                      : "当前内容与服务端一致"}
            </span>
            <div className="inline-actions">
              {dirty ? (
                <button
                  type="button"
                  className="ghost-button"
                  disabled={saveState === "saving"}
                  onClick={() => {
                    editRevisionRef.current += 1;
                    saveRequestRef.current += 1;
                    setSummaryDraft(session.summary ?? "");
                    setNotesDraft(session.notes ?? "");
                    setDirty(false);
                    setSaveState("idle");
                  }}
                >
                  撤销本地修改
                </button>
              ) : null}
              <button type="button" className="ghost-button" disabled={busy} onClick={() => void handleUndoToGenerated()}>
                恢复 AI 草稿
              </button>
            </div>
          </div>
          {session.generated_summary ? (
            <div className="editable-row">
              <strong>最近一版 AI 草稿</strong>
              <p>{session.generated_summary}</p>
            </div>
          ) : null}
        </SectionCard>

        <SectionCard eyebrow="引用" title="Citations" hint="这里只展示服务端真正命中的资料片段。">
          <CitationList citations={session.transcript.flatMap((turn) => turn.citations)} />
        </SectionCard>
      </div>

      <div className="content-grid two-up">
        <SectionCard eyebrow="字幕" title="Transcript" hint="只保留最终文本，不保留原始音频。">
          {session.transcript.length ? (
            <div className="timeline">
              {session.transcript.map((turn) => (
                <article key={turn.id} className={turn.role === "assistant" ? "bubble assistant" : "bubble user"}>
                  <div className="bubble-topline">
                    <span className="bubble-role">{turn.role === "assistant" ? "伴学角色" : "你"}</span>
                    {turn.emotion ? <span className="bubble-chip">{turn.emotion}</span> : null}
                  </div>
                  <p>{turn.display_text}</p>
                  {turn.suggested_actions.length ? <p className="muted">建议：{turn.suggested_actions.join(" / ")}</p> : null}
                </article>
              ))}
            </div>
          ) : (
            <EmptyState title="还没有 transcript" description="后端需要在结束会话后返回最终字幕和角色输出。" />
          )}
        </SectionCard>

        <SectionCard eyebrow="待确认记忆" title="Memory Candidates" hint="敏感内容默认只停留在候选区，必须由你手动确认。">
          {session.memory_candidates?.length ? (
            <div className="stack-list">
              {session.memory_candidates.map((item) => (
                <article key={item.id} className="editable-row">
                  <div className="card-row">
                    <strong>{item.confirmed ? "已确认记忆" : "待确认记忆"}</strong>
                    <StatusBadge label={item.sensitivity || "normal"} tone={item.sensitivity === "sensitive" ? "warn" : "muted"} />
                  </div>
                  <textarea
                    aria-label={`记忆内容-${item.id}`}
                    rows={3}
                    defaultValue={item.content}
                    onBlur={(event) => {
                      const nextValue = event.target.value.trim();
                      if (nextValue && nextValue !== item.content) {
                        void runArtifactAction(() => updateMemoryItem(item.id, { content: nextValue }, session.space_id));
                      }
                    }}
                  />
                  {item.sensitivity === "sensitive" && !item.confirmed ? (
                    <p className="micro-copy">
                      确认后，这段内容会在本空间后续对话中作为上下文发送给当前绑定的对话模型。
                    </p>
                  ) : null}
                  <div className="card-row">
                    <span className="micro-copy">来自本场会话 · {formatDateTime(item.created_at)}</span>
                    <div className="inline-actions">
                      {!item.confirmed ? (
                        <button type="button" className="ghost-button" disabled={busy} onClick={() => void runArtifactAction(() => confirmMemoryItem(item.id, session.space_id))}>
                          {item.sensitivity === "sensitive" ? "确认并用于后续对话" : "确认留下"}
                        </button>
                      ) : null}
                      <button type="button" className="ghost-button danger-button" disabled={busy} onClick={() => void runArtifactAction(() => deleteMemoryItem(item.id, session.space_id))}>
                        删除
                      </button>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <EmptyState title="这场会话还没有记忆候选" description="结束会话后，后台会尝试整理值得留下的长期记忆候选。" />
          )}
        </SectionCard>
      </div>

      <SectionCard eyebrow="复习项" title="Review Queue" hint="会话结束后生成；你可以直接改题干、补答案或删掉不值得留的项。">
        {session.review_items?.length ? (
          <div className="stack-list">
            {session.review_items.map((item) => (
              <article key={item.id} className="editable-row">
                <div className="card-row">
                    <strong>{item.prompt}</strong>
                    <StatusBadge label={item.status || "pending"} tone={item.status === "done" ? "good" : "muted"} />
                  </div>
                  <textarea
                    aria-label={`复习题干-${item.id}`}
                    rows={2}
                    defaultValue={item.prompt}
                    onBlur={(event) => {
                      const nextPrompt = event.target.value.trim();
                      if (nextPrompt && nextPrompt !== item.prompt) {
                        void runArtifactAction(() => updateReviewItem(item.id, { prompt: nextPrompt }, session.space_id));
                      }
                    }}
                  />
                  <textarea
                    aria-label={`复习答案-${item.id}`}
                    rows={3}
                    defaultValue={item.answer || ""}
                    onBlur={(event) => {
                    const nextValue = event.target.value;
                    if (nextValue !== (item.answer || "")) {
                      void runArtifactAction(() => updateReviewItem(item.id, { answer: nextValue }, session.space_id));
                    }
                  }}
                />
                <label>
                  <span className="micro-copy">下次复习时间</span>
                      <input
                        key={item.due_at ?? "unscheduled"}
                        type="datetime-local"
                    aria-label={`复盘复习到期时间-${item.id}`}
                    defaultValue={toDateTimeLocalValue(item.due_at)}
                    disabled={busy}
                    onBlur={(event) => {
                      if (event.target.value === toDateTimeLocalValue(item.due_at)) {
                        return;
                      }
                      void runArtifactAction(() =>
                        updateReviewItem(
                          item.id,
                          { due_at: fromDateTimeLocalValue(event.target.value) },
                          session.space_id,
                        ),
                      );
                    }}
                  />
                </label>
                <div className="card-row">
                  <span className="micro-copy">
                    计划复习：{formatDate(item.due_at)} · 创建于 {formatDateTime(item.created_at)}
                  </span>
                  <div className="inline-actions">
                    <button
                      type="button"
                      className="ghost-button"
                      disabled={busy}
                      onClick={() => void runArtifactAction(() => updateReviewItem(item.id, { status: item.status === "done" ? "pending" : "done" }, session.space_id))}
                    >
                      {item.status === "done" ? "改回待复习" : "标记完成"}
                    </button>
                    <button type="button" className="ghost-button danger-button" disabled={busy} onClick={() => void runArtifactAction(() => deleteReviewItem(item.id, session.space_id))}>
                      删除
                    </button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <EmptyState title="这场会话还没有复习项" description="结束会话后，这里会接住角色整理出的题目、提醒或下一步复习点。" />
        )}
      </SectionCard>
    </section>
  );
}
