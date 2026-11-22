import { type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { api, bodyOf, fetchSettings, settingsKey } from "../../app/api";
import { Loading, Problem } from "../../app/ui";
import { ArrowUpRight, Button, Check, useTransientSaved } from "../../ui";
import t from "../../locales/zh-CN.json";
import { AvatarSettingsPanel } from "./avatar-settings";
import { LearnerProfileSettings } from "./learner-profile-settings";
import { ModelSettings } from "./models";
import { SecuritySettings } from "./security";
import { VoiceSettingsPanel } from "./voice-settings";

const sections = [
  ["me", t.learner.profileHeading],
  ["models", t.settings.models],
  ["voice", t.settings.voices],
  ["avatar", t.settings.avatar],
  ["security", t.security.title],
  ["data", t.settings.data],
  ["usage", t.settings.usage],
] as const;

function DataSettings() {
  const queries = useQueryClient();
  const { saved, notifySaved } = useTransientSaved(t.common.saved);
  const settings = useQuery({ queryKey: settingsKey, queryFn: fetchSettings });
  const save = useMutation({
    mutationFn: async (analysis_concurrency: number) => bodyOf(await api.PUT("/api/v2/settings", { body: { analysis_concurrency } })),
    onSuccess: (result) => {
      queries.setQueryData(settingsKey, result);
      notifySaved();
    },
  });
  if (settings.isPending) return <Loading />;
  if (settings.isError) return <Problem error={settings.error} onRetry={() => void settings.refetch()} />;
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = Number(new FormData(event.currentTarget).get("concurrency"));
    if (Number.isInteger(value) && value > 0) save.mutate(value);
  }
  return (
    <>
      <div className="fields">
        <p>{t.settings.directory}</p>
        <code className="data-path">{settings.data.data_dir}</code>
      </div>
      <form className="fields" onSubmit={submit}>
        <label>{t.settings.parallel}<input key={settings.data.analysis_concurrency} name="concurrency" type="number" min="1" max="16" step="1" defaultValue={settings.data.analysis_concurrency} required /></label>
        <div className="actions">
          <Button type="submit" variant="primary" pending={save.isPending}>{t.common.save}</Button>
          {saved ? <span className="inline-flex items-center gap-1 text-ui font-medium text-ok-text"><Check size={15} aria-hidden="true" />{t.common.saved}</span> : null}
        </div>
        {save.isError ? <Problem error={save.error} /> : null}
      </form>
    </>
  );
}

function Usage() {
  const usage = useQuery({ queryKey: ["usage"], queryFn: async () => bodyOf(await api.GET("/api/v2/usage")) });
  if (usage.isPending) return <Loading />;
  if (usage.isError) return <Problem error={usage.error} onRetry={() => void usage.refetch()} />;
  if (!usage.data.length) return <p className="hint">{t.settings.usageEmpty}</p>;
  return (
    <div className="usage-table" tabIndex={0} role="region" aria-label={t.settings.usage}>
      <table>
        <thead><tr>{[t.settings.date, t.settings.role, t.settings.modelId, t.settings.calls, t.settings.inputTokens, t.settings.outputTokens].map((label) => <th scope="col" key={label}>{label}</th>)}</tr></thead>
        <tbody>
          {usage.data.map((row) => (
            <tr key={`${row.day}:${row.model}:${row.role}`}>
              <td>{row.day}</td><td>{t.roles[row.role as keyof typeof t.roles] ?? row.role}</td><td>{row.model}</td>
              <td>{row.calls}</td><td>{row.tokens_in}</td><td>{row.tokens_out}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function Settings() {
  return (
    <>
      <div className="page-title title-actions">
        <div>
          <h1>{t.settings.heading}</h1>
          <p>{t.settings.lead}</p>
        </div>
        <Link className="button quiet" to="/settings/diagnostics">
          {t.diagnostics.heading}<ArrowUpRight size={15} aria-hidden="true" />
        </Link>
      </div>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label={t.settings.heading}>
          {sections.map(([id, title]) => <a key={id} href={`#${id}`}>{title}</a>)}
          <Link to="/settings/diagnostics">{t.app.diagnostics}<ArrowUpRight size={15} aria-hidden="true" /></Link>
        </nav>
        <div className="settings-sections">
          <section className="settings-section" id="me" aria-label={t.learner.profileHeading}><h2>{t.learner.profileHeading}</h2><LearnerProfileSettings /></section>
          <section className="settings-section" id="models" aria-label={t.settings.models}><ModelSettings /></section>
          <section className="settings-section" id="voice" aria-label={t.settings.voices}><h2>{t.settings.voices}</h2><VoiceSettingsPanel /></section>
          <section className="settings-section" id="avatar" aria-label={t.settings.avatar}><h2>{t.settings.avatar}</h2><AvatarSettingsPanel /></section>
          <section className="settings-section" id="security" aria-label={t.security.title}><h2>{t.security.title}</h2><SecuritySettings /></section>
          <section className="settings-section" id="data" aria-label={t.settings.data}><h2>{t.settings.data}</h2><DataSettings /></section>
          <section className="settings-section" id="usage" aria-label={t.settings.usage}><h2>{t.settings.usage}</h2><Usage /></section>
        </div>
      </div>
    </>
  );
}
