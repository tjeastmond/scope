const PLACEHOLDER = "[REDACTED]";

/** High-confidence credential shapes. Anything matched is replaced before source is parsed, shown or sent. */
const PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:sk|pk|rk)[-_](?:live|test|proj|ant)?[-_]?[A-Za-z0-9_-]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  // A quoted literal assigned to a credential-like name: apiKey = "...", "password": "...".
  /(?<=(?:api[_-]?key|secret|token|passw(?:or)?d|credential)s?["']?\s*[:=]\s*["'])[^"'\n]{8,}(?=["'])/gi,
];

/**
 * Replaces credential-looking text with a placeholder, keeping the line count so source locations stay valid.
 * Best-effort: it catches common shapes, not every secret, so excluding files remains the primary defense.
 */
export function redactSecrets(source: string): string {
  return PATTERNS.reduce(
    (text, pattern) => text.replace(pattern, (match) => PLACEHOLDER + "\n".repeat(match.split("\n").length - 1)),
    source,
  );
}
