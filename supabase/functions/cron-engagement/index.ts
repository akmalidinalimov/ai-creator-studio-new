// Engagement cron: daily reminders, streak warnings, re-engagement drips.
// Invoked every 30 minutes by the pg_cron job `cron-engagement-every-30-min`.
// Quiet hours: skip 00:00-08:00 local time. Skip users with notifications_enabled=false.
// v2.0.1: All copy is now loaded from public.notification_templates (admin-editable).
//
// v3 (2026-09-27) — it must never be killed mid-run again.
// WHY: the old loop made ~5 database round-trips and built 4 `Intl.DateTimeFormat` objects for EVERY
// eligible user (~572) on EVERY tick, before it even asked whether a reminder window applied. Daytime
// ticks spent 25-51 s doing nothing; in the Tashkent 19:30-21:30 window the platform killed it ("CPU Time
// exceeded" 5x on 2026-09-25 and 3x on 09-26, plus a 150 s wall-clock shutdown at 15:30 UTC), so 74
// eligible students got no daily reminder on 09-26 — and nothing alarmed. Now:
//   * which windows apply is decided from the profile row and the clock ALONE; a user outside every
//     window costs no query at all, so 39 of the 48 daily ticks do no per-user work;
//   * formatters are built once per timezone (per isolate), not four times per user;
//   * reads that used to be repeated per user are fetched ONCE per run, in bulk, and only when a user
//     inside a window needs them (recent activity, streaks, groups, enrollments + tier, course
//     modules/lessons, completed lessons). Every bulk read falls back to the exact old per-user query if
//     it fails, so a failed prefetch degrades to the old behaviour instead of a wrong reminder;
//   * the drip skips, without a query, the ~450 students who already had the 30-day message and have done
//     nothing in 31 days (the old code queried them 3x per drip tick to conclude "nothing to send");
//   * notifications_log rows (display-only) are written 50 per request, each with its own send time;
//   * a wall-time budget AND a request budget stop it from STARTING another user before the platform
//     would kill it. A user already started is always finished (send → dedup stamp → log). Leftovers are
//     taken by the next tick, which is still inside the ±30-minute window, because dedup is per local day;
//   * every run writes `engagement_run_started` and `engagement_run_done` to admin_actions, and
//     public.engagement_run_watchdog() (migration 20260926232000) DMs admins when a run started but never
//     finished, ran out of budget, errored, or stopped running at all.
// Reminder semantics are deliberately UNCHANGED: same ±30-minute windows, quiet hours, reminder_time
// quirks, dedup columns, messages, buttons, deep links and drip reset. Each rule below carries a note
// saying which old line it reproduces.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { verifyInternalSecret } from "../_shared/internal-secret.ts";
import { sendTelegram } from "../_shared/telegram-send.ts";
import { logHealth } from "../_shared/edge.ts";
import { fetchAllKeyset, reminderWindows, type Row, type WindowUser, ymdInTz } from "./core.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// Module-level client: only used for the internal-secret check (its cache lives per isolate).
const __admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

type Locale = "uz" | "ru" | "en";
const normLocale = (c?: string | null): Locale => {
  const l = (c || "").toLowerCase().slice(0, 2);
  if (l === "ru") return "ru";
  if (l === "en") return "en";
  return "uz";
};

// Hardcoded English defaults if a template row is missing entirely
const FALLBACK: Record<string, { body: string; button_label?: string }> = {
  daily_reminder: { body: "Hi {{first_name}}! Continue learning today? 📚", button_label: "Continue →" },
  streak_warning: { body: "🔥 Keep your {{streak_days}}-day streak alive!", button_label: "⚡ Continue now" },
  inactive_3: { body: "We miss you 👋 Want to continue the course?", button_label: "Continue →" },
  inactive_7: { body: "{{first_name}}, your course is waiting.", button_label: "Start →" },
  inactive_14: { body: "We have a special message for you 🎁", button_label: "Details →" },
  inactive_30: { body: "{{first_name}}, it's been a month — your course and your group are still here for you 💚", button_label: "Come back →" },
};

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") || "";
const SITE_URL = (Deno.env.get("SITE_URL") || "").replace(/\/$/, "");

// ─────────────────────────── budgets ───────────────────────────
// Stop STARTING new users once either budget is spent. The platform kills an invocation at ~2 s of CPU
// or 150 s of wall clock, and a kill can land between a send and its dedup stamp.
const WALL_BUDGET_MS = 100_000;
// CPU cannot be read from inside the isolate, so the number of network requests is the proxy. In the old
// code every CPU kill came at roughly 3,000 requests (plus ~1,000-2,300 formatter constructions, which are
// gone now). The heaviest tick now — 19:30 Tashkent, every student due at once — costs ~3.3 requests per
// reminder, ~1,850 for today's 565 students. Crossing this is not a failure — the next tick takes the
// leftovers — but the run is recorded as partial and the watchdog reports it, because it means the load
// is outgrowing a single tick.
const REQUEST_BUDGET = 2_500;
// Bulk "recent activity" lookbacks.
// Daily/streak only ask "any activity TODAY (local)?": the window must reach back to the START of the user's
// local day in every timezone; a local day is at most 25 h long (DST), so 26 h always covers it.
const ACTIVITY_LOOKBACK_MS = 26 * 60 * 60 * 1000;
// The drip needs exact idle days, but only below 30: past that, a student who already had the 30-day
// message gets nothing more. 31 days lets it skip those students without a query (see the drip block).
const DRIP_LOOKBACK_MS = 31 * 24 * 60 * 60 * 1000;

// Per-run state. `requests` counts every PostgREST request made through `admin` (via its fetch) and
// every Telegram send (in tg()).
type Ctx = {
  runId: string;
  startedAt: number;
  requests: number;
  admin: any;
  prefetchFailed: string[];
  activity: () => Promise<Map<string, number> | null>;
  dripActivity: () => Promise<Map<string, number> | null>;
  streaks: () => Promise<Map<string, number> | null>;
  groups: () => Promise<Map<string, string | null> | null>;
  enrollments: () => Promise<Map<string, Row[]> | null>;
  content: Map<string, Promise<CourseContent | null>>;
  completed: Map<string, () => Promise<Map<string, Set<string>> | null>>;
  notifBuffer: Row[];
};

type CourseContent = {
  modules: { id: string; position: number }[];
  lessons: { id: string; module_id: string; position: number }[];
};

function once<T>(fn: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | undefined;
  return () => (p ??= fn());
}

// A per-run bulk read that can NEVER reject: a throw is recorded and becomes `null`, which every caller
// treats as "use the old per-user query". (A memoised rejection would otherwise fail every later user.)
function bulkOnce<T>(ctx: Ctx, what: string, fn: () => Promise<T | null>): () => Promise<T | null> {
  return once(async () => {
    try {
      return await fn();
    } catch (e) {
      prefetchFailed(ctx, what, String((e as Error)?.message || e));
      return null;
    }
  });
}

function newCtx(): Ctx {
  const ctx = {
    runId: crypto.randomUUID(),
    startedAt: Date.now(),
    requests: 0,
    prefetchFailed: [] as string[],
    content: new Map(),
    completed: new Map(),
    notifBuffer: [] as Row[],
  } as unknown as Ctx;
  const countingFetch: typeof fetch = (input, init) => {
    ctx.requests++;
    return fetch(input, init);
  };
  ctx.admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    global: { fetch: countingFetch },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  ctx.activity = bulkOnce(ctx, "activity_26h", () => loadRecentActivity(ctx, ACTIVITY_LOOKBACK_MS, "activity_26h"));
  ctx.dripActivity = bulkOnce(ctx, "activity_31d", () => loadRecentActivity(ctx, DRIP_LOOKBACK_MS, "activity_31d"));
  ctx.streaks = bulkOnce(ctx, "streaks", () => loadStreaks(ctx));
  ctx.groups = bulkOnce(ctx, "groups", () => loadGroups(ctx));
  ctx.enrollments = bulkOnce(ctx, "enrollments", () => loadEnrollments(ctx));
  return ctx;
}

// Route every engagement DM through the shared sender so a non-delivery (blocked bot /
// never-Started ~70% / transient) lands a classified telegram_send_failed row in admin_actions
// instead of vanishing behind a fire-and-forget fetch. Payload-transparent.
function tg(ctx: Ctx, method: string, body: any, purpose: string) {
  ctx.requests++;
  return sendTelegram(BOT_TOKEN, method, body, { admin: ctx.admin, purpose, recipientId: body?.chat_id ?? null });
}

function randomToken(len = 32): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("").slice(0, len);
}

async function magicLink(admin: any, user_id: string, target_path: string): Promise<string> {
  const token = randomToken(32);
  await admin.from("telegram_magic_links").insert({ token, user_id, purpose: "deeplink_lesson", target_path });
  return `${SITE_URL}/auth/magic?t=${token}`;
}

// Template loader with in-invocation cache + locale fallback chain (requested → uz → hardcoded EN)
type TplRow = { template_key: string; locale: string; body: string; button_label: string | null };
async function loadTemplates(admin: any): Promise<Map<string, TplRow>> {
  const { data } = await admin.from("notification_templates").select("template_key, locale, body, button_label");
  const m = new Map<string, TplRow>();
  for (const r of (data || []) as TplRow[]) m.set(`${r.template_key}:${r.locale}`, r);
  return m;
}
function pickTemplate(cache: Map<string, TplRow>, key: string, locale: Locale): { body: string; button_label?: string } {
  const exact = cache.get(`${key}:${locale}`);
  if (exact) return { body: exact.body, button_label: exact.button_label || undefined };
  const uz = cache.get(`${key}:uz`);
  if (uz) return { body: uz.body, button_label: uz.button_label || undefined };
  const fb = FALLBACK[key];
  if (fb) {
    console.warn(`[cron-engagement] using hardcoded fallback for ${key}`);
    return fb;
  }
  return { body: "" };
}
function interpolate(s: string, vars: Record<string, string | number>): string {
  return s.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, k) => String(vars[k] ?? ""));
}

// ─────────────────────────── bulk reads (paginator in core.ts) ───────────────────────────
function prefetchFailed(ctx: Ctx, what: string, error: string | null) {
  ctx.prefetchFailed.push(what);
  console.error(`[cron-engagement] bulk ${what} failed — falling back to per-user queries`, error);
}

// Latest activity per user over a lookback window, from the same three sources and filters as the
// per-user query. For a user WITH a row here the max IS their true latest activity (any later row would
// also be inside the window). For a user WITHOUT one, the true latest activity is older than the window
// start (or there is none) — each caller argues separately why that is enough for its rule.
async function loadRecentActivity(ctx: Ctx, lookbackMs: number, label: string): Promise<Map<string, number> | null> {
  const since = new Date(ctx.startedAt - lookbackMs).toISOString();
  const [lp, gm, hw] = await Promise.all([
    fetchAllKeyset(ctx.admin, "lesson_progress", "id, user_id, updated_at", "id", (q) => q.gte("updated_at", since)),
    fetchAllKeyset(ctx.admin, "group_message_events", "id, profile_id, sent_at", "id",
      (q) => q.not("telegram_thread_id", "is", null).gte("sent_at", since)),
    fetchAllKeyset(ctx.admin, "homework_submissions", "id, user_id, submitted_at", "id", (q) => q.gte("submitted_at", since)),
  ]);
  const err = lp.error || gm.error || hw.error;
  if (err) {
    prefetchFailed(ctx, label, err);
    return null;
  }
  const m = new Map<string, number>();
  const bump = (uid: string | null, t: string | null) => {
    if (!uid || !t) return;
    const ms = new Date(t).getTime();
    const cur = m.get(uid);
    if (cur === undefined || ms > cur) m.set(uid, ms);
  };
  for (const r of lp.rows) bump(r.user_id, r.updated_at);
  for (const r of gm.rows) bump(r.profile_id, r.sent_at);
  for (const r of hw.rows) bump(r.user_id, r.submitted_at);
  return m;
}

// The old per-user activity query, unchanged. Used when a bulk read failed, and by the drip for the few
// students with no activity in 31 days whose outcome still depends on the exact number of idle days.
async function exactLastActivity(admin: any, userId: string): Promise<Date | null> {
  const [lpRes, gmRes, hwRes] = await Promise.all([
    admin.from("lesson_progress").select("updated_at").eq("user_id", userId).order("updated_at", { ascending: false }).limit(1).maybeSingle(),
    admin.from("group_message_events").select("sent_at").eq("profile_id", userId).not("telegram_thread_id", "is", null).order("sent_at", { ascending: false }).limit(1).maybeSingle(),
    admin.from("homework_submissions").select("submitted_at").eq("user_id", userId).order("submitted_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  const tsCandidates = [
    (lpRes.data as any)?.updated_at,
    (gmRes.data as any)?.sent_at,
    (hwRes.data as any)?.submitted_at,
  ].filter(Boolean).map((t: string) => new Date(t).getTime());
  return tsCandidates.length ? new Date(Math.max(...tsCandidates)) : null;
}

// Only users with current_streak >= 1 — the only ones a streak warning can go to (streaks.user_id is the
// primary key, so the per-user maybeSingle() could never see two rows).
async function loadStreaks(ctx: Ctx): Promise<Map<string, number> | null> {
  const r = await fetchAllKeyset(ctx.admin, "streaks", "user_id, current_streak", "user_id", (q) => q.gte("current_streak", 1));
  if (r.error) {
    prefetchFailed(ctx, "streaks", r.error);
    return null;
  }
  return new Map(r.rows.map((x) => [x.user_id as string, x.current_streak as number]));
}

async function streakFor(ctx: Ctx, userId: string): Promise<number> {
  const m = await ctx.streaks();
  if (m) return m.get(userId) || 0;
  const { data: streakRow } = await ctx.admin.from("streaks").select("current_streak").eq("user_id", userId).maybeSingle();
  return streakRow?.current_streak || 0;
}

async function loadGroups(ctx: Ctx): Promise<Map<string, string | null> | null> {
  const r = await fetchAllKeyset(ctx.admin, "groups", "id, course_id", "id", (q) => q);
  if (r.error) {
    prefetchFailed(ctx, "groups", r.error);
    return null;
  }
  return new Map(r.rows.map((x) => [x.id as string, (x.course_id ?? null) as string | null]));
}

// enrollments is UNIQUE (user_id, course_id), so the per-user tier lookup's maybeSingle() could never
// see two rows; the bulk read gives the same answer.
async function loadEnrollments(ctx: Ctx): Promise<Map<string, Row[]> | null> {
  const r = await fetchAllKeyset(ctx.admin, "enrollments", "id, user_id, course_id, course_tiers(module_limit)", "id", (q) => q);
  if (r.error) {
    prefetchFailed(ctx, "enrollments", r.error);
    return null;
  }
  const m = new Map<string, Row[]>();
  for (const x of r.rows) {
    const list = m.get(x.user_id);
    if (list) list.push(x);
    else m.set(x.user_id, [x]);
  }
  return m;
}

async function getDefaultCourseId(admin: any): Promise<string | null> {
  const { data } = await admin
    .from("courses").select("id, is_default_for_signup, created_at")
    .eq("published", true)
    .order("is_default_for_signup", { ascending: false })
    .order("created_at", { ascending: true })
    .limit(1).maybeSingle();
  return data?.id ?? null;
}

// The course a re-engagement nudge should deep-link into for THIS user:
// their group's course, else their first enrollment, else the platform default.
// Byte-identical to the old behavior for single (old-course) students.
async function resolveUserCourseId(ctx: Ctx, userId: string, groupId: string | null, fallback: string | null): Promise<string | null> {
  try {
    if (groupId) {
      const groups = await ctx.groups();
      let gCourse: string | null;
      if (groups) {
        gCourse = groups.get(groupId) ?? null;
      } else {
        const { data: g } = await ctx.admin.from("groups").select("course_id").eq("id", groupId).maybeSingle();
        gCourse = g?.course_id ?? null;
      }
      if (gCourse) return gCourse;
    }
    const enrollments = await ctx.enrollments();
    const mine = enrollments ? (enrollments.get(userId) || []) : null;
    if (mine && mine.length <= 1) {
      // 0 or 1 enrollment: the old `.limit(1).maybeSingle()` had exactly this answer.
      if (mine[0]?.course_id) return mine[0].course_id;
    } else {
      // No bulk data, or SEVERAL enrollments: ask exactly as before, so "first" stays the database's own
      // choice. (Live: all 414 group-less eligible students have exactly one.)
      const { data: enr } = await ctx.admin.from("enrollments").select("course_id").eq("user_id", userId).limit(1).maybeSingle();
      if ((enr as any)?.course_id) return (enr as any).course_id;
    }
  } catch (_e) { /* ignore — fall through to default */ }
  return fallback;
}

// A student's module_limit for a course: NULL = unlimited (every 4.0 student) → no clamp.
async function moduleLimitFor(ctx: Ctx, userId: string, courseId: string): Promise<number | null> {
  if (!userId || !courseId) return null;
  const enrollments = await ctx.enrollments();
  let lim: unknown;
  if (enrollments) {
    const row = (enrollments.get(userId) || []).find((e) => e.course_id === courseId);
    lim = (row as any)?.course_tiers?.module_limit;
  } else {
    const { data } = await ctx.admin.from("enrollments").select("course_tiers(module_limit)")
      .eq("user_id", userId).eq("course_id", courseId).maybeSingle();
    lim = (data as any)?.course_tiers?.module_limit;
  }
  return typeof lim === "number" ? lim : null;
}

// Modules + published lessons of a course, fetched once per run. A FAILED read is not cached (the next
// user retries), which is what the old per-user fetch amounted to.
function courseContent(ctx: Ctx, courseId: string): Promise<CourseContent | null> {
  const hit = ctx.content.get(courseId);
  if (hit) return hit;
  const p = (async (): Promise<CourseContent | null> => {
    try {
      const { data: modulesRaw, error: mErr } = await ctx.admin.from("modules").select("id, position").eq("course_id", courseId).order("position", { ascending: true });
      if (mErr || !modulesRaw) return null;
      if (!modulesRaw.length) return { modules: [], lessons: [] };
      const moduleIds = modulesRaw.map((m: any) => m.id);
      const { data: lessons, error: lErr } = await ctx.admin.from("lessons").select("id, module_id, position").in("module_id", moduleIds).eq("published", true);
      if (lErr || !lessons) return null;
      return { modules: modulesRaw, lessons };
    } catch (_e) {
      return null; // never rejects; the old code's per-user read also just produced "no link"
    }
  })();
  ctx.content.set(courseId, p);
  p.then((v) => { if (!v) ctx.content.delete(courseId); });
  return p;
}

// Completed lessons per user, restricted to THIS course's published lessons — the only ids the "next
// lesson" search below ever looks up, so the answer is the same as the old all-rows-per-user query.
function completedLoader(ctx: Ctx, courseId: string, content: CourseContent) {
  let loader = ctx.completed.get(courseId);
  if (!loader) {
    const lessonIds = content.lessons.map((l) => l.id);
    loader = bulkOnce(ctx, `completed:${courseId}`, async () => {
      const r = await fetchAllKeyset(ctx.admin, "lesson_progress", "id, user_id, lesson_id", "id",
        (q) => q.in("lesson_id", lessonIds).not("completed_at", "is", null));
      if (r.error) {
        prefetchFailed(ctx, `completed:${courseId}`, r.error);
        return null;
      }
      const m = new Map<string, Set<string>>();
      for (const x of r.rows) {
        const s = m.get(x.user_id);
        if (s) s.add(x.lesson_id);
        else m.set(x.user_id, new Set([x.lesson_id]));
      }
      return m;
    });
    ctx.completed.set(courseId, loader);
  }
  return loader;
}

async function completedLessons(ctx: Ctx, userId: string, courseId: string, content: CourseContent): Promise<Set<string>> {
  const m = await completedLoader(ctx, courseId, content)();
  if (m) return m.get(userId) || new Set();
  const { data: progress } = await ctx.admin.from("lesson_progress").select("lesson_id, completed_at").eq("user_id", userId);
  return new Set((progress || []).filter((p: any) => p.completed_at).map((p: any) => p.lesson_id));
}

async function getNextIncompleteLesson(ctx: Ctx, userId: string, courseId: string): Promise<string | null> {
  const content = await courseContent(ctx, courseId);
  if (!content || !content.modules.length) return null;
  // Tier clamp (Phase 2): never deep-link a re-engagement nudge past the student's cap.
  const limit = await moduleLimitFor(ctx, userId, courseId);
  const modules = (limit == null) ? content.modules : content.modules.slice(0, limit);
  if (!modules.length) return null;
  const inScope = new Set(modules.map((m) => m.id));
  const lessons = content.lessons.filter((l) => inScope.has(l.module_id)); // a copy: the cache stays intact
  if (!lessons.length) return null;
  const positionMap = new Map(modules.map((m, i) => [m.id, i]));
  lessons.sort((a: any, b: any) => {
    const pa = (positionMap.get(a.module_id) ?? 0) * 10000 + a.position;
    const pb = (positionMap.get(b.module_id) ?? 0) * 10000 + b.position;
    return pa - pb;
  });
  const completed = await completedLessons(ctx, userId, courseId, content);
  const next = lessons.find((l: any) => !completed.has(l.id));
  return next?.id ?? lessons[0].id;
}

// notifications_log rows are display-only (nothing reads the engagement types back), so they are buffered and
// written 50 at a time: one request per send saved on the heaviest tick. Each row carries its own sent_at,
// taken right after its send — the value the column default used to give it. The dedup stamp on profiles is
// still written per user, immediately after the send, because THAT is what prevents a second reminder.
const NOTIF_BATCH = 50;

async function flushNotifs(ctx: Ctx, stats: Stats) {
  if (!ctx.notifBuffer.length) return;
  const rows = ctx.notifBuffer.splice(0);
  const { error } = await ctx.admin.from("notifications_log").insert(rows);
  if (!error) return;
  // One bad row (e.g. a profile deleted mid-run) must not cost the other rows their entry: fall back to the
  // old one-row inserts for this batch.
  for (const r of rows) {
    const { error: e } = await ctx.admin.from("notifications_log").insert(r);
    if (e) stats.log_write_failed++;
  }
}

async function logNotif(ctx: Ctx, stats: Stats, user_id: string, type: string, payload: Record<string, unknown>) {
  ctx.notifBuffer.push({ user_id, notification_type: type, payload, sent_at: new Date().toISOString() });
  if (ctx.notifBuffer.length >= NOTIF_BATCH) await flushNotifs(ctx, stats);
}

// ─────────────────────────── the run ───────────────────────────
type Stats = {
  eligible: number;
  processed: number;
  skipped_quiet_hours: number;
  skipped_out_of_window: number;
  deferred: number;
  errors: number;
  error_sample: string | null;
  sent: { daily: number; streak: number; drip: number };
  drip_resets: number;
  not_delivered: number;
  log_write_failed: number;
  partial: boolean;
  partial_reason: string | null;
  error: string | null;
};

function newStats(): Stats {
  return {
    eligible: 0, processed: 0, skipped_quiet_hours: 0, skipped_out_of_window: 0, deferred: 0,
    errors: 0, error_sample: null, sent: { daily: 0, streak: 0, drip: 0 }, drip_resets: 0,
    not_delivered: 0, log_write_failed: 0, partial: false, partial_reason: null, error: null,
  };
}

function runDetails(ctx: Ctx, s: Stats) {
  return {
    run_id: ctx.runId,
    eligible: s.eligible,
    processed: s.processed,
    skipped: s.skipped_quiet_hours + s.skipped_out_of_window,
    skipped_quiet_hours: s.skipped_quiet_hours,
    skipped_out_of_window: s.skipped_out_of_window,
    deferred: s.deferred,
    sent: s.sent,
    drip_resets: s.drip_resets,
    not_delivered: s.not_delivered,
    log_write_failed: s.log_write_failed,
    errors: s.errors,
    error_sample: s.error_sample,
    partial: s.partial,
    partial_reason: s.partial_reason,
    error: s.error,
    prefetch_failed: ctx.prefetchFailed,
    requests: ctx.requests,
    duration_ms: Date.now() - ctx.startedAt,
  };
}

async function finishRun(ctx: Ctx, s: Stats) {
  try {
    await flushNotifs(ctx, s); // every exit path writes the buffered log rows before reporting
  } catch (e) {
    s.log_write_failed += ctx.notifBuffer.length;
    console.error("[cron-engagement] notifications_log flush threw", e);
  }
  const details = runDetails(ctx, s);
  await logHealth(ctx.admin, "engagement_run_done", details, { source: "cron-engagement" });
  return details;
}

function budgetSpent(ctx: Ctx): string | null {
  if (Date.now() - ctx.startedAt >= WALL_BUDGET_MS) return "wall_time";
  if (ctx.requests >= REQUEST_BUDGET) return "request_budget";
  return null;
}

async function run(ctx: Ctx, stats: Stats): Promise<Response> {
  const admin = ctx.admin;
  const courseId = await getDefaultCourseId(admin);
  const templates = await loadTemplates(admin);

  // Paginated: the old single select silently stopped at PostgREST's 1000-row cap.
  const prof = await fetchAllKeyset(
    admin, "profiles",
    "id, name, telegram_id, timezone, reminder_time, notifications_enabled, preferred_locale, created_at, group_id, last_daily_reminder_at, last_streak_warning_at, last_inactive_warning_at, last_inactive_warning_day",
    "id",
    (q) => q.eq("notifications_enabled", true).eq("status", "active").not("telegram_id", "is", null),
  );
  if (prof.error) {
    stats.error = `profiles: ${prof.error}`.slice(0, 300);
    await finishRun(ctx, stats);
    return new Response(JSON.stringify({ error: prof.error }), { status: 500, headers: corsHeaders });
  }
  const users = prof.rows;
  stats.eligible = users.length;

  for (const u of users) {
    try {
      // ── Which windows apply? Profile columns + the clock ONLY — no database call before this. ──
      // (core.ts reminderWindows: quiet hours, ±30 min of reminder_time / 21:00 / 12:00, per-day dedup,
      // account age >= 3 days for the drip — each the old condition verbatim, pinned by core.test.ts.)
      const w = reminderWindows(u as WindowUser, new Date());
      if (w.quiet) { stats.skipped_quiet_hours++; continue; }
      if (!w.daily && !w.streak && !w.drip) { stats.skipped_out_of_window++; continue; }
      const { tz, ymd, accountAgeDays } = w;
      const dailyWindow = w.daily, streakWindow = w.streak, dripWindow = w.drip;

      // Never START a user the platform might kill us in the middle of.
      const spent = budgetSpent(ctx);
      if (spent) {
        stats.partial = true;
        stats.partial_reason ??= spent;
        stats.deferred++;
        continue;
      }
      stats.processed++;

      const locale = normLocale(u.preferred_locale);
      const chatId = Number(u.telegram_id);
      const firstName = u.name || "";
      // Course-aware deep links: resolve THIS user's course (group → enrollment → default). A pure read,
      // now done only when a message actually needs it.
      let courseMemo: Promise<string | null> | undefined;
      const userCourse = () => (courseMemo ??= resolveUserCourseId(ctx, u.id, u.group_id ?? null, courseId));

      // (old) watchedToday = lastActivity ? ymdInTz(lastActivity) === ymd : false
      // From the 26 h bulk map when it loaded, else the old per-user query. A user with no row in the map
      // last did something before the window start, which is before their local midnight — so not today.
      let watchedMemo: Promise<boolean> | undefined;
      const watchedToday = () => (watchedMemo ??= (async () => {
        const m = await ctx.activity();
        let last: Date | null;
        if (m) {
          const t = m.get(u.id);
          last = t === undefined ? null : new Date(t);
        } else {
          last = await exactLastActivity(admin, u.id);
        }
        return last ? ymdInTz(tz, last) === ymd : false;
      })());

      // ---------- DAILY REMINDER ----------
      // (old) withinReminder && !reminderInQuiet && !watchedToday && lastDailyYmd !== ymd && userCourseId
      if (dailyWindow && !(await watchedToday())) {
        const userCourseId = await userCourse();
        if (userCourseId) {
          const tpl = pickTemplate(templates, "daily_reminder", locale);
          const text = interpolate(tpl.body, { first_name: firstName || "👋" });
          const nextId = await getNextIncompleteLesson(ctx, u.id, userCourseId);
          const inline: any[][] = [];
          if (nextId && tpl.button_label) {
            const url = await magicLink(admin, u.id, `/lesson/${userCourseId}/${nextId}`);
            inline.push([{ text: tpl.button_label, url }]);
          }
          inline.push([{ text: locale === "ru" ? "Не сегодня" : locale === "en" ? "Not today" : "Bugun emas", callback_data: "ack:not_today" }]);
          const out = await tg(ctx, "sendMessage", { chat_id: chatId, text, reply_markup: { inline_keyboard: inline } }, "daily_reminder");
          if (!out.ok) stats.not_delivered++;
          await admin.from("profiles").update({ last_daily_reminder_at: new Date().toISOString() }).eq("id", u.id);
          await logNotif(ctx, stats, u.id, "daily_reminder", {});
          stats.sent.daily++;
        }
      }

      // ---------- STREAK WARNING (~21:00) ----------
      // (old) if (within21 && !watchedToday && lastStreakYmd !== ymd) { cs = streak; if (cs >= 1 && userCourseId) ... }
      // The streak is read first only because it is cheaper and rules out most users; both are pure reads.
      if (streakWindow) {
        const cs = await streakFor(ctx, u.id);
        if (cs >= 1 && !(await watchedToday())) {
          const userCourseId = await userCourse();
          if (userCourseId) {
            const tpl = pickTemplate(templates, "streak_warning", locale);
            const text = interpolate(tpl.body, { first_name: firstName, streak_days: cs });
            const nextId = await getNextIncompleteLesson(ctx, u.id, userCourseId);
            const inline: any[][] = [];
            if (nextId && tpl.button_label) {
              const url = await magicLink(admin, u.id, `/lesson/${userCourseId}/${nextId}`);
              inline.push([{ text: tpl.button_label, url }]);
            }
            const out = await tg(ctx, "sendMessage", { chat_id: chatId, text, reply_markup: inline.length ? { inline_keyboard: inline } : undefined }, "streak_warning");
            if (!out.ok) stats.not_delivered++;
            await admin.from("profiles").update({ last_streak_warning_at: new Date().toISOString() }).eq("id", u.id);
            await logNotif(ctx, stats, u.id, "streak_warning", { streak: cs });
            stats.sent.streak++;
          }
        }
      }

      // ---------- RE-ENGAGEMENT DRIP (~12:00) ----------
      if (dripWindow) {
        let lastActivity: Date | null;
        const m = await ctx.dripActivity();
        const t = m ? m.get(u.id) : undefined;
        if (t !== undefined) {
          lastActivity = new Date(t); // exact: their latest activity is inside the 31-day window
        } else if (m && u.last_inactive_warning_day === 30 && accountAgeDays >= 30) {
          // Nothing in 31 days (or nothing ever, on an account >= 30 days old), so daysSinceActivity >= 30
          // either way, and they already had the 30-day message. The old code did nothing for them: no reset
          // (needs < 3 days) and no stage (the only stage at >= 30 days is 30, which they had). ~450 of 572
          // students today — each used to cost 3 queries on every drip tick.
          continue;
        } else {
          lastActivity = await exactLastActivity(admin, u.id);
        }
        const daysSinceActivity = lastActivity
          ? Math.floor((Date.now() - lastActivity.getTime()) / 86_400_000)
          : accountAgeDays;
        if (daysSinceActivity < 3 && u.last_inactive_warning_day) {
          await admin.from("profiles").update({ last_inactive_warning_day: null, last_inactive_warning_at: null }).eq("id", u.id);
          stats.drip_resets++;
          continue;
        }
        let stage: 3 | 7 | 14 | 30 | null = null;
        if (daysSinceActivity >= 30 && u.last_inactive_warning_day !== 30) stage = 30;
        else if (daysSinceActivity >= 14 && daysSinceActivity < 30 && u.last_inactive_warning_day !== 14) stage = 14;
        else if (daysSinceActivity >= 7 && daysSinceActivity < 14 && u.last_inactive_warning_day !== 7) stage = 7;
        else if (daysSinceActivity >= 3 && daysSinceActivity < 7 && u.last_inactive_warning_day !== 3) stage = 3;
        const lastInactiveYmd = u.last_inactive_warning_at ? ymdInTz(tz, new Date(u.last_inactive_warning_at)) : null;
        if (stage && lastInactiveYmd !== ymd) {
          const key = `inactive_${stage}`;
          const tpl = pickTemplate(templates, key, locale);
          const text = interpolate(tpl.body, { first_name: firstName || "👋" });
          let path = "/dashboard";
          if (stage !== 14) {
            const userCourseId = await userCourse();
            if (userCourseId) {
              const nextId = await getNextIncompleteLesson(ctx, u.id, userCourseId);
              if (nextId) path = `/lesson/${userCourseId}/${nextId}`;
            }
          }
          const url = await magicLink(admin, u.id, path);
          const reply_markup = tpl.button_label ? { inline_keyboard: [[{ text: tpl.button_label, url }]] } : undefined;
          const out = await tg(ctx, "sendMessage", { chat_id: chatId, text, reply_markup }, "reengagement_drip");
          if (!out.ok) stats.not_delivered++;
          await admin.from("profiles").update({
            last_inactive_warning_at: new Date().toISOString(),
            last_inactive_warning_day: stage,
          }).eq("id", u.id);
          await logNotif(ctx, stats, u.id, key, { days: daysSinceActivity });
          stats.sent.drip++;
        }
      }
    } catch (e) {
      stats.errors++;
      stats.error_sample ??= String((e as Error)?.message || e).slice(0, 300);
      console.error("user loop error", u.id, e);
    }
  }

  const details = await finishRun(ctx, stats);
  return new Response(
    JSON.stringify({
      ok: true, daily: stats.sent.daily, streak: stats.sent.streak, drip: stats.sent.drip, processed: users.length,
      run: details,
    }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (!(await verifyInternalSecret(req, __admin))) {
    return new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  const ctx = newCtx();
  const stats = newStats();
  // DB-visible start marker: a run that starts and never writes engagement_run_done was killed — the
  // watchdog pairs the two rows by run_id. Written only for authenticated callers.
  await logHealth(ctx.admin, "engagement_run_started", { run_id: ctx.runId }, { source: "cron-engagement" });

  if (!BOT_TOKEN) {
    // Graceful is not silent: reminders are not going out, so say so where the watchdog reads.
    stats.error = "bot not configured";
    await finishRun(ctx, stats);
    return new Response(JSON.stringify({ error: "bot not configured" }), { status: 200, headers: corsHeaders });
  }

  try {
    return await run(ctx, stats);
  } catch (e) {
    stats.error = String((e as Error)?.message || e).slice(0, 300);
    await finishRun(ctx, stats);
    return new Response(JSON.stringify({ error: stats.error }), { status: 500, headers: corsHeaders });
  }
});
