import type { ReactNode } from "react";
import { Link, useLocation } from "react-router";
import clsx from "clsx";
import t from "../locales/zh-CN.json";
import { ArrowLeft, BrandMark, Toaster, TooltipProvider } from "../ui";

export interface FocusShellProps {
  flowName: string;
  exitTo?: string;
  exitLabel?: string;
  onExit?: () => void;
  progress?: ReactNode;
  maxWidth?: "md" | "lg";
  children: ReactNode;
}

export function FocusShell({
  flowName,
  exitTo = "/",
  exitLabel = t.app.exit,
  onExit,
  progress,
  maxWidth = "md",
  children,
}: FocusShellProps) {
  const location = useLocation();
  const containerWidth = maxWidth === "lg" ? "max-w-[960px]" : "max-w-[880px]";

  return (
    <TooltipProvider>
      <div
        data-surface="desk"
        className="min-h-dvh flex flex-col bg-surface-page text-fg-primary"
      >
        <a
          className="fixed left-2 -top-24 z-modal rounded-md bg-surface-card px-3 py-2 text-ui font-medium text-fg-primary shadow-2 focus:top-2"
          href="#main"
        >
          {t.app.skip}
        </a>

        <header className="sticky top-0 z-sticky border-b border-line-subtle bg-surface-card/95 backdrop-blur">
          <div className={clsx("mx-auto flex min-h-14 w-full items-center justify-between gap-4 px-4 sm:px-6", containerWidth)}>
            <div className="flex min-w-0 items-center gap-2.5">
              <BrandMark size={28} />
              <span className="truncate text-ui font-semibold text-fg-primary">{flowName}</span>
            </div>

            {progress ? (
              <div className="hidden sm:flex min-w-0 flex-1 items-center justify-center">
                {progress}
              </div>
            ) : null}

            {onExit ? (
              <button
                type="button"
                onClick={onExit}
                className="inline-flex min-h-10 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-ui font-medium text-fg-secondary transition-colors duration-fast ease-out hover:bg-surface-sunken hover:text-fg-primary"
              >
                <ArrowLeft size={16} aria-hidden="true" />
                <span>{exitLabel}</span>
              </button>
            ) : (
              <Link
                to={exitTo}
                className="inline-flex min-h-10 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-ui font-medium text-fg-secondary transition-colors duration-fast ease-out hover:bg-surface-sunken hover:text-fg-primary"
              >
                <ArrowLeft size={16} aria-hidden="true" />
                <span>{exitLabel}</span>
              </Link>
            )}
          </div>
          {progress ? (
            <div className="border-t border-line-subtle px-4 py-2 sm:hidden">
              {progress}
            </div>
          ) : null}
        </header>

        <main
          id="main"
          className={clsx("mx-auto w-full flex-1 px-4 py-6 sm:px-6 sm:py-8", containerWidth)}
        >
          <div key={location.pathname} className="cs-route-enter">
            {children}
          </div>
        </main>
      </div>
      <Toaster />
    </TooltipProvider>
  );
}
