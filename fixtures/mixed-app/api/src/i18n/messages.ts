export const messages = {
  de: { paid: "Bezahlt", overdue: "Überfällig" },
  ja: { paid: "支払い済み", overdue: "期限切れ" },
  ru: { paid: "Оплачено", overdue: "Просрочено" },
};

export function translate(locale: keyof typeof messages, key: "paid" | "overdue"): string {
  return messages[locale][key];
}

export function naïveSlug(title: string): string {
  return title.normalize("NFKD").replace(/[^\w]+/g, "-").toLowerCase();
}

export const 税率 = 0.19;

export function 合計(cents: number): number {
  return Math.round(cents * (1 + 税率));
}
