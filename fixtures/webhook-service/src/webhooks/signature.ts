export interface ParsedSignature {
  timestamp: number;
  signatures: string[];
}

const TOLERANCE_SECONDS = 300;

export function parseSignatureHeader(header: string): ParsedSignature {
  const parts = header.split(",").map((part) => part.split("="));
  const timestamp = Number(parts.find(([key]) => key === "t")?.[1] ?? 0);
  const signatures = parts.filter(([key]) => key === "v1").map(([, value]) => value ?? "");
  return { timestamp, signatures };
}

export function verifySignature(payload: string, header: string, secret: string): boolean {
  const { timestamp, signatures } = parseSignatureHeader(header);
  const ageSeconds = Math.abs(Date.now() / 1000 - timestamp);
  if (!timestamp || ageSeconds > TOLERANCE_SECONDS) {
    return false;
  }
  const expected = sign(`${timestamp}.${payload}`, secret);
  return signatures.includes(expected);
}

function sign(message: string, secret: string): string {
  let hash = 0;
  for (const char of secret + message) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return hash.toString(16);
}
