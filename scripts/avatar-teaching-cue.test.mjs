import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveAvatarGaze,
  teachingFeedbackEmotion,
  teachingFeedbackReactionKey,
} from "../packages/avatar-engine/src/teaching-cue.ts";

test("board focus overrides pointer gaze and clamps normalized coordinates", () => {
  assert.deepEqual(
    resolveAvatarGaze({
      boardFocus: { id: "quiz-1", x: 2, y: -2 },
      pointer: { active: true, x: -0.25, y: 0.4 },
      reducedMotion: false,
    }),
    { active: true, source: "board", x: 1, y: -1 },
  );
});

test("reduced motion disables teaching gaze and feedback produces stable reaction key", () => {
  assert.deepEqual(
    resolveAvatarGaze({
      boardFocus: { id: "formula", x: 0.4, y: 0.2 },
      reducedMotion: true,
    }),
    { active: false, source: "reduced", x: 0, y: 0 },
  );
  assert.equal(
    teachingFeedbackReactionKey({ kind: "retry", sequence: 4 }),
    "teaching:retry:4",
  );
  assert.equal(teachingFeedbackEmotion({ kind: "retry", sequence: 4 }), "concerned");
  assert.equal(teachingFeedbackEmotion({ kind: "correct", sequence: 5 }), "cheerful");
});
