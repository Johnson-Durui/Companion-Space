"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  createNoteMaterial,
  deleteMaterial,
  deleteSpaceAssignment,
  discoverProviderModels,
  getSpace,
  importLegacyKnowledge,
  listProviders,
  listLegacyKnowledgeCandidates,
  retryMaterialIngestion,
  saveSpaceAssignment,
  updateSpace,
  uploadMaterial,
} from "@/lib/api";
import { formatDateTime, joinCompact } from "@/lib/format";
import type {
  IngestionJob,
  LegacyKnowledgeCandidate,
  MaterialKind,
  ModelAssignment,
  ProviderCapability,
  ProviderConnection,
  StudySpaceDetail as StudySpaceDetailView,
} from "@/lib/types";
import {
  EmptyState,
  ErrorCallout,
  LoadingState,
  SectionCard,
  StatusBadge,
} from "@/components/ui";

const capabilityOptions: Array<{
  value: ProviderCapability;
  label: string;
  hint: string;
}> = [
  { value: "chat_llm", label: "Chat", hint: "主对话模型。M2 文字流式闭环优先走这里。" },
  { value: "analysis_llm", label: "Analysis", hint: "复盘、分析或更重的推理能力位。" },
  { value: "embedding", label: "Embedding", hint: "知识库检索向量化能力位。" },
  { value: "stt", label: "STT", hint: "语音转文字能力位，未绑定时房间应退化为文字输入。" },
  { value: "tts", label: "TTS", hint: "文字转语音。sidecar ready 时新空间默认 Built-in Neural TTS；旧 Mock 空间在此改成 builtin-neural-tts / qwen3-tts-0.6b-customvoice。" },
];

interface BindingDraft {
  connectionId: string;
  modelName: string;
  discoveredModels: string[];
  discoveryError: string | null;
  discoverySummary: string | null;
  mutationError: string | null;
  mutationSummary: string | null;
}

const MATERIAL_FILE_EXTENSION_PATTERN = /\.(pdf|txt|md)$/i;
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const JOB_ACTIVE_STATUSES = new Set(["queued", "processing"]);

function createEmptyBindingDrafts(): Record<ProviderCapability, BindingDraft> {
  return capabilityOptions.reduce<Record<ProviderCapability, BindingDraft>>(
    (current, { value }) => {
      current[value] = {
        connectionId: "",
        modelName: "",
        discoveredModels: [],
        discoveryError: null,
        discoverySummary: null,
        mutationError: null,
        mutationSummary: null,
      };
      return current;
    },
    {} as Record<ProviderCapability, BindingDraft>,
  );
}

function draftsFromAssignments(
  assignments: ModelAssignment[] | undefined,
  current?: Record<ProviderCapability, BindingDraft>,
  preserveDrafts = false,
): Record<ProviderCapability, BindingDraft> {
  const next = createEmptyBindingDrafts();
  const assignmentByCapability = new Map(
    (assignments ?? []).map((assignment) => [assignment.capability, assignment]),
  );

  for (const { value } of capabilityOptions) {
    const persisted = assignmentByCapability.get(value);
    const existing = current?.[value];
    if (persisted) {
      next[value] = {
        connectionId: persisted.connection_id ?? "",
        modelName: persisted.model ?? "",
        discoveredModels:
          existing && existing.connectionId === (persisted.connection_id ?? "")
            ? existing.discoveredModels
            : [],
        discoveryError: null,
        discoverySummary: null,
        mutationError: null,
        mutationSummary: existing?.mutationSummary ?? null,
      };
      continue;
    }
    if (preserveDrafts && existing) {
      next[value] = existing;
    }
  }

  return next;
}

function jobTimestamp(job: Pick<IngestionJob, "updated_at" | "created_at">): number {
  const raw = job.updated_at || job.created_at;
  const parsed = raw ? Date.parse(raw) : Number.NaN;
  return Number.isNaN(parsed) ? 0 : parsed;
}

function latestJobsByMaterialId(jobs: IngestionJob[]): Map<string, IngestionJob> {
  const next = new Map<string, IngestionJob>();
  for (const job of [...jobs].sort((left, right) => jobTimestamp(right) - jobTimestamp(left))) {
    if (job.material_id && !next.has(job.material_id)) {
      next.set(job.material_id, job);
    }
  }
  return next;
}

function materialStatusMeta(job: IngestionJob | null, kind: MaterialKind) {
  if (!job) {
    return {
      label: kind === "pdf" ? "PDF" : kind === "text" ? "TXT" : "Markdown",
      tone: "muted" as const,
    };
  }

  switch (job.status) {
    case "queued":
      return { label: "排队中", tone: "warn" as const };
    case "processing":
      return { label: "索引中", tone: "warn" as const };
    case "completed":
      return { label: "已完成", tone: "good" as const };
    case "failed":
      return { label: "失败", tone: "warn" as const };
    default:
      return { label: job.status, tone: "muted" as const };
  }
}

function legacyIssueLabel(issue: string | null): string {
  switch (issue) {
    case "source_missing":
      return "旧资料源文件缺失，不能导入。";
    case "source_outside_legacy_root":
      return "旧资料源文件位置不安全，不能导入。";
    default:
      return issue ? `旧资料不可导入：${issue}` : "旧资料当前可导入。";
  }
}

export function SpaceDetail({ spaceId }: { spaceId: string }) {
  const [space, setSpace] = useState<StudySpaceDetailView | null>(null);
  const [providerConnections, setProviderConnections] = useState<ProviderConnection[]>([]);
  const [providerError, setProviderError] = useState<string | null>(null);
  const [legacyCandidates, setLegacyCandidates] = useState<LegacyKnowledgeCandidate[]>([]);
  const [legacyError, setLegacyError] = useState<string | null>(null);
  const [bindingDrafts, setBindingDrafts] = useState<Record<ProviderCapability, BindingDraft>>(
    createEmptyBindingDrafts(),
  );
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [savingCapability, setSavingCapability] = useState<ProviderCapability | null>(null);
  const [discoveringCapability, setDiscoveringCapability] = useState<ProviderCapability | null>(null);
  const [unbindingCapability, setUnbindingCapability] = useState<ProviderCapability | null>(null);
  const [retryingMaterialId, setRetryingMaterialId] = useState<string | null>(null);
  const [importingLegacyDocumentId, setImportingLegacyDocumentId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [theme, setTheme] = useState("");
  const [goal, setGoal] = useState("");
  const [noteTitle, setNoteTitle] = useState("");
  const [noteContent, setNoteContent] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const refreshRequestRef = useRef(0);
  const legacyImportInFlightRef = useRef(false);
  const spaceIdRef = useRef(spaceId);
  const providerConnectionsRef = useRef(providerConnections);
  spaceIdRef.current = spaceId;
  providerConnectionsRef.current = providerConnections;

  const refresh = useCallback(
    async (
      options: {
        preserveBindingDrafts?: boolean;
        preserveEditableFields?: boolean;
        quiet?: boolean;
        includeProviders?: boolean;
      } = {},
    ) => {
      const requestId = refreshRequestRef.current + 1;
      refreshRequestRef.current = requestId;
      if (!options.quiet) {
        setLoading(true);
      }
      try {
        const [spaceResult, providersResult, legacyResult] = await Promise.allSettled([
          getSpace(spaceId),
          options.includeProviders === false
            ? Promise.resolve(providerConnectionsRef.current)
            : listProviders(),
          listLegacyKnowledgeCandidates(),
        ]);
        if (requestId !== refreshRequestRef.current || spaceIdRef.current !== spaceId) {
          return;
        }

        if (providersResult.status === "fulfilled") {
          setProviderConnections(providersResult.value);
          setProviderError(null);
        } else {
          setProviderConnections([]);
          setProviderError(
            providersResult.reason instanceof Error
              ? providersResult.reason.message
              : "Provider 列表加载失败",
          );
        }

        if (spaceResult.status === "fulfilled") {
          const next = spaceResult.value;
          setSpace(next);
          if (!options.preserveEditableFields) {
            setTitle(next.title);
            setTheme(next.theme || "");
            setGoal(next.goal || "");
          }
          setBindingDrafts((current) =>
            draftsFromAssignments(
              next.model_assignments,
              current,
              options.preserveBindingDrafts ?? false,
            ),
          );
          setError(null);
        } else {
          setError(
            spaceResult.reason instanceof Error
              ? spaceResult.reason.message
              : "空间详情加载失败",
          );
        }

        if (legacyResult.status === "fulfilled") {
          setLegacyCandidates(legacyResult.value);
          setLegacyError(null);
        } else {
          setLegacyCandidates([]);
          setLegacyError(
            legacyResult.reason instanceof Error
              ? legacyResult.reason.message
              : "旧知识库候选加载失败",
          );
        }
      } finally {
        if (requestId === refreshRequestRef.current && spaceIdRef.current === spaceId && !options.quiet) {
          setLoading(false);
        }
      }
    },
    [spaceId],
  );

  useEffect(() => {
    setSpace(null);
    setProviderConnections([]);
    setProviderError(null);
    setLegacyCandidates([]);
    setLegacyError(null);
    setBindingDrafts(createEmptyBindingDrafts());
    setTitle("");
    setTheme("");
    setGoal("");
    setNoteTitle("");
    setNoteContent("");
    setSelectedFile(null);
    setBusy(false);
    setSavingCapability(null);
    setDiscoveringCapability(null);
    setUnbindingCapability(null);
    setRetryingMaterialId(null);
    setImportingLegacyDocumentId(null);
    setError(null);
    void refresh();
    return () => {
      refreshRequestRef.current += 1;
    };
  }, [refresh]);

  const connectionsById = useMemo(
    () => new Map(providerConnections.map((item) => [item.id, item])),
    [providerConnections],
  );

  const assignmentsByCapability = useMemo(
    () =>
      new Map((space?.model_assignments ?? []).map((assignment) => [assignment.capability, assignment])),
    [space?.model_assignments],
  );

  const latestJobMap = useMemo(
    () => latestJobsByMaterialId(space?.jobs ?? []),
    [space?.jobs],
  );

  const hasActiveJobs = useMemo(
    () => space?.jobs.some((job) => JOB_ACTIVE_STATUSES.has(job.status)) ?? false,
    [space?.jobs],
  );

  useEffect(() => {
    if (!space || !hasActiveJobs) {
      return;
    }
    const timer = window.setInterval(() => {
      void refresh({
        preserveBindingDrafts: true,
        preserveEditableFields: true,
        quiet: true,
        includeProviders: false,
      });
    }, 2000);
    return () => window.clearInterval(timer);
  }, [hasActiveJobs, refresh, space]);

  async function run(action: () => Promise<unknown>) {
    const actionSpaceId = spaceId;
    setBusy(true);
    try {
      await action();
      if (spaceIdRef.current === actionSpaceId) {
        await refresh({
          preserveBindingDrafts: true,
          preserveEditableFields: true,
        });
      }
    } catch (actionError) {
      if (spaceIdRef.current === actionSpaceId) {
        setError(actionError instanceof Error ? actionError.message : "空间操作失败");
      }
    } finally {
      if (spaceIdRef.current === actionSpaceId) {
        setBusy(false);
      }
    }
  }

  function updateBindingDraft(
    capability: ProviderCapability,
    mutate: (draft: BindingDraft) => BindingDraft,
  ) {
    setBindingDrafts((current) => ({
      ...current,
      [capability]: mutate(current[capability]),
    }));
  }

  function handleSaveSpace(event: FormEvent) {
    event.preventDefault();
    setError(null);
    void run(() =>
      updateSpace(spaceId, {
        title,
        theme,
        goal,
      }),
    );
  }

  function handleUpload(event: FormEvent) {
    event.preventDefault();
    if (!selectedFile) {
      setError("请选择一个文件后再上传。");
      return;
    }
    if (!MATERIAL_FILE_EXTENSION_PATTERN.test(selectedFile.name)) {
      setError("仅支持 .pdf、.txt 和 .md 文件。");
      return;
    }
    if (selectedFile.size > MAX_UPLOAD_BYTES) {
      setError("单个资料文件不能超过 50 MiB。PDF 还会额外校验 500 页上限。");
      return;
    }
    setError(null);
    void run(async () => {
      await uploadMaterial({ spaceId, file: selectedFile });
      setSelectedFile(null);
    });
  }

  function handleCreateNote(event: FormEvent) {
    event.preventDefault();
    if (!noteTitle.trim() || !noteContent.trim()) {
      setError("笔记标题和内容都不能为空。");
      return;
    }
    setError(null);
    void run(async () => {
      await createNoteMaterial({ spaceId, title: noteTitle, content: noteContent });
      setNoteTitle("");
      setNoteContent("");
    });
  }

  async function handleRetryMaterial(materialId: string) {
    const actionSpaceId = spaceId;
    setRetryingMaterialId(materialId);
    setError(null);
    try {
      await retryMaterialIngestion(spaceId, materialId);
      if (spaceIdRef.current === actionSpaceId) {
        await refresh({
          preserveBindingDrafts: true,
          preserveEditableFields: true,
          includeProviders: false,
        });
      }
    } catch (actionError) {
      if (spaceIdRef.current === actionSpaceId) {
        setError(actionError instanceof Error ? actionError.message : "资料重试失败");
      }
    } finally {
      if (spaceIdRef.current === actionSpaceId) {
        setRetryingMaterialId(null);
      }
    }
  }

  async function handleImportLegacy(documentId: string) {
    if (legacyImportInFlightRef.current) {
      return;
    }
    legacyImportInFlightRef.current = true;
    const actionSpaceId = spaceId;
    setImportingLegacyDocumentId(documentId);
    setLegacyError(null);
    setError(null);
    try {
      await importLegacyKnowledge(spaceId, documentId);
      if (spaceIdRef.current === actionSpaceId) {
        await refresh({
          preserveBindingDrafts: true,
          preserveEditableFields: true,
          includeProviders: false,
        });
      }
    } catch (actionError) {
      if (spaceIdRef.current === actionSpaceId) {
        setLegacyError(
          actionError instanceof Error ? actionError.message : "旧知识库导入失败",
        );
      }
    } finally {
      legacyImportInFlightRef.current = false;
      if (spaceIdRef.current === actionSpaceId) {
        setImportingLegacyDocumentId(null);
      }
    }
  }

  async function handleDiscoverModels(capability: ProviderCapability) {
    const draft = bindingDrafts[capability];
    if (!draft.connectionId) {
      updateBindingDraft(capability, (current) => ({
        ...current,
        discoveryError: "请先选择一个连接，再请求模型发现。",
        discoverySummary: null,
      }));
      return;
    }

    setDiscoveringCapability(capability);
    updateBindingDraft(capability, (current) => ({
      ...current,
      discoveryError: null,
      discoverySummary: null,
    }));
    try {
      const result = await discoverProviderModels(draft.connectionId, capability);
      updateBindingDraft(capability, (current) => ({
        ...current,
        discoveredModels: result.models,
        discoveryError: null,
        discoverySummary: result.models.length
          ? `接口返回 ${result.models.length} 个模型。`
          : "接口返回空列表，请手动输入模型名。",
      }));
    } catch (actionError) {
      updateBindingDraft(capability, (current) => ({
        ...current,
        discoveryError:
          actionError instanceof Error ? actionError.message : "模型发现失败",
        discoverySummary: null,
      }));
    } finally {
      setDiscoveringCapability(null);
    }
  }

  async function handleSaveAssignment(event: FormEvent, capability: ProviderCapability) {
    event.preventDefault();
    const draft = bindingDrafts[capability];
    const modelName = draft.modelName.trim();
    if (!draft.connectionId) {
      updateBindingDraft(capability, (current) => ({
        ...current,
        mutationError: "请先选择一个连接。",
        mutationSummary: null,
      }));
      return;
    }
    if (!modelName) {
      updateBindingDraft(capability, (current) => ({
        ...current,
        mutationError: "模型名不能为空。",
        mutationSummary: null,
      }));
      return;
    }

    setSavingCapability(capability);
    updateBindingDraft(capability, (current) => ({
      ...current,
      mutationError: null,
      mutationSummary: null,
    }));
    try {
      await saveSpaceAssignment(spaceId, {
        capability,
        provider_connection_id: draft.connectionId,
        model_name: modelName,
      });
      updateBindingDraft(capability, (current) => ({
        ...current,
        mutationError: null,
        mutationSummary: "绑定已保存。",
      }));
      await refresh({
        preserveBindingDrafts: true,
        preserveEditableFields: true,
      });
    } catch (actionError) {
      updateBindingDraft(capability, (current) => ({
        ...current,
        mutationError:
          actionError instanceof Error ? actionError.message : "能力绑定保存失败",
        mutationSummary: null,
      }));
    } finally {
      setSavingCapability(null);
    }
  }

  async function handleDeleteAssignment(capability: ProviderCapability) {
    setUnbindingCapability(capability);
    updateBindingDraft(capability, (current) => ({
      ...current,
      mutationError: null,
      mutationSummary: null,
    }));
    try {
      await deleteSpaceAssignment(spaceId, capability);
      updateBindingDraft(capability, () => ({
        connectionId: "",
        modelName: "",
        discoveredModels: [],
        discoveryError: null,
        discoverySummary: null,
        mutationError: null,
        mutationSummary: "绑定已解绑。",
      }));
      await refresh({
        preserveBindingDrafts: true,
        preserveEditableFields: true,
      });
    } catch (actionError) {
      updateBindingDraft(capability, (current) => ({
        ...current,
        mutationError:
          actionError instanceof Error ? actionError.message : "解绑失败",
        mutationSummary: null,
      }));
    } finally {
      setUnbindingCapability(null);
    }
  }

  if (loading) {
    return <LoadingState label="正在加载空间详情..." />;
  }

  if (error && !space) {
    return <ErrorCallout message={error} />;
  }

  if (!space) {
    return <EmptyState title="空间不存在" description="这个 spaceId 没有返回任何数据，可能后端还没实现详情接口。" />;
  }

  return (
    <section className="page-stack">
      <header className="chapter-head">
        <p className="chapter-kicker">当前空间</p>
        <h1>{space.title}</h1>
        <p>先和伙伴开始一轮共学。资料、角色与模型可以稍后再补。</p>
        <dl className="chapter-facts" aria-label="空间摘要">
          <div>
            <dt>资料</dt>
            <dd>{space.materials.length} 份</dd>
          </div>
          <div>
            <dt>模型能力位</dt>
            <dd>{space.model_assignments?.length ?? 0}</dd>
          </div>
          <div>
            <dt>索引任务</dt>
            <dd>{hasActiveJobs ? "处理中" : `${space.jobs.length} 条`}</dd>
          </div>
        </dl>
        <div className="hero-actions">
          <Link href={`/spaces/${spaceId}/call`} className="primary-button subtle-link">
            开始共学
          </Link>
        </div>
      </header>

      {error ? <ErrorCallout message={error} /> : null}

      <div className="content-grid two-up">
        <SectionCard eyebrow="空间信息" title="基础设定" hint="这里负责主题、目标和默认描述，不处理复杂流程配置。">
          <form className="form-grid" onSubmit={handleSaveSpace}>
            <label className="field">
              <span>名称</span>
              <input value={title} onChange={(event) => setTitle(event.target.value)} />
            </label>
            <label className="field">
              <span>主题</span>
              <input value={theme} onChange={(event) => setTheme(event.target.value)} placeholder="比如：口语、刷题、设计系统" />
            </label>
            <label className="field">
              <span>目标</span>
              <input value={goal} onChange={(event) => setGoal(event.target.value)} placeholder="写一个能坚持的目标，而不是口号" />
            </label>
            <button type="submit" className="primary-button" disabled={busy}>
              保存空间
            </button>
          </form>
        </SectionCard>

        <SectionCard
          eyebrow="能力绑定"
          title="默认模型分配"
          hint="每个能力位都显式绑定 connection + model。TTS 切到 Built-in Neural TTS 后，新会话走服务端 PCM，不再用浏览器系统朗读。"
        >
          {providerError ? <ErrorCallout message={providerError} /> : null}
          <div className="stack-list">
            {capabilityOptions.map((capabilityOption) => {
              const assignment = assignmentsByCapability.get(capabilityOption.value);
              const draft = bindingDrafts[capabilityOption.value];
              const eligibleConnections = providerConnections.filter((item) =>
                item.capabilities.includes(capabilityOption.value),
              );
              const assignedConnection = assignment?.connection_id
                ? connectionsById.get(assignment.connection_id)
                : null;

              return (
                <article key={capabilityOption.value} className="info-card">
                  <div className="card-row">
                    <div>
                      <strong>{capabilityOption.label}</strong>
                      <p className="muted">{capabilityOption.hint}</p>
                    </div>
                    <span className="micro-copy">{eligibleConnections.length} 个可选连接</span>
                  </div>
                  <p>
                    {assignment
                      ? joinCompact([
                          assignedConnection?.label ?? null,
                          assignedConnection?.provider ?? null,
                          assignment.model ?? null,
                          assignment.connection_id ?? null,
                        ]) || "已绑定，但连接信息未命中当前列表"
                      : "当前未绑定"}
                  </p>
                  <form className="form-grid" onSubmit={(event) => void handleSaveAssignment(event, capabilityOption.value)}>
                    <label className="field">
                      <span>连接</span>
                      <select
                        value={draft.connectionId}
                        onChange={(event) => {
                          const nextConnectionId = event.target.value;
                          updateBindingDraft(capabilityOption.value, (current) => ({
                            ...current,
                            connectionId: nextConnectionId,
                            modelName: nextConnectionId === current.connectionId ? current.modelName : "",
                            discoveredModels:
                              nextConnectionId === current.connectionId ? current.discoveredModels : [],
                            discoveryError: null,
                            discoverySummary: null,
                            mutationError: null,
                            mutationSummary: null,
                          }));
                        }}
                        disabled={!eligibleConnections.length}
                      >
                        <option value="">选择一个支持该能力位的连接</option>
                        {eligibleConnections.map((connection) => (
                          <option key={connection.id} value={connection.id}>
                            {joinCompact([connection.label, connection.provider])}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field">
                      <span>模型名</span>
                      <input
                        value={draft.modelName}
                        onChange={(event) =>
                          updateBindingDraft(capabilityOption.value, (current) => ({
                            ...current,
                            modelName: event.target.value,
                            mutationError: null,
                            mutationSummary: null,
                          }))
                        }
                        placeholder="可手动输入；发现后也可直接选取"
                      />
                    </label>
                    {draft.discoveredModels.length ? (
                      <label className="field field-full">
                        <span>发现结果</span>
                        <select
                          value={draft.discoveredModels.includes(draft.modelName) ? draft.modelName : ""}
                          onChange={(event) =>
                            updateBindingDraft(capabilityOption.value, (current) => ({
                              ...current,
                              modelName: event.target.value,
                              mutationError: null,
                              mutationSummary: null,
                            }))
                          }
                        >
                          <option value="">从发现结果中选择一个模型</option>
                          {draft.discoveredModels.map((model) => (
                            <option key={model} value={model}>
                              {model}
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : null}
                    {draft.discoverySummary ? <p className="muted field-full">{draft.discoverySummary}</p> : null}
                    {draft.discoveryError ? <div className="field-full"><ErrorCallout message={draft.discoveryError} /></div> : null}
                    {draft.mutationSummary ? <div className="success-callout field-full">{draft.mutationSummary}</div> : null}
                    {draft.mutationError ? <div className="field-full"><ErrorCallout message={draft.mutationError} /></div> : null}
                    <div className="inline-actions field-full">
                      <button
                        type="button"
                        className="ghost-button"
                        disabled={!draft.connectionId || discoveringCapability === capabilityOption.value}
                        onClick={() => void handleDiscoverModels(capabilityOption.value)}
                      >
                        {discoveringCapability === capabilityOption.value ? "发现中..." : "发现模型"}
                      </button>
                      <button
                        type="submit"
                        className="primary-button"
                        disabled={!draft.connectionId || !draft.modelName.trim() || savingCapability === capabilityOption.value}
                      >
                        {savingCapability === capabilityOption.value ? "保存中..." : "保存绑定"}
                      </button>
                      <button
                        type="button"
                        className="ghost-button danger-button"
                        disabled={!assignment || unbindingCapability === capabilityOption.value}
                        onClick={() => void handleDeleteAssignment(capabilityOption.value)}
                      >
                        {unbindingCapability === capabilityOption.value ? "解绑中..." : "解绑"}
                      </button>
                    </div>
                  </form>
                </article>
              );
            })}
          </div>
        </SectionCard>
      </div>

      <div className="content-grid two-up">
        <SectionCard eyebrow="资料导入" title="上传文件" hint="首版仅覆盖 PDF、TXT、Markdown。浏览器会把 X-Filename 编码后再发给后端，以支持中文文件名；单文件 50 MiB，PDF 最多 500 页。">
          <form className="form-grid" onSubmit={handleUpload}>
            <label className="field">
              <span>选择文件</span>
              <input type="file" accept=".pdf,.txt,.md" onChange={(event) => setSelectedFile(event.target.files?.[0] ?? null)} />
            </label>
            {selectedFile ? (
              <p className="muted field-full">
                已选择 {selectedFile.name} · {(selectedFile.size / (1024 * 1024)).toFixed(2)} MiB
              </p>
            ) : null}
            <button type="submit" className="primary-button" disabled={busy || !selectedFile}>
              上传并索引
            </button>
          </form>
        </SectionCard>

        <SectionCard eyebrow="直接笔记" title="粘贴到知识库" hint="临时笔记也可以直接进入空间，而不是必须先整理成文件。">
          <form className="form-grid" onSubmit={handleCreateNote}>
            <label className="field">
              <span>笔记标题</span>
              <input value={noteTitle} onChange={(event) => setNoteTitle(event.target.value)} placeholder="例如：今天的错题反思" />
            </label>
            <label className="field field-full">
              <span>内容</span>
              <textarea value={noteContent} onChange={(event) => setNoteContent(event.target.value)} rows={6} placeholder="直接贴摘要、笔记、错题、灵感或提纲。" />
            </label>
            <button type="submit" className="primary-button" disabled={busy}>
              保存笔记
            </button>
          </form>
        </SectionCard>
      </div>

      <SectionCard
        eyebrow="旧版迁移"
        title="导入旧知识库资料"
        hint="这里只显示旧全局知识库的元数据，不展示正文；导入只复制到当前空间，不删除原文件。"
      >
        {legacyError ? <ErrorCallout message={legacyError} /> : null}
        {legacyCandidates.length ? (
          <div className="card-grid">
            {legacyCandidates.map((candidate) => (
              <article key={candidate.document_id} className="info-card">
                <div className="card-row">
                  <strong>{candidate.title}</strong>
                  <StatusBadge
                    label={candidate.importable ? "可导入" : "不可导入"}
                    tone={candidate.importable ? "good" : "warn"}
                  />
                </div>
                <p>
                  {joinCompact([
                    candidate.filename,
                    candidate.source_type,
                    `${candidate.chunk_count} chunks`,
                  ])}
                </p>
                <p className="muted">
                  {candidate.importable
                    ? "导入时会保留旧文件，只把资料复制到当前空间。"
                    : legacyIssueLabel(candidate.issue)}
                </p>
                {!candidate.importable && candidate.issue ? (
                  <ErrorCallout message={legacyIssueLabel(candidate.issue)} />
                ) : null}
                <div className="inline-actions">
                  <button
                    type="button"
                    className="ghost-button"
                    disabled={
                      busy ||
                      !candidate.importable ||
                      importingLegacyDocumentId !== null
                    }
                    onClick={() => void handleImportLegacy(candidate.document_id)}
                  >
                    {importingLegacyDocumentId === candidate.document_id
                      ? "导入中..."
                      : "导入到当前空间"}
                  </button>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <EmptyState
            title="未发现可导入旧资料"
            description="如果旧版全局知识库里有 PDF、TXT 或 Markdown 候选，它们会在这里列出元数据。当前不会读取正文，也不会自动删除原文件。"
          />
        )}
      </SectionCard>

      <SectionCard
        eyebrow="空间资料"
        title="Materials"
        hint="如果知识库为空，聊天也可以继续，但这里会明确告诉你尚未使用空间资料。"
      >
        {space.materials.length ? (
          <div className="card-grid">
            {space.materials.map((material) => {
              const latestJob = latestJobMap.get(material.id) ?? null;
              const status = materialStatusMeta(latestJob, material.kind);
              return (
                <article key={material.id} className="info-card">
                  <div className="card-row">
                    <strong>{material.title}</strong>
                    <StatusBadge label={status.label} tone={status.tone} />
                  </div>
                  <p>{joinCompact([material.filename || null, `${material.chunk_count ?? 0} chunks`]) || "尚无切片信息"}</p>
                  {latestJob ? (
                    <p className="muted">
                      最近任务：{latestJob.status} · {formatDateTime(latestJob.updated_at || latestJob.created_at)}
                    </p>
                  ) : null}
                  {latestJob?.detail ? <ErrorCallout message={latestJob.detail} /> : null}
                  <p className="muted">更新于 {formatDateTime(material.updated_at || material.created_at)}</p>
                  <div className="inline-actions">
                    {latestJob?.status === "failed" ? (
                      <button
                        type="button"
                        className="ghost-button"
                        disabled={busy || retryingMaterialId === material.id}
                        onClick={() => void handleRetryMaterial(material.id)}
                      >
                        {retryingMaterialId === material.id ? "重试中..." : "重试索引"}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="ghost-button danger-button"
                      disabled={busy}
                      onClick={() => void run(() => deleteMaterial(spaceId, material.id))}
                    >
                      删除
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <EmptyState title="这个空间还没有资料" description="你可以先上传 PDF/TXT/Markdown，或直接粘贴一段临时笔记。" />
        )}
      </SectionCard>

      <SectionCard
        eyebrow="伴学会话"
        title="进入文字 / 实时房间"
        hint="M1 的文字对话会创建真实会话并保留引用；实时语音会在后续里程碑接入同一房间。"
      >
        <div className="empty-state">
          <strong>资料准备好了，就去和搭子聊一轮。</strong>
          <p className="muted">
            发送文字后，服务端会在当前空间内检索资料；前端只展示服务端返回的真实引用。
          </p>
          <Link href={`/spaces/${spaceId}/call`} className="primary-button subtle-link">
            开始伴学会话
          </Link>
        </div>
      </SectionCard>
    </section>
  );
}
