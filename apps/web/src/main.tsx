import { lazy, StrictMode, Suspense, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { BrowserRouter, Link, matchPath, Navigate, Route, Routes, useLocation } from "react-router";
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

function navActive(to: string, pathname: string): boolean {
  if (to === "/courses") {
    return pathname === "/courses"
      || pathname.startsWith("/courses/")
      || pathname.startsWith("/lessons/")
      || pathname.startsWith("/plan-items/");
  }
  if (to === "/welcome") {
    return pathname === "/welcome"
      || pathname.startsWith("/characters")
      || pathname.startsWith("/sample-lesson");
  }
  if (to === "/settings") return pathname === "/settings";
  if (to === "/settings/diagnostics") return pathname.startsWith("/settings/diagnostics");
  return pathname === to;
}

function pageTitleFor(pathname: string, search: string): string {
  const titles = t.app.titles;
  if (matchPath("/", pathname)) return titles.courses;
  if (matchPath("/welcome", pathname)) return titles.welcome;
  if (matchPath("/sample-lesson", pathname)) return titles.sample;
  if (matchPath("/characters", pathname)) return titles.characters;
  if (matchPath("/courses", pathname)) return titles.courses;
  if (matchPath("/courses/:courseId/history", pathname)) return titles.courseHistory;
  if (matchPath("/courses/:courseId/review", pathname)) {
    return new URLSearchParams(search).has("plan") ? titles.warmup : titles.review;
  }
  if (matchPath("/courses/:courseId/progress", pathname)) return titles.progress;
  if (matchPath("/courses/:courseId", pathname)) return titles.course;
  if (matchPath("/plan-items/:itemId/practice", pathname)) return titles.practice;
  if (matchPath("/lessons/:lessonId/history", pathname)) return titles.lessonHistory;
  if (matchPath("/lessons/:lessonId", pathname)) return titles.lesson;
  if (matchPath("/settings/diagnostics", pathname)) return titles.diagnostics;
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
  return (
    <section className="error-screen">
      <h1>{t.app.notFoundTitle}</h1>
      <p className="hint">{t.app.notFoundHint}</p>
      <Link className="button primary" to="/courses">{t.app.backCourses}</Link>
    </section>
  );
}

function RouteFallback() {
  return (
    <section className="error-screen">
      <h1>{t.app.routeErrorTitle}</h1>
      <p role="alert">{t.app.error}</p>
      <div className="actions">
        <button className="button primary" onClick={() => window.location.reload()}>{t.app.refresh}</button>
        <Link className="button quiet" to="/courses">{t.app.backCourses}</Link>
      </div>
    </section>
  );
}

function Home() {
  const courses = useQuery({ queryKey: ["courses"], queryFn: async () => bodyOf(await api.GET("/api/v2/courses")) });
  if (courses.isPending) return <Loading />;
  if (courses.isError) return <Problem error={courses.error} onRetry={() => void courses.refetch()} />;
  return <Navigate to={courses.data.length ? "/courses" : "/welcome"} replace />;
}

function App() {
  const location = useLocation();
  const session = useQuery({ queryKey: sessionKey, queryFn: bootstrapSession, staleTime: Infinity });

  return (
    <>
      <RouteEffects />
      <a className="skip" href="#main">{t.app.skip}</a>
      <header className="site-header">
        <div className="shell header-row">
          <Link to="/welcome" className="brand">
            <span className="brand-mark" aria-hidden="true">✦</span>
            <span><strong>{t.app.name}</strong><small>Companion Space</small></span>
          </Link>
          <nav className="site-nav" aria-label={t.app.name}>
            {navigation.map(([to, label]) => (
              <Link key={to} to={to} aria-current={navActive(to, location.pathname) ? "page" : undefined}>{label}</Link>
            ))}
          </nav>
          <span className="local-badge"><span aria-hidden="true" />{t.app.local}</span>
        </div>
      </header>
      <main id="main" className="shell">
        {session.isPending ? <Loading text={t.app.loading} /> : null}
        {session.isError ? <Problem error={session.error} onRetry={() => void session.refetch()} /> : null}
        {session.data?.state !== undefined && session.data.state !== "ready" ? <UnlockSession session={session.data} /> : null}
        {session.data?.state === "ready" ? (
          <ErrorBoundary key={location.pathname} fallback={<RouteFallback />}>
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
                <Route path="*" element={<NotFound />} />
              </Routes>
            </Suspense>
          </ErrorBoundary>
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
