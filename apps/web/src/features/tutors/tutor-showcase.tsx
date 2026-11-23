import { useEffect, useRef, useState, type DragEvent } from "react";
import { Link } from "react-router";
import clsx from "clsx";
import type { InstantAction, TutorEmotion, TutorPose } from "@companion-space/avatar-engine/types";
import type { TutorVideoBoxHandle } from "@companion-space/avatar-engine/video-box";
import { tutorVideoCoordinator, type VideoPlaybackOwner } from "@companion-space/avatar-engine/video-coordinator";
import type { Character } from "../../app/api";
import {
  Award,
  Badge,
  Button,
  Check,
  GraduationCap,
  Heart,
  Play,
  Plus,
  Sparkles,
  Volume2,
} from "../../ui";
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
  /** Increment when user clicks "就选 {name}" so showcase speaks chosenGreeting in sync */
  chosenSpeakSeq?: number;
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
  chosenSpeakSeq = 0,
  onChoose,
}: TutorShowcaseProps) {
  const videoRef = useRef<TutorVideoBoxHandle>(null);
  const speech = useTutorSpeech();
  const [pose, setPose] = useState<TutorPose>("idle_companion");
  const [emotion, setEmotion] = useState<TutorEmotion>("warm");
  const [gen, setGen] = useState(1);
  const genRef = useRef(1);
  const choreoRef = useRef(0);

  const [activeDemo, setActiveDemo] = useState<"speak" | "praise" | "comfort" | null>(null);

  const bumpGen = () => {
    genRef.current += 1;
    setGen(genRef.current);
    return genRef.current;
  };

  const quote = character.persona.catchphrases[0] || character.greeting || "";
  const styleLabel =
    t.learner.styles[character.default_style_id as keyof typeof t.learner.styles] ?? "";
  const styleDesc =
    copy.styleNotes[character.default_style_id as keyof typeof copy.styleNotes] ??
    styleLabel;
  const hasLoopPack = Boolean(character.video_avatar?.loop_pack?.clips?.idle_breathe);
  const traits = (character.persona.traits ?? []).slice(0, 5);

  // Choreographed showcase on tutor selection:
  // Keep closed-mouth attentive nod while TTS synthesizes; switch to lecturing ONLY once audio is audible!
  useEffect(() => {
    if (introSeq === 0) return;
    let cancelled = false;
    const timers: number[] = [];
    const myChoreo = ++choreoRef.current;
    const isCurrentChoreo = () => !cancelled && choreoRef.current === myChoreo;

    const finishReaction = () => {
      if (!isCurrentChoreo()) return;
      const g = bumpGen();
      setPose("feedback_reaction");
      setEmotion("cheerful");
      videoRef.current?.triggerInstantAction("praise_thumbs_up", g);
      const tEnd = window.setTimeout(() => {
        if (!isCurrentChoreo()) return;
        bumpGen();
        setPose("idle_companion");
        setEmotion("warm");
      }, 1200);
      timers.push(tEnd);
    };

    const t0 = window.setTimeout(() => {
      if (!isCurrentChoreo()) return;
      const g0 = bumpGen();
      setPose("listening_empathy");
      setEmotion("warm");
      videoRef.current?.triggerInstantAction("empathy_nod", g0);

      if (quote) {
        void speech
          .speak(
            { characterId: character.id, text: quote },
            {
              onStart: () => {
                if (!isCurrentChoreo()) return;
                bumpGen();
                setPose("lecturing");
                setEmotion("warm");
              },
              onEnd: () => {
                finishReaction();
              },
            },
          )
          .then((played) => {
            if (!isCurrentChoreo() || played) return;
            bumpGen();
            setPose("idle_companion");
            setEmotion("warm");
          });
      } else {
        const tIdle = window.setTimeout(() => {
          if (!isCurrentChoreo()) return;
          bumpGen();
          setPose("idle_companion");
        }, 1200);
        timers.push(tIdle);
      }
    }, 0);
    timers.push(t0);

    return () => {
      cancelled = true;
      timers.forEach((id) => window.clearTimeout(id));
      if (choreoRef.current === myChoreo) {
        speech.stop();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [character.id, introSeq]);

  // Synchronized greeting speech when user clicks "就选 {name}"
  useEffect(() => {
    if (chosenSpeakSeq === 0 || !chosenGreeting) return;
    let cancelled = false;
    const myChoreo = ++choreoRef.current;
    const isCurrentChoreo = () => !cancelled && choreoRef.current === myChoreo;

    const t0 = window.setTimeout(() => {
      if (!isCurrentChoreo()) return;
      bumpGen();
      setPose("listening_empathy");
      setEmotion("warm");
      void speech
        .speak(
          { characterId: character.id, text: chosenGreeting },
          {
            onStart: () => {
              if (!isCurrentChoreo()) return;
              bumpGen();
              setPose("lecturing");
              setEmotion("cheerful");
            },
            onEnd: () => {
              if (!isCurrentChoreo()) return;
              bumpGen();
              setPose("idle_companion");
              setEmotion("warm");
            },
          },
        )
        .then((played) => {
          if (!isCurrentChoreo() || played) return;
          bumpGen();
          setPose("idle_companion");
          setEmotion("warm");
        });
    }, 0);

    return () => {
      cancelled = true;
      window.clearTimeout(t0);
      if (choreoRef.current === myChoreo) {
        speech.stop();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [character.id, chosenSpeakSeq, chosenGreeting]);

  function runDemo(
    demoKey: "speak" | "praise" | "comfort",
    nextPose: TutorPose,
    nextEmotion: TutorEmotion,
    action?: InstantAction,
  ) {
    setActiveDemo(demoKey);
    choreoRef.current += 1;
    speech.stop();
    const next = bumpGen();
    setPose(nextPose);
    setEmotion(nextEmotion);
    if (action) {
      videoRef.current?.triggerInstantAction(action, next);
    }
  }

  function replayQuote() {
    if (!quote) return;
    if (speech.speaking) {
      choreoRef.current += 1;
      speech.stop();
      bumpGen();
      setPose("idle_companion");
      return;
    }
    const myChoreo = ++choreoRef.current;
    const isCurrentChoreo = () => choreoRef.current === myChoreo;
    bumpGen();
    setPose("idle_companion");
    void speech
      .speak(
        { characterId: character.id, text: quote },
        {
          onStart: () => {
            if (!isCurrentChoreo()) return;
            bumpGen();
            setPose("lecturing");
            setEmotion("warm");
          },
          onEnd: () => {
            if (!isCurrentChoreo()) return;
            bumpGen();
            setPose("idle_companion");
          },
        },
      )
      .then((played) => {
        if (!isCurrentChoreo() || played) return;
        bumpGen();
        setPose("idle_companion");
      });
  }

  const HeadingTag = headingLevel;
  const isSpeaking = speech.speaking;

  return (
    <section
      data-theme={character.theme || "default"}
      data-testid="tutor-showcase"
      className="cs-hero-stage cs-enter-1 relative grid min-w-0 items-center gap-6 rounded-xl p-4 sm:p-5 md:grid-cols-[232px_1fr] md:gap-9 md:px-7 md:py-5"
    >
      {/* Decorative studio orbital arcs & coordinate markings */}
      <svg
        aria-hidden="true"
        viewBox="0 0 480 320"
        fill="none"
        className="pointer-events-none absolute -top-8 -right-10 hidden h-[340px] w-[480px] opacity-65 lg:block"
      >
        <circle cx="348" cy="158" r="136" stroke="var(--accent)" strokeOpacity="0.2" strokeDasharray="5 7" />
        <circle cx="348" cy="158" r="92" stroke="var(--accent)" strokeOpacity="0.26" />
        <circle cx="348" cy="158" r="48" stroke="var(--border-default)" strokeOpacity="0.55" strokeDasharray="2 5" />
        <path d="M180 248 C252 178 302 204 398 78" stroke="var(--accent)" strokeOpacity="0.26" strokeDasharray="3 5" />
        <circle cx="398" cy="78" r="4" fill="var(--accent)" fillOpacity="0.65" />
        <circle cx="256" cy="96" r="3" fill="var(--accent)" fillOpacity="0.48" />
      </svg>

      {/* Portrait Video Stage with Aura Halo */}
      <div className="relative z-10 mx-auto shrink-0">
        <div aria-hidden="true" className="cs-stage-aura" />
        <div
          data-testid="teacher-stage"
          className="relative aspect-[9/16] w-[208px] sm:w-[228px] overflow-hidden rounded-xl bg-surface-sunken shadow-3 ring-4 ring-surface-card"
        >
          <TeacherPreview
            key={character.id}
            character={character}
            pose={pose}
            emotion={emotion}
            gen={gen}
            videoRef={videoRef}
          />
          <span className="pointer-events-none absolute top-3 left-3 z-10 inline-flex items-center gap-1.5 rounded-full bg-scrim px-2.5 py-1 text-[11px] font-medium text-on-accent backdrop-blur-sm">
            <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-accent-on-dark" />
            <span>{hasLoopPack ? t.richUi.tutorMotionReady : t.richUi.tutorCustomAvatar}</span>
          </span>
          {isSpeaking ? (
            <span
              aria-live="polite"
              className="pointer-events-none absolute right-3 bottom-3 z-10 inline-flex items-center gap-1.5 rounded-full bg-scrim px-2.5 py-1 text-caption font-medium text-on-accent backdrop-blur-sm"
            >
              <span className="inline-flex h-2.5 items-end gap-0.5" aria-hidden="true">
                <span className="cs-eq-bar h-1.5 w-0.5 rounded-full bg-accent-on-dark" />
                <span className="cs-eq-bar h-2.5 w-0.5 rounded-full bg-accent-on-dark" />
                <span className="cs-eq-bar h-2 w-0.5 rounded-full bg-accent-on-dark" />
              </span>
              <span>{copy.introducing}</span>
            </span>
          ) : null}
        </div>
      </div>

      {/* Info & Actions */}
      <div className="relative z-10 grid min-w-0 content-center gap-3.5">
        <div className="grid gap-2">
          <div className="flex flex-wrap items-center gap-2">
            {character.tagline ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-accent-soft px-3 py-0.5 text-caption font-semibold text-accent-strong">
                <Sparkles size={12} aria-hidden="true" />
                <span>{character.tagline}</span>
              </span>
            ) : null}
            {styleLabel ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-line-subtle bg-surface-card/85 px-2.5 py-0.5 text-caption font-medium text-fg-secondary">
                <GraduationCap size={12} aria-hidden="true" />
                <span>{styleLabel}</span>
              </span>
            ) : null}
            <span className="inline-flex items-center gap-1 rounded-full border border-line-subtle bg-surface-card/85 px-2.5 py-0.5 text-caption font-medium text-fg-secondary">
              <Volume2 size={12} aria-hidden="true" />
              <span>{t.richUi.tutorVoiceTag}</span>
            </span>
          </div>

          <HeadingTag className="text-display font-semibold tracking-tight text-fg-primary">
            {character.name}
          </HeadingTag>
          <p className="text-body text-fg-secondary">{character.persona.relationship}</p>

          {traits.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
              {traits.map((trait) => (
                <span
                  key={trait}
                  className="inline-flex rounded-sm border border-line-subtle/90 bg-surface-card/75 px-2 py-0.5 text-caption text-fg-secondary"
                >
                  #{trait}
                </span>
              ))}
            </div>
          ) : null}
        </div>

        {/* Representative quote bubble + play */}
        {quote ? (
          <div className="grid gap-1.5">
            <div className="flex max-w-[580px] items-center gap-3.5 rounded-tl-sm rounded-tr-xl rounded-br-xl rounded-bl-xl border border-line-subtle/90 bg-surface-card/95 px-4 py-3 text-body text-fg-primary shadow-2 backdrop-blur-sm">
              <button
                type="button"
                aria-label={t.voice.preview}
                disabled={speech.loading}
                onClick={replayQuote}
                className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent text-on-accent shadow-1 transition-transform duration-fast hover:scale-105 hover:bg-accent-strong active:scale-95"
              >
                <Play size={16} aria-hidden="true" />
              </button>
              <span className="min-w-0 flex-1 break-words font-medium">{quote}</span>
              <span aria-hidden="true" className="hidden sm:inline-flex h-4 items-end gap-0.5 px-1 opacity-70">
                <span className={clsx("w-0.5 rounded-full bg-accent", isSpeaking ? "cs-eq-bar h-3" : "h-1.5")} />
                <span className={clsx("w-0.5 rounded-full bg-accent", isSpeaking ? "cs-eq-bar h-4" : "h-3")} />
                <span className={clsx("w-0.5 rounded-full bg-accent", isSpeaking ? "cs-eq-bar h-2.5" : "h-2")} />
                <span className={clsx("w-0.5 rounded-full bg-accent", isSpeaking ? "cs-eq-bar h-3.5" : "h-1.5")} />
              </span>
            </div>
            {speech.unavailable ? (
              <p role="status" className="text-caption text-fg-tertiary">
                {t.speech.unavailable}
              </p>
            ) : null}
          </div>
        ) : null}

        {/* Studio Panel: How they teach + 3 pose reaction pills */}
        <div className="grid max-w-[580px] gap-3 rounded-lg border border-line-subtle/90 bg-surface-card/82 p-3.5 shadow-1 backdrop-blur-sm">
          {styleDesc ? (
            <div className="grid gap-0.5 text-ui text-fg-secondary">
              <strong className="font-semibold text-fg-primary">{copy.howTeachTitle}</strong>
              <p>{styleDesc}</p>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-2 border-t border-line-subtle/80 pt-2.5 text-caption text-fg-tertiary">
            <span className="font-medium text-fg-secondary">{copy.tryReaction}</span>
            <button
              type="button"
              onClick={() => runDemo("speak", "lecturing", "warm")}
              className={clsx(
                "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-caption font-medium transition-colors duration-fast",
                activeDemo === "speak"
                  ? "border-accent bg-accent-soft text-accent-strong"
                  : "border-line-default bg-surface-card text-fg-secondary hover:border-accent hover:text-fg-primary",
              )}
            >
              <Sparkles size={12} aria-hidden="true" />
              <span>{copy.demoSpeak}</span>
            </button>
            <button
              type="button"
              onClick={() => runDemo("praise", "feedback_reaction", "cheerful", "praise_thumbs_up")}
              className={clsx(
                "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-caption font-medium transition-colors duration-fast",
                activeDemo === "praise"
                  ? "border-accent bg-accent-soft text-accent-strong"
                  : "border-line-default bg-surface-card text-fg-secondary hover:border-accent hover:text-fg-primary",
              )}
            >
              <Award size={12} aria-hidden="true" />
              <span>{copy.demoPraise}</span>
            </button>
            <button
              type="button"
              onClick={() => runDemo("comfort", "feedback_reaction", "warm", "gentle_encourage")}
              className={clsx(
                "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-caption font-medium transition-colors duration-fast",
                activeDemo === "comfort"
                  ? "border-accent bg-accent-soft text-accent-strong"
                  : "border-line-default bg-surface-card text-fg-secondary hover:border-accent hover:text-fg-primary",
              )}
            >
              <Heart size={12} aria-hidden="true" />
              <span>{copy.demoComfort}</span>
            </button>
          </div>
        </div>

        {/* Chosen greeting response */}
        {chosenGreeting ? (
          <p
            role="status"
            data-testid="tutor-greeting-response"
            className="max-w-[580px] rounded-md border border-accent/25 bg-accent-soft/75 px-3.5 py-2 text-ui font-medium text-accent-strong"
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
              className="inline-flex min-h-11 items-center gap-2 rounded-md border border-accent/35 bg-accent-soft px-5 text-ui font-semibold text-accent-strong shadow-1"
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
              className="inline-flex min-h-11 items-center rounded-md border border-line-subtle bg-surface-card/85 px-4 text-ui font-medium text-fg-secondary shadow-1 transition-colors duration-fast hover:bg-surface-sunken hover:text-fg-primary"
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
  index,
  selected,
  isCurrent,
  onSelect,
}: {
  entry: Character;
  index: number;
  selected: boolean;
  isCurrent: boolean;
  onSelect: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const idleUrl = entry.video_avatar?.loop_pack?.clips?.idle_breathe ?? "";
  const canHoverPlay = Boolean(idleUrl) && !prefersReducedMotion();
  const styleLabel =
    t.learner.styles[entry.default_style_id as keyof typeof t.learner.styles] ?? "";

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
      className="group grid min-w-0 content-start gap-2.5 text-left"
    >
      <div
        className={clsx(
          "relative aspect-[9/13] w-full overflow-hidden rounded-lg bg-surface-sunken shadow-1 transition-[transform,box-shadow,outline-color] duration-base ease-out",
          "group-hover:-translate-y-1 group-hover:shadow-2",
          selected
            ? "outline-[3px] outline-offset-[3px] outline-accent shadow-2"
            : "outline-[3px] outline-offset-[3px] outline-transparent group-hover:outline-accent/45",
        )}
      >
        <img
          src={entry.appearance.src}
          alt=""
          decoding="async"
          loading="lazy"
          className="h-full w-full object-cover object-[center_16%] transition-transform duration-slow ease-out group-hover:scale-[1.03]"
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
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-scrim via-scrim/35 to-transparent"
        />
        <span
          aria-hidden="true"
          className="pointer-events-none absolute top-2 right-2 rounded-sm bg-scrim/80 px-1.5 py-0.5 font-mono text-[10px] leading-4 text-on-accent backdrop-blur-xs"
        >
          {String(index + 1).padStart(2, "0")}
        </span>
        {isCurrent ? (
          <span className="absolute top-2 left-2 rounded-sm bg-accent px-2 py-0.5 text-[11px] leading-4 font-semibold text-on-accent shadow-1">
            {copy.currentTeacher}
          </span>
        ) : null}
        {styleLabel ? (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute bottom-2 left-2 rounded-sm bg-scrim/80 px-2 py-0.5 text-[10px] leading-4 font-medium text-on-accent backdrop-blur-xs"
          >
            {styleLabel}
          </span>
        ) : null}
      </div>
      <div className="grid min-w-0 gap-0.5 px-0.5">
        <strong className="truncate text-body font-semibold text-fg-primary">{entry.name}</strong>
        <small className="flex items-center gap-1.5 truncate text-caption text-fg-tertiary">
          <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full bg-accent" />
          <span className="truncate">{entry.tagline || styleLabel}</span>
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
    <section aria-label={copy.rosterLabel} className="cs-enter-2 grid min-w-0 gap-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-ui font-semibold text-fg-primary">{t.richUi.tutorRosterTitle}</span>
          <Badge tone="neutral">
            {t.richUi.tutorRosterMeta.replace("{count}", String(characters.length))}
          </Badge>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3.5 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-7">
        {characters.map((entry, index) => (
          <TutorTileCard
            key={entry.id}
            entry={entry}
            index={index}
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
            className="group grid min-w-0 content-start gap-2.5 text-left"
          >
            <div
              className={clsx(
                "grid aspect-[9/13] w-full place-items-center rounded-lg border-2 border-dashed p-3 transition-[border-color,background-color,transform] duration-fast group-hover:-translate-y-1",
                dragging
                  ? "border-accent bg-accent-soft/60 text-accent-strong"
                  : "border-line-default bg-surface-card/65 text-fg-tertiary group-hover:border-accent group-hover:bg-accent-soft/35 group-hover:text-accent-strong",
              )}
            >
              <span className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-accent-soft/80 text-accent-strong shadow-1">
                <Plus size={24} aria-hidden="true" />
              </span>
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
