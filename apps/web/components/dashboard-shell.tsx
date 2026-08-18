"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { ApiError, createSpace, getDashboardSnapshot } from "@/lib/api";
import { formatDateTime, joinCompact } from "@/lib/format";
import type { DashboardSnapshot } from "@/lib/types";
import { EmptyState, ErrorCallout, LoadingState, QuickLink, SectionCard, StatusBadge } from "@/components/ui";

function latestRecord<T extends { created_at?: string | null; updated_at?: string | null }>(records: T[]) {
  return records.reduce<T | undefined>((latest, record) => {
    if (!latest) {
      return record;
    }
    return (record.updated_at ?? record.created_at ?? "") > (latest.updated_at ?? latest.created_at ?? "")
      ? record
      : latest;
  }, undefined);
}

export function DashboardShell({ displayName }: { displayName: string }) {
  const router = useRouter();
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [vaultBlocked, setVaultBlocked] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const next = await getDashboardSnapshot();
        if (!cancelled) {
          setSnapshot(next);
          setVaultBlocked(false);
          setError(null);
        }
      } catch (loadError) {
        if (!cancelled) {
          const needsVault = loadError instanceof ApiError && (
            loadError.status === 401
            || ["Owner session required", "Invalid owner session", "Vault is locked"].includes(loadError.message)
          );
          setSnapshot(null);
          setVaultBlocked(needsVault);
          setError(needsVault ? null : loadError instanceof Error ? loadError.message : "总览加载失败");
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const vaultReady = snapshot?.vault?.initialized && snapshot.vault.unlocked;
  const activeSession = snapshot
    ? latestRecord(snapshot.sessions.filter((session) => session.state !== "closed"))
    : undefined;
  const recentSpace = snapshot ? latestRecord(snapshot.spaces) : undefined;
  const companionName = activeSession?.character_name || snapshot?.characters[0]?.name || "伙伴";
  const launcherLabel = vaultBlocked
    ? "打开本地保险箱"
    : !snapshot
    ? "正在读取最近会话…"
    : activeSession
      ? "继续最近会话"
      : recentSpace
        ? `进入 ${recentSpace.title}`
        : "创建空间并开始";
  const launcherHint = vaultBlocked
    ? "本地凭据仍处于锁定状态。完成初始化或解锁后，再读取空间、角色和会话。"
    : !snapshot
    ? "正在检查可继续的会话和最近使用的空间。"
    : activeSession
      ? `${activeSession.title} · ${activeSession.space_title || "最近空间"}`
      : recentSpace
        ? "直接进入文字陪伴；只有主动开启实时连接时才会请求麦克风权限。"
        : "会先创建一个空白本地空间；第一条消息发出时才创建会话。";
  const companionMessage = vaultBlocked
    ? "先把本地保险箱打开，我会在这里等你。"
    : !snapshot
      ? "我正在把上次的进度找回来，很快就好。"
      : activeSession
        ? `“${activeSession.title}”还停在上次的位置，我们接着来。`
        : recentSpace
          ? `“${recentSpace.title}”已经摊开了，随时可以开始。`
          : "想学什么都可以，我会陪你从第一句开始。";
  const currentRoute = vaultBlocked
    ? "本地安全入口"
    : activeSession?.space_title || recentSpace?.title || "第一段同行旅程";
  const routeStatus = vaultBlocked
    ? "等待解锁"
    : activeSession
      ? "会话仍在进行"
      : recentSpace
        ? `${recentSpace.material_count ?? 0} 份资料已就位`
        : "从空白地点出发";

  async function handleLaunch() {
    if (!snapshot || launching) {
      return;
    }

    setLaunching(true);
    setLaunchError(null);
    try {
      if (activeSession) {
        router.push(`/spaces/${activeSession.space_id}/call?session=${encodeURIComponent(activeSession.id)}`);
        return;
      }

      const space = recentSpace ?? await createSpace({
        name: "我的陪伴空间",
        topic: "自由陪伴",
        goal: "先从一段轻松的文字对话开始",
      });
      router.push(`/spaces/${space.id}/call`);
    } catch (actionError) {
      setLaunchError(actionError instanceof Error ? actionError.message : "陪伴空间启动失败");
      setLaunching(false);
    }
  }

  return (
    <section className="page-stack dashboard-home">
      <section className="dashboard-stage" aria-labelledby="dashboard-title">
        <div className="dashboard-stage-copy">
          <p className="dashboard-greeting">DAY ROUTE · {displayName}</p>
          <h1 id="dashboard-title">今天，和{companionName}去哪里？</h1>
          <p>角色已经在场。继续上次的章节，或挑一个新的主题一起出发。</p>
          <div className="dashboard-route" aria-label="当前同行路线">
            <span className="dashboard-route-mark" aria-hidden="true" />
            <span>
              <small>当前地点</small>
              <strong>{currentRoute}</strong>
            </span>
            <em>{routeStatus}</em>
          </div>
        </div>
        <div className="dashboard-stage-visual" aria-hidden="true">
          <span className="dashboard-compass" />
          <span className="dashboard-presence"><i aria-hidden="true" />{companionName}在这里</span>
        </div>
        <p className="dashboard-stage-bubble" aria-live="polite">{companionMessage}</p>
      </section>

      {error ? <ErrorCallout message={error} /> : null}

      <section className="companion-bookmark dashboard-companion" aria-label="伙伴便签">
        <div className="companion-bookmark-copy">
          <p className="dashboard-next-label">NEXT CHAPTER · 接着上次</p>
          <h2>{vaultBlocked ? "先打开本地保险箱" : activeSession?.title || recentSpace?.title || "从一张空白书签开始"}</h2>
          <p className="muted">{launcherHint}</p>
          <dl className="companion-bookmark-facts">
            <div>
              <dt>本地状态</dt>
              <dd>{vaultBlocked ? "需要解锁" : snapshot?.vault ? (vaultReady ? "已经准备好" : "需要解锁") : "正在准备"}</dd>
            </div>
            <div>
              <dt>空间资料</dt>
              <dd>{recentSpace ? `${recentSpace.material_count ?? 0} 份，按空间隔离` : "尚未建立空间"}</dd>
            </div>
            <div>
              <dt>陪伴角色</dt>
              <dd>{activeSession?.character_name || (snapshot?.characters.length ? `${snapshot.characters.length} 个可选角色` : "尚未选择")}</dd>
            </div>
          </dl>
        </div>
        <div className="companion-bookmark-action">
          {vaultBlocked ? (
            <Link href="/vault" className="primary-button" aria-label="初始化或解锁 Vault">
              <span>{launcherLabel}</span>
              <span aria-hidden="true">→</span>
            </Link>
          ) : (
            <button
              type="button"
              className="primary-button"
              aria-label={activeSession ? "继续陪伴" : "开始陪伴"}
              aria-busy={launching}
              disabled={!snapshot || launching}
              onClick={() => void handleLaunch()}
            >
              <span>{launching ? "正在准备…" : launcherLabel}</span>
              <span aria-hidden="true">→</span>
            </button>
          )}
          {launchError ? <ErrorCallout message={launchError} /> : null}
        </div>
      </section>

      <details className="dashboard-more">
        <summary>首次设置与更多信息</summary>
        <div className="dashboard-more-content">
      <div className="content-grid two-up dashboard-setup">
        <SectionCard
          eyebrow="推荐顺序"
          title="第一次启动"
          hint="按这个顺序走，可以最快从空仓库进入可测试状态。"
        >
          <div className="quick-link-grid">
            <QuickLink href="/vault" title="1. 初始化 Vault" description="设置主密码，确认浏览器不保存明文 Key。" />
            <QuickLink href="/providers" title="2. 接入模型" description="把 OpenAI-compatible、Anthropic、Gemini 或 ElevenLabs 接进来。" />
            <QuickLink href="/spaces" title="3. 新建学习空间" description="先空白，再导入资料、绑定角色和默认模型。" />
            <QuickLink href="/characters" title="4. 选择角色" description="可爱、酷、元气或温柔，基础配方先从文本参数开始。" />
          </div>
        </SectionCard>

        <SectionCard
          eyebrow="最近状态"
          title="当前环境"
          hint="这里显示已经有数据的模块，帮助你判断下一步该补哪里。"
        >
          {vaultBlocked ? (
            <EmptyState
              title="先解锁，再读取本地环境"
              description="Vault 解锁后，这里会显示空间、Provider 与最近会话。"
              action={<Link href="/vault" className="ghost-button">前往安全内核</Link>}
            />
          ) : !snapshot ? (
            <LoadingState label="正在聚合总览..." />
          ) : (
            <div className="stack-list">
              <div className="list-row">
                <div>
                  <strong>Vault</strong>
                  <p>{snapshot.vault ? "读取成功" : "后端未返回 /api/v1/vault/status"}</p>
                </div>
                <StatusBadge
                  label={snapshot.vault ? (snapshot.vault.unlocked ? "Unlocked" : "Locked") : "Unavailable"}
                  tone={snapshot.vault ? (snapshot.vault.unlocked ? "good" : "warn") : "muted"}
                />
              </div>
              <div className="list-row">
                <div>
                  <strong>空间</strong>
                  <p>{snapshot.spaces.length ? `最近更新 ${formatDateTime(snapshot.spaces[0]?.updated_at)}` : "还没有创建空间"}</p>
                </div>
                <StatusBadge label={`${snapshot.spaces.length} 个`} tone="default" />
              </div>
              <div className="list-row">
                <div>
                  <strong>Provider</strong>
                  <p>{snapshot.providers.length ? joinCompact(snapshot.providers[0]?.capabilities ?? []) : "尚未接入任何模型"}</p>
                </div>
                <StatusBadge label={`${snapshot.providers.length} 个`} tone="default" />
              </div>
              <div className="list-row">
                <div>
                  <strong>最近会话</strong>
                  <p>{snapshot.sessions.length ? snapshot.sessions[0]?.title : "还没有复盘记录"}</p>
                </div>
                <StatusBadge label={`${snapshot.sessions.length} 条`} tone="default" />
              </div>
            </div>
          )}
        </SectionCard>
      </div>

      <div className="content-grid two-up dashboard-secondary">
        <SectionCard eyebrow="空间" title="学习空间" hint="每个空间有独立资料、模型绑定、会话与记忆边界。">
          {vaultBlocked ? (
            <EmptyState title="空间仍在本地等待" description="解锁 Vault 后再读取或创建学习空间。" />
          ) : !snapshot ? (
            <LoadingState />
          ) : snapshot.spaces.length ? (
            <div className="card-grid">
              {snapshot.spaces.slice(0, 4).map((space) => (
                <article key={space.id} className="info-card">
                  <div className="card-row">
                    <strong>{space.title}</strong>
                    <StatusBadge label={space.knowledge_status || "blank"} tone="muted" />
                  </div>
                  <p>{space.goal || "还没有写目标。"}</p>
                  <p className="muted">{joinCompact([space.theme || null, `${space.material_count ?? 0} 份资料`, `${space.session_count ?? 0} 场会话`])}</p>
                </article>
              ))}
            </div>
          ) : (
            <EmptyState title="空白空间正是设计目标" description="先建一个主题，再慢慢塞进自己的资料和角色，而不是被预置课程牵着走。" />
          )}
        </SectionCard>

        <SectionCard eyebrow="会话" title="会话与复盘" hint="实时音频组件会插在会话页；这里先展示摘要与复盘入口。">
          {vaultBlocked ? (
            <EmptyState title="复盘尚未读取" description="解锁 Vault 后，会话与复盘会从本地安全载入。" />
          ) : !snapshot ? (
            <LoadingState />
          ) : snapshot.sessions.length ? (
            <div className="stack-list">
              {snapshot.sessions.slice(0, 4).map((session) => (
                <div key={session.id} className="list-row">
                  <div>
                    <strong>{session.title}</strong>
                    <p>{joinCompact([session.space_title || null, session.character_name || null, formatDateTime(session.updated_at)])}</p>
                  </div>
                  <div className="inline-actions">
                    <StatusBadge label={session.state} tone={session.state === "closed" ? "muted" : "good"} />
                    {session.state === "closed" ? (
                      <Link href={`/sessions/${session.id}`} className="ghost-button subtle-link">
                        查看复盘
                      </Link>
                    ) : (
                      <Link
                        href={`/spaces/${session.space_id}/call?session=${encodeURIComponent(session.id)}`}
                        className="ghost-button subtle-link"
                      >
                        继续
                      </Link>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState title="还没有任何复盘" description="完成一次通话后，这里会出现字幕、引用、记忆候选与复习项。" />
          )}
        </SectionCard>
      </div>
        </div>
      </details>
    </section>
  );
}
