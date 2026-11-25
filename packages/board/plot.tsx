import { useEffect, useMemo, useRef, useState } from "react";
import { parsePlotSpec, type PlotParam, type PlotSpec } from "./validation";
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

function clampParam(param: PlotParam, value: number): number {
  if (!Number.isFinite(value)) return param.default;
  return Math.min(param.max, Math.max(param.min, value));
}

function buildInitialParams(
  params: readonly PlotParam[] | undefined,
  external?: Record<string, number>,
): Record<string, number> {
  if (!params?.length) return {};
  const result: Record<string, number> = {};
  for (const param of params) {
    const override = external?.[param.name];
    result[param.name] = typeof override === "number" ? clampParam(param, override) : param.default;
  }
  return result;
}

function formatParamNumber(value: number, step: number): string {
  const stepText = String(step);
  const decimals = stepText.includes(".") ? Math.min(4, stepText.split(".")[1]?.length ?? 0) : 0;
  return Number(value.toFixed(Math.max(decimals, 2))).toString();
}

export function PlotBlock({
  source,
  errorLabel,
  viewSourceLabel = "查看原始内容",
  resetLabel = "恢复默认",
  playLabel = "演示变化",
  pauseLabel = "暂停演示",
  externalParams,
  paramSeq,
  reducedMotion = false,
}: {
  source: string;
  errorLabel: string;
  viewSourceLabel?: string;
  resetLabel?: string;
  playLabel?: string;
  pauseLabel?: string;
  externalParams?: Record<string, number>;
  paramSeq?: number;
  reducedMotion?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const [spec, setSpec] = useState<PlotSpec | null>();
  const [failed, setFailed] = useState(false);
  const [containerWidth, setContainerWidth] = useState(0);
  const [palette, setPalette] = useState<string[]>([]);
  const [paramValues, setParamValues] = useState<Record<string, number>>({});
  const [playing, setPlaying] = useState(false);
  const [activeKeyframe, setActiveKeyframe] = useState<number>(-1);
  const externalParamsRef = useRef(externalParams);
  externalParamsRef.current = externalParams;

  useEffect(() => {
    let active = true;
    setSpec(undefined);
    setFailed(false);
    setPlaying(false);
    setActiveKeyframe(-1);
    void parsePlotSpec(source).then((value) => {
      if (!active) return;
      setSpec(value);
      setParamValues(buildInitialParams(value?.params, externalParamsRef.current));
    });
    return () => { active = false; };
  }, [source]);

  // Sync teacher-driven <board_param> updates immediately into interactive controls
  useEffect(() => {
    if (!spec?.params?.length || !externalParams) return;
    setPlaying(false);
    setActiveKeyframe(-1);
    setParamValues((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const param of spec.params ?? []) {
        const incoming = externalParams[param.name];
        if (typeof incoming === "number" && Number.isFinite(incoming)) {
          const clamped = clampParam(param, incoming);
          if (next[param.name] !== clamped) {
            next[param.name] = clamped;
            changed = true;
          }
        }
      }
      return changed ? next : prev;
    });
  }, [spec, externalParams, paramSeq]);

  // Keyframe demo animation (disabled under prefers-reduced-motion)
  useEffect(() => {
    if (!playing || reducedMotion || !spec?.keyframes?.length || !spec.params?.length) return;
    const frames = spec.keyframes;
    const params = spec.params;
    let index = activeKeyframe >= 0 ? activeKeyframe : 0;
    const applyFrame = (idx: number) => {
      const frame = frames[idx];
      if (!frame) return;
      setActiveKeyframe(idx);
      setParamValues((prev) => {
        const next = { ...prev };
        for (const param of params) {
          const val = frame.values[param.name];
          if (typeof val === "number") next[param.name] = clampParam(param, val);
        }
        return next;
      });
    };
    const timer = window.setInterval(() => {
      index = (index + 1) % frames.length;
      applyFrame(index);
    }, 1200);
    return () => window.clearInterval(timer);
  }, [playing, reducedMotion, spec, activeKeyframe]);

  const hasParams = Boolean(spec?.params?.length);
  const scopeKey = useMemo(() => JSON.stringify(paramValues), [paramValues]);

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
    const currentScope = hasParams ? { ...paramValues } : undefined;
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
            ...(currentScope ? { scope: currentScope } : {}),
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
  }, [spec, containerWidth, hasParams, scopeKey]);

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

  const params = spec.params ?? [];
  const keyframes = spec.keyframes ?? [];
  const isModified = params.some((param) => paramValues[param.name] !== param.default);

  function handleSliderChange(param: PlotParam, raw: string) {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return;
    setPlaying(false);
    setActiveKeyframe(-1);
    setParamValues((prev) => ({ ...prev, [param.name]: clampParam(param, parsed) }));
  }

  function handleApplyKeyframe(index: number) {
    const frame = keyframes[index];
    if (!frame) return;
    setPlaying(false);
    setActiveKeyframe(index);
    setParamValues((prev) => {
      const next = { ...prev };
      for (const param of params) {
        const val = frame.values[param.name];
        if (typeof val === "number") next[param.name] = clampParam(param, val);
      }
      return next;
    });
  }

  function handleReset() {
    setPlaying(false);
    setActiveKeyframe(-1);
    setParamValues(buildInitialParams(params));
  }

  return (
    <div ref={containerRef} className={styles.plot} data-testid="board-plot">
      <div ref={host} />
      {params.length > 0 ? (
        <div className={styles.plotControls} data-testid="plot-controls">
          <div className={styles.plotParamList}>
            {params.map((param) => {
              const current = paramValues[param.name] ?? param.default;
              return (
                <label key={param.name} className={styles.plotParamRow}>
                  <span className={styles.plotParamHeader}>
                    <span className={styles.plotParamLabel}>{param.label}</span>
                    <code
                      className={styles.plotParamValue}
                      data-testid={`plot-param-value-${param.name}`}
                    >
                      {param.name} = {formatParamNumber(current, param.step)}
                    </code>
                  </span>
                  <input
                    type="range"
                    className={styles.plotSlider}
                    aria-label={param.label}
                    data-testid={`plot-param-slider-${param.name}`}
                    min={param.min}
                    max={param.max}
                    step={param.step}
                    value={current}
                    onChange={(event) => handleSliderChange(param, event.target.value)}
                  />
                </label>
              );
            })}
          </div>
          {keyframes.length > 0 || isModified ? (
            <div className={styles.plotActions}>
              {keyframes.length > 0 ? (
                <div className={styles.plotKeyframes} data-testid="plot-keyframes">
                  {keyframes.map((frame, index) => (
                    <button
                      key={`${frame.label}-${index}`}
                      type="button"
                      className={styles.plotChip}
                      data-active={activeKeyframe === index ? "true" : undefined}
                      data-testid={`plot-keyframe-${index}`}
                      onClick={() => handleApplyKeyframe(index)}
                    >
                      {frame.label}
                    </button>
                  ))}
                  {!reducedMotion && keyframes.length > 1 ? (
                    <button
                      type="button"
                      className={styles.plotChip}
                      data-testid="plot-play-toggle"
                      aria-pressed={playing}
                      onClick={() => setPlaying((prev) => !prev)}
                    >
                      {playing ? pauseLabel : playLabel}
                    </button>
                  ) : null}
                </div>
              ) : null}
              {isModified ? (
                <button
                  type="button"
                  className={styles.plotResetBtn}
                  data-testid="plot-reset"
                  onClick={handleReset}
                >
                  {resetLabel}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
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
