import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { BrowserRouter, Link, NavLink, Navigate, Route, Routes } from "react-router";
import { api, bodyOf, bootstrapSession, isClientError, sessionKey } from "./app/api";
import { ErrorBoundary, Loading, Problem } from "./app/ui";
import { UnlockSession } from "./features/settings/security";
import Welcome from "./features/onboarding/welcome";
import t from "./locales/zh-CN.json";
import "./styles/tokens.css";

const Settings = lazy(() => import("./features/settings/settings"));
const Diagnostics = lazy(() => import("./features/settings/diagnostics"));
const Courses = lazy(() => import("./features/courses/courses"));
const CourseWorkspace = lazy(() => import("./features/courses/course"));
const Classroom = lazy(() => import("./features/classroom/classroom"));
const Review = lazy(() => import("./features/review/review"));
const Practice = lazy(() => import("./features/practice/practice"));
const ProgressPage = lazy(() => import("./features/progress/progress"));
const TutorLibrary = lazy(() => import("./features/characters/library"));
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
const navigation = [
  ["/courses", t.app.courses],
  ["/welcome", t.app.teachers],
  ["/settings", t.app.settings],
  ["/settings/diagnostics", t.app.diagnostics],
] as const;

function Home() {
  const courses = useQuery({ queryKey: ["courses"], queryFn: async () => bodyOf(await api.GET("/api/v2/courses")) });
  if (courses.isPending) return <Loading />;
  if (courses.isError) return <Problem error={courses.error} onRetry={() => void courses.refetch()} />;
  return <Navigate to={courses.data.length ? "/courses" : "/welcome"} replace />;
}

function App() {
  const session = useQuery({ queryKey: sessionKey, queryFn: bootstrapSession, staleTime: Infinity });

  return (
    <>
      <a className="skip" href="#main">{t.app.skip}</a>
      <header className="site-header">
        <div className="shell header-row">
          <Link to="/welcome" className="brand">
            <span className="brand-mark" aria-hidden="true">✦</span>
            <span><strong>{t.app.name}</strong><small>Companion Space</small></span>
          </Link>
          <nav className="site-nav" aria-label={t.app.name}>
            {navigation.map(([to, label]) => <NavLink key={to} to={to} end>{label}</NavLink>)}
          </nav>
          <span className="local-badge"><span aria-hidden="true" />{t.app.local}</span>
        </div>
      </header>
      <main id="main" className="shell">
        {session.isPending ? <Loading text={t.app.loading} /> : null}
        {session.isError ? <Problem error={session.error} onRetry={() => void session.refetch()} /> : null}
        {session.data?.state !== undefined && session.data.state !== "ready" ? <UnlockSession session={session.data} /> : null}
        {session.data?.state === "ready" ? (
          <Suspense fallback={<Loading />}>
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/welcome" element={<Welcome />} />
              <Route path="/sample-lesson" element={<SampleLesson />} />
              <Route path="/characters" element={<TutorLibrary />} />
              <Route path="/courses" element={<Courses />} />
              <Route path="/courses/:courseId" element={<CourseWorkspace />} />
              <Route path="/courses/:courseId/history" element={<CourseHistory />} />
              <Route path="/courses/:courseId/review" element={<Review />} />
              <Route path="/courses/:courseId/progress" element={<ProgressPage />} />
              <Route path="/plan-items/:itemId/practice" element={<Practice />} />
              <Route path="/lessons/:lessonId" element={<Classroom />} />
              <Route path="/lessons/:lessonId/history" element={<LessonHistory />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="/settings/diagnostics" element={<Diagnostics />} />
              <Route path="*" element={<Navigate to="/courses" replace />} />
            </Routes>
          </Suspense>
        ) : null}
      </main>
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
