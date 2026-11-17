import assert from "node:assert/strict";
import test from "node:test";

import {
  dominantViseme,
  nextSpeakingEnvelope,
  speechEnergy,
  visemeWeights,
} from "../apps/web/components/avatar/vrm-viseme.ts";

test("idle audio does not open visemes", () => {
  const weights = visemeWeights({
    elapsedSeconds: 1.25,
    speaking: false,
    speechLevel: 0,
  });
  assert.equal(dominantViseme(weights), "none");
  assert.equal(weights.aa, 0);
});

test("speaking with no RMS still drives a mouth envelope", () => {
  const weights = visemeWeights({
    elapsedSeconds: 0.4,
    speaking: true,
    speechLevel: 0,
  });
  assert.equal(speechEnergy(0), 0);
  assert.ok(weights.aa + weights.ih + weights.ou + weights.ee + weights.oh > 0.1);
  assert.notEqual(dominantViseme(weights), "none");
});

test("PCM RMS scales mouth openness and cycles visemes over time", () => {
  const early = visemeWeights({
    elapsedSeconds: 0.05,
    speaking: true,
    speechLevel: 0.22,
  });
  const later = visemeWeights({
    elapsedSeconds: 0.22,
    speaking: true,
    speechLevel: 0.22,
  });
  assert.ok(speechEnergy(0.22) > 0.9);
  assert.ok(early.aa > 0.2);
  const earlyKey = `${early.aa.toFixed(2)}:${early.ih.toFixed(2)}:${early.ou.toFixed(2)}`;
  const laterKey = `${later.aa.toFixed(2)}:${later.ih.toFixed(2)}:${later.ou.toFixed(2)}`;
  assert.notEqual(earlyKey, laterKey);
});

test("speaking envelope attacks quickly and releases after speech ends", () => {
  let envelope = 0;
  envelope = nextSpeakingEnvelope({
    current: envelope,
    speaking: true,
    speechLevel: 0.2,
    deltaSeconds: 0.08,
  });
  assert.ok(envelope > 0.45);
  envelope = nextSpeakingEnvelope({
    current: envelope,
    speaking: false,
    speechLevel: 0,
    deltaSeconds: 0.25,
  });
  assert.ok(envelope < 0.12);
});

test("playful emotion opens the mouth more than focused", () => {
  const shared = {
    elapsedSeconds: 0.05,
    speaking: true,
    speechLevel: 0.22,
  };
  const playful = visemeWeights({ ...shared, emotion: "playful" });
  const focused = visemeWeights({ ...shared, emotion: "focused" });
  assert.ok(playful.aa > focused.aa);
});
