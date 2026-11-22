import { useEffect, useRef } from "react";
import clsx from "clsx";
import t from "../../locales/zh-CN.json";
import { Badge, MessageSquareText, Mic } from "../../ui";
import type { SpokenEntry } from "./lesson-state";

const copy = t.classroom;

export interface TranscriptPanelProps {
  entries: readonly SpokenEntry[];
  teacherName?: string;
  recording: boolean;
  liveTranscript?: string;
  reducedMotion: boolean;
  compact?: boolean;
}

export function TranscriptPanel({
  entries,
  teacherName,
  recording,
  liveTranscript,
  reducedMotion,
  compact = false,
}: TranscriptPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({
      top: el.scrollHeight,
      behavior: reducedMotion ? "instant" : "smooth",
    });
  }, [entries.length, recording, liveTranscript, reducedMotion]);

  const badgeText = (entry: SpokenEntry): string | null => {
    if (entry.role !== "student") return null;
    if (entry.badge === "voice") return copy.studentVoiceTag;
    if (entry.badge === "text") return copy.studentTextTag;
    if (entry.badge === "quick") return entry.quickLabel || copy.studentQuickTag;
    return null;
  };

  return (
    <div
      data-testid="classroom-transcript"
      className={clsx("flex h-full min-h-0 flex-col gap-3", compact ? "p-3" : "")}
    >
      <p className="text-caption text-fg-tertiary">{copy.transcriptHint}</p>

      <div
        ref={scrollRef}
        className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto pr-1"
      >
        {entries.length === 0 && !recording ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 py-10 text-center text-fg-tertiary">
            <MessageSquareText size={22} aria-hidden="true" />
            <p className="max-w-[240px] text-caption">{copy.transcriptEmpty}</p>
          </div>
        ) : null}

        {entries.map((entry) => {
          const isStudent = entry.role === "student";
          const tag = badgeText(entry);
          return (
            <div
              key={entry.id}
              data-transcript-role={entry.role}
              data-transcript-badge={entry.badge}
              className={clsx(
                "grid max-w-[92%] gap-1",
                isStudent ? "self-end justify-items-end" : "self-start justify-items-start",
              )}
            >
              <div className="flex items-center gap-1.5 text-micro text-fg-tertiary">
                <span>{isStudent ? copy.answer : teacherName || copy.teacher}</span>
                {tag ? <Badge tone="accent">{tag}</Badge> : null}
              </div>
              <p
                className={clsx(
                  "rounded-md px-3 py-2 text-ui leading-relaxed",
                  isStudent
                    ? "bg-accent-soft text-accent-strong"
                    : "border border-line-subtle bg-surface-sunken text-fg-primary",
                )}
              >
                {entry.text}
              </p>
            </div>
          );
        })}

        {recording ? (
          <div
            data-testid="transcript-recognizing"
            role="status"
            aria-live="polite"
            className="grid max-w-[92%] self-end justify-items-end gap-1"
          >
            <div className="flex items-center gap-1.5 text-micro text-fg-tertiary">
              <Mic size={12} aria-hidden="true" />
              <Badge tone="accent">{copy.studentVoiceTag}</Badge>
            </div>
            <p className="rounded-md border border-dashed border-accent/40 bg-accent-soft/60 px-3 py-2 text-caption text-accent-strong">
              {liveTranscript?.trim() || copy.transcriptRecognizing}
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
