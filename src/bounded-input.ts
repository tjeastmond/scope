import { open } from "node:fs/promises";
import { UsageError } from "./errors.ts";

const tooLarge = (label: string, maxBytes: number) => new UsageError(`${label} is larger than ${maxBytes} bytes.`);

/**
 * Reads a stream to the end as UTF-8 text, giving up as soon as more than `maxBytes` bytes have arrived: the chunk that
 * crosses the limit is the last one consumed, and nothing past it is buffered.
 */
export async function readBoundedText(
  stream: AsyncIterable<Uint8Array | string>,
  maxBytes: number,
  label: string,
): Promise<string> {
  const parts: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const part = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
    total += part.length;
    if (total > maxBytes) throw tooLarge(label, maxBytes);
    parts.push(part);
  }
  return Buffer.concat(parts).toString("utf8");
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
