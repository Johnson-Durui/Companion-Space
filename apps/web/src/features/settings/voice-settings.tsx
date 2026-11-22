import { useEffect, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";
import clsx from "clsx";
import { browserApiFetch } from "@companion-space/api-client";
import { api, bodyOf, charactersKey, fetchCharacters } from "../../app/api";
import { Loading, Problem } from "../../app/ui";
import {
  ArrowRight,
  Badge,
  Button,
  Card,
  Check,
  Dialog,
  Field,
  LevelMeter,
  Mic,
  Select,
  Slider,
  Square,
  Switch,
  TextInput,
  TutorAvatar,
  Volume2,
  useTransientSaved,
} from "../../ui";
import {
  classifyMicrophoneError,
  MicrophoneCapture,
  readSoundCuePrefs,
  SoundCuePlayer,
  writeSoundCuePrefs,
  type MicrophoneErrorKind,
} from "../../audio";
import t from "../../locales/zh-CN.json";
import { useActiveTutor, tutorGreeting } from "../tutors/use-active-tutor";
import { useTutorSpeech } from "../voice/use-tutor-speech";

const voiceSettingsKey = ["voice-settings"] as const;
const sttSettingsKey = ["stt-settings"] as const;
const voiceStatusKey = ["voice-status"] as const;
const defaultVoice = {
  engine: "edge" as const,
  voice_id: "zh-CN-XiaoxiaoNeural",
  model: "",
  rate: 1,
  pitch: 0,
  options: {},
};

const ENGINE_OPTIONS = Object.entries(t.voiceSettings.engines).map(([value, label]) => ({
  value,
  label,
}));

async function fetchVoiceSettings() {
  return bodyOf(await api.GET("/api/v2/voice/settings"));
}

type VoiceSettings = Awaited<ReturnType<typeof fetchVoiceSettings>>;
type VoiceSetting = NonNullable<VoiceSettings["default"]>;
type Character = Awaited<ReturnType<typeof fetchCharacters>>[number];

function characterVoice(character: Character): VoiceSetting {
  return {
    engine: character.voice.engine as VoiceSetting["engine"],
    voice_id: character.voice.voice_id,
    model: "",
    rate: character.voice.rate,
    pitch: character.voice.pitch,
    options: {},
  };
}

function VoiceEditor({
  target,
  initial,
  character,
  settings,
}: {
  target: string;
  initial: VoiceSetting;
  character?: Character;
  settings: VoiceSettings;
}) {
  const queries = useQueryClient();
  const [draft, setDraft] = useState(initial);
  const { saved, notifySaved } = useTransientSaved(t.common.saved);
  const speech = useTutorSpeech();

  const save = useMutation({
    mutationFn: async () =>
      bodyOf(
        await api.PUT("/api/v2/voice/settings", {
          body: {
            default: target === "default" ? draft : (settings.default ?? defaultVoice),
            characters: character?.id
              ? { ...(settings.characters ?? {}), [character.id]: draft }
              : (settings.characters ?? {}),
          },
        }),
      ),
    onSuccess: (result) => {
      queries.setQueryData(voiceSettingsKey, result);
      notifySaved();
    },
  });

  async function handlePreview() {
    if (!character) return;
    await save.mutateAsync();
    const sampleLine = character.greeting || character.persona.catchphrases?.[0] || tutorGreeting(character);
    void speech.speak({
      characterId: character.id,
      text: sampleLine,
      voiceId: draft.engine === "edge" ? draft.voice_id : undefined,
    });
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    save.mutate();
  }

  return (
    <form className="grid max-w-2xl gap-4" onSubmit={submit}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t.voiceSettings.engine}>
          <Select
            aria-label={t.voiceSettings.engine}
            options={ENGINE_OPTIONS}
            value={draft.engine}
            onValueChange={(next) => setDraft({ ...draft, engine: next as VoiceSetting["engine"] })}
          />
        </Field>
        <Field label={t.voiceSettings.voiceId}>
          <TextInput
            value={draft.voice_id}
            maxLength={240}
            required={draft.engine !== "browser"}
            onChange={(event) => setDraft({ ...draft, voice_id: event.target.value })}
          />
        </Field>
      </div>

      {!["edge", "browser", "gpt_sovits"].includes(draft.engine) ? (
        <Field label={t.voiceSettings.model}>
          <TextInput
            value={draft.model}
            maxLength={240}
            onChange={(event) => setDraft({ ...draft, model: event.target.value })}
          />
        </Field>
      ) : null}

      {draft.engine === "gpt_sovits" ? (
        <Field label={t.voiceSettings.localEndpoint}>
          <TextInput
            type="url"
            required
            value={String(draft.options?.base_url ?? "")}
            placeholder="http://127.0.0.1:9880"
            onChange={(event) =>
              setDraft({ ...draft, options: { ...draft.options, base_url: event.target.value } })
            }
          />
        </Field>
      ) : null}

      <div className="grid gap-2">
        <div className="flex items-center justify-between text-ui">
          <span className="font-medium text-fg-primary">{t.voiceSettings.rate}</span>
          <span className="tabular-nums text-fg-secondary">{draft.rate.toFixed(2)}×</span>
        </div>
        <Slider
          value={Math.round(draft.rate * 100)}
          min={60}
          max={160}
          step={5}
          aria-label={t.voiceSettings.rate}
          onValueChange={(val) => setDraft({ ...draft, rate: Number((val / 100).toFixed(2)) })}
        />
      </div>

      <div className="flex flex-wrap items-center gap-3 pt-1">
        <Button type="submit" variant="primary" pending={save.isPending}>
          {t.common.save}
        </Button>
        {character ? (
          <Button
            variant="secondary"
            disabled={save.isPending}
            pending={speech.loading}
            leftIcon={<Volume2 size={15} aria-hidden="true" />}
            onClick={() => void handlePreview()}
          >
            {t.voice.preview}
          </Button>
        ) : null}
        {saved ? (
          <span className="inline-flex items-center gap-1 text-ui font-medium text-ok-text">
            <Check size={15} aria-hidden="true" />
            {t.common.saved}
          </span>
        ) : null}
      </div>

      {speech.unavailable ? (
        <p className="text-caption text-fg-secondary" role="status">
          {t.speech.unavailable}
        </p>
      ) : null}
      {save.isError ? <Problem error={save.error} /> : null}
    </form>
  );
}

function SoundCuesCard() {
  const [prefs, setPrefs] = useState(() => readSoundCuePrefs());
  const previewPlayerRef = useRef<SoundCuePlayer | null>(null);

  useEffect(() => {
    const player = new SoundCuePlayer();
    previewPlayerRef.current = player;
    return () => {
      previewPlayerRef.current = null;
      void player.close();
    };
  }, []);

  const updatePrefs = (patch: Partial<{ enabled: boolean; volume: number }>) => {
    const next = writeSoundCuePrefs(patch);
    setPrefs(next);
    previewPlayerRef.current?.setPrefs(next);
  };

  return (
    <Card padding="lg" className="grid gap-4" data-testid="sound-cues-card">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="grid gap-0.5">
          <h3 className="text-body font-semibold text-fg-primary">{t.settings.tutorSoundCues}</h3>
          <p className="text-ui text-fg-secondary">{t.settings.tutorSoundCuesHint}</p>
        </div>
        <Switch
          checked={prefs.enabled}
          aria-label={t.settings.tutorSoundCues}
          onCheckedChange={(enabled) => {
            updatePrefs({ enabled });
            if (enabled) {
              previewPlayerRef.current?.unlock();
              previewPlayerRef.current?.play("connect");
            }
          }}
        />
      </div>

      {prefs.enabled ? (
        <div className="grid max-w-md gap-2 border-t border-line-subtle pt-3">
          <div className="flex items-center justify-between text-ui">
            <span className="font-medium text-fg-primary">{t.settings.tutorSoundCuesVolume}</span>
            <span className="tabular-nums text-fg-secondary">{Math.round(prefs.volume * 100)}%</span>
          </div>
          <Slider
            value={Math.round(prefs.volume * 100)}
            min={5}
            max={100}
            step={5}
            aria-label={t.settings.tutorSoundCuesVolume}
            onValueChange={(val) => updatePrefs({ volume: val / 100 })}
          />
        </div>
      ) : null}
    </Card>
  );
}

export function TutorVoiceSection() {
  const [params] = useSearchParams();
  const [selected, setSelected] = useState<string>();
  const { tutor: activeTutor } = useActiveTutor(true);
  const settings = useQuery({ queryKey: voiceSettingsKey, queryFn: fetchVoiceSettings });
  const characters = useQuery({ queryKey: charactersKey, queryFn: fetchCharacters });

  if (settings.isPending || characters.isPending) return <Loading />;
  if (settings.isError) return <Problem error={settings.error} onRetry={() => void settings.refetch()} />;
  if (characters.isError) return <Problem error={characters.error} onRetry={() => void characters.refetch()} />;

  const requested = selected ?? params.get("teacher") ?? activeTutor?.id;
  const target = characters.data.some((entry) => entry.id === requested) ? requested! : "default";
  const character = characters.data.find((entry) => entry.id === target);
  const initial =
    target === "default"
      ? (settings.data.default ?? defaultVoice)
      : (settings.data.characters?.[target] ?? (character ? characterVoice(character) : defaultVoice));

  const scopeOptions = [
    { value: "default", label: t.voiceSettings.defaultVoice },
    ...characters.data.map((entry) => ({ value: entry.id, label: entry.name })),
  ];

  return (
    <div className="grid gap-5">
      {activeTutor ? (
        <Card padding="lg" className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <TutorAvatar src={activeTutor.appearance.src} name={activeTutor.name} size="lg" />
            <div className="grid gap-1">
              <div className="flex items-center gap-2">
                <span className="text-caption font-medium text-fg-tertiary">{t.settings.tutorCurrent}</span>
                {activeTutor.tagline ? <Badge tone="accent">{activeTutor.tagline}</Badge> : null}
              </div>
              <h2 className="text-title font-semibold text-fg-primary">{activeTutor.name}</h2>
              {activeTutor.greeting ? (
                <p className="text-ui text-fg-secondary">{activeTutor.greeting}</p>
              ) : null}
            </div>
          </div>
          <Link
            to="/tutors"
            className="inline-flex min-h-10 items-center gap-1.5 rounded-md border border-line-default bg-surface-card px-3.5 text-ui font-medium text-fg-primary hover:bg-surface-sunken"
          >
            <span>{t.settings.tutorChange}</span>
            <ArrowRight size={15} aria-hidden="true" />
          </Link>
        </Card>
      ) : null}

      <Card padding="lg" className="grid gap-5">
        <div className="grid gap-1 border-b border-line-subtle pb-3">
          <h3 className="text-body font-semibold text-fg-primary">{t.settings.tutorVoiceHeading}</h3>
        </div>
        <div className="max-w-sm">
          <Field label={t.settings.tutorVoiceScope}>
            <Select
              aria-label={t.settings.tutorVoiceScope}
              options={scopeOptions}
              value={target}
              onValueChange={setSelected}
            />
          </Field>
        </div>
        <VoiceEditor
          key={target}
          target={target}
          initial={initial}
          character={character}
          settings={settings.data}
        />
      </Card>

      <SoundCuesCard />
    </div>
  );
}

function RecognitionCards() {
  const copy = t.voiceSettings;
  const queries = useQueryClient();
  const settings = useQuery({
    queryKey: sttSettingsKey,
    queryFn: async () => bodyOf(await api.GET("/api/v2/voice/stt")),
  });
  const save = useMutation({
    mutationFn: async (body: { engine: "openai_compat" | "local_sherpa"; download_model?: boolean }) =>
      bodyOf(await api.PUT("/api/v2/voice/stt", { body: { ...body, download_model: body.download_model ?? false } })),
    onSuccess(result) {
      queries.setQueryData(sttSettingsKey, result);
      void queries.invalidateQueries({ queryKey: voiceStatusKey });
    },
  });

  if (settings.isPending) return <Loading />;
  if (settings.isError) return <Problem error={settings.error} onRetry={() => void settings.refetch()} />;
  const current = settings.data;
  const local = current.engine === "local_sherpa";
  const size = String(Math.round((current.download_bytes ?? 163_000_000) / 1_000_000));

  return (
    <Card padding="lg" className="grid gap-4">
      <div className="grid gap-1 border-b border-line-subtle pb-3">
        <h3 className="text-body font-semibold text-fg-primary">{copy.recognition}</h3>
        <p className="text-ui text-fg-secondary">
          {copy.recognitionSelected.replace("{engine}", local ? copy.recognitionLocal : copy.recognitionOnline)}
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div
          className={clsx(
            "grid content-between gap-3 rounded-lg border p-4",
            !local ? "border-accent bg-accent-soft/35" : "border-line-subtle bg-surface-page",
          )}
        >
          <div className="grid gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <strong className="text-body font-semibold text-fg-primary">
                {t.settings.voiceCardOnline}
              </strong>
              {!local ? <Badge tone="ok">{t.settings.voiceActive}</Badge> : null}
            </div>
            <p className="text-ui text-fg-secondary">{t.settings.voiceCardOnlineHint}</p>
          </div>
          {local ? (
            <div>
              <Button
                variant="secondary"
                size="sm"
                pending={save.isPending && save.variables?.engine === "openai_compat"}
                onClick={() => save.mutate({ engine: "openai_compat" })}
              >
                {t.settings.voiceUseThis}
              </Button>
            </div>
          ) : null}
        </div>

        <div
          className={clsx(
            "grid content-between gap-3 rounded-lg border p-4",
            local ? "border-accent bg-accent-soft/35" : "border-line-subtle bg-surface-page",
          )}
        >
          <div className="grid gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <strong className="text-body font-semibold text-fg-primary">
                {t.settings.voiceCardOffline}
              </strong>
              {local ? <Badge tone="ok">{t.settings.voiceActive}</Badge> : null}
            </div>
            <p className="text-ui text-fg-secondary">
              {t.settings.voiceCardOfflineHint.replace("{size}", size)}{" "}
              <a
                href={current.license_url}
                target="_blank"
                rel="noreferrer"
                className="font-medium text-accent-strong underline underline-offset-2"
              >
                {copy.recognitionLicense}
              </a>
            </p>
          </div>
          <div>
            {!local || !current.local_model_available ? (
              <Button
                variant="secondary"
                size="sm"
                disabled={!current.local_runtime_available}
                pending={save.isPending && save.variables?.engine === "local_sherpa"}
                onClick={() =>
                  save.mutate({ engine: "local_sherpa", download_model: !current.local_model_available })
                }
              >
                {current.local_model_available
                  ? t.settings.voiceUseThis
                  : copy.recognitionDownload.replace("{size}", size)}
              </Button>
            ) : null}
          </div>
        </div>
      </div>

      {save.isPending && save.variables?.download_model ? (
        <p className="text-ui text-accent-strong" role="status">
          {copy.recognitionInstalling}
        </p>
      ) : null}
      {save.isError ? <Problem error={new Error(copy.recognitionFailed)} /> : null}

      <details
        data-advanced="true"
        className="rounded-md border border-line-subtle bg-surface-page px-4 py-3"
      >
        <summary className="cursor-pointer select-none text-ui font-medium text-fg-secondary">
          {t.settings.voiceTroubleshoot}
        </summary>
        <div className="mt-2 grid gap-2 text-caption text-fg-secondary">
          <p>{copy.recognitionRuntime}</p>
          <code className="block overflow-x-auto rounded-sm bg-surface-sunken px-3 py-2 text-fg-primary">
            python -m pip install -r services/api/requirements-local-stt.txt
          </code>
        </div>
      </details>
    </Card>
  );
}

function MicrophoneTestCard() {
  const status = useQuery({
    queryKey: voiceStatusKey,
    queryFn: async () => bodyOf(await api.GET("/api/v2/voice/status")),
  });
  const capture = useRef(new MicrophoneCapture());
  const frames = useRef<ArrayBuffer[]>([]);
  const frameCount = useRef(0);
  const [recording, setRecording] = useState(false);
  const [level, setLevel] = useState(0);
  const [result, setResult] = useState("");
  const [error, setError] = useState<unknown>();
  const [micErrKind, setMicErrKind] = useState<MicrophoneErrorKind | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);

  useEffect(() => {
    const cap = capture.current;
    return () => {
      void cap.dispose();
    };
  }, []);

  async function start() {
    setError(undefined);
    setMicErrKind(null);
    setResult("");
    frames.current = [];
    frameCount.current = 0;
    try {
      await capture.current.start((frame) => {
        if (frames.current.length < 3000) frames.current.push(frame.pcm16);
        frameCount.current += 1;
        if (frameCount.current % 4 === 0) setLevel(frame.level);
      });
      setRecording(true);
    } catch (reason) {
      setMicErrKind(classifyMicrophoneError(reason));
    }
  }

  async function stop() {
    await capture.current.stop();
    setRecording(false);
    setLevel(0);
    try {
      const body = new Blob(
        frames.current.map((frame) => new Uint8Array(frame)),
        { type: "audio/pcm" },
      );
      const response = await browserApiFetch("/api/v2/voice/microphone-test", { method: "POST", body });
      const payload = (await response.json()) as {
        accepted?: boolean;
        text?: string;
        discard_reason?: string;
      };
      if (!response.ok) throw new Error(t.common.error);
      const discard = payload.discard_reason as keyof typeof t.voiceSettings.discard;
      setResult(
        payload.accepted
          ? (payload.text ?? "")
          : (t.voiceSettings.discard[discard] ?? t.voiceSettings.noSpeech),
      );
    } catch (reason) {
      setError(reason);
    } finally {
      frames.current = [];
    }
  }

  return (
    <Card padding="lg" className="grid gap-4">
      <div className="grid gap-1 border-b border-line-subtle pb-3">
        <h3 className="text-body font-semibold text-fg-primary">{t.voiceSettings.microphone}</h3>
      </div>

      <div className="grid max-w-md gap-3">
        <LevelMeter
          value={recording ? Math.min(1, level * 4) : 0}
          label={t.voiceSettings.level}
        />
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant={recording ? "primary" : "secondary"}
            disabled={!recording && !status.data?.stt_configured}
            leftIcon={recording ? <Square size={14} /> : <Mic size={15} />}
            onClick={() => void (recording ? stop() : start())}
          >
            {recording ? t.voiceSettings.finishTest : t.voiceSettings.startTest}
          </Button>
          {recording ? (
            <span className="text-ui text-accent-strong" role="status">
              {t.voiceSettings.speakNow}
            </span>
          ) : null}
        </div>
      </div>

      {status.data && !status.data.stt_configured ? (
        <p className="text-ui text-fg-secondary">{t.voiceSettings.recognitionNotReady}</p>
      ) : null}
      {status.isError ? <Problem error={status.error} onRetry={() => void status.refetch()} /> : null}
      {result ? (
        <p className="rounded-md border border-line-subtle bg-accent-soft/40 px-3.5 py-2.5 text-ui text-fg-primary" role="status">
          {result}
        </p>
      ) : null}
      {micErrKind ? (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-warn/30 bg-warn-soft p-3 text-ui text-warn-text">
          <span>
            {micErrKind === "permission_denied"
              ? t.classroom.micDeniedBody
              : micErrKind === "not_found"
                ? t.classroom.micNotFoundBody
                : t.classroom.micOtherBody}
          </span>
          {micErrKind === "permission_denied" ? (
            <Button variant="secondary" size="sm" onClick={() => setHelpOpen(true)}>
              {t.classroom.micHelpButton}
            </Button>
          ) : null}
        </div>
      ) : null}
      {error ? <Problem error={error} /> : null}

      <Dialog
        open={helpOpen}
        onOpenChange={setHelpOpen}
        title={t.classroom.micHelpTitle}
        description={t.classroom.micDeniedBody}
        size="sm"
        closeLabel={t.classroom.close}
      >
        <ol className="m-0 grid list-none gap-2.5 p-0 text-ui text-fg-primary">
          <li>{t.classroom.micHelpStep1}</li>
          <li>{t.classroom.micHelpStep2}</li>
          <li>{t.classroom.micHelpStep3}</li>
        </ol>
      </Dialog>
    </Card>
  );
}

export function MicAndRecognitionSection() {
  return (
    <div className="grid gap-5">
      <MicrophoneTestCard />
      <RecognitionCards />
    </div>
  );
}
