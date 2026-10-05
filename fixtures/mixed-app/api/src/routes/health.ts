export async function handleHealth(_req: unknown, res: { end(body: string): void }): Promise<void> {
  res.end(JSON.stringify({ ok: true }));
}
