import type { components } from "@companion-space/api-client/schema";

export type LessonEvent = components["schemas"]["LessonEvent"];

export class Timeline {
  private queued = new Map<number, LessonEvent>();
  private cancelled = new Map<number, number>();
  private processing = false;
  private closed = false;
  private cursor: number;
  private active: { event: LessonEvent; abort: AbortController } | undefined;

  constructor(
    after: number,
    private execute: (event: LessonEvent, signal: AbortSignal) => Promise<void>,
    private onError: (error: unknown) => void,
  ) {
    this.cursor = after;
  }

  get heardSeq() { return this.cursor; }
  get playingGen() {
    if (this.active) return this.active.event.gen;
    return this.queued.get(this.cursor + 1)?.gen;
  }

  append(event: LessonEvent) {
    if (this.closed || event.seq <= this.cursor) return;
    if (event.type === "beat.cancelled") this.cancel(event.gen, event.seq);
    this.queued.set(event.seq, event);
    if (!this.processing) void this.drain();
  }

  cancel(gen: number, through = Infinity) {
    this.cancelled.set(gen, through);
    if (this.active?.event.gen === gen) this.active.abort.abort();
  }

  dispose() {
    this.closed = true;
    this.queued.clear();
    this.active?.abort.abort();
  }

  private async drain() {
    this.processing = true;
    try {
      while (!this.closed) {
        const event = this.queued.get(this.cursor + 1);
        if (!event) break;
        this.queued.delete(event.seq);
        if (event.seq >= (this.cancelled.get(event.gen) ?? 0) || event.type === "state") {
          const abort = new AbortController();
          this.active = { event, abort };
          try { await this.execute(event, abort.signal); }
          catch (error) { if (!abort.signal.aborted) this.onError(error); }
        }
        this.cursor = event.seq;
      }
    } finally {
      this.active = undefined;
      this.processing = false;
    }
  }
}

export function captionDelay(text: string, rate = 1) {
  const han = text.match(/\p{Script=Han}/gu)?.length ?? 0;
  const words = text.match(/[a-z0-9]+(?:['-][a-z0-9]+)*/gi)?.length ?? 0;
  return Math.max(1500, han * 150 + words * 240) / rate;
}

export function waitFor(ms: number, signal: AbortSignal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = window.setTimeout(finish, ms);
    function finish() {
      window.clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}
