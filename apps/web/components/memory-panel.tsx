"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { confirmMemoryItem, deleteMemoryItem, listMemoryItems, listSpaces, updateMemoryItem } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import type { MemoryItem, StudySpaceSummary } from "@/lib/types";
import { EmptyState, ErrorCallout, LoadingState, SectionCard, StatusBadge } from "@/components/ui";

export function MemoryPanel({ initialSpaceId }: { initialSpaceId?: string }) {
  const [items, setItems] = useState<MemoryItem[]>([]);
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
      const next = await listMemoryItems(spaceId);
      if (next.some((item) => item.space_id !== spaceId)) {
        throw new Error("记忆接口返回了其他空间的数据，已拒绝展示。");
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
      setError(loadError instanceof Error ? loadError.message : "记忆列表加载失败");
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
      setError(actionError instanceof Error ? actionError.message : "记忆操作失败");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="page-stack">
      <header className="chapter-head">
        <p className="chapter-kicker">长期记忆</p>
        <h1>可审查的记忆</h1>
        <p>候选要先确认，才能长期留下。敏感个人信息尤其如此。</p>
        <dl className="chapter-facts" aria-label="记忆摘要">
          <div>
            <dt>总记忆</dt>
            <dd>{items.length}</dd>
          </div>
          <div>
            <dt>待确认</dt>
            <dd>{items.filter((item) => !item.confirmed).length}</dd>
          </div>
        </dl>
      </header>

      {error ? <ErrorCallout message={error} /> : null}

      <SectionCard eyebrow="记忆列表" title="Memory Items" hint="双击式自动存储是危险的，所以默认要求人工确认。">
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
          <LoadingState label="正在读取记忆..." />
        ) : !spaces.length ? (
          <EmptyState title="还没有学习空间" description="先创建空间，再在明确的空间边界内管理长期记忆。" />
        ) : items.length ? (
          <div className="stack-list">
            {items.map((item) => (
              <article key={item.id} className="editable-row">
                <div className="card-row">
                  <strong>{item.confirmed ? "已确认记忆" : "候选记忆"}</strong>
                  <StatusBadge label={item.sensitivity || "normal"} tone={item.sensitivity === "sensitive" ? "warn" : "muted"} />
                </div>
                <textarea
                  aria-label={`记忆内容-${item.id}`}
                  rows={3}
                  defaultValue={item.content}
                  onBlur={(event) => {
                    const nextValue = event.target.value.trim();
                    if (nextValue && nextValue !== item.content) {
                      void run(item.id, () => updateMemoryItem(item.id, { content: nextValue }, selectedSpaceId));
                    }
                  }}
                />
                {item.sensitivity === "sensitive" && !item.confirmed ? (
                  <p className="micro-copy">
                    确认后，这段内容会在本空间后续对话中作为上下文发送给当前绑定的对话模型。
                  </p>
                ) : null}
                <div className="card-row">
                  <span className="micro-copy">创建于 {formatDateTime(item.created_at)}</span>
                  <div className="inline-actions">
                    {!item.confirmed ? (
                      <button type="button" className="ghost-button" disabled={busyId === item.id} onClick={() => void run(item.id, () => confirmMemoryItem(item.id, selectedSpaceId))}>
                        {item.sensitivity === "sensitive" ? "确认并用于后续对话" : "确认"}
                      </button>
                    ) : null}
                    <button type="button" className="ghost-button danger-button" disabled={busyId === item.id} onClick={() => void run(item.id, () => deleteMemoryItem(item.id, selectedSpaceId))}>
                      删除
                    </button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <EmptyState title="还没有任何记忆" description="等一次会话复盘返回候选记忆后，再来这里确认哪些值得长期保留。" />
        )}
      </SectionCard>
    </section>
  );
}
