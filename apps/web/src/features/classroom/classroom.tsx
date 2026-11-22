import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router";
import {
  IDLE_COMPANION_MS,
  quickActionToInstantAction,
  verdictToInstantAction,
} from "@companion-space/avatar-engine/choreographer";
import type {
  DecodedSpeechChunk,
  InstantAction,
  VideoAvatarTier,
  VideoDriverDegradedCode,
} from "@companion-space/avatar-engine/types";
import { TutorVideoBox, type TutorVideoBoxHandle } from "@companion-space/avatar-engine/video-box";
import "@companion-space/avatar-engine/video-box.css";
import { api, bodyOf } from "../../app/api";
import { Loading } from "../../app/ui";
import { StageShell } from "../../shell/StageShell";
import {
  ArrowLeft,
  Badge,
  Button,
  ConfirmDialog,
  ErrorState,
  Gauge,
  MessageSquareText,
  Pause,
  Play,
  Popover,
  RefreshCw,
  SkipForward,
  Sparkles,
  Spinner,
  toast,
} from "../../ui";
import { MicrophoneCapture, Pcm16Framer, type HandsFreeVad } from "../../audio";
import t from "../../locales/zh-CN.json";
import { toVideoAvatarConfig, videoBoxLabels } from "../characters/video-config";
import { createSidecarConnector } from "../characters/sidecar-connector";
import { courseKeys } from "../courses/api";
import { learnerKeys } from "../learner/api";
import { AnswerTray } from "./answer-tray";
import { BoardPanel, formatDividerText } from "./board-panel";
import { ControlDock } from "./control-dock";
import {
  JUDGING_TIMEOUT_MS,
  lessonPhase,
  phaseStatusKey,
  resolvePhasePose,
  type PendingSubmit,
} from "./lesson-phase";
import type { SpokenEntry } from "./lesson-state";
import { RecapView } from "./recap-view";
import { useClassroom } from "./use-classroom";

const copy = t.classroom;
const CAPTION_STORAGE_KEY = "cs:classroom:caption-visible";
const VOLUME_STORAGE_KEY = "cs:classroom:volume";

function readStoredCaption(): boolean {
  try {
    const raw = window.localStorage.getItem(CAPTION_STORAGE_KEY);
    return raw === null ? true : raw !== "0";
  } catch {
    return true;
  }
}

function readStoredVolume(): number {
  try {
    const raw = window.localStorage.getItem(VOLUME_STORAGE_KEY);
    const parsed = raw ? Number(raw) : 1;
    return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 1;
  } catch {
    return 1;
  }
}

function useReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return reduced;
}

function Lesson({ id }: { id: string }) {
  const navigate = useNavigate();
  const queries = useQueryClient();
  const videoRef = useRef<TutorVideoBoxHandle>(null);
  const composerRef = useRef<HTMLInputElement>(null);
  const spokenScrollRef = useRef<HTMLDivElement>(null);
  const reducedMotion = useReducedMotion();

  const [quietCompanion, setQuietCompanion] = useState(false);
  const [instantOverride, setInstantOverride] = useState<{ action: InstantAction; until: number } | null>(null);
  const [pendingSubmit, setPendingSubmit] = useState<PendingSubmit | null>(null);
  const [text, setText] = useState("");
  const [endOpen, setEndOpen] = useState(false);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [qualityOpen, setQualityOpen] = useState(false);
  const [activeTier, setActiveTier] = useState<VideoAvatarTier | null>(null);
  const [degradedNotice, setDegradedNotice] = useState<{
    code?: VideoDriverDegradedCode;
    message: string;
  } | null>(null);
  const [recording, setRecording] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [handsFree, setHandsFree] = useState(false);
  const [handsFreeLoading, setHandsFreeLoading] = useState(false);
  const [showCaption, setShowCaption] = useState<boolean>(() => readStoredCaption());
  const [volume, setVolume] = useState<number>(() => readStoredVolume());
  const [muted, setMuted] = useState(false);
  const [selectedStyle, setSelectedStyle] = useState<string | null>(null);
  const [textHeld, setTextHeld] = useState(false);
  const [dismissedDividerId, setDismissedDividerId] = useState<string | null>(null);

  const lastActivityRef = useRef<number>(0);
  const previewJudgeGenRef = useRef<number>(-1);
  const capture = useRef<MicrophoneCapture>(null);
  const vad = useRef<HandsFreeVad>(null);
  const vadRequest = useRef(0);
  const down = useRef(false);
  const micStarted = useRef(false);
  const echoProtected = useRef(false);

  const onSpeechLevel = useCallback((level: number) => {
    videoRef.current?.pushSpeechLevel(level);
  }, []);
  const onSpeechChunk = useCallback((chunk: DecodedSpeechChunk) => {
    videoRef.current?.pushSpeechChunk(chunk);
  }, []);
  const triggerFastAction = useCallback((action: InstantAction, gen: number) => {
    lastActivityRef.current = Date.now();
    setQuietCompanion(false);
    setInstantOverride({ action, until: Date.now() + 2600 });
    videoRef.current?.triggerInstantAction(action, gen);
  }, []);
  const onJudgePreview = useCallback(
    (verdict: string, gen: number) => {
      previewJudgeGenRef.current = gen;
      const action = verdictToInstantAction(verdict);
      if (action) triggerFastAction(action, gen);
    },
    [triggerFastAction],
  );

  const live = useClassroom(id, onSpeechLevel, onSpeechChunk, onJudgePreview);
  const voice = useQuery({
    queryKey: ["voice-status"],
    queryFn: async () => bodyOf(await api.GET("/api/v2/voice/status")),
  });

  const markLearnerActivity = useCallback(() => {
    lastActivityRef.current = Date.now();
    setQuietCompanion(false);
  }, []);

  // Sync audio volume & mute to SpeechOutput
  useEffect(() => {
    live.setVolume(volume);
    try {
      window.localStorage.setItem(VOLUME_STORAGE_KEY, String(volume));
    } catch {
      // Ignore storage failures
    }
  }, [live, volume]);

  useEffect(() => {
    live.setMuted(muted);
  }, [live, muted]);

  useEffect(() => {
    echoProtected.current = live.echoProtected;
  }, [live.echoProtected]);

  // Clear instant override timer
  useEffect(() => {
    if (!instantOverride) return;
    const delay = Math.max(0, instantOverride.until - Date.now());
    const timer = window.setTimeout(() => setInstantOverride(null), delay);
    return () => window.clearTimeout(timer);
  }, [instantOverride]);

  // Surface voice fallback / echo / error messages as non-blocking toasts
  useEffect(() => {
    if (live.fallback) toast.info(live.fallback);
  }, [live.fallback]);

  useEffect(() => {
    if (live.echoProtected) toast.info(copy.echo);
  }, [live.echoProtected]);

  // Derive active teaching style (local pick takes precedence until next server style update)
  const currentStyle = live.classroom.lastStyle ?? selectedStyle ?? "guided";

  // Briefly display R6 adaptation hint in topbar when a new adaptation divider arrives
  const latestDivider = live.classroom.dividers[live.classroom.dividers.length - 1];
  const adaptBanner =
    latestDivider && latestDivider.kind !== "stage" && dismissedDividerId !== latestDivider.id
      ? formatDividerText(latestDivider)
      : null;
  useEffect(() => {
    if (!latestDivider || latestDivider.kind === "stage") return;
    const idToDismiss = latestDivider.id;
    const timer = window.setTimeout(() => setDismissedDividerId(idToDismiss), 5000);
    return () => window.clearTimeout(timer);
  }, [latestDivider]);

  // Judging 20-second timeout protection (§5.6.2)
  useEffect(() => {
    if (!pendingSubmit || pendingSubmit.timedOut) return;
    if (pendingSubmit.askSeq !== live.classroom.askSeq) return;
    if (live.classroom.judge || live.previewVerdict?.askSeq === pendingSubmit.askSeq) return;
    if (live.errorSeq !== pendingSubmit.errorSeq) return;

    const timer = window.setTimeout(() => {
      setPendingSubmit((prev) =>
        prev && prev.askSeq === pendingSubmit.askSeq ? { ...prev, timedOut: true } : prev,
      );
    }, JUDGING_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [
    pendingSubmit,
    live.classroom.askSeq,
    live.classroom.judge,
    live.previewVerdict,
    live.errorSeq,
  ]);

  // Invalidate course/plan/progress caches upon recap
  const recapCourseId = live.room?.course_id;
  useEffect(() => {
    if (!live.recap || !recapCourseId) return;
    void queries.invalidateQueries({ queryKey: courseKeys.all });
    void queries.invalidateQueries({ queryKey: learnerKeys.plan(recapCourseId) });
    void queries.invalidateQueries({ queryKey: ["courses", recapCourseId, "progress"] });
  }, [live.recap, recapCourseId, queries]);

  // Derive single source of truth phase
  const ended = Boolean(
    live.recap || live.room?.status === "done" || live.room?.status === "abandoned",
  );
  const phase = lessonPhase({
    loading: !live.room && !live.fatalError,
    preparing: false,
    connected: live.connected,
    started: live.started,
    resuming: live.resuming,
    reconnectAttempt: live.reconnectAttempt,
    fatalError: live.fatalError && !live.room,
    recording,
    audioSpeaking: live.audioSpeaking,
    audioBuffering: live.audioBuffering,
    audioMode: live.lastAudio,
    pendingSubmit,
    previewVerdict: live.previewVerdict,
    classroom: live.classroom,
    roomSeq: live.room?.seq ?? 0,
    hasFirstBeat: live.hasFirstBeat,
    ending: live.ending,
    ended,
    tabPaused: live.tabPaused,
    quietCompanion,
    errorSeq: live.errorSeq,
  });

  const statusKey = phaseStatusKey(phase, quietCompanion);
  const statusLabel = copy[statusKey];
  const resolvedPose = resolvePhasePose(phase, {
    quietCompanion,
    instantAction: instantOverride?.action ?? null,
    classroom: live.classroom,
    audioSpeaking: live.audioSpeaking,
  });

  // Quiet companion timer while awaiting student answer
  useEffect(() => {
    if (phase !== "awaiting") return;
    lastActivityRef.current = Date.now();
    const timer = window.setInterval(() => {
      if (Date.now() - lastActivityRef.current >= IDLE_COMPANION_MS) {
        setQuietCompanion(true);
      }
    }, 1000);
    return () => {
      window.clearInterval(timer);
      setQuietCompanion(false);
    };
  }, [phase, live.classroom.askSeq]);

  // Forward server avatar instant actions (deduped against preview)
  useEffect(() => {
    const action = live.classroom.avatar.instantAction;
    if (!action) return;
    if (live.classroom.avatar.gen === previewJudgeGenRef.current && live.classroom.judge) return;
    videoRef.current?.triggerInstantAction(action, live.classroom.avatar.gen);
  }, [
    live.classroom.avatar.gestureSequence,
    live.classroom.avatar.instantAction,
    live.classroom.avatar.gen,
    live.classroom.judge,
  ]);

  // Release mic when tab hides
  useEffect(() => {
    const release = () => {
      if (!document.hidden) return;
      vadRequest.current += 1;
      down.current = false;
      micStarted.current = false;
      void capture.current?.stop();
      void vad.current?.destroy();
      capture.current = null;
      vad.current = null;
      setRecording(false);
      setMicLevel(0);
      setHandsFree(false);
      setHandsFreeLoading(false);
    };
    document.addEventListener("visibilitychange", release);
    return () => {
      document.removeEventListener("visibilitychange", release);
      vadRequest.current += 1;
      down.current = false;
      void capture.current?.stop();
      void vad.current?.destroy();
    };
  }, []);

  const currentGen = live.classroom.avatar.gen;
  const interruptAll = useCallback(() => {
    markLearnerActivity();
    setInstantOverride(null);
    videoRef.current?.interrupt(currentGen);
    return live.interrupt();
  }, [currentGen, live, markLearnerActivity]);

  const finishMic = useCallback(() => {
    if (!down.current) return;
    down.current = false;
    setRecording(false);
    setMicLevel(0);
    void capture.current?.stop();
    capture.current = null;
    if (micStarted.current) live.send("microphone.end");
    micStarted.current = false;
  }, [live]);

  const startMic = useCallback(async () => {
    if (down.current || !live.connected || !live.started || handsFree) return;
    down.current = true;
    const interrupted = interruptAll();
    setRecording(true);
    const mic = new MicrophoneCapture();
    capture.current = mic;
    try {
      await mic.start(({ pcm16, level }) => {
        if (!down.current || capture.current !== mic) return;
        if (!micStarted.current) micStarted.current = live.send("microphone.start", { interrupted });
        setMicLevel(level);
        if (micStarted.current) live.upload(pcm16);
      });
      if (!down.current || capture.current !== mic) await mic.stop();
    } catch {
      if (capture.current !== mic) return;
      toast.error(copy.micError);
      down.current = false;
      setRecording(false);
      setMicLevel(0);
    }
  }, [handsFree, interruptAll, live]);

  const stopVad = useCallback(async () => {
    vadRequest.current += 1;
    const instance = vad.current;
    vad.current = null;
    setHandsFree(false);
    setHandsFreeLoading(false);
    setRecording(false);
    setMicLevel(0);
    if (instance) await instance.destroy();
    live.send("microphone.cancel");
  }, [live]);

  const toggleVad = useCallback(async () => {
    if (handsFree || handsFreeLoading) {
      await stopVad();
      return;
    }
    const request = ++vadRequest.current;
    setHandsFreeLoading(true);
    try {
      const { HandsFreeVad } = await import("../../audio/vad");
      if (request !== vadRequest.current) return;
      let framer = new Pcm16Framer(16_000);
      const instance = new HandsFreeVad({
        onSpeechStart: () => {
          if (document.hidden || vad.current !== instance) return;
          markLearnerActivity();
          framer = new Pcm16Framer(16_000);
          setRecording(true);
          live.send("microphone.start");
        },
        onFrame: (samples) => {
          if (document.hidden || vad.current !== instance) return;
          for (const frame of framer.push(samples)) {
            setMicLevel(frame.level);
            live.upload(frame.pcm16);
          }
        },
        onInterrupt: () => {
          if (
            vad.current === instance &&
            !document.hidden &&
            !echoProtected.current &&
            interruptAll()
          ) {
            live.send("microphone.interrupted");
          }
        },
        onSpeechEnd: () => {
          if (vad.current !== instance) return;
          setRecording(false);
          setMicLevel(0);
          live.send("microphone.end");
        },
        onMisfire: () => {
          if (vad.current !== instance) return;
          setRecording(false);
          setMicLevel(0);
          live.send("microphone.cancel");
        },
      });
      vad.current = instance;
      await instance.start();
      if (request !== vadRequest.current) return;
      setHandsFreeLoading(false);
      setHandsFree(true);
    } catch {
      if (request !== vadRequest.current) return;
      await stopVad();
      toast.error(copy.micError);
    }
  }, [handsFree, handsFreeLoading, interruptAll, live, markLearnerActivity, stopVad]);

  const toggleCaption = useCallback(() => {
    setShowCaption((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(CAPTION_STORAGE_KEY, next ? "1" : "0");
      } catch {
        // Ignore storage failures
      }
      return next;
    });
  }, []);

  const handleQuickAction = useCallback(
    (kind: string) => {
      markLearnerActivity();
      live.interrupt();
      const instant = quickActionToInstantAction(kind);
      if (instant) {
        triggerFastAction(instant, currentGen);
      }
      const label = copy.quick[kind as keyof typeof copy.quick];
      if (label) {
        live.appendStudentEntry(label, "quick");
      }
      live.send("student.quick", instant ? { kind, recent_avatar_action: instant } : { kind });
    },
    [currentGen, live, markLearnerActivity, triggerFastAction],
  );

  const handleSubmitText = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      const trimmed = text.trim();
      if (!trimmed) return;
      interruptAll();
      live.appendStudentEntry(trimmed, "text");
      const ask = live.classroom.ask;
      const sent =
        ask && !ask.widget
          ? live.send("student.reply", { purpose: ask.purpose, value: trimmed })
          : live.send("student.text", { text: trimmed });
      if (sent) setText("");
    },
    [interruptAll, live, text],
  );

  const handleMicPointerDown = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      void startMic();
    },
    [startMic],
  );

  const handleMicKey = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>) => {
      if (event.key !== " " && event.key !== "Enter") return;
      event.preventDefault();
      if (event.type === "keyup") finishMic();
      else if (!event.repeat) void startMic();
    },
    [finishMic, startMic],
  );

  const handlePause = useCallback(() => {
    finishMic();
    void stopVad();
    live.pause();
  }, [finishMic, live, stopVad]);

  const handleEndConfirm = useCallback(() => {
    setEndOpen(false);
    finishMic();
    void stopVad();
    interruptAll();
    live.send("lesson.control", { action: "end" });
  }, [finishMic, interruptAll, live, stopVad]);

  const handleDegraded = useCallback(
    (notice: { code?: VideoDriverDegradedCode; message: string }) => {
      setDegradedNotice(notice);
      const reasonText =
        (notice.code && copy.videoDegraded[notice.code as keyof typeof copy.videoDegraded]) ||
        notice.message ||
        copy.videoDegraded.fallback;
      toast.warning(reasonText, {
        action: {
          label: copy.qualityTitle,
          onClick: () => setQualityOpen(true),
        },
      });
    },
    [],
  );

  // Global keyboard shortcuts (§5.6.10)
  const sttConfigured = Boolean(voice.data?.stt_configured);
  const ready = live.started && live.connected && !live.resuming && !live.ending;

  useEffect(() => {
    const isEditable = (el: HTMLElement | null) => {
      if (!el) return false;
      const tag = el.tagName.toLowerCase();
      return (
        tag === "input" ||
        tag === "textarea" ||
        tag === "select" ||
        el.isContentEditable
      );
    };
    const isInteractive = (el: HTMLElement | null) => {
      if (!el) return false;
      const tag = el.tagName.toLowerCase();
      if (isEditable(el) || tag === "button" || tag === "a") return true;
      const role = el.getAttribute("role");
      return role === "radio" || role === "checkbox" || role === "button" || role === "slider";
    };

    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.key === "Escape" && ready && (live.speaking || live.audioSpeaking)) {
        event.preventDefault();
        interruptAll();
        return;
      }
      if (event.shiftKey && !event.ctrlKey && !event.metaKey && !isEditable(target)) {
        const lower = event.key.toLowerCase();
        if (lower === "c" && live.lastAudio) {
          event.preventDefault();
          toggleCaption();
          return;
        }
        if (lower === "m" && live.lastAudio) {
          event.preventDefault();
          setMuted((prev) => !prev);
          return;
        }
      }
      if (event.key === "Enter" && phase === "lobby" && live.connected && !isInteractive(target)) {
        event.preventDefault();
        void live.start(true);
        return;
      }
      if (event.key === " " && ready && !isInteractive(target)) {
        event.preventDefault();
        if (!live.lastAudio) {
          live.skipTextWait();
        } else if (sttConfigured && !handsFree && !event.repeat) {
          void startMic();
        }
      }
    };

    const onKeyUp = (event: globalThis.KeyboardEvent) => {
      if (event.key === " " && down.current) {
        event.preventDefault();
        finishMic();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [
    finishMic,
    handsFree,
    interruptAll,
    live,
    phase,
    ready,
    startMic,
    sttConfigured,
    toggleCaption,
  ]);

  // Combine teacher spoken log + student messages for text-mode log
  const combinedLog = useMemo<SpokenEntry[]>(() => {
    const entries: SpokenEntry[] = [...live.classroom.spokenLog, ...live.studentEntries];
    return entries;
  }, [live.classroom.spokenLog, live.studentEntries]);

  useEffect(() => {
    const el = spokenScrollRef.current;
    if (!el || live.lastAudio) return;
    el.scrollTo({ top: el.scrollHeight, behavior: reducedMotion ? "instant" : "smooth" });
  }, [combinedLog.length, live.lastAudio, reducedMotion]);

  const labels = useMemo(() => videoBoxLabels(), []);
  const sidecarConnector = useMemo(() => createSidecarConnector(), []);
  const { room, classroom, connected, recap, error } = live;
  const teacher = room?.teacher;
  const teacherConfig = useMemo(
    () => (teacher ? toVideoAvatarConfig(teacher, reducedMotion) : null),
    [teacher, reducedMotion],
  );

  // Loading / fatal load failure before room arrives
  if (!room) {
    if (error) {
      return (
        <main id="main" className="mx-auto max-w-[640px] p-8">
          <h1 className="sr-only">{t.app.titles.lesson}</h1>
          <ErrorState title={copy.failed} message={error} onRetry={() => void live.reconnect()} />
        </main>
      );
    }
    return (
      <main id="main" className="mx-auto max-w-[640px] p-8">
        <h1 className="sr-only">{t.app.titles.lesson}</h1>
        <Loading />
      </main>
    );
  }

  // Ended -> Light Focus-style Recap container (scroll allowed, zero site nav)
  if (ended) {
    return (
      <RecapView
        lessonId={id}
        courseId={room.course_id}
        title={room.title}
        summary={typeof recap?.summary === "string" ? recap.summary : undefined}
        board={[...classroom.board]}
      />
    );
  }

  const ask = classroom.ask;
  const activeVerdict =
    classroom.judge ??
    (live.previewVerdict?.askSeq === classroom.askSeq ? live.previewVerdict?.verdict : undefined);
  const showTray = Boolean(
    ready &&
      ask &&
      (phase === "awaiting" || phase === "judging" || phase === "feedback" || phase === "listening"),
  );
  const textMode = !live.lastAudio;
  const canInterrupt = live.speaking || live.audioSpeaking || live.audioBuffering;

  const handleBackClick = () => {
    if (phase === "lobby" || phase === "paused" || phase === "failed") {
      void navigate(`/courses/${room.course_id}`);
      return;
    }
    setLeaveOpen(true);
  };

  const effectiveTier = activeTier ?? teacherConfig?.preferredTier ?? "static";
  const tierLabel = copy.videoTiers[effectiveTier as keyof typeof copy.videoTiers] ?? effectiveTier;

  const topbar = (
    <>
      <div className="flex min-w-0 items-center gap-3">
        <button
          type="button"
          onClick={handleBackClick}
          className="inline-flex min-h-9 items-center gap-1.5 rounded-md px-2 py-1 text-caption font-medium text-fg-secondary hover:bg-surface-card hover:text-fg-primary"
        >
          <ArrowLeft size={15} aria-hidden="true" />
          <span className="hidden sm:inline">{copy.back}</span>
        </button>
        <h1 className="truncate text-ui font-semibold text-fg-primary">{room.title}</h1>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {adaptBanner ? (
          <Badge tone="accent" className="hidden md:inline-flex">
            <Sparkles size={12} aria-hidden="true" />
            <span>{adaptBanner}</span>
          </Badge>
        ) : null}

        <Popover
          open={qualityOpen}
          onOpenChange={setQualityOpen}
          side="bottom"
          align="end"
          trigger={
            <button
              type="button"
              aria-label={copy.qualityTitle}
              title={copy.qualityTitle}
              className="inline-flex min-h-9 items-center gap-1.5 rounded-md border border-line-subtle bg-surface-card px-2.5 text-caption font-medium text-fg-secondary hover:text-fg-primary"
            >
              <Gauge size={15} aria-hidden="true" />
              <span className="hidden sm:inline">{copy.qualityTitle}</span>
            </button>
          }
          className="w-72"
        >
          <div className="grid gap-3 text-caption">
            <p className="text-ui font-semibold text-fg-primary">{copy.qualityTitle}</p>
            <div className="flex items-center justify-between">
              <span className="text-fg-secondary">{copy.qualityTier}</span>
              <Badge tone="neutral">{tierLabel ?? copy.qualityBasic}</Badge>
            </div>
            {live.latency !== undefined ? (
              <div className="flex items-center justify-between">
                <span className="text-fg-secondary">{copy.latency}</span>
                <span className="tabular-nums text-fg-primary">{live.latency} ms</span>
              </div>
            ) : null}
            {degradedNotice ? (
              <p className="rounded-sm bg-warn-soft p-2 text-warn-text">
                {(degradedNotice.code &&
                  copy.videoDegraded[degradedNotice.code as keyof typeof copy.videoDegraded]) ||
                  degradedNotice.message ||
                  copy.videoDegraded.fallback}
              </p>
            ) : null}
            {effectiveTier === "local_sidecar" || effectiveTier === "cloud_live" ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  void videoRef.current?.switchToFreeTier();
                  setQualityOpen(false);
                }}
              >
                {copy.switchToBasic}
              </Button>
            ) : null}
          </div>
        </Popover>
      </div>
    </>
  );

  const stageOverlay = (() => {
    if (phase === "lobby") {
      return (
        <div
          data-testid="stage-overlay-lobby"
          className="absolute inset-0 z-overlay flex flex-col items-center justify-center gap-3 rounded-lg bg-scrim p-5 text-center backdrop-blur-xs"
        >
          <p className="text-body font-semibold text-fg-primary">{copy.waitingStart}</p>
          <p className="max-w-[260px] text-caption text-fg-secondary">{copy.lobbySubtitle}</p>
          <div className="flex flex-wrap justify-center gap-2 pt-1">
            <Button
              variant="primary"
              disabled={!connected}
              onClick={() => void live.start(true)}
            >
              {copy.startVoice}
            </Button>
            <Button
              variant="secondary"
              disabled={!connected}
              onClick={() => void live.start(false)}
            >
              {copy.startText}
            </Button>
          </div>
        </div>
      );
    }

    if (phase === "paused") {
      return (
        <div
          data-testid="stage-overlay-paused"
          className="absolute inset-0 z-overlay flex flex-col items-center justify-center gap-3 rounded-lg bg-scrim p-5 text-center backdrop-blur-xs"
        >
          <p className="text-body font-semibold text-fg-primary">
            {live.tabPaused ? copy.tabPausedHint : copy.waitingResume}
          </p>
          <div className="flex flex-wrap justify-center gap-2 pt-1">
            <Button
              variant="primary"
              size="lg"
              disabled={!connected}
              leftIcon={<Play size={17} />}
              onClick={() => void live.start(live.lastAudio)}
            >
              {copy.resumeLesson}
            </Button>
          </div>
          <button
            type="button"
            disabled={!connected}
            onClick={() => void live.start(!live.lastAudio)}
            className="text-caption text-fg-secondary underline-offset-4 hover:text-fg-primary hover:underline"
          >
            {live.lastAudio ? copy.startText : copy.startVoice}
          </button>
        </div>
      );
    }

    if (phase === "reconnecting") {
      return (
        <div
          data-testid="stage-overlay-reconnecting"
          className="absolute inset-0 z-overlay flex flex-col items-center justify-center gap-3 rounded-lg bg-scrim p-5 text-center backdrop-blur-xs"
        >
          <Spinner size={26} />
          <p className="text-ui font-medium text-fg-primary">
            {live.reconnectAttempt > 0
              ? copy.reconnectingAttempt.replace("{n}", String(live.reconnectAttempt))
              : copy.reconnecting}
          </p>
          <Button
            variant="secondary"
            size="sm"
            leftIcon={<RefreshCw size={14} />}
            onClick={() => void live.reconnect()}
          >
            {copy.retryNow}
          </Button>
        </div>
      );
    }

    if (phase === "ending") {
      return (
        <div
          data-testid="stage-overlay-ending"
          className="absolute inset-0 z-overlay flex flex-col items-center justify-center gap-3 rounded-lg bg-scrim p-5 text-center backdrop-blur-xs"
        >
          <Spinner size={26} />
          <p className="text-ui font-medium text-fg-primary">{copy.ending}</p>
        </div>
      );
    }

    if (phase === "failed") {
      return (
        <div
          data-testid="stage-overlay-failed"
          className="absolute inset-0 z-overlay flex flex-col items-center justify-center gap-3 rounded-lg bg-scrim p-5 text-center backdrop-blur-xs"
        >
          <p className="text-ui font-medium text-fg-primary" role="alert">
            {error || copy.connectionError}
          </p>
          <Button
            variant="primary"
            size="sm"
            leftIcon={<RefreshCw size={14} />}
            onClick={() => void (connected ? live.start(live.lastAudio) : live.reconnect())}
          >
            {copy.retryNow}
          </Button>
        </div>
      );
    }

    return null;
  })();

  const stageNode = (
    <>
      <div className="relative flex min-h-0 flex-1 w-full items-center justify-center">
        {teacherConfig ? (
          <TutorVideoBox
            ref={videoRef}
            config={teacherConfig}
            pose={resolvedPose}
            phase={phase}
            emotion={classroom.avatar.emotion}
            gen={classroom.avatar.gen}
            statusLabel={statusLabel}
            caption={classroom.caption}
            captionVisible={live.lastAudio && showCaption}
            showSoundBars={live.lastAudio && phase === "speaking"}
            stageMode
            labels={labels}
            sidecarConnector={sidecarConnector}
            onTierChange={setActiveTier}
            onDegraded={handleDegraded}
            onQualityInfoClick={() => setQualityOpen(true)}
          />
        ) : (
          <div className="flex h-full w-full flex-col justify-end rounded-lg border border-line-subtle bg-surface-card p-5">
            {live.lastAudio && showCaption ? (
              <p className="text-body leading-relaxed text-fg-primary" aria-live="polite">
                {classroom.caption}
              </p>
            ) : null}
            <p className="mt-3 flex items-center justify-between text-ui font-semibold text-fg-primary">
              <span>{copy.teacher}</span>
              <span className="text-caption font-normal text-fg-secondary">{statusLabel}</span>
            </p>
          </div>
        )}
        {stageOverlay}
      </div>

      {/* Text mode: read-only teacher speech log + pacing controls (§5.6.5) */}
      {textMode ? (
        <section
          data-testid="text-mode-log"
          aria-label={copy.teacherSaid}
          className="flex h-[176px] w-full shrink-0 flex-col rounded-md border border-line-subtle bg-surface-card"
        >
          <header className="flex items-center justify-between gap-2 border-b border-line-subtle px-3 py-1.5">
            <span className="inline-flex items-center gap-1.5 text-caption font-semibold text-fg-secondary">
              <MessageSquareText size={13} aria-hidden="true" />
              <span>{copy.teacherSaid}</span>
            </span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                disabled={!ready}
                onClick={() => {
                  const next = !textHeld;
                  setTextHeld(next);
                  live.setTextHold(next);
                }}
                className="inline-flex min-h-7 items-center gap-1 rounded-sm px-2 text-micro font-medium text-fg-secondary hover:bg-surface-sunken hover:text-fg-primary disabled:opacity-45"
              >
                {textHeld ? <Play size={12} /> : <Pause size={12} />}
                <span>{textHeld ? copy.resumeSentence : copy.holdSentence}</span>
              </button>
              <button
                type="button"
                disabled={!ready || !live.audioSpeaking}
                onClick={() => {
                  setTextHeld(false);
                  live.setTextHold(false);
                  live.skipTextWait();
                }}
                className="inline-flex min-h-7 items-center gap-1 rounded-sm px-2 text-micro font-medium text-accent-strong hover:bg-accent-soft disabled:opacity-45"
              >
                <SkipForward size={12} />
                <span>{copy.nextSentence}</span>
              </button>
            </div>
          </header>
          <div ref={spokenScrollRef} className="grid flex-1 content-start gap-1.5 overflow-y-auto px-3 py-2">
            {combinedLog.length === 0 ? (
              <p className="text-caption text-fg-tertiary">{copy.ready}</p>
            ) : (
              combinedLog.map((entry, idx) => {
                const isLatest = idx === combinedLog.length - 1;
                return (
                  <p
                    key={entry.id}
                    className={
                      entry.role === "student"
                        ? "justify-self-end rounded-sm bg-accent-soft px-2.5 py-1 text-caption text-accent-strong"
                        : isLatest
                          ? "rounded-sm bg-surface-sunken px-2.5 py-1.5 text-ui font-medium text-fg-primary"
                          : "px-2 py-0.5 text-caption text-fg-secondary"
                    }
                  >
                    {entry.text}
                  </p>
                );
              })
            )}
          </div>
        </section>
      ) : null}
    </>
  );

  const boardNode = (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {error && phase !== "failed" && phase !== "reconnecting" ? (
        <div
          role="alert"
          className="flex shrink-0 items-center justify-between gap-3 border-b border-danger/30 bg-danger-soft px-4 py-2 text-caption text-danger-text"
        >
          <span>{error}</span>
          <Button
            variant="secondary"
            size="sm"
            pending={live.resuming}
            onClick={() => void (connected ? live.start(live.lastAudio) : live.reconnect())}
          >
            {copy.retry}
          </Button>
        </div>
      ) : null}

      <BoardPanel
        title={room.title}
        stage={classroom.stage}
        board={[...classroom.board]}
        dividers={[...classroom.dividers]}
        answeredCards={[...classroom.answeredCards]}
        activeBlockId={classroom.activeBlockId}
        trayOpen={showTray}
        ready={ready}
        reducedMotion={reducedMotion}
        trayKey={`${showTray ? "open" : "closed"}:${classroom.askSeq ?? 0}:${activeVerdict ?? ""}`}
        onLocate={(target) => {
          if (ready) handleQuickAction(`locate:${target}`);
        }}
      />

      {showTray && ask ? (
        <AnswerTray
          key={classroom.askSeq ?? ask.item_id ?? ask.purpose}
          ask={ask}
          askSeq={classroom.askSeq}
          prefill={live.prefill?.item_id === ask.item_id ? live.prefill : undefined}
          phase={phase}
          verdict={activeVerdict}
          revealedAnswer={classroom.revealedAnswer}
          judgingTimedOut={Boolean(
            pendingSubmit?.timedOut && pendingSubmit.askSeq === classroom.askSeq,
          )}
          onActivity={markLearnerActivity}
          onSubmit={(value, via, dont_know) => {
            markLearnerActivity();
            if (dont_know) triggerFastAction("gentle_encourage", currentGen);
            const sent = live.send("student.answer", {
              item_id: ask.item_id,
              value,
              via,
              dont_know,
            });
            if (sent && classroom.askSeq !== undefined && ask.item_id) {
              setPendingSubmit({
                itemId: ask.item_id,
                askSeq: classroom.askSeq,
                errorSeq: live.errorSeq,
                submittedAtMs: Date.now(),
              });
            }
          }}
          onAck={(value) => {
            markLearnerActivity();
            if (value === "easier") triggerFastAction("gentle_encourage", currentGen);
            live.send("student.reply", { purpose: ask.purpose, value });
          }}
          onQuick={(kind) => handleQuickAction(kind)}
          onFocusComposer={() => composerRef.current?.focus()}
        />
      ) : null}
    </div>
  );

  const dockNode = (
    <ControlDock
      ready={ready}
      audioMode={live.lastAudio}
      sttConfigured={sttConfigured}
      recording={recording}
      micLevel={micLevel}
      handsFree={handsFree}
      handsFreeLoading={handsFreeLoading}
      canInterrupt={canInterrupt}
      text={text}
      composerRef={composerRef}
      showCaption={showCaption}
      volume={volume}
      muted={muted}
      currentStyle={currentStyle}
      onTextChange={setText}
      onSubmitText={handleSubmitText}
      onMicPointerDown={handleMicPointerDown}
      onMicPointerUp={finishMic}
      onMicKey={handleMicKey}
      onToggleHandsFree={() => void toggleVad()}
      onInterrupt={() => void interruptAll()}
      onQuickAction={handleQuickAction}
      onToggleCaption={toggleCaption}
      onVolumeChange={setVolume}
      onToggleMute={() => setMuted((prev) => !prev)}
      onStyleChange={setSelectedStyle}
      onPause={handlePause}
      onRequestEnd={() => setEndOpen(true)}
    />
  );

  return (
    <>
      <StageShell
        phase={phase}
        textMode={textMode}
        topbar={topbar}
        stage={stageNode}
        board={boardNode}
        dock={dockNode}
      />

      <ConfirmDialog
        open={endOpen}
        onOpenChange={setEndOpen}
        title={copy.endTitle}
        description={copy.endConfirm}
        confirmLabel={copy.confirmEnd}
        cancelLabel={copy.keepLesson}
        danger={false}
        onConfirm={handleEndConfirm}
      />

      <ConfirmDialog
        open={leaveOpen}
        onOpenChange={setLeaveOpen}
        title={copy.leaveConfirmTitle}
        description={copy.leaveConfirmBody}
        confirmLabel={copy.leaveConfirmAction}
        cancelLabel={copy.keepLesson}
        danger={false}
        onConfirm={() => {
          setLeaveOpen(false);
          handlePause();
          void navigate(`/courses/${room.course_id}`);
        }}
      />
    </>
  );
}

export default function Classroom() {
  const { lessonId = "" } = useParams();
  return <Lesson key={lessonId} id={lessonId} />;
}
