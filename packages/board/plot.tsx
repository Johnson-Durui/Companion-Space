import { useEffect, useRef, useState } from "react";
import { parsePlotSpec, type PlotSpec } from "./validation";
import styles from "./board.module.css";

const PALETTE_TOKENS = [
  "--accent",
  "--info",
  "--ok",
  "--retry",
  "--warn",
  "--danger",
] as const;

function readToken(el: HTMLElement, name: string, fallback: string): string {
  try {
    const val = getComputedStyle(el).getPropertyValue(name).trim();
    return val || fallback;
  } catch {
    return fallback;
  }
}

function resolvePlotPalette(el: HTMLElement): string[] {
  const fallbacks = [
    "rgb(31 122 110)",
    "rgb(31 95 168)",
    "rgb(30 123 77)",
    "rgb(168 72 15)",
    "rgb(138 90 0)",
    "rgb(179 38 30)",
  ];
  return PALETTE_TOKENS.map((token, idx) => readToken(el, token, fallbacks[idx] ?? fallbacks[0]));
}

export function PlotBlock({
  source,
  errorLabel,
  viewSourceLabel = "查看原始内容",
}: {
  source: string;
  errorLabel: string;
  viewSourceLabel?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const [spec, setSpec] = useState<PlotSpec | null>();
  const [failed, setFailed] = useState(false);
  const [containerWidth, setContainerWidth] = useState(0);
  const [palette, setPalette] = useState<string[]>([]);

  useEffect(() => {
    let active = true;
    setSpec(undefined);
    setFailed(false);
    void parsePlotSpec(source).then((value) => { if (active) setSpec(value); });
    return () => { active = false; };
  }, [source]);

  // Redraw when container resizes (e.g. toggling view mode or opening lightbox)
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let raf = 0;
    const ro = new ResizeObserver((entries) => {
      const next = Math.round(entries[0]?.contentRect.width ?? el.clientWidth ?? 0);
      if (next <= 0) return;
      window.cancelAnimationFrame(raf);
      raf = window.requestAnimationFrame(() => {
        setContainerWidth((prev) => (Math.abs(prev - next) >= 12 ? next : prev));
      });
    });
    ro.observe(el);
    return () => {
      window.cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [spec]);

  useEffect(() => {
    if (!spec || !host.current) return;
    let active = true;
    void import("function-plot").then((module) => {
      if (!active || !host.current) return;
      const exported: unknown = module.default;
      const candidate = typeof exported === "function" ? exported : (exported as { default?: unknown } | null)?.default;
      if (typeof candidate !== "function") throw new TypeError("function-plot export is unavailable");
      const functionPlot = candidate as typeof module.default;

      const resolvedPalette = resolvePlotPalette(host.current);
      setPalette(resolvedPalette);
      const surfaceBg = readToken(host.current, "--surface-card", "rgb(255 253 246)");
      const textPrimary = readToken(host.current, "--text-primary", "rgb(27 33 38)");

      host.current.replaceChildren();
      const measured = containerWidth || host.current.clientWidth || 640;
      const width = Math.max(280, Math.min(820, measured));

      const instance = functionPlot({
        target: host.current,
        width,
        height: Math.round(width * 0.56),
        grid: true,
        disableZoom: true,
        xAxis: { domain: spec.x },
        yAxis: spec.y ? { domain: spec.y } : undefined,
        data: [
          ...spec.fn.map((fn, idx) => ({
            fn,
            graphType: "polyline" as const,
            color: resolvedPalette[idx % resolvedPalette.length],
          })),
          ...(spec.points.length
            ? [{
                points: spec.points,
                fnType: "points" as const,
                graphType: "scatter" as const,
                color: resolvedPalette[0],
              }]
            : []),
          ...(spec.holes.length
            ? [{
                points: spec.holes,
                fnType: "points" as const,
                graphType: "scatter" as const,
                color: resolvedPalette[0],
                attr: {
                  fill: surfaceBg,
                  stroke: resolvedPalette[0],
                  "stroke-width": 2.2,
                  r: 4.5,
                },
              }]
            : []),
        ],
      }) as unknown as {
        meta?: {
          xScale?: (x: number) => number;
          yScale?: (y: number) => number;
        };
      };

      // Draw hollow points & coordinate labels directly on the SVG canvas when scales are exposed.
      try {
        const xScale = instance?.meta?.xScale;
        const yScale = instance?.meta?.yScale;
        const canvas = host.current.querySelector<SVGGElement>("svg g.canvas");
        if (canvas && typeof xScale === "function" && typeof yScale === "function") {
          const ns = "http://www.w3.org/2000/svg";
          const overlay = document.createElementNS(ns, "g");
          overlay.setAttribute("class", "cs-plot-overlay");

          for (const [hx, hy] of spec.holes) {
            const cx = xScale(hx);
            const cy = yScale(hy);
            if (!Number.isFinite(cx) || !Number.isFinite(cy)) continue;
            const circle = document.createElementNS(ns, "circle");
            circle.setAttribute("cx", String(cx));
            circle.setAttribute("cy", String(cy));
            circle.setAttribute("r", "4.5");
            circle.setAttribute("fill", surfaceBg);
            circle.setAttribute("stroke", resolvedPalette[0]);
            circle.setAttribute("stroke-width", "2.2");
            overlay.appendChild(circle);
          }

          for (const { at: [lx, ly], text } of spec.labels) {
            const px = xScale(lx);
            const py = yScale(ly);
            if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
            const dot = document.createElementNS(ns, "circle");
            dot.setAttribute("cx", String(px));
            dot.setAttribute("cy", String(py));
            dot.setAttribute("r", "3");
            dot.setAttribute("fill", resolvedPalette[0]);
            overlay.appendChild(dot);

            const label = document.createElementNS(ns, "text");
            label.setAttribute("x", String(px + 7));
            label.setAttribute("y", String(py - 6));
            label.setAttribute("fill", textPrimary);
            label.setAttribute("font-size", "12");
            label.setAttribute("font-weight", "500");
            label.textContent = text;
            overlay.appendChild(label);
          }

          canvas.appendChild(overlay);
        }
      } catch {
        // Fallback label list below stays rendered regardless
      }

      setFailed(false);
    }).catch(() => setFailed(true));
    return () => { active = false; };
  }, [spec, containerWidth]);

  if (spec === null || failed) {
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
  if (!spec) return <div className={styles.pending} aria-busy="true" />;

  return (
    <div ref={containerRef} className={styles.plot} data-testid="board-plot">
      <div ref={host} />
      {spec.fn.length > 0 ? (
        <ul className={styles.plotLegend} data-testid="plot-legend">
          {spec.fn.map((fn, idx) => (
            <li key={`${fn}-${idx}`} className={styles.plotLegendItem}>
              <span
                className={styles.plotSwatch}
                aria-hidden="true"
                style={{ backgroundColor: palette[idx % Math.max(1, palette.length)] ?? "var(--accent)" }}
              />
              <code>y = {fn}</code>
            </li>
          ))}
        </ul>
      ) : null}
      {[...spec.holes.map((at) => ({ at, text: "○" })), ...spec.labels].length ? (
        <ul className={styles.plotLabels}>
          {[...spec.holes.map((at) => ({ at, text: "○" })), ...spec.labels].map(({ at, text }, index) => (
            <li key={index}>
              {text} ({at.join(", ")})
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
