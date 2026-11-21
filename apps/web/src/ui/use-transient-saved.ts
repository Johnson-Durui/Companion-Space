import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "./toast";

/**
 * Triggers a toast confirmation plus a short-lived nearby saved indicator
 * (per design-system §8: toast is never the sole trace, and inline text fades cleanly).
 */
export function useTransientSaved(defaultMessage = "已保存", visibleMs = 3000) {
  const [saved, setSaved] = useState(false);
  const timerRef = useRef<number | null>(null);

  const notifySaved = useCallback((message?: string) => {
    const text = message ?? defaultMessage;
    toast.success(text);
    setSaved(true);
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      setSaved(false);
      timerRef.current = null;
    }, visibleMs);
  }, [defaultMessage, visibleMs]);

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
  }, []);

  return { saved, notifySaved };
}
