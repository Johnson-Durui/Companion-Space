import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import type { components } from "@companion-space/api-client/schema";
import { CLIP_SLOTS, type VideoAvatarTier } from "@companion-space/avatar-engine/types";
import {
  api,
  avatarDriversKey,
  bodyOf,
  charactersKey,
  ensureOK,
  fetchAvatarDriverSettings,
  fetchCharacters,
  fetchSettings,
  settingsKey,
  type Character,
} from "../../app/api";
import { Loading, Problem } from "../../app/ui";
import {
  ArrowLeft,
  Badge,
  Button,
  Card,
  Chip,
  ConfirmDialog,
  Download,
  Field,
  Layers,
  RotateCcw,
  Select,
  Slider,
  SlidersHorizontal,
  Sparkles,
  Tabs,
  TextInput,
  Trash2,
  Volume2,
  X,
  toast,
} from "../../ui";
import t from "../../locales/zh-CN.json";
import { buildAnimeLoopPromptSheet } from "../characters/video-config";
import { useTutorSpeech } from "../voice/use-tutor-speech";
import { TutorShowcase } from "./tutor-showcase";
import { tutorGreeting } from "./use-active-tutor";
import { EDGE_VOICE_CHOICES, TUTOR_THEME_CHOICES, type TutorThemeChoice } from "./voice-catalog";

const copy = t.tutorsGallery;
const charCopy = t.characters;
type TutorUpdate = components["schemas"]["TutorUpdate"];
const voiceSettingsKey = ["voice-settings"] as const;

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

function PersonaTab({
  character,
  onDeleted,
}: {
  character: Character;
  onDeleted: () => void;
}) {
  const queries = useQueryClient();
  const speech = useTutorSpeech();
  const isBuiltin = character.pack_metadata?.source_kind === "builtin";

  const [name, setName] = useState(character.name);
  const [tagline, setTagline] = useState(character.tagline || "");
  const [greeting, setGreeting] = useState(character.greeting || "");
  const [relationship, setRelationship] = useState(character.persona.relationship || "");
  const [addressUserAs, setAddressUserAs] = useState(character.persona.address_user_as || "");
  const [traits, setTraits] = useState<string[]>(character.persona.traits ?? []);
  const [traitDraft, setTraitDraft] = useState("");
  const [catchphrases, setCatchphrases] = useState<string[]>(character.persona.catchphrases ?? []);
  const [phraseDraft, setPhraseDraft] = useState("");
  const [styleId, setStyleId] = useState<NonNullable<TutorUpdate["default_style_id"]>>(
    (character.default_style_id as NonNullable<TutorUpdate["default_style_id"]>) || "guided",
  );
  const [theme, setTheme] = useState<TutorThemeChoice>(
    (character.theme as TutorThemeChoice) || "default",
  );
  const [voiceId, setVoiceId] = useState(character.voice.voice_id || EDGE_VOICE_CHOICES[3].id);
  const [rate, setRate] = useState(character.voice.rate ?? 1.0);
  const [resetOpen, setResetOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  // Sync character.voice AND clear stale per-character voice_settings override if any so classroom & B13 stay identical
  async function syncVoiceOverrideIfPresent(nextVoiceId: string, nextRate: number) {
    const current = await api.GET("/api/v2/voice/settings").then(bodyOf).catch(() => null);
    if (!current) return;
    const overrides = current.characters ?? {};
    if (character.id in overrides) {
      const updatedOverrides = {
        ...overrides,
        [character.id]: {
          ...overrides[character.id],
          engine: "edge" as const,
          voice_id: nextVoiceId,
          rate: nextRate,
        },
      };
      const saved = await api
        .PUT("/api/v2/voice/settings", {
          body: { default: current.default, characters: updatedOverrides },
        })
        .then(bodyOf);
      queries.setQueryData(voiceSettingsKey, saved);
    }
  }

  // Partial update: NEVER submits preferred_tier from Persona tab (preserves _tier_explicit!)
  const save = useMutation({
    mutationFn: async () => {
      const body: TutorUpdate = {
        name: name.trim(),
        tagline: tagline.trim(),
        greeting: greeting.trim(),
        relationship: relationship.trim(),
        address_user_as: addressUserAs.trim(),
        traits,
        catchphrases,
        default_style_id: styleId,
        voice: {
          engine: character.voice.engine || "edge",
          voice_id: voiceId.trim() || character.voice.voice_id,
          rate,
          pitch: character.voice.pitch ?? 0,
        },
        ...(!isBuiltin ? { theme } : {}),
      };
      const updated = bodyOf(
        await api.PUT("/api/v2/characters/{character_id}", {
          params: { path: { character_id: character.id } },
          body,
        }),
      );
      await syncVoiceOverrideIfPresent(updated.voice.voice_id, updated.voice.rate);
      return updated;
    },
    onSuccess: (result) => {
      queries.setQueryData<Character[]>(charactersKey, (items) =>
        items?.map((entry) => (entry.id === result.id ? result : entry)),
      );
      toast.success(t.common.saved);
    },
  });

  const previewVoice = useMutation({
    mutationFn: async () => {
      const updated = bodyOf(
        await api.PUT("/api/v2/characters/{character_id}", {
          params: { path: { character_id: character.id } },
          body: {
            voice: {
              engine: character.voice.engine || "edge",
              voice_id: voiceId.trim() || character.voice.voice_id,
              rate,
              pitch: character.voice.pitch ?? 0,
            },
          },
        }),
      );
      await syncVoiceOverrideIfPresent(updated.voice.voice_id, updated.voice.rate);
      queries.setQueryData<Character[]>(charactersKey, (items) =>
        items?.map((entry) => (entry.id === updated.id ? updated : entry)),
      );
      await speech.speak({
        characterId: updated.id,
        text: greeting.trim() || catchphrases[0] || `${name.trim() || updated.name}，我们一起开始学习吧。`,
      });
    },
  });

  const resetBuiltin = useMutation({
    mutationFn: async () =>
      bodyOf(
        await api.POST("/api/v2/characters/{character_id}/reset", {
          params: { path: { character_id: character.id } },
        }),
      ),
    onSuccess: (restored) => {
      setResetOpen(false);
      queries.setQueryData<Character[]>(charactersKey, (items) =>
        items?.map((entry) => (entry.id === restored.id ? restored : entry)),
      );
      void queries.invalidateQueries({ queryKey: voiceSettingsKey });
      setName(restored.name);
      setTagline(restored.tagline || "");
      setGreeting(restored.greeting || "");
      setRelationship(restored.persona.relationship || "");
      setAddressUserAs(restored.persona.address_user_as || "");
      setTraits(restored.persona.traits ?? []);
      setCatchphrases(restored.persona.catchphrases ?? []);
      setStyleId((restored.default_style_id as NonNullable<TutorUpdate["default_style_id"]>) || "guided");
      setVoiceId(restored.voice.voice_id);
      setRate(restored.voice.rate);
      toast.success(t.common.saved);
    },
  });

  const removeCustom = useMutation({
    mutationFn: async () => {
      const response = await api.DELETE("/api/v2/characters/{character_id}", {
        params: { path: { character_id: character.id } },
      });
      ensureOK(response.response, response.error);
    },
    onSuccess: () => {
      setDeleteOpen(false);
      queries.setQueryData<Character[]>(charactersKey, (items) =>
        items?.filter((entry) => entry.id !== character.id),
      );
      void queries.invalidateQueries({ queryKey: settingsKey });
      toast.success(t.common.saved);
      onDeleted();
    },
  });

  function addTrait() {
    const clean = traitDraft.trim().slice(0, 20);
    if (!clean || traits.includes(clean) || traits.length >= 8) return;
    setTraits((prev) => [...prev, clean]);
    setTraitDraft("");
  }

  function addPhrase() {
    const clean = phraseDraft.trim().slice(0, 60);
    if (!clean || catchphrases.includes(clean) || catchphrases.length >= 8) return;
    setCatchphrases((prev) => [...prev, clean]);
    setPhraseDraft("");
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    save.mutate();
  }

  const voiceOptions = [
    ...EDGE_VOICE_CHOICES.map((v) => ({ value: v.id, label: v.label, description: v.note })),
    ...(EDGE_VOICE_CHOICES.some((v) => v.id === voiceId)
      ? []
      : [{ value: voiceId, label: voiceId, description: copy.voiceCustom }]),
  ];

  return (
    <form onSubmit={handleSubmit} className="grid gap-5" data-testid="tutor-persona-form">
      <Card padding="lg" className="grid gap-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={charCopy.name} required>
            <TextInput value={name} onChange={(e) => setName(e.target.value)} maxLength={60} required />
          </Field>
          <Field label={copy.tagline}>
            <TextInput
              value={tagline}
              onChange={(e) => setTagline(e.target.value)}
              placeholder={copy.taglinePlaceholder}
              maxLength={32}
            />
          </Field>
        </div>

        <Field label={copy.greeting}>
          <TextInput
            value={greeting}
            onChange={(e) => setGreeting(e.target.value)}
            placeholder={copy.greetingPlaceholder}
            maxLength={120}
          />
        </Field>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={charCopy.relationship}>
            <TextInput
              value={relationship}
              onChange={(e) => setRelationship(e.target.value)}
              maxLength={160}
            />
          </Field>
          <Field label={charCopy.address}>
            <TextInput
              value={addressUserAs}
              onChange={(e) => setAddressUserAs(e.target.value)}
              maxLength={60}
            />
          </Field>
        </div>

        <Field label={charCopy.style}>
          <Select
            value={styleId}
            onValueChange={(val) => setStyleId(val as NonNullable<TutorUpdate["default_style_id"]>)}
            options={Object.entries(t.learner.styles).map(([value, label]) => ({ value, label }))}
          />
        </Field>

        {/* Traits tag input */}
        <div className="grid gap-2">
          <span className="text-ui font-medium text-fg-primary">{charCopy.traits}</span>
          <div className="flex flex-wrap gap-1.5">
            {traits.map((tag) => (
              <Chip
                key={tag}
                selected
                onClick={() => setTraits((prev) => prev.filter((item) => item !== tag))}
              >
                <span>{tag}</span>
                <X size={13} aria-hidden="true" />
              </Chip>
            ))}
          </div>
          <div className="flex gap-2">
            <TextInput
              value={traitDraft}
              onChange={(e) => setTraitDraft(e.target.value)}
              placeholder={copy.addTraitPlaceholder}
              maxLength={20}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addTrait();
                }
              }}
            />
            <Button
              variant="secondary"
              className="shrink-0 whitespace-nowrap"
              onClick={addTrait}
              disabled={!traitDraft.trim() || traits.length >= 8}
            >
              {copy.addTag}
            </Button>
          </div>
        </div>

        {/* Catchphrases tag input */}
        <div className="grid gap-2">
          <span className="text-ui font-medium text-fg-primary">{charCopy.catchphrases}</span>
          <div className="flex flex-wrap gap-1.5">
            {catchphrases.map((phrase) => (
              <Chip
                key={phrase}
                selected
                onClick={() => setCatchphrases((prev) => prev.filter((item) => item !== phrase))}
              >
                <span className="max-w-[260px] truncate">{phrase}</span>
                <X size={13} aria-hidden="true" />
              </Chip>
            ))}
          </div>
          <div className="flex gap-2">
            <TextInput
              value={phraseDraft}
              onChange={(e) => setPhraseDraft(e.target.value)}
              placeholder={copy.addPhrasePlaceholder}
              maxLength={60}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addPhrase();
                }
              }}
            />
            <Button
              variant="secondary"
              className="shrink-0 whitespace-nowrap"
              onClick={addPhrase}
              disabled={!phraseDraft.trim() || catchphrases.length >= 8}
            >
              {copy.addTag}
            </Button>
          </div>
        </div>

        {/* Custom tutor theme palette */}
        {!isBuiltin ? (
          <div className="grid gap-1.5">
            <span className="text-ui font-medium text-fg-primary">{copy.themeSection}</span>
            <div className="flex flex-wrap gap-2">
              {TUTOR_THEME_CHOICES.map((swatch) => (
                <button
                  key={swatch.id}
                  type="button"
                  data-theme={swatch.id}
                  aria-pressed={theme === swatch.id}
                  onClick={() => setTheme(swatch.id)}
                  className="inline-flex h-9 items-center gap-2 rounded-full border border-line-default bg-surface-card px-3 text-caption font-medium text-fg-primary transition-colors duration-fast hover:border-accent aria-pressed:border-accent aria-pressed:ring-2 aria-pressed:ring-accent/30"
                >
                  <span aria-hidden="true" className="h-3.5 w-3.5 rounded-full bg-accent" />
                  <span>{swatch.label}</span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </Card>

      {/* Voice card */}
      <Card padding="lg" className="grid gap-4">
        <h2 className="text-title font-semibold text-fg-primary">{copy.voiceSection}</h2>
        <div className="grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
          <Field label={copy.voiceSelect}>
            <Select value={voiceId} onValueChange={setVoiceId} options={voiceOptions} />
          </Field>
          <Button
            variant="secondary"
            pending={previewVoice.isPending || speech.loading}
            leftIcon={<Volume2 size={15} aria-hidden="true" />}
            onClick={() => previewVoice.mutate()}
          >
            {copy.voicePreview}
          </Button>
        </div>

        <div className="grid max-w-md gap-1.5">
          <div className="flex items-center justify-between text-ui">
            <span className="font-medium text-fg-primary">{copy.voiceRate}</span>
            <span className="tabular-nums text-caption text-fg-secondary">{rate.toFixed(2)}×</span>
          </div>
          <Slider
            value={Math.round(rate * 100)}
            min={70}
            max={140}
            step={5}
            aria-label={copy.voiceRate}
            onValueChange={(val) => setRate(val / 100)}
          />
        </div>

        {speech.unavailable ? (
          <p role="status" className="text-caption text-fg-tertiary">{t.speech.unavailable}</p>
        ) : null}
      </Card>

      {save.isError ? <Problem error={save.error} /> : null}
      {resetBuiltin.isError ? <Problem error={resetBuiltin.error} /> : null}
      {removeCustom.isError ? <Problem error={removeCustom.error} /> : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {isBuiltin ? (
            <Button
              variant="ghost"
              leftIcon={<RotateCcw size={15} aria-hidden="true" />}
              pending={resetBuiltin.isPending}
              onClick={() => setResetOpen(true)}
            >
              {copy.resetDefault}
            </Button>
          ) : (
            <Button
              variant="danger"
              leftIcon={<Trash2 size={15} aria-hidden="true" />}
              pending={removeCustom.isPending}
              onClick={() => setDeleteOpen(true)}
            >
              {charCopy.delete}
            </Button>
          )}
        </div>
        <Button type="submit" variant="primary" pending={save.isPending}>
          {t.common.save}
        </Button>
      </div>

      <ConfirmDialog
        open={resetOpen}
        onOpenChange={setResetOpen}
        title={copy.resetTitle}
        description={copy.resetConfirm}
        confirmLabel={copy.resetAction}
        cancelLabel={t.common.cancel}
        pending={resetBuiltin.isPending}
        onConfirm={() => resetBuiltin.mutate()}
      />

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={charCopy.deleteTitle}
        description={charCopy.deleteConfirm}
        confirmLabel={charCopy.confirmDelete}
        cancelLabel={t.common.keep}
        pending={removeCustom.isPending}
        onConfirm={() => removeCustom.mutate()}
      />
    </form>
  );
}

function AssetsAdvancedTab({ character }: { character: Character }) {
  const queries = useQueryClient();
  const [tier, setTier] = useState<VideoAvatarTier>(
    (character.video_avatar?.preferred_tier ?? "static") as VideoAvatarTier,
  );
  const [driverId, setDriverId] = useState(character.video_avatar?.local_sidecar?.driver_id ?? "");

  const avatarDrivers = useQuery({
    queryKey: avatarDriversKey,
    queryFn: fetchAvatarDriverSettings,
  });

  const saveTier = useMutation({
    mutationFn: async () =>
      bodyOf(
        await api.PUT("/api/v2/characters/{character_id}", {
          params: { path: { character_id: character.id } },
          body: {
            preferred_tier: tier,
            local_sidecar_driver_id: tier === "local_sidecar" ? (driverId || null) : null,
          },
        }),
      ),
    onSuccess: (updated) => {
      queries.setQueryData<Character[]>(charactersKey, (items) =>
        items?.map((entry) => (entry.id === updated.id ? updated : entry)),
      );
      toast.success(t.common.saved);
    },
  });

  const clips = character.video_avatar?.loop_pack?.clips ?? {};
  const clipCount = CLIP_SLOTS.filter((slot) => Boolean(clips[slot])).length;
  const sidecars = avatarDrivers.data?.local_sidecars ?? [];
  const meta = character.pack_metadata;

  return (
    <div className="grid gap-5" data-testid="tutor-assets-tab">
      <Card padding="lg" className="grid gap-4">
        <h2 className="text-title font-semibold text-fg-primary">{copy.effectLabel}</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={copy.effectLabel}>
            <Select
              value={tier}
              onValueChange={(v) => setTier(v as VideoAvatarTier)}
              options={Object.entries(copy.effects).map(([value, label]) => ({ value, label }))}
            />
          </Field>
          {tier === "local_sidecar" ? (
            <Field label={charCopy.sidecarDriver}>
              <Select
                value={driverId}
                onValueChange={setDriverId}
                options={[
                  { value: "", label: charCopy.sidecarDefault },
                  ...sidecars.map((entry) => ({
                    value: entry.id,
                    label: `${entry.label} (${entry.base_url})`,
                  })),
                ]}
              />
            </Field>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" pending={saveTier.isPending} onClick={() => saveTier.mutate()}>
            {t.common.save}
          </Button>
          <Link className="button quiet" to="/settings/advanced">
            {charCopy.configureSidecar}
          </Link>
          <Button
            variant="secondary"
            leftIcon={<Download size={15} aria-hidden="true" />}
            onClick={() => downloadPromptSheet(character)}
          >
            {charCopy.exportPrompts}
          </Button>
        </div>
        {saveTier.isError ? <Problem error={saveTier.error} /> : null}
      </Card>

      <Card padding="lg" className="grid gap-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-title font-semibold text-fg-primary">{charCopy.clipCoverage}</h2>
          <Badge tone={clipCount === CLIP_SLOTS.length ? "ok" : "neutral"}>
            {clipCount} / {CLIP_SLOTS.length}
          </Badge>
        </div>
        <div className="flex flex-wrap gap-2">
          {CLIP_SLOTS.map((slot) => {
            const present = Boolean(clips[slot]);
            return (
              <Badge key={slot} tone={present ? "ok" : "neutral"}>
                {charCopy.clips[slot]} {present ? "✓" : "—"}
              </Badge>
            );
          })}
        </div>
      </Card>

      <Card padding="lg" className="grid gap-2 text-ui text-fg-secondary">
        <h2 className="text-title font-semibold text-fg-primary">{charCopy.license}</h2>
        <p>{charCopy.author}：{meta?.author || charCopy.unknown}</p>
        <p>{charCopy.license}：{character.license}</p>
        {meta ? (
          <p>{meta.allow_redistribution ? charCopy.redistributionAllowed : charCopy.redistributionRestricted}</p>
        ) : null}
        {meta?.license_url ? (
          <div>
            <a className="text-link" href={meta.license_url} target="_blank" rel="noreferrer">
              {meta.license_url}
            </a>
          </div>
        ) : null}
      </Card>
    </div>
  );
}

export default function TutorDetailPage() {
  const { tutorId = "" } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const queries = useQueryClient();

  const roster = useQuery({ queryKey: charactersKey, queryFn: fetchCharacters });
  const settings = useQuery({ queryKey: settingsKey, queryFn: fetchSettings });
  const [chosenGreeting, setChosenGreeting] = useState("");
  const [chosenSpeakSeq, setChosenSpeakSeq] = useState(0);

  const activeTab = searchParams.get("tab") || "about";

  const choose = useMutation({
    mutationFn: async (character: Character) => {
      await bodyOf(
        await api.PUT("/api/v2/settings/default-character", {
          body: { character_id: character.id },
        }),
      );
      return character;
    },
    onSuccess: (character) => {
      void queries.invalidateQueries({ queryKey: settingsKey });
      toast.success(t.common.saved);
      const line = tutorGreeting(character);
      if (line) {
        setChosenGreeting(line);
        setChosenSpeakSeq((seq) => seq + 1);
      }
    },
  });

  if (roster.isPending || settings.isPending) return <Loading />;
  if (roster.isError) return <Problem error={roster.error} onRetry={() => void roster.refetch()} />;
  if (settings.isError) return <Problem error={settings.error} onRetry={() => void settings.refetch()} />;

  const character = roster.data.find((entry) => entry.id === tutorId);
  if (!character) {
    return (
      <div className="grid gap-4 py-8">
        <h1 className="text-headline font-semibold text-fg-primary">{t.errors.tutor_not_found}</h1>
        <div>
          <Link className="button primary" to="/tutors">
            {copy.backGallery}
          </Link>
        </div>
      </div>
    );
  }

  const isCurrent = character.id === settings.data.default_character_id;

  return (
    <div
      data-theme={character.theme || "default"}
      className="grid min-w-0 gap-5 py-6 sm:py-8"
      data-testid="tutor-detail-page"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="grid gap-1">
          <Link
            to="/tutors"
            className="inline-flex items-center gap-1.5 text-caption font-medium text-fg-secondary hover:text-fg-primary"
          >
            <ArrowLeft size={14} aria-hidden="true" />
            <span>{copy.backGallery}</span>
          </Link>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-headline font-semibold text-fg-primary">{character.name}</h1>
            {character.tagline ? <Badge tone="accent">{character.tagline}</Badge> : null}
            {isCurrent ? <Badge tone="ok">{copy.currentTeacher}</Badge> : null}
          </div>
        </div>
      </div>

      <Tabs
        value={activeTab}
        onValueChange={(next) => {
          const updated = new URLSearchParams(searchParams);
          updated.set("tab", next);
          setSearchParams(updated, { replace: true });
        }}
        items={[
          {
            value: "about",
            label: copy.tabs.about,
            icon: <Sparkles size={15} aria-hidden="true" />,
            content: (
              <TutorShowcase
                character={character}
                isCurrent={isCurrent}
                choosing={choose.isPending}
                headingLevel="h2"
                showEditLink={false}
                chosenGreeting={chosenGreeting}
                chosenSpeakSeq={chosenSpeakSeq}
                onChoose={(entry) => choose.mutate(entry)}
              />
            ),
          },
          {
            value: "persona",
            label: copy.tabs.persona,
            icon: <SlidersHorizontal size={15} aria-hidden="true" />,
            content: (
              <PersonaTab
                key={character.id}
                character={character}
                onDeleted={() => navigate("/tutors", { replace: true })}
              />
            ),
          },
          {
            value: "assets",
            label: copy.tabs.assets,
            icon: <Layers size={15} aria-hidden="true" />,
            content: <AssetsAdvancedTab key={character.id} character={character} />,
          },
        ]}
      />
    </div>
  );
}
