import type { ReactNode } from "react";
import { Link, useLocation } from "react-router";
import clsx from "clsx";
import t from "../locales/zh-CN.json";
import { useReadiness } from "../features/settings/use-readiness";
import { useActiveTutor } from "../features/tutors/use-active-tutor";
import { BookOpen, BrandMark, Home, Settings, Toaster, TooltipProvider, TutorChip, Users } from "../ui";

const DESK_NAV = [
  { to: "/", label: t.app.today, icon: Home },
  { to: "/courses", label: t.app.courses, icon: BookOpen },
  { to: "/tutors", label: t.app.teachers, icon: Users },
  { to: "/settings", label: t.app.settings, icon: Settings },
] as const;

export function navActive(to: string, pathname: string): boolean {
  if (to === "/") {
    return pathname === "/";
  }
  if (to === "/courses") {
    return (
      pathname === "/courses"
      || pathname.startsWith("/courses/")
      || pathname.startsWith("/lessons/")
      || pathname.startsWith("/plan-items/")
    );
  }
  if (to === "/tutors") {
    return (
      pathname === "/tutors"
      || pathname.startsWith("/tutors/")
      || pathname.startsWith("/characters")
      || pathname.startsWith("/welcome")
      || pathname.startsWith("/sample-lesson")
    );
  }
  if (to === "/settings") {
    return pathname === "/settings" || pathname.startsWith("/settings/");
  }
  return pathname === to;
}

export interface AppShellProps {
  sessionReady?: boolean;
  children: ReactNode;
}

export function AppShell({ sessionReady = false, children }: AppShellProps) {
  const location = useLocation();
  const readiness = useReadiness(sessionReady);
  const { tutor } = useActiveTutor(sessionReady);
  const aiReady = !sessionReady || readiness.isPending || readiness.readyForLessons;

  return (
    <TooltipProvider>
      <div className="cs-desk-canvas min-h-dvh flex flex-col overflow-x-clip bg-surface-page text-fg-primary">
        <div aria-hidden="true" className="cs-desk-grid" />
        <a
          className="fixed left-2 -top-24 z-modal rounded-md bg-surface-card px-3 py-2 text-ui font-medium text-fg-primary shadow-2 focus:top-2"
          href="#main"
        >
          {t.app.skip}
        </a>

        <header className="sticky top-0 z-sticky border-b border-line-subtle/80 bg-surface-card/82 backdrop-blur-xl">
          <div className="mx-auto grid min-h-16 max-w-[1220px] grid-cols-[1fr_auto] md:grid-cols-[1fr_auto_1fr] items-center gap-4 px-4 md:px-8">
            <Link
              to="/"
              className="group inline-flex items-center gap-3 justify-self-start min-h-10"
            >
              <span className="inline-flex rounded-md p-0.5 ring-1 ring-accent/20 transition-transform duration-fast group-hover:scale-[1.03]">
                <BrandMark size={34} />
              </span>
              <span className="grid leading-tight">
                <strong className="text-body font-semibold tracking-wide text-fg-primary">
                  {t.app.name}
                </strong>
                <small className="text-caption text-fg-secondary">
                  {t.richUi.studioSubtitle}
                </small>
              </span>
            </Link>

            <nav
              className="cs-glass-nav hidden md:flex items-center gap-1 rounded-full p-1"
              aria-label={t.app.name}
            >
              {DESK_NAV.map(({ to, label, icon: Icon }) => {
                const active = navActive(to, location.pathname);
                return (
                  <Link
                    key={to}
                    to={to}
                    aria-current={active ? "page" : undefined}
                    className={clsx(
                      "relative inline-flex min-h-9 items-center gap-2 rounded-full px-4 text-ui transition-[background-color,color,box-shadow] duration-fast ease-out",
                      active
                        ? "bg-surface-card font-semibold text-accent-strong shadow-1 ring-1 ring-accent/25"
                        : "font-medium text-fg-secondary hover:bg-surface-card/55 hover:text-fg-primary",
                    )}
                  >
                    <Icon size={16} strokeWidth={active ? 2.1 : 1.85} aria-hidden="true" />
                    <span>{label}</span>
                    {active ? (
                      <span
                        aria-hidden="true"
                        className="h-1.5 w-1.5 rounded-full bg-accent"
                      />
                    ) : null}
                  </Link>
                );
              })}
            </nav>

            <div className="flex items-center justify-end gap-2.5 justify-self-end min-w-0">
              {aiReady ? (
                <span
                  data-testid="readiness-indicator"
                  data-ready="true"
                  className="hidden sm:inline-flex min-h-9 items-center gap-1.5 rounded-full border border-line-subtle bg-surface-card/85 px-3 text-caption font-medium text-fg-secondary whitespace-nowrap shadow-1"
                >
                  <span aria-hidden="true" className="h-2 w-2 rounded-full bg-ok ring-3 ring-ok-soft" />
                  <span>{t.app.local}</span>
                </span>
              ) : (
                <Link
                  to="/settings/ai"
                  data-testid="readiness-indicator"
                  data-ready="false"
                  className="inline-flex min-h-9 items-center gap-1.5 rounded-full border border-warn/35 bg-warn-soft px-3 text-caption font-medium text-warn-text whitespace-nowrap shadow-1 transition-colors duration-fast ease-out hover:bg-warn-soft/80"
                >
                  <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full bg-warn" />
                  <span className="hidden sm:inline">{t.app.aiNotReady}</span>
                </Link>
              )}
              {tutor ? (
                <Link
                  to="/tutors"
                  data-testid="header-tutor-chip"
                  aria-label={`${t.tutorsGallery.currentTeacher}：${tutor.name}`}
                  className="inline-flex rounded-full transition-transform duration-fast hover:scale-[1.02] active:scale-[0.98]"
                >
                  <TutorChip
                    name={tutor.name}
                    src={tutor.appearance.src}
                    subtitle={tutor.tagline ? <span className="hidden lg:inline">{tutor.tagline}</span> : undefined}
                  />
                </Link>
              ) : null}
            </div>
          </div>
        </header>

        <main
          id="main"
          className="mx-auto w-full min-w-0 max-w-[1220px] flex-1 px-4 pb-20 md:px-8 md:pb-10"
        >
          <div key={location.pathname} className="cs-route-enter min-w-0">
            {children}
          </div>
        </main>

        <footer className="hidden md:block border-t border-line-subtle/70 bg-surface-card/45">
          <div className="mx-auto flex max-w-[1220px] items-center justify-between gap-4 px-8 py-4 text-caption text-fg-tertiary">
            <span className="font-medium text-fg-secondary">{t.app.name} · Companion Space</span>
            <span>{t.richUi.footerTagline}</span>
            <span className="font-mono">127.0.0.1</span>
          </div>
        </footer>

        <nav
          aria-label={`${t.app.name}导航`}
          className="fixed inset-x-0 bottom-0 z-dock flex md:hidden items-center justify-around border-t border-line-subtle bg-surface-card/92 px-2 py-1 backdrop-blur-xl pb-[max(0.25rem,env(safe-area-inset-bottom))]"
        >
          {DESK_NAV.map(({ to, label, icon: Icon }) => {
            const active = navActive(to, location.pathname);
            return (
              <Link
                key={to}
                to={to}
                aria-current={active ? "page" : undefined}
                className={clsx(
                  "flex min-h-12 flex-1 flex-col items-center justify-center gap-0.5 rounded-md text-caption transition-colors duration-fast ease-out",
                  active
                    ? "bg-accent-soft/75 font-semibold text-accent-strong"
                    : "font-medium text-fg-secondary",
                )}
              >
                <Icon size={19} strokeWidth={active ? 2.1 : 1.85} aria-hidden="true" />
                <span>{label}</span>
              </Link>
            );
          })}
        </nav>
      </div>
      <Toaster />
    </TooltipProvider>
  );
}
