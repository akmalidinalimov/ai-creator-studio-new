// Pure, dependency-free pieces of cron-engagement: local time, the reminder-window decision, and the
// keyset paginator. Split out so CI (`deno test supabase/functions/`) can pin the reminder rules — see
// core.test.ts. Nothing here touches the network except through the query builder it is handed.

// ─────────────────────────── local time (formatters cached per timezone) ───────────────────────────
// Same options as the old per-call constructions. `null` = the zone is not a valid IANA name (live data
// has "Moskva", "Swed", "Asia/Samarqand", ...): the old code's catch{} then used UTC, and so does this.
// Building a formatter costs ~0.1 ms of CPU; the old loop built four per user per tick (~2,300 per tick).
const TIME_OPTS: Intl.DateTimeFormatOptions = {
  hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
};
const DATE_OPTS: Intl.DateTimeFormatOptions = { year: "numeric", month: "2-digit", day: "2-digit" };
const timeFmtCache = new Map<string, Intl.DateTimeFormat | null>();
const dateFmtCache = new Map<string, Intl.DateTimeFormat | null>();

function cachedFmt(cache: Map<string, Intl.DateTimeFormat | null>, tz: string, opts: Intl.DateTimeFormatOptions) {
  const hit = cache.get(tz);
  if (hit !== undefined) return hit;
  let fmt: Intl.DateTimeFormat | null = null;
  try {
    fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, ...opts });
  } catch {
    fmt = null;
  }
  cache.set(tz, fmt);
  return fmt;
}

export function localTimeParts(tz: string, d: Date): { hour: number; minute: number; ymd: string } {
  const fmt = cachedFmt(timeFmtCache, tz, TIME_OPTS);
  if (fmt) {
    try {
      const parts = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));
      let h = parseInt(parts.hour || "0", 10);
      if (h === 24) h = 0;
      return { hour: h, minute: parseInt(parts.minute || "0", 10), ymd: `${parts.year}-${parts.month}-${parts.day}` };
    } catch { /* fall through to the UTC fallback, exactly as before */ }
  }
  return { hour: d.getUTCHours(), minute: d.getUTCMinutes(), ymd: d.toISOString().slice(0, 10) };
}

export function ymdInTz(tz: string, date: Date): string {
  const fmt = cachedFmt(dateFmtCache, tz, DATE_OPTS);
  if (fmt) {
    try {
      const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
      return `${parts.year}-${parts.month}-${parts.day}`;
    } catch { /* fall through, exactly as before */ }
  }
  return date.toISOString().slice(0, 10);
}

export function minutesBetween(h1: number, m1: number, h2: number, m2: number): number {
  return Math.abs(h1 * 60 + m1 - (h2 * 60 + m2));
}

// ─────────────────────────── which reminder windows apply ───────────────────────────
// Decided from the profile row and the clock ALONE — no database call — so a user outside every window
// costs nothing. Each rule is the old code's, word for word; the comments name the old condition.
export type WindowUser = {
  timezone?: string | null;
  reminder_time?: string | null;
  created_at: string;
  last_daily_reminder_at?: string | null;
  last_streak_warning_at?: string | null;
};
export type Windows = {
  tz: string;
  hour: number;
  minute: number;
  ymd: string;
  quiet: boolean; // local hour < 8: the old loop `continue`d before doing anything
  daily: boolean; // still needs: not watched today, and a course to link to
  streak: boolean; // still needs: current_streak >= 1, not watched today, and a course
  drip: boolean; // still needs the idle-days rule
  accountAgeDays: number;
};

export function reminderWindows(u: WindowUser, now: Date): Windows {
  const tz = u.timezone || "Asia/Tashkent";
  const { hour, minute, ymd } = localTimeParts(tz, now);
  const accountAgeDays = Math.floor((now.getTime() - new Date(u.created_at).getTime()) / 86_400_000);
  if (hour < 8) return { tz, hour, minute, ymd, quiet: true, daily: false, streak: false, drip: false, accountAgeDays };

  const lastDailyYmd = u.last_daily_reminder_at ? ymdInTz(tz, new Date(u.last_daily_reminder_at)) : null;
  const lastStreakYmd = u.last_streak_warning_at ? ymdInTz(tz, new Date(u.last_streak_warning_at)) : null;
  // (old) withinReminder && !reminderInQuiet && ... && lastDailyYmd !== ymd — including its quirks: an
  // unparseable or 00:xx reminder_time hour falls back to 20 via `rh || 20`, a :00 minute via `rm || 0`.
  const [rh, rm] = (u.reminder_time || "20:00:00").split(":").map((s: string) => parseInt(s, 10));
  const withinReminder = minutesBetween(hour, minute, rh || 20, rm || 0) <= 30;
  const reminderInQuiet = (rh || 20) < 8;
  const daily = withinReminder && !reminderInQuiet && lastDailyYmd !== ymd;
  // (old) within21 && ... && lastStreakYmd !== ymd
  const streak = minutesBetween(hour, minute, 21, 0) <= 30 && lastStreakYmd !== ymd;
  // (old) if (within12) { if (accountAgeDays < 3) continue; ... } — written as !(x < 3), not x >= 3, so that
  // it reads the same value the same way.
  const drip = minutesBetween(hour, minute, 12, 0) <= 30 && !(accountAgeDays < 3);
  return { tz, hour, minute, ymd, quiet: false, daily, streak, drip, accountAgeDays };
}

// ─────────────────────────── bulk reads ───────────────────────────
// Keyset pagination (order by a unique key, `key > last`) until an EMPTY page. It never trusts a short
// page to mean "done": PostgREST caps rows per response (1000 by default, lower if configured), and a
// truncated read here would look like "no activity" and send a reminder to someone who studied today.
// deno-lint-ignore no-explicit-any
export type Row = Record<string, any>;
export const PAGE_SIZE = 1000;
export const MAX_PAGES = 100;

export async function fetchAllKeyset(
  // deno-lint-ignore no-explicit-any
  admin: any,
  table: string,
  select: string,
  key: string,
  // deno-lint-ignore no-explicit-any
  filter: (q: any) => any,
  pageSize = PAGE_SIZE,
): Promise<{ rows: Row[]; error: string | null }> {
  const rows: Row[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    let q = filter(admin.from(table).select(select));
    if (after !== null) q = q.gt(key, after);
    const { data, error } = await q.order(key, { ascending: true }).limit(pageSize);
    if (error) return { rows, error: String(error.message || error) };
    if (!data || data.length === 0) return { rows, error: null };
    for (const r of data) rows.push(r);
    after = String(data[data.length - 1][key]);
  }
  return { rows, error: `more than ${MAX_PAGES} pages` };
}
