import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Navigate, useLocation, useParams } from "react-router";
import clsx from "clsx";
import { api, bodyOf, fetchSettings, settingsKey } from "../../app/api";
import { Loading, Problem } from "../../app/ui";
import {
  Button,
  Card,
  Check,
  Field,
  Mic,
  Shield,
  SlidersHorizontal,
  Sparkles,
  TextInput,
  Users,
  Volume2,
  useTransientSaved,
} from "../../ui";
import t from "../../locales/zh-CN.json";
import { AvatarSettingsPanel } from "./avatar-settings";
import { LearnerProfileSettings } from "./learner-profile-settings";
import { ModelSettings } from "./models";
import { SecuritySettings } from "./security";
import { MicAndRecognitionSection, TutorVoiceSection } from "./voice-settings";

export const SETTINGS_SECTIONS = [
  { id: "me", label: t.settings.nav.me, icon: Users },
  { id: "tutor", label: t.settings.nav.tutor, icon: Volume2 },
  { id: "ai", label: t.settings.nav.ai, icon: Sparkles },
  { id: "voice", label: t.settings.nav.voice, icon: Mic },
  { id: "privacy", label: t.settings.nav.privacy, icon: Shield },
  { id: "advanced", label: t.settings.nav.advanced, icon: SlidersHorizontal },
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];

const HASH_REDIRECTS: Record<string, SettingsSectionId> = {
  "#me": "me",
  "#models": "ai",
  "#voice": "voice",
  "#avatar": "advanced",
  "#security": "privacy",
  "#data": "privacy",
  "#usage": "advanced",
};

export function SettingsRedirect() {
  const location = useLocation();
  const target = HASH_REDIRECTS[location.hash] ?? "me";
  const search = location.search || "";
  return <Navigate to={`/settings/${target}${search}`} replace />;
}

function PrivacyDataCard() {
  const settings = useQuery({ queryKey: settingsKey, queryFn: fetchSettings });
  return (
    <Card padding="lg" className="grid gap-4">
      <div className="flex items-start gap-3">
        <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-ok-soft text-ok">
          <Shield size={20} aria-hidden="true" />
        </span>
        <div className="grid gap-1">
          <h2 className="text-title font-semibold text-fg-primary">{t.settings.privacyLocalTitle}</h2>
          <p className="text-ui text-fg-secondary">{t.settings.privacyLocalBody}</p>
        </div>
      </div>

      <div className="grid gap-1.5 border-t border-line-subtle pt-4">
        <p className="text-ui font-medium text-fg-primary">{t.settings.directory}</p>
        <p className="text-caption text-fg-secondary">{t.settings.privacyDirHint}</p>
        {settings.isPending ? <Loading /> : null}
        {settings.isError ? (
          <Problem error={settings.error} onRetry={() => void settings.refetch()} />
        ) : null}
        {settings.data ? (
          <code className="block break-all rounded-sm bg-surface-sunken px-3 py-2 text-ui text-fg-primary">
            {settings.data.data_dir}
          </code>
        ) : null}
      </div>
    </Card>
  );
}

function ConcurrencyCard() {
  const queries = useQueryClient();
  const { saved, notifySaved } = useTransientSaved(t.common.saved);
  const settings = useQuery({ queryKey: settingsKey, queryFn: fetchSettings });
  const [draft, setDraft] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async (analysis_concurrency: number) =>
      bodyOf(await api.PUT("/api/v2/settings", { body: { analysis_concurrency } })),
    onSuccess: (result) => {
      queries.setQueryData(settingsKey, result);
      setDraft(null);
      notifySaved();
    },
  });

  if (settings.isPending) return <Loading />;
  if (settings.isError) return <Problem error={settings.error} onRetry={() => void settings.refetch()} />;

  const value = draft ?? String(settings.data.analysis_concurrency);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed > 0) save.mutate(parsed);
  }

  return (
    <Card padding="lg" className="grid gap-4">
      <h3 className="text-body font-semibold text-fg-primary">{t.settings.parallel}</h3>
      <form className="grid max-w-sm gap-3" onSubmit={submit}>
        <Field label={t.settings.parallel}>
          <TextInput
            name="concurrency"
            type="number"
            min={1}
            max={16}
            step={1}
            value={value}
            required
            onChange={(event) => setDraft(event.target.value)}
          />
        </Field>
        <div className="flex items-center gap-3">
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
      </form>
    </Card>
  );
}

function UsageCard() {
  const usage = useQuery({
    queryKey: ["usage"],
    queryFn: async () => bodyOf(await api.GET("/api/v2/usage")),
  });

  return (
    <Card padding="lg" className="grid gap-4">
      <h3 className="text-body font-semibold text-fg-primary">{t.settings.usage}</h3>
      {usage.isPending ? <Loading /> : null}
      {usage.isError ? <Problem error={usage.error} onRetry={() => void usage.refetch()} /> : null}
      {usage.data && !usage.data.length ? (
        <p className="text-ui text-fg-secondary">{t.settings.usageEmpty}</p>
      ) : null}
      {usage.data && usage.data.length > 0 ? (
        <div className="overflow-x-auto" tabIndex={0} role="region" aria-label={t.settings.usage}>
          <table className="w-full border-collapse text-left text-ui tabular-nums">
            <thead>
              <tr className="border-b border-line-subtle text-caption font-semibold text-fg-secondary">
                {[
                  t.settings.date,
                  t.settings.role,
                  t.settings.modelId,
                  t.settings.calls,
                  t.settings.inputTokens,
                  t.settings.outputTokens,
                ].map((label) => (
                  <th scope="col" key={label} className="whitespace-nowrap px-3 py-2.5">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {usage.data.map((row) => (
                <tr key={`${row.day}:${row.model}:${row.role}`} className="border-b border-line-subtle last:border-b-0">
                  <td className="px-3 py-2.5">{row.day}</td>
                  <td className="px-3 py-2.5">
                    {t.roles[row.role as keyof typeof t.roles] ?? row.role}
                  </td>
                  <td className="px-3 py-2.5">{row.model}</td>
                  <td className="px-3 py-2.5">{row.calls}</td>
                  <td className="px-3 py-2.5">{row.tokens_in}</td>
                  <td className="px-3 py-2.5">{row.tokens_out}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Card>
  );
}

export default function Settings() {
  const { section = "me" } = useParams();
  const active = SETTINGS_SECTIONS.find((item) => item.id === section);
  if (!active) return <Navigate to="/settings/me" replace />;

  return (
    <div className="grid gap-6 pb-12" data-testid={`settings-section-${active.id}`}>
      <header className="grid gap-1.5 pt-2">
        <h1 className="text-headline font-semibold text-fg-primary">{t.settings.heading}</h1>
        <p className="text-body text-fg-secondary">{t.settings.lead}</p>
      </header>

      <div className="grid items-start gap-6 md:grid-cols-[204px_minmax(0,1fr)]">
        <nav
          aria-label={t.settings.heading}
          data-testid="settings-nav"
          className="flex gap-1.5 overflow-x-auto pb-1 md:sticky md:top-6 md:grid md:gap-1 md:overflow-visible md:border-r md:border-line-subtle md:pr-4 md:pb-0"
        >
          {SETTINGS_SECTIONS.map((item) => {
            const Icon = item.icon;
            const current = item.id === active.id;
            return (
              <Link
                key={item.id}
                to={`/settings/${item.id}`}
                aria-current={current ? "page" : undefined}
                className={clsx(
                  "inline-flex min-h-10 shrink-0 items-center gap-2.5 rounded-md px-3 py-2 text-ui font-medium transition-[background-color,color] duration-fast ease-out",
                  current
                    ? "bg-accent-soft text-accent-strong font-semibold"
                    : "text-fg-secondary hover:bg-surface-sunken hover:text-fg-primary",
                )}
              >
                <Icon size={16} aria-hidden="true" />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="min-w-0">
          {active.id === "me" ? <LearnerProfileSettings /> : null}
          {active.id === "tutor" ? <TutorVoiceSection /> : null}
          {active.id === "ai" ? <ModelSettings /> : null}
          {active.id === "voice" ? <MicAndRecognitionSection /> : null}
          {active.id === "privacy" ? (
            <div className="grid gap-5">
              <PrivacyDataCard />
              <SecuritySettings />
            </div>
          ) : null}
          {active.id === "advanced" ? (
            <div className="grid gap-5" data-advanced="true">
              <p className="text-ui text-fg-secondary">{t.settings.advancedHint}</p>
              <AvatarSettingsPanel />
              <ConcurrencyCard />
              <UsageCard />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
