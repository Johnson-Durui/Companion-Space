import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams, useSearchParams } from "react-router";
import clsx from "clsx";
import { LessonText } from "@companion-space/board";
import { TutorVideoBox } from "@companion-space/avatar-engine";
import { charactersKey, fetchCharacters, fetchSettings, publicMessage, settingsKey, type Character } from "../../app/api";
import { Loading, Problem } from "../../app/ui";
import { FocusShell } from "../../shell/FocusShell";
import {
  ArrowRight,
  Badge,
  Button,
  Card,
  Checkbox,
  ChevronDown,
  ChevronUp,
  Chip,
  ChoiceCardGroup,
  ConfirmDialog,
  Field,
  FileDropzone,
  Play,
  SegmentedControl,
  Select,
  Spinner,
  Stepper,
  TextInput,
  Textarea,
  TutorAvatar,
  Volume2,
  toast,
} from "../../ui";
import t from "../../locales/zh-CN.json";
import { toVideoAvatarConfig, videoBoxLabels } from "../characters/video-config";
import {
  answerInterview,
  answerPlacement,
  createPlan,
  finishPlacement,
  getEnrollment,
  getInterview,
  getLearnerProfile,
  getPlan,
  getPlacement,
  learnerKeys,
  skipInterview,
  type CourseEnrollment,
  type LearnerProfile,
} from "../learner/api";
import { isLessonItem, planItemDisplayTitle, planItemKindLabel } from "../plan/item-kind";
import { PlanItemWhyPanel } from "../plan/plan-page";
import { masteryLabel, masteryLevel } from "../plan/why-sentence";
import { ConnectWizardDialog } from "../settings/connect-wizard";
import { useReadiness } from "../settings/use-readiness";
import { useTutorSpeech } from "../voice/use-tutor-speech";
import {
  courseKeys,
  getAnalysis,
  getCourse,
  getCourseJourney,
  getCourseMap,
  listMaterials,
  pasteMaterial,
  retryAnalysis,
  startAnalysis,
  uploadMaterials,
} from "./api";
import {
  BACKEND_STAGES,
  coarseStageIndex,
  estimateRemainingMinutes,
  formatFileSize,
} from "./analysis-stages";
import { inferMaterial } from "./materials";
import type { AnalysisStart, Job, MaterialRole } from "./types";

const copy = t.setup;
const ROLES = Object.keys(t.courses.roles) as MaterialRole[];
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;
const SESSION_CHOICES = [20, 30, 45, 60] as const;
const SETUP_STEPS = ["materials", "analysis", "interview", "placement", "plan"] as const;
type SetupStep = (typeof SETUP_STEPS)[number];
type PendingFile = { file: File; role: MaterialRole; year?: number; exam_name?: string; has_answers?: boolean };

function isSetupStep(value: string | null): value is SetupStep {
  return value !== null && (SETUP_STEPS as readonly string[]).includes(value);
}

function useAnalysisEventsStream(courseId: string, job: Job | null | undefined) {
  const queries = useQueryClient();
  const jobId = job?.id;
  const terminal = job?.status === "completed" || job?.status === "failed";
  useEffect(() => {
    if (!jobId || terminal) return;
    const source = new EventSource(`/api/v2/courses/${courseId}/analysis/events`);
    source.addEventListener("job", (event) => {
      const next = JSON.parse((event as MessageEvent<string>).data) as Job;
      queries.setQueryData(courseKeys.analysis(courseId), next);
      if (next.status === "completed" || next.status === "failed") {
        source.close();
        void queries.invalidateQueries({ queryKey: courseKeys.map(courseId) });
        void queries.invalidateQueries({ queryKey: courseKeys.materials(courseId) });
        void queries.invalidateQueries({ queryKey: courseKeys.journey(courseId) });
        void queries.invalidateQueries({ queryKey: learnerKeys.placement(courseId) });
      }
    });
    source.onerror = () => void queries.invalidateQueries({ queryKey: courseKeys.analysis(courseId) });
    return () => source.close();
  }, [courseId, jobId, queries, terminal]);
}

function summarizeTopicValues(
  topic: string,
  values: Record<string, unknown>,
): string {
  if (topic === "identity") {
    const parts = [
      typeof values.nickname === "string" && values.nickname.trim() ? values.nickname.trim() : null,
      typeof values.level === "string"
        ? t.learner.levels[values.level as keyof typeof t.learner.levels]
        : null,
    ].filter(Boolean);
    return parts.join(" · ") || t.learner.levels.self_study;
  }
  if (topic === "goal") {
    const g = typeof values.goal_type === "string"
      ? t.learner.goals[values.goal_type as keyof typeof t.learner.goals]
      : t.learner.goals.interest;
    const extra = [values.exam_name, values.exam_date].filter((v) => typeof v === "string" && v).join(" ");
    return [g, extra].filter(Boolean).join(" · ");
  }
  if (topic === "schedule") {
    const days = Array.isArray(values.weekly_days)
      ? values.weekly_days.map((d) => t.learner.weekdays[Number(d) - 1]).filter(Boolean).join("、")
      : "";
    const min = values.session_minutes ? `${values.session_minutes} ${t.learner.minutes}` : "";
    return [days, min].filter(Boolean).join(" · ");
  }
  if (topic === "starting_point") {
    const lvl = typeof values.self_level === "string"
      ? t.learner.selfLevels[values.self_level as keyof typeof t.learner.selfLevels]
      : "";
    return lvl || t.learner.selfLevels.never;
  }
  if (topic === "hard_parts") {
    const hints = typeof values.teacher_hints === "string" && values.teacher_hints.trim()
      ? values.teacher_hints.trim().slice(0, 28)
      : "";
    const count = Array.isArray(values.hard_units) ? values.hard_units.length : 0;
    return [count ? `${count} 个难点章节` : null, hints].filter(Boolean).join(" · ") || "无特别标注";
  }
  const style = typeof values.preferred_style_id === "string"
    ? t.learner.styles[values.preferred_style_id as keyof typeof t.learner.styles]
    : "";
  const pace = typeof values.pace === "string"
    ? t.learner.paces[values.pace as keyof typeof t.learner.paces]
    : "";
  return [style, pace].filter(Boolean).join(" · ");
}

export default function CourseSetupPage() {
  const courseId = useParams().courseId ?? "";
  const [searchParams, setSearchParams] = useSearchParams();
  const queries = useQueryClient();
  const readiness = useReadiness();
  const speech = useTutorSpeech();

  const [connectOpen, setConnectOpen] = useState(false);
  const [pendingConnectAnalyze, setPendingConnectAnalyze] = useState(false);

  const course = useQuery({
    queryKey: courseKeys.one(courseId),
    queryFn: () => getCourse(courseId),
    enabled: Boolean(courseId),
  });
  const journey = useQuery({
    queryKey: courseKeys.journey(courseId),
    queryFn: () => getCourseJourney(courseId),
    enabled: Boolean(courseId),
  });
  const settings = useQuery({ queryKey: settingsKey, queryFn: fetchSettings });
  const characters = useQuery({ queryKey: charactersKey, queryFn: fetchCharacters });
  const materials = useQuery({
    queryKey: courseKeys.materials(courseId),
    queryFn: () => listMaterials(courseId),
    enabled: Boolean(courseId),
  });
  const analysis = useQuery({
    queryKey: courseKeys.analysis(courseId),
    queryFn: () => getAnalysis(courseId),
    enabled: Boolean(courseId),
    refetchInterval: (q) => (q.state.data?.status === "running" || q.state.data?.status === "queued" ? 2500 : false),
  });
  const map = useQuery({
    queryKey: courseKeys.map(courseId),
    queryFn: () => getCourseMap(courseId),
    enabled: Boolean(courseId),
  });
  const profile = useQuery({ queryKey: learnerKeys.profile, queryFn: getLearnerProfile });
  const enrollment = useQuery({
    queryKey: learnerKeys.enrollment(courseId),
    queryFn: () => getEnrollment(courseId),
    enabled: Boolean(courseId),
  });
  const plan = useQuery({
    queryKey: learnerKeys.plan(courseId),
    queryFn: () => getPlan(courseId),
    enabled: Boolean(courseId),
  });

  useAnalysisEventsStream(courseId, analysis.data);

  const paramStep = searchParams.get("step");
  const defaultStep: SetupStep = useMemo(() => {
    const next = journey.data?.next_step;
    if (next && isSetupStep(next)) return next;
    if (next === "learn") return "plan";
    return "materials";
  }, [journey.data?.next_step]);

  const activeStep: SetupStep = isSetupStep(paramStep) ? paramStep : defaultStep;

  function goStep(next: SetupStep) {
    const updated = new URLSearchParams(searchParams);
    updated.set("step", next);
    setSearchParams(updated, { replace: true });
  }

  const teacher = useMemo(() => {
    const list = characters.data ?? [];
    return list.find((entry) => entry.id === settings.data?.default_character_id) ?? list[0] ?? null;
  }, [characters.data, settings.data?.default_character_id]);

  // Step 1 state
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [largeConfirm, setLargeConfirm] = useState<AnalysisStart | null>(null);

  const startReadMutation = useMutation({
    mutationFn: (confirmed: boolean) => startAnalysis(courseId, confirmed),
    onSuccess: (res) => {
      if (res.requires_confirmation && !res.job) {
        setLargeConfirm(res);
        return;
      }
      setLargeConfirm(null);
      if (res.job) queries.setQueryData(courseKeys.analysis(courseId), res.job);
      void queries.invalidateQueries({ queryKey: courseKeys.journey(courseId) });
      goStep("analysis");
    },
  });

  const uploadAndStartMutation = useMutation({
    mutationFn: async ({ autoStart }: { autoStart: boolean }) => {
      if (pendingFiles.length > 0) {
        await uploadMaterials(
          courseId,
          pendingFiles.map((entry) => entry.file),
          pendingFiles.map((entry) => ({
            role: entry.role,
            year: entry.year,
            exam_name: entry.exam_name,
            has_answers: entry.has_answers,
          })),
        );
        setPendingFiles([]);
        await queries.invalidateQueries({ queryKey: courseKeys.materials(courseId) });
        await queries.invalidateQueries({ queryKey: courseKeys.journey(courseId) });
      }
      if (autoStart) {
        const res = await startAnalysis(courseId, false);
        return res;
      }
      return null;
    },
    onSuccess: (res) => {
      if (!res) {
        toast.success(t.common.saved);
        return;
      }
      if (res.requires_confirmation && !res.job) {
        setLargeConfirm(res);
        return;
      }
      if (res.job) queries.setQueryData(courseKeys.analysis(courseId), res.job);
      void queries.invalidateQueries({ queryKey: courseKeys.journey(courseId) });
      goStep("analysis");
    },
  });

  const pasteMutation = useMutation({
    mutationFn: (body: { title: string; content: string; role: MaterialRole }) => pasteMaterial(courseId, body),
    onSuccess: () => {
      toast.success(t.common.saved);
      void queries.invalidateQueries({ queryKey: courseKeys.materials(courseId) });
      void queries.invalidateQueries({ queryKey: courseKeys.journey(courseId) });
    },
  });

  const retryStageMutation = useMutation({
    mutationFn: (stage: string) => retryAnalysis(courseId, stage),
    onSuccess: (job) => {
      queries.setQueryData(courseKeys.analysis(courseId), job);
      void queries.invalidateQueries({ queryKey: courseKeys.journey(courseId) });
    },
  });

  // Step 3 Interview (ONLY queried when on Step 3 per §5.5!)
  const interview = useQuery({
    queryKey: learnerKeys.interview(courseId),
    queryFn: () => getInterview(courseId),
    enabled: Boolean(courseId) && activeStep === "interview",
  });

  // Step 4 Placement (ONLY queried when on Step 4 AND materials_ready!)
  const materialsReady = Boolean(journey.data?.materials_ready);
  const placement = useQuery({
    queryKey: learnerKeys.placement(courseId),
    queryFn: () => getPlacement(courseId),
    enabled: Boolean(courseId) && activeStep === "placement" && materialsReady,
  });

  const buildPlanMutation = useMutation({
    mutationFn: () => createPlan(courseId),
    onSuccess: (saved) => {
      queries.setQueryData(learnerKeys.plan(courseId), saved);
      void queries.invalidateQueries({ queryKey: courseKeys.all });
      void queries.invalidateQueries({ queryKey: courseKeys.journey(courseId) });
      goStep("plan");
    },
  });

  if (course.isPending || journey.isPending) {
    return (
      <FocusShell flowName={copy.flowName} exitTo={`/courses/${courseId}`}>
        <Loading />
      </FocusShell>
    );
  }
  if (course.isError) {
    return (
      <FocusShell flowName={copy.flowName} exitTo="/courses">
        <Problem error={course.error} onRetry={() => void course.refetch()} />
      </FocusShell>
    );
  }
  if (journey.isError) {
    return (
      <FocusShell flowName={copy.flowName} exitTo={`/courses/${courseId}`}>
        <Problem error={journey.error} onRetry={() => void journey.refetch()} />
      </FocusShell>
    );
  }

  const j = journey.data;
  const stepperItems = [
    { id: "materials", label: copy.steps[0], status: j.steps.materials },
    { id: "analysis", label: copy.steps[1], status: j.steps.analysis },
    { id: "interview", label: copy.steps[2], status: j.steps.interview },
    {
      id: "placement",
      label: copy.steps[3],
      status: j.steps.placement,
      hint: !materialsReady ? t.learner.placementWaitMaterials : undefined,
    },
    { id: "plan", label: copy.steps[4], status: j.steps.plan },
  ];

  const uploadedCount = materials.data?.length ?? 0;

  return (
    <FocusShell
      flowName={`${course.data.name} · ${copy.flowName}`}
      exitTo={`/courses/${courseId}`}
      exitLabel={t.classroom.backToCourse}
      progress={
        <Stepper
          steps={stepperItems}
          currentId={activeStep}
          compact
          onSelect={(id) => {
            if (isSetupStep(id)) goStep(id);
          }}
        />
      }
    >
      <div className="grid gap-6" data-testid="course-setup" data-step={activeStep}>
        {/* STEP 1: MATERIALS */}
        {activeStep === "materials" ? (
          <Card padding="lg" className="grid gap-5">
            <div className="grid gap-1">
              <h1 className="text-headline font-semibold text-fg-primary">{copy.step1Title}</h1>
              <p className="text-ui text-fg-secondary">{copy.step1Hint}</p>
            </div>

            <FileDropzone
              onFiles={(files) => {
                const additions = files.map((file) => ({ file, ...inferMaterial(file.name) }));
                setPendingFiles((prev) => [...prev, ...additions]);
              }}
              accept=".pdf,.pptx,.docx,.md,.txt,.png,.jpg,.jpeg,.webp"
              title={t.courses.drop}
              description={t.courses.formats}
              buttonLabel={t.courses.choose}
            />

            {pendingFiles.length > 0 ? (
              <div className="grid gap-2.5">
                {pendingFiles.map((entry, index) => (
                  <div
                    key={`${entry.file.name}:${entry.file.lastModified}:${index}`}
                    data-testid="pending-file"
                    className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-line-subtle bg-surface-page p-3"
                  >
                    <div className="grid min-w-0">
                      <strong className="truncate text-ui font-medium text-fg-primary">{entry.file.name}</strong>
                      <small className="text-caption text-fg-tertiary">{formatFileSize(entry.file.size)}</small>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Select
                        aria-label={t.courses.role}
                        value={entry.role}
                        onValueChange={(value) =>
                          setPendingFiles((items) =>
                            items.map((item, idx) => (idx === index ? { ...item, role: value as MaterialRole } : item)),
                          )
                        }
                        options={ROLES.map((role) => ({ value: role, label: t.courses.roles[role] }))}
                        className="w-36"
                      />
                      {entry.role === "exam" ? (
                        <>
                          <TextInput
                            type="number"
                            min="1900"
                            max="2100"
                            placeholder={t.courses.year}
                            value={entry.year ?? ""}
                            onChange={(e) =>
                              setPendingFiles((items) =>
                                items.map((item, idx) =>
                                  idx === index ? { ...item, year: e.target.value ? Number(e.target.value) : undefined } : item,
                                ),
                              )
                            }
                            className="w-24"
                          />
                          <TextInput
                            placeholder={t.courses.examName}
                            value={entry.exam_name ?? ""}
                            onChange={(e) =>
                              setPendingFiles((items) =>
                                items.map((item, idx) =>
                                  idx === index ? { ...item, exam_name: e.target.value || undefined } : item,
                                ),
                              )
                            }
                            className="w-36"
                          />
                          <Checkbox
                            label={t.courses.hasAnswers}
                            checked={entry.has_answers ?? false}
                            onChange={(e) =>
                              setPendingFiles((items) =>
                                items.map((item, idx) =>
                                  idx === index ? { ...item, has_answers: e.target.checked } : item,
                                ),
                              )
                            }
                          />
                        </>
                      ) : null}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setPendingFiles((items) => items.filter((_, idx) => idx !== index))}
                      >
                        {t.common.remove}
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            ) : null}

            {uploadedCount > 0 ? (
              <div className="grid gap-2">
                <p className="text-caption font-medium text-fg-tertiary">{t.courseHub.materialsCard}</p>
                <ul className="grid gap-1.5">
                  {materials.data!.map((m) => (
                    <li
                      key={m.id}
                      data-testid="material-item"
                      className="flex items-center justify-between gap-2 rounded-md bg-surface-sunken/60 px-3 py-2 text-ui"
                    >
                      <span className="truncate font-medium text-fg-primary">{m.title || m.filename}</span>
                      <Badge tone="neutral">{t.courses.roles[m.role]}</Badge>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <details className="rounded-md border border-line-subtle bg-surface-page px-4 py-3">
              <summary className="cursor-pointer text-ui font-medium text-fg-secondary select-none">
                {t.courses.paste}
              </summary>
              <form
                className="mt-3 grid gap-3"
                onSubmit={(event: FormEvent<HTMLFormElement>) => {
                  event.preventDefault();
                  const form = event.currentTarget;
                  const data = new FormData(form);
                  pasteMutation.mutate(
                    {
                      title: String(data.get("title")),
                      content: String(data.get("content")),
                      role: String(data.get("role")) as MaterialRole,
                    },
                    { onSuccess: () => form.reset() },
                  );
                }}
              >
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label={t.courses.pasteTitle} required>
                    <TextInput name="title" maxLength={120} required />
                  </Field>
                  <label className="grid gap-1 text-ui font-medium text-fg-primary">
                    <span>{t.courses.role}</span>
                    <select name="role" defaultValue="notes" className="min-h-10 rounded-md border border-line-control bg-surface-card px-3 text-ui">
                      {ROLES.map((role) => (
                        <option key={role} value={role}>{t.courses.roles[role]}</option>
                      ))}
                    </select>
                  </label>
                </div>
                <Field label={t.courses.pasteContent} required>
                  <Textarea name="content" rows={4} required />
                </Field>
                <div>
                  <Button type="submit" variant="secondary" pending={pasteMutation.isPending}>
                    {t.courses.addPaste}
                  </Button>
                </div>
                {pasteMutation.isError ? <Problem error={pasteMutation.error} /> : null}
              </form>
            </details>

            {uploadAndStartMutation.isError ? <Problem error={uploadAndStartMutation.error} /> : null}
            {startReadMutation.isError ? <Problem error={startReadMutation.error} /> : null}

            <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
              {uploadedCount > 0 ? (
                <Button variant="ghost" onClick={() => goStep("interview")}>
                  {copy.chatWhileReading}
                </Button>
              ) : (
                <span />
              )}

              {pendingFiles.length > 0 && !readiness.canAnalyze ? (
                <Button
                  variant="primary"
                  size="lg"
                  pending={uploadAndStartMutation.isPending}
                  onClick={() => {
                    goStep("materials");
                    uploadAndStartMutation.mutate({ autoStart: false });
                  }}
                >
                  {copy.uploadOnly}
                </Button>
              ) : !readiness.canAnalyze ? (
                <Button
                  variant="primary"
                  size="lg"
                  disabled={uploadedCount === 0 && pendingFiles.length === 0}
                  onClick={() => {
                    setPendingConnectAnalyze(true);
                    setConnectOpen(true);
                  }}
                >
                  {copy.connectToRead}
                </Button>
              ) : (
                <Button
                  variant="primary"
                  size="lg"
                  pending={uploadAndStartMutation.isPending}
                  disabled={uploadedCount === 0 && pendingFiles.length === 0}
                  onClick={() => uploadAndStartMutation.mutate({ autoStart: true })}
                >
                  {copy.handToTeacher}
                </Button>
              )}
            </div>
          </Card>
        ) : null}

        {/* STEP 2: READING MATERIALS */}
        {activeStep === "analysis" ? (
          <SetupAnalysisStep
            courseId={courseId}
            teacher={teacher}
            job={analysis.data ?? null}
            materialsReady={materialsReady}
            interviewDone={j.steps.interview === "done"}
            placementDone={j.steps.placement === "done"}
            canAnalyze={readiness.canAnalyze}
            mapData={map.data}
            starting={startReadMutation.isPending}
            retrying={retryStageMutation.isPending}
            error={startReadMutation.error ?? retryStageMutation.error}
            onStart={() => startReadMutation.mutate(false)}
            onRetry={(stage) => retryStageMutation.mutate(stage)}
            onConnect={() => {
              setPendingConnectAnalyze(true);
              setConnectOpen(true);
            }}
            onGoStep={goStep}
          />
        ) : null}

        {/* STEP 3: INTERVIEW */}
        {activeStep === "interview" ? (
          <SetupInterviewStep
            courseId={courseId}
            teacher={teacher}
            interviewQuery={interview}
            profile={profile.data}
            enrollment={enrollment.data}
            units={map.data?.units ?? []}
            materialsReady={materialsReady}
            speech={speech}
            onComplete={() => {
              void queries.invalidateQueries({ queryKey: courseKeys.journey(courseId) });
              goStep(materialsReady ? "placement" : "analysis");
            }}
          />
        ) : null}

        {/* STEP 4: PLACEMENT */}
        {activeStep === "placement" ? (
          <SetupPlacementStep
            courseId={courseId}
            materialsReady={materialsReady}
            job={analysis.data ?? null}
            placementQuery={placement}
            units={map.data?.units ?? []}
            buildingPlan={buildPlanMutation.isPending}
            buildError={buildPlanMutation.error}
            onBuildPlan={() => buildPlanMutation.mutate()}
            onBackToReading={() => goStep("analysis")}
          />
        ) : null}

        {/* STEP 5: PLAN REVEAL */}
        {activeStep === "plan" ? (
          <SetupPlanStep
            courseId={courseId}
            teacher={teacher}
            plan={plan.data}
            enrollment={enrollment.data}
            building={buildPlanMutation.isPending}
            buildError={buildPlanMutation.error}
            onBuild={() => buildPlanMutation.mutate()}
          />
        ) : null}
      </div>

      {/* Large Analysis Confirmation Dialog (human scale, tokens tucked inside details) */}
      <ConfirmDialog
        open={Boolean(largeConfirm)}
        onOpenChange={(open) => {
          if (!open) setLargeConfirm(null);
        }}
        title={copy.largeConfirmTitle}
        description={
          <div className="grid gap-2">
            <p>{copy.largeConfirmBody}</p>
            {largeConfirm ? (
              <details className="text-caption text-fg-tertiary">
                <summary className="cursor-pointer">{copy.largeConfirmDetails}</summary>
                <p className="mt-1">
                  {copy.largeConfirmTokens.replace("{tokens}", largeConfirm.estimated_tokens.toLocaleString())}
                </p>
              </details>
            ) : null}
          </div>
        }
        confirmLabel={t.courses.confirmStart}
        cancelLabel={t.common.cancel}
        pending={startReadMutation.isPending}
        onConfirm={() => startReadMutation.mutate(true)}
      />

      <ConnectWizardDialog
        open={connectOpen}
        onOpenChange={(open) => {
          setConnectOpen(open);
          if (!open) setPendingConnectAnalyze(false);
        }}
        onConnected={() => {
          if (pendingConnectAnalyze && uploadedCount > 0) {
            setPendingConnectAnalyze(false);
            startReadMutation.mutate(false);
          }
        }}
      />
    </FocusShell>
  );
}

function SetupAnalysisStep({
  courseId,
  teacher,
  job,
  materialsReady,
  interviewDone,
  placementDone,
  canAnalyze,
  mapData,
  starting,
  retrying,
  error,
  onStart,
  onRetry,
  onConnect,
  onGoStep,
}: {
  courseId: string;
  teacher: { id: string; name: string; appearance: { src: string } } | null;
  job: Job | null;
  materialsReady: boolean;
  interviewDone: boolean;
  placementDone: boolean;
  canAnalyze: boolean;
  mapData: Awaited<ReturnType<typeof getCourseMap>> | undefined;
  starting: boolean;
  retrying: boolean;
  error: unknown;
  onStart: () => void;
  onRetry: (stage: string) => void;
  onConnect: () => void;
  onGoStep: (step: SetupStep) => void;
}) {
  const isRunning = job?.status === "queued" || job?.status === "running";
  const isFailed = job?.status === "failed";
  const isDone = job?.status === "completed" || materialsReady;
  const coarseIdx = isDone ? 4 : coarseStageIndex(job?.stage);
  const currentStageLabel = copy.coarseStages[Math.min(3, coarseIdx)] ?? copy.coarseStages[0];

  const allPoints = useMemo(
    () => mapData?.units.flatMap((unit) => unit.knowledge_points) ?? [],
    [mapData],
  );
  const topExamNames = useMemo(
    () =>
      [...allPoints]
        .filter((pt) => (pt.stats?.score_share ?? 0) > 0)
        .sort((a, b) => (b.stats?.score_share ?? 0) - (a.stats?.score_share ?? 0))
        .slice(0, 3)
        .map((pt) => pt.name),
    [allPoints],
  );

  const etaMin = job ? estimateRemainingMinutes(job.progress, job.created_at) : null;
  const backendStageIdx = Math.max(0, BACKEND_STAGES.indexOf((job?.stage ?? "parse") as (typeof BACKEND_STAGES)[number]));

  const progressText =
    allPoints.length > 0
      ? copy.progressWithCount.replace("{stage}", currentStageLabel).replace("{count}", String(allPoints.length))
      : copy.progressPlain.replace("{stage}", currentStageLabel);

  return (
    <Card padding="lg" className="grid gap-5" data-testid="setup-analysis-step">
      <div className="flex flex-wrap items-center gap-4">
        {teacher ? <TutorAvatar src={teacher.appearance.src} name={teacher.name} size="lg" /> : null}
        <div className="grid gap-1">
          <h1 className="text-headline font-semibold text-fg-primary">
            {isDone ? copy.readingDoneTitle : copy.step2Title}
          </h1>
          <p className="text-body text-fg-secondary" role="status">
            {isDone
              ? mapData?.has_exams
                ? copy.resultCounts
                    .replace("{units}", String(mapData.units.length))
                    .replace("{kps}", String(allPoints.length))
                    .replace("{exams}", String(mapData.brief?.section_count ?? 1))
                    .replace("{items}", String(mapData.brief?.item_count ?? 0))
                : copy.resultCountsNoExam
                    .replace("{units}", String(mapData?.units.length ?? 0))
                    .replace("{kps}", String(allPoints.length))
              : isFailed
                ? copy.readingFailed
                : progressText}
          </p>
        </div>
      </div>

      {/* 4 Coarse Stages */}
      <Stepper
        steps={copy.coarseStages.map((label, idx) => ({
          id: String(idx),
          label,
          status:
            isDone || idx < coarseIdx
              ? "done"
              : idx === coarseIdx && isRunning
                ? "active"
                : "todo",
        }))}
        currentId={String(Math.min(3, coarseIdx))}
      />

      {isRunning ? (
        <div className="flex items-center gap-2.5 text-ui text-fg-secondary">
          <Spinner size={16} />
          <span>
            {etaMin
              ? copy.etaMinutes.replace("{min}", String(etaMin))
              : copy.etaUnknown}
          </span>
        </div>
      ) : null}

      {isDone && topExamNames.length > 0 ? (
        <div className="rounded-md bg-accent-soft/45 px-4 py-3 text-ui text-fg-primary">
          {copy.topExamPoints.replace("{names}", topExamNames.join("、"))}
        </div>
      ) : null}

      {isDone && mapData?.warnings.length ? (
        <ul className="grid gap-2">
          {mapData.warnings.map((w) => (
            <li key={w} className="rounded-md border border-warn/30 bg-warn-soft px-3.5 py-2 text-ui text-warn-text">
              {t.courses.warnings[w as keyof typeof t.courses.warnings] ?? w}
            </li>
          ))}
        </ul>
      ) : null}

      {isFailed ? (
        <div className="grid gap-3 rounded-md border border-danger/30 bg-danger-soft p-4 text-ui text-danger-text">
          <p role="alert">{job?.error ? (publicMessage({ code: job.error }) ?? copy.readingFailed) : copy.readingFailed}</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" onClick={onConnect}>
              {t.classroom.checkAiService}
            </Button>
            <Button
              variant="primary"
              size="sm"
              pending={retrying}
              onClick={() => onRetry(job?.stage || "parse")}
            >
              {copy.retryStage}
            </Button>
          </div>
        </div>
      ) : null}

      {error ? <Problem error={error} /> : null}

      {/* Details collapsible: 10 backend stages + retry */}
      {job ? (
        <details className="rounded-md border border-line-subtle bg-surface-page px-4 py-3">
          <summary className="cursor-pointer text-ui font-medium text-fg-secondary select-none">
            {copy.viewDetails}
          </summary>
          <div className="mt-3 grid gap-2 text-caption text-fg-secondary">
            {job.detail ? <p>{job.detail}</p> : null}
            <ol className="grid gap-1 sm:grid-cols-2">
              {BACKEND_STAGES.map((stage, idx) => (
                <li key={stage} className="flex items-center gap-2">
                  <Badge
                    tone={
                      job.status === "completed" || idx < backendStageIdx
                        ? "ok"
                        : idx === backendStageIdx
                          ? job.status === "failed"
                            ? "danger"
                            : "accent"
                          : "neutral"
                    }
                  >
                    {idx + 1}
                  </Badge>
                  <span>{t.courses.stages[stage]}</span>
                </li>
              ))}
            </ol>
          </div>
        </details>
      ) : null}

      {/* Single Primary CTA */}
      <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
        {!isDone && interviewDone ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-ui text-fg-secondary">{copy.waitDoneHint}</span>
            <Link className="button quiet" to="/sample-lesson">{t.today.trySample}</Link>
            <Link className="button quiet" to="/tutors">{copy.browseTutors}</Link>
          </div>
        ) : (
          <Link className="text-ui font-medium text-fg-secondary hover:text-fg-primary" to={`/courses/${courseId}/materials`}>
            {t.courseHub.tabs.materials}
          </Link>
        )}

        {isDone ? (
          !interviewDone ? (
            <Button variant="primary" size="lg" onClick={() => onGoStep("interview")}>
              {t.courseHub.stageCtas.interview}
            </Button>
          ) : !placementDone ? (
            <Button variant="primary" size="lg" onClick={() => onGoStep("placement")}>
              {copy.goPlacement}
            </Button>
          ) : (
            <Button variant="primary" size="lg" onClick={() => onGoStep("plan")}>
              {copy.goPlan}
            </Button>
          )
        ) : !job && !canAnalyze ? (
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={onConnect}>
              {t.today.connectFirst}
            </Button>
            <Button variant="primary" onClick={() => onGoStep("interview")}>
              {copy.chatWhileReading}
            </Button>
          </div>
        ) : !job ? (
          <Button variant="primary" size="lg" pending={starting} onClick={onStart}>
            {copy.handToTeacher}
          </Button>
        ) : !interviewDone ? (
          <Button variant="primary" size="lg" onClick={() => onGoStep("interview")}>
            {copy.chatWhileReading}
          </Button>
        ) : null}
      </div>
    </Card>
  );
}

function SetupInterviewStep({
  courseId,
  teacher,
  interviewQuery,
  profile,
  enrollment,
  units,
  materialsReady,
  speech,
  onComplete,
}: {
  courseId: string;
  teacher: Character | null;
  interviewQuery: ReturnType<typeof useQuery<Awaited<ReturnType<typeof getInterview>>>>;
  profile: LearnerProfile | undefined;
  enrollment: CourseEnrollment | undefined;
  units: Array<{ id: string; title: string }>;
  materialsReady: boolean;
  speech: ReturnType<typeof useTutorSpeech>;
  onComplete: () => void;
}) {
  const queries = useQueryClient();
  const [freeText, setFreeText] = useState("");
  const [fallbackNotice, setFallbackNotice] = useState(false);
  const [recaps, setRecaps] = useState<Array<{ topic: string; summary: string }>>([]);
  const [editingKnown, setEditingKnown] = useState<Record<string, boolean>>({});

  // Structured control state across the 6 topics
  const [nickname, setNickname] = useState(profile?.nickname ?? "");
  const [level, setLevel] = useState<LearnerProfile["level"]>(profile?.level ?? "self_study");
  const [goalType, setGoalType] = useState<CourseEnrollment["goal_type"]>(enrollment?.goal_type ?? "exam");
  const [examName, setExamName] = useState(enrollment?.exam_name ?? "");
  const [examDate, setExamDate] = useState(enrollment?.exam_date ?? "");
  const [targetScore, setTargetScore] = useState(
    enrollment?.target_score != null ? String(enrollment.target_score) : "",
  );
  const [weeklyDays, setWeeklyDays] = useState<number[]>(
    enrollment?.weekly_days?.length ? enrollment.weekly_days : [1, 3, 5],
  );
  const [sessionMinutes, setSessionMinutes] = useState<number>(enrollment?.session_minutes ?? 30);
  const [selfLevel, setSelfLevel] = useState<CourseEnrollment["self_level"]>(enrollment?.self_level ?? "basic");
  const [hardUnits, setHardUnits] = useState<string[]>(enrollment?.hard_units ?? []);
  const [teacherHints, setTeacherHints] = useState(enrollment?.teacher_hints ?? "");
  const [styleId, setStyleId] = useState<LearnerProfile["preferred_style_id"]>(
    profile?.preferred_style_id ?? "guided",
  );
  const [pace, setPace] = useState<LearnerProfile["pace"]>(profile?.pace ?? "normal");
  const [encouragement, setEncouragement] = useState<LearnerProfile["encouragement"]>(
    profile?.encouragement ?? "normal",
  );

  const data = interviewQuery.data;
  const currentTopic = data?.current ?? null;

  // Speak question via B13 when topic arrives
  const questionText = currentTopic
    ? data?.question || copy.fixedPrompts[currentTopic as keyof typeof copy.fixedPrompts] || ""
    : "";

  useEffect(() => {
    if (!currentTopic || !questionText || !teacher) return;
    void speech.speak({ characterId: teacher.id, text: questionText });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTopic, teacher?.id]);

  const submitTopic = useMutation({
    mutationFn: ({
      topic,
      values,
      text,
    }: {
      topic: string;
      values: Record<string, unknown>;
      text?: string;
    }) => answerInterview(courseId, topic, values, text ?? ""),
    onSuccess: (next, variables) => {
      if (next.fallback_to_chips && variables.text) {
        setFallbackNotice(true);
        return;
      }
      setFallbackNotice(false);
      setFreeText("");
      setRecaps((prev) => [
        ...prev.filter((entry) => entry.topic !== variables.topic),
        { topic: variables.topic, summary: summarizeTopicValues(variables.topic, variables.values) },
      ]);
      queries.setQueryData(learnerKeys.interview(courseId), next);
      void queries.invalidateQueries({ queryKey: learnerKeys.profile });
      void queries.invalidateQueries({ queryKey: learnerKeys.enrollment(courseId) });
      if (!next.current || next.status === "done") {
        onComplete();
      }
    },
  });

  const skipAll = useMutation({
    mutationFn: () => skipInterview(courseId),
    onSuccess: (next) => {
      queries.setQueryData(learnerKeys.interview(courseId), next);
      onComplete();
    },
  });

  const teacherConfig = useMemo(
    () => (teacher ? toVideoAvatarConfig(teacher, false) : null),
    [teacher],
  );
  const labels = useMemo(() => videoBoxLabels(), []);

  if (interviewQuery.isPending) return <Loading />;
  if (interviewQuery.isError) {
    return <Problem error={interviewQuery.error} onRetry={() => void interviewQuery.refetch()} />;
  }

  if (!data || !currentTopic) {
    return (
      <Card padding="lg" className="grid gap-4">
        <h1 className="text-headline font-semibold text-fg-primary">{t.courseHub.stageCtas.interview}</h1>
        <Button variant="primary" onClick={onComplete}>
          {copy.goPlacement}
        </Button>
      </Card>
    );
  }

  // E8: Check if current topic is already known (e.g. nickname filled in onboarding!)
  const isKnownIdentity = currentTopic === "identity" && Boolean(profile?.nickname?.trim()) && !editingKnown.identity;

  function buildValuesForTopic(topic: string): Record<string, unknown> {
    if (topic === "identity") {
      return { nickname: nickname.trim() || profile?.nickname || "", level };
    }
    if (topic === "goal") {
      return {
        goal_type: goalType,
        exam_name: goalType === "exam" ? examName.trim() : "",
        exam_date: goalType === "exam" && examDate.trim() ? examDate.trim() : null,
        target_score: goalType === "exam" && targetScore.trim() !== "" ? Number(targetScore) : null,
      };
    }
    if (topic === "schedule") {
      return {
        weekly_days: [...weeklyDays].sort((a, b) => a - b),
        session_minutes: sessionMinutes,
      };
    }
    if (topic === "starting_point") {
      return { self_level: selfLevel };
    }
    if (topic === "hard_parts") {
      return { hard_units: hardUnits, teacher_hints: teacherHints.trim() };
    }
    return { preferred_style_id: styleId, pace, encouragement };
  }

  function handleContinue(event: FormEvent) {
    event.preventDefault();
    if (!currentTopic) return;
    const values = buildValuesForTopic(currentTopic);
    submitTopic.mutate({
      topic: currentTopic,
      values,
      text: freeText.trim() || undefined,
    });
  }

  const totalTopics = data.topics.length;
  const currentNum = Math.min(totalTopics, data.completed.length + 1);

  return (
    <div className="grid gap-6 md:grid-cols-[240px_1fr]" data-testid="setup-interview-step" data-topic={currentTopic}>
      {/* Teacher Video Column */}
      <div className="mx-auto flex h-[360px] w-[202px] flex-col items-center gap-2 md:h-[420px] md:w-[236px]">
        {teacherConfig ? (
          <TutorVideoBox
            config={teacherConfig}
            pose={speech.speaking ? "lecturing" : "listening_empathy"}
            phase={speech.speaking ? "speaking" : "awaiting"}
            emotion="warm"
            gen={0}
            statusLabel={speech.speaking ? t.classroom.speaking : t.classroom.listening}
            showOverlay={false}
            compact
            labels={labels}
          />
        ) : null}
        {speech.unavailable ? (
          <span role="status" className="text-caption text-fg-tertiary">{t.speech.unavailable}</span>
        ) : null}
      </div>

      {/* Question + Structured Controls Column */}
      <Card padding="lg" className="grid content-start gap-5">
        <div className="flex flex-wrap items-center justify-between gap-2 text-caption text-fg-secondary">
          <h1 className="text-title font-semibold text-fg-primary">
            {copy.step3Progress.replace("{current}", String(currentNum)).replace("{total}", String(totalTopics))}
          </h1>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              pending={submitTopic.isPending}
              onClick={() => submitTopic.mutate({ topic: currentTopic, values: buildValuesForTopic(currentTopic) })}
            >
              {copy.skipQuestion}
            </Button>
            <Button variant="ghost" size="sm" pending={skipAll.isPending} onClick={() => skipAll.mutate()}>
              {copy.skipAll}
            </Button>
          </div>
        </div>

        {/* Previous Recaps */}
        {recaps.length > 0 ? (
          <ul className="grid gap-1.5">
            {recaps.map((entry) => (
              <li
                key={entry.topic}
                className="rounded-md bg-surface-sunken/60 px-3 py-1.5 text-caption text-fg-secondary"
              >
                {copy.recapPrefix.replace("{summary}", entry.summary)}
              </li>
            ))}
          </ul>
        ) : null}

        {/* Teacher Question Bubble */}
        <div className="flex items-start justify-between gap-3 rounded-lg bg-accent-soft/50 p-4 text-body text-fg-primary">
          <p className="font-medium">
            {isKnownIdentity
              ? copy.knownConfirm.replace(
                  "{summary}",
                  summarizeTopicValues("identity", { nickname: profile?.nickname, level: profile?.level }),
                )
              : questionText}
          </p>
          {teacher ? (
            <button
              type="button"
              aria-label={t.speech.replay}
              onClick={() => void speech.speak({ characterId: teacher.id, text: questionText })}
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-fg-secondary hover:bg-surface-card hover:text-fg-primary"
            >
              <Volume2 size={16} aria-hidden="true" />
            </button>
          ) : null}
        </div>

        {isKnownIdentity ? (
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="primary"
              pending={submitTopic.isPending}
              onClick={() =>
                submitTopic.mutate({
                  topic: "identity",
                  values: { nickname: profile?.nickname ?? "", level: profile?.level ?? "self_study" },
                })
              }
            >
              {copy.knownYes}
            </Button>
            <Button
              variant="secondary"
              onClick={() => setEditingKnown((prev) => ({ ...prev, identity: true }))}
            >
              {copy.knownEdit}
            </Button>
          </div>
        ) : (
          <form className="grid gap-4" onSubmit={handleContinue}>
            {/* Topic-specific structured controls */}
            {currentTopic === "identity" ? (
              <>
                <Field label={t.learner.nickname}>
                  <TextInput
                    name="nickname"
                    value={nickname}
                    onChange={(e) => setNickname(e.target.value)}
                    placeholder={t.onboarding.nicknamePlaceholder}
                    maxLength={80}
                  />
                </Field>
                <div className="grid gap-1.5">
                  <span className="text-ui font-medium text-fg-primary">{t.learner.level}</span>
                  <ChoiceCardGroup
                    label={t.learner.level}
                    showKey={false}
                    value={level}
                    onChange={(v) => setLevel(String(v) as LearnerProfile["level"])}
                    options={Object.entries(t.learner.levels).map(([key, label]) => ({ key, text: label }))}
                  />
                </div>
              </>
            ) : null}

            {currentTopic === "goal" ? (
              <>
                <div className="grid gap-1.5">
                  <span className="text-ui font-medium text-fg-primary">{t.learner.goalType}</span>
                  <ChoiceCardGroup
                    label={t.learner.goalType}
                    showKey={false}
                    value={goalType}
                    onChange={(v) => setGoalType(String(v) as CourseEnrollment["goal_type"])}
                    options={Object.entries(t.learner.goals).map(([key, label]) => ({ key, text: label }))}
                  />
                </div>
                {goalType === "exam" ? (
                  <div className="grid gap-3 sm:grid-cols-3">
                    <Field label={t.learner.examName}>
                      <TextInput
                        name="exam_name"
                        value={examName}
                        onChange={(e) => setExamName(e.target.value)}
                        maxLength={120}
                      />
                    </Field>
                    <Field label={t.learner.examDate}>
                      <TextInput
                        name="exam_date"
                        type="date"
                        value={examDate}
                        onChange={(e) => setExamDate(e.target.value)}
                      />
                    </Field>
                    <Field label={t.learner.targetScore}>
                      <TextInput
                        name="target_score"
                        type="number"
                        min="0"
                        max="1000"
                        step="any"
                        value={targetScore}
                        onChange={(e) => setTargetScore(e.target.value)}
                      />
                    </Field>
                  </div>
                ) : null}
              </>
            ) : null}

            {currentTopic === "schedule" ? (
              <>
                <div className="grid gap-1.5">
                  <span className="text-ui font-medium text-fg-primary">{t.learner.weeklyDays}</span>
                  <div className="flex flex-wrap gap-2">
                    {WEEKDAYS.map((day) => (
                      <Chip
                        key={day}
                        selected={weeklyDays.includes(day)}
                        onClick={() =>
                          setWeeklyDays((prev) =>
                            prev.includes(day)
                              ? prev.length > 1
                                ? prev.filter((d) => d !== day)
                                : prev
                              : [...prev, day],
                          )
                        }
                      >
                        {t.learner.weekdays[day - 1]}
                      </Chip>
                    ))}
                  </div>
                </div>
                <div className="grid gap-1.5">
                  <span className="text-ui font-medium text-fg-primary">{t.learner.sessionMinutes}</span>
                  <SegmentedControl<string>
                    aria-label={t.learner.sessionMinutes}
                    value={String(sessionMinutes)}
                    onValueChange={(v) => setSessionMinutes(Number(v))}
                    options={SESSION_CHOICES.map((min, idx) => ({
                      value: String(min),
                      label: copy.sessionOptions[idx],
                    }))}
                  />
                </div>
              </>
            ) : null}

            {currentTopic === "starting_point" ? (
              <ChoiceCardGroup
                label={t.learner.selfLevel}
                showKey={false}
                value={selfLevel}
                onChange={(v) => setSelfLevel(String(v) as CourseEnrollment["self_level"])}
                options={Object.entries(t.learner.selfLevels).map(([key, label]) => ({ key, text: label }))}
              />
            ) : null}

            {currentTopic === "hard_parts" ? (
              <>
                {materialsReady && units.length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {units.map((unit) => (
                      <Chip
                        key={unit.id}
                        selected={hardUnits.includes(unit.id)}
                        onClick={() =>
                          setHardUnits((prev) =>
                            prev.includes(unit.id)
                              ? prev.filter((id) => id !== unit.id)
                              : [...prev, unit.id],
                          )
                        }
                      >
                        {unit.title}
                      </Chip>
                    ))}
                  </div>
                ) : (
                  <p className="text-ui text-fg-secondary">{copy.hardUnitsPending}</p>
                )}
                <Field label={t.learner.teacherHints}>
                  <Textarea
                    name="teacher_hints"
                    rows={2}
                    value={teacherHints}
                    onChange={(e) => setTeacherHints(e.target.value)}
                    maxLength={2000}
                  />
                </Field>
              </>
            ) : null}

            {currentTopic === "teaching" ? (
              <div className="grid gap-4">
                <div className="grid gap-1.5">
                  <span className="text-ui font-medium text-fg-primary">{t.learner.style}</span>
                  <ChoiceCardGroup
                    label={t.learner.style}
                    showKey={false}
                    value={styleId}
                    onChange={(v) => setStyleId(String(v) as LearnerProfile["preferred_style_id"])}
                    options={Object.entries(t.learner.styles).map(([key, label]) => ({ key, text: label }))}
                  />
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="grid gap-1.5">
                    <span className="text-ui font-medium text-fg-primary">{t.learner.pace}</span>
                    <SegmentedControl<string>
                      aria-label={t.learner.pace}
                      value={pace}
                      onValueChange={(v) => setPace(v as LearnerProfile["pace"])}
                      options={Object.entries(t.learner.paces).map(([value, label]) => ({ value, label }))}
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <span className="text-ui font-medium text-fg-primary">{t.learner.encouragement}</span>
                    <SegmentedControl<string>
                      aria-label={t.learner.encouragement}
                      value={encouragement}
                      onValueChange={(v) => setEncouragement(v as LearnerProfile["encouragement"])}
                      options={Object.entries(t.learner.encouragements).map(([value, label]) => ({ value, label }))}
                    />
                  </div>
                </div>
              </div>
            ) : null}

            {/* Optional free-text box */}
            <Field label={copy.freeInputLabel}>
              <TextInput
                name="free_text"
                value={freeText}
                onChange={(e) => setFreeText(e.target.value)}
                placeholder={copy.freeInputPlaceholder}
              />
            </Field>

            {fallbackNotice ? (
              <p role="status" className="text-ui text-warn-text">{copy.fallbackGentle}</p>
            ) : null}
            {submitTopic.isError ? <Problem error={submitTopic.error} /> : null}

            <div className="flex justify-end pt-1">
              <Button type="submit" variant="primary" size="lg" pending={submitTopic.isPending}>
                {t.onboarding.continue}
              </Button>
            </div>
          </form>
        )}
      </Card>
    </div>
  );
}

function SetupPlacementStep({
  courseId,
  materialsReady,
  job,
  placementQuery,
  units,
  buildingPlan,
  buildError,
  onBuildPlan,
  onBackToReading,
}: {
  courseId: string;
  materialsReady: boolean;
  job: Job | null;
  placementQuery: ReturnType<typeof useQuery<Awaited<ReturnType<typeof getPlacement>>>>;
  units: Array<{ id: string; title: string }>;
  buildingPlan: boolean;
  buildError: unknown;
  onBuildPlan: () => void;
  onBackToReading: () => void;
}) {
  const queries = useQueryClient();
  const [answer, setAnswer] = useState<string | string[]>("");

  const submitAnswer = useMutation({
    mutationFn: (dontKnow: boolean) =>
      answerPlacement(courseId, {
        item_id: placementQuery.data!.question!.item_id,
        answer: dontKnow ? undefined : answer,
        dont_know: dontKnow,
      }),
    onSuccess: (next) => {
      setAnswer("");
      queries.setQueryData(learnerKeys.placement(courseId), next);
      void queries.invalidateQueries({ queryKey: courseKeys.journey(courseId) });
      if (next.question) toast.info(copy.step4Received);
    },
  });

  const finish = useMutation({
    mutationFn: () => finishPlacement(courseId),
    onSuccess: (next) => {
      queries.setQueryData(learnerKeys.placement(courseId), next);
      void queries.invalidateQueries({ queryKey: courseKeys.journey(courseId) });
    },
  });

  if (!materialsReady) {
    return (
      <Card padding="lg" className="grid gap-4" data-testid="placement-locked">
        <h1 className="text-headline font-semibold text-fg-primary">{copy.step4Locked}</h1>
        <p className="text-body text-fg-secondary">{copy.step4LockedHint}</p>
        {job && (job.status === "queued" || job.status === "running") ? (
          <p className="text-ui text-accent-strong">
            {copy.progressPlain.replace("{stage}", copy.coarseStages[coarseStageIndex(job.stage)] ?? copy.coarseStages[0])}
          </p>
        ) : null}
        <div>
          <Button variant="primary" onClick={onBackToReading}>
            {t.courseHub.stageCtas.analyzing}
          </Button>
        </div>
      </Card>
    );
  }

  if (placementQuery.isPending) return <Loading />;
  if (placementQuery.isError) {
    return <Problem error={placementQuery.error} onRetry={() => void placementQuery.refetch()} />;
  }

  const data = placementQuery.data;
  if (!data) return null;

  if (data.status === "unavailable") {
    return (
      <Card padding="lg" className="grid gap-4" data-testid="placement-unavailable">
        <h1 className="text-headline font-semibold text-fg-primary">{copy.step4Title}</h1>
        <p className="text-body text-fg-secondary">
          {data.unavailable_reason === "materials_not_ready"
            ? t.learner.placementWaitMaterials
            : t.learner.placementNoQuestions}
        </p>
        {buildError ? <Problem error={buildError} /> : null}
        <div>
          {data.unavailable_reason === "materials_not_ready" ? (
            <Button variant="primary" onClick={onBackToReading}>
              {t.courseHub.stageCtas.analyzing}
            </Button>
          ) : (
            <Button variant="primary" size="lg" pending={buildingPlan} onClick={onBuildPlan}>
              {copy.step4BuildPlan}
            </Button>
          )}
        </div>
      </Card>
    );
  }

  const q = data.question;
  if (q) {
    const opts = Array.isArray(q.options)
      ? q.options
      : Object.entries(q.options).map(([key, text]) => ({ key, text }));

    return (
      <Card padding="lg" className="grid gap-5" data-testid="placement-question">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-title font-semibold text-fg-primary">{copy.step4Title}</h1>
          <Badge tone="neutral">{copy.step4Answered.replace("{count}", String(q.answered))}</Badge>
        </div>

        <div className="text-body text-fg-primary">
          <LessonText source={q.stem} />
        </div>

        {q.type === "numeric" ? (
          <TextInput
            aria-label={t.learner.answer}
            type="number"
            step="any"
            value={typeof answer === "string" ? answer : ""}
            onChange={(e) => setAnswer(e.target.value)}
          />
        ) : (
          <ChoiceCardGroup
            mode={q.type === "multi" ? "multi" : "single"}
            value={answer}
            onChange={setAnswer}
            options={opts}
            aria-label={copy.step4Title}
          />
        )}

        {submitAnswer.isError ? <Problem error={submitAnswer.error} /> : null}
        {finish.isError ? <Problem error={finish.error} /> : null}

        <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              pending={submitAnswer.isPending}
              onClick={() => submitAnswer.mutate(true)}
            >
              {t.learner.dontKnow}
            </Button>
            <Button variant="ghost" pending={finish.isPending} onClick={() => finish.mutate()}>
              {t.learner.enough}
            </Button>
          </div>
          <Button
            variant="primary"
            size="lg"
            pending={submitAnswer.isPending}
            disabled={Array.isArray(answer) ? answer.length === 0 : !answer.trim()}
            onClick={() => submitAnswer.mutate(false)}
          >
            {t.learner.submitAnswer}
          </Button>
        </div>
      </Card>
    );
  }

  // Done: Starting mastery grid
  const unitNameById = new Map(units.map((u) => [u.id, u.title]));
  const grouped = new Map<string, typeof data.mastery>();
  for (const pt of data.mastery) {
    const key = pt.unit_id ? (unitNameById.get(pt.unit_id) ?? t.courses.map) : t.courses.map;
    const list = grouped.get(key) ?? [];
    list.push(pt);
    grouped.set(key, list);
  }

  return (
    <Card padding="lg" className="grid gap-5" data-testid="placement-done">
      <div className="grid gap-1.5">
        <h1 className="text-headline font-semibold text-fg-primary">{copy.step4DoneTitle}</h1>
        {data.summary ? (
          <p className="text-body text-fg-secondary">
            {t.learner.placementSummary
              .replace("{strongest}", data.summary.strongest_name)
              .replace("{priority}", data.summary.priority_name)
              .replace("{inferred}", String(data.summary.inferred_count))}
          </p>
        ) : null}
      </div>

      {data.mastery.length > 0 ? (
        <div className="grid gap-4">
          {Array.from(grouped.entries()).map(([unitTitle, points]) => (
            <section key={unitTitle} className="grid gap-2">
              <h2 className="text-ui font-semibold text-fg-secondary">{unitTitle}</h2>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {points.map((pt) => {
                  const lvl = masteryLevel(pt.probability);
                  return (
                    <div
                      key={pt.kp_id}
                      className={clsx(
                        "grid gap-1 rounded-md border px-3 py-2.5",
                        pt.inferred ? "border-dashed border-line-control" : "border-line-subtle",
                        lvl === "mastered"
                          ? "bg-ok-soft/60"
                          : lvl === "shaky"
                            ? "bg-warn-soft/60"
                            : "bg-surface-page",
                      )}
                    >
                      <strong className="truncate text-ui font-medium text-fg-primary">{pt.name}</strong>
                      <span className="text-caption text-fg-secondary">
                        {masteryLabel(pt.probability)} · {Math.round(pt.probability * 100)}%
                        {pt.inferred ? ` · ${t.learner.inferred}` : ""}
                      </span>
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      ) : null}

      {buildError ? <Problem error={buildError} /> : null}

      <div className="flex justify-end pt-2">
        <Button variant="primary" size="lg" pending={buildingPlan} onClick={onBuildPlan}>
          {copy.step4BuildPlan}
        </Button>
      </div>
    </Card>
  );
}

function SetupPlanStep({
  courseId,
  teacher,
  plan,
  enrollment,
  building,
  buildError,
  onBuild,
}: {
  courseId: string;
  teacher: { id: string; name: string; appearance: { src: string } } | null;
  plan: Awaited<ReturnType<typeof getPlan>> | undefined;
  enrollment: CourseEnrollment | undefined;
  building: boolean;
  buildError: unknown;
  onBuild: () => void;
}) {
  const [showDeferred, setShowDeferred] = useState(false);
  const [expandedWhy, setExpandedWhy] = useState<Record<string, boolean>>({});
  const [mountNow] = useState(() => Date.now());

  if (!plan || !plan.items.length) {
    return (
      <Card padding="lg" className="grid gap-4">
        <h1 className="text-headline font-semibold text-fg-primary">{t.learner.buildPlan}</h1>
        {buildError ? <Problem error={buildError} /> : null}
        <div>
          <Button variant="primary" size="lg" pending={building} onClick={onBuild}>
            {t.learner.buildPlan}
          </Button>
        </div>
      </Card>
    );
  }

  const examDateStr = enrollment?.exam_date || plan.params?.exam_date || null;
  const remainingDays = examDateStr
    ? Math.max(0, Math.ceil((Date.parse(`${examDateStr}T00:00:00`) - mountNow) / 86_400_000))
    : null;
  const daysPerWeek = enrollment?.weekly_days?.length ?? 5;
  const minutes = enrollment?.session_minutes ?? 30;

  const summaryLine =
    remainingDays !== null
      ? copy.step5SummaryExam
          .replace("{days}", String(remainingDays))
          .replace("{daysPerWeek}", String(daysPerWeek))
          .replace("{min}", String(minutes))
          .replace("{count}", String(plan.items.length))
      : copy.step5SummaryNoExam
          .replace("{daysPerWeek}", String(daysPerWeek))
          .replace("{min}", String(minutes));

  const deferredList =
    plan.deferred_items?.length
      ? plan.deferred_items
      : plan.deferred.map((id) => ({ kp_id: id, kp_name: id }));
  const firstLesson = plan.items.find((item) => isLessonItem(item.kind)) ?? plan.items[0];
  const firstHref = firstLesson && isLessonItem(firstLesson.kind)
    ? `/plan-items/${firstLesson.id}/lesson`
    : `/courses/${courseId}/plan`;

  return (
    <div className="grid gap-5" data-testid="setup-plan-step">
      <Card padding="lg" className="grid gap-4 shadow-2">
        <div className="flex flex-wrap items-center gap-4">
          {teacher ? <TutorAvatar src={teacher.appearance.src} name={teacher.name} size="lg" /> : null}
          <div className="grid gap-1">
            <h1 className="text-headline font-semibold text-fg-primary">{copy.step5Title}</h1>
            <p className="text-body text-fg-secondary">{summaryLine}</p>
            {!examDateStr ? (
              <div>
                <Link className="text-ui font-medium text-accent-strong hover:underline" to={`/courses/${courseId}?settings=1`}>
                  {t.today.addExamDate}
                </Link>
              </div>
            ) : null}
          </div>
        </div>

        {deferredList.length > 0 ? (
          <div className="grid gap-2 rounded-md bg-surface-sunken/70 p-3.5 text-ui">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-fg-secondary">
                {typeof plan.deferred_weight === "number"
                  ? copy.step5Deferred
                      .replace("{count}", String(deferredList.length))
                      .replace("{weight}", String(Math.round(plan.deferred_weight * 100)))
                  : copy.step5DeferredNoWeight.replace("{count}", String(deferredList.length))}
              </span>
              <Button variant="ghost" size="sm" onClick={() => setShowDeferred((v) => !v)}>
                {copy.step5SeeDeferred}
              </Button>
            </div>
            {showDeferred ? (
              <ul className="flex flex-wrap gap-1.5 pt-1">
                {deferredList.map((entry) => (
                  <li key={entry.kp_id} className="rounded-sm bg-surface-card px-2.5 py-1 text-caption text-fg-primary">
                    {entry.kp_name}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </Card>

      <Card padding="lg" className="grid gap-3">
        <ol className="grid gap-2.5">
          {plan.items.slice(0, 8).map((item) => {
            const open = Boolean(expandedWhy[item.id]);
            return (
              <li key={item.id} className="rounded-md border border-line-subtle bg-surface-page p-3.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="grid gap-0.5">
                    <strong className="text-ui font-semibold text-fg-primary">
                      {planItemDisplayTitle(item)}
                    </strong>
                    <span className="text-caption text-fg-tertiary">
                      {item.scheduled_date ? `${item.scheduled_date} · ` : ""}
                      {planItemKindLabel(item.kind)} · {item.est_minutes} {t.learner.minutes}
                    </span>
                  </div>
                  {item.why.length > 0 ? (
                    <button
                      type="button"
                      aria-expanded={open}
                      onClick={() => setExpandedWhy((prev) => ({ ...prev, [item.id]: !prev[item.id] }))}
                      className="inline-flex min-h-8 items-center gap-1 text-caption font-medium text-fg-secondary hover:text-accent-strong"
                    >
                      {open ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
                      <span>{t.planView.whyToggle}</span>
                    </button>
                  ) : null}
                </div>
                {open ? <PlanItemWhyPanel why={item.why} /> : null}
              </li>
            );
          })}
        </ol>

        <div className="flex flex-wrap items-center justify-end gap-3 pt-3">
          <Link className="button quiet" to={`/courses/${courseId}`}>
            {copy.step5Later}
          </Link>
          <Link className="button primary" to={firstHref}>
            <Play size={15} aria-hidden="true" />
            <span>{copy.step5StartFirst}</span>
            <ArrowRight size={15} aria-hidden="true" />
          </Link>
        </div>
      </Card>
    </div>
  );
}
