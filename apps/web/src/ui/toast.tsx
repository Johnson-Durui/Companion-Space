import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import clsx from "clsx";
import { AlertCircle, AlertTriangle, CheckCircle2, Info, X } from "./icons";

export type ToastTone = "info" | "success" | "warning" | "error";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastItem {
  id: string;
  tone: ToastTone;
  message: string;
  durationMs: number;
  action?: ToastAction;
}

export interface ToastOptions {
  durationMs?: number;
  action?: ToastAction;
}

const DEFAULT_DURATION_MS = 5000;
let nextId = 1;
let items: ToastItem[] = [];
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): ToastItem[] {
  return items;
}

function add(tone: ToastTone, message: string, options: ToastOptions = {}): string {
  const id = `toast-${nextId++}`;
  const durationMs = options.action ? 0 : (options.durationMs ?? DEFAULT_DURATION_MS);
  items = [...items.slice(-4), { id, tone, message, durationMs, action: options.action }];
  emit();
  return id;
}

function dismiss(id: string): void {
  const next = items.filter((item) => item.id !== id);
  if (next.length !== items.length) {
    items = next;
    emit();
  }
}

function clear(): void {
  if (items.length === 0) return;
  items = [];
  emit();
}

export const toast = {
  info: (message: string, options?: ToastOptions) => add("info", message, options),
  success: (message: string, options?: ToastOptions) => add("success", message, options),
  warning: (message: string, options?: ToastOptions) => add("warning", message, options),
  error: (message: string, options?: ToastOptions) => add("error", message, options),
  dismiss,
  clear,
};

const TONE_BORDER: Record<ToastTone, string> = {
  info: "border-l-info",
  success: "border-l-ok",
  warning: "border-l-warn",
  error: "border-l-danger",
};

function ToastIcon({ tone }: { tone: ToastTone }) {
  if (tone === "success") return <CheckCircle2 size={18} className="text-ok shrink-0" aria-hidden="true" />;
  if (tone === "warning") return <AlertTriangle size={18} className="text-warn shrink-0" aria-hidden="true" />;
  if (tone === "error") return <AlertCircle size={18} className="text-danger shrink-0" aria-hidden="true" />;
  return <Info size={18} className="text-info shrink-0" aria-hidden="true" />;
}

function ToastCard({ item }: { item: ToastItem }) {
  const [paused, setPaused] = useState(false);
  const remainingRef = useRef(item.durationMs);
  const startedAtRef = useRef(0);

  useEffect(() => {
    if (item.durationMs <= 0) return;
    if (paused) return;
    startedAtRef.current = Date.now();
    const timer = window.setTimeout(() => {
      toast.dismiss(item.id);
    }, remainingRef.current);
    return () => {
      window.clearTimeout(timer);
      const elapsed = Date.now() - startedAtRef.current;
      remainingRef.current = Math.max(0, remainingRef.current - elapsed);
    };
  }, [item.id, item.durationMs, paused]);

  const role = item.tone === "error" ? "alert" : "status";

  return (
    <div
      role={role}
      aria-live={item.tone === "error" ? "assertive" : "polite"}
      data-testid="toast-item"
      data-tone={item.tone}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      className={clsx(
        "cs-toast-item pointer-events-auto flex w-full max-w-sm items-center gap-3 rounded-md border border-line-subtle border-l-4 bg-surface-overlay px-4 py-3 text-ui text-fg-primary shadow-3",
        TONE_BORDER[item.tone],
      )}
    >
      <ToastIcon tone={item.tone} />
      <p className="min-w-0 flex-1 break-words">{item.message}</p>
      {item.action ? (
        <button
          type="button"
          onClick={() => {
            item.action?.onClick();
            toast.dismiss(item.id);
          }}
          className="shrink-0 rounded-sm px-2 py-1 text-caption font-semibold text-accent-strong hover:bg-accent-soft"
        >
          {item.action.label}
        </button>
      ) : null}
      <button
        type="button"
        aria-label="关闭提示"
        onClick={() => toast.dismiss(item.id)}
        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-fg-tertiary hover:bg-surface-sunken hover:text-fg-primary"
      >
        <X size={15} aria-hidden="true" />
      </button>
    </div>
  );
}

export function Toaster() {
  const active = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  if (active.length === 0) return null;

  return (
    <div
      aria-label="通知"
      className="pointer-events-none fixed inset-x-0 bottom-5 z-toast flex flex-col items-end gap-2 px-4 sm:right-5 sm:left-auto"
    >
      {active.map((item) => (
        <ToastCard key={item.id} item={item} />
      ))}
    </div>
  );
}
