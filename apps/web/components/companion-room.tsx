"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { getBuiltinPortraitDefinition } from "@/components/avatar/portrait-registry";
import { ApiError, createSpace, listCharacters, listSessions, listSpaces } from "@/lib/api";
import type { CharacterPackSummary, SessionSummary, StudySpaceSummary } from "@/lib/types";

import styles from "./companion-room.module.css";

const SCENE_PREFERENCE_KEY = "companion-space:room-scene:v1";
const FOCUS_DURATIONS = [15, 25, 45] as const;

type SceneMode = "warm" | "twilight";

function timestamp(value: string | null | undefined) {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function latestSession(sessions: SessionSummary[], spaceId: string) {
  return sessions
    .filter((session) => session.space_id === spaceId && session.state !== "closed")
    .slice()
    .sort((left, right) => timestamp(right.updated_at) - timestamp(left.updated_at))[0];
}

function formatCountdown(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function FocusTimer() {
  const [durationMinutes, setDurationMinutes] = useState<(typeof FOCUS_DURATIONS)[number]>(25);
  const [remainingMs, setRemainingMs] = useState(25 * 60_000);
  const [deadline, setDeadline] = useState<number | null>(null);
  const running = deadline !== null;
  const completed = remainingMs <= 0;

  useEffect(() => {
    if (deadline === null) {
      return;
    }

    let timeout: number | undefined;
    const sync = () => {
      const next = Math.max(0, deadline - Date.now());
      setRemainingMs(next);
      if (next === 0) {
        setDeadline(null);
      } else {
        timeout = window.setTimeout(sync, next % 1000 || 1000);
      }
    };

    sync();
    return () => window.clearTimeout(timeout);
  }, [deadline]);

  function chooseDuration(minutes: (typeof FOCUS_DURATIONS)[number]) {
    setDurationMinutes(minutes);
    setRemainingMs(minutes * 60_000);
    setDeadline(null);
  }

  function start() {
    const nextRemaining = completed ? durationMinutes * 60_000 : remainingMs;
    setRemainingMs(nextRemaining);
    setDeadline(Date.now() + nextRemaining);
  }

  function pause() {
    if (deadline === null) {
      return;
    }
    setRemainingMs(Math.max(0, deadline - Date.now()));
    setDeadline(null);
  }

  function reset() {
    setDeadline(null);
    setRemainingMs(durationMinutes * 60_000);
  }

  return (
    <section className={styles.focusCard} aria-labelledby="room-focus-title">
      <div>
        <h2 id="room-focus-title">专注计时</h2>
      </div>
      <output className={styles.timerValue} aria-label="专注倒计时" aria-live="off">
        {formatCountdown(remainingMs)}
      </output>
      <div className={styles.durationOptions} aria-label="选择专注时长">
        {FOCUS_DURATIONS.map((minutes) => (
          <button
            className={durationMinutes === minutes ? styles.durationActive : undefined}
            key={minutes}
            type="button"
            aria-pressed={durationMinutes === minutes}
            onClick={() => chooseDuration(minutes)}
          >
            {minutes} 分钟
          </button>
        ))}
      </div>
      <div className={styles.timerActions}>
        <button type="button" className={styles.timerPrimary} onClick={running ? pause : start}>
          {running ? "暂停专注" : completed ? "再来一轮" : "开始专注"}
        </button>
        <button type="button" onClick={reset}>重置</button>
      </div>
      <p className={styles.timerNote} role="status">
        {completed ? "这一轮结束了。伸个懒腰，再决定下一步。" : "请留在当前页面保持专注；离开或刷新页面会重置倒计时。"}
      </p>
    </section>
  );
}

export function CompanionRoom() {
  const router = useRouter();
  const sceneRef = useRef<HTMLDivElement | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const loadGenerationRef = useRef(0);
  const sessionGenerationRef = useRef(0);
  const selectedSpaceIdRef = useRef("");
  const [spaces, setSpaces] = useState<StudySpaceSummary[]>([]);
  const [characters, setCharacters] = useState<CharacterPackSummary[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selectedSpaceId, setSelectedSpaceId] = useState("");
  const [loading, setLoading] = useState(true);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionReload, setSessionReload] = useState(0);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);
  const [sceneMode, setSceneModeState] = useState<SceneMode>("warm");
  const [preferenceNotice, setPreferenceNotice] = useState<string | null>(null);
  const [parallaxEnabled, setParallaxEnabled] = useState(false);

  const loadRoom = useCallback(async () => {
    const generation = ++loadGenerationRef.current;
    sessionGenerationRef.current += 1;
    setLoading(true);
    setSessions([]);
    setSessionsLoading(false);
    try {
      const [nextSpaces, nextCharacters] = await Promise.all([listSpaces(), listCharacters()]);
      if (generation !== loadGenerationRef.current) {
        return;
      }
      const currentSelectedSpaceId = selectedSpaceIdRef.current;
      const nextSelectedSpaceId = nextSpaces.some((space) => space.id === currentSelectedSpaceId)
        ? currentSelectedSpaceId
        : nextSpaces.slice().sort((left, right) => timestamp(right.updated_at) - timestamp(left.updated_at))[0]?.id ?? "";
      setSpaces(nextSpaces);
      setCharacters(nextCharacters);
      setSessionsLoading(Boolean(nextSelectedSpaceId));
      selectedSpaceIdRef.current = nextSelectedSpaceId;
      setSelectedSpaceId(nextSelectedSpaceId);
      setSessionReload((current) => current + 1);
      setLocked(false);
      setError(null);
    } catch (loadError) {
      if (generation !== loadGenerationRef.current) {
        return;
      }
      setSpaces([]);
      setCharacters([]);
      setSessions([]);
      const needsVault = loadError instanceof ApiError && loadError.status === 401;
      setLocked(needsVault);
      setError(needsVault ? null : loadError instanceof Error ? loadError.message : "互动书房加载失败");
    } finally {
      if (generation === loadGenerationRef.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void loadRoom();
    return () => {
      loadGenerationRef.current += 1;
    };
  }, [loadRoom]);

  useEffect(() => {
    const generation = ++sessionGenerationRef.current;
    if (!selectedSpaceId) {
      setSessions([]);
      setSessionsLoading(false);
      return;
    }

    setSessions([]);
    setSessionsLoading(true);
    void listSessions(selectedSpaceId)
      .then((nextSessions) => {
        if (generation !== sessionGenerationRef.current) {
          return;
        }
        setSessions(nextSessions);
      })
      .catch((sessionError) => {
        if (generation !== sessionGenerationRef.current) {
          return;
        }
        const needsVault = sessionError instanceof ApiError && sessionError.status === 401;
        setLocked(needsVault);
        setError(needsVault ? null : sessionError instanceof Error ? sessionError.message : "互动书房加载失败");
      })
      .finally(() => {
        if (generation === sessionGenerationRef.current) {
          setSessionsLoading(false);
        }
      });
  }, [selectedSpaceId, sessionReload]);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(SCENE_PREFERENCE_KEY);
      if (!raw) {
        return;
      }
      const saved = JSON.parse(raw) as { version?: unknown; mode?: unknown };
      if (saved.version === 1 && (saved.mode === "warm" || saved.mode === "twilight")) {
        setSceneModeState(saved.mode);
      }
    } catch {
      setPreferenceNotice("当前浏览器无法读取书房外观偏好，本次仍可正常使用。");
    }
  }, []);

  const resetParallax = useCallback(() => {
    if (animationFrameRef.current !== null) {
      window.cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    sceneRef.current?.style.setProperty("--room-shift-x", "0px");
    sceneRef.current?.style.setProperty("--room-shift-y", "0px");
  }, []);

  useEffect(() => {
    const finePointer = window.matchMedia("(pointer: fine)");
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => {
      const enabled = finePointer.matches && !reducedMotion.matches;
      setParallaxEnabled(enabled);
      if (!enabled) {
        resetParallax();
      }
    };
    sync();
    finePointer.addEventListener("change", sync);
    reducedMotion.addEventListener("change", sync);
    return () => {
      finePointer.removeEventListener("change", sync);
      reducedMotion.removeEventListener("change", sync);
      resetParallax();
    };
  }, [resetParallax]);

  const selectedSpace = spaces.find((space) => space.id === selectedSpaceId) ?? null;
  const activeSession = selectedSpace
    ? latestSession(sessions, selectedSpace.id)
    : undefined;
  const characterId = activeSession?.character_pack_id ?? selectedSpace?.default_character_id;
  const companion = characters.find((character) => character.id === characterId)
    ?? characters[0]
    ?? null;
  const portrait = companion && !companion.has_custom_avatar_asset
    ? getBuiltinPortraitDefinition(companion.avatar_model ?? "")
      ?? getBuiltinPortraitDefinition(`${companion.avatar_model ?? ""}_2d`)
    : null;

  const callHref = selectedSpace
    ? `/spaces/${selectedSpace.id}/call?${activeSession ? `session=${encodeURIComponent(activeSession.id)}&` : ""}view=immersive`
    : "";

  const companionMessage = selectedSpace
    ? activeSession
      ? `“${selectedSpace.title}”还停在上次的位置。准备好，我们就接着走。`
      : `“${selectedSpace.title}”的桌面已经整理好了，第一句话由你来写。`
    : "先建一个学习空间，我会替你把主题、资料和每次回顾收在一起。";

  function setSceneMode(mode: SceneMode) {
    setSceneModeState(mode);
    try {
      window.localStorage.setItem(SCENE_PREFERENCE_KEY, JSON.stringify({ version: 1, mode }));
      setPreferenceNotice(null);
    } catch {
      setPreferenceNotice("外观已在本次页面切换，但浏览器没有保存这项偏好。");
    }
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (!parallaxEnabled || !sceneRef.current) {
      return;
    }
    const bounds = sceneRef.current.getBoundingClientRect();
    const x = ((event.clientX - bounds.left) / bounds.width - 0.5) * 2;
    const y = ((event.clientY - bounds.top) / bounds.height - 0.5) * 2;
    if (animationFrameRef.current !== null) {
      window.cancelAnimationFrame(animationFrameRef.current);
    }
    animationFrameRef.current = window.requestAnimationFrame(() => {
      animationFrameRef.current = null;
      sceneRef.current?.style.setProperty("--room-shift-x", `${x * -7}px`);
      sceneRef.current?.style.setProperty("--room-shift-y", `${y * -5}px`);
    });
  }

  async function createFirstSpace() {
    if (creating) {
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const space = await createSpace({
        name: "我的陪伴空间",
        topic: "自由陪伴",
        goal: "从一段安静的共学开始",
      });
      router.push(`/spaces/${space.id}/call?view=immersive`);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "学习空间创建失败");
      setCreating(false);
    }
  }

  const status = useMemo(() => {
    if (loading) return "正在点亮书房…";
    if (locked) return "本地保险箱还没有解锁";
    if (error) return "书房暂时没有准备好";
    if (sessionsLoading && selectedSpace) return `正在准备“${selectedSpace.title}”的共学…`;
    return selectedSpace ? `共学记录 ${sessions.length} 次` : "还没有学习空间";
  }, [error, loading, locked, selectedSpace, sessions.length, sessionsLoading]);

  return (
    <section className={styles.page}>
      <header className={styles.topline}>
        <div>
          <p className={styles.kicker}>互动书房</p>
          <h1>今晚，想从哪一页继续？</h1>
          <p>{status}</p>
        </div>
        <div className={styles.sceneSwitch} aria-label="书房光线">
          <button type="button" aria-pressed={sceneMode === "warm"} onClick={() => setSceneMode("warm")}>暖灯</button>
          <button type="button" aria-pressed={sceneMode === "twilight"} onClick={() => setSceneMode("twilight")}>暮色</button>
        </div>
      </header>

      {preferenceNotice ? <p className={styles.preferenceNotice} role="status">{preferenceNotice}</p> : null}
      {error ? (
        <div className={styles.alert} role="alert">
          <div><strong>没能打开互动书房</strong><p>{error}</p></div>
          <button type="button" disabled={loading} onClick={() => void loadRoom()}>
            {loading ? "正在重试…" : "重试"}
          </button>
        </div>
      ) : null}

      {locked ? (
        <div className={styles.lockedState}>
          <span aria-hidden="true">✦</span>
          <div><h2>先打开本地保险箱</h2><p>解锁后，书房才能读取你的空间、角色和会话。</p></div>
          <Link href="/vault">前往解锁</Link>
        </div>
      ) : error ? null : (
        <>
          <div
            ref={sceneRef}
            data-room-scene
            data-parallax-enabled={parallaxEnabled ? "true" : "false"}
            className={`${styles.roomScene} ${sceneMode === "twilight" ? styles.twilight : styles.warm}`}
            onPointerMove={handlePointerMove}
            onPointerLeave={resetParallax}
          >
            <div className={styles.roomBackground} aria-hidden="true" />
            <div className={styles.roomVignette} aria-hidden="true" />

            <div className={styles.sceneCopy}>
              <h2>{selectedSpace?.title ?? (loading ? "正在整理桌面" : "一间等你命名的书房")}</h2>
              <p>{selectedSpace?.goal || selectedSpace?.theme || "把今天最想弄懂的一件事留在这里。"}</p>

              {spaces.length ? (
                <label className={styles.spacePicker}>
                  <span>选择学习空间</span>
                  <select
                    value={selectedSpaceId}
                    onChange={(event) => {
                      selectedSpaceIdRef.current = event.target.value;
                      setSelectedSpaceId(event.target.value);
                    }}
                    aria-label="选择学习空间"
                  >
                    {spaces.map((space) => <option key={space.id} value={space.id}>{space.title}</option>)}
                  </select>
                </label>
              ) : null}

              {selectedSpace && sessionsLoading ? (
                <span className={styles.continueButton} role="status">正在准备这次共学…</span>
              ) : selectedSpace ? (
                <Link
                  className={styles.continueButton}
                  href={callHref}
                  aria-label={`${activeSession ? "继续" : "开始"}${selectedSpace.title}的共学`}
                >
                  <span>{activeSession ? "继续上次共学" : "开始这次共学"}</span><span aria-hidden="true">→</span>
                </Link>
              ) : !loading ? (
                <button className={styles.continueButton} type="button" disabled={creating} onClick={() => void createFirstSpace()}>
                  <span>{creating ? "正在整理书房…" : "创建第一个学习空间"}</span><span aria-hidden="true">→</span>
                </button>
              ) : null}
            </div>

            <div className={styles.companionPresence}>
              {portrait ? (
                <div className={styles.companionPortrait} aria-hidden="true">
                  <Image src={portrait.assetUrl} alt="" fill sizes="(max-width: 760px) 26vw, 30vw" style={{ objectPosition: portrait.objectPosition }} />
                </div>
              ) : null}
              <aside className={styles.companionNote} aria-live="polite">
                <p>{companion?.name ?? "你的学习伙伴"}</p>
                <blockquote>{companionMessage}</blockquote>
              </aside>
            </div>

            <nav className={styles.roomShortcuts} aria-label="书房快捷入口">
              {selectedSpace ? (
                <Link href={`/spaces/${selectedSpace.id}`} className={styles.hotspot} aria-label={`查看${selectedSpace.title}的资料`}>
                  <span aria-hidden="true">▤</span><strong>资料书架</strong><small>整理主题与资料</small>
                </Link>
              ) : null}
              <Link href="/characters" className={styles.hotspot} aria-label="挑选学习伙伴">
                <span aria-hidden="true">✦</span><strong>换位伙伴</strong><small>{companion?.name ?? "挑选同行者"}</small>
              </Link>
              <Link href="/sessions" className={styles.hotspot} aria-label="打开会话回忆">
                <span aria-hidden="true">⌁</span><strong>回忆便签</strong><small>翻看共学轨迹</small>
              </Link>
            </nav>
          </div>

          <div className={styles.afterScene}>
            <FocusTimer />
            <section className={styles.roomGuide} aria-labelledby="room-guide-title">
              <h2 id="room-guide-title">学习记录</h2>
              <div>
                <Link href="/review-items"><strong>复习任务</strong><span>回顾会话整理出的练习</span></Link>
                <Link href="/memory"><strong>记忆抽屉</strong><span>确认长期记忆</span></Link>
              </div>
            </section>
          </div>
        </>
      )}
    </section>
  );
}
