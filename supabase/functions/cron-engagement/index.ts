// Engagement cron: daily reminders, streak warnings, re-engagement drips.
// Designed to be invoked every 30 minutes (configure via Supabase Cron Jobs UI).
// Quiet hours: skip 00:00-08:00 local time. Skip users with notifications_enabled=false.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type Locale = "uz" | "ru" | "en";
const normLocale = (c?: string | null): Locale => {
  const l = (c || "").toLowerCase().slice(0, 2);
  if (l === "ru") return "ru";
  if (l === "en") return "en";
  return "uz";
};

const T = {
  uz: {
    daily: (n: string) => `Salom, ${n}! Bugun kursda davom etamizmi? 📚`,
    btnContinue: "Davom etish →",
    btnNotToday: "Bugun emas",
    streak: (s: number) => `🔥 ${s} kunlik g'alabangizni saqlang! Bugun bittagina dars qoldi.`,
    btnNow: "⚡ Hoziroq davom etish",
    inactive3: "Sog'indik sizni 👋 Kursdan davom etamizmi?",
    inactive7: (n: string) => `${n}, kursingiz sizni kutmoqda. Birga davom etaylik?`,
    inactive14: "Sizga maxsus xabar bor — qaytib keling va bonusni oling 🎁",
    btnContinueDrip: "Davom etish →",
    btnStartDrip: "Boshlash →",
    btnDetailsDrip: "Tafsilotlar →",
  },
  ru: {
    daily: (n: string) => `Привет, ${n}! Продолжим обучение сегодня? 📚`,
    btnContinue: "Продолжить →",
    btnNotToday: "Не сегодня",
    streak: (s: number) => `🔥 Сохраните победу в ${s} дней! Сегодня остался один урок.`,
    btnNow: "⚡ Продолжить сейчас",
    inactive3: "Соскучились по вам 👋 Продолжим курс?",
    inactive7: (n: string) => `${n}, ваш курс ждёт вас. Продолжим вместе?`,
    inactive14: "У нас для вас особое сообщение — вернитесь и заберите бонус 🎁",
    btnContinueDrip: "Продолжить →",
    btnStartDrip: "Начать →",
    btnDetailsDrip: "Подробнее →",
  },
  en: {
    daily: (n: string) => `Hi ${n}! Continue learning today? 📚`,
    btnContinue: "Continue →",
    btnNotToday: "Not today",
    streak: (s: number) => `🔥 Keep your ${s}-day streak alive! One lesson left today.`,
    btnNow: "⚡ Continue now",
    inactive3: "We miss you 👋 Want to continue the course?",
    inactive7: (n: string) => `${n}, your course is waiting. Continue together?`,
    inactive14: "We have a special message for you — come back and grab the bonus 🎁",
    btnContinueDrip: "Continue →",
    btnStartDrip: "Start →",
    btnDetailsDrip: "Details →",
  },
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

// Returns the local "wallclock" time in the given IANA timezone for the current instant.
function localTimeParts(tz: string): { hour: number; minute: number; ymd: string } {
  try {
    const d = new Date();
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    const parts = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));
    let h = parseInt(parts.hour || "0", 10);
    if (h === 24) h = 0; // some envs return 24 for midnight
    return {
      hour: h,
      minute: parseInt(parts.minute || "0", 10),
      ymd: `${parts.year}-${parts.month}-${parts.day}`,
    };
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
    .from("courses")
    .select("id, is_default_for_signup, created_at")
    .eq("published", true)
    .order("is_default_for_signup", { ascending: false })
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  return data?.id ?? null;
}

async function getNextIncompleteLesson(admin: any, userId: string, courseId: string): Promise<string | null> {
  const { data: modules } = await admin
    .from("modules")
    .select("id, position")
    .eq("course_id", courseId)
    .order("position", { ascending: true });
  if (!modules?.length) return null;
  const moduleIds = modules.map((m: any) => m.id);
  const { data: lessons } = await admin
    .from("lessons")
    .select("id, module_id, position")
    .in("module_id", moduleIds)
    .eq("published", true);
  if (!lessons?.length) return null;
  const positionMap = new Map(modules.map((m: any, i: number) => [m.id, i]));
  lessons.sort((a: any, b: any) => {
    const pa = (positionMap.get(a.module_id) ?? 0) * 10000 + a.position;
    const pb = (positionMap.get(b.module_id) ?? 0) * 10000 + b.position;
    return pa - pb;
  });
  const { data: progress } = await admin
    .from("lesson_progress")
    .select("lesson_id, completed_at")
    .eq("user_id", userId);
  const completed = new Set((progress || []).filter((p: any) => p.completed_at).map((p: any) => p.lesson_id));
  const next = lessons.find((l: any) => !completed.has(l.id));
  return next?.id ?? lessons[0].id;
}

async function logNotif(admin: any, user_id: string, type: string, payload: Record<string, unknown>) {
  await admin.from("notifications_log").insert({ user_id, notification_type: type, payload });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  if (!BOT_TOKEN) {
    return new Response(JSON.stringify({ error: "bot not configured" }), { status: 200, headers: corsHeaders });
  }

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const courseId = await getDefaultCourseId(admin);

  // Pull all eligible users
  const { data: users, error } = await admin
    .from("profiles")
    .select(
      "id, name, telegram_id, timezone, reminder_time, notifications_enabled, preferred_locale, created_at, last_daily_reminder_at, last_streak_warning_at, last_inactive_warning_at, last_inactive_warning_day",
    )
    .eq("notifications_enabled", true)
    .not("telegram_id", "is", null);

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: corsHeaders });
  }

  let dailySent = 0;
  let streakSent = 0;
  let dripSent = 0;

  for (const u of users || []) {
    try {
      const tz = u.timezone || "Asia/Tashkent";
      const { hour, minute, ymd } = localTimeParts(tz);

      // Quiet hours: skip 00:00-08:00 entirely
      if (hour < 8) continue;

      const locale = normLocale(u.preferred_locale);
      const t = T[locale];
      const chatId = Number(u.telegram_id);
      const firstName = u.name || "";

      // Latest activity
      const { data: lastProg } = await admin
        .from("lesson_progress")
        .select("updated_at")
        .eq("user_id", u.id)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      const lastActivity = lastProg?.updated_at ? new Date(lastProg.updated_at) : null;

      // "today" boundary in user's timezone — compare as YMD string
      function ymdInTz(date: Date): string {
        try {
          const fmt = new Intl.DateTimeFormat("en-CA", {
            timeZone: tz,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
          });
          const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
          return `${parts.year}-${parts.month}-${parts.day}`;
        } catch {
          return date.toISOString().slice(0, 10);
        }
      }
      const watchedToday = lastActivity ? ymdInTz(lastActivity) === ymd : false;
      const lastDailyYmd = u.last_daily_reminder_at ? ymdInTz(new Date(u.last_daily_reminder_at)) : null;
      const lastStreakYmd = u.last_streak_warning_at ? ymdInTz(new Date(u.last_streak_warning_at)) : null;

      // ---------- DAILY REMINDER ----------
      const [rh, rm] = (u.reminder_time || "20:00:00").split(":").map((s: string) => parseInt(s, 10));
      const withinReminder = minutesBetween(hour, minute, rh || 20, rm || 0) <= 30;
      // Skip if reminder time falls in quiet hours
      const reminderInQuiet = (rh || 20) < 8;
      if (
        withinReminder &&
        !reminderInQuiet &&
        !watchedToday &&
        lastDailyYmd !== ymd &&
        courseId
      ) {
        const nextId = await getNextIncompleteLesson(admin, u.id, courseId);
        const inline: any[][] = [];
        if (nextId) {
          const url = await magicLink(admin, u.id, `/lesson/${courseId}/${nextId}`);
          inline.push([{ text: t.btnContinue, url }]);
        }
        inline.push([{ text: t.btnNotToday, callback_data: "ack:not_today" }]);
        await tg("sendMessage", {
          chat_id: chatId,
          text: t.daily(firstName || "👋"),
          reply_markup: { inline_keyboard: inline },
        });
        await admin.from("profiles").update({ last_daily_reminder_at: new Date().toISOString() }).eq("id", u.id);
        await logNotif(admin, u.id, "daily_reminder", {});
        dailySent++;
      }

      // ---------- STREAK WARNING (~21:00) ----------
      const within21 = minutesBetween(hour, minute, 21, 0) <= 30;
      if (within21 && !watchedToday && lastStreakYmd !== ymd) {
        const { data: streakRow } = await admin
          .from("streaks")
          .select("current_streak")
          .eq("user_id", u.id)
          .maybeSingle();
        const cs = streakRow?.current_streak || 0;
        if (cs >= 1 && courseId) {
          const nextId = await getNextIncompleteLesson(admin, u.id, courseId);
          const inline: any[][] = [];
          if (nextId) {
            const url = await magicLink(admin, u.id, `/lesson/${courseId}/${nextId}`);
            inline.push([{ text: t.btnNow, url }]);
          }
          await tg("sendMessage", {
            chat_id: chatId,
            text: t.streak(cs),
            reply_markup: inline.length ? { inline_keyboard: inline } : undefined,
          });
          await admin.from("profiles").update({ last_streak_warning_at: new Date().toISOString() }).eq("id", u.id);
          await logNotif(admin, u.id, "streak_warning", { streak: cs });
          streakSent++;
        }
      }

      // ---------- RE-ENGAGEMENT DRIP ----------
      // Send drip at most once per day (any user), gated by stage transitions
      // Use a single 12:00 ± 30min window to deliver drips
      const within12 = minutesBetween(hour, minute, 12, 0) <= 30;
      if (within12) {
        // Skip first 3 days as a new user
        const accountAgeDays = Math.floor((Date.now() - new Date(u.created_at).getTime()) / 86_400_000);
        if (accountAgeDays < 3) continue;

        const daysSinceActivity = lastActivity
          ? Math.floor((Date.now() - lastActivity.getTime()) / 86_400_000)
          : accountAgeDays;

        // If user has been active recently, reset drip stage
        if (daysSinceActivity < 3 && u.last_inactive_warning_day) {
          await admin
            .from("profiles")
            .update({ last_inactive_warning_day: null, last_inactive_warning_at: null })
            .eq("id", u.id);
          continue;
        }

        let stage: 3 | 7 | 14 | null = null;
        if (daysSinceActivity >= 14 && u.last_inactive_warning_day !== 14) stage = 14;
        else if (daysSinceActivity >= 7 && daysSinceActivity < 14 && u.last_inactive_warning_day !== 7) stage = 7;
        else if (daysSinceActivity >= 3 && daysSinceActivity < 7 && u.last_inactive_warning_day !== 3) stage = 3;

        // Don't re-send same day
        const lastInactiveYmd = u.last_inactive_warning_at
          ? ymdInTz(new Date(u.last_inactive_warning_at))
          : null;
        if (stage && lastInactiveYmd !== ymd) {
          let text = "";
          let btn = "";
          let path = "/dashboard";
          if (stage === 3) {
            text = t.inactive3;
            btn = t.btnContinueDrip;
            if (courseId) {
              const nextId = await getNextIncompleteLesson(admin, u.id, courseId);
              if (nextId) path = `/lesson/${courseId}/${nextId}`;
            }
          } else if (stage === 7) {
            text = t.inactive7(firstName || "👋");
            btn = t.btnStartDrip;
            if (courseId) {
              const nextId = await getNextIncompleteLesson(admin, u.id, courseId);
              if (nextId) path = `/lesson/${courseId}/${nextId}`;
            }
          } else {
            text = t.inactive14;
            btn = t.btnDetailsDrip;
          }
          const url = await magicLink(admin, u.id, path);
          await tg("sendMessage", {
            chat_id: chatId,
            text,
            reply_markup: { inline_keyboard: [[{ text: btn, url }]] },
          });
          await admin
            .from("profiles")
            .update({
              last_inactive_warning_at: new Date().toISOString(),
              last_inactive_warning_day: stage,
            })
            .eq("id", u.id);
          await logNotif(admin, u.id, `inactive_${stage}`, { days: daysSinceActivity });
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
