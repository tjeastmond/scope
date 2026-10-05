export function format(cents: number, currency: string): string {
  return new Intl.NumberFormat("de-DE", { style: "currency", currency }).format(cents / 100);
}
