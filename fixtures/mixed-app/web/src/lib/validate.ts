export function validate(input: { number: string; totalCents: number }): string[] {
  const problems: string[] = [];
  if (!/^INV-\d{4,}$/.test(input.number)) problems.push("number must look like INV-0001");
  if (!Number.isInteger(input.totalCents) || input.totalCents < 0) problems.push("total must be a non-negative integer");
  return problems;
}
