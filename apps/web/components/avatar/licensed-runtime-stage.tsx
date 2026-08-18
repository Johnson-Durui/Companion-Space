"use client";

import { useCallback, useEffect, useRef } from "react";

import type { CharacterLicensedRuntimeAssets } from "@/components/avatar/character-runtime-assets";
import type { AvatarSpeechController } from "@/components/avatar/vrm-speech-controller";
import type {
  CharacterPreviewState,
  CompanionEmotion,
  LicensedAvatarRuntimeFormat,
} from "@/lib/types";

const RUNTIME_PROTOCOL = "companion-avatar-runtime/v1";
const ARCHIVE_INSTANCE_IDS = new WeakMap<Blob, string>();
let nextArchiveInstanceId = 1;

interface LicensedRuntimeState {
  emotion: CompanionEmotion;
  reducedMotion: boolean;
  speechLevel: number;
  state: CharacterPreviewState;
}

interface LicensedRuntimeHandle {
  destroy: () => void | Promise<void>;
  instanceId?: string;
  ready: Promise<void>;
  resize: (width: number, height: number, devicePixelRatio: number) => void | Promise<void>;
  update: (state: LicensedRuntimeState) => void | Promise<void>;
}

interface LicensedRuntimeBridge {
  create: (options: {
    archive: Blob;
    entrypoint: string;
    initial: LicensedRuntimeState;
    mount: HTMLElement;
    sha256: string;
    signal: AbortSignal;
  }) => LicensedRuntimeHandle | Promise<LicensedRuntimeHandle>;
  format: LicensedAvatarRuntimeFormat;
  protocol: typeof RUNTIME_PROTOCOL;
}

declare global {
  interface Window {
    __COMPANION_AVATAR_RUNTIME_BRIDGES__?: Partial<
      Record<LicensedAvatarRuntimeFormat, unknown>
    >;
    __COMPANION_AVATAR_RUNTIME_BRIDGE_URLS__?: Partial<
      Record<LicensedAvatarRuntimeFormat, string>
    >;
  }
}

export interface LicensedRuntimeStatus {
  assetIdentity: string;
  canvasCount: number;
  detail: string;
  instance: string;
  mode: "loading" | "ready" | "blocked" | "error";
  reason: "loading" | "ready" | "bridge-unconfigured" | "cross-origin" | "protocol-mismatch" | "load-failed" | "runtime-invalid";
}

class RuntimeBridgeError extends Error {
  constructor(
    message: string,
    readonly reason: LicensedRuntimeStatus["reason"],
    readonly blocked = false,
  ) {
    super(message);
  }
}

function bridgeEnvironmentUrl(format: LicensedAvatarRuntimeFormat) {
  const runtimeOverride = window.__COMPANION_AVATAR_RUNTIME_BRIDGE_URLS__?.[format];
  if (runtimeOverride) {
    return runtimeOverride;
  }
  return format === "live2d"
    ? process.env.NEXT_PUBLIC_LIVE2D_RUNTIME_BRIDGE_URL
    : process.env.NEXT_PUBLIC_SPINE_RUNTIME_BRIDGE_URL;
}

function asBridge(candidate: unknown, format: LicensedAvatarRuntimeFormat) {
  const bridge = candidate && typeof candidate === "object" && "default" in candidate
    ? (candidate as { default: unknown }).default
    : candidate;
  if (!bridge || typeof bridge !== "object") {
    throw new RuntimeBridgeError(`${format} 许可运行时桥接未提供有效模块。`, "protocol-mismatch", true);
  }
  const record = bridge as Partial<LicensedRuntimeBridge>;
  if (
    record.protocol !== RUNTIME_PROTOCOL
    || record.format !== format
    || typeof record.create !== "function"
  ) {
    throw new RuntimeBridgeError(`${format} 许可运行时桥接协议或格式不匹配。`, "protocol-mismatch", true);
  }
  return record as LicensedRuntimeBridge;
}

async function loadBridge(format: LicensedAvatarRuntimeFormat) {
  const injected = window.__COMPANION_AVATAR_RUNTIME_BRIDGES__?.[format];
  if (injected) {
    return asBridge(injected, format);
  }
  const configuredUrl = bridgeEnvironmentUrl(format);
  if (!configuredUrl) {
    throw new RuntimeBridgeError(
      `${format} 模型已安全导入，但尚未配置同源的已许可运行时桥接。`,
      "bridge-unconfigured",
      true,
    );
  }
  const url = new URL(configuredUrl, window.location.href);
  if (url.origin !== window.location.origin) {
    throw new RuntimeBridgeError(`${format} 运行时桥接必须与 Companion Space 同源。`, "cross-origin", true);
  }
  const loaded: unknown = await import(/* webpackIgnore: true */ url.href);
  return asBridge(loaded, format);
}

function destroyCandidate(candidate: unknown) {
  if (!candidate || typeof candidate !== "object") {
    return;
  }
  const destroy = (candidate as { destroy?: unknown }).destroy;
  if (typeof destroy !== "function") {
    return;
  }
  try {
    void Promise.resolve(destroy.call(candidate)).catch(() => undefined);
  } catch {
    // Invalid licensed hosts still receive one best-effort resource cleanup.
  }
}

function asHandle(candidate: unknown) {
  if (!candidate || typeof candidate !== "object") {
    throw new RuntimeBridgeError("许可运行时桥接没有返回实例句柄。", "runtime-invalid");
  }
  const handle = candidate as Partial<LicensedRuntimeHandle>;
  if (
    typeof handle.update !== "function"
    || typeof handle.resize !== "function"
    || typeof handle.destroy !== "function"
    || !handle.ready
    || typeof handle.ready.then !== "function"
  ) {
    destroyCandidate(candidate);
    throw new RuntimeBridgeError("许可运行时实例句柄缺少 ready/update/resize/destroy。", "runtime-invalid");
  }
  return handle as LicensedRuntimeHandle;
}

export function licensedRuntimeAssetIdentity(asset: CharacterLicensedRuntimeAssets) {
  let instanceId = ARCHIVE_INSTANCE_IDS.get(asset.archive);
  if (!instanceId) {
    instanceId = `archive-${nextArchiveInstanceId}`;
    nextArchiveInstanceId += 1;
    ARCHIVE_INSTANCE_IDS.set(asset.archive, instanceId);
  }
  return `${asset.format}:${asset.sha256}:${asset.entrypoint}:${instanceId}`;
}

function destroyHandle(handle: LicensedRuntimeHandle) {
  try {
    void Promise.resolve(handle.destroy()).catch(() => undefined);
  } catch {
    // A licensed host must never prevent local mount cleanup.
  }
}

export function LicensedRuntimeStage({
  asset,
  emotion,
  onStatusChange,
  reducedMotion,
  speechController,
  state,
}: {
  asset: CharacterLicensedRuntimeAssets;
  emotion: CompanionEmotion;
  onStatusChange: (status: LicensedRuntimeStatus) => void;
  reducedMotion: boolean;
  speechController?: AvatarSpeechController;
  state: CharacterPreviewState;
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<LicensedRuntimeHandle | null>(null);
  const cleanupRuntimeRef = useRef<(() => void) | null>(null);
  const generationRef = useRef(0);
  const currentRef = useRef<LicensedRuntimeState>({
    emotion,
    reducedMotion,
    speechLevel: speechController?.peek() ?? 0,
    state,
  });
  currentRef.current = {
    emotion,
    reducedMotion,
    speechLevel: currentRef.current.speechLevel,
    state,
  };
  const assetIdentity = licensedRuntimeAssetIdentity(asset);

  const updateHandle = useCallback((next: LicensedRuntimeState) => {
    const handle = handleRef.current;
    if (!handle) {
      return;
    }
    const generation = generationRef.current;
    const fail = (error: unknown) => {
      if (generationRef.current !== generation || handleRef.current !== handle) {
        return;
      }
      const mount = mountRef.current;
      const instance = handle.instanceId || `${asset.format}-${generationRef.current}`;
      cleanupRuntimeRef.current?.();
      onStatusChange({
        assetIdentity,
        canvasCount: mount?.querySelectorAll("canvas").length ?? 0,
        detail: error instanceof Error ? error.message : `${asset.format} 运行时更新失败。`,
        instance,
        mode: "error",
        reason: "runtime-invalid",
      });
    };
    try {
      void Promise.resolve(handle.update(next)).catch(fail);
    } catch (error) {
      fail(error);
    }
  }, [asset.format, assetIdentity, onStatusChange]);

  useEffect(() => {
    updateHandle(currentRef.current);
  }, [emotion, reducedMotion, state, updateHandle]);

  useEffect(() => {
    if (!speechController) {
      currentRef.current.speechLevel = 0;
      updateHandle(currentRef.current);
      return;
    }
    return speechController.subscribe((speechLevel) => {
      currentRef.current.speechLevel = speechLevel;
      updateHandle(currentRef.current);
    });
  }, [speechController, updateHandle]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) {
      return;
    }
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    const fallbackInstance = `${asset.format}-${generation}`;
    const abortController = new AbortController();
    let resizeObserver: ResizeObserver | null = null;
    let mutationObserver: MutationObserver | null = null;
    let handle: LicensedRuntimeHandle | null = null;
    let cleaned = false;

    const cleanup = () => {
      if (cleaned) {
        return;
      }
      cleaned = true;
      abortController.abort();
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      resizeObserver = null;
      mutationObserver = null;
      if (handleRef.current === handle) {
        handleRef.current = null;
      }
      if (handle) {
        destroyHandle(handle);
        handle = null;
      }
      mount.replaceChildren();
    };
    cleanupRuntimeRef.current = cleanup;

    const publish = (
      mode: LicensedRuntimeStatus["mode"],
      detail: string,
      instance = fallbackInstance,
      reason: LicensedRuntimeStatus["reason"] = mode === "ready" ? "ready" : "loading",
    ) => {
      if (generationRef.current !== generation) {
        return;
      }
      onStatusChange({
        assetIdentity,
        canvasCount: mount.querySelectorAll("canvas").length,
        detail,
        instance,
        mode,
        reason,
      });
    };

    publish("loading", `正在加载 ${asset.format} 已许可运行时桥接。`);
    void loadBridge(asset.format)
      .then((bridge) => {
        if (cleaned || generationRef.current !== generation) {
          throw new DOMException("Licensed runtime initialization was superseded.", "AbortError");
        }
        abortController.signal.throwIfAborted();
        return bridge.create({
          archive: asset.archive,
          entrypoint: asset.entrypoint,
          initial: { ...currentRef.current },
          mount,
          sha256: asset.sha256,
          signal: abortController.signal,
        });
      })
      .then(async (candidate) => {
        if (abortController.signal.aborted || generationRef.current !== generation) {
          destroyHandle(asHandle(candidate));
          return;
        }
        const nextHandle = asHandle(candidate);
        if (cleaned || abortController.signal.aborted || generationRef.current !== generation) {
          destroyHandle(nextHandle);
          return;
        }
        handle = nextHandle;
        try {
          await handle.ready;
        } catch (error) {
          throw new RuntimeBridgeError(
            error instanceof Error ? error.message : `${asset.format} 运行时首帧准备失败。`,
            "runtime-invalid",
          );
        }
        if (cleaned || abortController.signal.aborted || generationRef.current !== generation) {
          return;
        }
        handleRef.current = handle;
        if (mount.querySelectorAll("canvas").length === 0) {
          throw new RuntimeBridgeError(
            `${asset.format} 运行时未在宿主节点内创建 canvas。`,
            "runtime-invalid",
          );
        }
        const instance = typeof handle.instanceId === "string" && handle.instanceId
          ? handle.instanceId
          : fallbackInstance;
        const resize = () => {
          const bounds = mount.getBoundingClientRect();
          return handle?.resize(bounds.width, bounds.height, window.devicePixelRatio || 1);
        };
        resizeObserver = new ResizeObserver(() => {
          const observedHandle = handle;
          if (!observedHandle) {
            return;
          }
          try {
            void Promise.resolve(resize()).catch((error) => {
              if (generationRef.current !== generation || handleRef.current !== observedHandle) {
                return;
              }
              cleanup();
              publish(
                "error",
                error instanceof Error ? error.message : `${asset.format} 运行时缩放失败。`,
                instance,
                "runtime-invalid",
              );
            });
          } catch (error) {
            if (generationRef.current !== generation || handleRef.current !== observedHandle) {
              return;
            }
            cleanup();
            publish(
              "error",
              error instanceof Error ? error.message : `${asset.format} 运行时缩放失败。`,
              instance,
              "runtime-invalid",
            );
          }
        });
        resizeObserver.observe(mount);
        mutationObserver = new MutationObserver(() => {
          if (mount.querySelectorAll("canvas").length === 0) {
            cleanup();
            publish("error", `${asset.format} 运行时 canvas 已被移除。`, instance, "runtime-invalid");
          }
        });
        mutationObserver.observe(mount, { childList: true, subtree: true });
        try {
          await Promise.resolve(resize());
          await Promise.resolve(handle.update(currentRef.current));
          if (mount.querySelectorAll("canvas").length === 0) {
            throw new RuntimeBridgeError(
              `${asset.format} 运行时初始化后未保留可渲染 canvas。`,
              "runtime-invalid",
            );
          }
        } catch (error) {
          throw new RuntimeBridgeError(
            error instanceof Error ? error.message : `${asset.format} 运行时初始化失败。`,
            "runtime-invalid",
          );
        }
        if (mount.querySelectorAll("canvas").length === 0) {
          throw new RuntimeBridgeError(
            `${asset.format} 运行时在初始化后移除了 canvas。`,
            "runtime-invalid",
          );
        }
        publish("ready", `${asset.format} 许可运行时已就绪。`, instance);
      })
      .catch((error: unknown) => {
        if (abortController.signal.aborted || generationRef.current !== generation) {
          return;
        }
        const detail = error instanceof Error ? error.message : `${asset.format} 运行时加载失败。`;
        const bridgeError = error instanceof RuntimeBridgeError ? error : null;
        cleanup();
        publish(
          bridgeError?.blocked ? "blocked" : "error",
          detail,
          fallbackInstance,
          bridgeError?.reason ?? "load-failed",
        );
      });

    return () => {
      cleanup();
      if (cleanupRuntimeRef.current === cleanup) {
        cleanupRuntimeRef.current = null;
      }
    };
  }, [asset.archive, asset.entrypoint, asset.format, asset.sha256, assetIdentity, onStatusChange]);

  return (
    <div
      ref={mountRef}
      data-licensed-runtime-mount={asset.format}
      style={{ height: "100%", width: "100%" }}
    />
  );
}
