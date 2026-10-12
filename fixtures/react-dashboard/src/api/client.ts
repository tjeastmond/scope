export const API_BASE = "/api/v1";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function buildUrl(path: string, params: Record<string, string> = {}): string {
  const query = new URLSearchParams(params).toString();
  return `${API_BASE}${path}${query ? `?${query}` : ""}`;
}

export async function apiGet<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const response = await fetch(buildUrl(path, params), { headers: { Accept: "application/json" } });
  if (!response.ok) {
    throw new ApiError(response.status, `Request to ${path} failed with ${response.status}`);
  }
  return (await response.json()) as T;
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(buildUrl(path), {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new ApiError(response.status, `Request to ${path} failed with ${response.status}`);
  }
  return (await response.json()) as T;
}
