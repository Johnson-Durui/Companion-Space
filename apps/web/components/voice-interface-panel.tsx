"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

import {
  createProvider,
  discoverProviderModels,
  listSpaces,
  previewProviderSpeech,
  saveSpaceAssignment,
  updateProvider,
} from "@/lib/api";
import type { ProviderConnection, ProviderRegistryEntry, StudySpaceSummary } from "@/lib/types";
import { LOCAL_NEURAL_VOICE_MODEL, LOCAL_NEURAL_VOICES } from "@/lib/voice-presets";
import { Pcm16PlaybackQueue, OUTPUT_PCM16_SAMPLE_RATE } from "@/components/realtime/realtime-audio";
import { ErrorCallout, SectionCard } from "@/components/ui";
import styles from "@/components/voice-interface-panel.module.css";

function defaultsFor(provider: string) {
  return {
    model: provider === "local-neural" ? LOCAL_NEURAL_VOICE_MODEL : provider === "mock" ? "mock-voice-v1" : "",
    voice: provider === "local-neural" ? "Serena" : provider === "mock" ? "default" : "",
  };
}

export function VoiceInterfacePanel({ providers, registry, onConnectionSaved }: {
  providers: ProviderConnection[];
  registry: ProviderRegistryEntry[];
  onConnectionSaved: (connection: ProviderConnection) => void;
}) {
  const [connectionId, setConnectionId] = useState("");
  const [provider, setProvider] = useState("local-neural");
  const [label, setLabel] = useState("本地 Qwen 语音");
  const [baseUrl, setBaseUrl] = useState("http://127.0.0.1:8001");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(LOCAL_NEURAL_VOICE_MODEL);
  const [voiceId, setVoiceId] = useState("Serena");
  const [rate, setRate] = useState(1);
  const [text, setText] = useState("你好，语音连接准备好了。我们一起开始今天的学习吧。");
  const [models, setModels] = useState<string[]>([]);
  const [spaces, setSpaces] = useState<StudySpaceSummary[]>([]);
  const [spaceId, setSpaceId] = useState("");
  const [spacesError, setSpacesError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [playback, setPlayback] = useState<"idle" | "loading" | "playing">("idle");
  const [audioMessage, setAudioMessage] = useState<string | null>(null);
  const queueRef = useRef<Pcm16PlaybackQueue | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const spaceRequestRef = useRef(0);

  const selected = providers.find((item) => item.id === connectionId);
  const descriptor = registry.find((item) => item.provider === provider);
  const builtIn = connectionId === "builtin-neural-tts" || connectionId === "builtin-mock";
  const requiresKey = descriptor?.requires_api_key !== false;
  const canSetUrl = descriptor?.supports_custom_base_url === true;
  const dirty = !selected || selected.label !== label.trim()
    || (selected.base_url ?? "") !== baseUrl.trim() || Boolean(apiKey);
  const selectedSpace = spaces.find((item) => item.id === spaceId);
  const supportedTypes = registry.filter((item) => item.capabilities.includes("tts") && item.provider !== "mock");

  const invalidatePlayback = useCallback(() => {
    const request = requestRef.current;
    requestRef.current = null;
    request?.abort();
    queueRef.current?.clear();
  }, []);

  const stopPlayback = useCallback(() => {
    const active = Boolean(requestRef.current);
    invalidatePlayback();
    setPlayback("idle");
    setAudioMessage(active ? "试听已停止。" : null);
  }, [invalidatePlayback]);

  const loadSpaces = useCallback(async () => {
    const generation = ++spaceRequestRef.current;
    try {
      const result = await listSpaces();
      if (mountedRef.current && generation === spaceRequestRef.current) {
        setSpaces(result);
        setSpacesError(null);
      }
    } catch (loadError) {
      if (mountedRef.current && generation === spaceRequestRef.current) {
        setSpacesError(loadError instanceof Error ? loadError.message : "读取学习空间失败");
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void loadSpaces();
    return () => {
      mountedRef.current = false;
      spaceRequestRef.current += 1;
      invalidatePlayback();
      const queue = queueRef.current;
      queueRef.current = null;
      void queue?.close().catch((closeError: unknown) => {
        console.error("关闭语音接口试听失败", closeError);
      });
    };
  }, [invalidatePlayback, loadSpaces]);

  useEffect(() => {
    if (!connectionId) return;
    stopPlayback();
    setProvider(selected?.provider ?? "local-neural");
    setLabel(selected?.label ?? "本地 Qwen 语音");
    setBaseUrl(selected?.base_url ?? (!selected?.id ? "http://127.0.0.1:8001" : ""));
    setApiKey("");
    if (!selected?.id) {
      setConnectionId("");
      setModel(LOCAL_NEURAL_VOICE_MODEL);
      setVoiceId("Serena");
      setModels([]);
      setError(null);
      setNotice("原连接已删除，可以新建语音连接。");
    }
  }, [
    connectionId, selected?.id, selected?.provider, selected?.label,
    selected?.base_url, selected?.updated_at, stopPlayback,
  ]);

  function chooseConnection(id: string) {
    stopPlayback();
    const next = providers.find((item) => item.id === id);
    const nextProvider = next?.provider ?? "local-neural";
    setConnectionId(id);
    setProvider(nextProvider);
    setLabel(next?.label ?? "本地 Qwen 语音");
    setBaseUrl(next?.base_url ?? (nextProvider === "local-neural" ? "http://127.0.0.1:8001" : ""));
    setApiKey("");
    setModel(defaultsFor(nextProvider).model);
    setVoiceId(defaultsFor(nextProvider).voice);
    setModels([]);
    setError(null);
    setNotice(null);
  }

  function chooseProvider(value: string) {
    stopPlayback();
    setProvider(value);
    setBaseUrl(value === "local-neural" ? "http://127.0.0.1:8001" : "");
    setApiKey("");
    setModel(defaultsFor(value).model);
    setVoiceId(defaultsFor(value).voice);
    setModels([]);
    setError(null);
    setNotice(null);
  }

  async function saveConnection(event: FormEvent) {
    event.preventDefault();
    stopPlayback();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const input = {
        label: label.trim(),
        base_url: canSetUrl ? baseUrl.trim() || null : null,
        api_key: requiresKey ? apiKey.trim() || undefined : undefined,
      };
      const saved = connectionId
        ? await updateProvider(connectionId, input)
        : await createProvider({ ...input, provider, api_key: input.api_key ?? "" });
      if (!mountedRef.current) return;
      onConnectionSaved(saved);
      setConnectionId(saved.id);
      setLabel(saved.label);
      setBaseUrl(saved.base_url ?? "");
      setApiKey("");
      setNotice("语音连接已保存。接下来测试实际合成，再绑定学习空间。");
    } catch (saveError) {
      if (mountedRef.current) setError(saveError instanceof Error ? saveError.message : "保存语音连接失败");
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  async function discoverModels() {
    stopPlayback();
    setBusy(true);
    setError(null);
    setNotice(null);
    setModels([]);
    try {
      const result = await discoverProviderModels(connectionId, "tts");
      if (!mountedRef.current) return;
      setModels(result.models);
      setNotice(result.models.length
        ? `已读取 ${result.models.length} 个模型；是否能发声还需点击“测试并试听”。`
        : "服务没有返回模型列表，可以手动填写语音模型名再试听。");
    } catch (discoveryError) {
      if (mountedRef.current) setError(discoveryError instanceof Error ? discoveryError.message : "读取模型列表失败");
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  async function preview() {
    invalidatePlayback();
    const request = new AbortController();
    requestRef.current = request;
    const current = () => mountedRef.current && requestRef.current === request && !request.signal.aborted;
    setPlayback("loading");
    setAudioMessage("正在准备语音试听…");
    setError(null);
    setNotice(null);
    try {
      let queue = queueRef.current;
      if (!queue) {
        queue = new Pcm16PlaybackQueue(OUTPUT_PCM16_SAMPLE_RATE, () => {
          if (!requestRef.current || !mountedRef.current) return;
          requestRef.current = null;
          setPlayback("idle");
          setAudioMessage("试听已完成。");
        });
        queueRef.current = queue;
      }
      await queue.prepare();
      if (!current()) return;
      const audio = await previewProviderSpeech({
        connectionId, model: model.trim(), text: text.trim(), voiceId: voiceId.trim(),
        speakingRate: rate, signal: request.signal,
      });
      if (!current()) return;
      queue.enqueue(audio.pcm16);
      setPlayback("playing");
      setAudioMessage(provider === "mock" ? "正在播放 Mock 测试音。" : "已收到合成音频，正在试听。");
    } catch (previewError) {
      if (!current()) return;
      invalidatePlayback();
      setPlayback("idle");
      setAudioMessage(null);
      setError(previewError instanceof Error ? previewError.message : "语音试听失败");
    }
  }

  async function bindSpace() {
    stopPlayback();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await saveSpaceAssignment(spaceId, {
        capability: "tts", provider_connection_id: connectionId, model_name: model.trim(),
      });
      if (mountedRef.current) {
        setNotice(`已绑定到「${selectedSpace?.title ?? "所选空间"}」的 TTS。新的共学会话会使用此连接；角色声线仍以角色设置为准。`);
      }
    } catch (bindError) {
      if (mountedRef.current) setError(bindError instanceof Error ? bindError.message : "绑定语音服务失败");
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  return (
    <section id="voice-service" aria-label="语音接口配置" className={styles.panel}>
      <SectionCard title="语音接口配置" eyebrow="让伙伴开口说话" hint="保存接口，测试真实合成，再选择使用它的学习空间。">
        <div className={styles.columns}>
          <form className={styles.column} onSubmit={(event) => void saveConnection(event)}>
            <h3>1. 接入语音服务</h3>
            <label className="field"><span>语音连接</span>
              <select value={connectionId} disabled={busy} onChange={(event) => chooseConnection(event.target.value)}>
                <option value="">新建语音连接</option>
                {providers.filter((item) => item.capabilities.includes("tts")).map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
              </select>
            </label>
            <label className="field"><span>协议类型</span>
              <select value={provider} disabled={busy || Boolean(connectionId)} onChange={(event) => chooseProvider(event.target.value)}>
                {provider === "mock" ? <option value="mock">Mock 测试音</option> : null}
                {supportedTypes.map((item) => <option key={item.provider} value={item.provider}>{item.provider === "local-neural" ? "本地 Qwen · local-neural" : item.provider}</option>)}
              </select>
            </label>
            <label className="field"><span>连接名称</span>
              <input value={label} required maxLength={120} disabled={busy || builtIn} onChange={(event) => { stopPlayback(); setLabel(event.target.value); }} />
            </label>
            <label className="field"><span>接口地址（Base URL）</span>
              <input type="url" value={baseUrl} maxLength={2048} disabled={busy || builtIn || !canSetUrl} placeholder={provider === "local-neural" ? "http://127.0.0.1:8001" : "使用服务提供方的 Base URL"} onChange={(event) => { stopPlayback(); setBaseUrl(event.target.value); }} />
              <small className="muted">本地 Qwen 填服务根地址；兼容接口按供应商说明填写。地址由本项目后端访问。</small>
            </label>
            {requiresKey && !builtIn ? <label className="field"><span>API Key</span>
              <input type="password" autoComplete="off" value={apiKey} required={!connectionId} maxLength={400} disabled={busy} placeholder={connectionId ? "留空保留已保存的 Key" : "填写语音服务的 API Key"} onChange={(event) => { stopPlayback(); setApiKey(event.target.value); }} />
              <small className="muted">保存至加密保险箱，不会回填到页面。</small>
            </label> : null}
            {builtIn ? <p className="muted">这是内置连接。要填写自己的地址，请选择“新建语音连接”。</p> :
              <button className="primary-button" type="submit" disabled={busy || !descriptor || !label.trim() || (!connectionId && requiresKey && !apiKey.trim())}>保存语音连接</button>}
          </form>
          <div className={styles.column}>
            <h3>2. 试听与空间绑定</h3>
            <label className="field"><span>语音模型</span>
              <input list="voice-interface-models" value={model} maxLength={200} disabled={busy} onChange={(event) => { stopPlayback(); setModel(event.target.value); }} />
              <datalist id="voice-interface-models">{models.map((name) => <option key={name} value={name} />)}</datalist>
            </label>
            <button type="button" className="ghost-button" disabled={busy || dirty} onClick={() => void discoverModels()}>读取模型列表</button>
            <label className="field"><span>声线 ID</span>
              <input list={provider === "local-neural" ? "voice-interface-voices" : undefined} value={voiceId} maxLength={120} disabled={busy} onChange={(event) => { stopPlayback(); setVoiceId(event.target.value); }} />
              {provider === "local-neural" ? <datalist id="voice-interface-voices">{LOCAL_NEURAL_VOICES.map((voice) => <option key={voice.value} value={voice.value}>{voice.label}</option>)}</datalist> : null}
              <small className="muted">在线服务请填它支持的 Voice ID；这里的声线用于试听，角色声线在伙伴编辑页保存。</small>
            </label>
            <label className="field"><span>语速</span>
              <input type="range" min={0.5} max={2} step={0.05} value={rate} disabled={busy} onChange={(event) => { stopPlayback(); setRate(Number(event.target.value)); }} />
              <small>{rate.toFixed(2)} 倍</small>
            </label>
            <label className="field"><span>试听文本</span>
              <textarea rows={3} maxLength={240} value={text} disabled={busy} onChange={(event) => { stopPlayback(); setText(event.target.value); }} />
            </label>
            <div className={styles.actions}>
              {playback !== "idle" ? <button className="primary-button" type="button" onClick={stopPlayback}>停止试听</button> :
                <button className="primary-button" type="button" disabled={busy || dirty || !model.trim() || !voiceId.trim() || !text.trim()} onClick={() => void preview()}>测试并试听</button>}
              {dirty ? <small className="muted">请先保存连接信息。</small> : null}
            </div>
            {audioMessage ? <p role="status" className={styles.status}>{audioMessage}</p> : null}
            {provider === "mock" ? <p className="muted">Mock 仅播放测试音，不代表真实声线效果。</p> : null}
            <label className="field"><span>绑定学习空间</span>
              <select value={spaceId} disabled={busy} onChange={(event) => { stopPlayback(); setSpaceId(event.target.value); setNotice(null); }}>
                <option value="">选择使用此语音服务的空间</option>
                {spaces.map((space) => <option key={space.id} value={space.id}>{space.title}</option>)}
              </select>
            </label>
            {spacesError ? <><ErrorCallout message={spacesError} /><button type="button" className="ghost-button" onClick={() => void loadSpaces()}>重新读取空间</button></> : null}
            {!spacesError && !spaces.length ? <Link href="/spaces">创建学习空间</Link> : null}
            <div className={styles.actions}>
              <button type="button" className="primary-button" disabled={busy || dirty || !spaceId || !model.trim()} onClick={() => void bindSpace()}>绑定到空间</button>
              <Link href={selectedSpace?.default_character_id ? `/characters/${selectedSpace.default_character_id}` : "/characters"}>设置角色声线</Link>
              {spaceId ? <Link href={`/spaces/${spaceId}`}>查看空间配置</Link> : null}
            </div>
          </div>
        </div>
        {error ? <ErrorCallout message={error} /> : null}
        {notice ? <p role="status" className={styles.status}>{notice}</p> : null}
        <details className={styles.example}>
          <summary>接口调用示例</summary>
          <p className="muted">向本项目 API 发送请求，使用解锁后获得的临时 Owner token。返回 24 kHz、单声道 PCM16 音频。</p>
          <pre>{`POST /api/v1/providers/connections/${connectionId || "<连接ID>"}/speech-preview\nAuthorization: Bearer <OWNER_TOKEN>\nContent-Type: application/json\n\n${JSON.stringify({ model, text, voice_id: voiceId, speaking_rate: rate }, null, 2)}`}</pre>
        </details>
      </SectionCard>
    </section>
  );
}
