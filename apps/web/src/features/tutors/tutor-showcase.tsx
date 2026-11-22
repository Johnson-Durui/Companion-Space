import { useEffect, useRef, useState, type DragEvent } from "react";
import { Link } from "react-router";
import clsx from "clsx";
import type { InstantAction, TutorEmotion, TutorPose } from "@companion-space/avatar-engine/types";
import type { TutorVideoBoxHandle } from "@companion-space/avatar-engine/video-box";
import { tutorVideoCoordinator, type VideoPlaybackOwner } from "@companion-space/avatar-engine/video-coordinator";
import type { Character } from "../../app/api";
import { Button, Check, Play, Plus } from "../../ui";
import t from "../../locales/zh-CN.json";
import { TeacherPreview } from "../characters/teacher-preview";
import { useTutorSpeech } from "../voice/use-tutor-speech";

const copy = t.tutorsGallery;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export interface TutorShowcaseProps {
  character: Character;
  isCurrent: boolean;
  choosing?: boolean;
  headingLevel?: "h1" | "h2";
  showEditLink?: boolean;
  /** Increment when user actively selects a tile to trigger choreographed intro */
  introSeq?: number;
  /** Optional greeting response shown right after user clicks "就选 {name}" */
  chosenGreeting?: string;
  onChoose: (character: Character) => void;
}

export function TutorShowcase({
  character,
  isCurrent,
  choosing = false,
  headingLevel = "h1",
  showEditLink = true,
  introSeq = 0,
  chosenGreeting = "",
  onChoose,
}: TutorShowcaseProps) {
  const videoRef = useRef<TutorVideoBoxHandle>(null);
  const speech = useTutorSpeech();
  const [pose, setPose] = useState<TutorPose>("idle_companion");
  const [emotion, setEmotion] = useState<TutorEmotion>("warm");
  const [gen, setGen] = useState(1);
  const [introducing, setIntroducing] = useState(false);

  const quote = character.persona.catchphrases[0] || character.greeting || "";
  const styleDesc =
    copy.styleNotes[character.default_style_id as keyof typeof copy.styleNotes] ??
    t.learner.styles[character.default_style_id as keyof typeof t.learner.styles] ??
    "";

  // Choreographed showcase on tutor selection: greet -> lecturing + catchphrase audio -> praise -> idle
  useEffect(() => {
    if (introSeq === 0) return;
    let cancelled = false;
    const timers: number[] = [];

    const startGen = introSeq * 10 + 1;
    const t0 = window.setTimeout(() => {
      if (cancelled) return;
      setIntroducing(true);
      setPose("greeting");
      setEmotion("warm");
      setGen(startGen);
      videoRef.current?.triggerInstantAction("greet", startGen);
    }, 0);
    timers.push(t0);

    const t1 = window.setTimeout(() => {
      if (cancelled) return;
      setPose("lecturing");
      setGen(startGen + 1);
      if (quote) {
        void speech
          .speak({ characterId: character.id, text: quote })
          .finally(() => {
            if (cancelled) return;
            setPose("feedback_reaction");
            setEmotion("cheerful");
            setGen(startGen + 2);
            videoRef.current?.triggerInstantAction("praise_thumbs_up", startGen + 2);
            const t2 = window.setTimeout(() => {
              if (cancelled) return;
              setPose("idle_companion");
              setEmotion("warm");
              setGen(startGen + 3);
              setIntroducing(false);
            }, 1200);
            timers.push(t2);
          });
      } else {
        const t2 = window.setTimeout(() => {
          if (cancelled) return;
          setPose("idle_companion");
          setIntroducing(false);
        }, 1400);
        timers.push(t2);
      }
    }, 450);
    timers.push(t1);

    return () => {
      cancelled = true;
      timers.forEach((id) => window.clearTimeout(id));
      speech.stop();
      setIntroducing(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [character.id, introSeq]);

  function runDemo(nextPose: TutorPose, nextEmotion: TutorEmotion, action?: InstantAction) {
    setGen((prev) => {
      const next = prev + 1;
      setPose(nextPose);
      setEmotion(nextEmotion);
      if (action) {
        videoRef.current?.triggerInstantAction(action, next);
      }
      return next;
    });
  }

  function replayQuote() {
    if (!quote) return;
    setPose("lecturing");
    setGen((prev) => prev + 1);
    void speech.speak({ characterId: character.id, text: quote }).finally(() => {
      setPose("idle_companion");
    });
  }

  const HeadingTag = headingLevel;
  const isSpeaking = speech.speaking || introducing;

  return (
    <section
      data-theme={character.theme || "default"}
      data-testid="tutor-showcase"
      className="relative grid min-w-0 items-center gap-7 rounded-xl p-4 sm:p-6 md:grid-cols-[264px_1fr] md:gap-11"
      style={{
        backgroundImage:
          "radial-gradient(50% 48% at 16% 12%, color-mix(in srgb, var(--accent) 12%, transparent), transparent 72%)",
      }}
    >
      {/* Portrait Video Stage */}
      <div
        data-testid="teacher-stage"
        className="relative mx-auto aspect-[9/16] w-[220px] sm:w-[264px] shrink-0 overflow-hidden rounded-xl bg-surface-sunken shadow-3 ring-4 ring-surface-card"
      >
        <TeacherPreview
          key={character.id}
          character={character}
          pose={pose}
          emotion={emotion}
          gen={gen}
          videoRef={videoRef}
        />
        {isSpeaking ? (
          <span
            aria-live="polite"
            className="pointer-events-none absolute right-3 bottom-3 z-10 inline-flex items-center gap-1.5 rounded-full bg-scrim px-2.5 py-1 text-caption font-medium text-on-accent backdrop-blur-sm"
          >
            <span className="inline-flex h-2.5 items-end gap-0.5" aria-hidden="true">
              <span className="h-1.5 w-0.5 rounded-full bg-accent-on-dark" />
              <span className="h-2.5 w-0.5 rounded-full bg-accent-on-dark" />
              <span className="h-2 w-0.5 rounded-full bg-accent-on-dark" />
            </span>
            <span>{copy.introducing}</span>
          </span>
        ) : null}
      </div>

      {/* Info & Actions */}
      <div className="grid min-w-0 content-center gap-4">
        <div className="grid gap-1.5">
          {character.tagline ? (
            <div>
              <span className="inline-flex rounded-sm bg-accent-soft px-2.5 py-0.5 text-caption font-semibold text-accent-strong">
                {character.tagline}
              </span>
            </div>
          ) : null}
          <HeadingTag className="text-display font-semibold tracking-tight text-fg-primary">
            {character.name}
          </HeadingTag>
          <p className="text-body text-fg-secondary">{character.persona.relationship}</p>
        </div>

        {/* Representative quote bubble + play */}
        {quote ? (
          <div className="grid gap-1.5">
            <div className="flex max-w-[560px] items-center gap-3.5 rounded-tl-sm rounded-tr-xl rounded-br-xl rounded-bl-xl bg-surface-card px-4 py-3 text-body text-fg-primary shadow-2">
              <button
                type="button"
                aria-label={t.voice.preview}
                disabled={speech.loading}
                onClick={replayQuote}
                className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent-strong transition-transform duration-fast hover:scale-105 active:scale-95"
              >
                <Play size={16} aria-hidden="true" />
              </button>
              <span className="min-w-0 flex-1 break-words">{quote}</span>
            </div>
            {speech.unavailable ? (
              <p role="status" className="text-caption text-fg-tertiary">
                {t.speech.unavailable}
              </p>
            ) : null}
          </div>
        ) : null}

        {/* How they teach */}
        {styleDesc ? (
          <div className="grid max-w-[560px] gap-0.5 text-ui text-fg-secondary">
            <strong className="font-semibold text-fg-primary">{copy.howTeachTitle}</strong>
            <p>{styleDesc}</p>
          </div>
        ) : null}

        {/* 3 pose demo pills */}
        <div className="flex flex-wrap items-center gap-2 text-caption text-fg-tertiary">
          <span>{copy.tryReaction}</span>
          <button
            type="button"
            onClick={() => runDemo("lecturing", "warm")}
            className="inline-flex h-8 items-center rounded-full border border-line-default bg-surface-card px-3 text-caption font-medium text-fg-secondary transition-colors duration-fast hover:border-accent hover:text-fg-primary"
          >
            {copy.demoSpeak}
          </button>
          <button
            type="button"
            onClick={() => runDemo("feedback_reaction", "cheerful", "praise_thumbs_up")}
            className="inline-flex h-8 items-center rounded-full border border-line-default bg-surface-card px-3 text-caption font-medium text-fg-secondary transition-colors duration-fast hover:border-accent hover:text-fg-primary"
          >
            {copy.demoPraise}
          </button>
          <button
            type="button"
            onClick={() => runDemo("feedback_reaction", "warm", "gentle_encourage")}
            className="inline-flex h-8 items-center rounded-full border border-line-default bg-surface-card px-3 text-caption font-medium text-fg-secondary transition-colors duration-fast hover:border-accent hover:text-fg-primary"
          >
            {copy.demoComfort}
          </button>
        </div>

        {/* Chosen greeting response */}
        {chosenGreeting ? (
          <p
            role="status"
            data-testid="tutor-greeting-response"
            className="max-w-[560px] rounded-md border border-accent/25 bg-accent-soft/60 px-3.5 py-2 text-ui font-medium text-accent-strong"
          >
            {character.name}：{chosenGreeting}
          </p>
        ) : null}

        {/* Primary CTA + Secondary edit link */}
        <div className="flex flex-wrap items-center gap-3 pt-1">
          {isCurrent ? (
            <span
              role="status"
              data-testid="current-tutor-badge"
              className="inline-flex min-h-11 items-center gap-2 rounded-md border border-accent/30 bg-accent-soft px-5 text-ui font-semibold text-accent-strong"
            >
              <Check size={16} aria-hidden="true" />
              <span>{copy.currentTeacher}</span>
            </span>
          ) : (
            <Button
              variant="primary"
              size="lg"
              pending={choosing}
              onClick={() => onChoose(character)}
            >
              {copy.chooseMe.replace("{name}", character.name)}
            </Button>
          )}

          {showEditLink ? (
            <Link
              to={`/tutors/${encodeURIComponent(character.id)}?tab=persona`}
              className="inline-flex min-h-11 items-center rounded-md px-4 text-ui font-medium text-fg-secondary transition-colors duration-fast hover:bg-surface-sunken hover:text-fg-primary"
            >
              {copy.editPersona}
            </Link>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function TutorTileCard({
  entry,
  selected,
  isCurrent,
  onSelect,
}: {
  entry: Character;
  selected: boolean;
  isCurrent: boolean;
  onSelect: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const idleUrl = entry.video_avatar?.loop_pack?.clips?.idle_breathe ?? "";
  const canHoverPlay = Boolean(idleUrl) && !prefersReducedMotion();

  useEffect(() => {
    if (!hovered || !canHoverPlay) return;
    const owner: VideoPlaybackOwner = {
      pause: () => videoRef.current?.pause(),
      resume: () => {
        void videoRef.current?.play().catch(() => undefined);
      },
      isVisible: () => true,
    };
    tutorVideoCoordinator.claim(owner);
    const el = videoRef.current;
    if (el) {
      void el.play().catch(() => undefined);
    }
    return () => {
      el?.pause();
      tutorVideoCoordinator.release(owner);
    };
  }, [hovered, canHoverPlay]);

  return (
    <button
      type="button"
      data-theme={entry.theme || "default"}
      data-testid={`tutor-tile-${entry.id}`}
      aria-pressed={selected}
      onClick={onSelect}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setHovered(true)}
      onBlur={() => setHovered(false)}
      className="group grid min-w-0 content-start gap-2 text-left"
    >
      <div
        className={clsx(
          "relative aspect-[9/13] w-full overflow-hidden rounded-lg bg-surface-sunken shadow-1 transition-[transform,box-shadow,outline-color] duration-base ease-out",
          "group-hover:-translate-y-1 group-hover:shadow-2",
          selected
            ? "outline-[3px] outline-offset-[3px] outline-accent"
            : "outline-[3px] outline-offset-[3px] outline-transparent group-hover:outline-accent/40",
        )}
      >
        <img
          src={entry.appearance.src}
          alt=""
          decoding="async"
          loading="lazy"
          className="h-full w-full object-cover object-[center_16%]"
        />
        {hovered && canHoverPlay ? (
          <video
            ref={videoRef}
            src={idleUrl}
            muted
            loop
            playsInline
            aria-hidden="true"
            className="absolute inset-0 h-full w-full object-cover object-[center_16%]"
          />
        ) : null}
        {isCurrent ? (
          <span className="absolute top-2 left-2 rounded-sm bg-accent px-2 py-0.5 text-[11px] leading-4 font-semibold text-on-accent shadow-1">
            {copy.currentTeacher}
          </span>
        ) : null}
      </div>
      <div className="grid min-w-0 gap-0.5 px-0.5">
        <strong className="truncate text-body font-semibold text-fg-primary">{entry.name}</strong>
        <small className="flex items-center gap-1.5 truncate text-caption text-fg-tertiary">
          <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full bg-accent" />
          <span className="truncate">{entry.tagline || t.learner.styles[entry.default_style_id as keyof typeof t.learner.styles] || ""}</span>
        </small>
      </div>
    </button>
  );
}

export interface TutorRosterProps {
  characters: Character[];
  selectedId: string;
  currentId?: string | null;
  onSelect: (character: Character) => void;
  showImportTile?: boolean;
  onOpenImport?: () => void;
  onDropImportFile?: (file: File) => void;
}

export function TutorRoster({
  characters,
  selectedId,
  currentId,
  onSelect,
  showImportTile = true,
  onOpenImport,
  onDropImportFile,
}: TutorRosterProps) {
  const [dragging, setDragging] = useState(false);

  function handleDragOver(event: DragEvent<HTMLButtonElement>) {
    event.preventDefault();
    setDragging(true);
  }

  function handleDragLeave(event: DragEvent<HTMLButtonElement>) {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setDragging(false);
    }
  }

  function handleDrop(event: DragEvent<HTMLButtonElement>) {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files[0];
    if (file) onDropImportFile?.(file);
  }

  return (
    <section aria-label={copy.rosterLabel} className="grid min-w-0 gap-3">
      <div className="grid grid-cols-2 gap-3.5 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-7">
        {characters.map((entry) => (
          <TutorTileCard
            key={entry.id}
            entry={entry}
            selected={entry.id === selectedId}
            isCurrent={entry.id === currentId}
            onSelect={() => onSelect(entry)}
          />
        ))}

        {showImportTile ? (
          <button
            type="button"
            data-testid="import-tutor-tile"
            data-dragging={dragging || undefined}
            onClick={onOpenImport}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            className="group grid min-w-0 content-start gap-2 text-left"
          >
            <div
              className={clsx(
                "grid aspect-[9/13] w-full place-items-center rounded-lg border-2 border-dashed transition-colors duration-fast",
                dragging
                  ? "border-accent bg-accent-soft/60 text-accent-strong"
                  : "border-line-default bg-transparent text-fg-tertiary group-hover:border-accent group-hover:text-accent-strong",
              )}
            >
              <Plus size={28} aria-hidden="true" />
            </div>
            <div className="grid min-w-0 gap-0.5 px-0.5">
              <strong className="truncate text-body font-semibold text-fg-primary">
                {copy.importTile}
              </strong>
              <small className="truncate text-caption text-fg-tertiary">{copy.importSub}</small>
            </div>
          </button>
        ) : null}
      </div>
    </section>
  );
}
