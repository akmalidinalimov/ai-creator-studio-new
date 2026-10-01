// engagement-targeting — WHO the automatic student reminders go to, and where a trial student's button lands.
//
// Owner decisions after #228 (the watch-button audit, 2026-09-30), each behind its own switch in
//   platform_settings.engagement_targeting = {
//     "skip_closed_courses":          true,  // no daily / streak / drip / smart inactive nudge to a student who
//                                            // has NO published course (today: 412 AI CREATORS 4.0 graduates,
//                                            // ~390 of ~540 daily reminders, a button to a lesson RLS hides)
//     "trial_to_course_page":         true,  // a trial (account_type 'provisional') student's reminder button
//                                            // opens the course page (the trial card), not a locked lesson
//     "retire_smart_inactive_nudges": true   // detect-and-nudge stops its inactive_3d / inactive_7d nudges: the
//                                            // cron-engagement drip already sends day 3 / 7 / 14 / 30, and 68-78%
//                                            // of the smart ones landed within 2 days of a drip message
//   }
//
// FAIL-CLOSED TO TODAY'S BEHAVIOUR: only a JSON boolean `true` turns a switch on. An absent row, a missing key,
// the string "true", or a read error = off = exactly what the senders did before this change. A read error is
// never cached (the next call retries) and is returned so the caller can make it DB-visible.
//
// "Closed" is the same bit RLS uses to hide lessons (courses.published = false), so a skipped student is, by
// construction, one whose every lesson link would open a locked page. A student who ALSO has a published course
// is never skipped: the reminder is re-pointed at that course instead.
//
// Pure: no imports, no Deno or DOM APIs. The SAME FILE, byte for byte, is
//   supabase/functions/_shared/engagement-targeting.ts   (cron-engagement, detect-and-nudge)
//   src/lib/engagementTargeting.ts                       (the admin switch card)
// src/test/engagement-targeting-parity.test.ts fails if the two copies drift. Edit one, copy it over the other.

export const ENGAGEMENT_TARGETING_KEY = "engagement_targeting";

export const TARGETING_SWITCHES = [
  "skip_closed_courses",
  "trial_to_course_page",
  "retire_smart_inactive_nudges",
] as const;
export type TargetingSwitch = (typeof TARGETING_SWITCHES)[number];
export type EngagementTargeting = Record<TargetingSwitch, boolean>;

export const TARGETING_OFF: EngagementTargeting = Object.freeze({
  skip_closed_courses: false,
  trial_to_course_page: false,
  retire_smart_inactive_nudges: false,
});

/** platform_settings.engagement_targeting.value → the switches. Only a JSON boolean `true` turns one on. */
export function parseEngagementTargeting(value: unknown): EngagementTargeting {
  const v = (value && typeof value === "object" && !Array.isArray(value)) ? value as Record<string, unknown> : null;
  return {
    skip_closed_courses: v?.skip_closed_courses === true,
    trial_to_course_page: v?.trial_to_course_page === true,
    retire_smart_inactive_nudges: v?.retire_smart_inactive_nudges === true,
  };
}

/** The value to write when one switch is flipped: every other key of the stored object is kept as it was. */
export function withTargetingSwitch(value: unknown, key: TargetingSwitch, on: boolean): Record<string, unknown> {
  const base = (value && typeof value === "object" && !Array.isArray(value)) ? value as Record<string, unknown> : {};
  return { ...base, [key]: on === true };
}

// ─────────────────────────── the reader (edge functions) ───────────────────────────
let cache: { v: EngagementTargeting; at: number } | null = null;
const TTL_MS = 60_000;

/** Test hook: forget the cached switches. */
export function _resetEngagementTargetingCache() {
  cache = null;
}

/**
 * The switches, cached 60 s per isolate. FAIL-CLOSED: an absent row or a malformed value gives TARGETING_OFF
 * (today's behaviour) with error null; a read error or a throw gives TARGETING_OFF with the error text, and is
 * not cached. Never throws.
 */
export async function loadEngagementTargeting(
  // deno-lint-ignore no-explicit-any
  admin: any,
  now: number = Date.now(),
): Promise<{ targeting: EngagementTargeting; error: string | null }> {
  if (cache && now - cache.at < TTL_MS) return { targeting: cache.v, error: null };
  try {
    const { data, error } = await admin.from("platform_settings").select("value")
      .eq("key", ENGAGEMENT_TARGETING_KEY).maybeSingle();
    if (error) return { targeting: { ...TARGETING_OFF }, error: String(error.message ?? error).slice(0, 200) };
    const v = parseEngagementTargeting(data?.value);
    cache = { v, at: now };
    return { targeting: v, error: null };
  } catch (e) {
    return { targeting: { ...TARGETING_OFF }, error: String((e as Error)?.message ?? e).slice(0, 200) };
  }
}

// ─────────────────────────── the closed-course rule ───────────────────────────
export type ReminderCourse = {
  /** The course the reminder links to, or null = no course-linked reminder (as before, or skipped). */
  courseId: string | null;
  /** True only when skip_closed_courses dropped the reminder: the student has no published course at all. */
  closed: boolean;
  /** True when the resolved course was closed and another enrolled, PUBLISHED course was used instead. */
  redirected: boolean;
};

/**
 * Which course a student's reminder links to.
 *   resolved   the sender's usual answer (cron-engagement: group course → first enrollment → platform default;
 *              detect-and-nudge: group course → first enrollment), or null when it has none
 *   published  course id → courses.published, or null when that read failed
 *   enrolled   the student's enrolled course ids, or null when unknown
 * Anything unknown (switch off, read failed, a course id missing from the map) keeps TODAY'S answer — the rule
 * only ever drops a reminder when it KNOWS the resolved course is closed and no enrolled course is open.
 */
export function decideReminderCourse(
  resolved: string | null,
  skipClosed: boolean,
  published: ReadonlyMap<string, boolean> | null,
  enrolled: readonly string[] | null,
): ReminderCourse {
  if (!resolved) return { courseId: null, closed: false, redirected: false };
  if (!skipClosed || !published || published.get(resolved) !== false || !enrolled) {
    return { courseId: resolved, closed: false, redirected: false };
  }
  const open = enrolled.find((c) => c !== resolved && published.get(c) === true);
  if (open) return { courseId: open, closed: false, redirected: true };
  return { courseId: null, closed: true, redirected: false };
}
