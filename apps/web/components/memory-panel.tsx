"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { confirmMemoryItem, deleteMemoryItem, listMemoryItems, listSpaces, updateMemoryItem } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import type { MemoryItem, StudySpaceSummary } from "@/lib/types";
import { EmptyState, ErrorCallout, LoadingState, StatusBadge } from "@/components/ui";

import styles from "./reflection-task-panel.module.css";

function MemoryCard({
  item,
  busy,
  spaceId,
  run,
}: {
  item: MemoryItem;
  busy: boolean;
  spaceId: string;
  run: (itemId: string, action: () => Promise<unknown>) => Promise<void>;
}) {
  const confirmed = item.confirmed;

  return (
    <article className={`${styles.fragmentCard} editable-row ${confirmed ? styles.savedFragment : styles.pendingFragment}`}>
      <div className={styles.fragmentMeta}>
        <div>
          <span className={styles.sequence}>{confirmed ? "ARCHIVED" : "TO REVIEW"}</span>
          <strong>{confirmed ? "已确认记忆" : "待校准的回忆碎片"}</strong>
        </div>
        <StatusBadge
          label={item.sensitivity === "sensitive" ? "敏感信息" : confirmed ? "已确认" : "普通候选"}
          tone={item.sensitivity === "sensitive" ? "warn" : confirmed ? "good" : "muted"}
        />
      </div>

      {item.sensitivity === "sensitive" && !confirmed ? (
        <div className={styles.sensitiveNotice}>
          <strong>需要你亲自确认</strong>
          <span>留下后，这段内容只会在当前空间的后续对话中作为上下文使用。</span>
        </div>
      ) : null}

      <label className={styles.fragmentEditor}>
        <span className={styles.visuallyHidden}>记忆内容</span>
        <textarea
          aria-label={`记忆内容-${item.id}`}
          rows={confirmed ? 3 : 4}
          defaultValue={item.content}
          disabled={busy}
          onBlur={(event) => {
            const nextValue = event.target.value.trim();
            if (nextValue && nextValue !== item.content) {
              void run(item.id, () => updateMemoryItem(item.id, { content: nextValue }, spaceId));
            }
          }}
        />
      </label>

      <footer className={styles.fragmentFooter}>
        <div className={styles.provenance}>
          <span>创建于 {formatDateTime(item.created_at)}</span>
          {item.source_session_id ? (
            <Link href={`/sessions/${item.source_session_id}`}>查看来源会话</Link>
          ) : (
            <span>来源会话未记录</span>
          )}
        </div>
        <div className={styles.cardActions}>
          {!confirmed ? (
            <button
              type="button"
              className="primary-button"
              disabled={busy}
              onClick={() => void run(item.id, () => confirmMemoryItem(item.id, spaceId))}
            >
              {busy ? "正在留下…" : "留下这段记忆"}
            </button>
          ) : null}
          <button
            type="button"
            className="ghost-button danger-button"
            aria-label={`舍弃记忆：${item.content.slice(0, 28)}`}
            disabled={busy}
            onClick={() => void run(item.id, () => deleteMemoryItem(item.id, spaceId))}
          >
            舍弃
          </button>
        </div>
      </footer>
    </article>
  );
}

export function MemoryPanel({ initialSpaceId }: { initialSpaceId?: string }) {
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [spaces, setSpaces] = useState<StudySpaceSummary[]>([]);
  const [selectedSpaceId, setSelectedSpaceId] = useState("");
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
      await refresh(spaceId);
    } catch (actionError) {
      if (requestId === actionRequestRef.current && selectedSpaceIdRef.current === spaceId) {
        setError(actionError instanceof Error ? actionError.message : "记忆操作失败");
      }
    } finally {
      if (requestId === actionRequestRef.current) {
        setBusyId(null);
      }
    }
  }

  const pendingItems = items.filter((item) => !item.confirmed);
  const confirmedItems = items.filter((item) => item.confirmed);
  const selectedSpace = spaces.find((space) => space.id === selectedSpaceId);

  return (
    <section className={`${styles.page} page-stack`}>
      <header className={`${styles.hero} ${styles.memoryHero}`}>
        <div className={styles.heroCopy}>
          <div className={styles.chapterLine}>
            <span>REFLECTION TASK 02</span>
            <span>{pendingItems.length ? `${pendingItems.length} 条待校准` : "本次已整理"}</span>
          </div>
          <p className={styles.kicker}>MEMORY CALIBRATION · 记忆校准</p>
          <h1>把值得留下的，交给她记住。</h1>
          <p>会话只会生成候选。只有你确认过的内容，才会成为这个空间里的长期记忆。</p>
          <dl className={styles.heroStats} aria-label="记忆摘要">
            <div>
              <dt>待校准</dt>
              <dd>{pendingItems.length}</dd>
            </div>
            <div>
              <dt>已留下</dt>
              <dd>{confirmedItems.length}</dd>
            </div>
            <div>
              <dt>当前关卡</dt>
              <dd>{selectedSpace?.title || "未选择"}</dd>
            </div>
          </dl>
        </div>
        <div className={styles.characterStage} aria-hidden="true">
          <span className={styles.orbitOne} />
          <span className={styles.orbitTwo} />
          <Image
            src="/assets/characters/art/roster/lyra.png"
            alt=""
            fill
            priority
            sizes="(max-width: 720px) 72vw, 420px"
            className={styles.characterImage}
          />
          <span className={styles.characterName}>LYRA · KEEPER OF ECHOES</span>
        </div>
      </header>

      <nav className={styles.chapterNav} aria-label="复盘章节">
        <Link href="/sessions"><span>01</span>会话轨迹</Link>
        <Link href="/memory" aria-current="page"><span>02</span>记忆校准</Link>
        <Link href="/review-items"><span>03</span>复习试炼</Link>
      </nav>

      <section className={styles.controlDeck} aria-label="任务控制">
        <div>
          <span className={styles.controlEyebrow}>CURRENT SPACE</span>
          <strong>{selectedSpace?.title || "等待空间"}</strong>
          <p>{pendingItems.length ? "逐条修改、留下或舍弃。" : "没有待确认候选，新的会话复盘会继续补充。"}</p>
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
        <div className={styles.statePanel}><LoadingState label="正在整理回忆碎片…" /></div>
      ) : !spaces.length ? (
        <div className={styles.statePanel}>
          <EmptyState title="还没有学习空间" description="先创建空间，再在清楚的边界里管理长期记忆。" action={<Link href="/spaces" className="primary-button">创建空间</Link>} />
        </div>
      ) : (
        <>
          <section className={styles.taskSection} aria-labelledby="memory-pending-heading">
            <div className={styles.sectionHeading}>
              <div>
                <span>CALIBRATION QUEUE</span>
                <h2 id="memory-pending-heading">待校准</h2>
              </div>
              <strong>{String(pendingItems.length).padStart(2, "0")}</strong>
            </div>
            {pendingItems.length ? (
              <div className={styles.fragmentList}>
                {pendingItems.map((item) => (
                  <MemoryCard key={item.id} item={item} busy={busyId !== null} spaceId={selectedSpaceId} run={run} />
                ))}
              </div>
            ) : (
              <div className={styles.completionState}>
                <span aria-hidden="true">✓</span>
                <div>
                  <strong>本次记忆已整理</strong>
                  <p>待确认列表已经清空。你仍可以在下方检查已留下的内容。</p>
                </div>
              </div>
            )}
          </section>

          <section className={`${styles.taskSection} ${styles.archiveSection}`} aria-labelledby="memory-saved-heading">
            <div className={styles.sectionHeading}>
              <div>
                <span>MEMORY ARCHIVE</span>
                <h2 id="memory-saved-heading">已留下</h2>
              </div>
              <strong>{String(confirmedItems.length).padStart(2, "0")}</strong>
            </div>
            {confirmedItems.length ? (
              <div className={styles.fragmentList}>
                {confirmedItems.map((item) => (
                  <MemoryCard key={item.id} item={item} busy={busyId !== null} spaceId={selectedSpaceId} run={run} />
                ))}
              </div>
            ) : (
              <EmptyState title="还没有留下任何记忆" description="确认一条候选后，它会从待校准区移到这里。" />
            )}
          </section>
        </>
      )}
    </section>
  );
}
