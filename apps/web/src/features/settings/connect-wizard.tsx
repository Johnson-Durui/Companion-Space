import { useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import {
  api,
  bodyOf,
  connectionsKey,
  publicMessage,
  rolesKey,
} from "../../app/api";
import { Loading, Problem } from "../../app/ui";
import {
  ArrowLeft,
  ArrowUpRight,
  Badge,
  Button,
  Card,
  CheckCircle2,
  Dialog,
  Field,
  SecretInput,
  SegmentedControl,
  Spinner,
  Stepper,
  TextInput,
  XCircle,
  toast,
} from "../../ui";
import t from "../../locales/zh-CN.json";
import { useReadiness } from "./use-readiness";

const copy = t.connectWizard;
const CAP_KEYS = ["live", "analysis", "checker", "vision", "stt"] as const;

type FilterMode = "free" | "fast" | "all";
type WizardStep = 1 | 2 | 3 | 4;

async function fetchPresets() {
  return bodyOf(await api.GET("/api/v2/providers/presets"));
}

type Preset = Awaited<ReturnType<typeof fetchPresets>>[number];
type RoleTestEntry = {
  role: string;
  ok: boolean;
  code?: string | null;
  latency_ms?: number | null;
};

const FREE_BASES = ["https://open.bigmodel.cn/", "https://api.siliconflow.cn/"];
const FAST_BASES = ["https://api.deepseek.com", "https://dashscope.aliyuncs.com/"];

function presetHasCap(preset: Preset, cap: (typeof CAP_KEYS)[number]): boolean {
  if (cap === "checker") return Boolean(preset.models.checker || preset.models.analysis);
  return Boolean(preset.models[cap]);
}

function isFreePreset(preset: Preset): boolean {
  return (
    FREE_BASES.some((prefix) => preset.base_url?.startsWith(prefix)) ||
    preset.free_tier_note.includes("免费")
  );
}

export interface ConnectWizardProps {
  onComplete?: () => void;
  onSkip?: () => void;
  skipLabel?: string;
  doneLabel?: string;
}

export function ConnectWizard({
  onComplete,
  onSkip,
  skipLabel,
  doneLabel = copy.done,
}: ConnectWizardProps) {
  const queries = useQueryClient();
  const presets = useQuery({ queryKey: ["presets"], queryFn: fetchPresets });
  const readiness = useReadiness();

  const [step, setStep] = useState<WizardStep>(1);
  const [filter, setFilter] = useState<FilterMode>("free");
  const [selectedId, setSelectedId] = useState<string>("");
  const [apiKey, setApiKey] = useState("");
  const [label, setLabel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [testResults, setTestResults] = useState<RoleTestEntry[]>([]);
  const [testError, setTestError] = useState<unknown>(null);
  const cancelRef = useRef<AbortController | null>(null);

  const allPresets = presets.data ?? [];
  const filteredPresets =
    filter === "free"
      ? allPresets.filter(isFreePreset)
      : filter === "fast"
        ? allPresets.filter((entry) => FAST_BASES.some((prefix) => entry.base_url?.startsWith(prefix)))
        : allPresets;
  const visiblePresets = filteredPresets.length ? filteredPresets : allPresets;
  const chosenPreset =
    allPresets.find((entry) => entry.id === selectedId) ?? visiblePresets[0] ?? null;

  const saveAndTest = useMutation({
    mutationFn: async () => {
      if (!chosenPreset) throw new Error("No provider selected");
      const created = bodyOf(
        await api.POST("/api/v2/providers/connections", {
          body: {
            preset_id: chosenPreset.id,
            label: label.trim() || chosenPreset.label,
            base_url: baseUrl.trim() || chosenPreset.base_url || null,
            api_key: apiKey.trim(),
          },
        }),
      );
      await Promise.all([
        queries.invalidateQueries({ queryKey: connectionsKey }),
        queries.invalidateQueries({ queryKey: rolesKey }),
      ]);

      setStep(3);
      setTestError(null);
      setTestResults([]);
      const controller = new AbortController();
      cancelRef.current = controller;
      try {
        const results = bodyOf(
          await api.POST("/api/v2/providers/connections/{connection_id}/test", {
            params: { path: { connection_id: created.id } },
            signal: controller.signal,
          }),
        );
        return results;
      } finally {
        cancelRef.current = null;
      }
    },
    onSuccess: (results) => {
      setApiKey("");
      setTestResults(results);
      toast.success(t.common.saved);
      readiness.refetch();
      const anyFailed = results.some((item) => !item.ok);
      if (!anyFailed) {
        setStep(4);
      }
    },
    onError: (error) => {
      if (error instanceof DOMException && error.name === "AbortError") {
        setStep(2);
        return;
      }
      setTestError(error);
    },
  });

  if (presets.isPending) return <Loading />;
  if (presets.isError) return <Problem error={presets.error} onRetry={() => void presets.refetch()} />;

  const wizardSteps = copy.steps.map((stepLabel, idx) => {
    const n = (idx + 1) as WizardStep;
    return {
      id: String(n),
      label: stepLabel,
      status: n < step ? ("done" as const) : n === step ? ("active" as const) : ("todo" as const),
    };
  });

  function choosePreset(preset: Preset) {
    setSelectedId(preset.id);
    setLabel(preset.label);
    setBaseUrl(preset.base_url ?? "");
    setApiKey("");
    setTestError(null);
    setTestResults([]);
    setStep(2);
  }

  function submitKey(event: FormEvent) {
    event.preventDefault();
    saveAndTest.mutate();
  }

  const missingLabels = [
    !readiness.canTeach ? copy.caps.live : null,
    !readiness.canAnalyze ? copy.caps.analysis : null,
  ].filter(Boolean);

  return (
    <div className="grid gap-5" data-testid="connect-wizard">
      <Stepper steps={wizardSteps} currentId={String(step)} compact aria-label={copy.title} />

      {step === 1 ? (
        <div className="grid gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <SegmentedControl<FilterMode>
              aria-label={copy.title}
              value={filter}
              onValueChange={setFilter}
              options={[
                { value: "free", label: copy.filterFree },
                { value: "fast", label: copy.filterFast },
                { value: "all", label: copy.filterAll },
              ]}
            />
            {onSkip ? (
              <Button variant="ghost" onClick={onSkip}>
                {skipLabel ?? t.onboarding.connectLater}
              </Button>
            ) : null}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            {visiblePresets.map((preset) => (
              <button
                key={preset.id}
                type="button"
                data-testid={`preset-card-${preset.id}`}
                onClick={() => choosePreset(preset)}
                className={clsx(
                  "grid gap-3 rounded-lg border border-line-subtle bg-surface-card p-4 text-left shadow-1",
                  "transition-[border-color,box-shadow,transform] duration-fast ease-out hover:border-accent hover:shadow-2 active:scale-[0.99]",
                )}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <strong className="text-body font-semibold text-fg-primary">{preset.label}</strong>
                  <div className="flex flex-wrap gap-1.5">
                    {isFreePreset(preset) ? <Badge tone="ok">{copy.freeBadge}</Badge> : null}
                    {preset.cn_reachable ? <Badge tone="neutral">{copy.cnBadge}</Badge> : null}
                  </div>
                </div>
                <p className="text-ui text-fg-secondary">{preset.free_tier_note}</p>
                <div className="flex flex-wrap gap-1.5">
                  {CAP_KEYS.map((cap) => {
                    const supported = presetHasCap(preset, cap);
                    return (
                      <span
                        key={cap}
                        className={clsx(
                          "inline-flex items-center rounded-sm px-2 py-0.5 text-caption font-medium",
                          supported
                            ? "bg-accent-soft text-accent-strong"
                            : "bg-surface-sunken text-fg-tertiary line-through",
                        )}
                      >
                        {copy.caps[cap]}
                      </span>
                    );
                  })}
                </div>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {step === 2 && chosenPreset ? (
        <form className="grid gap-4" onSubmit={submitKey}>
          <div className="flex items-center justify-between gap-2">
            <Button
              variant="ghost"
              size="sm"
              leftIcon={<ArrowLeft size={15} aria-hidden="true" />}
              onClick={() => setStep(1)}
            >
              {t.onboarding.back}
            </Button>
            <strong className="text-body font-semibold text-fg-primary">{chosenPreset.label}</strong>
          </div>

          <Card padding="md" className="grid gap-3 bg-surface-sunken/50">
            <p className="text-ui font-semibold text-fg-primary">{copy.guideTitle}</p>
            <ol className="grid gap-1.5 pl-5 text-ui text-fg-secondary list-decimal">
              {(chosenPreset.key_guide?.length
                ? chosenPreset.key_guide
                : [copy.defaultGuide1, copy.defaultGuide2, copy.defaultGuide3]
              ).map((line, index) => (
                <li key={index}>{line}</li>
              ))}
            </ol>
            {chosenPreset.key_url ? (
              <div>
                <a
                  href={chosenPreset.key_url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex min-h-10 items-center gap-1.5 rounded-md border border-line-control bg-surface-card px-3.5 text-ui font-medium text-fg-primary hover:bg-surface-sunken"
                >
                  <span>{copy.openKeySite}</span>
                  <ArrowUpRight size={15} aria-hidden="true" />
                </a>
              </div>
            ) : null}
          </Card>

          <Field label={copy.keyLabel} required={chosenPreset.requires_api_key}>
            <SecretInput
              name="api_key"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={copy.keyPlaceholder}
              showLabel={copy.showKey}
              hideLabel={copy.hideKey}
              required={chosenPreset.requires_api_key}
            />
          </Field>

          <details className="rounded-md border border-line-subtle bg-surface-card px-4 py-3">
            <summary className="cursor-pointer text-ui font-medium text-fg-secondary select-none">
              {copy.advanced}
            </summary>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <Field label={t.settings.name}>
                <TextInput
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                  maxLength={120}
                />
              </Field>
              <Field label={t.settings.baseUrl}>
                <TextInput
                  type="url"
                  value={baseUrl}
                  onChange={(event) => setBaseUrl(event.target.value)}
                  placeholder={t.settings.customUrl}
                  required={!chosenPreset.base_url}
                />
              </Field>
            </div>
          </details>

          <p className="text-caption text-fg-tertiary">{copy.testingNotice}</p>

          {saveAndTest.isError && step === 2 ? <Problem error={saveAndTest.error} /> : null}

          <div className="flex flex-wrap items-center justify-end gap-3">
            {onSkip ? (
              <Button variant="ghost" onClick={onSkip}>
                {skipLabel ?? t.onboarding.connectLater}
              </Button>
            ) : null}
            <Button
              type="submit"
              variant="primary"
              pending={saveAndTest.isPending}
              disabled={chosenPreset.requires_api_key && !apiKey.trim()}
            >
              {copy.saveAndTest}
            </Button>
          </div>
        </form>
      ) : null}

      {step === 3 && chosenPreset ? (
        <Card padding="lg" className="grid gap-4">
          <div className="flex items-center gap-3">
            {saveAndTest.isPending ? <Spinner size={18} /> : null}
            <h3 className="text-title font-semibold text-fg-primary">{copy.testingTitle}</h3>
          </div>
          <p className="text-ui text-fg-secondary">{copy.testingNotice}</p>

          {testResults.length > 0 ? (
            <ul className="grid gap-2" aria-live="polite">
              {testResults.map((entry) => {
                const capLabel =
                  copy.caps[entry.role as keyof typeof copy.caps] ??
                  t.roles[entry.role as keyof typeof t.roles] ??
                  entry.role;
                const reason = !entry.ok
                  ? (publicMessage({ code: entry.code }) ?? t.common.error)
                  : "";
                return (
                  <li
                    key={entry.role}
                    className="flex items-center justify-between gap-3 rounded-md border border-line-subtle bg-surface-page px-3.5 py-2.5"
                  >
                    <span className="inline-flex items-center gap-2 text-ui font-medium text-fg-primary">
                      {entry.ok ? (
                        <CheckCircle2 size={17} className="text-ok" aria-hidden="true" />
                      ) : (
                        <XCircle size={17} className="text-danger" aria-hidden="true" />
                      )}
                      <span>{capLabel}</span>
                    </span>
                    <span className="text-caption text-fg-secondary">
                      {entry.ok ? copy.testPassed : reason || copy.testFailed}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : null}

          {testError ? <Problem error={testError} /> : null}

          <div className="flex flex-wrap items-center justify-end gap-3">
            {saveAndTest.isPending ? (
              <Button
                variant="secondary"
                onClick={() => {
                  cancelRef.current?.abort();
                }}
              >
                {copy.cancelTest}
              </Button>
            ) : (
              <>
                <Button variant="secondary" onClick={() => setStep(2)}>
                  {copy.checkKey}
                </Button>
                <Button variant="primary" onClick={() => setStep(4)}>
                  {t.onboarding.continue}
                </Button>
              </>
            )}
          </div>
        </Card>
      ) : null}

      {step === 4 ? (
        <Card padding="lg" className="grid gap-4">
          <div className="flex items-center gap-3">
            <CheckCircle2 size={24} className="text-ok shrink-0" aria-hidden="true" />
            <div className="grid gap-0.5">
              <h3 className="text-title font-semibold text-fg-primary">
                {readiness.readyForLessons ? copy.readyTitle : copy.partialTitle}
              </h3>
              <p className="text-ui text-fg-secondary">
                {readiness.readyForLessons
                  ? copy.readyHint
                  : copy.partialMissing.replace("{items}", missingLabels.join("、"))}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            {(
              [
                ["live", readiness.canTeach],
                ["analysis", readiness.canAnalyze],
                ["checker", readiness.canCheck],
                ["vision", readiness.canSeeImages],
                ["stt", readiness.canUseVoice],
              ] as const
            ).map(([cap, ok]) => (
              <Badge key={cap} tone={ok ? "ok" : "neutral"}>
                {copy.caps[cap]} {ok ? "✓" : "—"}
              </Badge>
            ))}
          </div>

          <div className="flex flex-wrap items-center justify-end gap-3 pt-2">
            {!readiness.readyForLessons ? (
              <Button variant="secondary" onClick={() => setStep(1)}>
                {copy.selectProvider}
              </Button>
            ) : null}
            <Button variant="primary" onClick={() => onComplete?.()}>
              {doneLabel}
            </Button>
          </div>
        </Card>
      ) : null}
    </div>
  );
}

export function ConnectWizardDialog({
  open,
  onOpenChange,
  onConnected,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConnected?: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={copy.title} size="lg">
      <ConnectWizard
        onComplete={() => {
          onConnected?.();
          onOpenChange(false);
        }}
        onSkip={() => onOpenChange(false)}
        skipLabel={t.common.cancel}
      />
    </Dialog>
  );
}
