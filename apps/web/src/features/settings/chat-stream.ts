import t from "../../locales/zh-CN.json";

export async function readDiagnosticStream(body: ReadableStream<Uint8Array>, onDelta: (text: string) => void) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";

  function readLine(line: string) {
    if (!line.trim()) return false;
    const value: unknown = JSON.parse(line);
    if (!value || typeof value !== "object" || !("type" in value)) throw new Error(t.diagnostics.streamError);
    if (value.type === "done") return true;
    if (value.type === "delta" && "text" in value && typeof value.text === "string") {
      onDelta(value.text);
      return false;
    }
    if (value.type === "error") {
      throw new Error("message" in value && typeof value.message === "string" ? value.message : t.diagnostics.failed);
    }
    throw new Error(t.diagnostics.streamError);
  }

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        if (readLine(pending + decoder.decode())) return;
        throw new Error(t.diagnostics.streamError);
      }
      pending += decoder.decode(value, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      if (lines.some(readLine)) return;
    }
  } finally {
    // Cancellation closes the upstream response after its terminal event.
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
