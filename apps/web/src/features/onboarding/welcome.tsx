import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router";
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
import { FocusShell } from "../../shell/FocusShell";
import {
  ArrowLeft,
  Button,
  Card,
  Field,
  Play,
  Stepper,
  TextInput,
  Textarea,
  toast,
} from "../../ui";
import { TeacherPreview } from "../characters/teacher-preview";
import { courseKeys, createCourse } from "../courses/api";
import { getLearnerProfile, learnerKeys, saveLearnerProfile } from "../learner/api";
import { fetchSample, sampleKey } from "../replay/sample-api";
import { ConnectWizard } from "../settings/connect-wizard";
import { TutorRoster, TutorShowcase } from "../tutors/tutor-showcase";
import { tutorGreeting } from "../tutors/use-active-tutor";
import { useTutorSpeech } from "../voice/use-tutor-speech";
import t from "../../locales/zh-CN.json";

const copy = t.onboarding;
type OnboardingStep = 1 | 2 | 3 | 4;

export default function Welcome() {
  const navigate = useNavigate();
  const queries = useQueryClient();
  const roster = useQuery({ queryKey: charactersKey, queryFn: fetchCharacters });
  const settings = useQuery({ queryKey: settingsKey, queryFn: fetchSettings });
  const profile = useQuery({ queryKey: learnerKeys.profile, queryFn: getLearnerProfile });
  const sample = useQuery({ queryKey: sampleKey, queryFn: fetchSample, staleTime: Infinity });
  const speech = useTutorSpeech();

  const [step, setStep] = useState<OnboardingStep>(1);
  const [focused, setFocused] = useState<string>();
  const [introSeq, setIntroSeq] = useState(0);
  const [tutorConfirmed, setTutorConfirmed] = useState(false);
  const [nickname, setNickname] = useState<string | null>(null);
  const [greetedName, setGreetedName] = useState("");
  const [courseName, setCourseName] = useState("");
  const [courseGoal, setCourseGoal] = useState("");

  const completeOnboarding = useMutation({
    mutationFn: async () =>
      bodyOf(await api.PUT("/api/v2/settings", { body: { onboarding_completed: true } })),
    onSuccess: (updated) => {
      queries.setQueryData(settingsKey, updated);
    },
  });

  const saveTutor = useMutation({
    mutationFn: async (character_id: string) =>
      bodyOf(await api.PUT("/api/v2/settings/default-character", { body: { character_id } })),
    onSuccess: () => {
      void queries.invalidateQueries({ queryKey: settingsKey });
      setTutorConfirmed(true);
      toast.success(t.common.saved);
    },
  });

  const saveNickname = useMutation({
    mutationFn: async (nextNickname: string) => {
      const current = profile.data ?? {
        nickname: "",
        level: "self_study" as const,
        pace: "normal" as const,
        encouragement: "normal" as const,
        preferred_style_id: "guided" as const,
        interests: [],
        approach_order: ["example", "intuition", "visual", "formal", "analogy", "contrast"] as const,
      };
      return saveLearnerProfile({
        ...current,
        approach_order: [...(current.approach_order ?? ["example", "intuition", "visual", "formal", "analogy", "contrast"])],
        nickname: nextNickname.trim(),
      });
    },
    onSuccess: (saved) => {
      queries.setQueryData(learnerKeys.profile, saved);
      if (saved.nickname) {
        setGreetedName(saved.nickname);
        const greetText = copy.greetAfterNickname.replace("{name}", saved.nickname);
        if (candidate) {
          void speech.speak({ characterId: candidate.id, text: greetText });
        }
      }
      setStep(3);
    },
  });

  const createFirstCourse = useMutation({
    mutationFn: async () => {
      const created = await createCourse({
        name: courseName.trim(),
        goal: courseGoal.trim() || undefined,
      });
      await completeOnboarding.mutateAsync();
      return created;
    },
    onSuccess: (created) => {
      void queries.invalidateQueries({ queryKey: courseKeys.all });
      navigate(`/courses/${created.id}/setup`);
    },
  });

  const characters = roster.data ?? [];
  const selectedId = settings.data?.default_character_id;
  const candidate =
    characters.find((entry) => entry.id === (focused ?? selectedId)) ?? characters[0] ?? null;

  const progressSteps = copy.steps.map((label, idx) => {
    const n = (idx + 1) as OnboardingStep;
    return {
      id: String(n),
      label,
      status: n < step ? ("done" as const) : n === step ? ("active" as const) : ("todo" as const),
    };
  });

  async function handleExit() {
    await completeOnboarding.mutateAsync().catch(() => {});
    navigate("/");
  }

  function handleSelectTutor(entry: Character) {
    saveTutor.reset();
    setFocused(entry.id);
    setTutorConfirmed(false);
    setIntroSeq((seq) => seq + 1);
  }

  function submitNickname(event: FormEvent) {
    event.preventDefault();
    const val = (nickname ?? profile.data?.nickname ?? "").trim();
    if (!val) {
      setStep(3);
      return;
    }
    saveNickname.mutate(val);
  }

  function submitCourse(event: FormEvent) {
    event.preventDefault();
    if (!courseName.trim()) return;
    createFirstCourse.mutate();
  }

  return (
    <FocusShell
      flowName={copy.flowName}
      onExit={() => void handleExit()}
      exitLabel={t.app.exit}
      progress={
        <Stepper
          steps={progressSteps}
          currentId={String(step)}
          compact
          onSelect={(id) => {
            const target = Number(id) as OnboardingStep;
            if (target < step) setStep(target);
          }}
        />
      }
    >
      {roster.isPending || settings.isPending ? <Loading /> : null}
      {roster.isError ? <Problem error={roster.error} onRetry={() => void roster.refetch()} /> : null}
      {settings.isError ? <Problem error={settings.error} onRetry={() => void settings.refetch()} /> : null}

      {!roster.isPending && !settings.isPending && !roster.isError && !settings.isError ? (
        <div className="grid gap-6" data-testid="onboarding-flow" data-step={step}>
          {/* Step 1: Pick Tutor */}
          {step === 1 && candidate ? (
            tutorConfirmed ? (
              <Card padding="lg" className="grid gap-6 text-center sm:text-left">
                <div className="grid items-center gap-6 sm:grid-cols-[200px_1fr]">
                  <div className="mx-auto w-44 sm:w-full" data-testid="teacher-stage">
                    <TeacherPreview key={candidate.id} character={candidate} />
                  </div>
                  <div className="grid gap-3">
                    <h1 className="text-headline font-semibold text-fg-primary">
                      {copy.greetTitle.replace("{name}", candidate.name)}
                    </h1>
                    <p className="text-body text-fg-secondary">
                      {tutorGreeting(candidate) || copy.greetHint}
                    </p>
                    <div className="flex flex-wrap items-center justify-center gap-3 pt-2 sm:justify-start">
                      <Button variant="primary" size="lg" onClick={() => setStep(2)}>
                        {copy.startFirstCourse}
                      </Button>
                      {sample.data ? (
                        <Link className="button quiet" to="/sample-lesson">
                          <Play size={15} aria-hidden="true" />
                          <span>{copy.trySampleNoConfig}</span>
                        </Link>
                      ) : null}
                    </div>
                  </div>
                </div>
              </Card>
            ) : (
              <div className="grid gap-6">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h1 className="text-headline font-semibold text-fg-primary">{t.welcome.heading}</h1>
                  {sample.data ? (
                    <Link className="button quiet" to="/sample-lesson">
                      <Play size={15} aria-hidden="true" />
                      <span>{copy.trySampleNoConfig}</span>
                    </Link>
                  ) : null}
                </div>

                <TutorShowcase
                  character={candidate}
                  isCurrent={false}
                  choosing={saveTutor.isPending}
                  headingLevel="h2"
                  showEditLink={false}
                  introSeq={introSeq}
                  onChoose={(entry) => saveTutor.mutate(entry.id)}
                />
                {saveTutor.isError ? <Problem error={saveTutor.error} /> : null}

                <TutorRoster
                  characters={characters}
                  selectedId={candidate.id}
                  currentId={selectedId}
                  onSelect={handleSelectTutor}
                  showImportTile={false}
                />
              </div>
            )
          ) : null}

          {/* Step 2: Nickname */}
          {step === 2 ? (
            <Card padding="lg" className="grid gap-5">
              <div>
                <Button
                  variant="ghost"
                  size="sm"
                  leftIcon={<ArrowLeft size={15} aria-hidden="true" />}
                  onClick={() => setStep(1)}
                >
                  {copy.back}
                </Button>
              </div>
              <div className="grid gap-1.5">
                <h1 className="text-headline font-semibold text-fg-primary">{copy.nicknameTitle}</h1>
                <p className="text-body text-fg-secondary">{copy.nicknameHint}</p>
              </div>
              <form className="grid gap-4 max-w-md" onSubmit={submitNickname}>
                <Field label={t.learner.nickname}>
                  <TextInput
                    name="nickname"
                    value={nickname ?? profile.data?.nickname ?? ""}
                    onChange={(event) => setNickname(event.target.value)}
                    placeholder={copy.nicknamePlaceholder}
                    maxLength={80}
                    autoFocus
                  />
                </Field>
                {saveNickname.isError ? <Problem error={saveNickname.error} /> : null}
                <div className="flex flex-wrap items-center gap-3">
                  <Button type="submit" variant="primary" pending={saveNickname.isPending}>
                    {copy.continue}
                  </Button>
                  <Button variant="ghost" onClick={() => setStep(3)}>
                    {copy.skip}
                  </Button>
                </div>
              </form>
            </Card>
          ) : null}

          {/* Step 3: Connect AI Service */}
          {step === 3 ? (
            <div className="grid gap-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  leftIcon={<ArrowLeft size={15} aria-hidden="true" />}
                  onClick={() => setStep(2)}
                >
                  {copy.back}
                </Button>
                {greetedName ? (
                  <p role="status" className="text-ui text-accent-strong font-medium">
                    {copy.greetAfterNickname.replace("{name}", greetedName)}
                  </p>
                ) : null}
              </div>
              <div className="grid gap-1">
                <h1 className="text-headline font-semibold text-fg-primary">{t.connectWizard.title}</h1>
                <p className="text-ui text-fg-secondary">
                  {copy.connectLaterNote} {copy.connectLaterBlocked}
                </p>
              </div>
              <ConnectWizard
                onComplete={() => setStep(4)}
                onSkip={() => {
                  void completeOnboarding.mutateAsync().catch(() => {});
                  setStep(4);
                }}
                skipLabel={copy.connectLater}
                doneLabel={copy.continue}
              />
            </div>
          ) : null}

          {/* Step 4: First Course */}
          {step === 4 ? (
            <Card padding="lg" className="grid gap-5">
              <div>
                <Button
                  variant="ghost"
                  size="sm"
                  leftIcon={<ArrowLeft size={15} aria-hidden="true" />}
                  onClick={() => setStep(3)}
                >
                  {copy.back}
                </Button>
              </div>
              <div className="grid gap-1.5">
                <h1 className="text-headline font-semibold text-fg-primary">{copy.firstCourseTitle}</h1>
                <p className="text-body text-fg-secondary">{copy.firstCourseHint}</p>
              </div>
              <form className="grid gap-4 max-w-lg" onSubmit={submitCourse}>
                <Field label={t.courses.name} required>
                  <TextInput
                    name="name"
                    value={courseName}
                    onChange={(event) => setCourseName(event.target.value)}
                    placeholder={copy.courseNamePlaceholder}
                    maxLength={120}
                    required
                    autoFocus
                  />
                </Field>
                <Field label={t.courses.goal}>
                  <Textarea
                    name="goal"
                    rows={2}
                    value={courseGoal}
                    onChange={(event) => setCourseGoal(event.target.value)}
                    placeholder={copy.courseGoalPlaceholder}
                    maxLength={500}
                  />
                </Field>
                {createFirstCourse.isError ? <Problem error={createFirstCourse.error} /> : null}
                <div className="flex flex-wrap items-center gap-3">
                  <Button
                    type="submit"
                    variant="primary"
                    size="lg"
                    pending={createFirstCourse.isPending}
                    disabled={!courseName.trim()}
                  >
                    {copy.createAndPrepare}
                  </Button>
                </div>
              </form>
            </Card>
          ) : null}
        </div>
      ) : null}
    </FocusShell>
  );
}
