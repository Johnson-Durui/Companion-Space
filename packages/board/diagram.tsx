import { useEffect, useId, useState } from "react";
import styles from "./board.module.css";

function repair(source: string) {
  let value = source.trim().replace(/^```(?:mermaid)?\s*/i, "").replace(/\s*```$/, "").replaceAll("→", "-->");
  if (!/^(?:flowchart|graph|sequenceDiagram|classDiagram|stateDiagram|erDiagram|gantt|pie|mindmap|timeline|journey|gitGraph|quadrantChart|xychart-beta)\b/i.test(value)
    && /-->|---|==>/.test(value)) value = `flowchart TD\n${value}`;
  return value;
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
  const [svg, setSvg] = useState<string>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    void import("mermaid").then(async ({ default: mermaid }) => {
      mermaid.initialize({ startOnLoad: false, securityLevel: "strict", maxTextSize: 20_000 });
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
  return svg ? <div className={styles.diagram} dangerouslySetInnerHTML={{ __html: svg }} /> : <div className={styles.pending} aria-busy="true" />;
}

