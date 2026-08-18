"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useState } from "react";

import { EmptyState, ErrorCallout, LoadingState, StatusBadge } from "@/components/ui";
import { createSpace, deleteSpace, listSpaces } from "@/lib/api";
import { formatDateTime, joinCompact } from "@/lib/format";
import type { StudySpaceSummary } from "@/lib/types";

import styles from "./spaces-panel.module.css";

function getKnowledgeLabel(status: string | null | undefined) {
  return status === "ready" ? "已有资料" : "暂无资料";
}

export function SpacesPanel() {
  const router = useRouter();
  const [spaces, setSpaces] = useState<StudySpaceSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [theme, setTheme] = useState("");
  const [goal, setGoal] = useState("");
  const [createOpen, setCreateOpen] = useState(true);

  async function refresh() {
    setLoading(true);
    try {
      const next = await listSpaces();
      setSpaces(next);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "空间列表加载失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(max-width: 760px)");
    const syncDisclosure = () => setCreateOpen(!mediaQuery.matches);
    syncDisclosure();
    mediaQuery.addEventListener("change", syncDisclosure);
    return () => mediaQuery.removeEventListener("change", syncDisclosure);
  }, []);

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    if (!title.trim()) {
      return;
    }
    setBusy(true);
    try {
      await createSpace({
        title,
        theme: theme || undefined,
        goal: goal || undefined,
      });
      setTitle("");
      setTheme("");
      setGoal("");
      await refresh();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "创建空间失败");
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(spaceId: string, spaceTitle: string) {
    if (!window.confirm(`确定删除“${spaceTitle}”吗？空间内的资料和会话将一起移除。`)) {
      return;
    }
    setBusy(true);
    try {
      await deleteSpace(spaceId);
      await refresh();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "删除空间失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={`${styles.page} page-stack`}>
      <header className={styles.intro}>
        <div>
          <span className={styles.kicker}>THEME MAP · 学习地图</span>
          <h1>学习空间</h1>
        </div>
        <p>每个主题都是一段独立旅程。资料、会话与记忆留在各自的世界里，搭档会陪你从上次停下的地方继续。</p>
      </header>

      {error ? <ErrorCallout message={error} /> : null}

      <section className={styles.directory} aria-labelledby="spaces-heading">
        <div className={styles.sectionHeading}>
          <h2 id="spaces-heading">你的空间</h2>
          {!loading && spaces.length ? <span>{spaces.length} 个</span> : null}
        </div>

        {loading ? (
          <LoadingState label="正在读取空间..." />
        ) : spaces.length ? (
          <div className={styles.spaceList}>
            {spaces.map((space, index) => (
              <article key={space.id} className={`${styles.spaceRow} ${index === 0 ? styles.featured : ""} info-card`}>
                {index === 0 ? (
                  <div className={styles.companionStage} aria-hidden="true">
                    <span className={`app-pet-portrait ${styles.heroPet}`} />
                    <span className={styles.compassMark} />
                    <span className={styles.stageCaption}>CURRENT THEME</span>
                  </div>
                ) : (
                  <span className={styles.routeNode} aria-hidden="true">{String(index).padStart(2, "0")}</span>
                )}
                <div className={styles.spaceMain}>
                  {index === 0 ? <span className={styles.currentLabel}>正在同行</span> : null}
                  <div className={styles.spaceTitleRow}>
                    <Link href={`/spaces/${space.id}`} className={styles.spaceTitle}>
                      <strong>{space.title}</strong>
                    </Link>
                    <StatusBadge label={getKnowledgeLabel(space.knowledge_status)} tone="muted" />
                  </div>
                  <p className={styles.goal}>{space.goal || "还没有写空间目标。"}</p>
                  <p className={styles.meta}>
                    {joinCompact([space.theme || null, `${space.material_count ?? 0} 份资料`, `${space.session_count ?? 0} 场会话`])}
                  </p>
                  <span className={styles.updated}>更新于 {formatDateTime(space.updated_at)}</span>
                </div>

                <div className={styles.actions}>
                  {index === 0 ? (
                    <button type="button" className="primary-button" onClick={() => router.push(`/spaces/${space.id}/call`)}>
                      和搭档继续
                    </button>
                  ) : (
                    <Link href={`/spaces/${space.id}`} className="ghost-button subtle-link">
                      进入主题
                    </Link>
                  )}
                  {index === 0 ? (
                    <Link href={`/spaces/${space.id}`} className={styles.textAction}>
                      查看主题档案
                    </Link>
                  ) : null}
                  <details className={styles.moreActions}>
                    <summary aria-label={`${space.title}的更多操作`} title="更多操作">•••</summary>
                    <div>
                      {index !== 0 ? (
                        <button type="button" className="ghost-button subtle-link" onClick={() => router.push(`/spaces/${space.id}/call`)}>
                          开始会话
                        </button>
                      ) : null}
                      <button type="button" className="ghost-button danger-button" disabled={busy} onClick={() => void handleDelete(space.id, space.title)}>
                        删除
                      </button>
                    </div>
                  </details>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <EmptyState title="还没有任何学习空间" description="先建一个空间，才能在其中导入资料、绑定模型和选择角色。" />
        )}
      </section>

      <details
        className={styles.createDisclosure}
        open={createOpen}
        onToggle={(event) => setCreateOpen(event.currentTarget.open)}
      >
        <summary>开启新的主题旅程</summary>
        <div className={styles.createSection} aria-labelledby="create-space-heading">
          <div className={styles.createCopy}>
            <span className={styles.kicker}>NEW ROUTE</span>
            <h2 id="create-space-heading">创建学习空间</h2>
            <p>先为这段旅程起名。资料、模型与角色可以在进入空间后慢慢补全。</p>
          </div>
          <form className={styles.createForm} onSubmit={handleCreate}>
            <label className="field">
              <span>空间名称</span>
              <input autoComplete="off" name="space-title" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：日语听说 / 产品系统设计 / 算法刷题…" />
            </label>
            <label className="field">
              <span>主题</span>
              <input autoComplete="off" name="space-theme" value={theme} onChange={(event) => setTheme(event.target.value)} placeholder="主题氛围、课程方向或长期计划…" />
            </label>
            <label className="field">
              <span>目标</span>
              <input autoComplete="off" name="space-goal" value={goal} onChange={(event) => setGoal(event.target.value)} placeholder="例如：8 周内建立稳定复习节奏…" />
            </label>
            <button type="submit" className="primary-button" disabled={busy}>
              创建空间
            </button>
          </form>
        </div>
      </details>

      <details className={styles.rules}>
        <summary>空间如何保护学习边界</summary>
        <div className={styles.ruleList}>
          <div>
            <strong>知识库为空也能聊</strong>
            <p>但空间页会直接告诉你：本轮未使用空间资料。</p>
          </div>
          <div>
            <strong>引用必须由服务端生成</strong>
            <p>前端只展示真实命中的 citations，不伪造来源标签。</p>
          </div>
          <div>
            <strong>记忆要人工确认</strong>
            <p>尤其是敏感个人信息，必须先在记忆页确认后再长期保存。</p>
          </div>
        </div>
      </details>
    </section>
  );
}
