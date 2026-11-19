import { useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { browserApiFetch } from "@companion-space/api-client";
import type { components } from "@companion-space/api-client/schema";
import { CLIP_SLOTS, type InstantAction, type TutorEmotion, type TutorPose, type VideoAvatarTier } from "@companion-space/avatar-engine/types";
import type { TutorVideoBoxHandle } from "@companion-space/avatar-engine/video-box";
import { api, bodyOf, charactersKey, ensureOK, fetchCharacters, settingsKey, type Character } from "../../app/api";
import { Loading, Problem } from "../../app/ui";
import t from "../../locales/zh-CN.json";
import { TeacherPreview } from "./teacher-preview";
import { buildAnimeLoopPromptSheet } from "./video-config";

const copy = t.characters;
const styles = t.learner.styles;
type TutorUpdate = components["schemas"]["TutorUpdate"];

type PosePreset = {
  key: keyof typeof copy.poses;
  pose: TutorPose;
  emotion: TutorEmotion;
  action?: InstantAction;
};

const POSE_PRESETS: readonly PosePreset[] = [
  { key: "idle", pose: "idle_companion", emotion: "neutral" },
  { key: "listen", pose: "listening_empathy", emotion: "warm", action: "empathy_nod" },
  { key: "think", pose: "feedback_reaction", emotion: "curious", action: "think_chin" },
  { key: "speak", pose: "lecturing", emotion: "warm" },
  { key: "point", pose: "board_guiding", emotion: "focused", action: "board_point" },
  { key: "praise", pose: "feedback_reaction", emotion: "cheerful", action: "praise_thumbs_up" },
  { key: "comfort", pose: "feedback_reaction", emotion: "warm", action: "gentle_encourage" },
];

function downloadPromptSheet(character: Character) {
  const content = buildAnimeLoopPromptSheet(character);
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${character.id}-anime-8-clips-prompts.md`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function TutorEditor({ character, onDeleted }: { character: Character; onDeleted: () => void }) {
  const queries = useQueryClient();
  const save = useMutation({
    mutationFn: async (body: TutorUpdate) => bodyOf(await api.PUT("/api/v2/characters/{character_id}", {
      params: { path: { character_id: character.id } }, body,
    })),
    onSuccess: (result) => queries.setQueryData<Character[]>(charactersKey, (items) => items?.map((entry) => entry.id === result.id ? result : entry)),
  });
  const remove = useMutation({
    mutationFn: async () => {
      const response = await api.DELETE("/api/v2/characters/{character_id}", {
        params: { path: { character_id: character.id } },
      });
      ensureOK(response.response, response.error);
    },
    onSuccess: () => {
      queries.setQueryData<Character[]>(charactersKey, (items) => items?.filter((entry) => entry.id !== character.id));
      void queries.invalidateQueries({ queryKey: settingsKey });
      onDeleted();
    },
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (key: string) => String(form.get(key) ?? "").trim();
    const lines = (key: string) => text(key).split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
    save.mutate({
      name: text("name"),
      relationship: text("relationship"),
      address_user_as: text("address"),
      default_style_id: text("style") as TutorUpdate["default_style_id"],
      preferred_tier: text("tier") as VideoAvatarTier,
      traits: lines("traits"),
      catchphrases: lines("phrases"),
    });
  }

  const canDelete = character.pack_metadata?.source_kind !== "builtin";

  return <form className="fields" onSubmit={submit}>
    <label>{copy.name}<input name="name" maxLength={160} required defaultValue={character.name} /></label>
    <label>{copy.relationship}<input name="relationship" maxLength={160} defaultValue={character.persona.relationship} /></label>
    <label>{copy.address}<input name="address" maxLength={160} defaultValue={character.persona.address_user_as} /></label>
    <label>{copy.traits}<textarea name="traits" rows={3} maxLength={1280} defaultValue={character.persona.traits.join("\n")} /></label>
    <label>{copy.catchphrases}<textarea name="phrases" rows={3} maxLength={1280} defaultValue={character.persona.catchphrases.join("\n")} /></label>
    <div className="field-row">
      <label>{copy.style}<select name="style" defaultValue={character.default_style_id}>
        {Object.entries(styles).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
      <label>{copy.tier}<select name="tier" defaultValue={character.video_avatar?.preferred_tier ?? "static"}>
        {Object.entries(copy.tiers).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
    </div>
    <div className="actions">
      <button className="button primary" disabled={save.isPending}>{t.common.save}</button>
      <Link className="button quiet" to={`/settings?teacher=${encodeURIComponent(character.id)}#voice`}>{copy.voice}</Link>
      <button className="button quiet" type="button" onClick={() => downloadPromptSheet(character)}>{copy.exportPrompts}</button>
      {canDelete ? (
        <button
          className="button danger-action"
          type="button"
          disabled={remove.isPending}
          onClick={() => { if (window.confirm(copy.deleteConfirm)) remove.mutate(); }}
        >
          {copy.delete}
        </button>
      ) : null}
    </div>
    {save.isSuccess ? <p className="form-success" role="status">{t.common.saved}</p> : null}
    {save.isError ? <Problem error={save.error} /> : null}
    {remove.isError ? <Problem error={remove.error} /> : null}
  </form>;
}

export default function TutorLibrary() {
  const queries = useQueryClient();
  const roster = useQuery({ queryKey: charactersKey, queryFn: fetchCharacters });
  const [selected, setSelected] = useState<string>();
  const [previewPose, setPreviewPose] = useState<TutorPose>("idle_companion");
  const [previewEmotion, setPreviewEmotion] = useState<TutorEmotion>("warm");
  const [previewGen, setPreviewGen] = useState(1);
  const previewVideoRef = useRef<TutorVideoBoxHandle>(null);

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const response = await browserApiFetch("/api/v2/characters/import", {
        method: "POST",
        body: file,
        headers: { "X-Filename": encodeURIComponent(file.name) },
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
  const meta = teacher?.pack_metadata;
  const clips = teacher?.video_avatar?.loop_pack?.clips ?? {};
  const clipCount = CLIP_SLOTS.filter((slot) => Boolean(clips[slot])).length;

  function importFile(file?: File) {
    if (file && !upload.isPending) upload.mutate(file);
  }

  function triggerPreset(preset: PosePreset) {
    const nextGen = previewGen + 1;
    setPreviewGen(nextGen);
    setPreviewPose(preset.pose);
    setPreviewEmotion(preset.emotion);
    if (preset.action) {
      previewVideoRef.current?.triggerInstantAction(preset.action, nextGen);
    }
  }

  return <>
    <div className="page-title"><h1>{copy.heading}</h1></div>
    <section className="settings-section fields" aria-label={copy.import} onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => { event.preventDefault(); importFile(event.dataTransfer.files[0]); }}>
      <label>{copy.import}<input type="file" accept=".tutorpack,.zip,.png,.jpg,.jpeg,.webp" disabled={upload.isPending} onChange={(event) => {
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
        <div className="teacher-stage">
          <TeacherPreview
            key={teacher.id}
            character={teacher}
            pose={previewPose}
            emotion={previewEmotion}
            gen={previewGen}
            videoRef={previewVideoRef}
          />
        </div>
        <div className="teacher-detail">
          <p className="teacher-type">{copy.tiers[(teacher.video_avatar?.preferred_tier ?? "static") as VideoAvatarTier]}</p>
          <h2>{teacher.name}</h2>
          <p>{copy.license} · {teacher.license}</p>
          {meta ? <>
            <p className="hint">{copy.author} · {meta.author || copy.unknown}</p>
            <p className="hint">{meta.allow_redistribution ? copy.redistributionAllowed : copy.redistributionRestricted}</p>
            {meta.license_url ? <a className="text-link" href={meta.license_url} target="_blank" rel="noreferrer">{copy.license}</a> : null}
          </> : null}
          <div>
            <p className="hint">{copy.clipCoverage} · {clipCount}/{CLIP_SLOTS.length}</p>
            <ul className="clip-coverage-list">
              {CLIP_SLOTS.map((slot) => (
                <li key={slot} className="clip-badge" data-present={Boolean(clips[slot])}>
                  {copy.clips[slot]}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <p className="hint">{copy.previewPoses}</p>
            <div className="pose-preview-bar">
              {POSE_PRESETS.map((preset) => (
                <button key={preset.key} type="button" className="button quiet" onClick={() => triggerPreset(preset)}>
                  {copy.poses[preset.key]}
                </button>
              ))}
            </div>
          </div>
          <TutorEditor key={teacher.id} character={teacher} onDeleted={() => setSelected(undefined)} />
        </div>
      </section>
    </> : null}
  </>;
}
