"use client";

import { useEffect, useRef, useState } from "react";
import type { AvatarBoardFocus, AvatarTeachingFeedback } from "@companion-space/avatar-engine/teaching-cue";
import {
  getClassroom, proposeFlashcards, sendClassroomEvent, startClassroom,
  type ClassroomEvent, type ClassroomSnapshot,
} from "@/lib/classroom-api";

interface ClassroomBinding {
  spaceId: string;
  sessionId: string | null;
  canInterrupt: boolean;
  ensureSession: () => Promise<string | null>;
  interrupt: (context: { boardActionId: string; prompt: string }) => boolean;
  narrate: (text: string) => Promise<unknown>;
  stopNarration: () => Promise<unknown>;
}

export function useClassroomBoard(binding: ClassroomBinding) {
  const { spaceId, sessionId } = binding;
  const [stored, setStored] = useState<ClassroomSnapshot | null>(null);
  const [focus, setFocus] = useState<AvatarBoardFocus | null>(null);
  const [feedback, setFeedback] = useState<AvatarTeachingFeedback | null>(null);
  const [busy, setBusy] = useState(false);
  const [narrating, setNarrating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const pending = useRef(false);
  const generation = useRef(0);
  const audioGeneration = useRef(0);
  const feedbackSequence = useRef(0);
  const snapshot = stored?.space_id === spaceId && stored?.session_id === sessionId ? stored : null;

  useEffect(() => {
    const load = new AbortController();
    if (sessionId) {
      void getClassroom(sessionId, load.signal).then((data) => {
        if (load.signal.aborted || !data || data.space_id !== spaceId || data.session_id !== sessionId) return;
        setStored((current) => current?.session_id === sessionId ? current : data);
        setFocus({ id: data.active_action_id, x: 0.8, y: 0.12 });
      }).catch((cause: unknown) => {
        if (!load.signal.aborted) setError(cause instanceof Error ? cause.message : "恢复课堂失败");
      });
    }
    return () => load.abort();
  }, [spaceId, sessionId]);

  useEffect(() => () => { generation.current += 1; audioGeneration.current += 1; }, [spaceId]);

  function pointAt(id: string) {
    setFocus({ id, x: 0.8, y: 0.12 });
  }

  async function run(work: () => Promise<void>) {
    if (pending.current) return;
    const current = generation.current;
    pending.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await work();
    } catch (cause) {
      if (generation.current === current) setError(cause instanceof Error ? cause.message : "课堂操作失败");
    } finally {
      pending.current = false;
      if (generation.current === current) setBusy(false);
    }
  }

  function accept(data: ClassroomSnapshot, id: string) {
    if (data.space_id !== spaceId || data.session_id !== id) throw new Error("课堂数据与当前空间不匹配");
    setStored(data);
    pointAt(data.active_action_id);
    const kind = data.feedback?.kind;
    if (kind === "correct" || kind === "correction" || kind === "answer" || kind === "instruction") {
      setFeedback({ kind: kind === "correct" ? "correct" : kind === "correction" ? "retry" : "explain", sequence: ++feedbackSequence.current });
    }
  }

  async function start(topic: string) {
    await run(async () => {
      const id = sessionId ?? await binding.ensureSession();
      if (!id) throw new Error("无法创建课堂，请检查空间和保险箱状态。");
      accept(await startClassroom(id, topic), id);
    });
  }

  async function event(input: ClassroomEvent) {
    if (!sessionId || !snapshot) return;
    const id = sessionId;
    await run(async () => {
      if (binding.canInterrupt && (input.type === "ask" || input.type === "interrupt")) {
        binding.interrupt({ boardActionId: input.action_id ?? snapshot.active_action_id, prompt: input.question ?? "请暂停当前讲解" });
      }
      await binding.stopNarration();
      accept(await sendClassroomEvent(id, input), id);
    });
  }

  async function toggleNarration() {
    if (!snapshot?.tutor.narration) return;
    const current = ++audioGeneration.current;
    setError(null);
    try {
      if (narrating) {
        await binding.stopNarration();
      } else {
        setNarrating(true);
        await binding.narrate(snapshot.tutor.narration);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "课堂播报失败");
    } finally {
      if (audioGeneration.current === current) setNarrating(false);
    }
  }

  async function saveFlashcards() {
    if (!sessionId) return;
    await run(async () => {
      const cards = await proposeFlashcards(sessionId);
      setNotice(cards.length ? `已提炼 ${cards.length} 张复习卡，打开「记忆复盘」确认。` : "当前课堂还没有可提炼的内容。");
    });
  }

  return { snapshot, focus, feedback, busy, narrating, error, notice, pointAt, start, event, toggleNarration, saveFlashcards };
}
