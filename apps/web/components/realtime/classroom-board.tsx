"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { InteractiveBoard, type BoardAction } from "@companion-space/lesson-board";
import { MermaidBoard } from "@/components/lesson/lesson-board";
import type { useClassroomBoard } from "./use-classroom-board";
import styles from "./classroom-board.module.css";

export function ClassroomBoard({ classroom, defaultTopic, disabled, spaceId, liveBoard }: {
  classroom: ReturnType<typeof useClassroomBoard>;
  defaultTopic: string;
  disabled: boolean;
  spaceId: string;
  liveBoard?: ReactNode;
}) {
  const [topic, setTopic] = useState<string | null>(null);
  const [question, setQuestion] = useState("");
  const activeTopic = topic ?? defaultTopic;
  const { snapshot, busy, error, notice } = classroom;
  const isReview = snapshot?.phase === "review";
  return (
    <section className={styles.board} aria-labelledby="classroom-board-title" aria-busy={busy || disabled}>
      <header className={styles.header}>
        <div>
          <h2 id="classroom-board-title">互动黑板</h2>
          {snapshot ? <p>{snapshot.topic}</p> : null}
        </div>
        {snapshot?.tutor.narration ? (
          <button className="ghost-button" type="button" disabled={busy} onClick={() => void classroom.toggleNarration()}>
            {classroom.narrating ? "停止播报" : "播报当前步骤"}
          </button>
        ) : null}
      </header>
      {error ? <p className="error-callout" role="alert">{error}</p> : null}
      {snapshot ? (
        <>
          <InteractiveBoard
            actions={snapshot.board_actions as BoardAction[]}
            activeId={snapshot.active_action_id}
            citations={snapshot.citations ?? []}
            feedback={snapshot.feedback}
            busy={busy}
            onEvent={(event) => { if (!disabled) void classroom.event(event); }}
            onFocus={classroom.pointAt}
            diagram={(source) => <MermaidBoard source={source} compact />}
          />
          <form className={styles.question} onSubmit={(event) => {
            event.preventDefault();
            if (!question.trim()) return;
            void classroom.event({ type: "ask", question: question.trim(), action_id: snapshot.active_action_id });
            setQuestion("");
          }}>
            <label>
              <span>针对当前板书追问</span>
              <input value={question} onChange={(event) => setQuestion(event.target.value)} maxLength={600} />
            </label>
            <button className="ghost-button" type="submit" disabled={busy || disabled || !question.trim()}>打断并追问</button>
          </form>
          {isReview ? (
            <div className={styles.review}>
              <button className="primary-button" type="button" disabled={busy} onClick={() => void classroom.saveFlashcards()}>提炼复习闪卡</button>
              <Link className="ghost-button" href={`/review-items?spaceId=${encodeURIComponent(spaceId)}`}>打开记忆复盘</Link>
            </div>
          ) : null}
        </>
      ) : (
        <div className={styles.ready}>
          {liveBoard}
          <form className={styles.question} onSubmit={(event) => {
            event.preventDefault();
            if (activeTopic.trim()) void classroom.start(activeTopic.trim());
          }}>
            <label>
              <span>想学习的主题</span>
              <input value={activeTopic} onChange={(event) => setTopic(event.target.value)} maxLength={240} required placeholder="例如 二分查找的边界条件" />
            </label>
            <button className="primary-button" type="submit" disabled={disabled || busy || !activeTopic.trim()}>
              {busy ? "正在准备板书…" : "开始互动课堂"}
            </button>
          </form>
        </div>
      )}
      {notice ? <p role="status">{notice}</p> : null}
    </section>
  );
}
