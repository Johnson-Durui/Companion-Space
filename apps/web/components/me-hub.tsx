"use client";

import Link from "next/link";
import { Skeleton } from "antd";
import { useEffect, useState } from "react";

import { getVaultStatus, listCharacters, listProviders } from "@/lib/api";

import styles from "./me-hub.module.css";

interface MeSummary {
  characterCount: number | null;
  characterName: string | null;
  providerCount: number | null;
  vaultLabel: string;
  vaultTone: "success" | "warning" | "default";
}

const initialSummary: MeSummary = {
  characterCount: null,
  characterName: null,
  providerCount: null,
  vaultLabel: "状态读取中",
  vaultTone: "default",
};

export function MeHub() {
  const [summary, setSummary] = useState(initialSummary);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;

    void Promise.allSettled([
      getVaultStatus(),
      listCharacters(),
      listProviders(),
    ]).then(([vaultResult, charactersResult, providersResult]) => {
      if (!active) {
        return;
      }

      const vault = vaultResult.status === "fulfilled" ? vaultResult.value : null;
      const characters = charactersResult.status === "fulfilled" ? charactersResult.value : null;
      setSummary({
        characterCount: characters?.length ?? null,
        characterName: characters?.[0]?.name ?? null,
        providerCount: providersResult.status === "fulfilled" ? providersResult.value.length : null,
        vaultLabel: vault
          ? !vault.initialized
            ? "待初始化"
            : vault.unlocked
              ? "已解锁"
              : "已锁定"
          : "状态暂不可用",
        vaultTone: vault?.unlocked ? "success" : vault ? "warning" : "default",
      });
      setLoading(false);
    });

    return () => {
      active = false;
    };
  }, []);

  const characterStatus = summary.characterCount === null
    ? "角色信息暂不可用"
    : summary.characterCount
      ? `已保存 ${summary.characterCount} 个角色`
      : "还没有角色，先创建一个学习搭子";

  return (
    <section className={styles.page} aria-labelledby="me-title">
      <header className={styles.header}>
        <div>
          <p className={styles.pageIndex}>PROFILE / 01</p>
          <h1 id="me-title">我的</h1>
        </div>
        <p>角色档案、声音与本机设置，都收在这里。</p>
      </header>

      <article className={styles.characterEntry}>
        <span className={styles.sceneLabel} aria-hidden="true">CURRENT COMPANION</span>
        <div className={styles.characterMark} aria-hidden="true">
          <span className={styles.characterOrbit} />
          <span className="app-pet-portrait" />
        </div>
        <div className={styles.characterCopy}>
          <p className={styles.kicker}>同行角色</p>
          <h2>{loading ? "正在找你的伙伴…" : summary.characterName || "创建你的第一个学习搭子"}</h2>
          {loading ? (
            <Skeleton active paragraph={{ rows: 1 }} title={false} />
          ) : (
            <p>{characterStatus}</p>
          )}
          <div className={styles.profileSignal} aria-hidden="true">
            <span>LOCAL</span><i /><span>READY</span>
          </div>
        </div>
        <div className={styles.characterActions}>
          <Link className={styles.primaryAction} href="/characters">管理角色</Link>
          <Link className={styles.secondaryAction} href="/characters#new-character">创建新角色</Link>
        </div>
      </article>

      <div className={styles.sectionHeading}>
        <span>系统菜单</span>
        <small>DEVICE SETTINGS</small>
      </div>
      <nav className={styles.ledger} aria-label="我的设置目录">
        <Link className={styles.ledgerRow} href="/providers">
          <span className={styles.rowIcon} aria-hidden="true"><b>01</b><i>VOICE</i></span>
          <span className={styles.rowCopy}>
            <strong>声音与模型</strong>
            <span>管理对话、识别与语音服务</span>
          </span>
          <span className={styles.rowStatus}>{loading ? "读取中" : summary.providerCount === null ? "暂不可用" : `${summary.providerCount} 项`}</span>
          <span className={styles.arrow} aria-hidden="true">›</span>
        </Link>

        <Link className={styles.ledgerRow} href="/vault">
          <span className={styles.rowIcon} aria-hidden="true"><b>02</b><i>VAULT</i></span>
          <span className={styles.rowCopy}>
            <strong>本地安全</strong>
            <span>主密码、解锁与本地凭据</span>
          </span>
          <span className={styles.rowStatus} data-tone={summary.vaultTone}>{loading ? "读取中" : summary.vaultLabel}</span>
          <span className={styles.arrow} aria-hidden="true">›</span>
        </Link>

        <Link className={styles.ledgerRow} href="/settings">
          <span className={styles.rowIcon} aria-hidden="true"><b>03</b><i>LOCAL</i></span>
          <span className={styles.rowCopy}>
            <strong>偏好与本机状态</strong>
            <span>调整陪伴偏好，查看运行环境</span>
          </span>
          <span className={styles.arrow} aria-hidden="true">›</span>
        </Link>
      </nav>

      <p className={styles.footnote}>角色与凭据都保存在你的本机环境中。</p>
    </section>
  );
}
