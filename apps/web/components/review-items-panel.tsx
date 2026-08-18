"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { deleteReviewItem, listReviewItems, listSpaces, updateReviewItem } from "@/lib/api";
import {
  formatDate,
  formatDateTime,
  fromDateTimeLocalValue,
  toDateTimeLocalValue,
} from "@/lib/format";
import type { ReviewItem, StudySpaceSummary } from "@/lib/types";
import { EmptyState, ErrorCallout, LoadingState, SectionCard, StatusBadge } from "@/components/ui";

export function ReviewItemsPanel({ initialSpaceId }: { initialSpaceId?: string }) {
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [spaces, setSpaces] = useState<StudySpaceSummary[]>([]);
  const [selectedSpaceId, setSelectedSpaceId] = useState("");
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refreshRequestRef = useRef(0);
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
        const firstSpaceId =
          nextSpaces.find((space) => space.id === initialSpaceId)?.id ??
          nextSpaces[0]?.id ??
          "";
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
    setBusyId(itemId);
    try {
      await action();
      await refresh(selectedSpaceIdRef.current);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "复习项操作失败");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="page-stack">
      <header className="chapter-head">
        <p className="chapter-kicker">复习触点</p>
        <h1>下次再见面</h1>
        <p>把一次会话拆成还能再问的题目。只交代提示、答案、到期时间和状态。</p>
        <dl className="chapter-facts" aria-label="复习摘要">
          <div>
            <dt>复习项</dt>
            <dd>{items.length}</dd>
          </div>
          <div>
            <dt>今日到期</dt>
            <dd>{items.filter((item) => item.due_at && new Date(item.due_at) <= new Date()).length}</dd>
          </div>
        </dl>
      </header>

      {error ? <ErrorCallout message={error} /> : null}

      <SectionCard eyebrow="排程" title="Review Queue" hint="双向编辑 prompt / answer，方便人工校正。">
        {spaces.length ? (
          <label>
            <span className="micro-copy">当前空间</span>
            <select
              value={selectedSpaceId}
              onChange={(event) => {
                const nextSpaceId = event.target.value;
                selectedSpaceIdRef.current = nextSpaceId;
                setSelectedSpaceId(nextSpaceId);
                setItems([]);
                void refresh(nextSpaceId);
              }}
            >
              {spaces.map((space) => (
                <option key={space.id} value={space.id}>
                  {space.title}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {loading ? (
          <LoadingState label="正在读取复习项..." />
        ) : !spaces.length ? (
          <EmptyState title="还没有学习空间" description="先创建空间，再在明确的空间边界内管理复习项。" />
        ) : items.length ? (
          <div className="stack-list">
            {items.map((item) => (
              <article key={item.id} className="editable-row">
                <div className="card-row">
                  <strong>{item.prompt}</strong>
                  <StatusBadge label={item.status || "pending"} tone={item.status === "done" ? "good" : "muted"} />
                </div>
                <textarea
                  aria-label={`复习列表题干-${item.id}`}
                  rows={2}
                  defaultValue={item.prompt}
                  placeholder="补一版更适合你自己的题干"
                  onBlur={(event) => {
                    const nextValue = event.target.value.trim();
                    if (nextValue && nextValue !== item.prompt) {
                      void run(item.id, () => updateReviewItem(item.id, { prompt: nextValue }, selectedSpaceId));
                    }
                  }}
                />
                <textarea
                  aria-label={`复习列表答案-${item.id}`}
                  rows={2}
                  defaultValue={item.answer || ""}
                  placeholder="补充答案或提醒"
                  onBlur={(event) => {
                    const nextValue = event.target.value;
                    if (nextValue !== (item.answer || "")) {
                      void run(item.id, () => updateReviewItem(item.id, { answer: nextValue }, selectedSpaceId));
                    }
                  }}
                />
                <label>
                  <span className="micro-copy">下次复习时间</span>
                  <input
                    key={item.due_at ?? "unscheduled"}
                    type="datetime-local"
                    aria-label={`复习列表到期时间-${item.id}`}
                    defaultValue={toDateTimeLocalValue(item.due_at)}
                    disabled={busyId === item.id}
                    onBlur={(event) => {
                      if (event.target.value === toDateTimeLocalValue(item.due_at)) {
                        return;
                      }
                      void run(item.id, () =>
                        updateReviewItem(
                          item.id,
                          { due_at: fromDateTimeLocalValue(event.target.value) },
                          selectedSpaceId,
                        ),
                      );
                    }}
                  />
                </label>
                <div className="card-row">
                  <span className="micro-copy">到期：{formatDate(item.due_at)} · 创建于 {formatDateTime(item.created_at)}</span>
                  <div className="inline-actions">
                    <button type="button" className="ghost-button" disabled={busyId === item.id} onClick={() => void run(item.id, () => updateReviewItem(item.id, { status: item.status === "done" ? "pending" : "done" }, selectedSpaceId))}>
                      {item.status === "done" ? "标回待复习" : "标记完成"}
                    </button>
                    <button type="button" className="ghost-button danger-button" disabled={busyId === item.id} onClick={() => void run(item.id, () => deleteReviewItem(item.id, selectedSpaceId))}>
                      删除
                    </button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <EmptyState title="还没有任何复习项" description="会话复盘生成题目后，这里会承接后续复习计划。" />
        )}
      </SectionCard>
    </section>
  );
}
