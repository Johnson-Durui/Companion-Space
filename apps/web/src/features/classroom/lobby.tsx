import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router";
import type { LessonPhase } from "@companion-space/avatar-engine/types";
import { TutorVideoBox } from "@companion-space/avatar-engine/video-box";
import "@companion-space/avatar-engine/video-box.css";
import { api, bodyOf, classroomErrorMessage, errorCodeOf } from "../../app/api";
import { Loading } from "../../app/ui";
import {
  ArrowLeft,
  Badge,
  Button,
  ErrorState,
  Mic,
  RefreshCw,
  Spinner,
  Toaster,
  TooltipProvider,
  toast,
} from "../../ui";
import t from "../../locales/zh-CN.json";
import { toVideoAvatarConfig, videoBoxLabels } from "../characters/video-config";
import { VoicePreview } from "../onboarding/voice-preview";
import { getReview } from "../review/api";
import { ReviewCardRunner } from "../review/review-card-runner";
import {
  fetchPlanItemPrepareStatus,
  openPlanItemLesson,
  preparePlanItem,
} from "./lesson-api";

const copy = t.classroom;

function formatWait(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(safe / 60);
  const rem = safe % 60;
  return `${mins}:${String(rem).padStart(2, "0")}`;
}

function LobbyWarmup({
  courseId,
  planItemId,
}: {
  courseId: string;
  planItemId: string;
}) {
  const queries = useQueryClient();
  const [skipped, setSkipped] = useState(false);
  const [cursor, setCursor] = useState(0);

  const queue = useQuery({
    queryKey: ["lobby-warmup-snapshot", courseId, planItemId],
    queryFn: () => getReview(courseId, planItemId),
    enabled: Boolean(courseId) && !skipped,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });

  const cards = (queue.data?.cards ?? []).slice(0, 5);
  const card = skipped || cursor >= cards.length ? undefined : cards[cursor];
  if (skipped || (!queue.isPending && !card)) return null;

  return (
    <section
      data-testid="lobby-warmup"
      aria-label={copy.warmupHeading}
      className="mx-auto mt-5 w-full max-w-[920px] rounded-lg border border-line-subtle bg-surface-card p-4"
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-line-subtle pb-2.5">
        <div className="flex items-center gap-2">
          <h2 className="text-ui font-semibold text-fg-primary">{copy.warmupHeading}</h2>
          <span className="text-caption text-fg-secondary">{copy.warmupLimitHint}</span>
        </div>
        <Button variant="ghost" size="sm" onClick={() => setSkipped(true)}>
          {copy.skipWarmup}
        </Button>
      </div>

      {queue.isPending ? (
        <Loading />
      ) : card ? (
        <ReviewCardRunner
          key={card.id}
          card={card}
          nextLabel={cursor + 1 >= cards.length ? t.loopViz.reviewFinish : t.loopViz.reviewNextCard}
          onSettled={() => {
            void queries.invalidateQueries({ queryKey: ["courses", courseId, "review"] });
            void queries.invalidateQueries({ queryKey: ["courses", courseId, "mistakes"] });
          }}
          onAdvance={() => setCursor((idx) => idx + 1)}
        />
      ) : null}
    </section>
  );
}

export default function LessonLobby() {
  const { itemId = "" } = useParams();
  const navigate = useNavigate();
  const queries = useQueryClient();
  const mountedAtRef = useRef<number>(0);
  const [waitSec, setWaitSec] = useState(0);
  const [connecting, setConnecting] = useState(false);
  const [openError, setOpenError] = useState("");
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    mountedAtRef.current = Date.now();
  }, [itemId]);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    const previous = meta?.content;
    if (meta) meta.content = "#0E1116";
    return () => {
      if (meta && previous) meta.content = previous;
    };
  }, []);

  const triggerPrepare = useMutation({
    mutationFn: () => preparePlanItem(itemId),
    onSuccess: (data) => {
      queries.setQueryData(["plan-item-prepare-status", itemId], data);
    },
  });
  const { mutate: runPrepare } = triggerPrepare;

  useEffect(() => {
    if (!itemId) return;
    runPrepare();
  }, [itemId, runPrepare]);

  const statusQuery = useQuery({
    queryKey: ["plan-item-prepare-status", itemId],
    queryFn: () => fetchPlanItemPrepareStatus(itemId),
    enabled: Boolean(itemId),
    refetchInterval: (query) => {
      const st = query.state.data?.status;
      return !st || st === "preparing" ? 1200 : false;
    },
  });

  const voice = useQuery({
    queryKey: ["voice-status"],
    queryFn: async () => bodyOf(await api.GET("/api/v2/voice/status")),
  });

  const data = statusQuery.data;
  const status = data?.status ?? "preparing";
  const isPreparing = status === "preparing";
  const isReady = status === "ready" || status === "has_lesson";
  const isFailed = status === "failed";
  const isMissing = status === "missing";

  // Redirect cleanly if plan was replanned and this item is gone
  const missingHandledRef = useRef(false);
  useEffect(() => {
    if (!isMissing || missingHandledRef.current) return;
    missingHandledRef.current = true;
    toast.info(copy.planUpdated);
    void navigate(data?.course_id ? `/courses/${data.course_id}` : "/courses", { replace: true });
  }, [data?.course_id, isMissing, navigate]);

  // Tick elapsed wait clock while preparing (NO percentage!)
  useEffect(() => {
    if (!isPreparing) return;
    const startMs = data?.started_at ? Date.parse(data.started_at) : mountedAtRef.current;
    const baseMs = Number.isFinite(startMs) && startMs > 0 ? startMs : mountedAtRef.current;
    const update = () => {
      setWaitSec(Math.max(0, Math.floor((Date.now() - baseMs) / 1000)));
    };
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [data?.started_at, isPreparing]);

  const existingLessonId = data?.lesson_id ?? null;
  const teacher = data?.teacher ?? null;

  const handleStart = useCallback(
    async (withAudio: boolean) => {
      if (!isReady || connecting) return;
      setOpenError("");
      setConnecting(true);
      try {
        let lessonId = existingLessonId;
        if (!lessonId) {
          const opened = await openPlanItemLesson(itemId);
          lessonId = opened.id;
        }
        // Brief connect transition before entering classroom stage (340ms)
        if (!reducedMotion) {
          await new Promise((resolve) => window.setTimeout(resolve, 340));
        }
        void navigate(`/lessons/${lessonId}`, {
          replace: true,
          state: { fromLobby: true, autoStartAudio: withAudio },
        });
      } catch (err) {
        setConnecting(false);
        if (errorCodeOf(err) === "lesson_preparing") {
          void queries.invalidateQueries({ queryKey: ["plan-item-prepare-status", itemId] });
          return;
        }
        setOpenError(classroomErrorMessage(err, copy.actionError));
      }
    },
    [connecting, existingLessonId, isReady, itemId, navigate, queries, reducedMotion],
  );

  // Enter triggers primary start button once ready (§5.6.3)
  useEffect(() => {
    if (!isReady || connecting) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Enter") return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select" || tag === "button" || tag === "a") return;
      event.preventDefault();
      void handleStart(true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [connecting, handleStart, isReady]);

  const labels = useMemo(() => videoBoxLabels(), []);
  const teacherConfig = useMemo(
    () => (teacher ? toVideoAvatarConfig(teacher, reducedMotion) : null),
    [teacher, reducedMotion],
  );

  const phase: LessonPhase = connecting
    ? "connecting"
    : isPreparing
      ? "preparing"
      : isFailed
        ? "failed"
        : "lobby";
  const statusLabel = connecting
    ? copy.connectingLesson
    : isPreparing
      ? copy.preparingTitle
      : isFailed
        ? copy.failed
        : copy.waitingStart;

  const sttConfigured = Boolean(voice.data?.stt_configured);
  const outline = data?.outline ?? [];
  const backTarget = data?.course_id ? `/courses/${data.course_id}` : "/courses";

  return (
    <TooltipProvider>
      <div
        data-surface="stage"
        data-phase={phase}
        data-testid="lesson-lobby"
        className="flex min-h-[100dvh] w-full flex-col bg-surface-page text-fg-primary"
        style={{
          backgroundImage:
            "radial-gradient(58% 60% at 18% 42%, color-mix(in oklab, var(--accent-on-dark) 16%, transparent), transparent 72%), radial-gradient(46% 52% at 86% 14%, color-mix(in oklab, var(--accent-on-dark) 9%, transparent), transparent 70%), radial-gradient(rgb(255 255 255 / 0.045) 1px, transparent 1px)",
          backgroundSize: "100% 100%, 100% 100%, 28px 28px",
        }}
      >
        <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-line-subtle bg-surface-card/65 px-4 text-fg-secondary backdrop-blur-md">
          <Link
            to={backTarget}
            className="inline-flex min-h-9 items-center gap-1.5 rounded-md px-2 py-1 text-caption font-medium text-fg-secondary hover:bg-surface-card hover:text-fg-primary"
          >
            <ArrowLeft size={15} aria-hidden="true" />
            <span>{copy.back}</span>
          </Link>
          {isPreparing ? (
            <Badge tone="neutral" data-testid="lobby-wait-badge">
              <Spinner size={12} />
              <span>{copy.waitedFor.replace("{time}", formatWait(waitSec))}</span>
            </Badge>
          ) : null}
        </header>

        <main id="main" className="mx-auto flex w-full max-w-[960px] flex-1 flex-col justify-center px-4 pb-8 pt-2">
          {statusQuery.isError && !data ? (
            <ErrorState
              title={copy.failed}
              message={classroomErrorMessage(statusQuery.error, copy.connectionError)}
              onRetry={() => {
                void statusQuery.refetch();
                triggerPrepare.mutate();
              }}
            />
          ) : (
            <>
              <div className="grid items-center gap-6 md:grid-cols-[minmax(240px,310px)_minmax(0,1fr)]">
                {/* Enlarged teacher video card */}
                <div
                  data-testid="lobby-stage"
                  className="mx-auto flex h-[390px] w-[220px] items-center justify-center sm:h-[480px] sm:w-[270px] md:h-[520px] md:w-[292px]"
                >
                  {teacherConfig ? (
                    <TutorVideoBox
                      config={teacherConfig}
                      pose={isPreparing ? "thinking" : "idle_companion"}
                      situation={isPreparing ? "preparing" : isFailed ? "frozen" : "idle"}
                      phase={phase}
                      emotion={isPreparing ? "focused" : "warm"}
                      gen={0}
                      statusLabel={statusLabel}
                      caption={isPreparing ? copy.preparingTeacherHint : undefined}
                      captionVisible={isPreparing}
                      stageMode
                      labels={labels}
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center rounded-lg border border-line-subtle bg-surface-card">
                      <Spinner size={26} />
                    </div>
                  )}
                </div>

                {/* Right info + controls panel */}
                <div className="grid gap-5 rounded-xl border border-line-subtle bg-surface-card/90 p-6 shadow-3 backdrop-blur-md">
                  <div className="grid gap-2">
                    {isReady ? (
                      <div>
                        <Badge tone="ok">{t.richUi.lobbyReadyTag}</Badge>
                      </div>
                    ) : null}
                    <h1 className="text-display font-semibold text-fg-primary leading-tight">
                      {data?.title || t.app.titles.lessonLobby}
                    </h1>
                    {data?.est_minutes ? (
                      <p className="text-ui tabular-nums text-fg-secondary">
                        {copy.estMinutes.replace("{min}", String(data.est_minutes))}
                      </p>
                    ) : null}
                  </div>

                  {/* Outline points (appear once lesson plan is ready) */}
                  {outline.length > 0 ? (
                    <div data-testid="lobby-outline" className="grid gap-2.5 rounded-lg border border-line-subtle bg-surface-sunken/85 p-4">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-caption font-semibold text-fg-secondary">{copy.outlineHeading}</p>
                        <span className="text-caption text-fg-tertiary">{t.richUi.lobbyOutlineSub}</span>
                      </div>
                      <ol className="m-0 grid gap-2 p-0 list-none text-ui text-fg-primary">
                        {outline.map((pt, idx) => (
                          <li
                            key={`${pt.seg_idx}-${pt.kp_idx}-${idx}`}
                            className="flex items-start gap-2.5"
                          >
                            <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-line-default bg-surface-card font-mono text-[11px] font-semibold text-accent-strong">
                              {String(idx + 1).padStart(2, "0")}
                            </span>
                            <span>{pt.text}</span>
                          </li>
                        ))}
                      </ol>
                    </div>
                  ) : isPreparing ? (
                    <div
                      data-testid="lobby-preparing-card"
                      className="flex items-start gap-3 rounded-md border border-accent/25 bg-accent-soft/40 p-4"
                    >
                      <Spinner size={18} />
                      <div className="grid gap-1">
                        <p className="text-ui font-medium text-fg-primary">
                          {copy.preparingTitle} · {copy.waitedFor.replace("{time}", formatWait(waitSec))}
                        </p>
                        <p className="text-caption text-fg-secondary">{copy.preparingTeacherHint}</p>
                      </div>
                    </div>
                  ) : null}

                  {/* Preparation failure state */}
                  {isFailed ? (
                    <div
                      role="alert"
                      data-testid="lobby-prepare-failed"
                      className="grid gap-3 rounded-md border border-danger/40 bg-danger-soft p-4"
                    >
                      <p className="text-ui font-medium text-danger-text">
                        {(data?.error_code && t.errors[data.error_code as keyof typeof t.errors]) ||
                          copy.prepareFailed}
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          variant="primary"
                          size="sm"
                          pending={triggerPrepare.isPending}
                          leftIcon={<RefreshCw size={14} />}
                          onClick={() => triggerPrepare.mutate()}
                        >
                          {t.common.retry}
                        </Button>
                        <a
                          href="/settings/ai"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex min-h-9 items-center rounded-md border border-line-default bg-surface-card px-3 text-caption font-medium text-fg-primary hover:bg-surface-sunken"
                        >
                          {copy.checkAiService}
                        </a>
                      </div>
                    </div>
                  ) : null}

                  {/* Voice preview & STT availability hint */}
                  <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line-subtle pt-4">
                    {data?.teacher ? <VoicePreview id={data.teacher.id} /> : <span />}
                    {!sttConfigured ? (
                      <div className="flex flex-wrap items-center gap-2 text-caption text-fg-secondary">
                        <Mic size={14} aria-hidden="true" />
                        <span>{copy.sttMissingNote}</span>
                        <a
                          href="/settings/voice"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-medium text-accent-strong hover:underline"
                        >
                          {copy.enableStt}
                        </a>
                      </div>
                    ) : null}
                  </div>

                  {/* Start buttons (disabled with reason while preparing) */}
                  <div className="grid gap-2">
                    <div className="flex flex-wrap items-center gap-3">
                      <Button
                        variant="primary"
                        size="lg"
                        disabled={!isReady || connecting}
                        pending={connecting}
                        onClick={() => void handleStart(true)}
                      >
                        {copy.startVoice}
                      </Button>
                      <Button
                        variant="secondary"
                        size="lg"
                        disabled={!isReady || connecting}
                        onClick={() => void handleStart(false)}
                      >
                        {copy.startText}
                      </Button>
                    </div>
                    {isPreparing ? (
                      <p className="text-caption text-fg-tertiary">{copy.readyToStartHint}</p>
                    ) : null}
                    {openError ? (
                      <p role="alert" className="text-caption text-danger-text">
                        {openError}
                      </p>
                    ) : null}
                  </div>
                </div>
              </div>

              {/* Embedded warmup cards (hidden automatically when 0 due cards) */}
              {data?.course_id ? (
                <LobbyWarmup courseId={data.course_id} planItemId={itemId} />
              ) : null}
            </>
          )}
        </main>
      </div>
      <Toaster />
    </TooltipProvider>
  );
}
