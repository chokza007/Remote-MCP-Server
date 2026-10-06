export interface OutputPage {
  readonly data: string;
  readonly nextOffset: number;
  readonly truncated: boolean;
  readonly truncatedBefore: number;
}

interface OutputChunk {
  readonly start: number;
  readonly end: number;
  readonly data: Buffer;
}

export class OutputBuffer {
  readonly #maxBytes: number;
  readonly #chunks: OutputChunk[] = [];
  #nextOffset = 0;
  #retainedBytes = 0;
  #truncatedBefore = 0;

  public constructor(maxBytes: number) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("Output buffer size must be positive");
    this.#maxBytes = maxBytes;
  }

  public append(value: string): void {
    let data = Buffer.from(value, "utf8");
    const end = this.#nextOffset + data.byteLength;
    if (data.byteLength > this.#maxBytes) {
      data = data.subarray(data.byteLength - this.#maxBytes);
    }
    const start = end - data.byteLength;
    this.#nextOffset = end;
    this.#chunks.push({ start, end, data });
    this.#retainedBytes += data.byteLength;
    while (this.#retainedBytes > this.#maxBytes && this.#chunks.length > 1) {
      const removed = this.#chunks.shift()!;
      this.#retainedBytes -= removed.data.byteLength;
    }
    this.#truncatedBefore = this.#chunks[0]?.start ?? this.#nextOffset;
  }

  public read(offset: number, limit: number): OutputPage {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Output offset must be non-negative");
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Output read limit must be positive");
    const truncated = offset < this.#truncatedBefore;
    const effectiveOffset = Math.max(offset, this.#truncatedBefore);
    const available = Buffer.concat(
      this.#chunks
        .filter((chunk) => chunk.end > effectiveOffset)
        .map((chunk) => chunk.data.subarray(Math.max(0, effectiveOffset - chunk.start)))
    );
    const selected = available.subarray(0, limit);
    const marker = truncated ? `[output truncated] before offset ${this.#truncatedBefore}\r\n` : "";
    return {
      data: marker + selected.toString("utf8"),
      nextOffset: effectiveOffset + selected.byteLength,
      truncated,
      truncatedBefore: this.#truncatedBefore
    };
  }

  public get nextOffset(): number {
    return this.#nextOffset;
  }
}
