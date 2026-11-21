import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, bodyOf, connectionsKey, ensureOK, fetchConnections, fetchRoles, publicMessage, rolesKey, type Connection, type ModelRoles } from "../../app/api";
import { Loading, Problem } from "../../app/ui";
import { ArrowUpRight, Button, Check, ChevronDown, ConfirmDialog, useTransientSaved } from "../../ui";
import t from "../../locales/zh-CN.json";

async function fetchPresets() {
  return bodyOf(await api.GET("/api/v2/providers/presets"));
}

type Preset = Awaited<ReturnType<typeof fetchPresets>>[number];
type Role = keyof typeof t.roles;
const roles = Object.keys(t.roles) as Role[];
const recommendations = {
  free: ["https://open.bigmodel.cn/", "https://api.siliconflow.cn/"],
  paid: ["https://api.deepseek.com"],
};

function roleLabel(role: string) {
  return t.roles[role as Role] ?? role;
}

function ConnectForm({ presets }: { presets: Preset[] }) {
  const [cost, setCost] = useState<"free" | "paid" | "all">("free");
  const [presetId, setPresetId] = useState("");
  const queryClient = useQueryClient();
  const { saved, notifySaved } = useTransientSaved(t.common.saved);
  const create = useMutation({
    mutationFn: async (data: FormData) => {
      const values = (field: string) => String(data.get(field) ?? "").trim();
      return bodyOf(await api.POST("/api/v2/providers/connections", { body: {
        label: values("label") || null,
        base_url: values("base_url") || null,
        api_key: values("api_key"),
        preset_id: values("preset_id"),
      } }));
    },
    onSuccess: async () => {
      await Promise.all([queryClient.invalidateQueries({ queryKey: connectionsKey }), queryClient.invalidateQueries({ queryKey: rolesKey })]);
      notifySaved();
    },
  });
  const suggested = cost === "all" ? presets : presets.filter((entry) => recommendations[cost].some((base) => entry.base_url?.startsWith(base)));
  const visible = suggested.length ? suggested : presets;
  const preset = visible.find((entry) => entry.id === presetId) ?? visible[0];
  if (!preset) return <p className="hint">{t.settings.noConnections}</p>;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const keyInput = event.currentTarget.elements.namedItem("api_key");
    create.mutate(new FormData(event.currentTarget), {
      onSuccess: () => { if (keyInput instanceof HTMLInputElement) keyInput.value = ""; },
    });
  }

  return (
    <form className="fields" onSubmit={submit}>
      <div className="cost-choice" aria-label={t.settings.preset}>
        <button type="button" className="button quiet" aria-pressed={cost === "free"} onClick={() => setCost("free")}>{t.settings.free}</button>
        <button type="button" className="button quiet" aria-pressed={cost === "paid"} onClick={() => setCost("paid")}>{t.settings.paid}</button>
        <button type="button" className="button quiet" aria-pressed={cost === "all"} onClick={() => setCost("all")}>{t.settings.all}</button>
      </div>
      {cost === "free" ? <p className="preset-note">{t.settings.recommendFree}</p> : null}
      {cost === "paid" ? <p className="preset-note">{t.settings.recommendPaid}</p> : null}
      <label>{t.settings.preset}
        <select name="preset_id" value={preset.id} onChange={(event) => { create.reset(); setPresetId(event.target.value); }}>
          {visible.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
        </select>
      </label>
      <div className="field-row" key={preset.id}>
        <label>{t.settings.name}<input name="label" defaultValue={preset.label} maxLength={120} /></label>
        <label>{t.settings.baseUrl}<input name="base_url" type="url" defaultValue={preset.base_url ?? ""} placeholder={t.settings.customUrl} required={!preset.base_url} /></label>
      </div>
      <label>{t.settings.apiKey}<input key={preset.id} name="api_key" type="password" autoComplete="new-password" spellCheck={false} required={preset.requires_api_key} /></label>
      {preset.free_tier_note ? <p className="hint">{preset.free_tier_note}</p> : null}
      {preset.manual_live ? <p className="hint">{preset.manual_live}</p> : null}
      <div className="actions">
        <Button type="submit" variant="primary" pending={create.isPending}>{t.settings.create}</Button>
        {preset.key_url ? <a className="text-link" href={preset.key_url} target="_blank" rel="noreferrer">{t.settings.getKey}<ArrowUpRight size={15} aria-hidden="true" /></a> : null}
        {saved ? <span className="inline-flex items-center gap-1 text-ui font-medium text-ok-text"><Check size={15} aria-hidden="true" />{t.common.saved}</span> : null}
      </div>
      {create.isError ? <Problem error={create.error} /> : null}
    </form>
  );
}

function ConnectionRow({ connection, onModels }: { connection: Connection; onModels: (id: string, entries: string[]) => void }) {
  const queries = useQueryClient();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const { saved, notifySaved } = useTransientSaved(t.common.saved);
  const params = { path: { connection_id: connection.id } };
  const refresh = async () => {
    await Promise.all([queries.invalidateQueries({ queryKey: connectionsKey }), queries.invalidateQueries({ queryKey: rolesKey })]);
  };
  const test = useMutation({
    mutationFn: async () => bodyOf(await api.POST("/api/v2/providers/connections/{connection_id}/test", { params })),
  });
  const discover = useMutation({
    mutationFn: async () => bodyOf(await api.GET("/api/v2/providers/connections/{connection_id}/models", { params })),
    onSuccess: ({ models }) => onModels(connection.id, models),
  });
  const edit = useMutation({
    mutationFn: async (data: FormData) => {
      const key = String(data.get("api_key") ?? "").trim();
      return bodyOf(await api.PATCH("/api/v2/providers/connections/{connection_id}", { params, body: {
        label: String(data.get("label") ?? "").trim(),
        base_url: String(data.get("base_url") ?? "").trim() || null,
        ...(key ? { api_key: key } : {}),
      } }));
    },
    onSuccess: async () => {
      await refresh();
      notifySaved();
    },
  });
  const remove = useMutation({
    mutationFn: async () => {
      const { response, error } = await api.DELETE("/api/v2/providers/connections/{connection_id}", { params });
      ensureOK(response, error);
    },
    onSuccess: async () => {
      setDeleteOpen(false);
      await refresh();
    },
  });
  return (
    <article className="connection" data-testid="connection-card">
      <h3>{connection.label}</h3>
      {connection.base_url ? <p className="hint">{connection.base_url}</p> : null}
      <div className="actions">
        <Button variant="secondary" disabled={remove.isPending} pending={test.isPending} onClick={() => test.mutate()}>
          {t.settings.test}
        </Button>
        <Button variant="secondary" disabled={remove.isPending} pending={discover.isPending} onClick={() => discover.mutate()}>
          {t.settings.discover}
        </Button>
      </div>
      {test.data?.length === 0 ? <p role="status" className="hint">{t.settings.testedNone}</p> : null}
      {test.data?.length ? (
        <ul className="test-results" data-testid="test-results" aria-live="polite">
          {test.data.map((result) => {
            const detail = result.ok
              ? (result.code === "stt_verified_silent" ? t.settings.sttVerifiedSilent : "")
              : (publicMessage({ code: result.code }) ?? t.common.error);
            const latency = typeof result.latency_ms === "number" ? `${Math.round(result.latency_ms)} ms` : "";
            const meta = [detail, latency].filter(Boolean).join(" · ");
            return (
              <li key={result.role} data-failed={!result.ok}>
                <strong>{roleLabel(result.role)} · {result.ok ? t.settings.passed : t.settings.failed}</strong>
                {meta ? <small>{meta}</small> : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {discover.data ? <p role="status" className="hint">{discover.data.models.length ? t.settings.modelCount : t.settings.discoverEmpty}</p> : null}
      {test.isError || discover.isError ? <Problem error={test.error ?? discover.error} /> : null}
      <details>
        <summary>{t.settings.edit}</summary>
        <form className="fields" onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const input = form.elements.namedItem("api_key");
          edit.mutate(new FormData(form), { onSuccess: () => { if (input instanceof HTMLInputElement) input.value = ""; } });
        }}>
          <label>{t.settings.name}<input name="label" defaultValue={connection.label} maxLength={120} required /></label>
          <label>{t.settings.baseUrl}<input name="base_url" type="url" defaultValue={connection.base_url ?? ""} /></label>
          <label>{t.settings.rotate}<input name="api_key" type="password" autoComplete="new-password" spellCheck={false} /></label>
          <div className="actions">
            <Button type="submit" variant="primary" disabled={remove.isPending} pending={edit.isPending}>{t.common.save}</Button>
            <Button variant="danger" disabled={edit.isPending} pending={remove.isPending} onClick={() => setDeleteOpen(true)}>{t.settings.delete}</Button>
            {saved ? <span className="inline-flex items-center gap-1 text-ui font-medium text-ok-text"><Check size={15} aria-hidden="true" />{t.common.saved}</span> : null}
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

function RoleRow({ role, value, connections, busy, onSave }: {
  role: Role; value: ModelRoles[Role]; connections: Connection[]; busy: boolean;
  onSave: (role: Role, entry?: NonNullable<ModelRoles[Role]>) => void;
}) {
  const [preferredConnectionId, setPreferredConnectionId] = useState(value?.connection_id);
  const connectionId = connections.find((entry) => entry.id === preferredConnectionId)?.id ?? connections[0]?.id ?? "";
  const [validation, setValidation] = useState("");
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setValidation("");
    const data = new FormData(event.currentTarget);
    let params: unknown;
    try {
      params = JSON.parse(String(data.get("params") ?? "").trim() || "{}");
    } catch {
      setValidation(t.settings.invalidParams);
      return;
    }
    if (!params || typeof params !== "object" || Array.isArray(params)) {
      setValidation(t.settings.invalidParams);
      return;
    }
    const model = String(data.get("model") ?? "").trim();
    if (model && connectionId) onSave(role, { connection_id: connectionId, model, params: { ...params } });
  }
  return (
    <details className="role-row" data-testid="role-row">
      <summary><span className="role-caption"><strong>{roleLabel(role)}</strong><small>{value?.model ?? t.settings.noRole}</small></span><ChevronDown size={16} aria-hidden="true" /></summary>
      <form className="fields" onSubmit={submit}>
        <div className="field-row">
          <label>{t.settings.useConnection}
            <select name="connection_id" value={connectionId} required onChange={(event) => setPreferredConnectionId(event.target.value)}>
              {connections.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
            </select>
          </label>
          <label>{t.settings.modelId}<input name="model" key={connectionId} list={`models-${connectionId}`} defaultValue={connectionId === value?.connection_id ? value.model : ""} maxLength={256} required /></label>
        </div>
        <details>
          <summary>{t.settings.advanced}</summary>
          <label>{t.settings.parameters}<textarea key={connectionId} spellCheck={false} name="params" rows={3} defaultValue={JSON.stringify(connectionId === value?.connection_id ? value.params : {}, null, 2)} /></label>
        </details>
        <div className="actions">
          <button className="button primary" disabled={busy} aria-busy={busy || undefined}>{t.settings.roleSave}</button>
          {value ? <button type="button" className="button quiet" disabled={busy} aria-busy={busy || undefined} onClick={() => onSave(role)}>{t.settings.clearRole}</button> : null}
        </div>
        {validation ? <p role="alert" className="hint">{validation}</p> : null}
      </form>
    </details>
  );
}

export function ModelSettings() {
  const [loadedModels, setLoadedModels] = useState<Record<string, string[]>>({});
  const queryClient = useQueryClient();
  const { saved, notifySaved } = useTransientSaved(t.common.saved);
  const presets = useQuery({ queryKey: ["presets"], queryFn: fetchPresets });
  const connections = useQuery({ queryKey: connectionsKey, queryFn: fetchConnections });
  const assignments = useQuery({ queryKey: rolesKey, queryFn: fetchRoles });
  const save = useMutation({
    mutationFn: async (body: ModelRoles) => bodyOf(await api.PUT("/api/v2/settings/model-roles", { body })),
    onSuccess: (values) => {
      queryClient.setQueryData(rolesKey, values);
      notifySaved();
    },
  });
  function setRole(role: Role, entry?: NonNullable<ModelRoles[Role]>) {
    const next = { ...assignments.data };
    if (entry) next[role] = entry;
    else delete next[role];
    save.mutate(next);
  }
  return (
    <>
      <h2>{t.settings.models}</h2>
      {presets.isPending ? <Loading /> : null}
      {presets.isError ? <Problem error={presets.error} onRetry={() => void presets.refetch()} /> : null}
      {presets.data ? <ConnectForm presets={presets.data} /> : null}
      <h3>{t.settings.connections}</h3>
      {connections.isPending ? <Loading /> : null}
      {connections.isError ? <Problem error={connections.error} onRetry={() => void connections.refetch()} /> : null}
      {connections.data?.length === 0 ? <p className="hint">{t.settings.noConnections}</p> : null}
      {connections.data?.length ? (
        <div className="connection-list">
          {connections.data.map((connection) => (
            <ConnectionRow key={connection.id} connection={connection} onModels={(id, models) => setLoadedModels((current) => ({ ...current, [id]: models }))} />
          ))}
        </div>
      ) : null}
      <h3>{t.settings.roles}</h3>
      {assignments.isPending ? <Loading /> : null}
      {assignments.isError ? <Problem error={assignments.error} onRetry={() => void assignments.refetch()} /> : null}
      {connections.data?.length === 0 ? <p className="hint">{t.settings.roleNone}</p> : null}
      {connections.data?.length && assignments.data ? (
        <div className="role-list">
          {Object.entries(loadedModels).map(([id, models]) => (
            <datalist key={id} id={`models-${id}`}>{models.map((model) => <option key={model} value={model} />)}</datalist>
          ))}
          {roles.map((role) => (
            <RoleRow key={`${role}:${JSON.stringify(assignments.data[role])}`} role={role} value={assignments.data[role]}
              connections={connections.data} busy={save.isPending} onSave={setRole} />
          ))}
        </div>
      ) : null}
      {save.isError ? <Problem error={save.error} /> : null}
      {saved ? <p className="inline-flex items-center gap-1 text-ui font-medium text-ok-text"><Check size={15} aria-hidden="true" />{t.common.saved}</p> : null}
    </>
  );
}
