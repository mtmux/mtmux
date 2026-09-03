/**
 * Reassemble a recording from `recording:chunk` messages.
 *
 * Pure over an injected send-and-subscribe pair, which is the whole reason it
 * is a module rather than a hook: vitest here runs `environment: "node"`, and
 * the risk surface — "does a resumed transfer produce the same bytes" — is a
 * question about arrays, not about React.
 *
 * The transport is the websocket rather than HTTP because the case this exists
 * for is a phone on cellular, which is the tunnelled case: there the relay has
 * no HTTP route at all and `resolveRelayHttpBase()` returns `""`.
 */

export type CastChunk = {
  id: string;
  offset: number;
  /** Base64. */
  data: string;
  totalBytes: number;
  final: boolean;
};

export type FetchTransport = {
  /** Send `recording:fetch`. */
  request(id: string, offset: number): void;
  /** Subscribe to chunks; returns an unsubscribe. */
  onChunk(listener: (chunk: CastChunk) => void): () => void;
};

export type FetchProgress = {
  receivedBytes: number;
  totalBytes: number;
};

export class CastFetchError extends Error {}

function decodeBase64(data: string): Uint8Array {
  const binary = atob(data);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Accumulates chunks and reports whether the transfer is whole.
 *
 * Separate from `fetchCast` so the assembly logic is testable without a
 * transport at all, and so a resume can hand back the offset it needs.
 */
export class CastAssembler {
  private readonly parts: Uint8Array[] = [];
  private received = 0;
  private total = 0;
  private done = false;

  /** Where a resumed `recording:fetch` should pick up. */
  get nextOffset(): number {
    return this.received;
  }

  get progress(): FetchProgress {
    return { receivedBytes: this.received, totalBytes: this.total };
  }

  get complete(): boolean {
    return this.done;
  }

  /**
   * Take one chunk. Returns true once the transfer is whole.
   *
   * A chunk whose offset is behind what we already have is dropped rather than
   * appended — that is what a resume after a dropped socket looks like, and
   * concatenating it would silently corrupt the file. A chunk that starts
   * *ahead* of what we have is a hole, and a hole is fatal: a `.cast` with a
   * gap in the middle parses, and plays back wrong.
   */
  push(chunk: CastChunk): boolean {
    this.total = chunk.totalBytes;

    if (chunk.offset > this.received) {
      throw new CastFetchError(
        `Recording arrived with a gap at byte ${this.received}.`,
      );
    }

    const bytes = decodeBase64(chunk.data);
    if (chunk.offset + bytes.length > this.received) {
      const skip = this.received - chunk.offset;
      const fresh = skip > 0 ? bytes.subarray(skip) : bytes;
      this.parts.push(fresh);
      this.received += fresh.length;
    }

    if (chunk.final) this.done = true;
    return this.done;
  }

  /** The assembled file as text. Throws if the transfer never finished. */
  text(): string {
    if (!this.done) {
      throw new CastFetchError("Recording transfer did not finish.");
    }
    const joined = new Uint8Array(this.received);
    let at = 0;
    for (const part of this.parts) {
      joined.set(part, at);
      at += part.length;
    }
    return new TextDecoder().decode(joined);
  }
}

export type FetchCastOptions = {
  transport: FetchTransport;
  id: string;
  onProgress?: (progress: FetchProgress) => void;
  signal?: AbortSignal;
};

/** Ask for a recording and resolve with its text once every chunk has landed. */
export function fetchCast(options: FetchCastOptions): Promise<string> {
  const assembler = new CastAssembler();

  return new Promise<string>((resolve, reject) => {
    const unsubscribe = options.transport.onChunk((chunk) => {
      if (chunk.id !== options.id) return;
      try {
        const done = assembler.push(chunk);
        options.onProgress?.(assembler.progress);
        if (done) {
          unsubscribe();
          resolve(assembler.text());
        }
      } catch (err) {
        unsubscribe();
        reject(err instanceof Error ? err : new CastFetchError(String(err)));
      }
    });

    options.signal?.addEventListener("abort", () => {
      unsubscribe();
      reject(new CastFetchError("Cancelled."));
    });

    options.transport.request(options.id, 0);
  });
}
