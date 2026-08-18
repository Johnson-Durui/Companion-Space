"use client";

import { useCallback, useEffect, useState } from "react";

import {
  ApiError,
  createMobilePairingChallenge,
  listMobileDevices,
  revokeMobileDevice,
} from "@/lib/api";
import type { MobileDevice, MobilePairingChallenge } from "@/lib/types";
import { ErrorCallout, LoadingState } from "@/components/ui";

const LOCAL_OWNER_MESSAGE = "只有已解锁 Vault 的本机浏览器才能管理移动设备。";

function messageFor(error: unknown, fallback: string) {
  if (error instanceof ApiError && error.status === 403) {
    return LOCAL_OWNER_MESSAGE;
  }
  return error instanceof Error ? error.message : fallback;
}

function formatDateTime(value: string) {
  return new Date(value).toLocaleString();
}

export function MobileDeviceSettings() {
  const [devices, setDevices] = useState<MobileDevice[] | null>(null);
  const [challenge, setChallenge] = useState<MobilePairingChallenge | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const loadDevices = useCallback(async () => {
    setLoading(true);
    try {
      setDevices(await listMobileDevices());
      setError(null);
    } catch (loadError) {
      setDevices(null);
      setError(messageFor(loadError, "移动设备列表加载失败"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadDevices();
  }, [loadDevices]);

  async function handleCreateChallenge() {
    setCreating(true);
    setNotice(null);
    setCopied(false);
    try {
      setChallenge(await createMobilePairingChallenge());
      setError(null);
    } catch (createError) {
      setChallenge(null);
      setError(messageFor(createError, "一次性配对码生成失败"));
    } finally {
      setCreating(false);
    }
  }

  async function handleCopyPairingCode() {
    if (!challenge) return;
    try {
      await navigator.clipboard.writeText(challenge.code);
      setCopied(true);
      setError(null);
    } catch (copyError) {
      setCopied(false);
      setError(messageFor(copyError, "复制失败，请使用下方 8 位配对码手动输入。"));
    }
  }

  async function handleRevoke(device: MobileDevice) {
    if (!window.confirm(`撤销“${device.name}”的访问权限？该设备需要重新配对才能使用。`)) {
      return;
    }
    setRevokingId(device.id);
    setNotice(null);
    try {
      await revokeMobileDevice(device.id);
      setDevices((current) => current?.filter((item) => item.id !== device.id) ?? []);
      setError(null);
      setNotice(`已撤销“${device.name}”。`);
    } catch (revokeError) {
      setError(messageFor(revokeError, "撤销移动设备失败"));
    } finally {
      setRevokingId(null);
    }
  }

  return (
    <div className="stack-list">
      <div className="list-row compact">
        <div>
          <strong>本机拥有者管理</strong>
          <p>{LOCAL_OWNER_MESSAGE} 移动端访问令牌不能生成配对码、查看设备或撤销设备。</p>
        </div>
      </div>

      <div className="inline-actions">
        <button
          type="button"
          className="primary-button"
          disabled={creating}
          onClick={() => void handleCreateChallenge()}
        >
          {creating ? "生成中..." : "生成一次性 8 位配对码"}
        </button>
        <button
          type="button"
          className="ghost-button"
          disabled={loading}
          onClick={() => void loadDevices()}
        >
          {loading ? "刷新中..." : "刷新设备"}
        </button>
      </div>

      {challenge ? (
        <div className="qr-placeholder" aria-live="polite">
          <p className="muted">在移动 App 中输入此一次性配对码</p>
          <strong data-testid="mobile-pairing-code">{challenge.code}</strong>
          <button
            type="button"
            className="primary-button"
            data-testid="copy-mobile-pairing-code"
            onClick={() => void handleCopyPairingCode()}
          >
            {copied ? "已复制配对码" : "复制 8 位配对码"}
          </button>
          <dl className="meta-list wide">
            <div>
              <dt>有效期至</dt>
              <dd>{formatDateTime(challenge.expires_at)}</dd>
            </div>
            <div>
              <dt>剩余尝试</dt>
              <dd>{challenge.attempts_allowed} 次（新生成）</dd>
            </div>
          </dl>
          <p className="muted">请勿转发；生成新码或到期后应停止使用旧码。</p>
        </div>
      ) : null}

      {notice ? <p className="success-callout" role="status">{notice}</p> : null}
      {error ? <ErrorCallout message={error} /> : null}
      {loading && devices === null ? <LoadingState label="正在加载已配对设备..." /> : null}

      {!loading && devices?.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-copy">
            <strong>还没有已配对设备</strong>
            <p>在上方生成一次性配对码，再到 iOS 或 Android App 中完成配对。</p>
          </div>
        </div>
      ) : null}

      {devices?.map((device) => (
        <div className="list-row" key={device.id}>
          <div>
            <strong>{device.name}</strong>
            <p>最近使用：{formatDateTime(device.last_seen_at)}</p>
            <p className="muted">
              配对于 {formatDateTime(device.created_at)} · 凭据有效期至 {formatDateTime(device.refresh_expires_at)}
            </p>
          </div>
          <button
            type="button"
            className="ghost-button danger-button"
            disabled={revokingId === device.id}
            aria-label={`撤销设备 ${device.name}`}
            onClick={() => void handleRevoke(device)}
          >
            {revokingId === device.id ? "撤销中..." : "撤销"}
          </button>
        </div>
      ))}
    </div>
  );
}
