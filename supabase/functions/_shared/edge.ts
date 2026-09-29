// Shared edge-function scaffold: CORS, JSON responses, and DB-visible health logging.
//
// Every function inherits the incident-doctrine default ("a real failure is DB-visible, never
// console-only") instead of copy-pasting it — corsHeaders is currently duplicated in ~58 functions,
// json() in ~19, and logHealth in 3 (hw-image-url / hw-audio-url / notify-grade-voice each have a
// near-identical local copy). New functions should import these; existing ones migrate opportunistically.

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/** JSON response with CORS. `extraHeaders` lets a caller add e.g. a marker header. */
export function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", ...extraHeaders },
  });
}

/**
 * Best-effort, non-blocking DB-visible health signal (incident-doctrine step 5): a real failure lands
 * in `admin_actions` so the watchdog/digest layer can see it before the next complaint. Never throws,
 * never blocks the real response, and must never carry a secret (the caller controls `details`).
 * `admin` is a service-role Supabase client. Resolves true when the row was written.
 */
export async function logHealth(
  admin: any,
  action: string,
  details: Record<string, unknown>,
  opts?: HealthOpts,
): Promise<boolean> {
  try {
    const { error } = await admin.from("admin_actions").insert({
      actor_user_id: opts?.actorUserId ?? null,
      action,
      target_user_id: opts?.targetUserId ?? null,
      target_resource_type: opts?.targetResourceType ?? null,
      target_resource_id: opts?.targetResourceId ?? null,
      details: { ...details, source: opts?.source ?? "edge" },
    });
    if (error) {
      console.error(`logHealth insert failed (${action})`, error.message);
      return false;
    }
    return true;
  } catch (e) {
    console.error(`logHealth threw (${action})`, String(e));
    return false;
  }
}

export type HealthOpts = {
  actorUserId?: string | null;
  source?: string;
  targetUserId?: string | null;
  targetResourceType?: string | null;
  targetResourceId?: string | null;
};

const TASHKENT_OFFSET_MS = 5 * 3_600_000; // UTC+5, no DST — a fixed offset is exact
const DAY_MS = 86_400_000;

/** Start of the Tashkent calendar day containing `now`, as an ISO (UTC) timestamp. */
export function tashkentDayStartIso(now: Date = new Date()): string {
  const local = now.getTime() + TASHKENT_OFFSET_MS;
  const startLocal = local - (((local % DAY_MS) + DAY_MS) % DAY_MS);
  return new Date(startLocal - TASHKENT_OFFSET_MS).toISOString();
}

// Isolate-local burst guard for logHealthOnce. Bounded so a long-lived isolate can't grow it without limit.
const healthOnceSeen = new Set<string>();
const HEALTH_ONCE_MEMO_MAX = 2000;

/**
 * logHealth for a signal that a busy chat or a retrying caller could repeat: at most ONE admin_actions row
 * per (action, dedupeKey) since `sinceIso` (default: the start of the current Tashkent day). The key is
 * stored as details.dedupe_key, so the check is a created_at range read (idx_admin_actions_created_at)
 * plus a filter.
 *
 * Two layers. An isolate-local memo, claimed before the first await, stops a 10-photo album that lands on
 * one isolate from racing itself. The DB existence check stops other isolates and cold starts from logging
 * the key again. Two isolates checking the same key in the same instant can still both insert: an
 * occasional duplicate in a counter, never a flood. A failed existence check falls through to the insert,
 * because a lost signal is worse than a duplicate one. Never throws. Resolves true when it wrote a row.
 */
export async function logHealthOnce(
  admin: any,
  action: string,
  dedupeKey: string,
  details: Record<string, unknown>,
  opts?: HealthOpts & { sinceIso?: string },
): Promise<boolean> {
  const memoKey = `${tashkentDayStartIso()}|${action}|${dedupeKey}`;
  if (healthOnceSeen.has(memoKey)) return false;
  if (healthOnceSeen.size >= HEALTH_ONCE_MEMO_MAX) healthOnceSeen.clear();
  healthOnceSeen.add(memoKey);
  try {
    const { data, error } = await admin.from("admin_actions").select("id")
      .eq("action", action)
      .eq("details->>dedupe_key", dedupeKey)
      .gte("created_at", opts?.sinceIso ?? tashkentDayStartIso())
      .limit(1);
    if (error) console.error(`logHealthOnce check failed (${action})`, error.message);
    else if (Array.isArray(data) && data.length > 0) return false;
  } catch (e) {
    console.error(`logHealthOnce check threw (${action})`, String(e));
  }
  const ok = await logHealth(admin, action, { ...details, dedupe_key: dedupeKey }, opts);
  if (!ok) healthOnceSeen.delete(memoKey); // let a later call retry the write
  return ok;
}

/** How far back a grade_card_dm_skipped row suppresses another for the same attempt (= reconciler lookback). */
export const GRADE_CARD_SKIP_WINDOW_DAYS = 14;

/**
 * A grade card was owed for this graded attempt, but the student has no telegram_id, so no sender can
 * deliver it. Three paths send the card (bot grading in telegram-bot-webhook, notify-grade-voice for
 * app/web grading, and the grade-card-reconcile backstop every 30 min), and each skips such a student.
 * All three call this, so they share one key and one window: an attempt yields ONE row whichever path
 * sees it first, and the reconciler re-seeing it every run for 14 days adds nothing. An expected reach
 * gap, not a fault: a countable signal that no watchdog alarms on. Never throws.
 */
export function recordGradeCardSkipped(
  admin: any,
  p: {
    submissionId: string;
    studentId: string | null;
    attempt: number;
    source: string;
    actorUserId?: string | null;
    details?: Record<string, unknown>;
  },
): Promise<boolean> {
  return logHealthOnce(admin, "grade_card_dm_skipped", `no_telegram:${p.submissionId}:${p.attempt}`, {
    reason: "no_telegram", submission_id: p.submissionId, attempt: p.attempt, ...(p.details ?? {}),
  }, {
    source: p.source,
    actorUserId: p.actorUserId ?? null,
    targetUserId: p.studentId,
    targetResourceType: "homework_submission",
    targetResourceId: p.submissionId,
    sinceIso: new Date(Date.now() - GRADE_CARD_SKIP_WINDOW_DAYS * DAY_MS).toISOString(),
  });
}
