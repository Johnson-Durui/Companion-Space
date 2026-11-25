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
import { useLocation, useNavigate, useParams } from "react-router";
import {
  IDLE_COMPANION_MS,
  oneShotToInstantAction,
  phaseToSituation,
  quickActionToInstantAction,
  quickActionToOneShot,
  verdictToInstantAction,
  verdictToOneShot,
} from "@companion-space/avatar-engine/choreographer";
import type {
  DecodedSpeechChunk,
  InstantAction,
  OneShotKind,
  VideoAvatarTier,
  VideoDriverDegradedCode,
} from "@companion-space/avatar-engine/types";
import { TutorVideoBox, type TutorVideoBoxHandle } from "@companion-space/avatar-engine/video-box";
import "@companion-space/avatar-engine/video-box.css";
import { api, bodyOf, sessionKey, voiceStatusKey } from "../../app/api";
import { Loading } from "../../app/ui";
import {
  StageShell,
  type StageMobileView,
  type StageViewMode,
} from "../../shell/StageShell";
import {
  ArrowLeft,
  Badge,
  Button,
  ChevronRight,
  ConfirmDialog,
  Dialog,
  Drawer,
  ErrorState,
  Gauge,
  HelpCircle,
  MessageSquareText,
  Monitor,
  Pause,
  PictureInPicture2,
  Play,
  Popover,
  RefreshCw,
  SkipForward,
  Sparkles,
  Spinner,
  toast,
} from "../../ui";
import {
  classifyMicrophoneError,
  MicrophoneCapture,
  Pcm16Framer,
  readSoundCuePrefs,
  SoundCuePlayer,
  type HandsFreeVad,
  type MicrophoneErrorKind,
} from "../../audio";
import t from "../../locales/zh-CN.json";
import { toVideoAvatarConfig, videoBoxLabels } from "../characters/video-config";
import { createSidecarConnector } from "../characters/sidecar-connector";
import { courseKeys } from "../courses/api";
import { learnerKeys } from "../learner/api";
import { addNoteBlock, notesKeys } from "../notes/api";
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
import { mergeTranscriptEntries } from "./lesson-state";
import { RecapView } from "./recap-view";
import { ShortcutsDialog } from "./shortcuts-dialog";
import { TranscriptPanel } from "./transcript-panel";
import { useClassroom } from "./use-classroom";

const copy = t.classroom;
const CAPTION_STORAGE_KEY = "cs:classroom:caption-visible";
const VOLUME_STORAGE_KEY = "cs:classroom:volume";
const VIEW_MODE_STORAGE_KEY = "cs:classroom:view-mode";

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

function readStoredViewMode(): StageViewMode | null {
  try {
    const raw = window.localStorage.getItem(VIEW_MODE_STORAGE_KEY);
    return raw === "split" || raw === "board-first" ? raw : null;
  } catch {
    return null;
  }
}

function writeStoredViewMode(mode: StageViewMode) {
  try {
    window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, mode);
  } catch {
    // Ignore storage failures
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

function useViewportBuckets() {
  const read = () => {
    if (typeof window === "undefined") {
      return { isMobile: false, isCompactTablet: false, isWideDesktop: false };
    }
    const w = window.innerWidth;
    return {
      isMobile: w < 768,
      isCompactTablet: w >= 768 && w < 1100,
      isWideDesktop: w >= 1600,
    };
  };
  const [buckets, setBuckets] = useState(read);
  useEffect(() => {
    const update = () => setBuckets(read());
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return buckets;
}

function formatClock(totalMs: number): string {
  const secs = Math.max(0, Math.floor(totalMs / 1000));
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return `${String(mins).padStart(2, "0")}:${String(rem).padStart(2, "0")}`;
}

function Lesson({ id, onResumed }: { id: string; onResumed?: () => void }) {
  const location = useLocation();
  const navigate = useNavigate();
  const queries = useQueryClient();
  const lobbyNavState = (location.state as { fromLobby?: boolean; autoStartAudio?: boolean } | null) ?? null;
  const fromLobby = Boolean(lobbyNavState?.fromLobby);
  const autoStartConsumedRef = useRef(false);
  const videoRef = useRef<TutorVideoBoxHandle>(null);
  const composerRef = useRef<HTMLInputElement>(null);
  const spokenScrollRef = useRef<HTMLDivElement>(null);
  const reducedMotion = useReducedMotion();
  const { isMobile, isCompactTablet, isWideDesktop } = useViewportBuckets();

  const [quietCompanion, setQuietCompanion] = useState(false);
  const [typingRecently, setTypingRecently] = useState(false);
  const [instantOverride, setInstantOverride] = useState<{ action: InstantAction; until: number } | null>(null);
  const [pendingSubmit, setPendingSubmit] = useState<PendingSubmit | null>(null);
  const [text, setText] = useState("");
  const [endOpen, setEndOpen] = useState(false);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [qualityOpen, setQualityOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [micHelpOpen, setMicHelpOpen] = useState(false);
  const [micErrorKind, setMicErrorKind] = useState<MicrophoneErrorKind | null>(null);
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
  const [soundCuePrefs, setSoundCuePrefs] = useState(() => readSoundCuePrefs());
  const [selectedStyle, setSelectedStyle] = useState<string | null>(null);
  const [textHeld, setTextHeld] = useState(false);
  const [dismissedDividerId, setDismissedDividerId] = useState<string | null>(null);
  const [storedViewMode, setStoredViewMode] = useState<StageViewMode | null>(() => readStoredViewMode());
  const [mobileView, setMobileView] = useState<StageMobileView>("teacher");
  const [transcriptOpen, setTranscriptOpen] = useState<boolean>(() =>
    typeof window !== "undefined" ? window.innerWidth >= 1600 : false,
  );

  const effectiveViewMode: StageViewMode = isCompactTablet
    ? (storedViewMode ?? "board-first")
    : (storedViewMode ?? "split");

  const lastActivityRef = useRef<number>(0);
  const typingTimerRef = useRef<number | null>(null);
  const consecutiveCorrectRef = useRef<number>(0);
  const lastVerdictWasWrongRef = useRef<boolean>(false);
  const lastBoardBlockCountRef = useRef<number>(0);
  const previewJudgeGenRef = useRef<number>(-1);
  const capture = useRef<MicrophoneCapture | null>(null);
  const vad = useRef<HandsFreeVad>(null);
  const vadRequest = useRef(0);
  const down = useRef(false);
  const micStarted = useRef(false);
  const echoProtected = useRef(false);
  const echoNotifiedRef = useRef(false);
  const recordingRef = useRef(false);
  const speakingRef = useRef(false);
  const lastCueConnectRef = useRef(false);
  const lastCueAskSeqRef = useRef<number | undefined>(undefined);
  const lastCueVerdictKeyRef = useRef<string | null>(null);
  const lastCueEndRef = useRef(false);

  const soundCuesRef = useRef<SoundCuePlayer | null>(null);

  useEffect(() => {
    recordingRef.current = recording;
  }, [recording]);

  useEffect(() => {
    const player = new SoundCuePlayer({
      isSuppressed: () => speakingRef.current || recordingRef.current,
    });
    soundCuesRef.current = player;
    return () => {
      soundCuesRef.current = null;
      void player.close();
    };
  }, []);

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
  const triggerFastOneShot = useCallback((kind: OneShotKind, gen: number) => {
    lastActivityRef.current = Date.now();
    setQuietCompanion(false);
    const legacy = oneShotToInstantAction(kind);
    if (legacy) {
      setInstantOverride({ action: legacy, until: Date.now() + 2600 });
    }
    videoRef.current?.triggerOneShot(kind, gen);
  }, []);
  const onJudgePreview = useCallback(
    (verdict: string, gen: number) => {
      previewJudgeGenRef.current = gen;
      if (verdict === "correct") {
        consecutiveCorrectRef.current += 1;
        lastVerdictWasWrongRef.current = false;
      } else {
        consecutiveCorrectRef.current = 0;
        lastVerdictWasWrongRef.current = true;
      }
      const oneShot = verdictToOneShot(verdict, consecutiveCorrectRef.current);
      if (oneShot) {
        triggerFastOneShot(oneShot, gen);
        return;
      }
      const action = verdictToInstantAction(verdict);
      if (action) triggerFastAction(action, gen);
    },
    [triggerFastAction, triggerFastOneShot],
  );

  const live = useClassroom(id, onSpeechLevel, onSpeechChunk, onJudgePreview);
  const voice = useQuery({
    queryKey: voiceStatusKey,
    queryFn: async () => bodyOf(await api.GET("/api/v2/voice/status")),
    staleTime: 0,
    refetchOnWindowFocus: true,
  });

  useEffect(() => {
    speakingRef.current = live.speaking || live.audioSpeaking;
  }, [live.speaking, live.audioSpeaking]);

  const markLearnerActivity = useCallback(() => {
    lastActivityRef.current = Date.now();
    setQuietCompanion(false);
  }, []);

  const handleTextChange = useCallback((nextText: string) => {
    setText(nextText);
    lastActivityRef.current = Date.now();
    setQuietCompanion(false);
    setTypingRecently(true);
    if (typingTimerRef.current !== null) window.clearTimeout(typingTimerRef.current);
    typingTimerRef.current = window.setTimeout(() => {
      typingTimerRef.current = null;
      setTypingRecently(false);
    }, 2000);
  }, []);

  useEffect(() => {
    return () => {
      if (typingTimerRef.current !== null) window.clearTimeout(typingTimerRef.current);
    };
  }, []);

  const startLesson = useCallback(
    (withAudio: boolean) => {
      soundCuesRef.current?.unlock();
      videoRef.current?.triggerOneShot("greet", live.classroom.avatar.gen);
      return live.start(withAudio);
    },
    [live],
  );

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
    if (live.echoProtected && !echoNotifiedRef.current) {
      echoNotifiedRef.current = true;
      toast.info(copy.echo);
    }
  }, [live.echoProtected]);

  // Clear instant override timer
  useEffect(() => {
    if (!instantOverride) return;
    const delay = Math.max(0, instantOverride.until - Date.now());
    const timer = window.setTimeout(() => setInstantOverride(null), delay);
    return () => window.clearTimeout(timer);
  }, [instantOverride]);

  // Surface voice fallback as non-blocking toast
  useEffect(() => {
    if (live.fallback) toast.info(live.fallback);
  }, [live.fallback]);

  // Derive active teaching style (local pick takes precedence until next server style update)
  const currentStyle = live.classroom.lastStyle ?? selectedStyle ?? live.room?.style_id ?? "guided";

  // Elapsed active lesson clock (seeded from B1 active_ms, ticks only while active)
  const [extraActiveMs, setExtraActiveMs] = useState(0);
  const baseActiveMs = live.room?.active_ms ?? 0;
  const clockRunning = Boolean(
    live.started && live.connected && !live.classroom.paused && !live.recap && live.room?.status !== "done" && live.room?.status !== "abandoned",
  );
  useEffect(() => {
    if (!clockRunning) return;
    const timer = window.setInterval(() => {
      setExtraActiveMs((prev) => prev + 1000);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [clockRunning]);
  const totalElapsedMs = baseActiveMs + extraActiveMs;

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
    fatalError: Boolean(live.conflict || live.vaultLocked || (live.fatalError && !live.room)),
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
  const sentenceSeq = live.classroom.avatar.gen * 1000 + live.classroom.avatar.seg;
  const resolvedSituation = phaseToSituation(phase, {
    speaking: live.audioSpeaking,
    hasBoardEvent: live.classroom.avatar.pose === "board_guiding",
    quietCompanion,
    typingRecently,
    sentenceSeq,
  });

  // Synthesized sound cues (design-system §9)
  useEffect(() => {
    if (live.started && live.connected && !lastCueConnectRef.current) {
      lastCueConnectRef.current = true;
      soundCuesRef.current?.play("connect");
    }
  }, [live.started, live.connected]);

  useEffect(() => {
    if (phase === "awaiting" && live.classroom.askSeq !== undefined && live.classroom.askSeq !== lastCueAskSeqRef.current) {
      lastCueAskSeqRef.current = live.classroom.askSeq;
      soundCuesRef.current?.play("your_turn");
    }
  }, [phase, live.classroom.askSeq]);

  const verdictForCue =
    live.classroom.judge ??
    (live.previewVerdict?.askSeq === live.classroom.askSeq ? live.previewVerdict?.verdict : undefined);
  useEffect(() => {
    if (!verdictForCue || live.classroom.askSeq === undefined) return;
    const key = `${live.classroom.askSeq}:${verdictForCue}`;
    if (lastCueVerdictKeyRef.current === key) return;
    lastCueVerdictKeyRef.current = key;
    soundCuesRef.current?.play(verdictForCue === "correct" ? "correct" : "retry");
  }, [verdictForCue, live.classroom.askSeq]);

  useEffect(() => {
    if ((phase === "ending" || phase === "ended") && !lastCueEndRef.current) {
      lastCueEndRef.current = true;
      soundCuesRef.current?.play("lesson_end");
    }
  }, [phase]);

  // Seamless single-click entry when navigating from /plan-items/:itemId/lesson Lobby
  useEffect(() => {
    if (!fromLobby || autoStartConsumedRef.current) return;
    if (!live.connected || live.started || ended) return;
    if (phase !== "lobby" && phase !== "paused") return;
    autoStartConsumedRef.current = true;
    void startLesson(lobbyNavState?.autoStartAudio ?? true);
  }, [ended, fromLobby, live.connected, live.started, lobbyNavState?.autoStartAudio, phase, startLesson]);

  // Pre-warm reusable MicrophoneCapture AudioContext + AudioWorklet when entering a voice lesson
  const sttConfigured = Boolean(voice.data?.stt_configured);
  useEffect(() => {
    if (!live.started || !live.lastAudio || !sttConfigured) return;
    if (!capture.current) capture.current = new MicrophoneCapture();
    void capture.current.warmup();
  }, [live.started, live.lastAudio, sttConfigured]);

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
    if (live.classroom.judge) {
      if (live.classroom.judge === "correct") {
        consecutiveCorrectRef.current += 1;
        lastVerdictWasWrongRef.current = false;
      } else {
        consecutiveCorrectRef.current = 0;
        lastVerdictWasWrongRef.current = true;
      }
      const oneShot = verdictToOneShot(live.classroom.judge, consecutiveCorrectRef.current);
      if (oneShot) {
        videoRef.current?.triggerOneShot(oneShot, live.classroom.avatar.gen);
        return;
      }
    }
    if (action === "board_point") {
      if (!speakingRef.current) {
        videoRef.current?.triggerOneShot("board_point", live.classroom.avatar.gen);
      }
      return;
    }
    if (action === "think_chin") {
      videoRef.current?.triggerOneShot("hint", live.classroom.avatar.gen);
      return;
    }
    if (action === "praise_thumbs_up" || action === "praise_clap") {
      videoRef.current?.triggerOneShot("praise", live.classroom.avatar.gen);
      return;
    }
    if (action === "gentle_encourage") {
      videoRef.current?.triggerOneShot("comfort", live.classroom.avatar.gen);
      return;
    }
    videoRef.current?.triggerInstantAction(action, live.classroom.avatar.gen);
  }, [
    live.classroom.avatar.gestureSequence,
    live.classroom.avatar.instantAction,
    live.classroom.avatar.gen,
    live.classroom.judge,
  ]);

  // Trigger board_glance when board gains new content while teacher is silent (§4.1)
  const totalBoardBlocks = live.classroom.boardPages.reduce((sum, page) => sum + page.blocks.length, 0);
  useEffect(() => {
    const prev = lastBoardBlockCountRef.current;
    lastBoardBlockCountRef.current = totalBoardBlocks;
    if (prev > 0 && totalBoardBlocks > prev && live.started && !speakingRef.current) {
      videoRef.current?.triggerOneShot("board_glance", live.classroom.avatar.gen);
    }
  }, [totalBoardBlocks, live.started, live.classroom.avatar.gen]);

  // Release mic & warmed AudioContext cleanly when tab hides or unmounts
  useEffect(() => {
    const release = () => {
      if (!document.hidden) return;
      vadRequest.current += 1;
      down.current = false;
      micStarted.current = false;
      void capture.current?.dispose();
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
      void capture.current?.dispose();
      void vad.current?.destroy();
      capture.current = null;
    };
  }, []);

  const currentGen = live.classroom.avatar.gen;
  const interruptAll = useCallback(() => {
    markLearnerActivity();
    setInstantOverride(null);
    videoRef.current?.interrupt(currentGen);
    return live.interrupt();
  }, [currentGen, live, markLearnerActivity]);

  const surfaceMicError = useCallback((err: unknown) => {
    const kind = classifyMicrophoneError(err);
    setMicErrorKind(kind);
    if (kind === "permission_denied") {
      toast.error(copy.micDeniedTitle, {
        action: {
          label: copy.micHelpButton,
          onClick: () => setMicHelpOpen(true),
        },
      });
    } else if (kind === "not_found") {
      toast.error(copy.micNotFoundTitle);
    } else {
      toast.error(copy.micOtherTitle);
    }
  }, []);

  const finishMic = useCallback(() => {
    if (!down.current) return;
    down.current = false;
    setRecording(false);
    setMicLevel(0);
    void capture.current?.stop();
    if (micStarted.current) {
      live.send("microphone.end");
      soundCuesRef.current?.play("rec_end");
    }
    micStarted.current = false;
  }, [live]);

  const startMic = useCallback(async () => {
    if (down.current || !live.connected || !live.started || handsFree) return;
    down.current = true;
    setMicErrorKind(null);
    const interrupted = interruptAll();
    if (!speakingRef.current) {
      soundCuesRef.current?.play("rec_start", { ignoreSuppression: true });
    }
    setRecording(true);
    const mic = capture.current ?? new MicrophoneCapture();
    capture.current = mic;
    try {
      await mic.start(({ pcm16, level }) => {
        if (!down.current || capture.current !== mic) return;
        if (!micStarted.current) micStarted.current = live.send("microphone.start", { interrupted });
        setMicLevel(level);
        if (micStarted.current) live.upload(pcm16);
      });
      if (!down.current || capture.current !== mic) await mic.stop();
    } catch (err) {
      if (capture.current !== mic) return;
      surfaceMicError(err);
      down.current = false;
      setRecording(false);
      setMicLevel(0);
    }
  }, [handsFree, interruptAll, live, surfaceMicError]);

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
    setMicErrorKind(null);
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
    } catch (err) {
      if (request !== vadRequest.current) return;
      await stopVad();
      surfaceMicError(err);
    }
  }, [handsFree, handsFreeLoading, interruptAll, live, markLearnerActivity, stopVad, surfaceMicError]);

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

  const toggleViewMode = useCallback(() => {
    const next: StageViewMode = effectiveViewMode === "split" ? "board-first" : "split";
    setStoredViewMode(next);
    writeStoredViewMode(next);
  }, [effectiveViewMode]);

  const handleSoundCuesEnabledChange = useCallback((enabled: boolean) => {
    const updated = soundCuesRef.current?.setPrefs({ enabled });
    if (updated) setSoundCuePrefs(updated);
  }, []);

  const handleSoundCuesVolumeChange = useCallback((nextVolume: number) => {
    const updated = soundCuesRef.current?.setPrefs({ volume: nextVolume });
    if (updated) setSoundCuePrefs(updated);
  }, []);

  const handleQuickAction = useCallback(
    (kind: string) => {
      markLearnerActivity();
      live.interrupt();
      const instant = quickActionToInstantAction(kind);
      const oneShot = quickActionToOneShot(kind);
      if (oneShot) {
        if (oneShot !== "board_point" || !speakingRef.current) {
          triggerFastOneShot(oneShot, currentGen);
        }
      } else if (instant) {
        triggerFastAction(instant, currentGen);
      }
      const label = kind.startsWith("locate:")
        ? copy.locate
        : copy.quick[kind as keyof typeof copy.quick];
      if (label) {
        live.appendStudentEntry(label, "quick", label);
      }
      live.send("student.quick", instant ? { kind, recent_avatar_action: instant } : { kind });
    },
    [currentGen, live, markLearnerActivity, triggerFastAction, triggerFastOneShot],
  );

  const handleSubmitText = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      const trimmed = text.trim();
      if (!trimmed) return;
      interruptAll();
      setTypingRecently(false);
      live.appendStudentEntry(trimmed, "text");
      const ask = live.classroom.ask;
      const isReplyToAsk = Boolean(ask && !ask.widget);
      const sent = isReplyToAsk
        ? live.send("student.reply", { purpose: ask!.purpose, value: trimmed })
        : live.send("student.text", { text: trimmed });
      if (sent) {
        setText("");
        if (!isReplyToAsk) {
          videoRef.current?.triggerOneShot("ack", currentGen);
        }
      }
    },
    [currentGen, interruptAll, live, text],
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
    live.interrupt();
    videoRef.current?.triggerOneShot("farewell", currentGen);
    live.send("lesson.control", { action: "end" });
  }, [currentGen, finishMic, live, stopVad]);

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
      if (event.key === "?" && !event.ctrlKey && !event.metaKey && !isEditable(target)) {
        event.preventDefault();
        setShortcutsOpen((prev) => !prev);
        return;
      }
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
        if (lower === "t") {
          event.preventDefault();
          setTranscriptOpen((prev) => !prev);
          return;
        }
      }
      if (event.key === "Enter" && phase === "lobby" && live.connected && !isInteractive(target)) {
        event.preventDefault();
        void startLesson(true);
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
    startLesson,
    startMic,
    sttConfigured,
    toggleCaption,
  ]);

  // Chronologically merged in-memory transcript (never persisted)
  const combinedLog = useMemo(
    () => mergeTranscriptEntries(live.classroom.spokenLog, live.studentEntries),
    [live.classroom.spokenLog, live.studentEntries],
  );

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
    const allBlocks = classroom.boardPages.flatMap((page) => page.blocks);
    return (
      <RecapView
        lessonId={id}
        courseId={room.course_id}
        title={room.title}
        summary={typeof recap?.summary === "string" ? recap.summary : undefined}
        board={allBlocks}
        teacher={teacher}
        onResumed={onResumed}
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

  // Compute live flattened outline progress (B1 / §5.6.11)
  const outline = room.outline ?? [];
  const outlineProgress = (() => {
    if (outline.length === 0) return null;
    const total = outline.length;
    if (classroom.stage === "wrap" || classroom.stage === "done") {
      return { current: total, total, text: outline[total - 1]?.text ?? "" };
    }
    const segIdx = classroom.segIdx;
    const kpCursor = classroom.kpCursor;
    const matchIdx = outline.findIndex((pt) => pt.seg_idx === segIdx && pt.kp_idx === kpCursor);
    const current = matchIdx >= 0
      ? matchIdx + 1
      : Math.max(1, Math.min(total, room.progress?.current_index ?? 1));
    return { current, total, text: outline[current - 1]?.text ?? "" };
  })();

  const topbar = (
    <>
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        <button
          type="button"
          onClick={handleBackClick}
          className="inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-caption font-medium text-fg-secondary hover:bg-surface-card hover:text-fg-primary"
        >
          <ArrowLeft size={15} aria-hidden="true" />
          <span className="hidden sm:inline">{copy.back}</span>
        </button>
        <h1 className="truncate text-ui font-semibold text-fg-primary">{room.title}</h1>
        {outlineProgress ? (
          <div
            data-testid="lesson-outline-progress"
            className="hidden min-w-0 items-center gap-2 border-l border-line-subtle pl-3 md:flex"
          >
            <span className="flex shrink-0 items-center gap-0.5" aria-hidden="true">
              {outline.map((pt, idx) => (
                <span
                  key={`${pt.seg_idx}-${pt.kp_idx}-${idx}`}
                  className={
                    idx + 1 <= outlineProgress.current
                      ? "h-1.5 w-3.5 rounded-pill bg-accent"
                      : "h-1.5 w-3.5 rounded-pill bg-line-default"
                  }
                />
              ))}
            </span>
            <span className="truncate text-caption text-fg-secondary">
              {copy.pointProgress
                .replace("{current}", String(outlineProgress.current))
                .replace("{total}", String(outlineProgress.total))}
              {outlineProgress.text ? ` · ${outlineProgress.text}` : ""}
            </span>
          </div>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
        {adaptBanner ? (
          <span className="hidden md:inline-flex">
            <Badge tone="accent">
              <Sparkles size={12} aria-hidden="true" />
              <span>{adaptBanner}</span>
            </Badge>
          </span>
        ) : null}

        {live.started || totalElapsedMs > 0 ? (
          <span
            data-testid="lesson-elapsed-clock"
            className="hidden rounded-sm bg-surface-card px-2 py-1 text-caption tabular-nums text-fg-secondary sm:inline-block"
          >
            {formatClock(totalElapsedMs)}
          </span>
        ) : null}

        {/* Mobile dual-mode toggle (teacher <-> board) */}
        <button
          type="button"
          data-testid="mobile-view-toggle"
          aria-label={mobileView === "teacher" ? copy.mobileViewBoard : copy.mobileViewTeacher}
          onClick={() => setMobileView((prev) => (prev === "teacher" ? "board" : "teacher"))}
          className="inline-flex min-h-9 items-center gap-1 rounded-pill border border-line-subtle bg-surface-card px-2.5 text-caption font-medium text-fg-primary hover:border-accent md:hidden"
        >
          <span>{mobileView === "teacher" ? copy.mobileViewBoard : copy.mobileViewTeacher}</span>
        </button>

        {/* Desktop view switcher (split <-> board-first floating PiP) */}
        <button
          type="button"
          data-testid="view-mode-toggle"
          aria-label={copy.viewToggleHint}
          aria-pressed={effectiveViewMode === "board-first"}
          title={effectiveViewMode === "board-first" ? copy.viewSplit : copy.viewBoardFirst}
          onClick={toggleViewMode}
          className="hidden min-h-9 items-center gap-1.5 rounded-md border border-line-subtle bg-surface-card px-2.5 text-caption font-medium text-fg-secondary hover:text-fg-primary md:inline-flex"
        >
          {effectiveViewMode === "board-first" ? (
            <Monitor size={15} aria-hidden="true" />
          ) : (
            <PictureInPicture2 size={15} aria-hidden="true" />
          )}
          <span className="hidden xl:inline">
            {effectiveViewMode === "board-first" ? copy.viewSplit : copy.viewBoardFirst}
          </span>
        </button>

        {/* Topbar transcript button (always accessible on narrow widths / mobile) */}
        <button
          type="button"
          data-testid="topbar-transcript-toggle"
          aria-label={copy.transcriptTitle}
          aria-pressed={transcriptOpen}
          title={copy.transcriptTitle}
          onClick={() => setTranscriptOpen((prev) => !prev)}
          className="inline-flex min-h-9 min-w-9 items-center justify-center rounded-md border border-line-subtle bg-surface-card px-2 text-caption font-medium text-fg-secondary hover:text-fg-primary lg:hidden"
        >
          <MessageSquareText size={15} aria-hidden="true" />
        </button>

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
              className="hidden min-h-9 items-center gap-1.5 rounded-md border border-line-subtle bg-surface-card px-2.5 text-caption font-medium text-fg-secondary hover:text-fg-primary sm:inline-flex"
            >
              <Gauge size={15} aria-hidden="true" />
              <span className="hidden lg:inline">{copy.qualityTitle}</span>
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

        {/* Shortcuts help button */}
        <button
          type="button"
          data-testid="shortcuts-trigger"
          aria-label={copy.shortcutsTitle}
          title={copy.shortcutsTitle}
          onClick={() => setShortcutsOpen(true)}
          className="hidden min-h-9 min-w-9 items-center justify-center rounded-md border border-line-subtle bg-surface-card text-fg-secondary hover:text-fg-primary sm:inline-flex"
        >
          <HelpCircle size={15} aria-hidden="true" />
        </button>
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
              onClick={() => void startLesson(true)}
            >
              {copy.startVoice}
            </Button>
            <Button
              variant="secondary"
              disabled={!connected}
              onClick={() => void startLesson(false)}
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
              onClick={() => void startLesson(live.lastAudio)}
            >
              {copy.resumeLesson}
            </Button>
          </div>
          <button
            type="button"
            disabled={!connected}
            onClick={() => void startLesson(!live.lastAudio)}
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
      if (live.vaultLocked) {
        return (
          <div
            data-testid="stage-overlay-locked"
            className="absolute inset-0 z-overlay flex flex-col items-center justify-center gap-3 rounded-lg bg-scrim p-5 text-center backdrop-blur-xs"
          >
            <p className="text-ui font-medium text-fg-primary" role="alert">
              {copy.serviceRestartLocked}
            </p>
            <Button
              variant="primary"
              size="sm"
              onClick={() => void queries.invalidateQueries({ queryKey: sessionKey })}
            >
              {copy.unlockNow}
            </Button>
          </div>
        );
      }
      if (live.conflict === "other_tab") {
        return (
          <div
            data-testid="stage-overlay-conflict"
            className="absolute inset-0 z-overlay flex flex-col items-center justify-center gap-3 rounded-lg bg-scrim p-5 text-center backdrop-blur-xs"
          >
            <p className="text-ui font-medium text-fg-primary" role="alert">
              {copy.otherTab}
            </p>
            <div className="flex flex-wrap justify-center gap-2">
              <Button
                variant="primary"
                size="sm"
                onClick={() => void live.reconnect({ takeover: true })}
              >
                {copy.takeoverHere}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void navigate(`/courses/${room.course_id}`)}
              >
                {copy.backToCourse}
              </Button>
            </div>
          </div>
        );
      }
      if (live.conflict === "taken_over") {
        return (
          <div
            data-testid="stage-overlay-taken-over"
            className="absolute inset-0 z-overlay flex flex-col items-center justify-center gap-3 rounded-lg bg-scrim p-5 text-center backdrop-blur-xs"
          >
            <p className="text-body font-semibold text-fg-primary">{copy.takenOver}</p>
            <p className="max-w-[260px] text-caption text-fg-secondary">{copy.takenOverHint}</p>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void navigate(`/courses/${room.course_id}`)}
            >
              {copy.backToCourse}
            </Button>
          </div>
        );
      }
      return (
        <div
          data-testid="stage-overlay-failed"
          className="absolute inset-0 z-overlay flex flex-col items-center justify-center gap-3 rounded-lg bg-scrim p-5 text-center backdrop-blur-xs"
        >
          <p className="text-ui font-medium text-fg-primary" role="alert">
            {error || copy.connectionError}
          </p>
          <div className="flex flex-wrap justify-center gap-2">
            <Button
              variant="primary"
              size="sm"
              leftIcon={<RefreshCw size={14} />}
              onClick={() => void (connected ? startLesson(live.lastAudio) : live.reconnect())}
            >
              {copy.retryNow}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void navigate(`/courses/${room.course_id}`)}
            >
              {copy.backToCourse}
            </Button>
          </div>
        </div>
      );
    }

    if (phase === "connecting") {
      return (
        <div
          data-testid="stage-overlay-connecting"
          className="absolute inset-0 z-overlay flex flex-col items-center justify-center gap-3 rounded-lg bg-scrim p-5 text-center backdrop-blur-xs"
        >
          <Spinner size={26} />
          <p className="text-ui font-medium text-fg-primary">{copy.connectingLesson}</p>
        </div>
      );
    }

    return null;
  })();

  const stageNode = (
    <>
      <div className="relative flex h-full min-h-0 flex-none items-center justify-center sm:w-full sm:flex-1">
        {teacherConfig ? (
          <TutorVideoBox
            ref={videoRef}
            config={teacherConfig}
            pose={resolvedPose}
            situation={resolvedSituation}
            sentenceSeq={sentenceSeq}
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
        {/* In mobile board mode, tapping the small teacher PiP returns to teacher mode */}
        {isMobile && mobileView === "board" && !stageOverlay ? (
          <button
            type="button"
            data-testid="mobile-pip-restore"
            aria-label={copy.mobileBackTeacher}
            onClick={() => setMobileView("teacher")}
            className="absolute inset-0 z-sticky rounded-md bg-transparent"
          />
        ) : null}
      </div>

      {/* Text mode: read-only teacher speech log + pacing controls (§5.6.5) */}
      {textMode ? (
        <section
          data-testid="text-mode-log"
          aria-label={copy.teacherSaid}
          className="flex h-full min-w-0 flex-1 flex-col rounded-md border border-line-subtle bg-surface-card sm:h-[176px] sm:w-full sm:flex-none sm:shrink-0"
        >
          <header className="flex flex-wrap items-center justify-between gap-1.5 border-b border-line-subtle px-2.5 py-1.5 sm:px-3">
            <span className="inline-flex min-w-0 items-center gap-1.5 text-caption font-semibold text-fg-secondary">
              <MessageSquareText size={13} aria-hidden="true" className="shrink-0" />
              <span className="truncate">{copy.teacherSaid}</span>
            </span>
            <div className="flex shrink-0 items-center gap-1">
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

  const micErrorBanner = micErrorKind ? (
    <div
      role="alert"
      data-testid="mic-error-banner"
      className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-warn/30 bg-warn-soft px-4 py-2 text-caption text-warn-text"
    >
      <div className="grid gap-0.5">
        <strong className="font-semibold">
          {micErrorKind === "permission_denied"
            ? copy.micDeniedTitle
            : micErrorKind === "not_found"
              ? copy.micNotFoundTitle
              : copy.micOtherTitle}
        </strong>
        <span>
          {micErrorKind === "permission_denied"
            ? copy.micDeniedBody
            : micErrorKind === "not_found"
              ? copy.micNotFoundBody
              : copy.micOtherBody}
        </span>
      </div>
      <div className="flex items-center gap-2">
        {micErrorKind === "permission_denied" ? (
          <Button variant="secondary" size="sm" onClick={() => setMicHelpOpen(true)}>
            {copy.micHelpButton}
          </Button>
        ) : null}
        <Button variant="ghost" size="sm" onClick={() => setMicErrorKind(null)}>
          {copy.dismissNotice}
        </Button>
      </div>
    </div>
  ) : null;

  const mobilePreviewBanner =
    isMobile && mobileView === "teacher" ? (
      <button
        type="button"
        data-testid="mobile-expand-board"
        onClick={() => setMobileView("board")}
        className="flex shrink-0 items-center justify-between gap-2 border-b border-line-subtle bg-surface-sunken px-3.5 py-2 text-caption font-medium text-fg-primary"
      >
        <span>{copy.board}</span>
        <span className="inline-flex items-center gap-1 text-accent-strong">
          <span>{copy.mobileOpenBoard}</span>
          <ChevronRight size={14} aria-hidden="true" />
        </span>
      </button>
    ) : null;

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
            onClick={() => void (connected ? startLesson(live.lastAudio) : live.reconnect())}
          >
            {copy.retry}
          </Button>
        </div>
      ) : null}

      {micErrorBanner}

      <BoardPanel
        title={room.title}
        stage={classroom.stage}
        estMinutes={room.est_minutes}
        outline={outline}
        board={[...classroom.board]}
        pages={classroom.boardPages}
        dividers={[...classroom.dividers]}
        answeredCards={[...classroom.answeredCards]}
        activeBlockId={classroom.activeBlockId}
        activePoint={classroom.activePoint}
        latestMarkSeq={classroom.latestMarkSeq}
        trayOpen={showTray}
        ready={ready}
        reducedMotion={reducedMotion}
        trayKey={`${showTray ? "open" : "closed"}:${classroom.askSeq ?? 0}:${activeVerdict ?? ""}`}
        topBanner={mobilePreviewBanner}
        onLocate={(target) => {
          if (ready) handleQuickAction(`locate:${target}`);
        }}
        onSaveToNote={(block) => {
          void addNoteBlock(room.course_id, "quick", {
            block_type: block.type,
            title: block.title ?? room.title,
            content: block.content,
            source_ref: { kind: "lesson", lesson_id: id },
            default_title: t.notes.defaultQuickTitle,
          })
            .then(() => {
              void queries.invalidateQueries({ queryKey: notesKeys.list(room.course_id), exact: true });
              toast.success(copy.boardSavedToNote);
            })
            .catch(() => {
              toast.error(t.common.error);
            });
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
            if (dont_know) {
              consecutiveCorrectRef.current = 0;
              lastVerdictWasWrongRef.current = true;
              triggerFastOneShot("comfort", currentGen);
            }
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
            if (value === "easier") {
              triggerFastOneShot("comfort", currentGen);
            } else if (value === "end") {
              videoRef.current?.triggerOneShot("farewell", currentGen);
            } else if (value === "continue" && lastVerdictWasWrongRef.current) {
              lastVerdictWasWrongRef.current = false;
              triggerFastOneShot("encourage", currentGen);
            }
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
      transcriptOpen={transcriptOpen}
      volume={volume}
      muted={muted}
      soundCuesEnabled={soundCuePrefs.enabled}
      soundCuesVolume={soundCuePrefs.volume}
      currentStyle={currentStyle}
      onTextChange={handleTextChange}
      onSubmitText={handleSubmitText}
      onMicPointerDown={handleMicPointerDown}
      onMicPointerUp={finishMic}
      onMicKey={handleMicKey}
      onToggleHandsFree={() => void toggleVad()}
      onInterrupt={() => void interruptAll()}
      onQuickAction={handleQuickAction}
      onToggleCaption={toggleCaption}
      onToggleTranscript={() => setTranscriptOpen((prev) => !prev)}
      onVolumeChange={setVolume}
      onToggleMute={() => setMuted((prev) => !prev)}
      onSoundCuesEnabledChange={handleSoundCuesEnabledChange}
      onSoundCuesVolumeChange={handleSoundCuesVolumeChange}
      onStyleChange={setSelectedStyle}
      onPause={handlePause}
      onRequestEnd={() => setEndOpen(true)}
    />
  );

  const dockedTranscriptNode = (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-line-subtle px-4 py-3">
        <span className="inline-flex items-center gap-1.5 text-ui font-semibold text-fg-primary">
          <MessageSquareText size={15} aria-hidden="true" />
          <span>{copy.transcriptTitle}</span>
        </span>
      </header>
      <div className="min-h-0 flex-1 overflow-hidden">
        <TranscriptPanel
          entries={combinedLog}
          teacherName={teacher?.name}
          recording={recording}
          liveTranscript={live.transcript}
          reducedMotion={reducedMotion}
          compact
        />
      </div>
    </div>
  );

  return (
    <>
      <StageShell
        phase={phase}
        textMode={textMode}
        viewMode={effectiveViewMode}
        mobileView={mobileView}
        trayOpen={showTray}
        transcript={dockedTranscriptNode}
        transcriptDocked={isWideDesktop && transcriptOpen}
        className={fromLobby ? "cs-stage-connecting" : undefined}
        topbar={topbar}
        stage={stageNode}
        board={boardNode}
        dock={dockNode}
      />

      {/* Full transcript drawer on viewports < 1600px */}
      <Drawer
        open={!isWideDesktop && transcriptOpen}
        onOpenChange={setTranscriptOpen}
        title={copy.transcriptTitle}
        side="right"
        closeLabel={copy.close}
        testId="transcript-drawer"
      >
        <TranscriptPanel
          entries={combinedLog}
          teacherName={teacher?.name}
          recording={recording}
          liveTranscript={live.transcript}
          reducedMotion={reducedMotion}
        />
      </Drawer>

      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />

      <Dialog
        open={micHelpOpen}
        onOpenChange={setMicHelpOpen}
        title={copy.micHelpTitle}
        description={copy.micDeniedBody}
        size="sm"
        closeLabel={copy.close}
      >
        <ol className="m-0 grid list-none gap-2.5 p-0 text-ui text-fg-primary">
          <li>{copy.micHelpStep1}</li>
          <li>{copy.micHelpStep2}</li>
          <li>{copy.micHelpStep3}</li>
        </ol>
      </Dialog>

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
  const [resumeCount, setResumeCount] = useState(0);
  return (
    <Lesson
      key={`${lessonId}:${resumeCount}`}
      id={lessonId}
      onResumed={() => setResumeCount((count) => count + 1)}
    />
  );
}
