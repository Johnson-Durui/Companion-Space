import { Button, Play, Square } from "../../ui";
import t from "../../locales/zh-CN.json";
import { useTutorSpeech } from "../voice/use-tutor-speech";

export function VoicePreview({ id, text }: { id: string; text?: string }) {
  const { speak, stop, loading, speaking, unavailable, warning } = useTutorSpeech();

  return (
    <div className="inline-flex flex-wrap items-center gap-2">
      <Button
        variant="secondary"
        pending={loading}
        leftIcon={speaking ? <Square size={14} aria-hidden="true" /> : <Play size={15} aria-hidden="true" />}
        onClick={() => {
          if (speaking) stop();
          else void speak({ characterId: id, text });
        }}
      >
        {speaking ? t.common.stop : t.voice.preview}
      </Button>
      {warning && !unavailable ? (
        <span role="status" className="text-caption text-fg-secondary">{warning}</span>
      ) : null}
      {unavailable ? (
        <span role="status" className="text-caption text-fg-secondary">{t.speech.unavailable}</span>
      ) : null}
    </div>
  );
}
