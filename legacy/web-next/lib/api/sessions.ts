import type { CompanionTurn, MemoryItemWire, RealtimeEventWire, RealtimeTicketResponseWire, ReviewItemWire, SessionDemoRequestInput, SessionDemoResponseWire } from "@/lib/types";
import { ApiError, apiClient, apiData, apiUrl, contractError, errorMessage, expectArray, expectArrayField, expectRecord, isOwnerAuthFailure, isRecord, parseResponse, request } from "./transport";
import { decodeSessionDemoResponse } from "@/components/lesson/lesson-contract";
import { asRealtimeEvent, decodeSessionRecordWire, eventErrorMessage, toSessionDetail, toSessionSummary } from "./session-codec";
import { browserApiFetch } from "@companion-space/api-client";
import { clearOwnerSessionToken } from "@/lib/owner-session";
import { loadSpacesWire } from "./spaces";

export async function createSessionDemo(
  sessionId: string,
  input: SessionDemoRequestInput,
): Promise<SessionDemoResponseWire> {
  const payload = await request<unknown>(`/api/v1/sessions/${sessionId}/demos`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const decoded = decodeSessionDemoResponse(payload);
  if (!decoded) {
    throw contractError("演示生成接口返回了无效脚本载荷", payload);
  }
  return decoded;
}

export async function createSession(input: {
  space_id: string;
  character_pack_id?: string | null;
}) {
  const payload = apiData(await apiClient().POST("/api/v1/sessions", { body: input }), "无法创建课堂会话");
  return decodeSessionRecordWire(payload, "会话创建接口");
}

export async function createTurn(sessionId: string, text: string) {
  return request<CompanionTurn>(`/api/v1/sessions/${sessionId}/turns`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
}

export async function streamTurn(
  sessionId: string,
  text: string,
  onEvent: (event: RealtimeEventWire) => void,
) {
  const headers = new Headers({ "Content-Type": "application/json" });
  const response = await browserApiFetch(apiUrl(`/api/v1/sessions/${sessionId}/turns/stream`), {
    method: "POST",
    headers,
    body: JSON.stringify({ text }),
    cache: "no-store",
  });

  if (!response.ok) {
    const parsed = await parseResponse(response);
    if (isOwnerAuthFailure(response.status, parsed)) {
      clearOwnerSessionToken({
        notifyOtherTabs:
          isRecord(parsed) && parsed.detail === "Vault is locked",
      });
    }
    throw new ApiError(errorMessage(parsed, "流式会话启动失败"), response.status, parsed);
  }

  if (!response.body) {
    throw contractError("流式会话接口没有返回可读数据流", response);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  async function flushLine(rawLine: string) {
    const line = rawLine.trim();
    if (!line) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw contractError("流式会话接口返回了无效 NDJSON 行", rawLine);
    }
    const event = asRealtimeEvent(parsed, "流式会话接口");
    if (event.type === "error") {
      throw new ApiError(
        eventErrorMessage(event) ?? "流式会话返回 error 事件",
        502,
        event.payload,
      );
    }
    onEvent(event);
  }

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      await flushLine(line);
    }
    if (done) {
      break;
    }
  }

  if (buffer.trim()) {
    await flushLine(buffer);
  }
}

export async function createRealtimeTicket(sessionId: string) {
  const payload = apiData(await apiClient().POST("/api/v1/sessions/{session_id}/realtime-ticket", { params: { path: { session_id: sessionId } } }), "无法签发实时票据");
  const record = expectRecord(payload, "实时会话票据接口");
  if (typeof record.ticket !== "string" || typeof record.expires_at !== "string") {
    throw contractError("实时会话票据接口字段无效", payload);
  }
  return record as unknown as RealtimeTicketResponseWire;
}

export async function listSessions(spaceId?: string) {
  if (spaceId) {
    const payload = await request<unknown>(`/api/v1/spaces/${spaceId}/sessions`);
    return expectArray<unknown>(payload, "会话列表接口").map((value) => {
      const session = decodeSessionRecordWire(value, "会话列表接口.session");
      if (session.space_id !== spaceId) {
        throw contractError("会话接口返回了其他空间的数据，已拒绝展示", session);
      }
      return toSessionSummary(session);
    });
  }

  const spaces = await loadSpacesWire();
  const sessionsBySpace = await Promise.all(
    spaces.map(async (space) => {
      const payload = await request<unknown>(`/api/v1/spaces/${space.id}/sessions`);
      return expectArray<unknown>(payload, "会话列表接口").map((value) => {
        const session = decodeSessionRecordWire(value, "会话列表接口.session");
        if (session.space_id !== space.id) {
          throw contractError("会话接口返回了其他空间的数据，已拒绝聚合", session);
        }
        return toSessionSummary(session, { spaceTitle: space.name });
      });
    }),
  );
  return sessionsBySpace.flat();
}

export async function getSession(sessionId: string) {
  const payload = apiData(await apiClient().GET("/api/v1/sessions/{session_id}", { params: { path: { session_id: sessionId } } }), "无法读取会话");
  const record = expectRecord(payload, "会话详情接口");
  const sessionWire = decodeSessionRecordWire(record.session, "会话详情接口.session");
  const spaces = await loadSpacesWire();
  return toSessionDetail({
    session: sessionWire,
    turns: expectArrayField(record, "turns", "会话详情接口"),
    memory_candidates: record.memory_candidates as MemoryItemWire[] | undefined,
    review_items: record.review_items as ReviewItemWire[] | undefined,
  }, {
    spaceTitle: spaces.find((space) => space.id === sessionWire.space_id)?.name,
  });
}

export async function endSession(sessionId: string, summary = "") {
  const payload = await request<unknown>(`/api/v1/sessions/${sessionId}/end`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ summary }),
  });
  return decodeSessionRecordWire(payload, "会话结束接口");
}

export async function saveSessionRecap(
  sessionId: string,
  input: { summary: string; notes: string },
) {
  const payload = await request<unknown>(`/api/v1/sessions/${sessionId}/recap`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const record = expectRecord(payload, "会话复盘保存接口");
  const sessionWire = decodeSessionRecordWire(record.session, "会话复盘保存接口.session");
  const spaces = await loadSpacesWire();
  return toSessionDetail({
    session: sessionWire,
    turns: expectArrayField(record, "turns", "会话复盘保存接口"),
    memory_candidates: record.memory_candidates as MemoryItemWire[] | undefined,
    review_items: record.review_items as ReviewItemWire[] | undefined,
  }, {
    spaceTitle: spaces.find((space) => space.id === sessionWire.space_id)?.name,
  });
}

export async function undoSessionRecap(sessionId: string) {
  const payload = await request<unknown>(`/api/v1/sessions/${sessionId}/recap/undo`, {
    method: "POST",
  });
  const record = expectRecord(payload, "会话复盘撤销接口");
  const sessionWire = decodeSessionRecordWire(record.session, "会话复盘撤销接口.session");
  const spaces = await loadSpacesWire();
  return toSessionDetail({
    session: sessionWire,
    turns: expectArrayField(record, "turns", "会话复盘撤销接口"),
    memory_candidates: record.memory_candidates as MemoryItemWire[] | undefined,
    review_items: record.review_items as ReviewItemWire[] | undefined,
  }, {
    spaceTitle: spaces.find((space) => space.id === sessionWire.space_id)?.name,
  });
}
