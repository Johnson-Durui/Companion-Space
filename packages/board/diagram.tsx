import { useEffect, useId, useRef, useState } from "react";
import styles from "./board.module.css";

function repair(source: string) {
  let value = source.trim().replace(/^```(?:mermaid)?\s*/i, "").replace(/\s*```$/, "").replaceAll("→", "-->");
  if (!/^(?:flowchart|graph|sequenceDiagram|classDiagram|stateDiagram|erDiagram|gantt|pie|mindmap|timeline|journey|gitGraph|quadrantChart|xychart-beta)\b/i.test(value)
    && /-->|---|==>/.test(value)) value = `flowchart TD\n${value}`;
  return value;
}

function readThemeVars(el: HTMLElement | null) {
  const read = (name: string, fallback: string) => {
    if (!el) return fallback;
    try {
      return getComputedStyle(el).getPropertyValue(name).trim() || fallback;
    } catch {
      return fallback;
    }
  };
  const primaryColor = read("--accent-soft", "rgb(227 241 238)");
  const primaryTextColor = read("--text-primary", "rgb(27 33 38)");
  const primaryBorderColor = read("--accent", "rgb(31 122 110)");
  const lineColor = read("--text-secondary", "rgb(85 96 106)");
  const secondaryColor = read("--surface-sunken", "rgb(239 237 232)");
  const tertiaryColor = read("--surface-card", "rgb(255 253 246)");
  const fontFamily = read("--font-sans", "system-ui, sans-serif");
  return {
    primaryColor,
    primaryTextColor,
    primaryBorderColor,
    lineColor,
    secondaryColor,
    tertiaryColor,
    fontFamily,
  };
}

export function DiagramBlock({
  source,
  errorLabel,
  viewSourceLabel = "查看原始内容",
}: {
  source: string;
  errorLabel: string;
  viewSourceLabel?: string;
}) {
  const reactId = useId().replace(/[^A-Za-z0-9_-]/g, "");
  const containerRef = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState<string>();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    void import("mermaid").then(async ({ default: mermaid }) => {
      const themeVariables = readThemeVars(containerRef.current ?? document.documentElement);
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        maxTextSize: 20_000,
        theme: "base",
        themeVariables,
      });
      for (const [index, candidate] of [source, repair(source)].entries()) {
        if (index === 1 && candidate === source) continue;
        if (await mermaid.parse(candidate, { suppressErrors: true })) {
          const result = await mermaid.render(`board-${reactId}-${index}`, candidate);
          if (active) { setSvg(result.svg); setFailed(false); }
          return;
        }
      }
      if (active) setFailed(true);
    }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [reactId, source]);

  if (failed) {
    return (
      <div className={styles.fallback} role="note">
        <p className={styles.fallbackTitle}>{errorLabel}</p>
        <details className={styles.fallbackDetails}>
          <summary>{viewSourceLabel}</summary>
          <pre><code>{source}</code></pre>
        </details>
      </div>
    );
  }
  return (
    <div ref={containerRef} className={svg ? styles.diagram : styles.pending} aria-busy={!svg || undefined}>
      {svg ? <div dangerouslySetInnerHTML={{ __html: svg }} /> : null}
    </div>
  );
}
