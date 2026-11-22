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
import {
  Button,
  Card,
  Check,
  Checkbox,
  Field,
  Select,
  TextInput,
  useTransientSaved,
} from "../../ui";
import t from "../../locales/zh-CN.json";

const copy = t.avatarSettings;
type LocalSidecarEntry = components["schemas"]["LocalSidecarEntry"];
type SidecarTestResult = components["schemas"]["SidecarTestResult"];

const TRANSPORT_OPTIONS = Object.entries(copy.transports).map(([value, label]) => ({
  value,
  label,
}));

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

  const defaultOptions = [
    { value: "", label: copy.noDefault },
    ...sidecars.map((entry) => ({ value: entry.id, label: `${entry.label} (${entry.base_url})` })),
  ];

  return (
    <Card padding="lg" className="grid gap-5">
      <div className="grid gap-1 border-b border-line-subtle pb-3">
        <h3 className="text-body font-semibold text-fg-primary">{copy.sidecarsTitle}</h3>
        <p className="text-ui text-fg-secondary">{copy.lead}</p>
      </div>

      <form className="grid max-w-2xl gap-5" onSubmit={submit}>
        <div className="grid gap-3">
          <p className="text-caption text-fg-secondary">{copy.sidecarsHint}</p>
          <code className="block overflow-x-auto rounded-sm bg-surface-sunken px-3 py-2 text-caption text-fg-secondary">
            {copy.protocolHint}
          </code>

          {sidecars.length > 0 ? (
            <Field label={copy.defaultDriver}>
              <Select
                aria-label={copy.defaultDriver}
                options={defaultOptions}
                value={draft.default_sidecar_id ?? ""}
                onValueChange={(next) =>
                  setDraft((prev) => ({ ...prev, default_sidecar_id: next || null }))
                }
              />
            </Field>
          ) : (
            <p className="text-ui text-fg-secondary">{copy.sidecarsEmpty}</p>
          )}

          <div className="grid gap-3">
            {sidecars.map((entry) => {
              const probeResult = probes[entry.id];
              const isTesting = probingId === entry.id && probe.isPending;
              return (
                <article
                  key={entry.id}
                  className="grid gap-3 rounded-md border border-line-subtle bg-surface-page p-4"
                >
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label={copy.label} required>
                      <TextInput
                        value={entry.label}
                        maxLength={120}
                        required
                        onChange={(event) => updateSidecar(entry.id, { label: event.target.value })}
                      />
                    </Field>
                    <Field label={copy.url} required>
                      <TextInput
                        type="url"
                        value={entry.base_url}
                        maxLength={512}
                        placeholder={copy.urlPlaceholder}
                        required
                        onChange={(event) => updateSidecar(entry.id, { base_url: event.target.value })}
                      />
                    </Field>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2 sm:items-end">
                    <Field label={copy.transport}>
                      <Select
                        aria-label={copy.transport}
                        options={TRANSPORT_OPTIONS}
                        value={entry.transport_preference ?? "auto"}
                        onValueChange={(next) =>
                          updateSidecar(entry.id, {
                            transport_preference: next as LocalSidecarEntry["transport_preference"],
                          })
                        }
                      />
                    </Field>
                    <div className="flex flex-wrap items-center gap-4 pb-1">
                      <Checkbox
                        label={copy.enabled}
                        checked={entry.enabled ?? true}
                        onChange={(event) => updateSidecar(entry.id, { enabled: event.target.checked })}
                      />
                      <Checkbox
                        label={copy.allowLan}
                        checked={entry.allow_lan ?? false}
                        onChange={(event) => updateSidecar(entry.id, { allow_lan: event.target.checked })}
                      />
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={probe.isPending || !entry.base_url.trim()}
                      pending={isTesting}
                      onClick={() => probe.mutate(entry)}
                    >
                      {isTesting ? copy.testing : copy.test}
                    </Button>
                    <Button variant="danger" size="sm" onClick={() => removeSidecar(entry.id)}>
                      {t.common.remove}
                    </Button>
                  </div>
                  {probeResult ? (
                    <div
                      aria-live="polite"
                      className={
                        probeResult.ok
                          ? "grid gap-0.5 rounded-sm border-l-3 border-ok bg-ok-soft px-3 py-2 text-caption text-fg-primary"
                          : "grid gap-0.5 rounded-sm border-l-3 border-danger bg-danger-soft px-3 py-2 text-caption text-danger-text"
                      }
                    >
                      <span>
                        {probeResult.ok && probeResult.capabilities
                          ? copy.probeOk
                              .replace("{driver}", probeResult.capabilities.driver_name)
                              .replace("{fps}", String(probeResult.capabilities.max_fps ?? 25))
                              .replace("{ms}", String(probeResult.latency_ms))
                          : copy.probeFailed.replace("{error}", probeResult.error ?? t.common.error)}
                      </span>
                      {probeResult.capabilities?.gpu_info ? (
                        <small className="text-fg-secondary">
                          {copy.gpuLabel.replace("{gpu}", probeResult.capabilities.gpu_info)}
                        </small>
                      ) : null}
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>

          <div>
            <Button variant="secondary" size="sm" onClick={addSidecar}>
              {copy.addDriver}
            </Button>
          </div>
        </div>

        <div className="grid gap-3 border-t border-line-subtle pt-4">
          <h4 className="text-body font-semibold text-fg-primary">{copy.cloudTitle}</h4>
          <p className="text-caption text-fg-secondary">{copy.cloudHint}</p>
          <Checkbox
            label={copy.cloudEnabled}
            checked={cloud.enabled ?? false}
            onChange={(event) =>
              setDraft((prev) => ({
                ...prev,
                cloud_live: { ...cloud, enabled: event.target.checked },
              }))
            }
          />
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label={copy.idleSuspendSec}>
              <TextInput
                type="number"
                min={5}
                max={300}
                step={1}
                value={String(cloud.idle_suspend_sec ?? 30)}
                onChange={(event) =>
                  setDraft((prev) => ({
                    ...prev,
                    cloud_live: { ...cloud, idle_suspend_sec: Number(event.target.value) },
                  }))
                }
              />
            </Field>
            <Field label={copy.maxSessionMin}>
              <TextInput
                type="number"
                min={1}
                max={120}
                step={1}
                value={String(cloud.max_session_minutes ?? 10)}
                onChange={(event) =>
                  setDraft((prev) => ({
                    ...prev,
                    cloud_live: { ...cloud, max_session_minutes: Number(event.target.value) },
                  }))
                }
              />
            </Field>
            <Field label={copy.maxSessionCost}>
              <TextInput
                type="number"
                min={1}
                max={500}
                step={0.5}
                value={String(cloud.max_session_cost_cny ?? 20)}
                onChange={(event) =>
                  setDraft((prev) => ({
                    ...prev,
                    cloud_live: { ...cloud, max_session_cost_cny: Number(event.target.value) },
                  }))
                }
              />
            </Field>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" variant="primary" pending={save.isPending}>
            {t.common.save}
          </Button>
          {saved ? (
            <span className="inline-flex items-center gap-1 text-ui font-medium text-ok-text">
              <Check size={15} aria-hidden="true" />
              {t.common.saved}
            </span>
          ) : null}
        </div>
        {save.isError ? <Problem error={save.error} /> : null}
        {probe.isError ? <Problem error={probe.error} /> : null}
      </form>
    </Card>
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
