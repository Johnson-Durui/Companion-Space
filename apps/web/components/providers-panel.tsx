"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

import {
  createProvider,
  deleteProvider,
  discoverProviderModels,
  listProviderRegistry,
  listProviders,
  testProvider,
  updateProvider,
} from "@/lib/api";
import { formatDateTime, joinCompact } from "@/lib/format";
import type {
  ProviderConnection,
  ProviderRegistryEntry,
  ProviderTestResult,
} from "@/lib/types";
import {
  EmptyState,
  ErrorCallout,
  LoadingState,
  SectionCard,
  StatusBadge,
} from "@/components/ui";

export function ProvidersPanel() {
  const [providers, setProviders] = useState<ProviderConnection[]>([]);
  const [registry, setRegistry] = useState<ProviderRegistryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [provider, setProvider] = useState("openai-compatible");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [testingId, setTestingId] = useState<string | null>(null);
  const [discoveringId, setDiscoveringId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, ProviderTestResult>>({});
  const [testErrors, setTestErrors] = useState<Record<string, string>>({});
  const [discoveryResults, setDiscoveryResults] = useState<Record<string, string[]>>({});
  const [discoveryErrors, setDiscoveryErrors] = useState<Record<string, string>>({});

  async function refresh() {
    setLoading(true);
    try {
      const [nextProviders, nextRegistry] = await Promise.all([
        listProviders(),
        listProviderRegistry(),
      ]);
      setProviders(nextProviders);
      setRegistry(nextRegistry);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "模型中心加载失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    if (!registry.length || editingId) {
      return;
    }
    if (!registry.some((item) => item.provider === provider)) {
      setProvider(registry[0].provider);
    }
  }, [editingId, provider, registry]);

  const editingProvider = useMemo(
    () => providers.find((item) => item.id === editingId) ?? null,
    [providers, editingId],
  );

  const selectedDescriptor = useMemo(
    () => registry.find((item) => item.provider === provider) ?? null,
    [provider, registry],
  );

  const apiKeyOptional = useMemo(
    () => selectedDescriptor?.requires_api_key === false,
    [selectedDescriptor],
  );

  function loadIntoForm(next: ProviderConnection | null) {
    setEditingId(next?.id ?? null);
    setLabel(next?.label ?? "");
    setProvider(next?.provider ?? (registry[0]?.provider ?? "openai-compatible"));
    setBaseUrl(next?.base_url ?? "");
    setApiKey("");
    setError(null);
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!label.trim()) {
      setError("连接名称不能为空");
      return;
    }
    if (!editingId && !apiKey.trim() && !apiKeyOptional) {
      setError("这个 Provider 需要 API Key；仅服务端标记为可选时才能留空。");
      return;
    }

    setBusy(true);
    try {
      if (editingId) {
        await updateProvider(editingId, {
          label: label.trim(),
          base_url: baseUrl.trim() || null,
          api_key: apiKey.trim() || undefined,
        });
      } else {
        await createProvider({
          label: label.trim(),
          provider,
          api_key: apiKey.trim(),
          base_url: baseUrl.trim() || null,
        });
      }
      loadIntoForm(null);
      await refresh();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "保存 Provider 失败");
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(providerId: string) {
    setBusy(true);
    try {
      await deleteProvider(providerId);
      if (editingId === providerId) {
        loadIntoForm(null);
      }
      setTestResults((current) => {
        const next = { ...current };
        delete next[providerId];
        return next;
      });
      setTestErrors((current) => {
        const next = { ...current };
        delete next[providerId];
        return next;
      });
      setDiscoveryResults((current) => {
        const next = { ...current };
        delete next[providerId];
        return next;
      });
      setDiscoveryErrors((current) => {
        const next = { ...current };
        delete next[providerId];
        return next;
      });
      await refresh();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "删除 Provider 失败");
    } finally {
      setBusy(false);
    }
  }

  async function handleTest(providerId: string) {
    setTestingId(providerId);
    setTestErrors((current) => {
      const next = { ...current };
      delete next[providerId];
      return next;
    });
    try {
      const result = await testProvider(providerId);
      setTestResults((current) => ({ ...current, [providerId]: result }));
    } catch (actionError) {
      setTestErrors((current) => ({
        ...current,
        [providerId]:
          actionError instanceof Error ? actionError.message : "Provider 测试失败",
      }));
    } finally {
      setTestingId(null);
    }
  }

  async function handleDiscover(providerId: string) {
    setDiscoveringId(providerId);
    setDiscoveryErrors((current) => {
      const next = { ...current };
      delete next[providerId];
      return next;
    });
    try {
      const result = await discoverProviderModels(providerId);
      setDiscoveryResults((current) => ({
        ...current,
        [providerId]: result.models,
      }));
    } catch (actionError) {
      setDiscoveryErrors((current) => ({
        ...current,
        [providerId]:
          actionError instanceof Error ? actionError.message : "模型发现失败",
      }));
    } finally {
      setDiscoveringId(null);
    }
  }

  return (
    <section className="page-stack">
      <header className="chapter-head">
        <p className="chapter-kicker">声音与模型</p>
        <h1>自己带 Key 接入</h1>
        <p>按服务端 registry 声明能力位。连接测试和模型发现只展示真实返回，不伪造就绪状态。</p>
        <dl className="chapter-facts" aria-label="模型摘要">
          <div>
            <dt>连接数</dt>
            <dd>{providers.length}</dd>
          </div>
          <div>
            <dt>可接服务</dt>
            <dd>{registry.length}</dd>
          </div>
        </dl>
      </header>

      {error ? <ErrorCallout message={error} /> : null}

      <div className="content-grid two-up">
        <SectionCard
          eyebrow="新增 / 编辑"
          title={editingProvider ? "编辑连接" : "创建连接"}
          hint="Owner token 只存在内存；API Key 只在提交时发送，不回填。"
        >
          {loading && !registry.length ? (
            <LoadingState label="正在读取 provider registry..." />
          ) : (
            <form className="form-grid" onSubmit={handleSubmit}>
              <label className="field">
                <span>连接名称</span>
                <input
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                  placeholder="例如：主对话 OpenAI、备用 Ollama、本地 Mock"
                />
              </label>
              <label className="field">
                <span>Provider</span>
                <select
                  value={provider}
                  onChange={(event) => setProvider(event.target.value)}
                  disabled={Boolean(editingId) || !registry.length}
                >
                  {registry.map((item) => (
                    <option key={item.provider} value={item.provider}>
                      {item.provider}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Base URL</span>
                <input
                  value={baseUrl}
                  onChange={(event) => setBaseUrl(event.target.value)}
                  placeholder={
                    selectedDescriptor?.supports_custom_base_url
                      ? "兼容端点可自定义"
                      : "这个 Provider 通常不需要自定义"
                  }
                />
                {selectedDescriptor?.supports_custom_base_url ? (
                  <small className="muted">
                    自定义端点会接收 system prompt、对话历史与检索片段；只连接你信任的服务。
                    本机 Ollama 请优先选择 Ollama Provider。
                  </small>
                ) : null}
              </label>
              <label className="field field-full">
                <span>
                  {editingId
                    ? "替换 API Key（留空表示不改）"
                    : apiKeyOptional
                      ? "API Key（此 Provider 可留空）"
                      : "API Key"}
                </span>
                <input
                  type="password"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder="只在这里输入一次，前端不持久化"
                />
              </label>
              {selectedDescriptor ? (
                <div className="field field-full">
                  <span>服务端声明的能力位</span>
                  <p>{selectedDescriptor.capabilities.join(" / ")}</p>
                  <p className="muted">
                    默认模型：{selectedDescriptor.default_models.join(" / ") || "无默认模型列表"}
                  </p>
                </div>
              ) : null}
              <div className="inline-actions field-full">
                <button type="submit" className="primary-button" disabled={busy || !registry.length}>
                  {editingId ? "保存修改" : "创建连接"}
                </button>
                {editingId ? (
                  <button type="button" className="ghost-button" onClick={() => loadIntoForm(null)}>
                    取消编辑
                  </button>
                ) : null}
              </div>
            </form>
          )}
        </SectionCard>

        <SectionCard
          eyebrow="Registry"
          title="能力位与默认模型"
          hint="这里直接来自 `/api/v1/providers/registry`，不是前端写死常量。"
        >
          {loading && !registry.length ? (
            <LoadingState label="正在读取 registry..." />
          ) : registry.length ? (
            <div className="stack-list">
              {registry.map((item) => (
                <div key={item.provider} className="list-row compact">
                  <strong>{item.provider}</strong>
                  <p>{item.capabilities.join(" / ")}</p>
                  <p className="muted">
                    {item.supports_custom_base_url ? "支持自定义 Base URL" : "固定官方端点"}
                  </p>
                  <p className="muted">
                    默认模型：{item.default_models.join(" / ") || "无"}
                  </p>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState title="Registry 为空" description="服务端没有返回任何 Provider 描述符，当前无法安全创建连接。" />
          )}
        </SectionCard>
      </div>

      <SectionCard eyebrow="连接列表" title="Provider Connections" hint="可以先测试连接，再发模型发现。所有结果都来自实时接口返回。">
        {loading ? (
          <LoadingState label="正在读取 Provider..." />
        ) : providers.length ? (
          <div className="card-grid">
            {providers.map((item) => {
              const isBuiltinMock = item.id === "builtin-mock";
              const isBuiltinNeuralTts = item.id === "builtin-neural-tts";
              const isBuiltin = isBuiltinMock || isBuiltinNeuralTts;
              const testResult = testResults[item.id];
              const testError = testErrors[item.id];
              const discoveredModels = discoveryResults[item.id];
              const discoveryError = discoveryErrors[item.id];
              return (
                <article key={item.id} className="info-card">
                  <div className="card-row">
                    {isBuiltin ? (
                      <strong>{item.label}</strong>
                    ) : (
                      <button type="button" className="inline-title-button" onClick={() => loadIntoForm(item)}>
                        <strong>{item.label}</strong>
                      </button>
                    )}
                    {testResult ? (
                      <StatusBadge label={testResult.ok ? "test ok" : "test failed"} tone={testResult.ok ? "good" : "warn"} />
                    ) : (
                      <StatusBadge label={item.provider} tone="muted" />
                    )}
                  </div>
                  <p>{joinCompact([item.provider, item.base_url || null])}</p>
                  <p className="muted">{item.capabilities.join(" / ") || "未声明能力位"}</p>
                  {isBuiltin ? (
                    <p className="micro-copy">
                      {isBuiltinMock
                        ? "这是无 Key 演示闭环的保留连接，不可编辑或删除。"
                        : "这是本机 Qwen3-TTS 固定声线连接，不可编辑或删除。新空间在 sidecar ready 时默认走这里；旧 Mock 空间需在该空间的 TTS 能力位手动改过来。"}
                    </p>
                  ) : null}
                  <p className="micro-copy">更新于 {formatDateTime(item.updated_at)}</p>
                  {testResult ? (
                    <div className="list-row compact">
                      <strong>最近测试</strong>
                      <p>{joinCompact([testResult.mode, testResult.latency_ms === null ? null : `${testResult.latency_ms} ms`])}</p>
                      <p className="muted">{testResult.message || "接口未返回额外消息。"}</p>
                      <p className="muted">
                        能力位：{testResult.capabilities.join(" / ") || "无"}；模型：{testResult.models.join(" / ") || "无"}
                      </p>
                    </div>
                  ) : null}
                  {testError ? <ErrorCallout message={testError} /> : null}
                  {discoveredModels ? (
                    <div className="list-row compact">
                      <strong>模型发现</strong>
                      <p>{discoveredModels.length ? discoveredModels.join(" / ") : "接口返回空列表"}</p>
                    </div>
                  ) : null}
                  {discoveryError ? <ErrorCallout message={discoveryError} /> : null}
                  <div className="inline-actions">
                    <button type="button" className="ghost-button" disabled={testingId === item.id} onClick={() => void handleTest(item.id)}>
                      {testingId === item.id ? "测试中..." : "测试"}
                    </button>
                    <button type="button" className="ghost-button" disabled={discoveringId === item.id} onClick={() => void handleDiscover(item.id)}>
                      {discoveringId === item.id ? "发现中..." : "发现模型"}
                    </button>
                    {isBuiltin ? null : (
                      <button type="button" className="ghost-button danger-button" disabled={busy} onClick={() => void handleDelete(item.id)}>
                        删除
                      </button>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <EmptyState title="还没有任何 Provider" description="先接一个真实模型或 Mock 连接，再到空间里做能力绑定。" />
        )}
      </SectionCard>
    </section>
  );
}
