import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { browserApiFetch } from "@companion-space/api-client";
import type { components } from "@companion-space/api-client/schema";
import { api, bodyOf, charactersKey, ensureOK, fetchCharacters, type Character } from "../../app/api";
import { Loading, Problem } from "../../app/ui";
import t from "../../locales/zh-CN.json";
import { TeacherPreview } from "./teacher-preview";

const copy = t.characters;
const styles = t.learner.styles;
type TutorUpdate = components["schemas"]["TutorUpdate"];

function TutorEditor({ character }: { character: Character }) {
  const queries = useQueryClient();
  const save = useMutation({
    mutationFn: async (body: TutorUpdate) => bodyOf(await api.PUT("/api/v2/characters/{character_id}", {
      params: { path: { character_id: character.id } }, body,
    })),
    onSuccess: (result) => queries.setQueryData<Character[]>(charactersKey, (items) => items?.map((entry) => entry.id === result.id ? result : entry)),
  });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (key: string) => String(form.get(key) ?? "").trim();
    const lines = (key: string) => text(key).split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
    save.mutate({
      name: text("name"), relationship: text("relationship"), address_user_as: text("address"),
      default_style_id: text("style") as TutorUpdate["default_style_id"], traits: lines("traits"), catchphrases: lines("phrases"),
    });
  }
  return <form className="fields" onSubmit={submit}>
    <label>{copy.name}<input name="name" maxLength={160} required defaultValue={character.name} /></label>
    <label>{copy.relationship}<input name="relationship" maxLength={160} defaultValue={character.persona.relationship} /></label>
    <label>{copy.address}<input name="address" maxLength={160} defaultValue={character.persona.address_user_as} /></label>
    <label>{copy.traits}<textarea name="traits" rows={3} maxLength={1280} defaultValue={character.persona.traits.join("\n")} /></label>
    <label>{copy.catchphrases}<textarea name="phrases" rows={3} maxLength={1280} defaultValue={character.persona.catchphrases.join("\n")} /></label>
    <label>{copy.style}<select name="style" defaultValue={character.default_style_id}>
      {Object.entries(styles).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
    </select></label>
    <div className="actions">
      <button className="button primary" disabled={save.isPending}>{t.common.save}</button>
      <Link className="button quiet" to={`/settings?teacher=${encodeURIComponent(character.id)}#voice`}>{copy.voice}</Link>
    </div>
    {save.isSuccess ? <p className="form-success" role="status">{t.common.saved}</p> : null}
    {save.isError ? <Problem error={save.error} /> : null}
  </form>;
}

export default function TutorLibrary() {
  const queries = useQueryClient();
  const roster = useQuery({ queryKey: charactersKey, queryFn: fetchCharacters });
  const [selected, setSelected] = useState<string>();
  const upload = useMutation({
    mutationFn: async (file: File) => {
      const response = await browserApiFetch("/api/v2/characters/import", {
        method: "POST", body: file, headers: { "X-Filename": encodeURIComponent(file.name) },
      });
      const payload = await response.json();
      ensureOK(response, payload);
      return payload as Character;
    },
    onSuccess(character) {
      setSelected(character.id);
      queries.setQueryData<Character[]>(charactersKey, (items) => [...(items ?? []), character]);
    },
  });
  if (roster.isPending) return <Loading />;
  if (roster.isError) return <Problem error={roster.error} onRetry={() => void roster.refetch()} />;
  const teacher = roster.data.find((entry) => entry.id === selected) ?? roster.data[0];
  const meta = teacher?.model_metadata;

  function importFile(file?: File) {
    if (file && !upload.isPending) upload.mutate(file);
  }

  return <>
    <div className="page-title"><h1>{copy.heading}</h1></div>
    <section className="settings-section fields" aria-label={copy.import} onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => { event.preventDefault(); importFile(event.dataTransfer.files[0]); }}>
      <label>{copy.import}<input type="file" accept=".vrm" disabled={upload.isPending} onChange={(event) => {
        importFile(event.currentTarget.files?.[0]);
        event.currentTarget.value = "";
      }} /></label>
      <p className="hint">{copy.importHint}</p>
      {upload.isPending ? <p role="status">{copy.importing}</p> : null}
      {upload.isError ? <Problem error={upload.error} /> : null}
    </section>
    {teacher ? <>
      <div className="fields"><label>{copy.choose}<select value={teacher.id} onChange={(event) => setSelected(event.target.value)}>
        {roster.data.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
      </select></label></div>
      <section className="teacher-feature" aria-label={teacher.name}>
        <div className={`teacher-stage ${teacher.appearance.kind === "vrm" ? "stage-model" : ""}`}><TeacherPreview key={teacher.id} character={teacher} /></div>
        <div className="teacher-detail">
          <h2>{teacher.name}</h2>
          <p>{copy.license} · {teacher.license}{meta ? ` · VRM ${meta.spec_version}` : ""}</p>
          {meta ? <>
            <p className="hint">{copy.author} · {meta.authors.join("、") || copy.unknown}</p>
            <p className="hint">{meta.redistribution_allowed ? copy.redistributionAllowed : copy.redistributionRestricted}</p>
            {meta.license_url ? <a className="text-link" href={meta.license_url} target="_blank" rel="noreferrer">{copy.license}</a> : null}
            {meta.other_license_url ? <a className="text-link" href={meta.other_license_url} target="_blank" rel="noreferrer">{copy.otherLicense}</a> : null}
            {meta.missing_expressions.length ? <p className="hint">{copy.missingExpressions} {meta.missing_expressions.join(", ")}</p> : null}
          </> : null}
          <TutorEditor key={teacher.id} character={teacher} />
        </div>
      </section>
    </> : null}
  </>;
}
