"use client";

import { useEffect, useState } from "react";

import {
  getDashboardSnapshot,
  getLocalMetricsSummary,
  getNeuralTtsSidecarStatus,
} from "@/lib/api";
import type { LocalMetricsSummary, NeuralTtsSidecarStatus } from "@/lib/types";
import { StatCard, LoadingState, ErrorCallout } from "@/components/ui";

import styles from "./settings-overview.module.css";

export function SettingsOverview() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [metricsLoading, setMetricsLoading] = useState(true);
  const [metricsError, setMetricsError] = useState<string | null>(null);
  const [localMetrics, setLocalMetrics] = useState<LocalMetricsSummary | null>(null);
  const [providerCount, setProviderCount] = useState(0);
  const [spaceCount, setSpaceCount] = useState(0);
  const [vaultState, setVaultState] = useState("Unavailable");
  const [sidecar, setSidecar] = useState<NeuralTtsSidecarStatus | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadSnapshot() {
      setLoading(true);
      try {
        const snapshot = await getDashboardSnapshot();
        if (!cancelled) {
          setProviderCount(snapshot.providers.length);
          setSpaceCount(snapshot.spaces.length);
          setVaultState(snapshot.vault ? (snapshot.vault.unlocked ? "Unlocked" : "Locked") : "Unavailable");
          setError(null);
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : "设置总览加载失败");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    async function loadMetrics() {
      setMetricsLoading(true);
      try {
        const metrics = await getLocalMetricsSummary();
        if (!cancelled) {
          setLocalMetrics(metrics);
          setMetricsError(null);
        }
      } catch (loadError) {
        if (!cancelled) {
          setLocalMetrics(null);
          setMetricsError(loadError instanceof Error ? loadError.message : "本地指标加载失败");
        }
      } finally {
        if (!cancelled) {
          setMetricsLoading(false);
        }
      }
    }

    async function loadSidecar() {
      try {
        const status = await getNeuralTtsSidecarStatus();
        if (!cancelled) {
          setSidecar(status);
        }
      } catch {
        if (!cancelled) {
          setSidecar(null);
        }
      }
    }

    void loadSnapshot();
    void loadMetrics();
    void loadSidecar();
    return () => {
      cancelled = true;
    };
  }, []);

  const activationCompleted = localMetrics
    ? Object.values(localMetrics.activation).filter((count) => count > 0).length
    : 0;
  const reliabilityIssueCount = localMetrics
    ? Object.values(localMetrics.reliability).reduce((total, count) => total + count, 0)
    : 0;

  function formatRate(value: number | null | undefined) {
    return typeof value === "number" ? `${(value * 100).toFixed(1)}%` : "No sample";
  }

  return (
    <section className={`${styles.page} page-stack`}>
      <header className={styles.header}>
        <p className={styles.kicker}>本机档案</p>
        <h1>偏好与设置</h1>
        <p>查看本地存储、模型服务和运行状态。</p>
        <dl className={styles.facts} aria-label="当前本机状态">
          <div>
            <dt>保险箱</dt>
            <dd>{vaultState}</dd>
          </div>
          <div>
            <dt>模型连接</dt>
            <dd>{providerCount}</dd>
          </div>
          <div>
            <dt>学习空间</dt>
            <dd>{spaceCount}</dd>
          </div>
        </dl>
      </header>

      {error ? <ErrorCallout message={error} /> : null}
      {loading ? <LoadingState label="正在汇总设置..." /> : null}

      <section className={styles.block} aria-labelledby="data-defaults-title">
        <h2 id="data-defaults-title">默认怎么保存</h2>
        <p>这些规则直接影响你对本地数据的预期。</p>
        <div className={styles.policyRow}>
          <strong>原始音频默认不保留</strong>
          <p>只保留最终字幕、摘要、记忆和复习项。</p>
        </div>
        <div className={styles.policyRow}>
          <strong>资料、字幕和数据库默认本地明文</strong>
          <p>API Key 单独加密，前端用保险箱流程提醒这一点。</p>
        </div>
      </section>

      <section className={styles.block} aria-labelledby="local-signals-title">
        <h2 id="local-signals-title">本机信号</h2>
        <p>只在本机聚合枚举事件、ID 和数值；不采集 Prompt、资料正文、字幕正文或 Key。</p>
        {metricsError ? (
          <ErrorCallout message={`本地指标当前不可用：${metricsError}`} />
        ) : null}
        <div className={styles.policyRow}>
          <strong>Activation {activationCompleted}/7</strong>
          <p>保险箱、Mock/Provider、空间、资料、角色、会话结束和复盘查看构成本地漏斗。</p>
        </div>
        <div className="mini-metrics">
          <StatCard
            label="API errors"
            value={formatRate(localMetrics?.rates.api_error_rate)}
            detail={`${localMetrics?.reliability.api_error ?? 0} 次`}
          />
          <StatCard
            label="Citation accuracy"
            value={formatRate(localMetrics?.rates.citation_accuracy)}
            detail={`${localMetrics?.quality.citation_verified.matched ?? 0}/${localMetrics?.quality.citation_verified.total ?? 0} 命中可回溯`}
          />
          <StatCard
            label="Memory confirm"
            value={formatRate(localMetrics?.rates.memory_confirmation_rate)}
            detail={`${localMetrics?.quality.memory_candidate_confirmed ?? 0} 确认 / ${localMetrics?.quality.memory_candidate_rejected ?? 0} 拒绝`}
          />
        </div>
        <div className={styles.policyRow}>
          <strong>可靠性事件 {reliabilityIssueCount} 次</strong>
          <p>
            WS 错误 {localMetrics?.reliability.ws_error ?? 0} · 索引失败{" "}
            {localMetrics?.reliability.ingestion_failed ?? 0} · 模型超时{" "}
            {localMetrics?.reliability.model_timeout ?? 0} · 文字回退{" "}
            {localMetrics?.reliability.text_fallback_used ?? 0}
          </p>
        </div>
        <div className={styles.policyRow}>
          <strong>性能证据</strong>
          <p>
            {metricsLoading
              ? "正在加载本地性能信号…"
              : `插话 P50 ${localMetrics?.performance.interrupt_latency_ms.p50 ?? "待采样"} ms · 首音频 P50 ${localMetrics?.performance.first_audio_latency_ms.p50 ?? "待采样"} ms · 角色 FPS P50 ${localMetrics?.performance.avatar_fps.p50 ?? "待采样"}`}
          </p>
        </div>
      </section>

      <section className={styles.block} aria-labelledby="voice-title">
        <h2 id="voice-title">本地神经语音</h2>
        <p>不解锁保险箱也能看 sidecar 是否 ready。不会改写已有 Mock 空间。</p>
        <div className={styles.policyRow}>
          <strong>{sidecar?.ready ? "sidecar ready" : sidecar?.enabled ? "已启用但未 ready" : "未探测到 sidecar"}</strong>
          <p>
            {sidecar
              ? sidecar.how_to_switch
              : "打开保险箱页或本页可再次探测。本机 sidecar 默认在 127.0.0.1:8001。"}
          </p>
        </div>
      </section>

      <section className={styles.block} aria-labelledby="mobile-title">
        <h2 id="mobile-title">移动设备</h2>
        <p>一次性配对、可信设备查看与撤销都只允许本机拥有者操作。</p>
      </section>

      <section className={styles.block} aria-labelledby="release-title">
        <h2 id="release-title">当前项目边界</h2>
        <p>这是前端根据现有仓库状态直说的结论。</p>
        <div className={styles.policyRow}>
          <strong>空间数</strong>
          <p>{spaceCount} 个。空间化信息架构已经替换旧单聊天页。</p>
        </div>
        <div className={styles.policyRow}>
          <strong>Provider 连接数</strong>
          <p>{providerCount} 个。模型能力绑定已经按空间能力位组织，不再把角色和模型硬耦合在一起。</p>
        </div>
      </section>
    </section>
  );
}
