import { useEffect, useRef, useState } from "react";
import { parsePlotSpec, type PlotSpec } from "./validation";
import styles from "./board.module.css";

export function PlotBlock({ source, errorLabel }: { source: string; errorLabel: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [spec, setSpec] = useState<PlotSpec | null>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    setSpec(undefined);
    setFailed(false);
    void parsePlotSpec(source).then((value) => { if (active) setSpec(value); });
    return () => { active = false; };
  }, [source]);
  useEffect(() => {
    if (!spec || !host.current) return;
    let active = true;
    void import("function-plot").then((module) => {
      if (!active || !host.current) return;
      const exported: unknown = module.default;
      const candidate = typeof exported === "function" ? exported : (exported as { default?: unknown } | null)?.default;
      if (typeof candidate !== "function") throw new TypeError("function-plot export is unavailable");
      const functionPlot = candidate as typeof module.default;
      host.current.replaceChildren();
      const width = Math.max(320, Math.min(760, host.current.clientWidth || 640));
      functionPlot({
        target: host.current, width, height: Math.round(width * .58), grid: true, disableZoom: true,
        xAxis: { domain: spec.x }, yAxis: spec.y ? { domain: spec.y } : undefined,
        data: [
          ...spec.fn.map((fn) => ({ fn, graphType: "polyline" as const })),
          ...(spec.points.length ? [{ points: spec.points, fnType: "points" as const, graphType: "scatter" as const }] : []),
        ],
      });
      setFailed(false);
    }).catch(() => setFailed(true));
    return () => { active = false; };
  }, [spec]);
  if (spec === null || failed) return <pre className={styles.fallback}><code>{source}</code><small>{errorLabel}</small></pre>;
  if (!spec) return <div className={styles.pending} aria-busy="true" />;
  return <div className={styles.plot}>
    <div ref={host} />
    {[...spec.holes.map((at) => ({ at, text: "○" })), ...spec.labels].length ? <ul className={styles.plotLabels}>
      {[...spec.holes.map((at) => ({ at, text: "○" })), ...spec.labels].map(({ at, text }, index) => <li key={index}>{text} ({at.join(", ")})</li>)}
    </ul> : null}
  </div>;
}

