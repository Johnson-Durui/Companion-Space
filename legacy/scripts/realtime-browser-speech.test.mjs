import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

import ts from "typescript";

async function loadModule(window) {
  const sourcePath = "apps/web/components/realtime/realtime-browser-speech.ts";
  const source = await readFile(sourcePath, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: sourcePath,
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(compiled, {
    exports: module.exports,
    module,
    require(specifier) {
      if (specifier === "@/components/avatar/emotion-profile") {
        return { tuneBuiltInVoice: (profile) => profile };
      }
      throw new Error(`Unexpected dependency: ${specifier}`);
    },
    window,
  }, { filename: sourcePath });
  return module.exports;
}

function makeWindow() {
  let nextTimer = 1;
  const timers = new Map();
  class Utterance {
    constructor(text) { this.text = text; }
  }
  const speechSynthesis = {
    canceled: 0,
    spoken: [],
    getVoices: () => [{ lang: "zh-CN", localService: true, name: "Local", voiceURI: "local" }],
    speak(utterance) { this.spoken.push(utterance); },
    cancel() { this.canceled += 1; },
    addEventListener() {},
    removeEventListener() {},
  };
  return {
    AudioContext: class {},
    SpeechSynthesisUtterance: Utterance,
    performance: { now: () => 100 },
    speechSynthesis,
    setInterval(callback) { const id = nextTimer++; timers.set(id, callback); return id; },
    clearInterval(id) { timers.delete(id); },
    setTimeout(callback) { const id = nextTimer++; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
}

test("browser speech publishes lifecycle and cancels the active utterance", async () => {
  const window = makeWindow();
  const events = [];
  const { RealtimeBrowserSpeech } = await loadModule(window);
  const playback = new RealtimeBrowserSpeech({
    onComplete: () => events.push("complete"),
    onError: (message) => events.push(`error:${message}`),
    onLevel: (level) => events.push(`level:${level}`),
    onStart: () => events.push("start"),
  });
  playback.speak("hello", { id: "soft", pitch: 1, rate: 1, voiceIndex: 0 });
  assert.equal(playback.hasPending(), true);
  const utterance = window.speechSynthesis.spoken[0];
  utterance.onstart();
  assert.ok(events.includes("start"));
  assert.equal(playback.cancel(), true);
  assert.equal(playback.hasPending(), false);
  assert.equal(window.speechSynthesis.canceled, 1);
  utterance.onend();
  assert.equal(events.includes("complete"), false, "stale completion must be ignored after cancel");
});
