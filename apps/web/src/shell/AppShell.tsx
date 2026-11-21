import type { ReactNode } from "react";
import { Link, useLocation } from "react-router";
import clsx from "clsx";
import t from "../locales/zh-CN.json";
import { BookOpen, BrandMark, Settings, Toaster, TooltipProvider, Users } from "../ui";

const DESK_NAV = [
  { to: "/courses", label: t.app.courses, icon: BookOpen },
  { to: "/welcome", label: t.app.teachers, icon: Users },
  { to: "/settings", label: t.app.settings, icon: Settings },
] as const;

export function navActive(to: string, pathname: string): boolean {
  if (to === "/courses") {
    return (
      pathname === "/courses"
      || pathname.startsWith("/courses/")
      || pathname.startsWith("/lessons/")
      || pathname.startsWith("/plan-items/")
    );
  }
  if (to === "/welcome") {
    return (
      pathname === "/welcome"
      || pathname.startsWith("/characters")
      || pathname.startsWith("/tutors")
      || pathname.startsWith("/sample-lesson")
    );
  }
  if (to === "/settings") {
    return pathname === "/settings" || pathname.startsWith("/settings/");
  }
  return pathname === to;
}

export interface AppShellProps {
  children: ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  const location = useLocation();

  return (
    <TooltipProvider>
      <div className="min-h-dvh flex flex-col bg-surface-page text-fg-primary">
        <a
          className="fixed left-2 -top-24 z-modal rounded-md bg-surface-card px-3 py-2 text-ui font-medium text-fg-primary shadow-2 focus:top-2"
          href="#main"
        >
          {t.app.skip}
        </a>

        <header className="sticky top-0 z-sticky border-b border-line-subtle bg-surface-card/95 backdrop-blur">
          <div className="mx-auto grid min-h-16 max-w-[1200px] grid-cols-[1fr_auto] md:grid-cols-[1fr_auto_1fr] items-center gap-4 px-4 md:px-8">
            <Link to="/welcome" className="inline-flex items-center gap-3 justify-self-start min-h-10">
              <BrandMark size={34} />
              <span className="grid leading-tight">
                <strong className="text-body font-semibold tracking-wide text-fg-primary">
                  {t.app.name}
                </strong>
                <small className="text-caption text-fg-secondary">Companion Space</small>
              </span>
            </Link>

            <nav
              className="hidden md:flex items-stretch self-stretch gap-2"
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
                      "relative inline-flex items-center gap-2 px-3.5 text-ui transition-colors duration-fast ease-out",
                      active
                        ? "font-semibold text-accent-strong"
                        : "font-medium text-fg-secondary hover:text-fg-primary",
                    )}
                  >
                    <Icon size={17} strokeWidth={1.85} aria-hidden="true" />
                    <span>{label}</span>
                    {active ? (
                      <span
                        aria-hidden="true"
                        className="absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-accent"
                      />
                    ) : null}
                  </Link>
                );
              })}
            </nav>

            <span className="inline-flex items-center gap-2 justify-self-end text-caption text-fg-secondary">
              <span
                aria-hidden="true"
                className="h-2 w-2 rounded-full bg-ok"
              />
              <span>{t.app.local}</span>
            </span>
          </div>
        </header>

        <main
          id="main"
          className="mx-auto w-full max-w-[1200px] flex-1 px-4 pb-20 md:px-8 md:pb-12"
        >
          <div key={location.pathname} className="cs-route-enter">
            {children}
          </div>
        </main>

        <nav
          aria-label={`${t.app.name}导航`}
          className="fixed inset-x-0 bottom-0 z-dock flex md:hidden items-center justify-around border-t border-line-subtle bg-surface-card/95 backdrop-blur pb-[env(safe-area-inset-bottom)]"
        >
          {DESK_NAV.map(({ to, label, icon: Icon }) => {
            const active = navActive(to, location.pathname);
            return (
              <Link
                key={to}
                to={to}
                aria-current={active ? "page" : undefined}
                className={clsx(
                  "flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 text-caption transition-colors duration-fast ease-out",
                  active ? "font-semibold text-accent-strong" : "font-medium text-fg-secondary",
                )}
              >
                <Icon size={19} strokeWidth={1.85} aria-hidden="true" />
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
