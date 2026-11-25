import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loading, Problem } from "../../app/ui";
import {
  Button,
  Card,
  Check,
  Field,
  SegmentedControl,
  Select,
  TextInput,
  UnsavedBar,
  useTransientSaved,
} from "../../ui";
import t from "../../locales/zh-CN.json";
import {
  getLearnerProfile,
  learnerKeys,
  saveLearnerProfile,
  type LearnerProfile,
} from "../learner/api";
import { GlobalMemoryArchiveCard } from "../memory/memory-cards";

function parseInterests(raw: string): string[] {
  return raw
    .split(/[，,]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

const LEVEL_OPTIONS = Object.entries(t.learner.levels).map(([value, label]) => ({ value, label }));
const STYLE_OPTIONS = Object.entries(t.learner.styles).map(([value, label]) => ({ value, label }));
const PACE_OPTIONS = Object.entries(t.learner.paces).map(([value, label]) => ({ value, label }));
const ENCOURAGEMENT_OPTIONS = Object.entries(t.learner.encouragements).map(([value, label]) => ({
  value,
  label,
}));

function ProfileForm({ data }: { data: LearnerProfile }) {
  const queries = useQueryClient();
  const { saved, notifySaved } = useTransientSaved(t.common.saved);

  const [nickname, setNickname] = useState(data.nickname ?? "");
  const [level, setLevel] = useState<LearnerProfile["level"]>(data.level);
  const [styleId, setStyleId] = useState<LearnerProfile["preferred_style_id"]>(
    data.preferred_style_id,
  );
  const [pace, setPace] = useState<LearnerProfile["pace"]>(data.pace);
  const [encouragement, setEncouragement] = useState<LearnerProfile["encouragement"]>(
    data.encouragement,
  );
  const [interestsText, setInterestsText] = useState((data.interests ?? []).join("，"));

  const initialInterests = (data.interests ?? []).join("，");
  const dirty =
    nickname.trim() !== (data.nickname ?? "").trim() ||
    level !== data.level ||
    styleId !== data.preferred_style_id ||
    pace !== data.pace ||
    encouragement !== data.encouragement ||
    interestsText.trim() !== initialInterests.trim();

  const save = useMutation({
    mutationFn: saveLearnerProfile,
    onSuccess: (result) => {
      queries.setQueryData(learnerKeys.profile, result);
      setNickname(result.nickname ?? "");
      setLevel(result.level);
      setStyleId(result.preferred_style_id);
      setPace(result.pace);
      setEncouragement(result.encouragement);
      setInterestsText((result.interests ?? []).join("，"));
      notifySaved();
    },
  });

  function doSave() {
    save.mutate({
      nickname: nickname.trim(),
      level,
      pace,
      encouragement,
      preferred_style_id: styleId,
      interests: parseInterests(interestsText),
      approach_order: data.approach_order,
    });
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    doSave();
  }

  function discard() {
    setNickname(data.nickname ?? "");
    setLevel(data.level);
    setStyleId(data.preferred_style_id);
    setPace(data.pace);
    setEncouragement(data.encouragement);
    setInterestsText(initialInterests);
  }

  return (
    <Card padding="lg" className="grid gap-5">
      <div className="grid gap-1 border-b border-line-subtle pb-4">
        <h2 className="text-title font-semibold text-fg-primary">{t.settings.nav.me}</h2>
        <p className="text-ui text-fg-secondary">{t.settings.meHint}</p>
      </div>

      <form className="grid max-w-2xl gap-5" onSubmit={submit} data-testid="profile-settings-form">
        <Field label={t.learner.nickname}>
          <TextInput
            name="nickname"
            value={nickname}
            maxLength={80}
            onChange={(event) => setNickname(event.target.value)}
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t.learner.level}>
            <Select
              aria-label={t.learner.level}
              options={LEVEL_OPTIONS}
              value={level}
              onValueChange={(next) => setLevel(next as LearnerProfile["level"])}
            />
          </Field>

          <Field label={t.learner.style}>
            <Select
              aria-label={t.learner.style}
              options={STYLE_OPTIONS}
              value={styleId}
              onValueChange={(next) => setStyleId(next as LearnerProfile["preferred_style_id"])}
            />
          </Field>
        </div>

        <Field label={t.learner.pace}>
          <SegmentedControl
            aria-label={t.learner.pace}
            options={PACE_OPTIONS}
            value={pace}
            onValueChange={(next) => setPace(next as LearnerProfile["pace"])}
          />
        </Field>

        <Field label={t.learner.encouragement}>
          <SegmentedControl
            aria-label={t.learner.encouragement}
            options={ENCOURAGEMENT_OPTIONS}
            value={encouragement}
            onValueChange={(next) => setEncouragement(next as LearnerProfile["encouragement"])}
          />
        </Field>

        <Field label={t.learner.interests}>
          <TextInput
            name="interests"
            value={interestsText}
            placeholder={t.learner.interestsPlaceholder}
            onChange={(event) => setInterestsText(event.target.value)}
          />
        </Field>

        <div className="flex flex-wrap items-center gap-3 pt-1">
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

        <UnsavedBar
          dirty={dirty}
          pending={save.isPending}
          message={t.settings.unsavedMessage}
          saveLabel={t.settings.unsavedSave}
          discardLabel={t.settings.unsavedDiscard}
          onSave={doSave}
          onDiscard={discard}
        />
      </form>
    </Card>
  );
}

export function LearnerProfileSettings() {
  const profile = useQuery({ queryKey: learnerKeys.profile, queryFn: getLearnerProfile });
  if (profile.isPending) return <Loading />;
  if (profile.isError) return <Problem error={profile.error} onRetry={() => void profile.refetch()} />;
  return (
    <div className="grid gap-5">
      <ProfileForm key={JSON.stringify(profile.data)} data={profile.data} />
      <GlobalMemoryArchiveCard />
    </div>
  );
}
