import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { api, bodyOf, charactersKey, fetchCharacters, fetchSettings, settingsKey, type Character } from "../../app/api";
import { Loading, Problem } from "../../app/ui";
import { Button, Check, toast } from "../../ui";
import { TeacherPreview } from "../characters/teacher-preview";
import { fetchSample, sampleKey } from "../replay/sample-api";
import t from "../../locales/zh-CN.json";
import { VoicePreview } from "./voice-preview";

export default function Welcome() {
  const [focused, setFocused] = useState<string>();
  const roster = useQuery({ queryKey: charactersKey, queryFn: fetchCharacters });
  const settings = useQuery({ queryKey: settingsKey, queryFn: fetchSettings });
  const sample = useQuery({ queryKey: sampleKey, queryFn: fetchSample, staleTime: Infinity });
  const queries = useQueryClient();
  const save = useMutation({
    mutationFn: async (character_id: string) => bodyOf(await api.PUT("/api/v2/settings/default-character", { body: { character_id } })),
    onSuccess: () => {
      void queries.invalidateQueries({ queryKey: settingsKey });
      toast.success(t.common.saved);
    },
  });
  if (roster.isPending || settings.isPending) return <Loading />;
  if (roster.isError) return <Problem error={roster.error} onRetry={() => void roster.refetch()} />;
  if (settings.isError) return <Problem error={settings.error} onRetry={() => void settings.refetch()} />;

  const characters = roster.data;
  const selectedId = settings.data.default_character_id;
  const candidate = characters.find((entry) => entry.id === (focused ?? selectedId)) ?? characters[0];
  if (!candidate) return <div className="welcome-page"><div className="page-title welcome-title"><h1>{t.welcome.heading}</h1></div><p className="state-note">{t.welcome.empty}</p></div>;

  const selected = candidate.id === selectedId;
  const typeLabel = candidate.appearance.kind === "video_pack" ? t.welcome.videoPack : t.welcome.portrait;

  function select(entry: Character) {
    save.reset();
    setFocused(entry.id);
  }

  return (
    <div className="welcome-page">
      <div className="page-title welcome-title">
        <h1>{t.welcome.heading}</h1>
        <nav aria-label={t.welcome.firstLesson} className="actions">
          <a className="button quiet" href="#teacher-picker">{t.welcome.heading}</a>
          <Link className="button quiet" to="/settings#models">{t.welcome.connect}</Link>
          <Link className="button quiet" to="/courses">{t.welcome.importCourse}</Link>
          {sample.data ? <Link className="button primary" to="/sample-lesson">{t.sample.open}</Link> : null}
        </nav>
      </div>
      <section id="teacher-picker" className="teacher-feature" aria-labelledby="teacher-name">
        <div className="teacher-stage" data-testid="teacher-stage">
          <TeacherPreview key={candidate.id} character={candidate} />
        </div>
        <div className="teacher-detail">
          <p className="teacher-type">{typeLabel}</p>
          <h2 id="teacher-name">{candidate.name}</h2>
          <p className="relationship">{candidate.persona.relationship}</p>
          {candidate.persona.traits.length ? <ul className="teacher-traits">{candidate.persona.traits.map((trait) => <li key={trait}>{trait}</li>)}</ul> : null}
          <div className="teacher-actions">
            {selected ? <p className="current-teacher" role="status"><Check size={16} aria-hidden="true" />{t.welcome.chosen}</p> : (
              <Button variant="primary" pending={save.isPending} onClick={() => save.mutate(candidate.id)}>
                {t.welcome.save}
              </Button>
            )}
            <VoicePreview key={candidate.id} id={candidate.id} />
          </div>
          {save.isError ? <Problem error={save.error} /> : null}
          <Link className="text-link" to="/characters">{t.characters.heading}</Link>
        </div>
      </section>
      <section className="roster" aria-label={t.welcome.label}>
        <div className="portrait-roster">
          {characters.map((entry) => (
            <button key={entry.id} type="button" className="roster-option" aria-pressed={candidate.id === entry.id} onClick={() => select(entry)}>
              <img src={entry.appearance.src} alt="" decoding="async" loading="lazy" />
              <span>{entry.name}</span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
