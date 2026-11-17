import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { BrowserRouter, Link, NavLink, Navigate, Route, Routes } from "react-router";
import { bootstrapSession, sessionKey } from "./app/api";
import { ErrorBoundary, Loading, Problem } from "./app/ui";
import { UnlockSession } from "./features/settings/security";
import Welcome from "./features/onboarding/welcome";
import t from "./locales/zh-CN.json";
import "./styles/tokens.css";

const Settings = lazy(() => import("./features/settings/settings"));
const Diagnostics = lazy(() => import("./features/settings/diagnostics"));
const queries = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000, refetchOnWindowFocus: false } } });
const navigation = [
  ["/welcome", t.app.teachers],
  ["/settings", t.app.settings],
  ["/settings/diagnostics", t.app.diagnostics],
] as const;

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
              <Route path="/welcome" element={<Welcome />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="/settings/diagnostics" element={<Diagnostics />} />
              <Route path="*" element={<Navigate to="/welcome" replace />} />
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
