import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { browserApiFetch } from "@companion-space/api-client";
import type { components } from "@companion-space/api-client/schema";
import {
  api,
  bodyOf,
  charactersKey,
  ensureOK,
  settingsKey,
  type Character,
} from "../../app/api";
import { Problem } from "../../app/ui";
import {
  Button,
  Chip,
  Dialog,
  Field,
  FileDropzone,
  Select,
  Slider,
  Stepper,
  TextInput,
  Volume2,
  X,
  toast,
} from "../../ui";
import t from "../../locales/zh-CN.json";
import { useTutorSpeech } from "../voice/use-tutor-speech";
import { EDGE_VOICE_CHOICES, TUTOR_THEME_CHOICES, type TutorThemeChoice } from "./voice-catalog";

const copy = t.tutorsGallery;
type TutorUpdate = components["schemas"]["TutorUpdate"];

export interface ImportTutorWizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialFile?: File | null;
  onFinished?: (character: Character) => void;
}

export function ImportTutorWizardDialog({
  open,
  onOpenChange,
  initialFile,
  onFinished,
}: ImportTutorWizardProps) {
  const queries = useQueryClient();
  const speech = useTutorSpeech();

  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [imported, setImported] = useState<Character | null>(null);
  const [name, setName] = useState("");
  const [tagline, setTagline] = useState("");
  const [greeting, setGreeting] = useState("");
  const [styleId, setStyleId] = useState<NonNullable<TutorUpdate["default_style_id"]>>("guided");
  const [traits, setTraits] = useState<string[]>([]);
  const [traitDraft, setTraitDraft] = useState("");
  const [theme, setTheme] = useState<TutorThemeChoice>("default");
  const [voiceId, setVoiceId] = useState<string>(EDGE_VOICE_CHOICES[3].id);
  const [rate, setRate] = useState(1.0);

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
    onSuccess: (character) => {
      setImported(character);
      setName(character.name);
      setTagline(character.tagline || "");
      setGreeting(character.greeting || "");
      setStyleId((character.default_style_id as NonNullable<TutorUpdate["default_style_id"]>) || "guided");
      setTraits(character.persona.traits ?? []);
      setTheme((character.theme as TutorThemeChoice) || "default");
      setVoiceId(character.voice.voice_id || EDGE_VOICE_CHOICES[3].id);
      setRate(character.voice.rate ?? 1.0);
      queries.setQueryData<Character[]>(charactersKey, (items) => [...(items ?? []), character]);
      setStep(2);
    },
  });

  const saveAndFinish = useMutation({
    mutationFn: async (setAsActive: boolean) => {
      if (!imported) throw new Error("No imported tutor");
      const updated = bodyOf(
        await api.PUT("/api/v2/characters/{character_id}", {
          params: { path: { character_id: imported.id } },
          body: {
            name: name.trim() || imported.name,
            tagline: tagline.trim(),
            greeting: greeting.trim(),
            default_style_id: styleId,
            traits: traits.slice(0, 8),
            theme,
            voice: { engine: "edge", voice_id: voiceId, rate, pitch: 0 },
          },
        }),
      );
      if (setAsActive) {
        bodyOf(
          await api.PUT("/api/v2/settings/default-character", {
            body: { character_id: updated.id },
          }),
        );
      }
      return updated;
    },
    onSuccess: (updated) => {
      queries.setQueryData<Character[]>(charactersKey, (items) =>
        items?.map((entry) => (entry.id === updated.id ? updated : entry)) ?? [updated],
      );
      void queries.invalidateQueries({ queryKey: settingsKey });
      toast.success(t.common.saved);
      onOpenChange(false);
      onFinished?.(updated);
    },
  });

  const previewVoice = useMutation({
    mutationFn: async () => {
      if (!imported) return;
      const updated = bodyOf(
        await api.PUT("/api/v2/characters/{character_id}", {
          params: { path: { character_id: imported.id } },
          body: { voice: { engine: "edge", voice_id: voiceId, rate, pitch: 0 } },
        }),
      );
      queries.setQueryData<Character[]>(charactersKey, (items) =>
        items?.map((entry) => (entry.id === updated.id ? updated : entry)),
      );
      await speech.speak({
        characterId: updated.id,
        text: greeting.trim() || `${name.trim() || updated.name}，你好，我们一起开始学习吧。`,
      });
    },
  });

  function handleDialogOpenChange(next: boolean) {
    if (!next) {
      speech.stop();
      setStep(1);
      setImported(null);
      setTraitDraft("");
      upload.reset();
      saveAndFinish.reset();
    }
    onOpenChange(next);
  }

  useEffect(() => {
    if (open && initialFile && !imported && !upload.isPending) {
      upload.mutate(initialFile);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialFile]);

  function addTrait() {
    const clean = traitDraft.trim().slice(0, 20);
    if (!clean || traits.includes(clean) || traits.length >= 8) return;
    setTraits((prev) => [...prev, clean]);
    setTraitDraft("");
  }

  const stepperItems = copy.importSteps.map((label, idx) => {
    const n = (idx + 1) as 1 | 2 | 3;
    return {
      id: String(n),
      label,
      status: n < step ? ("done" as const) : n === step ? ("active" as const) : ("todo" as const),
    };
  });

  return (
    <Dialog open={open} onOpenChange={handleDialogOpenChange} title={copy.importWizardTitle} size="lg">
      <div className="grid gap-5" data-testid="import-tutor-wizard">
        <Stepper steps={stepperItems} currentId={String(step)} compact aria-label={copy.importWizardTitle} />

        {step === 1 ? (
          <div className="grid gap-4">
            <FileDropzone
              onFiles={(files) => {
                if (files[0] && !upload.isPending) upload.mutate(files[0]);
              }}
              accept=".tutorpack,.zip,.png,.jpg,.jpeg,.webp"
              multiple={false}
              disabled={upload.isPending}
              title={upload.isPending ? t.characters.importing : copy.importDropTitle}
              description={copy.importDropHint}
              buttonLabel={copy.importChooseFile}
            />
            {upload.isError ? <Problem error={upload.error} /> : null}
          </div>
        ) : null}

        {step === 2 && imported ? (
          <div className="grid gap-4 sm:grid-cols-[140px_1fr]">
            <div className="mx-auto aspect-[9/14] w-32 overflow-hidden rounded-lg bg-surface-sunken shadow-2">
              <img
                src={imported.appearance.src}
                alt={name || imported.name}
                className="h-full w-full object-cover object-[center_18%]"
              />
            </div>
            <div className="grid gap-3">
              <Field label={t.characters.name} required>
                <TextInput
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={60}
                  required
                  autoFocus
                />
              </Field>
              <Field label={copy.tagline}>
                <TextInput
                  value={tagline}
                  onChange={(e) => setTagline(e.target.value)}
                  placeholder={copy.taglinePlaceholder}
                  maxLength={24}
                />
              </Field>
              <Field label={copy.greeting}>
                <TextInput
                  value={greeting}
                  onChange={(e) => setGreeting(e.target.value)}
                  placeholder={copy.greetingPlaceholder}
                  maxLength={80}
                />
              </Field>
              <div className="grid gap-1.5">
                <span className="text-ui font-medium text-fg-primary">{copy.themeSection}</span>
                <div className="flex flex-wrap gap-2">
                  {TUTOR_THEME_CHOICES.map((swatch) => (
                    <button
                      key={swatch.id}
                      type="button"
                      data-theme={swatch.id}
                      aria-label={swatch.label}
                      aria-pressed={theme === swatch.id}
                      onClick={() => setTheme(swatch.id)}
                      className="inline-flex h-8 items-center gap-1.5 rounded-full border border-line-default bg-surface-card px-2.5 text-caption font-medium text-fg-primary transition-transform duration-fast hover:border-accent aria-pressed:border-accent aria-pressed:ring-2 aria-pressed:ring-accent/30"
                    >
                      <span aria-hidden="true" className="h-3.5 w-3.5 rounded-full bg-accent" />
                      <span>{swatch.label}</span>
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <Button variant="primary" disabled={!name.trim()} onClick={() => setStep(3)}>
                  {copy.importNext}
                </Button>
              </div>
            </div>
          </div>
        ) : null}

        {step === 3 && imported ? (
          <div className="grid gap-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t.characters.style}>
                <Select
                  value={styleId}
                  onValueChange={(v) => setStyleId(v as NonNullable<TutorUpdate["default_style_id"]>)}
                  options={Object.entries(t.learner.styles).map(([value, label]) => ({ value, label }))}
                />
              </Field>
              <Field label={copy.voiceSelect}>
                <Select
                  value={voiceId}
                  onValueChange={setVoiceId}
                  options={EDGE_VOICE_CHOICES.map((v) => ({
                    value: v.id,
                    label: v.label,
                    description: v.note,
                  }))}
                />
              </Field>
            </div>

            <div className="grid gap-2">
              <span className="text-ui font-medium text-fg-primary">{t.characters.traits}</span>
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
                <Button variant="secondary" onClick={addTrait} disabled={!traitDraft.trim() || traits.length >= 8}>
                  {copy.addTag}
                </Button>
              </div>
            </div>

            <div className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
              <div className="grid gap-1.5">
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
              <Button
                variant="secondary"
                pending={previewVoice.isPending || speech.loading}
                leftIcon={<Volume2 size={15} aria-hidden="true" />}
                onClick={() => previewVoice.mutate()}
              >
                {copy.voicePreview}
              </Button>
            </div>
            {speech.unavailable ? (
              <p role="status" className="text-caption text-fg-tertiary">{t.speech.unavailable}</p>
            ) : null}

            {saveAndFinish.isError ? <Problem error={saveAndFinish.error} /> : null}

            <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
              <Button variant="ghost" onClick={() => setStep(2)}>
                {t.onboarding.back}
              </Button>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  pending={saveAndFinish.isPending}
                  onClick={() => saveAndFinish.mutate(false)}
                >
                  {copy.importDoneOnly}
                </Button>
                <Button
                  variant="primary"
                  pending={saveAndFinish.isPending}
                  onClick={() => saveAndFinish.mutate(true)}
                >
                  {copy.importFinish}
                </Button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
