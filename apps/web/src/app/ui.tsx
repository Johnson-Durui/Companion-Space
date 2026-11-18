import { Component, type ReactNode } from "react";
import t from "../locales/zh-CN.json";

export function Loading({ text = t.common.loading }: { text?: string }) {
  return <p role="status" className="state-note">{text}</p>;
}

export function Problem({ error, onRetry }: { error?: unknown; onRetry?: () => void }) {
  return (
    <div className="notice danger">
      <p role="alert">{error instanceof Error ? error.message : t.common.error}</p>
      {onRetry ? <button className="button quiet" onClick={onRetry}>{t.common.retry}</button> : null}
    </div>
  );
}

export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? (
      <main className="shell error-screen">
        <p role="alert">{t.app.error}</p>
        <button className="button primary" onClick={() => window.location.reload()}>{t.app.refresh}</button>
      </main>
    ) : this.props.children;
  }
}
