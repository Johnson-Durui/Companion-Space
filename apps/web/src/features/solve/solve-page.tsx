import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams, useSearchParams } from "react-router";
import { BoardBlock, LessonText } from "@companion-space/board";
import { Loading, Problem } from "../../app/ui";
import t from "../../locales/zh-CN.json";
import {
  AlertTriangle,
  Badge,
  Button,
  Card,
  CheckCircle2,
  ChoiceCardGroup,
  Dialog,
  EmptyState,
  Field,
  FileDropzone,
  Lightbulb,
  MasteryShapeGlyph,
  Plus,
  Send,
  Sparkles,
  TextInput,
  Textarea,
  TutorAvatar,
  Volume2,
  X,
  normalizeMasteryStatus,
  toast,
} from "../../ui";
import { resolveCharacterStill } from "../characters/video-config";
import { courseKeys } from "../courses/api";
import { addNoteBlock, notesKeys } from "../notes/api";
import { progressKeys } from "../progress/api";
import { useActiveTutor } from "../tutors/use-active-tutor";
import { useTutorSpeech } from "../voice/use-tutor-speech";
import {
  answerSolveMimic,
  createImageSolve,
  createTextSolve,
  generateSolveMimic,
  getSolveSession,
  listSolveSessions,
  performSolveAction,
  solveKeys,
  type SolveMimicItem,
  type SolveSessionDetail,
} from "./api";

const copy = t.solve;

function verifyBadgeTone(status: string): "ok" | "warn" | "neutral" {
  if (status === "verified") return "ok";
  if (status === "disputed" || status === "unverified") return "warn";
  return "neutral";
}

function verifyBadgeLabel(status: string): string {
  if (status === "verified") return copy.verifiedBadge;
  if (status === "disputed") return copy.disputedBadge;
  return copy.unverifiedBadge;
}

function MimicItemCard({
  courseId,
  sessionId,
  item,
  onUpdated,
}: {
  courseId: string;
  sessionId: string;
  item: SolveMimicItem;
  onUpdated: (session: SolveSessionDetail) => void;
}) {
  const [choice, setChoice] = useState<string>("");
  const [numeric, setNumeric] = useState<string>("");
  const queries = useQueryClient();

  const submitMutation = useMutation({
    mutationFn: (payload: { answer?: string | null; dont_know?: boolean }) =>
      answerSolveMimic(courseId, sessionId, item.id, payload),
    onSuccess: (response) => {
      onUpdated(response.session);
      void queries.invalidateQueries({ queryKey: courseKeys.map(courseId) });
      void queries.invalidateQueries({ queryKey: courseKeys.dashboard });
      void queries.invalidateQueries({ queryKey: progressKeys.course(courseId) });
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : t.common.error);
    },
  });

  const result = item.result;
  const isChoice = item.type === "choice" && Boolean(item.options?.length);
  const canSubmit = isChoice ? Boolean(choice) : Boolean(numeric.trim());

  return (
    <Card padding="md" className="grid gap-3 border-line-subtle bg-surface-card" data-testid={`mimic-card-${item.id}`}>
      <div className="text-body text-fg-primary">
        <LessonText source={item.stem} />
      </div>

      {isChoice && item.options ? (
        <ChoiceCardGroup
          value={result ? String(result.learner_answer ?? "") : choice}
          onChange={(next) => setChoice(typeof next === "string" ? next : next[0] ?? "")}
          disabled={Boolean(result) || submitMutation.isPending}
          outcomes={
            result
              ? Object.fromEntries(
                  item.options.map((opt) => [
                    opt.key,
                    opt.key === item.answer
                      ? "correct"
                      : opt.key === String(result.learner_answer ?? "") && result.verdict !== "correct"
                        ? "retry"
                        : null,
                  ]),
                )
              : undefined
          }
          options={item.options.map((opt) => ({
            key: opt.key,
            text: opt.text,
          }))}
        />
      ) : !result ? (
        <TextInput
          value={numeric}
          onChange={(event) => setNumeric(event.target.value)}
          placeholder={copy.mimicOptionPlaceholder}
          disabled={submitMutation.isPending}
          aria-label={copy.mimicOptionPlaceholder}
        />
      ) : null}

      {!result ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            size="sm"
            disabled={!canSubmit || submitMutation.isPending}
            onClick={() => submitMutation.mutate({ answer: isChoice ? choice : numeric.trim() })}
            data-testid={`mimic-submit-${item.id}`}
          >
            {copy.mimicSubmit}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={submitMutation.isPending}
            onClick={() => submitMutation.mutate({ dont_know: true })}
            data-testid={`mimic-dont-know-${item.id}`}
          >
            {copy.mimicDontKnow}
          </Button>
        </div>
      ) : (
        <div
          className={
            result.verdict === "correct"
              ? "grid gap-2 rounded-md border border-ok/30 bg-ok-soft p-3 text-ui"
              : "grid gap-2 rounded-md border border-retry/30 bg-retry-soft p-3 text-ui"
          }
          data-testid={`mimic-result-${item.id}`}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-medium text-fg-primary">
              {result.verdict === "correct" ? copy.mimicCorrect : copy.mimicWrong}
            </span>
            <Badge tone={result.verdict === "correct" ? "ok" : "warn"}>
              {copy.mimicMasteryDelta
                .replace("{before}", String(Math.round(result.p_before * 100)))
                .replace("{after}", String(Math.round(result.p_after * 100)))}
            </Badge>
          </div>
          {result.hint_level > 0 ? (
            <p className="text-caption text-fg-secondary">{copy.mimicHintDiscount}</p>
          ) : null}
          {item.answer ? (
            <p className="text-ui font-medium text-fg-primary">
              {copy.mimicAnswer.replace("{answer}", item.answer)}
            </p>
          ) : null}
          {item.solution ? (
            <div className="rounded-sm bg-surface-card p-2.5 text-ui text-fg-primary">
              <p className="mb-1 text-caption font-medium text-fg-secondary">{copy.mimicSolution}</p>
              <LessonText source={item.solution} />
            </div>
          ) : null}
        </div>
      )}
    </Card>
  );
}

export default function SolvePage() {
  const courseId = useParams().courseId ?? "";
  const [searchParams, setSearchParams] = useSearchParams();
  const activeSessionId = searchParams.get("session") ?? "";
  const presetKpId = searchParams.get("kp");
  const queries = useQueryClient();
  const { tutor } = useActiveTutor(true);
  const speech = useTutorSpeech();

  const [stemInput, setStemInput] = useState("");
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [ideaInput, setIdeaInput] = useState("");
  const [imagePreviewOpen, setImagePreviewOpen] = useState(false);

  const sessionsQuery = useQuery({
    queryKey: solveKeys.list(courseId),
    queryFn: () => listSolveSessions(courseId),
    enabled: Boolean(courseId),
  });

  const detailQuery = useQuery({
    queryKey: solveKeys.one(courseId, activeSessionId),
    queryFn: () => getSolveSession(courseId, activeSessionId),
    enabled: Boolean(courseId && activeSessionId),
  });

  function selectSession(sessionId: string) {
    const next = new URLSearchParams(searchParams);
    if (sessionId) next.set("session", sessionId);
    else next.delete("session");
    setSearchParams(next, { replace: false });
    setIdeaInput("");
  }

  function syncSession(updated: SolveSessionDetail) {
    queries.setQueryData(solveKeys.one(courseId, updated.id), updated);
    void queries.invalidateQueries({ queryKey: solveKeys.list(courseId), exact: true });
  }

  const createMutation = useMutation({
    mutationFn: async () => {
      if (imageFile) {
        return createImageSolve(courseId, imageFile, stemInput, presetKpId);
      }
      return createTextSolve(courseId, { stem: stemInput.trim(), kp_id: presetKpId });
    },
    onSuccess: (created) => {
      setStemInput("");
      setImageFile(null);
      syncSession(created);
      selectSession(created.id);
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : t.common.error);
    },
  });

  const actionMutation = useMutation({
    mutationFn: (payload: { action: "submit_idea" | "hint" | "show_solution" | "locate_step"; text?: string; step_index?: number }) =>
      performSolveAction(courseId, activeSessionId, payload),
    onSuccess: (updated, variables) => {
      if (variables.action === "submit_idea") setIdeaInput("");
      syncSession(updated);
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : t.common.error);
    },
  });

  const mimicMutation = useMutation({
    mutationFn: () => generateSolveMimic(courseId, activeSessionId, 1),
    onSuccess: (updated) => {
      syncSession(updated);
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : t.common.error);
    },
  });

  function handleSubmitProblem(event: FormEvent) {
    event.preventDefault();
    if (!imageFile && !stemInput.trim()) return;
    createMutation.mutate();
  }

  function handleSubmitIdea(event: FormEvent) {
    event.preventDefault();
    if (!ideaInput.trim()) return;
    actionMutation.mutate({ action: "submit_idea", text: ideaInput.trim() });
  }

  const session = detailQuery.data;
  const tutorStill = resolveCharacterStill(
    tutor,
    session?.solved ? "recap" : session?.verify_status === "verified" ? "today_greeting" : "not_found",
  );

  function speakText(text: string) {
    if (!text.trim()) return;
    void speech.speak({ characterId: tutor?.id, text: text.slice(0, 220) });
  }

  const stepsContent = session?.steps.length ? session.steps.join("\n") : "";
  const showSteps = Boolean(session && (session.revealed || session.solved || session.verify_status !== "verified"));

  return (
    <div className="grid min-w-0 gap-5" data-testid="solve-page">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1">
          <h2 className="text-title font-semibold text-fg-primary">{copy.heading}</h2>
          <p className="text-ui text-fg-secondary">{copy.lead}</p>
        </div>
        {activeSessionId ? (
          <Button variant="secondary" size="sm" onClick={() => selectSession("")} data-testid="solve-new-btn">
            <Plus size={15} aria-hidden="true" />
            {copy.newQuestion}
          </Button>
        ) : null}
      </div>

      {!activeSessionId ? (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1.4fr)_minmax(260px,0.9fr)]">
          <Card padding="lg" className="grid gap-4">
            <form className="grid gap-4" onSubmit={handleSubmitProblem}>
              <Field label={copy.stemLabel}>
                <Textarea
                  value={stemInput}
                  onChange={(event) => setStemInput(event.target.value)}
                  placeholder={copy.stemPlaceholder}
                  rows={5}
                  disabled={createMutation.isPending}
                  data-testid="solve-stem-input"
                />
              </Field>

              <div className="grid gap-2">
                <span className="text-ui font-medium text-fg-primary">{copy.imageLabel}</span>
                {imageFile ? (
                  <div className="flex items-center justify-between gap-2 rounded-md border border-line-default bg-surface-sunken px-3 py-2 text-ui">
                    <span className="truncate text-fg-primary">
                      {copy.imageSelected.replace("{name}", imageFile.name)}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setImageFile(null)}
                      disabled={createMutation.isPending}
                    >
                      <X size={14} aria-hidden="true" />
                      {copy.clearImage}
                    </Button>
                  </div>
                ) : (
                  <FileDropzone
                    accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp"
                    multiple={false}
                    disabled={createMutation.isPending}
                    title={copy.imageLabel}
                    description={copy.imageHint}
                    buttonLabel={copy.imageLabel}
                    onFiles={(files) => {
                      const first = files[0];
                      if (first) setImageFile(first);
                    }}
                  />
                )}
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <Button
                  type="submit"
                  variant="primary"
                  disabled={(!stemInput.trim() && !imageFile) || createMutation.isPending}
                  data-testid="solve-submit-btn"
                >
                  <Sparkles size={15} aria-hidden="true" />
                  {createMutation.isPending ? copy.analyzing : copy.submit}
                </Button>
              </div>
            </form>
          </Card>

          <Card padding="md" className="grid content-start gap-3">
            <h3 className="text-body font-semibold text-fg-primary">{copy.historyHeading}</h3>
            {sessionsQuery.isPending ? (
              <Loading />
            ) : sessionsQuery.isError ? (
              <Problem error={sessionsQuery.error} onRetry={() => void sessionsQuery.refetch()} />
            ) : !sessionsQuery.data?.length ? (
              <EmptyState title={copy.historyHeading} description={copy.historyEmpty} />
            ) : (
              <div className="grid gap-2">
                {sessionsQuery.data.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    onClick={() => selectSession(entry.id)}
                    className="grid gap-1.5 rounded-md border border-line-subtle bg-surface-sunken/60 p-3 text-left transition-colors hover:border-accent hover:bg-surface-sunken"
                    data-testid={`solve-history-${entry.id}`}
                  >
                    <p className="line-clamp-2 text-ui font-medium text-fg-primary">{entry.stem_preview}</p>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge tone={entry.solved ? "ok" : entry.revealed ? "info" : "neutral"}>
                        {entry.solved ? copy.statusSolved : entry.revealed ? copy.statusRevealed : copy.statusActive}
                      </Badge>
                      <Badge tone={verifyBadgeTone(entry.verify_status)}>
                        {verifyBadgeLabel(entry.verify_status)}
                      </Badge>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </Card>
        </div>
      ) : detailQuery.isPending ? (
        <Loading />
      ) : detailQuery.isError || !session ? (
        <Problem error={detailQuery.error} onRetry={() => void detailQuery.refetch()} />
      ) : (
        <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(250px,0.72fr)_minmax(0,1.6fr)]">
          {/* Left companion & diagnostic column */}
          <div className="grid min-w-0 content-start gap-4">
            <Card padding="md" className="grid min-w-0 grid-cols-1 gap-3">
              <div className="flex items-center gap-3">
                {tutor ? (
                  <TutorAvatar src={tutorStill.url} still={tutorStill.still} name={tutor.name} size="lg" />
                ) : null}
                <div className="grid gap-1">
                  <span className="text-body font-semibold text-fg-primary">{tutor?.name ?? t.app.teachers}</span>
                  <Badge tone={verifyBadgeTone(session.verify_status)} data-testid="solve-verify-badge">
                    {verifyBadgeLabel(session.verify_status)}
                  </Badge>
                </div>
              </div>

              {session.verify_status !== "verified" ? (
                <div
                  role="status"
                  className="flex items-start gap-2 rounded-md border border-warn/35 bg-warn-soft p-2.5 text-caption text-fg-primary"
                  data-testid="solve-unverified-notice"
                >
                  <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warn" aria-hidden="true" />
                  <span>{copy.unverifiedNotice}</span>
                </div>
              ) : null}

              <div className="rounded-md bg-surface-sunken p-3 text-ui text-fg-primary">
                <p className="mb-1 text-caption font-medium text-fg-secondary">{copy.approachLabel}</p>
                <p>{session.approach_prompt || copy.approachFallback}</p>
                <div className="mt-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => speakText(session.approach_prompt || copy.approachFallback)}
                    disabled={speech.loading}
                  >
                    <Volume2 size={14} aria-hidden="true" />
                    {copy.readAloud}
                  </Button>
                </div>
              </div>

              {session.mapped_kps.length > 0 ? (
                <div className="grid gap-2">
                  <span className="text-caption font-medium text-fg-secondary">{copy.relatedKps}</span>
                  <div className="grid gap-1.5">
                    {session.mapped_kps.map((kp) => (
                      <div
                        key={kp.id}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-sm border border-line-subtle bg-surface-card px-2.5 py-1.5 text-caption"
                      >
                        <span className="inline-flex items-center gap-1.5 font-medium text-fg-primary">
                          <MasteryShapeGlyph status={normalizeMasteryStatus(kp.mastery_status)} size={13} />
                          {kp.name}
                        </span>
                        {kp.exam_count > 0 ? (
                          <Badge tone="accent">{copy.examHits.replace("{count}", String(kp.exam_count))}</Badge>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </Card>
          </div>

          {/* Right warm-paper solve whiteboard & mimic column */}
          <div className="grid min-w-0 content-start gap-4">
            <Card padding="lg" data-surface="paper" className="grid min-w-0 grid-cols-1 gap-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-caption font-semibold text-fg-secondary">{copy.stemCard}</span>
                {session.image_url ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setImagePreviewOpen(true)}
                  >
                    {copy.viewOriginalImage}
                  </Button>
                ) : null}
              </div>
              <div className="min-w-0 overflow-x-auto text-body text-fg-primary" data-testid="solve-stem-display">
                <LessonText source={session.stem} />
              </div>

              {session.key_formula ? (
                <div className="grid min-w-0 grid-cols-1 gap-1 overflow-x-auto rounded-md border border-line-subtle bg-surface-sunken p-3">
                  <span className="text-caption font-medium text-fg-secondary">{copy.keyFormula}</span>
                  <BoardBlock
                    block={{ id: "solve-formula", type: "math", content: session.key_formula }}
                    showTools={false}
                  />
                </div>
              ) : null}

              {session.hints.length > 0 ? (
                <div className="grid min-w-0 grid-cols-1 gap-2" data-testid="solve-hints">
                  {session.hints.map((hint) => (
                    <div
                      key={hint.level}
                      className="min-w-0 overflow-x-auto rounded-md border border-accent/25 bg-accent-soft/60 p-3 text-ui text-fg-primary"
                    >
                      <p className="mb-1 inline-flex items-center gap-1.5 text-caption font-semibold text-accent-strong">
                        <Lightbulb size={13} aria-hidden="true" />
                        {copy.hintLabel.replace("{level}", String(hint.level))}
                      </p>
                      <LessonText source={hint.text} />
                    </div>
                  ))}
                </div>
              ) : null}

              {session.turns.length > 0 ? (
                <div className="grid gap-2" data-testid="solve-turns">
                  {session.turns.map((turn, idx) => {
                    const kind = String(turn.kind ?? "");
                    const text = String(turn.text ?? "");
                    if (kind === "hint" || kind === "step_detail") return null;
                    const fallbackLine =
                      kind === "verdict_correct"
                        ? copy.verdictCorrect
                        : kind === "solution_revealed"
                          ? copy.solutionRevealedNote
                          : kind === "hint_exhausted"
                            ? copy.hintExhausted
                            : turn.verdict === "partial"
                              ? copy.verdictPartial
                              : turn.verdict === "incorrect"
                                ? copy.verdictIncorrect
                                : turn.verdict === "discuss"
                                  ? copy.verdictDiscuss
                                  : "";
                    const display = text || fallbackLine;
                    if (!display) return null;
                    const isStudent = turn.role === "student";
                    return (
                      <div
                        key={String(turn.id ?? idx)}
                        className={
                          isStudent
                            ? "justify-self-end rounded-md bg-accent-soft px-3 py-2 text-ui text-fg-primary"
                            : "rounded-md border border-line-subtle bg-surface-card px-3 py-2 text-ui text-fg-primary"
                        }
                      >
                        <LessonText source={display} />
                      </div>
                    );
                  })}
                </div>
              ) : null}

              {/* Interactive Loop 2 action bar */}
              {!session.solved ? (
                <form className="grid gap-3 border-t border-line-subtle pt-3" onSubmit={handleSubmitIdea}>
                  <Field label={copy.ideaLabel}>
                    <Textarea
                      value={ideaInput}
                      onChange={(event) => setIdeaInput(event.target.value)}
                      placeholder={copy.ideaPlaceholder}
                      rows={2}
                      disabled={actionMutation.isPending}
                      data-testid="solve-idea-input"
                    />
                  </Field>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="submit"
                      variant="primary"
                      size="sm"
                      disabled={!ideaInput.trim() || actionMutation.isPending}
                      data-testid="solve-idea-submit"
                    >
                      <Send size={14} aria-hidden="true" />
                      {actionMutation.isPending ? copy.submittingIdea : copy.submitIdea}
                    </Button>
                    {session.hint_level < session.max_hint_level ? (
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        disabled={actionMutation.isPending}
                        onClick={() => actionMutation.mutate({ action: "hint" })}
                        data-testid="solve-hint-btn"
                      >
                        <Lightbulb size={14} aria-hidden="true" />
                        {copy.needHint}
                      </Button>
                    ) : null}
                    {!session.revealed ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={actionMutation.isPending}
                        onClick={() => actionMutation.mutate({ action: "show_solution" })}
                        data-testid="solve-reveal-btn"
                      >
                        {copy.showSolution}
                      </Button>
                    ) : null}
                  </div>
                </form>
              ) : null}

              {/* Step-by-step derivation board with line-level locate */}
              {showSteps && stepsContent ? (
                <div className="grid min-w-0 grid-cols-1 gap-3 border-t border-line-subtle pt-4" data-testid="solve-steps-section">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-body font-semibold text-fg-primary">{copy.stepsHeading}</h3>
                    {session.verified_answer ? (
                      <Badge tone="ok" data-testid="solve-verified-answer">
                        <CheckCircle2 size={13} aria-hidden="true" />
                        {copy.verifiedAnswerLabel}：{session.verified_answer}
                      </Badge>
                    ) : null}
                  </div>

                  <div className="min-w-0 overflow-x-auto">
                    <BoardBlock
                      block={{ id: "solve-steps", type: "steps", content: stepsContent }}
                      progressiveSteps={false}
                      reducedMotion
                      showTools
                      onSaveToNote={(block) => {
                        void addNoteBlock(courseId, "quick", {
                          block_type: block.type,
                          title: session.mapped_kps[0]?.name || copy.stepsHeading,
                          content: block.content,
                          source_ref: {
                            kind: "solve",
                            solve_session_id: session.id,
                            kp_id: session.mapped_kps[0]?.id ?? null,
                          },
                          default_title: t.notes.defaultQuickTitle,
                        })
                          .then(() => {
                            void queries.invalidateQueries({ queryKey: notesKeys.list(courseId), exact: true });
                            toast.success(copy.savedToNote);
                          })
                          .catch(() => {
                            toast.error(t.common.error);
                          });
                      }}
                      labels={{
                        locate: copy.stepLocate,
                        renderError: t.classroom.boardRenderError,
                        viewSource: t.classroom.boardViewSource,
                        copy: t.classroom.boardCopy,
                        copied: t.classroom.boardCopied,
                        saveToNote: copy.saveToNote,
                        savedToNote: copy.savedToNote,
                      }}
                      locate={(target) => {
                        const line = Number(target.split(".")[1]);
                        if (Number.isInteger(line) && line >= 1) {
                          actionMutation.mutate({ action: "locate_step", step_index: line - 1 });
                        }
                      }}
                    />
                  </div>

                  {Object.entries(session.step_explanations).map(([key, detail]) => {
                    const stepNum = Number(key) + 1;
                    const substeps = Array.isArray(detail.substeps) ? (detail.substeps as string[]) : [];
                    return (
                      <div
                        key={key}
                        className="grid min-w-0 grid-cols-1 gap-2 overflow-x-auto rounded-md border border-accent/25 bg-accent-soft/40 p-3 text-ui"
                        data-testid={`solve-step-detail-${key}`}
                      >
                        <p className="text-caption font-semibold text-accent-strong">
                          {copy.stepDetailHeading.replace("{step}", String(stepNum))}
                        </p>
                        {typeof detail.summary === "string" && detail.summary ? (
                          <LessonText source={detail.summary} />
                        ) : null}
                        {substeps.length > 0 ? (
                          <ol className="grid list-decimal gap-1.5 pl-5 text-fg-primary">
                            {substeps.map((sub, sIdx) => (
                              <li key={sIdx}>
                                <LessonText source={sub} />
                              </li>
                            ))}
                          </ol>
                        ) : null}
                      </div>
                    );
                  })}

                  {session.pitfalls.length > 0 ? (
                    <div className="grid min-w-0 grid-cols-1 gap-1.5 overflow-x-auto rounded-md border border-warn/30 bg-warn-soft p-3 text-ui">
                      <p className="text-caption font-semibold text-fg-primary">{copy.pitfallsHeading}</p>
                      <ul className="grid list-disc gap-1 pl-5 text-fg-secondary">
                        {session.pitfalls.map((pitfall, idx) => (
                          <li key={idx}>
                            <LessonText source={pitfall} />
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </Card>

            {/* Exam-Style Mimicry Consolidation Section */}
            <Card padding="lg" className="grid min-w-0 grid-cols-1 gap-3" data-testid="solve-mimic-section">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="grid gap-0.5">
                  <h3 className="text-body font-semibold text-fg-primary">{copy.mimicHeading}</h3>
                  <p className="text-caption text-fg-secondary">{copy.mimicLead}</p>
                </div>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={mimicMutation.isPending}
                  onClick={() => mimicMutation.mutate()}
                  data-testid="solve-mimic-generate-btn"
                >
                  <Sparkles size={14} aria-hidden="true" />
                  {mimicMutation.isPending ? copy.generatingMimic : copy.generateMimic}
                </Button>
              </div>

              {session.mimic_items.length > 0 ? (
                <div className="grid gap-3">
                  {session.mimic_items.map((item) => (
                    <MimicItemCard
                      key={item.id}
                      courseId={courseId}
                      sessionId={session.id}
                      item={item}
                      onUpdated={syncSession}
                    />
                  ))}
                </div>
              ) : null}
            </Card>
          </div>

          <Dialog open={imagePreviewOpen} onOpenChange={setImagePreviewOpen} title={copy.viewOriginalImage} size="lg">
            {session.image_url ? (
              <img
                src={session.image_url}
                alt={copy.viewOriginalImage}
                className="max-h-[70vh] w-full rounded-md object-contain"
              />
            ) : null}
          </Dialog>
        </div>
      )}
    </div>
  );
}
