import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import clsx from "clsx";
import { browserApiFetch } from "@companion-space/api-client";
import { ensureOK, publicMessage } from "../../app/api";
import { Loading, Problem } from "../../app/ui";
import { FocusShell } from "../../shell/FocusShell";
import {
  ArrowLeft,
  ArrowRight,
  Badge,
  Button,
  Card,
  Check,
  CheckCircle2,
  ChoiceCardGroup,
  Clock,
  ConfirmDialog,
  Flag,
  Play,
  RefreshCw,
  ScoreRing,
  TextInput,
  TutorAvatar,
  Volume2,
  XCircle,
  toast,
} from "../../ui";
import t from "../../locales/zh-CN.json";
import { courseKeys } from "../courses/api";
import { planItemDisplayTitle } from "../plan/item-kind";
import { progressKeys } from "../progress/api";
import { useActiveTutor } from "../tutors/use-active-tutor";
import { useTutorSpeech } from "../voice/use-tutor-speech";

const copy = t.practice;
const viz = t.loopViz;

type PracticeOption = { key: string; text: string };
type Item = {
  id: string;
  kp_id?: string | null;
  kp_name?: string;
  type: string;
  stem: string;
  options?: Record<string, string> | PracticeOption[];
  answer_saved?: boolean;
  saved_answer?: string | string[] | number | null;
};
type Move = "SHOW_SOLUTION" | "REEXPLAIN" | "CHECK";
type Debrief = {
  item_id: string;
  kp_id?: string | null;
  kp_name?: string;
  type?: string;
  stem?: string;
  learner_answer?: unknown;
  verdict: string;
  score: number;
  max_score: number;
  answer: unknown;
  solution: string;
  moves: Move[];
};
type Commentary = {
  available: boolean;
  commentary: string | null;
  code?: string | null;
  reason: string | null;
  browser_voice?: { lang?: string; voice_id?: string; rate?: number; pitch?: number };
};
type Preview = {
  plan_item_id: string;
  course_id: string;
  kind: "practice" | "mock";
  title: string;
  est_minutes: number;
  item_count: number;
  kp_names: string[];
  active_run_id: string | null;
  submitted_run_id: string | null;
};
type Run = {
  id: string;
  space_id: string;
  kind: "practice" | "mock";
  status: string;
  deadline_at: string;
  score?: number;
  max_score?: number;
  items: Item[];
  debrief?: Debrief[];
};
type SaveState = "idle" | "saving" | "saved" | "failed";

async function request<T>(path: string, init?: RequestInit) {
  const response = await browserApiFetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const body = await response.json();
  ensureOK(response, body);
  return body as T;
}

function itemOptions(item: Item): PracticeOption[] {
  if (!item.options) return [];
  return Array.isArray(item.options)
    ? item.options
    : Object.entries(item.options).map(([key, text]) => ({ key, text }));
}

function formatAnswerValue(val: unknown): string {
  if (val === undefined || val === null || val === "") return viz.practiceUnanswered;
  if (Array.isArray(val)) return val.length ? val.join(", ") : viz.practiceUnanswered;
  return String(val);
}

function formatTimer(seconds: number): string {
  const safe = Math.max(0, seconds);
  const mins = Math.floor(safe / 60);
  const rem = safe % 60;
  return `${mins}:${String(rem).padStart(2, "0")}`;
}

function indexStorageKey(runId: string) {
  return `cs:practice:idx:${runId}`;
}

function readStoredIndex(runId: string, maxLen: number): number {
  try {
    const raw = window.sessionStorage.getItem(indexStorageKey(runId));
    const parsed = raw ? Number(raw) : 0;
    return Number.isInteger(parsed) && parsed >= 0 && parsed < maxLen ? parsed : 0;
  } catch {
    return 0;
  }
}

function writeStoredIndex(runId: string, idx: number) {
  try {
    window.sessionStorage.setItem(indexStorageKey(runId), String(idx));
  } catch {
    // Ignore storage errors
  }
}

function restoreAnswersFromRun(run: Run): {
  answers: Record<string, string | string[]>;
  saveStates: Record<string, SaveState>;
} {
  const answers: Record<string, string | string[]> = {};
  const saveStates: Record<string, SaveState> = {};
  for (const item of run.items) {
    if (item.saved_answer !== undefined && item.saved_answer !== null) {
      answers[item.id] = Array.isArray(item.saved_answer)
        ? item.saved_answer.map(String)
        : String(item.saved_answer);
      saveStates[item.id] = "saved";
    }
  }
  return { answers, saveStates };
}

function speakFallbackBrowser(text: string, voice?: Commentary["browser_voice"]) {
  if (!("speechSynthesis" in window) || typeof SpeechSynthesisUtterance === "undefined") return;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = voice?.lang ?? "zh-CN";
  utterance.rate = voice?.rate ?? 1;
  utterance.pitch =
    voice?.pitch === undefined ? 1 : Math.max(0, Math.min(2, 1 + voice.pitch / 100));
  utterance.voice =
    window.speechSynthesis.getVoices().find((candidate) => candidate.name === voice?.voice_id) ??
    null;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utterance);
}

export default function Practice() {
  const itemId = useParams().itemId ?? "";
  const queries = useQueryClient();
  const { tutor } = useActiveTutor();
  const speech = useTutorSpeech();
  const autoSubmitted = useRef(false);
  const oneMinWarned = useRef(false);

  const [run, setRun] = useState<Run>();
  const [currentIdx, setCurrentIdx] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  const [flagged, setFlagged] = useState<Record<string, boolean>>({});
  const [saveStates, setSaveStates] = useState<Record<string, SaveState>>({});
  const [saveErrors, setSaveErrors] = useState<Record<string, unknown>>({});
  const [seconds, setSeconds] = useState(-1);
  const [liveTimerAnnouncement, setLiveTimerAnnouncement] = useState("");
  const [confirmSubmitOpen, setConfirmSubmitOpen] = useState(false);
  const [commentary, setCommentary] = useState<Record<string, Commentary>>({});
  const [commentaryError, setCommentaryError] = useState<Record<string, string>>({});

  const preview = useQuery({
    queryKey: ["practice-preview", itemId],
    queryFn: () => request<Preview>(`/api/v2/plan-items/${encodeURIComponent(itemId)}/practice/preview`),
    enabled: Boolean(itemId),
  });

  // Automatically restore an active or submitted run on page reload (B7)
  const existingRunId = preview.data?.active_run_id || preview.data?.submitted_run_id || null;
  const restoredRun = useQuery({
    queryKey: ["practice-run", existingRunId],
    queryFn: () => request<Run>(`/api/v2/practice/${encodeURIComponent(existingRunId!)}`),
    enabled: Boolean(existingRunId) && !run,
  });

  const hydratedRunIdRef = useRef<string | null>(null);
  const hydrateRun = (loaded: Run) => {
    if (hydratedRunIdRef.current === loaded.id && run?.status === loaded.status) return;
    hydratedRunIdRef.current = loaded.id;
    setRun(loaded);
    const restored = restoreAnswersFromRun(loaded);
    setAnswers(restored.answers);
    setSaveStates(restored.saveStates);
    setCurrentIdx(readStoredIndex(loaded.id, loaded.items.length));
  };

  useEffect(() => {
    if (restoredRun.data && !run) {
      const timer = window.setTimeout(() => hydrateRun(restoredRun.data), 0);
      return () => window.clearTimeout(timer);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restoredRun.data, run]);

  const start = useMutation({
    mutationFn: () =>
      request<Run>(`/api/v2/plan-items/${encodeURIComponent(itemId)}/practice`, {
        method: "POST",
        body: "{}",
      }),
    onSuccess: (loaded) => {
      hydrateRun(loaded);
    },
  });

  function persist(item_id: string, answer: string | string[]) {
    if (!run) return Promise.resolve();
    return request(`/api/v2/practice/${encodeURIComponent(run.id)}/answer`, {
      method: "PUT",
      body: JSON.stringify({ item_id, answer }),
    });
  }

  async function saveAnswer(item_id: string, next: string | string[]) {
    setSaveStates((prev) => ({ ...prev, [item_id]: "saving" }));
    setSaveErrors((prev) => {
      if (!(item_id in prev)) return prev;
      const nextMap = { ...prev };
      delete nextMap[item_id];
      return nextMap;
    });
    try {
      await persist(item_id, next);
      setSaveStates((prev) => ({ ...prev, [item_id]: "saved" }));
    } catch (cause) {
      setSaveStates((prev) => ({ ...prev, [item_id]: "failed" }));
      setSaveErrors((prev) => ({ ...prev, [item_id]: cause }));
    }
  }

  const submit = useMutation({
    mutationFn: async () => {
      if (!run) throw new Error(t.common.error);
      if (seconds !== 0) {
        await Promise.all(
          Object.entries(answers).map(([item_id, answer]) => persist(item_id, answer)),
        );
      }
      return request<Run>(`/api/v2/practice/${encodeURIComponent(run.id)}/submit`, {
        method: "POST",
        body: "{}",
      });
    },
    onSuccess: (submitted) => {
      setConfirmSubmitOpen(false);
      setRun(submitted);
      void queries.invalidateQueries({ queryKey: progressKeys.course(submitted.space_id) });
      void queries.invalidateQueries({ queryKey: courseKeys.dashboard });
      void queries.invalidateQueries({ queryKey: ["courses", submitted.space_id, "mistakes"] });
    },
  });

  // Accessible countdown: announce ONLY every exact minute & last 10 seconds
  useEffect(() => {
    if (!run || run.status !== "active") return;
    const tick = () => {
      const rem = Math.max(0, Math.ceil((Date.parse(run.deadline_at) - Date.now()) / 1000));
      setSeconds(rem);
      if (rem === 60 && !oneMinWarned.current) {
        oneMinWarned.current = true;
        toast.info(viz.practiceOneMinWarn);
      }
      if (rem > 0 && (rem <= 10 || rem % 60 === 0)) {
        setLiveTimerAnnouncement(viz.practiceTimeLeft.replace("{time}", formatTimer(rem)));
      }
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [run]);

  useEffect(() => {
    if (run?.status === "active" && seconds === 0 && !autoSubmitted.current) {
      autoSubmitted.current = true;
      submit.mutate();
    }
  }, [run?.status, seconds, submit]);

  function goToQuestion(idx: number) {
    if (!run) return;
    const clamped = Math.max(0, Math.min(run.items.length - 1, idx));
    setCurrentIdx(clamped);
    writeStoredIndex(run.id, clamped);
  }

  function updateAnswer(item: Item, next: string | string[]) {
    setAnswers((prev) => ({ ...prev, [item.id]: next }));
    void saveAnswer(item.id, next);
  }

  const speakCommentary = async (text: string, browserVoice?: Commentary["browser_voice"]) => {
    if (tutor?.id) {
      const played = await speech.speak({ characterId: tutor.id, text });
      if (played) return;
    }
    speakFallbackBrowser(text, browserVoice);
  };

  const explain = useMutation({
    mutationFn: ({ targetItemId, move }: { targetItemId: string; move: Move }) =>
      request<Commentary>(
        `/api/v2/practice/${encodeURIComponent(run!.id)}/debrief/${encodeURIComponent(targetItemId)}`,
        {
          method: "POST",
          body: JSON.stringify({ move }),
        },
      ),
    onSuccess: (result, variables) => {
      setCommentary((prev) => ({ ...prev, [variables.targetItemId]: result }));
      setCommentaryError((prev) => ({
        ...prev,
        [variables.targetItemId]: result.available
          ? ""
          : (publicMessage({ code: result.code }) ?? copy.debriefUnavailable),
      }));
      if (result.commentary) {
        void speakCommentary(result.commentary, result.browser_voice);
      }
    },
    onError: (error, variables) =>
      setCommentaryError((prev) => ({
        ...prev,
        [variables.targetItemId]: error instanceof Error ? error.message : t.common.error,
      })),
  });

  const kpBreakdown = useMemo(() => {
    if (!run?.debrief) return [];
    const byKp = new Map<string, { name: string; correct: number; total: number }>();
    for (const entry of run.debrief) {
      const key = entry.kp_id || entry.kp_name || "__kp__";
      const name = entry.kp_name || viz.ungroupedUnit;
      const prev = byKp.get(key) ?? { name, correct: 0, total: 0 };
      prev.total += 1;
      if (entry.verdict === "correct") prev.correct += 1;
      byKp.set(key, prev);
    }
    return Array.from(byKp.values());
  }, [run?.debrief]);

  const courseBack =
    run?.space_id
      ? `/courses/${run.space_id}/plan`
      : preview.data?.course_id
        ? `/courses/${preview.data.course_id}/plan`
        : "/courses";
  const pageTitle = preview.data
    ? planItemDisplayTitle({ kind: preview.data.kind, title: preview.data.title })
    : copy.heading;

  // Loading existing run
  if (preview.isPending || (existingRunId && restoredRun.isPending && !run)) {
    return (
      <FocusShell flowName={copy.heading} exitTo={courseBack} maxWidth="md">
        <h1 className="sr-only">{copy.heading}</h1>
        <Loading />
      </FocusShell>
    );
  }

  // Start preview page (B7)
  if (!run) {
    const p = preview.data;
    return (
      <FocusShell flowName={pageTitle} exitTo={courseBack} maxWidth="md">
        <Card padding="lg" className="grid gap-5 shadow-2" data-testid="practice-start">
          <div className="grid gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="accent">
                {p?.kind === "mock" ? copy.mock : copy.practice}
              </Badge>
              {p ? (
                <>
                  <Badge tone="neutral">{viz.practicePreviewCount.replace("{count}", String(p.item_count))}</Badge>
                  <Badge tone="neutral">{viz.practicePreviewMinutes.replace("{min}", String(p.est_minutes))}</Badge>
                </>
              ) : null}
            </div>
            <h1 className="text-headline font-semibold text-fg-primary">{pageTitle}</h1>
            <p className="text-body text-fg-secondary">{viz.practiceRule}</p>
          </div>

          {p && p.kp_names.length > 0 ? (
            <div className="grid gap-2 rounded-md bg-surface-page p-3.5">
              <span className="text-caption font-semibold text-fg-secondary">
                {viz.practicePreviewKps}
              </span>
              <div className="flex flex-wrap gap-1.5">
                {p.kp_names.map((name) => (
                  <Badge key={name} tone="neutral">{name}</Badge>
                ))}
              </div>
            </div>
          ) : null}

          {start.isError ? <Problem error={start.error} /> : null}
          {preview.isError ? <Problem error={preview.error} onRetry={() => void preview.refetch()} /> : null}

          <div className="flex flex-wrap items-center gap-3 pt-1">
            <Button
              variant="primary"
              size="lg"
              pending={start.isPending}
              leftIcon={<Play size={16} aria-hidden="true" />}
              onClick={() => start.mutate()}
            >
              {p?.submitted_run_id
                ? viz.practiceViewResult
                : p?.active_run_id
                  ? viz.practiceResume
                  : copy.start}
            </Button>
          </div>
        </Card>
      </FocusShell>
    );
  }

  // Submitted Result Page
  if (run.status === "submitted") {
    return (
      <FocusShell flowName={copy.result} exitTo={`/courses/${run.space_id}/progress`} maxWidth="lg">
        <div className="grid gap-5" data-testid="practice-result">
          <Card padding="lg" className="grid gap-5 shadow-2 sm:grid-cols-[auto_1fr] sm:items-center">
            <ScoreRing
              score={run.score ?? 0}
              maxScore={run.max_score ?? 1}
              label={copy.result}
            />
            <div className="grid gap-3">
              <div className="grid gap-1">
                <span className="text-caption font-medium text-accent-strong">
                  {run.kind === "mock" ? copy.mock : copy.practice}
                </span>
                <h1 className="text-headline font-semibold text-fg-primary">{copy.result}</h1>
                <p className="text-ui text-fg-secondary">{viz.practiceWrongToReview}</p>
              </div>
              {kpBreakdown.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {kpBreakdown.map((entry) => (
                    <Badge
                      key={entry.name}
                      tone={entry.correct === entry.total ? "ok" : "warn"}
                    >
                      {entry.name} · {entry.correct}/{entry.total}
                    </Badge>
                  ))}
                </div>
              ) : null}
              <div className="flex flex-wrap gap-2.5 pt-1">
                <Link className="button primary" to={`/courses/${run.space_id}/progress`}>
                  {copy.progress}
                </Link>
                <Link className="button quiet" to={`/courses/${run.space_id}/review`}>
                  {t.courseHub.goReview}
                </Link>
              </div>
            </div>
          </Card>

          <div className="grid gap-4">
            {run.debrief?.map((entry, index) => {
              const isOk = entry.verdict === "correct";
              const verdictLabel =
                copy.verdicts[entry.verdict as keyof typeof copy.verdicts] ?? entry.verdict;
              const comm = commentary[entry.item_id];
              const commErr = commentaryError[entry.item_id];
              return (
                <Card
                  key={entry.item_id}
                  padding="lg"
                  data-testid="debrief-item"
                  className="grid gap-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={isOk ? "ok" : "retry"}>
                        {isOk ? <CheckCircle2 size={13} aria-hidden="true" /> : <XCircle size={13} aria-hidden="true" />}
                        <span>{index + 1}. {verdictLabel}</span>
                      </Badge>
                      {entry.kp_name ? <Badge tone="neutral">{entry.kp_name}</Badge> : null}
                    </div>
                    <span className="text-caption tabular-nums font-medium text-fg-secondary">
                      {entry.score} / {entry.max_score}
                    </span>
                  </div>

                  {entry.stem ? (
                    <h2 className="text-body font-semibold text-fg-primary">{entry.stem}</h2>
                  ) : null}

                  <div className="grid gap-1.5 rounded-md bg-surface-page p-3 text-ui">
                    <p className="text-fg-secondary">
                      <strong className="font-medium text-fg-primary">{viz.practiceYourAnswer}：</strong>
                      <span>{formatAnswerValue(entry.learner_answer)}</span>
                    </p>
                    <p className="text-fg-secondary">
                      <strong className="font-medium text-fg-primary">{copy.answer}</strong>
                      <span>{formatAnswerValue(entry.answer)}</span>
                    </p>
                    <p className="text-fg-secondary">{entry.solution}</p>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    {entry.moves.map((move) => {
                      const busy =
                        explain.isPending &&
                        explain.variables?.targetItemId === entry.item_id &&
                        explain.variables?.move === move;
                      return (
                        <Button
                          key={move}
                          variant="secondary"
                          size="sm"
                          pending={busy}
                          disabled={explain.isPending && explain.variables?.targetItemId === entry.item_id}
                          onClick={() => explain.mutate({ targetItemId: entry.item_id, move })}
                        >
                          {copy.moves[move]}
                        </Button>
                      );
                    })}
                  </div>

                  {comm?.commentary ? (
                    <div className="grid gap-2 rounded-md border border-accent/25 bg-accent-soft/40 p-3.5">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          {tutor ? <TutorAvatar src={tutor.appearance.src} name={tutor.name} size="sm" /> : null}
                          <strong className="text-ui font-semibold text-fg-primary">
                            {copy.teacherCommentary}
                          </strong>
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          leftIcon={<Volume2 size={14} aria-hidden="true" />}
                          onClick={() => void speakCommentary(comm.commentary ?? "", comm.browser_voice)}
                        >
                          {copy.speakAgain}
                        </Button>
                      </div>
                      <p aria-live="polite" className="text-ui text-fg-primary">
                        {comm.commentary}
                      </p>
                    </div>
                  ) : null}

                  {commErr ? (
                    <div role="alert" className="rounded-md border border-danger/30 bg-danger-soft p-3 text-ui text-danger-text">
                      <p className="font-medium">{commErr}</p>
                      <p className="text-caption">{copy.solutionSafe}</p>
                    </div>
                  ) : null}
                </Card>
              );
            })}
          </div>
        </div>
      </FocusShell>
    );
  }

  // Active Single-Question Screen + Bottom Number Rail
  const currentItem = run.items[currentIdx] ?? run.items[0];
  const opts = currentItem ? itemOptions(currentItem) : [];
  const isMulti = currentItem?.type === "multi";
  const currentValue = currentItem ? answers[currentItem.id] : undefined;
  const currentSaveState = currentItem ? (saveStates[currentItem.id] ?? "idle") : "idle";
  const isLowTime = seconds >= 0 && seconds <= 300;
  const answeredCount = run.items.filter((item) => {
    const val = answers[item.id];
    return Array.isArray(val) ? val.length > 0 : Boolean(val && String(val).trim());
  }).length;
  const unansweredCount = run.items.length - answeredCount;

  const timerPill = (
    <div
      data-testid="practice-timer"
      className={clsx(
        "inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 text-ui font-semibold tabular-nums",
        isLowTime
          ? "border-danger/40 bg-danger-soft text-danger-text"
          : "border-line-subtle bg-surface-page text-fg-primary",
      )}
    >
      <Clock size={14} aria-hidden="true" />
      <span>{seconds >= 0 ? formatTimer(seconds) : "--:--"}</span>
    </div>
  );

  return (
    <FocusShell
      flowName={pageTitle}
      exitTo={courseBack}
      maxWidth="lg"
      progress={timerPill}
    >
      {/* Screen-reader announcements ONLY at minute boundaries and last 10 seconds */}
      <span className="sr-only" aria-live="polite">
        {liveTimerAnnouncement}
      </span>

      <div className="grid gap-5" data-testid="practice-active">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-title font-semibold text-fg-primary">{pageTitle}</h1>
            <Badge tone="neutral">
              {viz.reviewProgress
                .replace("{current}", String(currentIdx + 1))
                .replace("{total}", String(run.items.length))}
            </Badge>
            <div className="md:hidden">{timerPill}</div>
          </div>

          <div className="flex items-center gap-2">
            {/* Visible save state */}
            <span
              data-testid="practice-save-status"
              className={clsx(
                "inline-flex items-center gap-1 text-caption font-medium",
                currentSaveState === "failed"
                  ? "text-danger-text"
                  : currentSaveState === "saved"
                    ? "text-ok-text"
                    : "text-fg-tertiary",
              )}
            >
              {currentSaveState === "saving" ? viz.practiceSaving : null}
              {currentSaveState === "saved" ? (
                <>
                  <Check size={13} aria-hidden="true" />
                  <span>{viz.practiceSaved}</span>
                </>
              ) : null}
              {currentSaveState === "failed" ? viz.practiceSaveFailed : null}
            </span>

            {currentItem ? (
              <Button
                variant={flagged[currentItem.id] ? "secondary" : "ghost"}
                size="sm"
                leftIcon={<Flag size={14} aria-hidden="true" />}
                onClick={() =>
                  setFlagged((prev) => ({ ...prev, [currentItem.id]: !prev[currentItem.id] }))
                }
              >
                {flagged[currentItem.id] ? viz.practiceFlagged : viz.practiceFlag}
              </Button>
            ) : null}
          </div>
        </div>

        {/* Single-question card */}
        {currentItem ? (
          <Card padding="lg" className="grid gap-5 shadow-2" data-testid="practice-question-card">
            <div className="grid gap-1.5">
              {currentItem.kp_name ? (
                <div>
                  <Badge tone="neutral">{currentItem.kp_name}</Badge>
                </div>
              ) : null}
              <h2 className="text-body font-semibold leading-relaxed text-fg-primary">
                {currentIdx + 1}. {currentItem.stem}
              </h2>
            </div>

            {opts.length > 0 ? (
              <ChoiceCardGroup
                options={opts}
                mode={isMulti ? "multi" : "single"}
                value={
                  isMulti
                    ? Array.isArray(currentValue)
                      ? currentValue
                      : []
                    : typeof currentValue === "string"
                      ? currentValue
                      : ""
                }
                label={copy.answer}
                onChange={(next) => {
                  const val = isMulti
                    ? Array.isArray(next)
                      ? next
                      : [next]
                    : Array.isArray(next)
                      ? (next[0] ?? "")
                      : next;
                  updateAnswer(currentItem, val);
                }}
              />
            ) : (
              <TextInput
                aria-label={copy.answer}
                value={typeof currentValue === "string" ? currentValue : ""}
                onChange={(event) => updateAnswer(currentItem, event.target.value)}
              />
            )}

            {saveErrors[currentItem.id] ? (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-danger/35 bg-danger-soft px-3.5 py-2.5 text-ui text-danger-text">
                <span>{viz.practiceSaveFailed}</span>
                <Button
                  variant="secondary"
                  size="sm"
                  leftIcon={<RefreshCw size={14} aria-hidden="true" />}
                  onClick={() => void saveAnswer(currentItem.id, answers[currentItem.id] ?? "")}
                >
                  {viz.practiceRetrySave}
                </Button>
              </div>
            ) : null}

            {/* Prev / Next / Submit row */}
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line-subtle pt-4">
              <div className="flex items-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={currentIdx === 0}
                  leftIcon={<ArrowLeft size={14} aria-hidden="true" />}
                  onClick={() => goToQuestion(currentIdx - 1)}
                >
                  {viz.practicePrev}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={currentIdx >= run.items.length - 1}
                  rightIcon={<ArrowRight size={14} aria-hidden="true" />}
                  onClick={() => goToQuestion(currentIdx + 1)}
                >
                  {viz.practiceNext}
                </Button>
              </div>
              <Button
                variant="primary"
                pending={submit.isPending}
                onClick={() => setConfirmSubmitOpen(true)}
              >
                {copy.submit}
              </Button>
            </div>
          </Card>
        ) : null}

        {submit.isError ? <Problem error={submit.error} /> : null}

        {/* Bottom Question Number Rail */}
        <Card padding="md" className="grid gap-2.5" data-testid="practice-number-rail">
          <span className="text-caption font-medium text-fg-tertiary">{viz.practiceRailLabel}</span>
          <div className="flex flex-wrap gap-2">
            {run.items.map((item, idx) => {
              const val = answers[item.id];
              const isAnswered = Array.isArray(val) ? val.length > 0 : Boolean(val && String(val).trim());
              const isCurrent = idx === currentIdx;
              const isFlagged = Boolean(flagged[item.id]);
              return (
                <button
                  key={item.id}
                  type="button"
                  aria-current={isCurrent ? "step" : undefined}
                  data-answered={isAnswered || undefined}
                  data-flagged={isFlagged || undefined}
                  onClick={() => goToQuestion(idx)}
                  className={clsx(
                    "relative inline-flex h-10 w-10 items-center justify-center rounded-md border text-ui font-medium tabular-nums transition-colors duration-fast",
                    isCurrent
                      ? "border-accent bg-accent text-on-accent"
                      : isAnswered
                        ? "border-accent/40 bg-accent-soft text-accent-strong"
                        : "border-line-default bg-surface-card text-fg-secondary hover:border-line-control",
                  )}
                >
                  <span>{idx + 1}</span>
                  {isFlagged ? (
                    <span
                      aria-hidden="true"
                      className="absolute top-1 right-1 h-2 w-2 rounded-full bg-warn"
                    />
                  ) : null}
                </button>
              );
            })}
          </div>
        </Card>
      </div>

      <ConfirmDialog
        open={confirmSubmitOpen}
        onOpenChange={setConfirmSubmitOpen}
        title={viz.practiceSubmitConfirm}
        description={
          unansweredCount > 0
            ? viz.practiceUnansweredWarn.replace("{count}", String(unansweredCount))
            : viz.practiceAllAnswered
        }
        confirmLabel={viz.practiceConfirmSubmit}
        cancelLabel={viz.practiceKeepAnswering}
        danger={false}
        pending={submit.isPending}
        onConfirm={() => submit.mutate()}
      />
    </FocusShell>
  );
}
