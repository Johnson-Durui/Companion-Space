import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { api, bodyOf, charactersKey, fetchCharacters, fetchSettings, settingsKey, type Character } from "../../app/api";
import { Loading, Problem } from "../../app/ui";
import t from "../../locales/zh-CN.json";
import { VoicePreview } from "./voice-preview";

export default function Welcome() {
  const [focused, setFocused] = useState<string>();
  const roster = useQuery({ queryKey: charactersKey, queryFn: fetchCharacters });
  const settings = useQuery({ queryKey: settingsKey, queryFn: fetchSettings });
  const queries = useQueryClient();
  const save = useMutation({
    mutationFn: async (character_id: string) => bodyOf(await api.PUT("/api/v2/settings/default-character", { body: { character_id } })),
    onSuccess: () => queries.invalidateQueries({ queryKey: settingsKey }),
  });
  if (roster.isPending || settings.isPending) return <Loading />;
  if (roster.isError) return <Problem error={roster.error} onRetry={() => void roster.refetch()} />;
  if (settings.isError) return <Problem error={settings.error} onRetry={() => void settings.refetch()} />;

  const characters = roster.data;
  const selectedId = settings.data.default_character_id;
  const candidate = characters.find((entry) => entry.id === (focused ?? selectedId)) ?? characters[0];
  if (!candidate) return <p className="state-note">{t.welcome.empty}</p>;

  const portraits = characters.filter((entry) => entry.appearance.kind === "portrait");
  const models = characters.filter((entry) => entry.appearance.kind === "vrm");
  const selected = candidate.id === selectedId;

  function select(entry: Character) {
    save.reset();
    setFocused(entry.id);
  }

  return (
    <div className="welcome-page">
      <div className="page-title welcome-title"><h1>{t.welcome.heading}</h1></div>
      <section className="teacher-feature" aria-labelledby="teacher-name">
        <div className={`teacher-stage ${candidate.appearance.kind === "vrm" ? "stage-model" : ""}`}>
          {candidate.appearance.kind === "portrait" ? (
            <img key={candidate.id} src={candidate.appearance.src} alt={candidate.name} decoding="async" fetchPriority="high" />
          ) : <span>{t.welcome.preview3d}</span>}
        </div>
        <div className="teacher-detail">
          <p className="teacher-type">{candidate.appearance.kind === "portrait" ? t.welcome.portrait : t.welcome.sample3d}</p>
          <h2 id="teacher-name">{candidate.name}</h2>
          <p className="relationship">{candidate.persona.relationship}</p>
          {candidate.persona.traits.length ? <ul className="teacher-traits">{candidate.persona.traits.map((trait) => <li key={trait}>{trait}</li>)}</ul> : null}
          <div className="teacher-actions">
            {selected ? <p className="current-teacher" role="status">{t.welcome.chosen}</p> : (
              <button className="button primary" disabled={save.isPending} onClick={() => save.mutate(candidate.id)}>
                {save.isPending ? t.common.saving : t.welcome.save}
              </button>
            )}
            <VoicePreview key={candidate.id} id={candidate.id} />
          </div>
          {save.isError ? <Problem error={save.error} /> : null}
          <Link className="text-link next-link" to="/settings">{t.welcome.connect}<span aria-hidden="true">↗</span></Link>
        </div>
      </section>
      <section className="roster" aria-label={t.welcome.label}>
        <div className="portrait-roster">
          {portraits.map((entry) => (
            <button key={entry.id} type="button" className="roster-option" aria-pressed={candidate.id === entry.id} onClick={() => select(entry)}>
              <img src={entry.appearance.src} alt="" decoding="async" loading="lazy" />
              <span>{entry.name}</span>
            </button>
          ))}
        </div>
        {models.length ? (
          <div className="model-roster">
            <h2>{t.welcome.sample3d}</h2>
            {models.map((entry) => (
              <button key={entry.id} type="button" className="model-option" aria-pressed={candidate.id === entry.id} onClick={() => select(entry)}>
                <span>{entry.name}</span><small>{t.welcome.preview3d}</small>
              </button>
            ))}
          </div>
        ) : null}
      </section>
    </div>
  );
}
