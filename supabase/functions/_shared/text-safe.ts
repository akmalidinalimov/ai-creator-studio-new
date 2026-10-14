// Text that is always valid UTF-8 when it leaves the function.
//
// WHY (2026-10-14): JavaScript strings are UTF-16. `.slice(0, n)` counts UTF-16 units, so cutting a string that holds
// emoji or "fancy" letters (𝐎𝐌𝐎𝐍𝐈𝐋𝐋𝐎 — Mathematical Bold, two units each) can leave HALF a character (a lone
// surrogate). Telegram then refuses the whole message: "Bad Request: … must be encoded in UTF-8". One student name cut
// at 24 in a curators' reminder button failed 48 sends in 4 hours, and 1-GURUH's curators got no reminders. A lone
// surrogate in a database write fails the same way (Postgres refuses it).
//
//   clip(s, n)          cut to at most n UTF-16 units, never inside a character (use instead of .slice(0, n))
//   wellFormed(s)       drop any lone surrogate already in a string
//   deepWellFormed(x)   the same for every string inside an object/array — the Telegram senders run every payload
//                       through it, so a stray cut anywhere can no longer break a send

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function wellFormed(s: string): string {
  return typeof s === "string" ? s.replace(LONE_SURROGATE, "") : s;
}

export function clip(s: string, n: number): string {
  const str = String(s ?? "");
  if (str.length <= n) return str;
  let out = str.slice(0, Math.max(0, n));
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);   // never end on half a character
  return out;
}

export function deepWellFormed<T>(x: T): T {
  if (typeof x === "string") return wellFormed(x) as unknown as T;
  if (Array.isArray(x)) return x.map((v) => deepWellFormed(v)) as unknown as T;
  if (x && typeof x === "object" && Object.getPrototypeOf(x) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(x as Record<string, unknown>)) out[k] = deepWellFormed(v);
    return out as T;
  }
  return x;
}
