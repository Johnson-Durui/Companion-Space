import { describe, expect, it } from "vitest";
import { readDiagnosticStream } from "../src/features/settings/chat-stream";

const encode = (text: string) => new TextEncoder().encode(text);

function streamChunks(chunks: Uint8Array[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

describe("diagnostic stream", () => {
  it("preserves Unicode and LaTeX split across network chunks", async () => {
    const value = "令 θ = \\frac{a}{b}\n";
    const lines = [JSON.stringify({ type: "delta", text: value }), JSON.stringify({ type: "done" })].join("\n");
    const bytes = encode(lines);
    const chunks = Array.from(bytes, (byte) => Uint8Array.of(byte));
    const output: string[] = [];
    await readDiagnosticStream(streamChunks(chunks), (delta) => output.push(delta));
    expect(output.join("")).toBe(value);
  });

  it("retains partial visible output and propagates reported errors", async () => {
    const chunks = ['{"type":"delta","text":"visible"}\n', '{"type":"error","message":"service unavailable"}\n'];
    const output: string[] = [];
    await expect(readDiagnosticStream(streamChunks(chunks.map(encode)), (delta) => output.push(delta))).rejects.toThrow("service unavailable");
    expect(output).toEqual(["visible"]);
  });

  it("treats a stream closed before completion as incomplete", async () => {
    await expect(readDiagnosticStream(streamChunks([encode('{"type":"delta","text":"partial"}\n')]), () => {})).rejects.toThrow();
  });
});
