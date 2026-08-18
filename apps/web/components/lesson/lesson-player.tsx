"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { CitationList } from "@/components/citation-list";
import { LessonBoard } from "@/components/lesson/lesson-board";
import type { DemoNarrationResult } from "@/components/realtime/use-realtime-session";
import type { BoardAction, SessionDemoResponseWire } from "@/lib/types";
import styles from "@/components/lesson/lesson-player.module.css";

interface LessonPlayerProps {
  canRequestDemo: boolean;
  characterId: string | null;
  demo: SessionDemoResponseWire | null;
  demoAudioStopToken: number;
  demoError: string | null;
  isDemoLoading: boolean;
  onAskQuestion: (question: string) => Promise<boolean>;
  onClearDemo: () => Promise<void>;
  onPlayNarration: (input: {
    characterId: string;
    text: string;
    voiceId?: string;
    speakingRate?: number;
  }) => Promise<DemoNarrationResult>;
  onRequestDemo: (topic: string) => Promise<boolean>;
  onStopNarration: () => Promise<void>;
  requestHint: string;
  speakingRate?: number;
  voiceId?: string;
}

function findPreviousBoard(
  demo: SessionDemoResponseWire | null,
  currentStepIndex: number,
): BoardAction | null {
  if (!demo) {
    return null;
  }
  for (let index = currentStepIndex - 1; index >= 0; index -= 1) {
    const board = demo.script.steps[index]?.board;
    if (board && board.kind !== "highlight") {
      return board;
    }
  }
  return null;
}

export function LessonPlayer({
  canRequestDemo,
  characterId,
  demo,
  demoAudioStopToken,
  demoError,
  isDemoLoading,
  onAskQuestion,
  onClearDemo,
  onPlayNarration,
  onRequestDemo,
  onStopNarration,
  requestHint,
  speakingRate,
  voiceId,
}: LessonPlayerProps) {
  const [topic, setTopic] = useState("");
  const [question, setQuestion] = useState("");
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [isNarrating, setIsNarrating] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const ignoreNextStopTokenRef = useRef(false);
  const previousStopTokenRef = useRef(demoAudioStopToken);

  useEffect(() => {
    setCurrentStepIndex(0);
    setIsNarrating(false);
    setIsPlaying(false);
    setLocalError(null);
  }, [demo]);

  useEffect(() => {
    if (previousStopTokenRef.current === demoAudioStopToken) {
      return;
    }
    previousStopTokenRef.current = demoAudioStopToken;
    if (ignoreNextStopTokenRef.current) {
      ignoreNextStopTokenRef.current = false;
      return;
    }
    setIsNarrating(false);
    setIsPlaying(false);
  }, [demoAudioStopToken]);

  const totalSteps = demo?.script.steps.length ?? 0;
  const currentStep = demo?.script.steps[currentStepIndex] ?? null;
  const progressPercent =
    totalSteps > 0 ? ((currentStepIndex + 1) / totalSteps) * 100 : 0;
  const previousBoard = useMemo(
    () => findPreviousBoard(demo, currentStepIndex),
    [currentStepIndex, demo],
  );

  useEffect(() => {
    if (!isPlaying || !currentStep || isNarrating) {
      return;
    }
    if (!characterId) {
      setLocalError("当前会话没有可用角色，暂时无法为这段演示配音。");
      setIsPlaying(false);
      return;
    }

    const narration = currentStep.narration.trim();
    if (!narration) {
      if (currentStepIndex < totalSteps - 1) {
        setCurrentStepIndex((index) => index + 1);
      } else {
        setIsPlaying(false);
      }
      return;
    }

    let active = true;
    setIsNarrating(true);
    setLocalError(null);
    void onPlayNarration({
      characterId,
      text: narration,
      voiceId,
      speakingRate,
    })
      .then((result) => {
        if (!active) {
          return;
        }
        setIsNarrating(false);
        if (result !== "completed") {
          setIsPlaying(false);
          return;
        }
        if (currentStepIndex < totalSteps - 1) {
          setCurrentStepIndex((index) => index + 1);
          return;
        }
        setIsPlaying(false);
      })
      .catch((playbackError) => {
        if (!active) {
          return;
        }
        setIsNarrating(false);
        setIsPlaying(false);
        setLocalError(
          playbackError instanceof Error ? playbackError.message : "演示配音播放失败",
        );
      });

    return () => {
      active = false;
    };
  }, [
    characterId,
    currentStep,
    currentStepIndex,
    isNarrating,
    isPlaying,
    onPlayNarration,
    speakingRate,
    totalSteps,
    voiceId,
  ]);

  async function handleRequestDemo() {
    if (!canRequestDemo) {
      return;
    }
    setLocalError(null);
    setIsPlaying(false);
    ignoreNextStopTokenRef.current = true;
    await onStopNarration();
    const ok = await onRequestDemo(topic);
    if (!ok) {
      return;
    }
    setQuestion("");
  }

  async function handlePause() {
    setIsPlaying(false);
    setIsNarrating(false);
    ignoreNextStopTokenRef.current = true;
    await onStopNarration();
  }

  async function handleReplay() {
    ignoreNextStopTokenRef.current = true;
    await onStopNarration();
    setCurrentStepIndex(0);
    setIsPlaying(true);
    setLocalError(null);
  }

  async function handleStepChange(nextIndex: number) {
    ignoreNextStopTokenRef.current = true;
    await onStopNarration();
    setCurrentStepIndex(nextIndex);
    setIsPlaying(false);
    setIsNarrating(false);
    setLocalError(null);
  }

  async function handleAskQuestion() {
    const trimmed = question.trim();
    if (!trimmed) {
      return;
    }
    setIsPlaying(false);
    setIsNarrating(false);
    ignoreNextStopTokenRef.current = true;
    await onStopNarration();
    const sent = await onAskQuestion(trimmed);
    if (sent) {
      setQuestion("");
    }
  }

  return (
    <div className={styles.player}>
      <div className={styles.requestCard}>
        <div className={styles.requestHeader}>
          <div>
            <p className="eyebrow">Lesson Demo</p>
            <h3>分步演示</h3>
          </div>
          {demo ? (
            <button
              type="button"
              className={styles.ghostButton}
              onClick={() => void onClearDemo()}
            >
              清空脚本
            </button>
          ) : null}
        </div>
        <label className={styles.field}>
          <span>演示主题</span>
          <textarea
            rows={3}
            value={topic}
            onChange={(event) => setTopic(event.target.value)}
            placeholder="输入一个你想看懂的主题，比如：为什么二分查找要求区间单调。"
          />
        </label>
        <div className={styles.requestActions}>
          <button
            type="button"
            className={styles.primaryButton}
            disabled={!canRequestDemo || isDemoLoading || !topic.trim()}
            onClick={() => void handleRequestDemo()}
          >
            {isDemoLoading ? "生成中…" : "演示一下"}
          </button>
          <p className={styles.helperText}>{requestHint}</p>
        </div>
        {demoError ? <p className={styles.errorText}>{demoError}</p> : null}
      </div>

      {demo ? (
        <div className={styles.scriptCard}>
          <div className={styles.scriptHeader}>
            <div>
              <p className="eyebrow">Script Ready</p>
              <h3>{demo.script.title}</h3>
              <p className={styles.scriptMeta}>
                {demo.used_space_materials
                  ? `主题：${demo.topic} · 已引用空间资料`
                  : `主题：${demo.topic} · 本轮未使用空间资料`}
              </p>
            </div>
            <div className={styles.badges}>
              <span className={styles.badge}>步骤 {currentStepIndex + 1}/{totalSteps}</span>
              {isNarrating ? <span className={styles.badge}>配音中</span> : null}
            </div>
          </div>

          <div className={styles.progressTrack}>
            <div className={styles.progressFill} style={{ width: `${progressPercent}%` }} />
          </div>

          <LessonBoard action={currentStep?.board ?? null} baseAction={previousBoard} />

          {currentStep ? (
            <div className={styles.captionCard}>
              <h4>当前步骤</h4>
              <p>{currentStep.caption}</p>
              <p className={styles.narrationText}>{currentStep.narration}</p>
            </div>
          ) : null}

          <div className={styles.transport}>
            <button
              type="button"
              className={styles.secondaryButton}
              disabled={!demo || !canRequestDemo || currentStepIndex === 0}
              onClick={() => void handleStepChange(Math.max(0, currentStepIndex - 1))}
            >
              上一步
            </button>
            <button
              type="button"
              className={styles.primaryButton}
              disabled={!demo || !canRequestDemo || totalSteps === 0}
              onClick={() => {
                setLocalError(null);
                if (isPlaying) {
                  void handlePause();
                  return;
                }
                setIsPlaying(true);
              }}
            >
              {isPlaying ? "暂停" : "播放"}
            </button>
            <button
              type="button"
              className={styles.secondaryButton}
              disabled={!demo || !canRequestDemo || totalSteps === 0}
              onClick={() => void handleReplay()}
            >
              重播
            </button>
            <button
              type="button"
              className={styles.secondaryButton}
              disabled={
                !demo ||
                !canRequestDemo ||
                currentStepIndex >= totalSteps - 1
              }
              onClick={() =>
                void handleStepChange(Math.min(totalSteps - 1, currentStepIndex + 1))
              }
            >
              下一步
            </button>
          </div>

          <label className={styles.field}>
            <span>播放中提问</span>
            <textarea
              rows={2}
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              placeholder="这里的问题会先停止讲解，再作为文本消息发出去。"
            />
          </label>
          <div className={styles.requestActions}>
            <button
              type="button"
              className={styles.secondaryButton}
              disabled={!canRequestDemo || !question.trim()}
              onClick={() => void handleAskQuestion()}
            >
              停止并提问
            </button>
          </div>

          {localError ? <p className={styles.errorText}>{localError}</p> : null}

          <div className={styles.citationCard}>
            <div className={styles.citationHeader}>
              <h4>演示引用</h4>
              <span>{demo.citations.length} 条</span>
            </div>
            <CitationList citations={demo.citations} />
          </div>
        </div>
      ) : (
        <div className={styles.emptyCard}>
          <p className={styles.helperText}>
            现在还没有分步演示。先创建当前对话，再输入主题，或在通话里直接说“演示一下”。
          </p>
        </div>
      )}
    </div>
  );
}
