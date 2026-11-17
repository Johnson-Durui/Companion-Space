export const CSA1_HEADER_BYTES = 16;
export const CSA1_FLAG_LAST = 1;

export interface Csa1Frame {
  flags: number;
  gen: number;
  payload: ArrayBuffer;
  seg: number;
}

export function parseCsa1Frame(data: ArrayBuffer): Csa1Frame {
  if (data.byteLength < CSA1_HEADER_BYTES) throw new Error("Audio frame is shorter than the CSA1 header.");
  const view = new DataView(data);
  if (String.fromCharCode(...new Uint8Array(data, 0, 4)) !== "CSA1") {
    throw new Error("Audio frame has an invalid CSA1 signature.");
  }
  const reserved = view.getUint16(14, false);
  if (reserved !== 0) throw new Error("Audio frame uses unsupported CSA1 header bits.");
  return {
    gen: view.getUint32(4, false),
    seg: view.getUint32(8, false),
    flags: view.getUint16(12, false),
    payload: data.slice(CSA1_HEADER_BYTES),
  };
}

interface PendingSegment<T> {
  complete: boolean;
  values: T[];
}

export interface OrderedValue<T> {
  last: boolean;
  seg: number;
  value: T | null;
}

/** Keeps one generation ordered while allowing the current segment to stream. */
export class OrderedGenerationQueue<T> {
  private expectedSeg = 1;
  private gen = 0;
  private readonly pending = new Map<number, PendingSegment<T>>();

  setGeneration(gen: number) {
    if (gen < this.gen) return false;
    if (gen !== this.gen) {
      this.gen = gen;
      this.expectedSeg = 1;
      this.pending.clear();
    }
    return true;
  }

  reset(gen: number, firstSeg = 1) {
    this.gen = gen;
    this.expectedSeg = firstSeg;
    this.pending.clear();
  }

  push(gen: number, seg: number, value: T | null, last = false): OrderedValue<T>[] {
    if (gen !== this.gen || seg < this.expectedSeg) return [];
    if (seg === this.expectedSeg) {
      const ready = [{ seg, value, last }];
      if (last) {
        this.expectedSeg += 1;
        this.drain(ready);
      }
      return ready;
    }
    const pending = this.pending.get(seg) ?? { complete: false, values: [] };
    if (value !== null) pending.values.push(value);
    pending.complete ||= last;
    this.pending.set(seg, pending);
    return [];
  }

  private drain(ready: OrderedValue<T>[]) {
    while (true) {
      const next = this.pending.get(this.expectedSeg);
      if (!next) return;
      this.pending.delete(this.expectedSeg);
      next.values.forEach((value, index) => ready.push({
        seg: this.expectedSeg,
        value,
        last: next.complete && index === next.values.length - 1,
      }));
      if (next.complete && next.values.length === 0) {
        ready.push({ seg: this.expectedSeg, value: null, last: true });
      }
      if (!next.complete) return;
      this.expectedSeg += 1;
    }
  }
}
