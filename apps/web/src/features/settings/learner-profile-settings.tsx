import { type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loading, Problem } from "../../app/ui";
import { Button, Check, useTransientSaved } from "../../ui";
import t from "../../locales/zh-CN.json";
import {
  getLearnerProfile,
  learnerKeys,
  saveLearnerProfile,
  type LearnerProfile,
} from "../learner/api";

function parseInterests(raw: FormDataEntryValue | null): string[] {
  return String(raw ?? "")
    .split(/[，,]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function LearnerProfileSettings() {
  const queries = useQueryClient();
  const { saved, notifySaved } = useTransientSaved(t.common.saved);
  const profile = useQuery({ queryKey: learnerKeys.profile, queryFn: getLearnerProfile });
  const save = useMutation({
    mutationFn: saveLearnerProfile,
    onSuccess: (result) => {
      queries.setQueryData(learnerKeys.profile, result);
      notifySaved();
    },
  });

  if (profile.isPending) return <Loading />;
  if (profile.isError) return <Problem error={profile.error} onRetry={() => void profile.refetch()} />;

  const data = profile.data;
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    save.mutate({
      nickname: String(formData.get("nickname") ?? "").trim(),
      level: String(formData.get("level")) as LearnerProfile["level"],
      pace: String(formData.get("pace")) as LearnerProfile["pace"],
      encouragement: String(formData.get("encouragement")) as LearnerProfile["encouragement"],
      preferred_style_id: String(formData.get("preferred_style_id")) as LearnerProfile["preferred_style_id"],
      interests: parseInterests(formData.get("interests")),
      approach_order: data.approach_order,
    });
  }

  return (
    <form className="fields" onSubmit={submit} data-testid="profile-settings-form">
      <p className="hint">{t.learner.profileHint}</p>
      <label>
        {t.learner.nickname}
        <input name="nickname" defaultValue={data.nickname} maxLength={80} />
      </label>
      <div className="field-row">
        <label>
          {t.learner.level}
          <select name="level" defaultValue={data.level}>
            {Object.entries(t.learner.levels).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </label>
        <label>
          {t.learner.style}
          <select name="preferred_style_id" defaultValue={data.preferred_style_id}>
            {Object.entries(t.learner.styles).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </label>
      </div>
      <div className="field-row">
        <label>
          {t.learner.pace}
          <select name="pace" defaultValue={data.pace}>
            {Object.entries(t.learner.paces).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </label>
        <label>
          {t.learner.encouragement}
          <select name="encouragement" defaultValue={data.encouragement}>
            {Object.entries(t.learner.encouragements).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </label>
      </div>
      <label>
        {t.learner.interests}
        <input
          name="interests"
          defaultValue={(data.interests ?? []).join("，")}
          placeholder={t.learner.interestsPlaceholder}
        />
      </label>
      <div className="actions">
        <Button type="submit" variant="primary" pending={save.isPending}>
          {t.learner.saveProfile}
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
  );
}
