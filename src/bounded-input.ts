import { open } from "node:fs/promises";
import { CancelledError, UsageError } from "./errors.ts";

const tooLarge = (label: string, maxBytes: number) => new UsageError(`${label} is larger than ${maxBytes} bytes.`);

/**
 * Reads a stream to the end as UTF-8 text, giving up as soon as more than `maxBytes` bytes have arrived: the chunk that
 * crosses the limit is the last one consumed, and nothing past it is buffered. An aborted `signal` rejects with
 * `CancelledError` promptly, even while the stream yields nothing, and stops the stream.
 */
export async function readBoundedText(
  stream: AsyncIterable<Uint8Array | string>,
  maxBytes: number,
  label: string,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) throw new CancelledError();
  const parts: Buffer[] = [];
  let total = 0;
  const iterator = stream[Symbol.asyncIterator]();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    if (!signal) return;
    onAbort = () => reject(new CancelledError());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  aborted.catch(() => undefined); // never an unhandled rejection when the read finishes first
  let finished = false;
  try {
    while (true) {
      const next = await Promise.race([iterator.next(), aborted]);
      if (next.done) {
        finished = true;
        break;
      }
      const chunk = next.value;
      const part = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
      total += part.length;
      if (total > maxBytes) throw tooLarge(label, maxBytes);
      parts.push(part);
    }
    return Buffer.concat(parts).toString("utf8");
  } finally {
    if (onAbort) signal!.removeEventListener("abort", onAbort);
    // Stop the source; a pending read on a stream that never yields would block `return()`, so it is not awaited.
    if (!finished) void Promise.resolve(iterator.return?.()).catch(() => undefined);
  }
}

/** Reads a file as UTF-8 text with a bounded read: at most `maxBytes + 1` bytes are ever read. */
export async function readBoundedFile(path: string, maxBytes: number, label: string): Promise<string> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch {
    throw new UsageError(`--file could not be read: ${path}`);
  }
  try {
    const buffer = Buffer.alloc(maxBytes + 1);
    let filled = 0;
    try {
      while (filled < buffer.length) {
        const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, null);
        if (bytesRead === 0) break;
        filled += bytesRead;
      }
    } catch {
      throw new UsageError(`--file could not be read: ${path}`);
    }
    if (filled > maxBytes) throw tooLarge(label, maxBytes);
    return buffer.subarray(0, filled).toString("utf8");
  } finally {
    await handle.close();
  }
}
