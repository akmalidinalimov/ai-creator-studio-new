// Engagement cron: daily reminders, streak warnings, re-engagement drips.
// Designed to be invoked every 30 minutes (configure via Supabase Cron Jobs UI).
// Quiet hours: skip 00:00-08:00 local time. Skip users with notifications_enabled=false.
// v2.0.1: All copy is now loaded from public.notification_templates (admin-editable).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { verifyInternalSecret } from "../_shared/internal-secret.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const __admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

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

function tg(method: string, body: unknown) {
  return fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
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

function localTimeParts(tz: string): { hour: number; minute: number; ymd: string } {
  try {
    const d = new Date();
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    });
    const parts = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));
    let h = parseInt(parts.hour || "0", 10);
    if (h === 24) h = 0;
    return { hour: h, minute: parseInt(parts.minute || "0", 10), ymd: `${parts.year}-${parts.month}-${parts.day}` };
  } catch {
    const d = new Date();
    return { hour: d.getUTCHours(), minute: d.getUTCMinutes(), ymd: d.toISOString().slice(0, 10) };
  }
}

function minutesBetween(h1: number, m1: number, h2: number, m2: number): number {
  return Math.abs(h1 * 60 + m1 - (h2 * 60 + m2));
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
async function resolveUserCourseId(admin: any, userId: string, groupId: string | null, fallback: string | null): Promise<string | null> {
  try {
    if (groupId) {
      const { data: g } = await admin.from("groups").select("course_id").eq("id", groupId).maybeSingle();
      if (g?.course_id) return g.course_id;
    }
    const { data: enr } = await admin.from("enrollments").select("course_id").eq("user_id", userId).limit(1).maybeSingle();
    if ((enr as any)?.course_id) return (enr as any).course_id;
  } catch (_e) { /* ignore — fall through to default */ }
  return fallback;
}

// A student's module_limit for a course: NULL = unlimited (every 4.0 student) → no clamp.
async function moduleLimitFor(admin: any, userId: string, courseId: string): Promise<number | null> {
  if (!userId || !courseId) return null;
  const { data } = await admin.from("enrollments").select("course_tiers(module_limit)")
    .eq("user_id", userId).eq("course_id", courseId).maybeSingle();
  const lim = (data as any)?.course_tiers?.module_limit;
  return typeof lim === "number" ? lim : null;
}

async function getNextIncompleteLesson(admin: any, userId: string, courseId: string): Promise<string | null> {
  const { data: modulesRaw } = await admin.from("modules").select("id, position").eq("course_id", courseId).order("position", { ascending: true });
  if (!modulesRaw?.length) return null;
  // Tier clamp (Phase 2): never deep-link a re-engagement nudge past the student's cap.
  const limit = await moduleLimitFor(admin, userId, courseId);
  const modules = (limit == null) ? modulesRaw : modulesRaw.slice(0, limit);
  if (!modules.length) return null;
  const moduleIds = modules.map((m: any) => m.id);
  const { data: lessons } = await admin.from("lessons").select("id, module_id, position").in("module_id", moduleIds).eq("published", true);
  if (!lessons?.length) return null;
  const positionMap = new Map(modules.map((m: any, i: number) => [m.id, i]));
  lessons.sort((a: any, b: any) => {
    const pa = (positionMap.get(a.module_id) ?? 0) * 10000 + a.position;
    const pb = (positionMap.get(b.module_id) ?? 0) * 10000 + b.position;
    return pa - pb;
  });
  const { data: progress } = await admin.from("lesson_progress").select("lesson_id, completed_at").eq("user_id", userId);
  const completed = new Set((progress || []).filter((p: any) => p.completed_at).map((p: any) => p.lesson_id));
  const next = lessons.find((l: any) => !completed.has(l.id));
  return next?.id ?? lessons[0].id;
}

async function logNotif(admin: any, user_id: string, type: string, payload: Record<string, unknown>) {
  await admin.from("notifications_log").insert({ user_id, notification_type: type, payload });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (!(await verifyInternalSecret(req, __admin))) {
    return new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  if (!BOT_TOKEN) {
    return new Response(JSON.stringify({ error: "bot not configured" }), { status: 200, headers: corsHeaders });
  }

  const admin = __admin;
  const courseId = await getDefaultCourseId(admin);
  const templates = await loadTemplates(admin);

  const { data: users, error } = await admin
    .from("profiles")
    .select("id, name, telegram_id, timezone, reminder_time, notifications_enabled, preferred_locale, created_at, group_id, last_daily_reminder_at, last_streak_warning_at, last_inactive_warning_at, last_inactive_warning_day")
    .eq("notifications_enabled", true)
    .eq("status", "active")
    .not("telegram_id", "is", null);

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: corsHeaders });
  }

  let dailySent = 0, streakSent = 0, dripSent = 0;

  for (const u of users || []) {
    try {
      const tz = u.timezone || "Asia/Tashkent";
      const { hour, minute, ymd } = localTimeParts(tz);
      if (hour < 8) continue;

      const locale = normLocale(u.preferred_locale);
      const chatId = Number(u.telegram_id);
      const firstName = u.name || "";
      // Course-aware deep links: resolve THIS user's course (group → enrollment → default).
      const userCourseId = await resolveUserCourseId(admin, u.id, (u as any).group_id ?? null, courseId);

      const [lpRes, gmRes, hwRes] = await Promise.all([
        admin.from("lesson_progress").select("updated_at").eq("user_id", u.id).order("updated_at", { ascending: false }).limit(1).maybeSingle(),
        admin.from("group_message_events").select("sent_at").eq("profile_id", u.id).not("telegram_thread_id", "is", null).order("sent_at", { ascending: false }).limit(1).maybeSingle(),
        admin.from("homework_submissions").select("submitted_at").eq("user_id", u.id).order("submitted_at", { ascending: false }).limit(1).maybeSingle(),
      ]);
      const tsCandidates = [
        (lpRes.data as any)?.updated_at,
        (gmRes.data as any)?.sent_at,
        (hwRes.data as any)?.submitted_at,
      ].filter(Boolean).map((t: string) => new Date(t).getTime());
      const lastActivity = tsCandidates.length ? new Date(Math.max(...tsCandidates)) : null;

      function ymdInTz(date: Date): string {
        try {
          const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
          const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
          return `${parts.year}-${parts.month}-${parts.day}`;
        } catch { return date.toISOString().slice(0, 10); }
      }
      const watchedToday = lastActivity ? ymdInTz(lastActivity) === ymd : false;
      const lastDailyYmd = u.last_daily_reminder_at ? ymdInTz(new Date(u.last_daily_reminder_at)) : null;
      const lastStreakYmd = u.last_streak_warning_at ? ymdInTz(new Date(u.last_streak_warning_at)) : null;

      // ---------- DAILY REMINDER ----------
      const [rh, rm] = (u.reminder_time || "20:00:00").split(":").map((s: string) => parseInt(s, 10));
      const withinReminder = minutesBetween(hour, minute, rh || 20, rm || 0) <= 30;
      const reminderInQuiet = (rh || 20) < 8;
      if (withinReminder && !reminderInQuiet && !watchedToday && lastDailyYmd !== ymd && userCourseId) {
        const tpl = pickTemplate(templates, "daily_reminder", locale);
        const text = interpolate(tpl.body, { first_name: firstName || "👋" });
        const nextId = await getNextIncompleteLesson(admin, u.id, userCourseId);
        const inline: any[][] = [];
        if (nextId && tpl.button_label) {
          const url = await magicLink(admin, u.id, `/lesson/${userCourseId}/${nextId}`);
          inline.push([{ text: tpl.button_label, url }]);
        }
        inline.push([{ text: locale === "ru" ? "Не сегодня" : locale === "en" ? "Not today" : "Bugun emas", callback_data: "ack:not_today" }]);
        await tg("sendMessage", { chat_id: chatId, text, reply_markup: { inline_keyboard: inline } });
        await admin.from("profiles").update({ last_daily_reminder_at: new Date().toISOString() }).eq("id", u.id);
        await logNotif(admin, u.id, "daily_reminder", {});
        dailySent++;
      }

      // ---------- STREAK WARNING (~21:00) ----------
      const within21 = minutesBetween(hour, minute, 21, 0) <= 30;
      if (within21 && !watchedToday && lastStreakYmd !== ymd) {
        const { data: streakRow } = await admin.from("streaks").select("current_streak").eq("user_id", u.id).maybeSingle();
        const cs = streakRow?.current_streak || 0;
        if (cs >= 1 && userCourseId) {
          const tpl = pickTemplate(templates, "streak_warning", locale);
          const text = interpolate(tpl.body, { first_name: firstName, streak_days: cs });
          const nextId = await getNextIncompleteLesson(admin, u.id, userCourseId);
          const inline: any[][] = [];
          if (nextId && tpl.button_label) {
            const url = await magicLink(admin, u.id, `/lesson/${userCourseId}/${nextId}`);
            inline.push([{ text: tpl.button_label, url }]);
          }
          await tg("sendMessage", { chat_id: chatId, text, reply_markup: inline.length ? { inline_keyboard: inline } : undefined });
          await admin.from("profiles").update({ last_streak_warning_at: new Date().toISOString() }).eq("id", u.id);
          await logNotif(admin, u.id, "streak_warning", { streak: cs });
          streakSent++;
        }
      }

      // ---------- RE-ENGAGEMENT DRIP (~12:00) ----------
      const within12 = minutesBetween(hour, minute, 12, 0) <= 30;
      if (within12) {
        const accountAgeDays = Math.floor((Date.now() - new Date(u.created_at).getTime()) / 86_400_000);
        if (accountAgeDays < 3) continue;
        const daysSinceActivity = lastActivity
          ? Math.floor((Date.now() - lastActivity.getTime()) / 86_400_000)
          : accountAgeDays;
        if (daysSinceActivity < 3 && u.last_inactive_warning_day) {
          await admin.from("profiles").update({ last_inactive_warning_day: null, last_inactive_warning_at: null }).eq("id", u.id);
          continue;
        }
        let stage: 3 | 7 | 14 | 30 | null = null;
        if (daysSinceActivity >= 30 && u.last_inactive_warning_day !== 30) stage = 30;
        else if (daysSinceActivity >= 14 && daysSinceActivity < 30 && u.last_inactive_warning_day !== 14) stage = 14;
        else if (daysSinceActivity >= 7 && daysSinceActivity < 14 && u.last_inactive_warning_day !== 7) stage = 7;
        else if (daysSinceActivity >= 3 && daysSinceActivity < 7 && u.last_inactive_warning_day !== 3) stage = 3;
        const lastInactiveYmd = u.last_inactive_warning_at ? ymdInTz(new Date(u.last_inactive_warning_at)) : null;
        if (stage && lastInactiveYmd !== ymd) {
          const key = `inactive_${stage}`;
          const tpl = pickTemplate(templates, key, locale);
          const text = interpolate(tpl.body, { first_name: firstName || "👋" });
          let path = "/dashboard";
          if (stage !== 14 && userCourseId) {
            const nextId = await getNextIncompleteLesson(admin, u.id, userCourseId);
            if (nextId) path = `/lesson/${userCourseId}/${nextId}`;
          }
          const url = await magicLink(admin, u.id, path);
          const reply_markup = tpl.button_label ? { inline_keyboard: [[{ text: tpl.button_label, url }]] } : undefined;
          await tg("sendMessage", { chat_id: chatId, text, reply_markup });
          await admin.from("profiles").update({
            last_inactive_warning_at: new Date().toISOString(),
            last_inactive_warning_day: stage,
          }).eq("id", u.id);
          await logNotif(admin, u.id, key, { days: daysSinceActivity });
          dripSent++;
        }
      }
    } catch (e) {
      console.error("user loop error", u.id, e);
    }
  }

  return new Response(
    JSON.stringify({ ok: true, daily: dailySent, streak: streakSent, drip: dripSent, processed: (users || []).length }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
