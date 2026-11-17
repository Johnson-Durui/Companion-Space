"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { listSpaces } from "@/lib/api";
import type { StudySpaceSummary } from "@/lib/types";

import styles from "./study-launcher.module.css";

export function StudyLauncher() {
  const [spaces, setSpaces] = useState<StudySpaceSummary[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function loadSpaces() {
    setLoading(true);
    setError(null);

    try {
      const nextSpaces = await listSpaces();
      setSpaces(nextSpaces);
      setSelectedId(nextSpaces[0]?.id ?? "");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "空间列表加载失败，请稍后重试。");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadSpaces();
  }, []);

  const selectedSpace = spaces.find((space) => space.id === selectedId) ?? spaces[0] ?? null;

  return (
    <section className={styles.page} aria-label="今天想在哪个空间一起学习？">
      <header className={styles.hero}>
        <div className={styles.heroGrid} aria-hidden="true" />
        <div className={styles.heroArtwork} aria-hidden="true">
          <span className={styles.orbit} />
          <span className={`app-pet-portrait ${styles.heroPet}`} />
          <span className={styles.presenceChip}>
            <span aria-hidden="true" />
            伙伴已准备好
          </span>
        </div>
        <div className={styles.heroCopy}>
          <p className={styles.eyebrow}><span>COMPANION ROUTE</span> / 今日出发</p>
          <h1 id="study-launcher-title">
            今天想学什么？
          </h1>
          <p>选好主题就出发。目标、资料和对话，我都会一起带上。</p>
          <div className={styles.routeSignal} aria-hidden="true">
            <span>选主题</span>
            <i />
            <span>出发</span>
          </div>
        </div>
      </header>

      {loading ? (
        <div className={styles.status} role="status" aria-live="polite">
          <span className={styles.spinner} aria-hidden="true" />
          <span>正在准备你的学习空间…</span>
        </div>
      ) : error ? (
        <div className={styles.error} role="alert">
          <div>
            <strong>暂时没能读取学习空间</strong>
            <p>{error}</p>
          </div>
          <button type="button" onClick={() => void loadSpaces()}>重试</button>
        </div>
      ) : spaces.length ? (
        <div className={styles.launcherBody}>
          <fieldset className={styles.choices}>
            <legend>
              <span><b>路线选择</b><small>决定今天与伙伴前往的学习区域</small></span>
              <em>{String(spaces.length).padStart(2, "0")} ROUTES</em>
            </legend>
            <div className={styles.choiceList}>
              {spaces.map((space, index) => (
                <label className={styles.choice} key={space.id}>
                  <input
                    checked={selectedId === space.id}
                    name="study-space"
                    onChange={() => setSelectedId(space.id)}
                    type="radio"
                    value={space.id}
                  />
                  <span className={styles.routeIndex} aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
                  <span className={styles.choiceCopy}>
                    <strong>{space.title}</strong>
                    <span>{space.goal || space.theme || "从一次轻松的共学开始。"}</span>
                    <span className={styles.choiceMeta}>
                      <span>{space.material_count ? `${space.material_count} 份资料` : "还没有资料"}</span>
                      <span>{space.session_count ? `${space.session_count} 次共学` : "第一次共学"}</span>
                    </span>
                  </span>
                  <span className={styles.radioMark} aria-hidden="true">✓</span>
                </label>
              ))}
            </div>
          </fieldset>

          <aside className={styles.launchDock} aria-live="polite">
            <span className={styles.compass} aria-hidden="true"><i /></span>
            <div className={styles.launchDockCopy}>
              <span>当前目的地</span>
              <strong>{selectedSpace?.title}</strong>
              <p>{selectedSpace?.goal || selectedSpace?.theme || "从一个轻松的问题开始今天的共学。"}</p>
            </div>
            <Link
              aria-label="开始共学"
              className={styles.primaryAction}
              href={`/spaces/${selectedId}/call`}
            >
              出发
              <span aria-hidden="true">↗</span>
            </Link>
          </aside>
        </div>
      ) : (
        <div className={styles.empty}>
          <span className={styles.emptyMark} aria-hidden="true">＋</span>
          <h2>先创建一个学习空间</h2>
          <p>空间会收好你的主题、目标和资料，创建后就能从这里一键开始共学。</p>
          <Link href="/spaces">去管理学习空间</Link>
        </div>
      )}
    </section>
  );
}
