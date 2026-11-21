import type { ReactNode } from "react";
import clsx from "clsx";
import { Button } from "./button";
import { AlertCircle, RefreshCw } from "./icons";

export interface ErrorStateProps {
  title?: string;
  message?: string;
  error?: unknown;
  onRetry?: () => void;
  retryLabel?: string;
  action?: ReactNode;
  className?: string;
}

function extractDetails(error: unknown): { summary: string; detail?: string } {
  if (error instanceof Error) {
    const raw = error.message.trim();
    const looksTechnical = /HTTP \d+|status \d+|TypeError|SyntaxError|NetworkError|ECONN|stack|traceback|\b[a-z]+_[a-z_]+\b/i.test(raw);
    if (looksTechnical) {
      return {
        summary: "请检查本机服务或连接状态后再试一次。",
        detail: raw,
      };
    }
    return { summary: raw || "请稍后再试一次。" };
  }
  if (typeof error === "string" && error.trim()) {
    return { summary: error.trim() };
  }
  return { summary: "请稍后再试一次。" };
}

export function ErrorState({
  title = "暂时没有完成这一步",
  message,
  error,
  onRetry,
  retryLabel = "重试",
  action,
  className,
}: ErrorStateProps) {
  const extracted = extractDetails(error);
  const body = message ?? extracted.summary;
  const detail = extracted.detail;

  return (
    <div
      role="alert"
      className={clsx(
        "grid gap-3 rounded-md border border-danger/30 border-l-4 border-l-danger bg-danger-soft p-4 text-fg-primary",
        className,
      )}
    >
      <div className="flex items-start gap-2.5">
        <AlertCircle size={18} className="mt-0.5 shrink-0 text-danger" aria-hidden="true" />
        <div className="grid min-w-0 flex-1 gap-1">
          <p className="text-ui font-semibold text-danger-text">{title}</p>
          <p className="text-ui text-fg-primary break-words">{body}</p>
        </div>
      </div>
      {onRetry || action ? (
        <div className="flex flex-wrap items-center gap-2">
          {onRetry ? (
            <Button
              variant="secondary"
              size="sm"
              leftIcon={<RefreshCw size={14} aria-hidden="true" />}
              onClick={onRetry}
            >
              {retryLabel}
            </Button>
          ) : null}
          {action}
        </div>
      ) : null}
      {detail ? (
        <details className="text-caption text-fg-secondary">
          <summary className="cursor-pointer font-medium text-fg-secondary">查看详情</summary>
          <pre className="mt-2 overflow-x-auto rounded-sm bg-surface-card p-2.5 text-caption text-fg-secondary whitespace-pre-wrap break-all">
            {detail}
          </pre>
        </details>
      ) : null}
    </div>
  );
}
