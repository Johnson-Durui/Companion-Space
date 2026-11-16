import type { SessionState } from "@/components/realtime/realtime-types";

export const REALTIME_PROTOCOL = "companion-v1";

export type RealtimeControlEvent =
  | {
      type: "turn.interrupt";
      payload?: { board_action_id?: string; clear_audio_buffer?: boolean; prompt?: string };
    }
  | { type: "user.commit"; payload?: Record<string, never> };

export function createRealtimeWebSocket(url: string, ticket: string) {
  return new WebSocket(url, [REALTIME_PROTOCOL, `ticket.${ticket}`]);
}

export function sendRealtimeControlEvent(
  socket: WebSocket | null,
  sessionId: string | null,
  state: SessionState,
  event: RealtimeControlEvent,
) {
  if (!socket || !sessionId || socket.readyState !== WebSocket.OPEN) {
    return false;
  }
  socket.send(JSON.stringify({
    type: event.type,
    session_id: sessionId,
    state,
    payload: event.payload ?? {},
  }));
  return true;
}
