"use client";

import Link from "next/link";
import { Button, Input } from "antd";
import type { InputRef } from "antd";
import { FormEvent, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { ApiError, getNeuralTtsSidecarStatus, getVaultStatus, initializeVault, lockVault, resetVault, unlockVault } from "@/lib/api";
import { getOwnerSessionToken, subscribeOwnerSession } from "@/lib/owner-session";
import type { NeuralTtsSidecarStatus, VaultStatus } from "@/lib/types";
import { ErrorCallout, LoadingState, PropertyList, SectionCard, StatusBadge } from "@/components/ui";

function vaultErrorMessage(error: unknown) {
  if (error instanceof ApiError) {
    if (error.message === "Vault already initialized") {
      return "Vault 已初始化，请直接输入原主密码解锁。";
    }
    if (error.message === "Invalid vault password") {
      return "主密码不正确，请检查后重试。";
    }
    if (error.message === "Vault is not initialized") {
      return "Vault 尚未初始化，请先设置主密码。";
    }
    if (["Owner session required", "Invalid owner session", "Vault is locked"].includes(error.message)) {
      return "当前解锁会话已失效，请重新解锁后再操作。";
    }
  }
  return error instanceof Error ? error.message : "Vault 操作失败";
}

export function VaultPanel() {
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [sidecar, setSidecar] = useState<NeuralTtsSidecarStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [initPassword, setInitPassword] = useState("");
  const [unlockPassword, setUnlockPassword] = useState("");
  const [resetPassword, setResetPassword] = useState("");
  const ownerToken = useSyncExternalStore(subscribeOwnerSession, getOwnerSessionToken, () => null);
  const refreshGenerationRef = useRef(0);
  const previousOwnerTokenRef = useRef(ownerToken);
  const initPasswordRef = useRef<InputRef>(null);
  const unlockPasswordRef = useRef<InputRef>(null);
  const browserUnlocked = status?.unlocked === true && Boolean(ownerToken);

  const refresh = useCallback(async () => {
    const generation = ++refreshGenerationRef.current;
    setLoading(true);
    try {
      const [next, nextSidecar] = await Promise.all([
        getVaultStatus(),
        getNeuralTtsSidecarStatus().catch(() => null),
      ]);
      if (generation !== refreshGenerationRef.current) {
        return;
      }
      setStatus(next);
      setSidecar(nextSidecar);
      setError(null);
    } catch (loadError) {
      if (generation !== refreshGenerationRef.current) {
        return;
      }
      setStatus(null);
      setError(loadError instanceof Error ? loadError.message : "Vault 状态加载失败");
    } finally {
      if (generation === refreshGenerationRef.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
    return () => {
      refreshGenerationRef.current += 1;
    };
  }, [refresh]);

  useEffect(() => {
    const previousOwnerToken = previousOwnerTokenRef.current;
    previousOwnerTokenRef.current = ownerToken;
    if (previousOwnerToken && !ownerToken) {
      setNotice(null);
      void refresh();
    }
  }, [ownerToken, refresh]);

  useEffect(() => {
    if (loading || browserUnlocked || !window.matchMedia("(min-width: 641px)").matches) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      if (status?.initialized) {
        unlockPasswordRef.current?.focus();
      } else {
        initPasswordRef.current?.focus();
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [browserUnlocked, loading, status?.initialized]);

  async function runAction(
    action: () => Promise<unknown>,
    successMessage: string,
    onSuccess?: () => void,
  ) {
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      await action();
      onSuccess?.();
      setNotice(successMessage);
      await refresh();
    } catch (actionError) {
      if (actionError instanceof ApiError && actionError.message === "Vault is not initialized") {
        await refresh();
      }
      setError(vaultErrorMessage(actionError));
    } finally {
      setBusy(false);
    }
  }

  function clearFeedback() {
    setError(null);
    setNotice(null);
  }

  function handleInit(event: FormEvent) {
    event.preventDefault();
    if (!initPassword.trim()) {
      return;
    }
    void runAction(
      () => initializeVault({ password: initPassword }),
      "Vault 已初始化。",
      () => setInitPassword(""),
    );
  }

  function handleUnlock(event: FormEvent) {
    event.preventDefault();
    if (!unlockPassword.trim()) {
      return;
    }
    void runAction(
      () => unlockVault({ password: unlockPassword }),
      "Vault 已解锁。",
      () => setUnlockPassword(""),
    );
  }

  function handleReset(event: FormEvent) {
    event.preventDefault();
    if (!resetPassword.trim()) {
      return;
    }
    void runAction(
      () => resetVault({ password: resetPassword }),
      "凭据已重置，学习数据应保持不变。",
      () => setResetPassword(""),
    );
  }

  return (
    <section className="page-stack">
      <header className="chapter-head">
        <p className="chapter-kicker">本地保险箱</p>
        <h1>先打开保险箱</h1>
        <p>主密码只用于本地加密凭据。浏览器不保存明文 API Key。</p>
      </header>

      <div className="vault-layout">
        <SectionCard
          eyebrow="入口"
          title={loading ? "Vault 入口" : browserUnlocked ? "Vault 已解锁" : status?.initialized ? "解锁 Vault" : "初始化 Vault"}
          hint={
            loading
              ? "正在确认当前状态。"
              : browserUnlocked
                ? "当前浏览器已获得临时 owner session，可以继续使用。"
                : status?.initialized
                  ? status.unlocked
                    ? "服务端仍保持解锁，但当前浏览器会话已失效，请重新输入主密码。"
                    : "Vault 已经初始化，只需输入原主密码。"
                  : "首次使用时设置一次主密码，之后只需要解锁。"
          }
        >
          <div className="stack-form">
            {error ? <ErrorCallout message={error} /> : null}
            {notice ? <div className="success-callout" role="status">{notice}</div> : null}
            {loading ? <LoadingState label="正在读取 Vault 状态..." /> : null}

            {!loading && status && !status.initialized ? (
              <form className="form-grid" aria-label="Vault 初始化" aria-busy={busy} onSubmit={handleInit}>
                <label className="field">
                  <span>初始化主密码</span>
                  <Input.Password
                    ref={initPasswordRef}
                    autoComplete="new-password"
                    minLength={8}
                    required
                    value={initPassword}
                    onChange={(event) => {
                      setInitPassword(event.target.value);
                      clearFeedback();
                    }}
                    placeholder="至少 8 位，仅用于本地加密"
                  />
                </label>
                <Button type="primary" htmlType="submit" loading={busy} disabled={busy || !initPassword.trim()}>
                  {busy ? "正在初始化..." : "初始化 Vault"}
                </Button>
              </form>
            ) : null}

            {!loading && status?.initialized && !browserUnlocked ? (
              <form className="form-grid" aria-label="Vault 解锁" aria-busy={busy} onSubmit={handleUnlock}>
                <label className="field">
                  <span>解锁主密码</span>
                  <Input.Password
                    ref={unlockPasswordRef}
                    autoComplete="current-password"
                    minLength={8}
                    required
                    value={unlockPassword}
                    onChange={(event) => {
                      setUnlockPassword(event.target.value);
                      clearFeedback();
                    }}
                    placeholder="输入原主密码"
                  />
                </label>
                <Button type="primary" htmlType="submit" loading={busy} disabled={busy || !unlockPassword.trim()}>
                  {busy ? "正在解锁..." : "解锁 Vault"}
                </Button>
              </form>
            ) : null}

            {!loading && browserUnlocked ? (
              <>
                <div className="success-callout" role="status">Vault 已就绪，可以进入 Companion Space。</div>
                <div className="inline-actions">
                  <Link className="primary-button" href="/">进入 Companion Space</Link>
                </div>
                <details className="info-card">
                  <summary>高级操作：重置 Vault</summary>
                  <p className="muted">需要当前主密码。此操作会清除 Provider 凭据并要求重新初始化，但不会删除学习空间和资料。</p>
                  <form className="form-grid" aria-label="Vault 重置" aria-busy={busy} onSubmit={handleReset}>
                    <label className="field">
                      <span>当前主密码</span>
                      <Input.Password
                        autoComplete="current-password"
                        minLength={8}
                        required
                        value={resetPassword}
                        onChange={(event) => {
                          setResetPassword(event.target.value);
                          clearFeedback();
                        }}
                        placeholder="验证后清除 Vault 凭据"
                      />
                    </label>
                    <Button danger htmlType="submit" loading={busy} disabled={busy || !resetPassword.trim()}>
                      {busy ? "正在重置..." : "重置 Vault"}
                    </Button>
                  </form>
                </details>
              </>
            ) : null}
          </div>
        </SectionCard>

        <SectionCard eyebrow="状态" title="当前 Vault" hint="状态由本地后端实时返回，不会把主密码保存到浏览器。">
          {loading ? (
            <LoadingState label="正在读取 Vault 状态..." />
          ) : status ? (
            <>
              <PropertyList
                entries={[
                  { label: "已初始化", value: <StatusBadge label={status.initialized ? "Yes" : "No"} tone={status.initialized ? "good" : "warn"} /> },
                  { label: "当前浏览器已授权", value: <StatusBadge label={browserUnlocked ? "Yes" : "No"} tone={browserUnlocked ? "good" : "warn"} /> },
                  {
                    label: "本地神经语音",
                    value: sidecar
                      ? <StatusBadge label={sidecar.ready ? "sidecar ready" : sidecar.enabled ? "enabled, not ready" : "未启用"} tone={sidecar.ready ? "good" : "warn"} />
                      : <StatusBadge label="状态未知" tone="muted" />,
                  },
                ]}
              />
              {sidecar ? <p className="micro-copy">{sidecar.how_to_switch}</p> : null}
              <div className="inline-actions">
                <Button disabled={!browserUnlocked || busy} loading={busy} onClick={() => void runAction(lockVault, "Vault 已锁定。")}>
                  {busy ? "处理中..." : "立即锁定"}
                </Button>
              </div>
            </>
          ) : (
            <p className="muted">服务端尚未提供 Vault 状态接口，当前前端已按新合同接线，等待后端落地。</p>
          )}
        </SectionCard>
      </div>
    </section>
  );
}
