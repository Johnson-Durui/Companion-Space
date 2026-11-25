import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams, useSearchParams } from "react-router";
import { LessonText } from "@companion-space/board";
import { Loading, Problem } from "../../app/ui";
import {
  ArrowLeft,
  Badge,
  BookOpen,
  Button,
  Card,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ChoiceCardGroup,
  EmptyState,
  FileText,
  MasteryShapeGlyph,
  SegmentedControl,
  Sparkles,
  TextInput,
  Textarea,
  TutorAvatar,
  Volume2,
  VolumeX,
  normalizeMasteryStatus,
  toast,
} from "../../ui";
import t from "../../locales/zh-CN.json";
import { resolveCharacterStill } from "../characters/video-config";
import { progressKeys } from "../progress/api";
import { useActiveTutor } from "../tutors/use-active-tutor";
import { useTutorSpeech } from "../voice/use-tutor-speech";
import {
  addNoteBlock,
  answerReaderQuickCheck,
  askReaderPage,
  getReaderOverview,
  getReaderPage,
  notesKeys,
  readerKeys,
  type ReaderAskResponse,
  type ReaderQuizAnswerResponse,
} from "./api";

const copy = t.reader;

export default function ReaderPage() {
  const courseId = useParams().courseId ?? "";
  const materialId = useParams().materialId ?? "";
  const [searchParams, setSearchParams] = useSearchParams();
  const queries = useQueryClient();
  const { tutor } = useActiveTutor();
  const speech = useTutorSpeech();

  const overview = useQuery({
    queryKey: readerKeys.overview(courseId, materialId),
    queryFn: () => getReaderOverview(courseId, materialId),
    enabled: Boolean(courseId && materialId),
  });

  const requestedPage = Number(searchParams.get("page") ?? "1");
  const totalPages = overview.data?.page_count ?? 0;
  const pageNo =
    totalPages > 0
      ? Math.max(1, Math.min(totalPages, Number.isFinite(requestedPage) ? Math.floor(requestedPage) : 1))
      : 1;

  const pageQuery = useQuery({
    queryKey: readerKeys.page(courseId, materialId, pageNo),
    queryFn: () => getReaderPage(courseId, materialId, pageNo),
    enabled: Boolean(courseId && materialId && totalPages > 0),
  });

  const [viewMode, setViewMode] = useState<"text" | "image">("text");
  const [passage, setPassage] = useState("");
  const [question, setQuestion] = useState("");
  const [askResult, setAskResult] = useState<ReaderAskResponse | null>(null);
  const [quizChoice, setQuizChoice] = useState<string>("");
  const [quizText, setQuizText] = useState<string>("");
  const [quizResult, setQuizResult] = useState<ReaderQuizAnswerResponse | null>(null);

  function goToPage(next: number) {
    if (totalPages <= 0) return;
    const clamped = Math.max(1, Math.min(totalPages, next));
    const params = new URLSearchParams(searchParams);
    params.set("page", String(clamped));
    setSearchParams(params, { replace: true });
    setAskResult(null);
    setQuizChoice("");
    setQuizText("");
    setQuizResult(null);
  }

  function handleTextMouseUp() {
    if (typeof window === "undefined") return;
    const selected = window.getSelection()?.toString().trim() ?? "";
    if (selected.length >= 2) {
      setPassage(selected.slice(0, 3000));
    }
  }

  const askMutation = useMutation({
    mutationFn: () =>
      askReaderPage(courseId, materialId, pageNo, {
        passage: passage.trim(),
        question: question.trim(),
      }),
    onSuccess: (res) => {
      setAskResult(res);
    },
  });

  const saveBlockMutation = useMutation({
    mutationFn: (payload: {
      block_type: string;
      title?: string | null;
      content: string;
      source_ref?: Record<string, unknown> | null;
    }) =>
      addNoteBlock(courseId, "quick", {
        ...payload,
        default_title: t.notes.defaultQuickTitle,
      }),
    onSuccess: () => {
      void queries.invalidateQueries({ queryKey: notesKeys.list(courseId), exact: true });
      toast.success(copy.savedToNote);
    },
  });

  const quizMutation = useMutation({
    mutationFn: ({
      itemId,
      answer,
      dontKnow,
    }: {
      itemId: string;
      answer?: string | null;
      dontKnow?: boolean;
    }) => answerReaderQuickCheck(courseId, itemId, { answer: answer ?? null, dont_know: dontKnow }),
    onSuccess: (res) => {
      setQuizResult(res);
      void queries.invalidateQueries({ queryKey: progressKeys.course(courseId) });
      void queries.invalidateQueries({ queryKey: readerKeys.page(courseId, materialId, pageNo) });
      void queries.invalidateQueries({ queryKey: readerKeys.overview(courseId, materialId) });
    },
  });

  if (overview.isPending) return <Loading />;
  if (overview.isError) return <Problem error={overview.error} onRetry={() => void overview.refetch()} />;

  if (overview.data.page_count === 0) {
    return (
      <Card padding="lg" className="grid gap-4" data-testid="reader-empty">
        <EmptyState
          title={overview.data.title}
          description={copy.emptyPages}
          action={
            <Link className="button primary" to={`/courses/${courseId}/materials`}>
              {copy.backMaterials}
            </Link>
          }
        />
      </Card>
    );
  }

  const page = pageQuery.data;
  const tutorStill = tutor ? resolveCharacterStill(tutor, "today_greeting") : null;
  const quickQuiz = page?.quick_quiz ?? null;
  const quizOptions = (quickQuiz?.options ?? [])
    .map((opt) => ({
      key: String(opt.key ?? ""),
      text: String(opt.text ?? opt.label ?? ""),
    }))
    .filter((opt) => opt.key && opt.text);

  function submitAsk(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!passage.trim()) return;
    askMutation.mutate();
  }

  function speakText(text: string) {
    if (speech.speaking) {
      speech.stop();
      return;
    }
    if (!text.trim()) return;
    void speech.speak({ characterId: tutor?.id, text: text.slice(0, 240) });
  }

  function handleSavePassage() {
    if (!passage.trim() || !page) return;
    saveBlockMutation.mutate({
      block_type: "text",
      title: page.section_title || page.material_title,
      content: passage.trim(),
      source_ref: {
        kind: "material_page",
        material_id: materialId,
        material_title: page.material_title,
        page_no: page.page_no,
        kp_id: page.kps[0]?.id ?? null,
      },
    });
  }

  function handleSaveExplanation() {
    if (!askResult) return;
    const suggested = askResult.suggested_block ?? {};
    saveBlockMutation.mutate({
      block_type: typeof suggested.block_type === "string" ? suggested.block_type : "callout",
      title: typeof suggested.title === "string" ? suggested.title : askResult.key_takeaway || page?.material_title,
      content: typeof suggested.content === "string" ? suggested.content : askResult.explanation,
      source_ref:
        suggested.source_ref && typeof suggested.source_ref === "object"
          ? (suggested.source_ref as Record<string, unknown>)
          : {
              kind: "material_page",
              material_id: materialId,
              material_title: page?.material_title ?? overview.data?.title ?? "",
              page_no: pageNo,
            },
    });
  }

  return (
    <div className="grid min-w-0 gap-5" data-testid="reader-page">
      {/* Header & pagination controls */}
      <Card padding="md" className="grid gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <Link
              to={`/courses/${courseId}/materials`}
              className="inline-flex min-h-9 items-center gap-1 rounded-md border border-line-control bg-surface-card px-2.5 text-caption font-medium text-fg-secondary hover:text-fg-primary"
            >
              <ArrowLeft size={14} aria-hidden="true" />
              <span>{copy.backMaterials}</span>
            </Link>
            <div className="min-w-0">
              <h2 className="truncate text-title font-semibold text-fg-primary">{overview.data.title}</h2>
              {page?.section_title ? (
                <p className="truncate text-caption text-fg-secondary">{page.section_title}</p>
              ) : null}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {page?.has_image ? (
              <SegmentedControl
                aria-label={copy.heading}
                value={viewMode}
                onValueChange={(next) => setViewMode(next as "text" | "image")}
                options={[
                  { value: "text", label: copy.viewText },
                  { value: "image", label: copy.viewImage },
                ]}
              />
            ) : null}

            <nav
              aria-label={copy.heading}
              className="inline-flex items-center gap-1 rounded-pill border border-line-subtle bg-surface-sunken px-1.5 py-0.5 text-caption"
            >
              <Button
                variant="ghost"
                size="sm"
                disabled={pageNo <= 1}
                aria-label={copy.prevPage}
                onClick={() => goToPage(pageNo - 1)}
              >
                <ChevronLeft size={14} aria-hidden="true" />
              </Button>
              <span className="px-2 font-medium tabular-nums text-fg-primary" data-testid="reader-page-indicator">
                {copy.pageOf.replace("{current}", String(pageNo)).replace("{total}", String(totalPages))}
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={pageNo >= totalPages}
                aria-label={copy.nextPage}
                onClick={() => goToPage(pageNo + 1)}
              >
                <ChevronRight size={14} aria-hidden="true" />
              </Button>
            </nav>

            <Link
              to={`/courses/${courseId}/notes`}
              className="inline-flex min-h-9 items-center gap-1.5 rounded-md border border-line-control bg-surface-card px-3 text-caption font-medium text-fg-primary hover:bg-surface-sunken"
            >
              <FileText size={14} aria-hidden="true" />
              <span>{copy.openNotes}</span>
            </Link>
          </div>
        </div>

        {/* Page KP mastery & exam badges */}
        {page ? (
          <div className="flex flex-wrap items-center gap-2 border-t border-line-subtle pt-2.5" data-testid="reader-kp-strip">
            <span className="text-caption font-medium text-fg-tertiary">{copy.kpsOnPage}</span>
            {page.kps.length === 0 ? (
              <span className="text-caption text-fg-secondary">{copy.noKpsOnPage}</span>
            ) : (
              page.kps.map((kp) => {
                const status = normalizeMasteryStatus(kp.mastery_status);
                return (
                  <Link
                    key={kp.id}
                    to={`/courses/${courseId}/map?kp=${encodeURIComponent(kp.id)}`}
                    data-testid={`reader-kp-${kp.id}`}
                    className="inline-flex items-center gap-1.5 rounded-pill border border-line-subtle bg-surface-page px-2.5 py-1 text-caption hover:border-accent"
                  >
                    <MasteryShapeGlyph status={status} size={13} />
                    <span className="font-medium text-fg-primary">{kp.name}</span>
                    <span className="text-fg-tertiary">{t.loopViz.masteryStatuses[status]}</span>
                    {kp.exam_count > 0 ? (
                      <Badge tone="accent">{copy.examHits.replace("{count}", String(kp.exam_count))}</Badge>
                    ) : null}
                  </Link>
                );
              })
            )}
          </div>
        ) : null}
      </Card>

      {/* Main split: Material page on left, Tutor companion on right */}
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.35fr)_minmax(300px,0.95fr)]">
        <div className="grid min-w-0 gap-4">
          {overview.data.sections.length > 0 ? (
            <Card padding="sm" className="flex flex-wrap items-center gap-1.5">
              <span className="px-1.5 text-caption font-medium text-fg-tertiary">{copy.sectionsTitle}</span>
              {overview.data.sections.slice(0, 12).map((sec, idx) => {
                const start = typeof sec.page_start === "number" ? sec.page_start : 1;
                const title = typeof sec.title === "string" ? sec.title : "";
                if (!title) return null;
                return (
                  <button
                    key={String(sec.id ?? idx)}
                    type="button"
                    onClick={() => goToPage(start)}
                    className="rounded-pill border border-line-subtle bg-surface-page px-2.5 py-1 text-caption text-fg-secondary hover:border-accent hover:text-fg-primary"
                  >
                    {title}
                  </button>
                );
              })}
            </Card>
          ) : null}

          <Card padding="lg" className="grid min-w-0 gap-4">
            {pageQuery.isPending ? (
              <Loading />
            ) : pageQuery.isError || !page ? (
              <Problem error={pageQuery.error} onRetry={() => void pageQuery.refetch()} />
            ) : viewMode === "image" && page.image_url ? (
              <img
                src={page.image_url}
                alt={t.courses.sourceImage.replace("{page}", String(page.page_no))}
                className="max-h-[72vh] w-full rounded-md bg-surface-sunken object-contain"
              />
            ) : (
              <div
                onMouseUp={handleTextMouseUp}
                data-testid="reader-page-content"
                className="min-h-[280px] select-text text-body leading-relaxed text-fg-primary"
              >
                <LessonText source={page.markdown} />
              </div>
            )}
          </Card>
        </div>

        {/* Right companion pane */}
        <div className="grid content-start gap-4">
          <Card padding="md" className="grid gap-3.5">
            <div className="flex items-center gap-3">
              {tutor && tutorStill ? (
                <TutorAvatar src={tutorStill.url} still={tutorStill.still} name={tutor.name} size="md" />
              ) : (
                <span className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-accent-soft text-accent-strong">
                  <BookOpen size={18} aria-hidden="true" />
                </span>
              )}
              <div className="grid gap-0.5">
                <strong className="text-ui font-semibold text-fg-primary">{copy.passageHeading}</strong>
                <span className="text-caption text-fg-secondary">
                  {tutor ? tutor.name : t.app.teachers}
                </span>
              </div>
            </div>

            <form className="grid gap-3" onSubmit={submitAsk}>
              <Textarea
                value={passage}
                onChange={(event) => setPassage(event.target.value)}
                placeholder={copy.passagePlaceholder}
                rows={4}
                maxLength={3000}
                data-testid="reader-passage-input"
              />
              <TextInput
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                placeholder={copy.questionPlaceholder}
                maxLength={500}
                data-testid="reader-question-input"
              />

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="submit"
                  variant="primary"
                  size="sm"
                  pending={askMutation.isPending}
                  disabled={!passage.trim()}
                  leftIcon={<Sparkles size={14} aria-hidden="true" />}
                  data-testid="reader-ask-btn"
                >
                  {askMutation.isPending ? copy.asking : copy.askTeacher}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={!passage.trim() && !speech.speaking}
                  leftIcon={
                    speech.speaking ? <VolumeX size={14} aria-hidden="true" /> : <Volume2 size={14} aria-hidden="true" />
                  }
                  onClick={() => speakText(passage)}
                >
                  {speech.speaking ? copy.stopReading : copy.readAloud}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  pending={saveBlockMutation.isPending}
                  disabled={!passage.trim() || !page}
                  leftIcon={<FileText size={14} aria-hidden="true" />}
                  onClick={handleSavePassage}
                  data-testid="reader-save-passage-btn"
                >
                  {copy.saveToNote}
                </Button>
              </div>
            </form>

            {askMutation.isError ? <Problem error={askMutation.error} /> : null}
            {saveBlockMutation.isError ? <Problem error={saveBlockMutation.error} /> : null}
          </Card>

          {askResult ? (
            <Card padding="md" className="grid gap-3 border-accent/30" data-testid="reader-explanation-card">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <strong className="text-ui font-semibold text-fg-primary">{copy.teacherExplain}</strong>
                {askResult.key_takeaway ? (
                  <Badge tone="accent">{askResult.key_takeaway}</Badge>
                ) : null}
              </div>
              <div className="text-ui leading-relaxed text-fg-primary">
                <LessonText source={askResult.explanation} />
              </div>
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  pending={saveBlockMutation.isPending}
                  leftIcon={<FileText size={14} aria-hidden="true" />}
                  onClick={handleSaveExplanation}
                  data-testid="reader-save-explain-btn"
                >
                  {copy.saveExplainToNote}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  leftIcon={<Volume2 size={14} aria-hidden="true" />}
                  onClick={() => speakText(askResult.explanation)}
                >
                  {copy.readAloud}
                </Button>
              </div>
            </Card>
          ) : null}

          {/* Quick Quiz Card */}
          <Card padding="md" className="grid gap-3" data-testid="reader-quick-quiz">
            <h3 className="text-ui font-semibold text-fg-primary">{copy.quickQuizTitle}</h3>
            {!quickQuiz ? (
              <p className="text-caption text-fg-secondary">{copy.quickQuizEmpty}</p>
            ) : (
              <div className="grid gap-3">
                <div className="text-ui text-fg-primary">
                  <LessonText source={quickQuiz.stem} />
                </div>

                {quickQuiz.type === "choice" && quizOptions.length > 0 ? (
                  <ChoiceCardGroup
                    options={quizOptions}
                    value={quizChoice}
                    disabled={Boolean(quizResult) || quizMutation.isPending}
                    onChange={(next) => setQuizChoice(Array.isArray(next) ? (next[0] ?? "") : next)}
                    outcomes={
                      quizResult
                        ? {
                            [quizChoice]: quizResult.verdict === "correct" ? "correct" : "retry",
                            ...(quizResult.answer ? { [quizResult.answer]: "correct" } : {}),
                          }
                        : undefined
                    }
                  />
                ) : (
                  <TextInput
                    value={quizText}
                    disabled={Boolean(quizResult) || quizMutation.isPending}
                    placeholder={copy.quickQuizNumericPlaceholder}
                    onChange={(event) => setQuizText(event.target.value)}
                    data-testid="reader-quiz-input"
                  />
                )}

                {!quizResult ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      variant="primary"
                      size="sm"
                      pending={quizMutation.isPending}
                      disabled={quickQuiz.type === "choice" ? !quizChoice : !quizText.trim()}
                      onClick={() =>
                        quizMutation.mutate({
                          itemId: quickQuiz.id,
                          answer: quickQuiz.type === "choice" ? quizChoice : quizText.trim(),
                        })
                      }
                      data-testid="reader-quiz-submit"
                    >
                      {copy.quickQuizSubmit}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      pending={quizMutation.isPending}
                      onClick={() => quizMutation.mutate({ itemId: quickQuiz.id, dontKnow: true })}
                    >
                      {copy.quickQuizDontKnow}
                    </Button>
                  </div>
                ) : (
                  <div className="grid gap-2 rounded-md border border-line-subtle bg-surface-page p-3 text-caption">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <Badge tone={quizResult.verdict === "correct" ? "ok" : "retry"}>
                        <CheckCircle2 size={12} aria-hidden="true" />
                        <span>
                          {quizResult.verdict === "correct" ? copy.quickQuizCorrect : copy.quickQuizWrong}
                        </span>
                      </Badge>
                      <span className="tabular-nums text-fg-secondary">
                        {copy.quickQuizDelta
                          .replace("{before}", String(Math.round(quizResult.p_before * 100)))
                          .replace("{after}", String(Math.round(quizResult.p_after * 100)))}
                      </span>
                    </div>
                    {quizResult.solution ? (
                      <div className="text-ui text-fg-primary">
                        <LessonText source={quizResult.solution} />
                      </div>
                    ) : null}
                  </div>
                )}

                {quizMutation.isError ? <Problem error={quizMutation.error} /> : null}
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
