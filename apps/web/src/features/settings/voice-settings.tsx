import { useEffect, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { browserApiFetch } from "@companion-space/api-client";
import { api, bodyOf, charactersKey, fetchCharacters } from "../../app/api";
import { Loading, Problem } from "../../app/ui";
import { MicrophoneCapture } from "../../audio";
import t from "../../locales/zh-CN.json";

const voiceSettingsKey = ["voice-settings"] as const;
const defaultVoice = {
  engine: "edge" as const, voice_id: "zh-CN-XiaoxiaoNeural", model: "", rate: 1, pitch: 0, options: {},
};

async function fetchVoiceSettings() {
  return bodyOf(await api.GET("/api/v2/voice/settings"));
}

type VoiceSettings = Awaited<ReturnType<typeof fetchVoiceSettings>>;
type VoiceSetting = NonNullable<VoiceSettings["default"]>;
type Character = Awaited<ReturnType<typeof fetchCharacters>>[number];

function characterVoice(character: Character): VoiceSetting {
  return {
    engine: character.voice.engine as VoiceSetting["engine"], voice_id: character.voice.voice_id,
    model: "", rate: character.voice.rate, pitch: character.voice.pitch, options: {},
  };
}

function pcmWavUrl(audioB64: string, sampleRate: number) {
  const raw = atob(audioB64);
  const pcm = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) pcm[index] = raw.charCodeAt(index);
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const text = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
  };
  text(0, "RIFF"); view.setUint32(4, 36 + pcm.byteLength, true); text(8, "WAVE"); text(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, "data");
  view.setUint32(40, pcm.byteLength, true);
  return URL.createObjectURL(new Blob([header, pcm], { type: "audio/wav" }));
}

function VoiceEditor({ target, initial, characterId, settings }: {
  target: string; initial: VoiceSetting; characterId?: string; settings: VoiceSettings;
}) {
  const queries = useQueryClient();
  const audio = useRef<HTMLAudioElement>(null);
  const audioUrl = useRef("");
  const [draft, setDraft] = useState(initial);
  const [playbackHint, setPlaybackHint] = useState("");
  const save = useMutation({
    mutationFn: async () => bodyOf(await api.PUT("/api/v2/voice/settings", { body: {
      default: target === "default" ? draft : (settings.default ?? defaultVoice),
      characters: characterId
        ? { ...(settings.characters ?? {}), [characterId]: draft }
        : (settings.characters ?? {}),
    } })),
    onSuccess: (result) => queries.setQueryData(voiceSettingsKey, result),
  });
  const preview = useMutation({
    mutationFn: async () => {
      if (!characterId) throw new Error(t.voiceSettings.chooseTeacher);
      await save.mutateAsync();
      return bodyOf(await api.POST("/api/v2/voice/preview", { body: { character_id: characterId } }));
    },
    onSuccess(result) {
      setPlaybackHint(result.warning ?? "");
      if (result.kind === "browser") {
        if (!("speechSynthesis" in window)) { setPlaybackHint(t.voice.browserFailed); return; }
        window.speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(result.text);
        utterance.lang = "zh-CN";
        utterance.onerror = () => setPlaybackHint(t.voice.browserFailed);
        window.speechSynthesis.speak(utterance);
        return;
      }
      if (!result.audio_b64 || !result.format || !audio.current) return;
      if (audioUrl.current.startsWith("blob:")) URL.revokeObjectURL(audioUrl.current);
      audioUrl.current = result.format === "mp3"
        ? `data:audio/mpeg;base64,${result.audio_b64}`
        : pcmWavUrl(result.audio_b64, result.sample_rate_hz ?? 24_000);
      audio.current.src = audioUrl.current;
      void audio.current.play().catch(() => setPlaybackHint(t.voice.cannotAutoPlay));
    },
  });
  useEffect(() => () => {
    if (audioUrl.current.startsWith("blob:")) URL.revokeObjectURL(audioUrl.current);
    window.speechSynthesis?.cancel();
  }, []);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    save.mutate();
  }

  return (
    <form className="fields" onSubmit={submit}>
      <div className="field-row">
        <label>{t.voiceSettings.engine}
          <select value={draft.engine} onChange={(event) => setDraft({ ...draft, engine: event.target.value as VoiceSetting["engine"] })}>
            {Object.entries(t.voiceSettings.engines).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label>{t.voiceSettings.voiceId}
          <input value={draft.voice_id} maxLength={240} required={draft.engine !== "browser"} onChange={(event) => setDraft({ ...draft, voice_id: event.target.value })} />
        </label>
      </div>
      {!["edge", "browser", "gpt_sovits"].includes(draft.engine) ? (
        <label>{t.voiceSettings.model}<input value={draft.model} maxLength={240} onChange={(event) => setDraft({ ...draft, model: event.target.value })} /></label>
      ) : null}
      {draft.engine === "gpt_sovits" ? (
        <label>{t.voiceSettings.localEndpoint}
          <input type="url" required value={String(draft.options?.base_url ?? "")} placeholder="http://127.0.0.1:9880" onChange={(event) => setDraft({ ...draft, options: { ...draft.options, base_url: event.target.value } })} />
        </label>
      ) : null}
      <div className="field-row">
        <label>{t.voiceSettings.rate}<input type="number" min="0.5" max="2" step="0.05" value={draft.rate} onChange={(event) => setDraft({ ...draft, rate: Number(event.target.value) })} /></label>
        <label>{t.voiceSettings.pitch}<input type="number" min="-100" max="100" step="1" value={draft.pitch} onChange={(event) => setDraft({ ...draft, pitch: Number(event.target.value) })} /></label>
      </div>
      <div className="actions">
        <button className="button primary" disabled={save.isPending}>{save.isPending ? t.common.saving : t.common.save}</button>
        <button type="button" className="button quiet" disabled={!characterId || preview.isPending || save.isPending} onClick={() => preview.mutate()}>{preview.isPending ? t.voice.loading : t.voice.preview}</button>
        {save.isSuccess ? <p className="form-success" role="status">{t.common.saved}</p> : null}
      </div>
      <audio ref={audio} controls hidden={!preview.data || preview.data.kind !== "audio"} aria-label={t.voice.play} />
      {playbackHint ? <p className="hint" role="status">{playbackHint}</p> : null}
      {save.isError || preview.isError ? <Problem error={save.error ?? preview.error} /> : null}
    </form>
  );
}

function MicrophoneTest() {
  const capture = useRef(new MicrophoneCapture());
  const frames = useRef<ArrayBuffer[]>([]);
  const frameCount = useRef(0);
  const [recording, setRecording] = useState(false);
  const [level, setLevel] = useState(0);
  const [result, setResult] = useState("");
  const [error, setError] = useState<unknown>();
  useEffect(() => () => { void capture.current.stop(); }, []);

  async function start() {
    setError(undefined); setResult(""); frames.current = []; frameCount.current = 0;
    try {
      await capture.current.start((frame) => {
        if (frames.current.length < 3000) frames.current.push(frame.pcm16);
        frameCount.current += 1;
        if (frameCount.current % 4 === 0) setLevel(frame.level);
      });
      setRecording(true);
    } catch (reason) { setError(reason); }
  }

  async function stop() {
    await capture.current.stop(); setRecording(false); setLevel(0);
    try {
      const body = new Blob(frames.current.map((frame) => new Uint8Array(frame)), { type: "audio/pcm" });
      const response = await browserApiFetch("/api/v2/voice/microphone-test", { method: "POST", body });
      const payload = await response.json() as { accepted?: boolean; text?: string; discard_reason?: string };
      if (!response.ok) throw new Error(t.common.error);
      const discard = payload.discard_reason as keyof typeof t.voiceSettings.discard;
      setResult(payload.accepted ? (payload.text ?? "") : (t.voiceSettings.discard[discard] ?? t.voiceSettings.noSpeech));
    } catch (reason) { setError(reason); }
    finally { frames.current = []; }
  }

  return (
    <div className="fields">
      <h3>{t.voiceSettings.microphone}</h3>
      <meter min="0" max="0.25" value={Math.min(level, 0.25)} aria-label={t.voiceSettings.level} />
      <div className="actions">
        <button type="button" className={`button ${recording ? "primary" : "quiet"}`} onClick={() => void (recording ? stop() : start())}>{recording ? t.voiceSettings.finishTest : t.voiceSettings.startTest}</button>
        {recording ? <p className="hint" role="status">{t.voiceSettings.speakNow}</p> : null}
      </div>
      {result ? <p className="notice" role="status">{result}</p> : null}
      {error ? <Problem error={error} /> : null}
    </div>
  );
}

export function VoiceSettingsPanel() {
  const [target, setTarget] = useState("default");
  const settings = useQuery({ queryKey: voiceSettingsKey, queryFn: fetchVoiceSettings });
  const characters = useQuery({ queryKey: charactersKey, queryFn: fetchCharacters });
  if (settings.isPending || characters.isPending) return <Loading />;
  if (settings.isError) return <Problem error={settings.error} onRetry={() => void settings.refetch()} />;
  if (characters.isError) return <Problem error={characters.error} onRetry={() => void characters.refetch()} />;
  const character = characters.data.find((entry) => entry.id === target);
  const initial = target === "default"
    ? (settings.data.default ?? defaultVoice)
    : (settings.data.characters?.[target] ?? (character ? characterVoice(character) : defaultVoice));
  return (
    <>
      <label className="field">{t.voiceSettings.scope}
        <select value={target} onChange={(event) => setTarget(event.target.value)}>
          <option value="default">{t.voiceSettings.defaultVoice}</option>
          {characters.data.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
        </select>
      </label>
      <VoiceEditor key={target} target={target} initial={initial} characterId={character?.id} settings={settings.data} />
      <MicrophoneTest />
    </>
  );
}
