import { useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api, bodyOf } from "../../app/api";
import { Problem } from "../../app/ui";
import { Play } from "../../ui/icons";
import t from "../../locales/zh-CN.json";

export function VoicePreview({ id, text }: { id: string; text?: string }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [hint, setHint] = useState("");
  const preview = useMutation({
    mutationFn: async () => bodyOf(await api.POST("/api/v2/tts/preview", { body: { character_id: id, text } })),
    onSuccess(result) {
      if (result.kind === "audio" && result.audio_b64 && audio.current) {
        audio.current.src = `data:${result.content_type ?? "audio/mpeg"};base64,${result.audio_b64}`;
        void audio.current.play().catch(() => setHint(t.voice.cannotAutoPlay));
      }
    },
  });

  function speak() {
    if (!preview.data || !("speechSynthesis" in window)) {
      setHint(t.voice.browserFailed);
      return;
    }
    const speech = new SpeechSynthesisUtterance(preview.data.text);
    speech.lang = "zh-CN";
    speech.onerror = () => setHint(t.voice.browserFailed);
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(speech);
  }

  return (
    <div className="voice-preview">
      <button className="button quiet" disabled={preview.isPending} aria-busy={preview.isPending || undefined} onClick={() => { setHint(""); preview.mutate(); }}>
        <Play size={15} aria-hidden="true" />{preview.isPending ? t.voice.loading : t.voice.preview}
      </button>
      <audio aria-label={t.voice.play} ref={audio} controls hidden={preview.data?.kind !== "audio"} />
      {preview.data?.kind === "audio" && preview.data.warning ? <p role="status" className="hint">{preview.data.warning}</p> : null}
      {preview.data?.kind === "browser" ? (
        <div className="notice">
          <p role="status">{preview.data.warning ?? t.voice.fallback}</p>
          <button className="button quiet" onClick={speak}>{t.voice.browser}</button>
        </div>
      ) : null}
      {hint ? <p role="status" className="hint">{hint}</p> : null}
      {preview.isError ? <Problem error={preview.error} /> : null}
    </div>
  );
}
