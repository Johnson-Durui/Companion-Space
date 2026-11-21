import { Component, type ReactNode } from "react";
import t from "../locales/zh-CN.json";
import { Button, DelayedSkeleton, ErrorState } from "../ui";

export function Loading({ text = t.common.loading }: { text?: string }) {
  return <DelayedSkeleton loading={true} label={text} />;
}

export function Problem({ error, onRetry }: { error?: unknown; onRetry?: () => void }) {
  return <ErrorState error={error} onRetry={onRetry} retryLabel={t.common.retry} />;
}

export class ErrorBoundary extends Component<
  { children: ReactNode; fallback?: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    if (this.props.fallback) return this.props.fallback;
    return (
      <main className="mx-auto max-w-2xl px-6 py-12 grid gap-4 justify-items-start">
        <h1 className="text-headline font-semibold text-fg-primary">{t.app.routeErrorTitle}</h1>
        <p role="alert" className="text-ui text-fg-secondary">{t.app.error}</p>
        <Button variant="primary" onClick={() => window.location.reload()}>{t.app.refresh}</Button>
      </main>
    );
  }
}
