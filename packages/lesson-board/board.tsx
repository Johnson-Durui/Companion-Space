"use client";

import { useId, useState, type ReactNode } from "react";
import type { components } from "@companion-space/api-client/schema";
import { LessonText, MathBlock } from "./math";
import styles from "./board.module.css";

type Schema = components["schemas"];
type BoardBase = Pick<Schema["BoardActionV2"], "id" | "title" | "citation_ids">;
type Action<K, P> = BoardBase & { kind: K; payload: P };
export type BoardAction =
  | Action<"concept_sheet", Schema["ConceptSheetPayload"]>
  | Action<"step_sandbox", Schema["StepSandboxPayload"]>
  | Action<"interactive_diagram", Schema["InteractiveDiagramPayload"]>
  | Action<"checkpoint_quiz", Schema["CheckpointQuizPayload"]>
  | Action<"laser_focus", Schema["LaserFocusPayload"]>;

export type BoardCitation = Schema["Citation"];
export type TeachingEvent = Schema["ClassroomEventRequest"];
type BoardFeedback = Schema["ClassroomFeedback"];

const kindLabel = {
  concept_sheet: "概念与公式", step_sandbox: "分步推演", interactive_diagram: "交互图谱", checkpoint_quiz: "随堂测验",
};

function Sandbox({ action, busy, dispatch }: { action: Extract<BoardAction, { kind: "step_sandbox" }>; busy: boolean; dispatch: (event: TeachingEvent) => void }) {
  const { steps, current_step, code, parameters, editable_parameters } = action.payload;
  const [historyStep, setHistoryStep] = useState<number | null>(null);
  const index = historyStep ?? current_step;
  const step = steps[index];
  const parameter = editable_parameters?.[0];
  const [valueDraft, setValueDraft] = useState<string | null>(null);
  const parameterValue = parameter ? parameters?.[parameter] : undefined;
  const input = valueDraft ?? String(parameterValue ?? "");
  const rawArray = parameters?.values;
  const array = typeof rawArray === "string" && /^\[[-,\s0-9]+\]$/.test(rawArray)
    ? rawArray.slice(1, -1).split(",").slice(0, 32).map(Number)
    : [];
  if (!step) return <p>当前没有推演步骤。</p>;
  return (
    <div className={styles.sandbox}>
      <div className={styles.sandboxHeader}><strong>{step.label}</strong><span>{index + 1} / {steps.length}</span></div>
      {parameter ? (
        <form className={styles.parameter} onSubmit={(event) => {
          event.preventDefault();
          const value = parameter === "target" ? Number(input) : input.trim();
          if (value === "" || (typeof value === "number" && !Number.isSafeInteger(value))) return;
          setHistoryStep(null);
          setValueDraft(null);
          dispatch({ type: "update_parameters", action_id: action.id, parameters: { [parameter]: value } });
        }}>
          <label>{parameter === "target" ? "查找目标" : "推演输入"}
            <input type={parameter === "target" ? "number" : "text"} value={input} maxLength={120} required onChange={(event) => setValueDraft(event.target.value)} />
          </label>
          <button type="submit" disabled={busy}>重新推演</button>
        </form>
      ) : null}
      {array.length ? (
        <div className={styles.array} aria-label="待查找数组">
          {array.map((value, arrayIndex) => (
            <button type="button" key={arrayIndex} aria-label={`索引 ${arrayIndex}，值 ${value}`} data-mid={arrayIndex === step.values.mid || undefined} disabled={busy}
              onClick={() => dispatch({ type: "ask", action_id: action.id, question: `当前步骤中，索引 ${arrayIndex} 的值 ${value} 是否还在搜索范围内？` })}>
              <span>{arrayIndex}</span><strong>{value}</strong>
            </button>
          ))}
        </div>
      ) : null}
      <div className={styles.variables} aria-label="推演变量">
        {Object.entries(step.values).map(([name, value]) => (
          <button type="button" key={name} disabled={busy} onClick={() => dispatch({ type: "ask", action_id: action.id, question: `在「${step.label}」中，为什么 ${name} = ${value}？` })}>
            <span>{name}</span><strong>{value}</strong>
          </button>
        ))}
      </div>
      <pre className={styles.code}><code>{code.split("\n").map((line, lineIndex) => <span key={lineIndex} data-current={step.active_line === lineIndex + 1 || undefined}>{line || " "}</span>)}</code></pre>
      <div className={styles.actions}>
        <button type="button" disabled={index === 0 || busy} onClick={() => setHistoryStep(index - 1)}>上一步</button>
        <button type="button" disabled={busy} onClick={() => {
          if (index < current_step) setHistoryStep(index + 1 === current_step ? null : index + 1);
          else dispatch({ type: "advance", action_id: action.id });
        }}>{index + 1 < steps.length ? "下一步" : "继续教学"}</button>
      </div>
    </div>
  );
}

export function CitationExcerpts({ citations }: { citations: BoardCitation[] }) {
  if (!citations.length) return null;
  return <div className={styles.sources}>{citations.map((citation) => (
    <details key={citation.chunk_id}>
      <summary>{citation.title} · {citation.locator}</summary>
      {citation.excerpt ? <blockquote>{citation.excerpt}</blockquote> : null}
    </details>
  ))}</div>;
}

export function InteractiveBoard({ actions, activeId, citations, feedback, busy, onEvent, onFocus, diagram, after }: {
  actions: BoardAction[];
  activeId: string | null;
  citations: BoardCitation[];
  feedback?: BoardFeedback | null;
  busy: boolean;
  onEvent: (event: TeachingEvent) => void;
  onFocus: (id: string) => void;
  diagram?: (source: string) => ReactNode;
  after?: ReactNode;
}) {
  const regionId = useId();
  const cards = actions.filter((action) => action.kind !== "laser_focus");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const action = cards.find((item) => item.id === (selectedId ?? activeId)) ?? cards.at(-1);
  if (!action) return null;
  const focus = [...actions].reverse().find((item) => item.kind === "laser_focus");
  const focused = focus?.kind === "laser_focus" && focus.payload.target_action_id === action.id;
  const sources = citations.filter((citation) => action.citation_ids?.includes(citation.chunk_id));
  const dispatch = (event: TeachingEvent) => { setSelectedId(null); onEvent(event); };
  return (
    <>
      <nav className={styles.tabs} aria-label="课堂板书">
        {cards.map((item) => (
          <button key={item.id} type="button" aria-controls={regionId} aria-pressed={item.id === action.id} disabled={busy} onClick={() => { setSelectedId(item.id); onFocus(item.id); }}>
            {kindLabel[item.kind]}
          </button>
        ))}
      </nav>
      <article id={regionId} className={styles.content} data-focused={focused || undefined} data-board-kind={action.kind}>
        <h3>{action.title}</h3>
        {action.kind === "concept_sheet" ? (
          <>
            {action.payload.sections.map((section, index) => (
              <section className={styles.concept} key={index}>
                <h4>{section.heading}</h4>
                <LessonText source={section.markdown} />
                {section.formula ? <MathBlock expression={section.formula} /> : null}
              </section>
            ))}
            <div className={styles.actions}><button type="button" disabled={busy || action.id !== activeId} onClick={() => dispatch({ type: "advance", action_id: action.id })}>进入推演</button></div>
          </>
        ) : null}
        {action.kind === "step_sandbox" ? <Sandbox key={action.id} action={action} busy={busy || action.id !== activeId} dispatch={dispatch} /> : null}
        {action.kind === "interactive_diagram" ? (
          <>
            <ol className={styles.nodes} aria-label="可追问的图谱节点">
              {action.payload.nodes.map((node) => {
                const branches = (action.payload.edges ?? []).filter((edge) => edge.from_id === node.id);
                return (
                  <li key={node.id}>
                    <button type="button" disabled={busy} onClick={() => dispatch({ type: "ask", action_id: action.id, question: node.question })}>{node.label}</button>
                    {branches.map((edge) => (
                      <span key={edge.to_id}>→ {edge.label ? `${edge.label} · ` : ""}{action.payload.nodes.find((item) => item.id === edge.to_id)?.label}</span>
                    ))}
                  </li>
                );
              })}
            </ol>
            {diagram && action.payload.mermaid ? <details><summary>查看 Mermaid 原图</summary>{diagram(action.payload.mermaid)}</details> : null}
            <div className={styles.actions}><button type="button" disabled={busy || action.id !== activeId} onClick={() => dispatch({ type: "advance", action_id: action.id })}>进入随堂测验</button></div>
          </>
        ) : null}
        {action.kind === "checkpoint_quiz" ? (
          <>
            <p>{action.payload.question}</p>
            <div className={styles.options} aria-label="随堂测验答案">
              {action.payload.options.map((option) => (
                <button type="button" key={option.id} disabled={busy || action.id !== activeId} onClick={() => dispatch({ type: "quiz_answer", action_id: action.id, answer_id: option.id })}>{option.label}</button>
              ))}
            </div>
          </>
        ) : null}
        {feedback ? <p className={styles.feedback} role="status" data-correct={feedback.correct ?? undefined}>{feedback.message}</p> : null}
        <CitationExcerpts citations={sources} />
        {after}
      </article>
    </>
  );
}
