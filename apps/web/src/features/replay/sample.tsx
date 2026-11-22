import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { LessonText } from "@companion-space/board";
import {
  api,
  bodyOf,
  charactersKey,
  fetchCharacters,
  fetchSettings,
  settingsKey,
  type Character,
} from "../../app/api";
import { Loading, Problem } from "../../app/ui";
import { ArrowLeft, Badge, Button, ChoiceCardGroup, RefreshCw } from "../../ui";
import { restoreClassroom } from "../classroom/lesson-state";
import { captionDelay } from "../classroom/timeline";
import t from "../../locales/zh-CN.json";
import { ReplayStage } from "./replay-stage";
import { fetchSample, sampleKey, type Sample } from "./sample-api";

const copy = t.sample;

function SampleRecording({
  sample,
  teacher,
}: {
  sample: Sample;
  teacher?: Character | null;
}) {
  const events = useMemo(() => [...sample.events].sort((a, b) => a.seq - b.seq), [sample.events]);
  const [position, setPosition] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [choice, setChoice] = useState<string>();
  const [browserTts, setBrowserTts] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const row = events[position - 1];
  const finished = position >= events.length;
  const question = row?.type === "ask";
  const state = useMemo(() => restoreClassroom(events, row?.seq ?? 0), [events, row?.seq]);
  const options = question ? sample.branches[String(row.seq)] : undefined;
  const advancing = playing && !finished && !question;
  const feedback = choice ? options?.[choice] : undefined;

  // D11: Synthesize sample say lines via read-only /api/v2/tts/preview when online;
  // fall back gracefully to browser speechSynthesis + timed dwell when offline/unavailable.
  useEffect(() => {
    if (!advancing) {
      audioRef.current?.pause();
      if ("speechSynthesis" in window) window.speechSynthesis.cancel();
      return;
    }

    const isSay = row?.type === "say";
    const text = isSay ? String(row.data.text ?? "").trim() : "";
    const dwell = isSay
      ? Math.round(captionDelay(text, teacher?.voice.rate) / speed)
      : Math.round(200 / speed);

    if (!isSay || !text || !teacher) {
      const timer = window.setTimeout(() => setPosition((idx) => idx + 1), dwell);
      return () => window.clearTimeout(timer);
    }

    let cancelled = false;
    let fallbackTimer = 0;

    const runFallback = () => {
      if (cancelled) return;
      setBrowserTts(true);
      setSpeaking(true);
      if ("speechSynthesis" in window) {
        try {
          const utterance = new SpeechSynthesisUtterance(text);
          utterance.lang = "zh-CN";
          utterance.rate = Math.min(2, Math.max(0.5, (teacher.voice.rate ?? 1) * speed));
          window.speechSynthesis.cancel();
          window.speechSynthesis.speak(utterance);
        } catch {
          // Ignore browser speech synthesis failures in headless environments
        }
      }
      fallbackTimer = window.setTimeout(() => {
        if (!cancelled) {
          setSpeaking(false);
          setPosition((idx) => idx + 1);
        }
      }, dwell);
    };

    const controller = new AbortController();
    void (async () => {
      try {
        const result = bodyOf(
          await api.POST("/api/v2/tts/preview", {
            body: { character_id: teacher.id, text: text.slice(0, 240) },
            signal: controller.signal,
          }),
        );
        if (cancelled) return;
        if (result.kind === "audio" && result.audio_b64) {
          setBrowserTts(false);
          const audio = new Audio(`data:${result.content_type ?? "audio/mpeg"};base64,${result.audio_b64}`);
          audio.playbackRate = speed;
          audioRef.current = audio;
          setSpeaking(true);
          const finish = () => {
            if (cancelled) return;
            window.clearTimeout(fallbackTimer);
            setSpeaking(false);
            setPosition((idx) => idx + 1);
          };
          audio.onended = finish;
          audio.onerror = () => runFallback();
          fallbackTimer = window.setTimeout(finish, Math.max(dwell + 4000, 12_000));
          await audio.play().catch(() => runFallback());
          return;
        }
        runFallback();
      } catch {
        runFallback();
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
      window.clearTimeout(fallbackTimer);
      if (audioRef.current) {
        audioRef.current.onended = null;
        audioRef.current.onerror = null;
        audioRef.current.pause();
        audioRef.current = null;
      }
      if ("speechSynthesis" in window) window.speechSynthesis.cancel();
      setSpeaking(false);
    };
  }, [advancing, row, speed, teacher]);

  function continueLesson() {
    const answerBeat =
      feedback && row
        ? events.findIndex(
            (event, index) => index >= position && event.type === "beat.end" && event.gen > row.gen,
          )
        : -1;
    setPosition(answerBeat >= 0 ? answerBeat + 1 : position + 1);
    setChoice(undefined);
    setPlaying(true);
  }

  // Ended -> Light Focus-style Recap container (§5.8)
  if (finished) {
    return (
      <div className="min-h-screen bg-surface-page text-fg-primary">
        <header className="sticky top-0 z-sticky border-b border-line-subtle bg-surface-card/90 backdrop-blur-xs">
          <div className="mx-auto flex h-12 max-w-[880px] items-center justify-between gap-3 px-4">
            <Link
              to="/welcome"
              className="inline-flex min-h-9 items-center gap-1.5 rounded-md px-2 py-1 text-caption font-medium text-fg-secondary hover:bg-surface-sunken hover:text-fg-primary"
            >
              <ArrowLeft size={15} aria-hidden="true" />
              <span>{t.welcome.heading}</span>
            </Link>
            <Badge tone="neutral" data-testid="sample-prerecorded-badge">
              {t.classroom.sampleBadge}
            </Badge>
          </div>
        </header>
        <main id="main" className="mx-auto grid max-w-[880px] gap-6 px-4 py-8">
          <div className="grid gap-1.5">
            <h1 className="text-display font-semibold text-fg-primary">{sample.title}</h1>
            <p className="text-caption text-fg-secondary">
              {copy.recording} · {sample.model} · {sample.recorded_at}
            </p>
          </div>
          <section className="grid gap-3 rounded-lg border border-line-subtle bg-surface-card p-6 shadow-1">
            <h2 className="text-title font-semibold text-fg-primary">{t.classroom.recap}</h2>
            {sample.recap?.summary ? <LessonText source={sample.recap.summary} /> : null}
          </section>
          <div className="flex flex-wrap items-center gap-3">
            <Link
              to="/settings#models"
              className="inline-flex min-h-11 items-center justify-center rounded-md bg-accent px-5 text-ui font-medium text-on-accent hover:bg-accent-strong"
            >
              {t.classroom.sampleConnectCta}
            </Link>
            <Button
              variant="secondary"
              leftIcon={<RefreshCw size={15} />}
              onClick={() => {
                setPosition(0);
                setChoice(undefined);
                setPlaying(true);
              }}
            >
              {copy.restart}
            </Button>
          </div>
        </main>
      </div>
    );
  }

  const tray = question ? (
    <section
      data-testid="answer-tray"
      aria-label={t.classroom.question}
      className="cs-stage-tray cs-tray-enter"
    >
      <div className="grid gap-1.5 border-b border-line-subtle px-5 py-3.5">
        <span className="text-caption font-semibold text-accent-strong">{t.classroom.question}</span>
        {state.ask?.widget ? (
          <div className="text-body font-medium text-fg-primary [&>p]:m-0">
            <LessonText source={state.ask.widget.stem} />
          </div>
        ) : null}
      </div>

      <div className="overflow-y-auto px-5 py-3">
        {options && !feedback ? (
          <ChoiceCardGroup
            options={state.ask?.widget?.options ?? []}
            mode="single"
            value={choice ?? ""}
            label={t.classroom.question}
            onChange={(next) => setChoice(Array.isArray(next) ? next[0] : next)}
          />
        ) : (
          <div data-testid="sample-feedback" aria-live="polite" className="grid gap-2 text-ui text-fg-primary">
            {feedback?.map((line, index) => (
              <LessonText key={index} source={line} />
            ))}
          </div>
        )}
      </div>

      {!options || feedback ? (
        <div className="flex items-center justify-between gap-2 border-t border-line-subtle bg-surface-card px-5 py-3">
          <Button variant="primary" onClick={continueLesson}>
            {copy.continue}
          </Button>
        </div>
      ) : null}
    </section>
  ) : null;

  return (
    <ReplayStage
      title={sample.title}
      backTo="/welcome"
      backLabel={t.welcome.heading}
      events={events}
      position={position}
      playing={playing}
      speed={speed}
      speaking={speaking}
      teacher={teacher}
      disablePlay={question}
      tray={tray}
      topbarBadges={
        <>
          <Badge tone="neutral" data-testid="sample-prerecorded-badge">
            {t.classroom.sampleBadge}
          </Badge>
          {browserTts ? (
            <Badge tone="warn" data-testid="sample-browser-tts-badge">
              {t.classroom.browserTtsBadge}
            </Badge>
          ) : null}
        </>
      }
      dockExtra={
        <Link
          to="/settings#models"
          className="hidden min-h-11 items-center rounded-md border border-line-subtle bg-surface-card px-3 text-caption font-medium text-fg-primary hover:bg-surface-sunken lg:inline-flex"
        >
          {copy.connect}
        </Link>
      }
      onTogglePlay={() => {
        if (finished) {
          setPosition(0);
          setChoice(undefined);
          setPlaying(true);
        } else {
          setPlaying((prev) => !prev);
        }
      }}
      onSeekPosition={(nextIdx) => {
        setPlaying(false);
        setChoice(undefined);
        setPosition(nextIdx);
      }}
      onSpeedChange={setSpeed}
    />
  );
}

export default function SampleLesson() {
  const sample = useQuery({ queryKey: sampleKey, queryFn: fetchSample, staleTime: Infinity });
  const settings = useQuery({ queryKey: settingsKey, queryFn: fetchSettings, staleTime: 60_000 });
  const roster = useQuery({ queryKey: charactersKey, queryFn: fetchCharacters, staleTime: 60_000 });
  const teacher =
    roster.data?.find((entry) => entry.id === settings.data?.default_character_id) ??
    roster.data?.[0] ??
    null;

  if (sample.isPending) {
    return (
      <main id="main" className="mx-auto max-w-[640px] p-8">
        <h1 className="sr-only">{t.app.titles.sample}</h1>
        <Loading />
      </main>
    );
  }
  if (sample.isError) {
    return (
      <main id="main" className="mx-auto max-w-[640px] p-8">
        <h1 className="sr-only">{t.app.titles.sample}</h1>
        <Problem error={sample.error} onRetry={() => void sample.refetch()} />
      </main>
    );
  }
  if (!sample.data) {
    return (
      <main id="main" className="mx-auto max-w-[640px] p-8">
        <h1>{copy.open}</h1>
        <p className="notice">{copy.unavailable}</p>
      </main>
    );
  }
  return <SampleRecording sample={sample.data} teacher={teacher} />;
}
