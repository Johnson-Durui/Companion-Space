import { useEffect, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";
import {
  api,
  bodyOf,
  connectionsKey,
  ensureOK,
  fetchConnections,
  fetchRoles,
  publicMessage,
  rolesKey,
  type Connection,
  type ModelRoles,
} from "../../app/api";
import { Loading, Problem } from "../../app/ui";
import {
  ArrowUpRight,
  Badge,
  Button,
  Card,
  Check,
  CheckCircle2,
  ChevronDown,
  ConfirmDialog,
  Field,
  Plus,
  SecretInput,
  SegmentedControl,
  Select,
  Textarea,
  TextInput,
  XCircle,
  useTransientSaved,
} from "../../ui";
import t from "../../locales/zh-CN.json";
import { ConnectWizardDialog } from "./connect-wizard";
import { DiagnosticsPanel } from "./diagnostics";
import { useReadiness } from "./use-readiness";

async function fetchPresets() {
  return bodyOf(await api.GET("/api/v2/providers/presets"));
}

type Preset = Awaited<ReturnType<typeof fetchPresets>>[number] & {
  requires_base_url?: boolean;
};
type Role = keyof typeof t.roles;
const roles = Object.keys(t.roles) as Role[];
const recommendations = {
  free: ["https://open.bigmodel.cn/", "https://api.siliconflow.cn/"],
  paid: ["https://api.deepseek.com"],
};
const NO_URL_ADAPTERS = new Set(["antigravity-acp", "codex-app-server"]);
const NO_KEY_ADAPTERS = new Set(["local-neural", "antigravity-acp", "codex-app-server"]);
const voiceStatusKey = ["voice-status"] as const;

function isLocalSubscriptionPreset(preset: Preset): boolean {
  return !preset.requires_api_key && Boolean(preset.models.live);
}

function presetRequiresBaseUrl(preset: Preset): boolean {
  if (typeof preset.requires_base_url === "boolean") return preset.requires_base_url;
  return !NO_URL_ADAPTERS.has(preset.adapter);
}

function roleLabel(role: string) {
  return t.roles[role as Role] ?? role;
}

function ConnectForm({ presets }: { presets: Preset[] }) {
  const [cost, setCost] = useState<"free" | "paid" | "all">("free");
  const [presetId, setPresetId] = useState("");
  const [label, setLabel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const queryClient = useQueryClient();
  const { saved, notifySaved } = useTransientSaved(t.common.saved);

  const suggested =
    cost === "all"
      ? presets
      : presets.filter(
          (entry) =>
            (cost === "free" && isLocalSubscriptionPreset(entry)) ||
            recommendations[cost].some((base) => entry.base_url?.startsWith(base)),
        );
  const visible = suggested.length ? suggested : presets;
  const preset = visible.find((entry) => entry.id === presetId) ?? visible[0];

  const selectPreset = (nextId: string) => {
    setPresetId(nextId);
    const chosen = presets.find((entry) => entry.id === nextId);
    if (chosen) {
      setLabel(chosen.label);
      setBaseUrl(chosen.base_url ?? "");
      setApiKey("");
    }
  };

  const create = useMutation({
    mutationFn: async () => {
      if (!preset) throw new Error("No preset");
      const needsUrl = presetRequiresBaseUrl(preset);
      const acceptsKey = !NO_KEY_ADAPTERS.has(preset.adapter);
      return bodyOf(
        await api.POST("/api/v2/providers/connections", {
          body: {
            label: (label || preset.label).trim() || null,
            base_url: needsUrl ? (baseUrl || preset.base_url || "").trim() || null : null,
            api_key: acceptsKey ? apiKey.trim() : "",
            preset_id: preset.id,
          },
        }),
      );
    },
    onSuccess: async () => {
      setApiKey("");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: connectionsKey }),
        queryClient.invalidateQueries({ queryKey: rolesKey }),
        queryClient.invalidateQueries({ queryKey: voiceStatusKey }),
      ]);
      notifySaved();
    },
  });

  if (!preset) return <p className="text-ui text-fg-secondary">{t.settings.noConnections}</p>;

  const effectiveLabel = presetId === preset.id ? label : preset.label;
  const effectiveBaseUrl = presetId === preset.id ? baseUrl : (preset.base_url ?? "");

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    create.mutate();
  }

  return (
    <form className="grid max-w-2xl gap-4" onSubmit={submit} data-testid="manual-connect-form">
      <SegmentedControl<"free" | "paid" | "all">
        aria-label={t.settings.preset}
        value={cost}
        onValueChange={(next) => {
          setCost(next);
          setPresetId("");
        }}
        options={[
          { value: "free", label: t.settings.free },
          { value: "paid", label: t.settings.paid },
          { value: "all", label: t.settings.all },
        ]}
      />
      {cost === "free" ? (
        <p className="text-caption text-fg-secondary">{t.settings.recommendFree}</p>
      ) : null}
      {cost === "paid" ? (
        <p className="text-caption text-fg-secondary">{t.settings.recommendPaid}</p>
      ) : null}

      <Field label={t.settings.preset}>
        <Select
          aria-label={t.settings.preset}
          options={visible.map((entry) => ({ value: entry.id, label: entry.label }))}
          value={preset.id}
          onValueChange={(next) => {
            create.reset();
            selectPreset(next);
          }}
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t.settings.name}>
          <TextInput
            name="label"
            value={effectiveLabel}
            maxLength={120}
            onChange={(event) => {
              if (presetId !== preset.id) {
                setPresetId(preset.id);
                setBaseUrl(preset.base_url ?? "");
              }
              setLabel(event.target.value);
            }}
          />
        </Field>
        {presetRequiresBaseUrl(preset) ? (
          <Field label={t.settings.baseUrl} required={!preset.base_url}>
            <TextInput
              name="base_url"
              type="url"
              value={effectiveBaseUrl}
              placeholder={t.settings.customUrl}
              required={!preset.base_url}
              onChange={(event) => {
                if (presetId !== preset.id) {
                  setPresetId(preset.id);
                  setLabel(preset.label);
                }
                setBaseUrl(event.target.value);
              }}
            />
          </Field>
        ) : null}
      </div>

      {!NO_KEY_ADAPTERS.has(preset.adapter) ? (
        <Field label={t.settings.apiKey} required={preset.requires_api_key}>
          <SecretInput
            name="api_key"
            value={apiKey}
            required={preset.requires_api_key}
            onChange={(event) => setApiKey(event.target.value)}
          />
        </Field>
      ) : null}

      {preset.free_tier_note ? (
        <p className="text-caption text-fg-secondary">{preset.free_tier_note}</p>
      ) : null}
      {preset.manual_live ? (
        <p className="text-caption text-fg-secondary">{preset.manual_live}</p>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" pending={create.isPending}>
          {t.settings.create}
        </Button>
        {preset.key_url ? (
          <a
            className="inline-flex items-center gap-1 text-ui font-medium text-accent-strong underline underline-offset-4"
            href={preset.key_url}
            target="_blank"
            rel="noreferrer"
          >
            <span>{t.settings.getKey}</span>
            <ArrowUpRight size={15} aria-hidden="true" />
          </a>
        ) : null}
        {saved ? (
          <span className="inline-flex items-center gap-1 text-ui font-medium text-ok-text">
            <Check size={15} aria-hidden="true" />
            {t.common.saved}
          </span>
        ) : null}
      </div>
      {create.isError ? <Problem error={create.error} /> : null}
    </form>
  );
}

function ConnectionRow({
  connection,
  onModels,
}: {
  connection: Connection;
  onModels: (id: string, entries: string[]) => void;
}) {
  const queries = useQueryClient();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [editLabel, setEditLabel] = useState(connection.label);
  const [editUrl, setEditUrl] = useState(connection.base_url ?? "");
  const [editKey, setEditKey] = useState("");
  const { saved, notifySaved } = useTransientSaved(t.common.saved);
  const params = { path: { connection_id: connection.id } };

  const acceptsUrl = !NO_URL_ADAPTERS.has(connection.provider);
  const acceptsKey = !NO_KEY_ADAPTERS.has(connection.provider);

  const refresh = async () => {
    await Promise.all([
      queries.invalidateQueries({ queryKey: connectionsKey }),
      queries.invalidateQueries({ queryKey: rolesKey }),
      queries.invalidateQueries({ queryKey: voiceStatusKey }),
    ]);
  };
  const test = useMutation({
    mutationFn: async () =>
      bodyOf(await api.POST("/api/v2/providers/connections/{connection_id}/test", { params })),
  });
  const discover = useMutation({
    mutationFn: async () =>
      bodyOf(await api.GET("/api/v2/providers/connections/{connection_id}/models", { params })),
    onSuccess: ({ models }) => onModels(connection.id, models),
  });
  const edit = useMutation({
    mutationFn: async () =>
      bodyOf(
        await api.PATCH("/api/v2/providers/connections/{connection_id}", {
          params,
          body: {
            label: editLabel.trim(),
            base_url: acceptsUrl ? editUrl.trim() || null : null,
            ...(acceptsKey && editKey.trim() ? { api_key: editKey.trim() } : {}),
          },
        }),
      ),
    onSuccess: async () => {
      setEditKey("");
      await refresh();
      notifySaved();
    },
  });
  const remove = useMutation({
    mutationFn: async () => {
      const { response, error } = await api.DELETE("/api/v2/providers/connections/{connection_id}", {
        params,
      });
      ensureOK(response, error);
    },
    onSuccess: async () => {
      setDeleteOpen(false);
      await refresh();
    },
  });

  return (
    <article
      className="grid gap-3 rounded-lg border border-line-subtle bg-surface-page p-4"
      data-testid="connection-card"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-0.5">
          <h4 className="text-body font-semibold text-fg-primary">{connection.label}</h4>
          {connection.base_url ? (
            <p className="break-all text-caption text-fg-secondary">{connection.base_url}</p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            disabled={remove.isPending}
            pending={test.isPending}
            onClick={() => test.mutate()}
          >
            {t.settings.test}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={remove.isPending}
            pending={discover.isPending}
            onClick={() => discover.mutate()}
          >
            {t.settings.discover}
          </Button>
        </div>
      </div>

      {test.data?.length === 0 ? (
        <p role="status" className="text-caption text-fg-secondary">
          {t.settings.testedNone}
        </p>
      ) : null}
      {test.data?.length ? (
        <ul className="m-0 grid list-none gap-2 p-0" data-testid="test-results" aria-live="polite">
          {test.data.map((result) => {
            const detail = result.ok
              ? result.code === "stt_verified_silent"
                ? t.settings.sttVerifiedSilent
                : ""
              : (publicMessage({ code: result.code }) ?? t.common.error);
            const latency =
              typeof result.latency_ms === "number" ? `${Math.round(result.latency_ms)} ms` : "";
            const meta = [detail, latency].filter(Boolean).join(" · ");
            return (
              <li
                key={result.role}
                data-failed={!result.ok}
                className={
                  result.ok
                    ? "grid gap-0.5 rounded-sm border-l-3 border-ok bg-ok-soft px-3 py-2 text-caption text-fg-primary"
                    : "grid gap-0.5 rounded-sm border-l-3 border-danger bg-danger-soft px-3 py-2 text-caption text-danger-text"
                }
              >
                <strong>
                  {roleLabel(result.role)} · {result.ok ? t.settings.passed : t.settings.failed}
                </strong>
                {meta ? <small className="text-fg-secondary">{meta}</small> : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {discover.data ? (
        <p role="status" className="text-caption text-fg-secondary">
          {discover.data.models.length ? t.settings.modelCount : t.settings.discoverEmpty}
        </p>
      ) : null}
      {test.isError || discover.isError ? <Problem error={test.error ?? discover.error} /> : null}

      <details className="rounded-md border border-line-subtle bg-surface-card px-3.5 py-2.5">
        <summary className="cursor-pointer select-none text-ui font-medium text-accent-strong">
          {t.settings.edit}
        </summary>
        <form
          className="mt-3 grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            edit.mutate();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t.settings.name} required>
              <TextInput
                name="label"
                value={editLabel}
                maxLength={120}
                required
                onChange={(event) => setEditLabel(event.target.value)}
              />
            </Field>
            {acceptsUrl ? (
              <Field label={t.settings.baseUrl}>
                <TextInput
                  name="base_url"
                  type="url"
                  value={editUrl}
                  onChange={(event) => setEditUrl(event.target.value)}
                />
              </Field>
            ) : null}
          </div>
          {acceptsKey ? (
            <Field label={t.settings.rotate}>
              <SecretInput
                name="api_key"
                value={editKey}
                onChange={(event) => setEditKey(event.target.value)}
              />
            </Field>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" variant="primary" size="sm" disabled={remove.isPending} pending={edit.isPending}>
              {t.common.save}
            </Button>
            <Button
              variant="danger"
              size="sm"
              disabled={edit.isPending}
              pending={remove.isPending}
              onClick={() => setDeleteOpen(true)}
            >
              {t.settings.delete}
            </Button>
            {saved ? (
              <span className="inline-flex items-center gap-1 text-ui font-medium text-ok-text">
                <Check size={15} aria-hidden="true" />
                {t.common.saved}
              </span>
            ) : null}
          </div>
          <ConfirmDialog
            open={deleteOpen}
            onOpenChange={setDeleteOpen}
            title={t.settings.deleteTitle}
            description={t.settings.deleteConfirm}
            confirmLabel={t.settings.confirmDelete}
            cancelLabel={t.common.keep}
            pending={remove.isPending}
            onConfirm={() => remove.mutate()}
          />
          {edit.isError || remove.isError ? <Problem error={edit.error ?? remove.error} /> : null}
        </form>
      </details>
    </article>
  );
}

/**
 * Keeps its expanded state across saves (never remounted on value change, TASK-UX-UPGRADE §十一.1).
 */
function RoleRow({
  role,
  value,
  connections,
  loadedModels,
  busy,
  onSave,
}: {
  role: Role;
  value: ModelRoles[Role];
  connections: Connection[];
  loadedModels: Record<string, string[]>;
  busy: boolean;
  onSave: (role: Role, entry?: NonNullable<ModelRoles[Role]>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [preferredConnectionId, setPreferredConnectionId] = useState(value?.connection_id);
  const connectionId =
    connections.find((entry) => entry.id === preferredConnectionId)?.id ??
    connections.find((entry) => entry.id === value?.connection_id)?.id ??
    connections[0]?.id ??
    "";
  const [modelInput, setModelInput] = useState<string | null>(null);
  const [paramsInput, setParamsInput] = useState<string | null>(null);
  const [validation, setValidation] = useState("");

  const effectiveModel =
    modelInput !== null ? modelInput : connectionId === value?.connection_id ? (value?.model ?? "") : "";
  const effectiveParams =
    paramsInput !== null
      ? paramsInput
      : JSON.stringify(connectionId === value?.connection_id ? (value?.params ?? {}) : {}, null, 2);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setValidation("");
    let params: unknown;
    try {
      params = JSON.parse(effectiveParams.trim() || "{}");
    } catch {
      setValidation(t.settings.invalidParams);
      return;
    }
    if (!params || typeof params !== "object" || Array.isArray(params)) {
      setValidation(t.settings.invalidParams);
      return;
    }
    const model = effectiveModel.trim();
    if (model && connectionId) {
      onSave(role, { connection_id: connectionId, model, params: { ...params } });
    }
  }

  const connectionOptions = connections.map((entry) => ({ value: entry.id, label: entry.label }));
  const suggestions = loadedModels[connectionId] ?? [];

  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="border-b border-line-subtle last:border-b-0"
      data-testid="role-row"
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 py-3 text-ui">
        <span className="flex flex-wrap items-center gap-3">
          <strong className="min-w-[84px] font-semibold text-fg-primary">{roleLabel(role)}</strong>
          <small className="text-caption text-fg-secondary">{value?.model ?? t.settings.noRole}</small>
        </span>
        <ChevronDown
          size={16}
          aria-hidden="true"
          className={open ? "rotate-180 text-fg-secondary transition-transform" : "text-fg-secondary transition-transform"}
        />
      </summary>

      <form className="grid gap-3 pb-4" onSubmit={submit}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t.settings.useConnection}>
            <Select
              aria-label={t.settings.useConnection}
              options={connectionOptions}
              value={connectionId}
              onValueChange={(next) => {
                setPreferredConnectionId(next);
                setModelInput(null);
                setParamsInput(null);
              }}
            />
          </Field>
          <Field label={t.settings.modelId} required>
            <TextInput
              name="model"
              list={`models-${connectionId}`}
              value={effectiveModel}
              maxLength={256}
              required
              onChange={(event) => setModelInput(event.target.value)}
            />
          </Field>
        </div>

        {suggestions.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {suggestions.slice(0, 8).map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => setModelInput(item)}
                className="rounded-pill border border-line-subtle bg-surface-sunken px-2.5 py-0.5 text-caption text-fg-secondary hover:border-accent hover:text-accent-strong"
              >
                {item}
              </button>
            ))}
          </div>
        ) : null}

        <details className="rounded-md border border-line-subtle bg-surface-page px-3 py-2">
          <summary className="cursor-pointer select-none text-caption font-medium text-fg-secondary">
            {t.settings.advanced}
          </summary>
          <div className="mt-2">
            <Field label={t.settings.parameters} error={validation || undefined}>
              <Textarea
                spellCheck={false}
                name="params"
                rows={3}
                value={effectiveParams}
                onChange={(event) => setParamsInput(event.target.value)}
              />
            </Field>
          </div>
        </details>

        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" variant="primary" size="sm" pending={busy}>
            {t.settings.roleSave}
          </Button>
          {value ? (
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => {
                setModelInput("");
                onSave(role);
              }}
            >
              {t.settings.clearRole}
            </Button>
          ) : null}
        </div>
        {validation ? (
          <p role="alert" className="text-caption text-danger-text">
            {validation}
          </p>
        ) : null}
      </form>
    </details>
  );
}

export function ModelSettings() {
  const [searchParams] = useSearchParams();
  const [loadedModels, setLoadedModels] = useState<Record<string, string[]>>({});
  const [wizardOpen, setWizardOpen] = useState(false);
  const testChatRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();
  const readiness = useReadiness();
  const { saved, notifySaved } = useTransientSaved(t.common.saved);

  const presets = useQuery({ queryKey: ["presets"], queryFn: fetchPresets });
  const connections = useQuery({ queryKey: connectionsKey, queryFn: fetchConnections });
  const assignments = useQuery({ queryKey: rolesKey, queryFn: fetchRoles });

  useEffect(() => {
    if (searchParams.get("tab") === "test") {
      testChatRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [searchParams]);

  const save = useMutation({
    mutationFn: async (body: ModelRoles) =>
      bodyOf(await api.PUT("/api/v2/settings/model-roles", { body })),
    onSuccess: (values) => {
      queryClient.setQueryData(rolesKey, values);
      void queryClient.invalidateQueries({ queryKey: voiceStatusKey });
      readiness.refetch();
      notifySaved();
    },
  });

  function setRole(role: Role, entry?: NonNullable<ModelRoles[Role]>) {
    const next = { ...assignments.data };
    if (entry) next[role] = entry;
    else delete next[role];
    save.mutate(next);
  }

  const readinessCaps = [
    { key: "live", label: t.connectWizard.caps.live, ready: readiness.canTeach, fixTo: null },
    { key: "analysis", label: t.connectWizard.caps.analysis, ready: readiness.canAnalyze, fixTo: null },
    { key: "checker", label: t.connectWizard.caps.checker, ready: readiness.canCheck, fixTo: null },
    { key: "vision", label: t.connectWizard.caps.vision, ready: readiness.canSeeImages, fixTo: null },
    { key: "stt", label: t.connectWizard.caps.stt, ready: readiness.canUseVoice, fixTo: "/settings/voice" },
  ] as const;

  return (
    <div className="grid gap-5">
      <ConnectWizardDialog open={wizardOpen} onOpenChange={setWizardOpen} />

      {/* 5-Capability Readiness Overview (§5.13) */}
      <Card padding="lg" className="grid gap-4" data-testid="ai-readiness-card">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line-subtle pb-3">
          <div className="grid gap-0.5">
            <h2 className="text-title font-semibold text-fg-primary">{t.settings.aiReadiness}</h2>
            <p className="text-ui text-fg-secondary">{t.settings.aiReadinessHint}</p>
          </div>
          <Button
            variant="primary"
            leftIcon={<Plus size={16} aria-hidden="true" />}
            onClick={() => setWizardOpen(true)}
          >
            {t.settings.aiAddService}
          </Button>
        </div>

        <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
          {readinessCaps.map((cap) => (
            <div
              key={cap.key}
              className="flex items-center justify-between gap-2 rounded-md border border-line-subtle bg-surface-page px-3.5 py-2.5"
            >
              <span className="inline-flex items-center gap-2 text-ui font-medium text-fg-primary">
                {cap.ready ? (
                  <CheckCircle2 size={16} className="text-ok shrink-0" aria-hidden="true" />
                ) : (
                  <XCircle size={16} className="text-fg-tertiary shrink-0" aria-hidden="true" />
                )}
                <span>{cap.label}</span>
              </span>
              {cap.ready ? (
                <Badge tone="ok">{t.settings.aiReadinessReady}</Badge>
              ) : cap.fixTo ? (
                <Link
                  to={cap.fixTo}
                  className="text-caption font-medium text-accent-strong hover:underline"
                >
                  {t.settings.aiFix}
                </Link>
              ) : (
                <button
                  type="button"
                  onClick={() => setWizardOpen(true)}
                  className="text-caption font-medium text-accent-strong hover:underline"
                >
                  {t.settings.aiFix}
                </button>
              )}
            </div>
          ))}
        </div>
      </Card>

      {/* Connected Services + Manual Form */}
      <Card padding="lg" className="grid gap-4">
        <h3 className="text-body font-semibold text-fg-primary">{t.settings.connections}</h3>
        {connections.isPending ? <Loading /> : null}
        {connections.isError ? (
          <Problem error={connections.error} onRetry={() => void connections.refetch()} />
        ) : null}
        {connections.data?.length === 0 ? (
          <p className="text-ui text-fg-secondary">{t.settings.noConnections}</p>
        ) : null}
        {connections.data?.length ? (
          <div className="grid gap-3">
            {connections.data.map((connection) => (
              <ConnectionRow
                key={connection.id}
                connection={connection}
                onModels={(id, models) =>
                  setLoadedModels((current) => ({ ...current, [id]: models }))
                }
              />
            ))}
          </div>
        ) : null}

        <details
          data-testid="manual-connect-details"
          className="rounded-md border border-line-subtle bg-surface-page px-4 py-3"
        >
          <summary className="cursor-pointer select-none text-ui font-medium text-accent-strong">
            {t.settings.aiCustomForm}
          </summary>
          <div className="mt-4">
            {presets.isPending ? <Loading /> : null}
            {presets.isError ? (
              <Problem error={presets.error} onRetry={() => void presets.refetch()} />
            ) : null}
            {presets.data ? <ConnectForm presets={presets.data} /> : null}
          </div>
        </details>
      </Card>

      {/* Embedded Test Conversation (ex-试聊) */}
      <div ref={testChatRef}>
        <DiagnosticsPanel embedded onOpenConnect={() => setWizardOpen(true)} />
      </div>

      {/* Advanced: Per-capability Model Assignment (rows stay open on save!) */}
      <Card padding="lg" className="grid gap-3" data-advanced="true">
        <details data-testid="advanced-roles-details">
          <summary className="cursor-pointer select-none text-body font-semibold text-fg-primary">
            {t.settings.aiAdvancedRoles}
          </summary>
          <div className="mt-4 grid gap-3">
            {assignments.isPending ? <Loading /> : null}
            {assignments.isError ? (
              <Problem error={assignments.error} onRetry={() => void assignments.refetch()} />
            ) : null}
            {connections.data?.length === 0 ? (
              <p className="text-ui text-fg-secondary">{t.settings.roleNone}</p>
            ) : null}
            {connections.data?.length && assignments.data ? (
              <div className="grid">
                {Object.entries(loadedModels).map(([id, models]) => (
                  <datalist key={id} id={`models-${id}`}>
                    {models.map((model) => (
                      <option key={model} value={model} />
                    ))}
                  </datalist>
                ))}
                {roles.map((role) => (
                  <RoleRow
                    key={role}
                    role={role}
                    value={assignments.data[role]}
                    connections={connections.data}
                    loadedModels={loadedModels}
                    busy={save.isPending}
                    onSave={setRole}
                  />
                ))}
              </div>
            ) : null}
            {save.isError ? <Problem error={save.error} /> : null}
            {saved ? (
              <p className="inline-flex items-center gap-1 text-ui font-medium text-ok-text">
                <Check size={15} aria-hidden="true" />
                {t.common.saved}
              </p>
            ) : null}
          </div>
        </details>
      </Card>
    </div>
  );
}
