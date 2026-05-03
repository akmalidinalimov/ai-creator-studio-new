/**
 * Format a number using Uzbek (uz-UZ) locale conventions.
 * Uses non-breaking spaces as thousands separator (e.g. 1 000 000).
 */
export function formatNumberUz(value: number | null | undefined, fractionDigits = 0): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  try {
    return new Intl.NumberFormat("uz-UZ", {
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    }).format(value);
  } catch {
    return String(value);
  }
}

export function formatDateUz(input: string | Date | null | undefined): string {
  if (!input) return "—";
  const d = typeof input === "string" ? new Date(input) : input;
  if (Number.isNaN(d.getTime())) return "—";
  try {
    return new Intl.DateTimeFormat("uz-UZ", { year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}
