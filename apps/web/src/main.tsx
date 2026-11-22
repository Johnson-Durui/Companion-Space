import "./styles/theme.css";
import "./styles/base.css";
import { lazy, StrictMode, Suspense, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { BrowserRouter, Link, matchPath, Navigate, Route, Routes, useLocation } from "react-router";
import { bootstrapSession, isClientError, sessionKey } from "./app/api";
import { ErrorBoundary, Loading, Problem } from "./app/ui";
import { AppShell } from "./shell/AppShell";
import { UnlockSession } from "./features/settings/security";
import { useActiveTutor } from "./features/tutors/use-active-tutor";
import Welcome from "./features/onboarding/welcome";
import TodayPage from "./features/today/today";
import t from "./locales/zh-CN.json";
import { scheduleFontPrefetch } from "./styles/prefetch-fonts";
import { useTutorThemeSync } from "./styles/use-tutor-theme";
import { Button, TutorAvatar } from "./ui";

scheduleFontPrefetch();

const Settings = lazy(() => import("./features/settings/settings"));
const SettingsRedirect = lazy(() =>
  import("./features/settings/settings").then((m) => ({ default: m.SettingsRedirect })),
);
const Courses = lazy(() => import("./features/courses/courses"));
const CourseSetup = lazy(() => import("./features/courses/course-setup"));
const CourseHub = lazy(() => import("./features/courses/course-hub").then((m) => ({ default: m.CourseHubLayout })));
const CourseTodayTab = lazy(() => import("./features/courses/course-hub").then((m) => ({ default: m.CourseTodayTab })));
const CourseMapTab = lazy(() => import("./features/courses/course-hub").then((m) => ({ default: m.CourseMapTab })));
const CourseMaterialsTab = lazy(() => import("./features/courses/course-hub").then((m) => ({ default: m.CourseMaterialsTab })));
const PlanPage = lazy(() => import("./features/plan/plan-page"));
const Classroom = lazy(() => import("./features/classroom/classroom"));
const LessonLobby = lazy(() => import("./features/classroom/lobby"));
const Review = lazy(() => import("./features/review/review"));
const ReviewSession = lazy(() => import("./features/review/review-session"));
const Practice = lazy(() => import("./features/practice/practice"));
const ProgressPage = lazy(() => import("./features/progress/progress"));
const TutorsGallery = lazy(() => import("./features/tutors/tutors-gallery"));
const TutorDetail = lazy(() => import("./features/tutors/tutor-detail"));
const CourseHistory = lazy(() => import("./features/replay/history").then((module) => ({ default: module.CourseHistoryPage })));
const LessonHistory = lazy(() => import("./features/replay/history").then((module) => ({ default: module.LessonHistoryPage })));
const SampleLesson = lazy(() => import("./features/replay/sample"));

const queries = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => failureCount < 1 && !isClientError(error),
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
    mutations: { retry: false },
  },
});

function pageTitleFor(pathname: string, search: string): string {
  const titles = t.app.titles;
  if (matchPath("/", pathname)) return titles.today;
  if (matchPath("/welcome", pathname)) return titles.welcome;
  if (matchPath("/tutors/:tutorId", pathname)) return titles.tutorDetail;
  if (matchPath("/tutors", pathname)) return titles.tutors;
  if (matchPath("/sample-lesson", pathname)) return titles.sample;
  if (matchPath("/characters", pathname)) return titles.characters;
  if (matchPath("/courses", pathname)) return titles.courses;
  if (matchPath("/courses/:courseId/setup", pathname)) return titles.courseSetup;
  if (matchPath("/courses/:courseId/plan", pathname)) return titles.coursePlan;
  if (matchPath("/courses/:courseId/map", pathname)) return titles.courseMap;
  if (matchPath("/courses/:courseId/materials", pathname)) return titles.courseMaterials;
  if (matchPath("/courses/:courseId/history", pathname)) return titles.courseHistory;
  if (matchPath("/courses/:courseId/review/session", pathname)) return titles.reviewSession;
  if (matchPath("/courses/:courseId/review", pathname)) {
    return new URLSearchParams(search).has("plan") ? titles.warmup : titles.review;
  }
  if (matchPath("/courses/:courseId/progress", pathname)) return titles.progress;
  if (matchPath("/courses/:courseId", pathname)) return titles.course;
  if (matchPath("/plan-items/:itemId/practice", pathname)) return titles.practice;
  if (matchPath("/plan-items/:itemId/lesson", pathname)) return titles.lessonLobby;
  if (matchPath("/lessons/:lessonId/history", pathname)) return titles.lessonHistory;
  if (matchPath("/lessons/:lessonId", pathname)) return titles.lesson;
  if (matchPath("/settings/diagnostics", pathname)) return titles.diagnostics;
  if (matchPath("/settings/me", pathname)) return titles.settingsMe;
  if (matchPath("/settings/tutor", pathname)) return titles.settingsTutor;
  if (matchPath("/settings/ai", pathname)) return titles.settingsAi;
  if (matchPath("/settings/voice", pathname)) return titles.settingsVoice;
  if (matchPath("/settings/privacy", pathname)) return titles.settingsPrivacy;
  if (matchPath("/settings/advanced", pathname)) return titles.settingsAdvanced;
  if (matchPath("/settings", pathname)) return titles.settings;
  return titles.notFound;
}

function RouteEffects() {
  const location = useLocation();
  const initial = useRef(true);

  useEffect(() => {
    document.title = `${pageTitleFor(location.pathname, location.search)} · ${t.app.name}`;
  }, [location.pathname, location.search]);

  useEffect(() => {
    if (initial.current) {
      initial.current = false;
      return;
    }
    window.scrollTo(0, 0);
    const main = document.getElementById("main");
    if (!main) return;
    const focusHeading = () => {
      const heading = main.querySelector<HTMLElement>("h1");
      if (!heading) return false;
      if (!heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
      heading.focus({ preventScroll: true });
      return true;
    };
    if (focusHeading()) return;
    const observer = new MutationObserver(() => {
      if (focusHeading()) observer.disconnect();
    });
    observer.observe(main, { childList: true, subtree: true });
    const timeout = window.setTimeout(() => observer.disconnect(), 5000);
    return () => {
      window.clearTimeout(timeout);
      observer.disconnect();
    };
  }, [location.pathname]);

  return null;
}

function NotFound() {
  const { tutor } = useActiveTutor(true);
  return (
    <section className="mx-auto grid max-w-md justify-items-center gap-4 py-16 text-center">
      {tutor ? <TutorAvatar src={tutor.appearance.src} name={tutor.name} size="xl" /> : null}
      <h1 className="text-headline font-semibold text-fg-primary">{t.app.notFoundTitle}</h1>
      <p className="text-body text-fg-secondary">
        {tutor ? `${tutor.name}：${t.tutorsGallery.notFoundLine}` : t.app.notFoundHint}
      </p>
      <Link className="button primary" to="/">{t.app.backToday}</Link>
    </section>
  );
}

function RouteFallback() {
  return (
    <section className="mx-auto grid max-w-xl justify-items-start gap-3 py-12">
      <h1 className="text-headline font-semibold text-fg-primary">{t.app.routeErrorTitle}</h1>
      <p role="alert" className="text-ui text-fg-secondary">{t.app.error}</p>
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button variant="primary" onClick={() => window.location.reload()}>{t.app.refresh}</Button>
        <Link className="button quiet" to="/">{t.app.backToday}</Link>
      </div>
    </section>
  );
}

function App() {
  const location = useLocation();
  const session = useQuery({ queryKey: sessionKey, queryFn: bootstrapSession, staleTime: Infinity });
  const ready = session.data?.state === "ready";
  useTutorThemeSync(ready);

  const isStandaloneShell = Boolean(
    matchPath("/lessons/:lessonId", location.pathname) ||
    matchPath("/lessons/:lessonId/history", location.pathname) ||
    matchPath("/plan-items/:itemId/lesson", location.pathname) ||
    matchPath("/plan-items/:itemId/practice", location.pathname) ||
    matchPath("/courses/:courseId/review/session", location.pathname) ||
    matchPath("/sample-lesson", location.pathname) ||
    matchPath("/welcome", location.pathname) ||
    matchPath("/courses/:courseId/setup", location.pathname),
  );

  if (ready && isStandaloneShell) {
    return (
      <>
        <RouteEffects />
        <ErrorBoundary key={location.pathname} fallback={<RouteFallback />}>
          <Suspense fallback={<Loading />}>
            <Routes>
              <Route path="/welcome" element={<Welcome />} />
              <Route path="/courses/:courseId/setup" element={<CourseSetup />} />
              <Route path="/courses/:courseId/review/session" element={<ReviewSession />} />
              <Route path="/lessons/:lessonId" element={<Classroom />} />
              <Route path="/lessons/:lessonId/history" element={<LessonHistory />} />
              <Route path="/plan-items/:itemId/lesson" element={<LessonLobby />} />
              <Route path="/plan-items/:itemId/practice" element={<Practice />} />
              <Route path="/sample-lesson" element={<SampleLesson />} />
            </Routes>
          </Suspense>
        </ErrorBoundary>
      </>
    );
  }

  if (session.data?.state !== undefined && session.data.state !== "ready") {
    return (
      <>
        <RouteEffects />
        <UnlockSession session={session.data} />
      </>
    );
  }

  return (
    <>
      <RouteEffects />
      <AppShell sessionReady={ready}>
        {session.isPending ? <Loading text={t.app.loading} /> : null}
        {session.isError ? <Problem error={session.error} onRetry={() => void session.refetch()} /> : null}
        {ready ? (
          <ErrorBoundary key={location.pathname} fallback={<RouteFallback />}>
            <Suspense fallback={<Loading />}>
              <Routes>
                <Route path="/" element={<TodayPage />} />
                <Route path="/tutors" element={<TutorsGallery />} />
                <Route path="/tutors/:tutorId" element={<TutorDetail />} />
                <Route path="/characters" element={<Navigate to="/tutors" replace />} />
                <Route path="/courses" element={<Courses />} />
                <Route path="/courses/:courseId" element={<CourseHub><CourseTodayTab /></CourseHub>} />
                <Route path="/courses/:courseId/plan" element={<CourseHub><PlanPage /></CourseHub>} />
                <Route path="/courses/:courseId/map" element={<CourseHub><CourseMapTab /></CourseHub>} />
                <Route path="/courses/:courseId/materials" element={<CourseHub><CourseMaterialsTab /></CourseHub>} />
                <Route path="/courses/:courseId/history" element={<CourseHub><CourseHistory embedded /></CourseHub>} />
                <Route path="/courses/:courseId/review" element={<CourseHub><Review embedded /></CourseHub>} />
                <Route path="/courses/:courseId/progress" element={<CourseHub><ProgressPage embedded /></CourseHub>} />
                <Route path="/settings" element={<SettingsRedirect />} />
                <Route path="/settings/diagnostics" element={<Navigate to="/settings/ai?tab=test" replace />} />
                <Route path="/settings/:section" element={<Settings />} />
                <Route path="*" element={<NotFound />} />
              </Routes>
            </Suspense>
          </ErrorBoundary>
        ) : null}
      </AppShell>
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queries}>
        <BrowserRouter><App /></BrowserRouter>
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);
