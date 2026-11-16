import assert from "node:assert/strict";
import test from "node:test";

import { sendRealtimeControlEvent } from "../apps/web/components/realtime/realtime-transport.ts";

test("typed realtime transport emits the canonical event envelope", () => {
  const sent = [];
  globalThis.WebSocket = { OPEN: 1 };
  const socket = {
    readyState: 1,
    send(value) {
      sent.push(JSON.parse(value));
    },
  };
  assert.equal(
    sendRealtimeControlEvent(socket, "session-1", "speaking", {
      type: "turn.interrupt",
      payload: { board_action_id: "quiz-1", prompt: "请解释这一步" },
    }),
    true,
  );
  assert.deepEqual(sent, [{
    type: "turn.interrupt",
    session_id: "session-1",
    state: "speaking",
    payload: { board_action_id: "quiz-1", prompt: "请解释这一步" },
  }]);
});

test("typed realtime transport refuses closed sockets", () => {
  globalThis.WebSocket = { OPEN: 1 };
  assert.equal(
    sendRealtimeControlEvent({ readyState: 3 }, "session-1", "idle", {
      type: "user.commit",
    }),
    false,
  );
});
