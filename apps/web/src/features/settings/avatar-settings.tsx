import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { components } from "@companion-space/api-client/schema";
import {
  api,
  avatarDriversKey,
  bodyOf,
  fetchAvatarDriverSettings,
  type AvatarDriverSettings,
} from "../../app/api";
import { Loading, Problem } from "../../app/ui";
import { Button, Check, useTransientSaved } from "../../ui";
import t from "../../locales/zh-CN.json";

const copy = t.avatarSettings;
type LocalSidecarEntry = components["schemas"]["LocalSidecarEntry"];
type SidecarTestResult = components["schemas"]["SidecarTestResult"];

function nextSidecarId(entries: LocalSidecarEntry[]): string {
  const existing = new Set(entries.map((entry) => entry.id));
  let index = 1;
  while (existing.has(`local-gpu-${index}`)) index += 1;
  return `local-gpu-${index}`;
}

function AvatarSettingsForm({ initial }: { initial: AvatarDriverSettings }) {
  const queries = useQueryClient();
  const [draft, setDraft] = useState<AvatarDriverSettings>(() => ({
    default_sidecar_id: initial.default_sidecar_id ?? null,
    local_sidecars: (initial.local_sidecars ?? []).map((entry) => ({ ...entry })),
    cloud_live: {
      enabled: initial.cloud_live?.enabled ?? false,
      connection_id: initial.cloud_live?.connection_id ?? null,
      model: initial.cloud_live?.model ?? null,
      idle_suspend_sec: initial.cloud_live?.idle_suspend_sec ?? 30,
      max_session_minutes: initial.cloud_live?.max_session_minutes ?? 10,
      max_session_cost_cny: initial.cloud_live?.max_session_cost_cny ?? 20,
    },
  }));
  const [probes, setProbes] = useState<Record<string, SidecarTestResult>>({});
  const [probingId, setProbingId] = useState<string | null>(null);
  const { saved, notifySaved } = useTransientSaved(t.common.saved);

  const save = useMutation({
    mutationFn: async (body: AvatarDriverSettings) =>
      bodyOf(await api.PUT("/api/v2/avatar-drivers/settings", { body })),
    onSuccess(result) {
      queries.setQueryData(avatarDriversKey, result);
      setDraft(result);
      notifySaved();
    },
  });

  const probe = useMutation({
    mutationFn: async (entry: LocalSidecarEntry) => {
      setProbingId(entry.id);
      const result = bodyOf(
        await api.POST("/api/v2/avatar-drivers/sidecars/test", {
          body: { base_url: entry.base_url, allow_lan: Boolean(entry.allow_lan) },
        }),
      );
      return { id: entry.id, result };
    },
    onSuccess({ id, result }) {
      setProbes((prev) => ({ ...prev, [id]: result }));
    },
    onSettled() {
      setProbingId(null);
    },
  });

  function updateSidecar(id: string, patch: Partial<LocalSidecarEntry>) {
    setDraft((prev) => ({
      ...prev,
      local_sidecars: (prev.local_sidecars ?? []).map((entry) =>
        entry.id === id ? { ...entry, ...patch } : entry,
      ),
    }));
  }

  function addSidecar() {
    const current = draft.local_sidecars ?? [];
    const id = nextSidecarId(current);
    const entry: LocalSidecarEntry = {
      id,
      label: `${copy.newDriverLabel} ${current.length + 1}`,
      base_url: "http://127.0.0.1:8090",
      allow_lan: false,
      transport_preference: "auto",
      enabled: true,
    };
    setDraft((prev) => ({
      ...prev,
      default_sidecar_id: prev.default_sidecar_id ?? id,
      local_sidecars: [...(prev.local_sidecars ?? []), entry],
    }));
  }

  function removeSidecar(id: string) {
    setDraft((prev) => ({
      ...prev,
      default_sidecar_id: prev.default_sidecar_id === id ? null : prev.default_sidecar_id,
      local_sidecars: (prev.local_sidecars ?? []).filter((entry) => entry.id !== id),
    }));
    setProbes((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    save.mutate(draft);
  }

  const sidecars = draft.local_sidecars ?? [];
  const cloud = draft.cloud_live ?? {
    enabled: false,
    connection_id: null,
    model: null,
    idle_suspend_sec: 30,
    max_session_minutes: 10,
    max_session_cost_cny: 20,
  };

  return (
    <form className="fields" onSubmit={submit}>
      <p className="hint">{copy.lead}</p>

      <div className="fields">
        <h3>{copy.sidecarsTitle}</h3>
        <p className="hint">{copy.sidecarsHint}</p>
        <p className="hint"><code>{copy.protocolHint}</code></p>

        {sidecars.length > 0 ? (
          <label>
            {copy.defaultDriver}
            <select
              value={draft.default_sidecar_id ?? ""}
              onChange={(event) =>
                setDraft((prev) => ({
                  ...prev,
                  default_sidecar_id: event.target.value || null,
                }))
              }
            >
              <option value="">{copy.noDefault}</option>
              {sidecars.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label} ({entry.base_url})
                </option>
              ))}
            </select>
          </label>
        ) : (
          <p className="hint">{copy.sidecarsEmpty}</p>
        )}

        <div className="connection-list">
          {sidecars.map((entry) => {
            const probeResult = probes[entry.id];
            const isTesting = probingId === entry.id && probe.isPending;
            return (
              <article className="connection" key={entry.id}>
                <div className="field-row">
                  <label>
                    {copy.label}
                    <input
                      value={entry.label}
                      maxLength={120}
                      required
                      onChange={(event) => updateSidecar(entry.id, { label: event.target.value })}
                    />
                  </label>
                  <label>
                    {copy.url}
                    <input
                      type="url"
                      value={entry.base_url}
                      maxLength={512}
                      placeholder={copy.urlPlaceholder}
                      required
                      onChange={(event) => updateSidecar(entry.id, { base_url: event.target.value })}
                    />
                  </label>
                </div>
                <div className="field-row">
                  <label>
                    {copy.transport}
                    <select
                      value={entry.transport_preference ?? "auto"}
                      onChange={(event) =>
                        updateSidecar(entry.id, {
                          transport_preference: event.target.value as LocalSidecarEntry["transport_preference"],
                        })
                      }
                    >
                      {Object.entries(copy.transports).map(([value, label]) => (
                        <option key={value} value={value}>{label}</option>
                      ))}
                    </select>
                  </label>
                  <div className="actions">
                    <label className="check-field">
                      <input
                        type="checkbox"
                        checked={entry.enabled ?? true}
                        onChange={(event) => updateSidecar(entry.id, { enabled: event.target.checked })}
                      />
                      <span>{copy.enabled}</span>
                    </label>
                    <label className="check-field">
                      <input
                        type="checkbox"
                        checked={entry.allow_lan ?? false}
                        onChange={(event) => updateSidecar(entry.id, { allow_lan: event.target.checked })}
                      />
                      <span>{copy.allowLan}</span>
                    </label>
                  </div>
                </div>
                <div className="actions">
                  <button
                    type="button"
                    className="button quiet"
                    disabled={probe.isPending || !entry.base_url.trim()}
                    aria-busy={isTesting || undefined}
                    onClick={() => probe.mutate(entry)}
                  >
                    {isTesting ? copy.testing : copy.test}
                  </button>
                  <button
                    type="button"
                    className="button danger-action"
                    onClick={() => removeSidecar(entry.id)}
                  >
                    {t.common.remove}
                  </button>
                </div>
                {probeResult ? (
                  <ul className="test-results" aria-live="polite">
                    <li data-failed={!probeResult.ok}>
                      <span>
                        {probeResult.ok && probeResult.capabilities
                          ? copy.probeOk
                              .replace("{driver}", probeResult.capabilities.driver_name)
                              .replace("{fps}", String(probeResult.capabilities.max_fps ?? 25))
                              .replace("{ms}", String(probeResult.latency_ms))
                          : copy.probeFailed.replace("{error}", probeResult.error ?? t.common.error)}
                      </span>
                      {probeResult.capabilities?.gpu_info ? (
                        <small>{copy.gpuLabel.replace("{gpu}", probeResult.capabilities.gpu_info)}</small>
                      ) : null}
                    </li>
                  </ul>
                ) : null}
              </article>
            );
          })}
        </div>

        <div className="actions">
          <button type="button" className="button quiet" onClick={addSidecar}>
            {copy.addDriver}
          </button>
        </div>
      </div>

      <div className="fields">
        <h3>{copy.cloudTitle}</h3>
        <p className="hint">{copy.cloudHint}</p>
        <label className="check-field">
          <input
            type="checkbox"
            checked={cloud.enabled ?? false}
            onChange={(event) =>
              setDraft((prev) => ({
                ...prev,
                cloud_live: { ...cloud, enabled: event.target.checked },
              }))
            }
          />
          <span>{copy.cloudEnabled}</span>
        </label>
        <div className="field-row">
          <label>
            {copy.idleSuspendSec}
            <input
              type="number"
              min="5"
              max="300"
              step="1"
              value={cloud.idle_suspend_sec ?? 30}
              onChange={(event) =>
                setDraft((prev) => ({
                  ...prev,
                  cloud_live: { ...cloud, idle_suspend_sec: Number(event.target.value) },
                }))
              }
            />
          </label>
          <label>
            {copy.maxSessionMin}
            <input
              type="number"
              min="1"
              max="120"
              step="1"
              value={cloud.max_session_minutes ?? 10}
              onChange={(event) =>
                setDraft((prev) => ({
                  ...prev,
                  cloud_live: { ...cloud, max_session_minutes: Number(event.target.value) },
                }))
              }
            />
          </label>
        </div>
        <label>
          {copy.maxSessionCost}
          <input
            type="number"
            min="1"
            max="500"
            step="0.5"
            value={cloud.max_session_cost_cny ?? 20}
            onChange={(event) =>
              setDraft((prev) => ({
                ...prev,
                cloud_live: { ...cloud, max_session_cost_cny: Number(event.target.value) },
              }))
            }
          />
        </label>
      </div>

      <div className="actions">
        <Button type="submit" variant="primary" pending={save.isPending}>
          {t.common.save}
        </Button>
        {saved ? <span className="inline-flex items-center gap-1 text-ui font-medium text-ok-text"><Check size={15} aria-hidden="true" />{t.common.saved}</span> : null}
      </div>
      {save.isError ? <Problem error={save.error} /> : null}
      {probe.isError ? <Problem error={probe.error} /> : null}
    </form>
  );
}

export function AvatarSettingsPanel() {
  const settings = useQuery({
    queryKey: avatarDriversKey,
    queryFn: fetchAvatarDriverSettings,
  });
  if (settings.isPending) return <Loading />;
  if (settings.isError) return <Problem error={settings.error} onRetry={() => void settings.refetch()} />;
  return <AvatarSettingsForm initial={settings.data} />;
}
