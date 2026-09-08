// _warmup/pack.ts — loads the active campaign pack and answers every question that depends on it.
//
// The engine holds no campaign content, so essentially every decision it makes routes through
// here: what day it is, whether now is a quiet hour, what a copy_key says. Nothing in this file
// knows what any campaign actually contains.
//
// All time maths resolves through pack.manifest.timezone via Intl, never through the process
// timezone and never through a hardcoded UTC offset. broadcast-core hardcodes UTC+5 for Tashkent,
// which is correct there and would be a bug here — the pack names its own zone, and a campaign in
// a DST-observing zone would drift by an hour twice a year.

import type { CampaignPack, CopyEntry } from "./types.ts";

// ─── in-memory cache ─────────────────────────────────────────────────────────
// One warm edge instance serves many requests; re-fetching a ~100KB pack per event is waste. The
// TTL bounds how long a just-activated pack takes to reach an already-warm instance.

const CACHE_TTL_MS = 60_000;
let cached: { pack: CampaignPack; version: string; at: number } | null = null;

/** Drop the cached pack. Call after activating or rolling back a pack in the same process. */
export function invalidatePackCache(): void {
  cached = null;
}

/** The cached pack without touching the database, or null. For logging and tests. */
export function peekPack(): { version: string; ageMs: number } | null {
  return cached ? { version: cached.version, ageMs: Date.now() - cached.at } : null;
}

/**
 * The single pack with status='active' (warmup.campaign_pack has a partial unique index that makes
 * "active" singular). Throws when there is none — every caller needs a pack, and continuing
 * without one would mean inventing content.
 */
export async function loadActivePack(admin: any, opts?: { force?: boolean }): Promise<CampaignPack> {
  if (!opts?.force && cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.pack;

  const { data, error } = await admin
    .schema("warmup").from("campaign_pack")
    .select("version, pack").eq("status", "active").maybeSingle();

  if (error) {
    // A stale pack beats no pack: the campaign keeps running through a transient DB blip rather
    // than going silent mid-funnel.
    if (cached) return cached.pack;
    throw new Error(`warmup: cannot load active pack: ${error.message}`);
  }
  if (!data) {
    if (cached) return cached.pack;
    throw new Error("warmup: no active campaign pack");
  }

  cached = { pack: data.pack as CampaignPack, version: data.version, at: Date.now() };
  return cached.pack;
}

// ─── timezone helpers ────────────────────────────────────────────────────────

interface ZonedParts { year: number; month: number; day: number; hour: number; minute: number }

/** Wall-clock parts of `at` as seen in `tz`. */
export function zonedParts(at: Date, tz: string): ZonedParts {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).formatToParts(at);
  const get = (t: string) => Number(p.find((x) => x.type === t)!.value);
  // Intl renders midnight as hour 24 in some runtimes; normalise so 24:00 is 00:00.
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour") % 24, minute: get("minute") };
}

/** 'YYYY-MM-DD' as seen in `tz` — the campaign's notion of "today". */
export function zonedDateKey(at: Date, tz: string): string {
  const { year, month, day } = zonedParts(at, tz);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** The UTC instant of a wall-clock time in `tz`, resolved by probing the zone's real offset. */
export function zonedTimeToInstant(dateKey: string, hhmm: string, tz: string): Date {
  const [y, m, d] = dateKey.split("-").map(Number);
  const [hh, mi] = hhmm.split(":").map(Number);
  // Start from the naive UTC reading, then correct by the offset that zone actually had at that
  // moment. Two passes settle DST boundaries, where the offset depends on the answer.
  let guess = Date.UTC(y, m - 1, d, hh, mi, 0, 0);
  for (let i = 0; i < 2; i++) {
    const seen = zonedParts(new Date(guess), tz);
    const seenUtc = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute, 0, 0);
    const drift = Date.UTC(y, m - 1, d, hh, mi, 0, 0) - seenUtc;
    if (drift === 0) break;
    guess += drift;
  }
  return new Date(guess);
}

const minutesOf = (hhmm: string): number => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

// ─── campaign calendar ───────────────────────────────────────────────────────

/**
 * Day number within the campaign, 1-based, or null outside it. Counted in calendar days in the
 * pack timezone, so it never shifts by an hour under DST.
 */
export function campaignDayFor(pack: CampaignPack, at: Date): number | null {
  const tz = pack.manifest.timezone;
  const today = zonedDateKey(at, tz);
  const [sy, sm, sd] = pack.manifest.starts_on.split("-").map(Number);
  const [ty, tm, td] = today.split("-").map(Number);
  const days = Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(sy, sm - 1, sd)) / 86_400_000);
  const day = days + 1;
  return day >= 1 && day <= pack.manifest.duration_days ? day : null;
}

/** True when `at` falls on a pack-defined event date. Event days get their own channel budget. */
export function isEventDay(pack: CampaignPack, at: Date): boolean {
  const today = zonedDateKey(at, pack.manifest.timezone);
  return (pack.events || []).some((e) => e.date === today);
}

// ─── quiet hours ─────────────────────────────────────────────────────────────

/** True when `at` is inside the pack's quiet window. Handles a window crossing midnight. */
export function isQuietHour(pack: CampaignPack, at: Date): boolean {
  const { from, to } = pack.schedule.quiet_hours;
  const { hour, minute } = zonedParts(at, pack.manifest.timezone);
  const now = hour * 60 + minute;
  const start = minutesOf(from), end = minutesOf(to);
  return start > end ? (now >= start || now < end) : (now >= start && now < end);
}

/** The next instant the quiet window opens. Returns `at` unchanged when already open. */
export function nextWindowOpen(pack: CampaignPack, at: Date): Date {
  if (!isQuietHour(pack, at)) return at;
  const tz = pack.manifest.timezone;
  const { to } = pack.schedule.quiet_hours;
  const today = zonedDateKey(at, tz);
  const candidate = zonedTimeToInstant(today, to, tz);
  if (candidate > at) return candidate;
  const [y, m, d] = today.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return zonedTimeToInstant(zonedDateKey(next, tz), to, tz);
}

// ─── copy resolution ─────────────────────────────────────────────────────────

/** FNV-1a. Small, dependency-free, and — the only property that matters — deterministic. */
function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export class CopyKeyMissingError extends Error {
  constructor(public readonly copyKey: string) {
    super(`warmup: copy_key not in pack: ${copyKey}`);
    this.name = "CopyKeyMissingError";
  }
}

/**
 * Resolve a copy_key to the text that will actually be sent.
 *
 * Variant choice is a hash of `variantSeed`, never Math.random: a replayed event must produce the
 * byte-identical message, or "replay changes nothing" quietly stops being true for sends. Seed it
 * with something stable and per-recipient (telegram_id + day), so different people see different
 * variants while any one person sees a stable one.
 *
 * Missing keys throw rather than degrading to an empty string — a silently blank Telegram message
 * is a content bug that would otherwise reach participants. Agent C's validator is what stops this
 * happening at runtime; this is the backstop.
 */
export function resolveCopy(
  pack: CampaignPack,
  copyKey: string,
  opts?: { vars?: Record<string, string | number>; variantSeed?: string },
): string {
  const entry: CopyEntry | undefined = pack.copy?.[copyKey];
  if (!entry) throw new CopyKeyMissingError(copyKey);

  let text: string | undefined;
  if (Array.isArray(entry.variants) && entry.variants.length > 0) {
    const idx = hash32(opts?.variantSeed ?? copyKey) % entry.variants.length;
    text = entry.variants[idx];
  } else {
    text = entry.text;
  }
  if (typeof text !== "string") throw new CopyKeyMissingError(copyKey);

  const vars = opts?.vars;
  if (!vars) return text;
  // {name} interpolation. An unknown placeholder is left as-is: visible in a test, harmless live.
  return text.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

/** Every copy_key a pack defines. Used by the validator and by dry runs. */
export function copyKeys(pack: CampaignPack): string[] {
  return Object.keys(pack.copy ?? {});
}
