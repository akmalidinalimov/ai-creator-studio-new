// Teacher engagement nudges (cron, daytime) — Teacher Engagement, Phase 3.
// Sends AT MOST ONE warm, specific DM per teacher per run, choosing between:
//   1. "a student is waiting"  — a directed question unanswered >= 8h (higher priority)
//   2. "you've gone quiet"     — no activity >= 24h AND homework is waiting to grade
// Design rules from the research: specific > exhortative, help not surveillance, no guilt,
// no repeat-nagging. Quiet hours 22:00–08:00 Tashkent; per-type cooldowns via notifications_log;
// respects each teacher's notifications_enabled (opt-out). The ungraded-homework reminder is a
// separate, already-live job — this one covers the two NEW triggers.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-internal-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") || "";
const SITE_URL = Deno.env.get("SITE_URL") || "https://aicreator.academy";

// Tunables
const Q_HOURS = 8;              // a question is "waiting" after this many hours
const WINDOW_DAYS = 3;          // only consider questions from the last N days
const OFFLINE_MIN_H = 24;       // nudge after this much silence
const OFFLINE_MAX_H = 24 * 14;  // ...but stop after 2 weeks (teacher is gone, not idle)
const WAIT_COOLDOWN_H = 8;      // at most one "waiting" nudge per teacher per 8h
const OFFLINE_COOLDOWN_H = 47;  // at most one "offline" nudge per teacher per ~2 days

const __admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
let __sec: string | null = null;
async function internalSecret(): Promise<string> {
  if (__sec) return __sec;
  const { data, error } = await __admin.rpc("internal_fn_secret");
  if (error) throw error;
  __sec = data as string;
  return __sec;
}

type Locale = "uz" | "ru" | "en";
const normLocale = (c?: string | null): Locale => {
  const l = (c || "").toLowerCase().slice(0, 2);
  return l === "ru" ? "ru" : l === "en" ? "en" : "uz";
};

function tashkentHour(): number {
  try {
    const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Tashkent", hour12: false, hour: "2-digit" });
    let h = parseInt(fmt.format(new Date()).slice(0, 2), 10);
    if (h === 24) h = 0;
    return h;
  } catch {
    return new Date().getUTCHours() + 5;
  }
}

async function sendMessage(chatId: number, text: string, url: string, btn: string) {
  return fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true,
      reply_markup: { inline_keyboard: [[{ text: btn, url }]] },
    }),
  });
}

// Localized copy. Warm, specific, one clear action.
const COPY = {
  waiting: {
    uz: (n: number, h: number | null) =>
      `👋 <b>Ustoz, sizni kutishmoqda.</b>\n${n} ta talaba javob kutmoqda${h != null ? ` — eng eskisi ${Math.round(h)} soat oldin` : ""}.\nGuruhingizga o'tib, qisqacha javob bering 🙌`,
    ru: (n: number, h: number | null) =>
      `👋 <b>Вас ждут, преподаватель.</b>\n${n} студ. ждут ответа${h != null ? ` — самый давний ${Math.round(h)} ч назад` : ""}.\nЗайдите в группу и ответьте 🙌`,
    en: (n: number, h: number | null) =>
      `👋 <b>Your students are waiting.</b>\n${n} waiting for a reply${h != null ? ` — oldest ${Math.round(h)}h ago` : ""}.\nHop into your group and answer 🙌`,
  },
  offline: {
    uz: (days: number, pending: number) =>
      `👋 <b>Xush kelibsiz, ustoz!</b>\n${days} kundan beri ko'rinmadingiz.${pending > 0 ? ` ${pending} ta vazifa sizni kutmoqda 🌱` : ""}\nBir daqiqa vaqt topsangiz — talabalaringiz xursand bo'ladi.`,
    ru: (days: number, pending: number) =>
      `👋 <b>С возвращением, преподаватель!</b>\nВас не было ${days} дн.${pending > 0 ? ` ${pending} заданий ждут проверки 🌱` : ""}\nНайдёте минутку — студенты будут рады.`,
    en: (days: number, pending: number) =>
      `👋 <b>Welcome back!</b>\nYou've been away ${days} days.${pending > 0 ? ` ${pending} submissions are waiting 🌱` : ""}\nA minute of your time means a lot to your students.`,
  },
};
const BTN: Record<Locale, { waiting: string; offline: string }> = {
  uz: { waiting: "📋 Navbatni ochish", offline: "👤 Profilni ochish" },
  ru: { waiting: "📋 Открыть очередь", offline: "👤 Открыть профиль" },
  en: { waiting: "📋 Open queue", offline: "👤 Open profile" },
};

function randomToken(len = 32): string {
  const b = new Uint8Array(len / 2);
  crypto.getRandomValues(b);
  return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const provided = req.headers.get("x-internal-secret");
  if (!provided || provided !== (await internalSecret())) {
    return new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
  if (!BOT_TOKEN) {
    return new Response(JSON.stringify({ ok: false, error: "bot not configured" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
  const admin = __admin;

  // Quiet hours: no teacher pings 22:00–08:00 Tashkent.
  const hr = tashkentHour();
  if (hr < 8 || hr >= 22) {
    return new Response(JSON.stringify({ ok: true, skipped: "quiet_hours", hour: hr }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  const { data: rows, error } = await admin.rpc("teacher_nudge_signals", { p_q_hours: Q_HOURS, p_window_days: WINDOW_DAYS });
  if (error) {
    return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
  const signals = ((rows || []) as any[]).filter((r) => r.telegram_id && r.notifications_enabled !== false);
  if (!signals.length) {
    return new Response(JSON.stringify({ ok: true, processed: 0 }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  // Recent nudge log for cooldown checks (one query, then in-memory).
  const teacherIds = signals.map((s) => s.teacher_id);
  const since = new Date(Date.now() - Math.max(WAIT_COOLDOWN_H, OFFLINE_COOLDOWN_H) * 3600_000).toISOString();
  const { data: logs } = await admin.from("notifications_log")
    .select("user_id, notification_type, sent_at")
    .in("user_id", teacherIds)
    .in("notification_type", ["teacher_waiting", "teacher_offline"])
    .gte("sent_at", since);
  const lastSent = new Map<string, number>();
  for (const l of ((logs || []) as any[])) {
    const key = `${l.user_id}:${l.notification_type}`;
    const ts = new Date(l.sent_at).getTime();
    if (!lastSent.has(key) || ts > lastSent.get(key)!) lastSent.set(key, ts);
  }
  const cooledDown = (uid: string, type: string, hours: number) => {
    const last = lastSent.get(`${uid}:${type}`);
    return !last || (Date.now() - last) >= hours * 3600_000;
  };

  let sentWaiting = 0, sentOffline = 0, skipped = 0;

  for (const s of signals) {
    try {
      const loc = normLocale(s.preferred_locale);
      // Decide the single most useful nudge for this teacher this run.
      let type: "waiting" | "offline" | null = null;
      if (s.waiting_questions > 0 && cooledDown(s.teacher_id, "teacher_waiting", WAIT_COOLDOWN_H)) {
        type = "waiting";
      } else if (s.offline_hours != null && s.offline_hours >= OFFLINE_MIN_H && s.offline_hours <= OFFLINE_MAX_H
                 && s.pending_homework > 0 && cooledDown(s.teacher_id, "teacher_offline", OFFLINE_COOLDOWN_H)) {
        type = "offline";
      }
      if (!type) { skipped++; continue; }

      // Personal magic link into Mission Control (queue for waiting, profile for offline).
      const token = randomToken(32);
      await admin.from("telegram_magic_links").insert({
        token, user_id: s.teacher_id, purpose: "login", target_path: "/profile",
        expires_at: new Date(Date.now() + 3 * 86400_000).toISOString(),
      });
      const url = `${SITE_URL}/auth/magic?t=${token}`;

      const text = type === "waiting"
        ? COPY.waiting[loc](s.waiting_questions, s.oldest_wait_hours)
        : COPY.offline[loc](Math.round(s.offline_hours / 24), s.pending_homework);
      const btn = type === "waiting" ? BTN[loc].waiting : BTN[loc].offline;

      const resp = await sendMessage(Number(s.telegram_id), text, url, btn);
      const jr = await resp.json().catch(() => ({}));
      if (!jr?.ok) { console.error("teacher nudge send fail", s.teacher_id, type, jr?.description); skipped++; continue; }

      await admin.from("notifications_log").insert({
        user_id: s.teacher_id,
        notification_type: type === "waiting" ? "teacher_waiting" : "teacher_offline",
        payload: type === "waiting"
          ? { waiting_questions: s.waiting_questions, oldest_wait_hours: s.oldest_wait_hours }
          : { offline_hours: s.offline_hours, pending_homework: s.pending_homework },
        sent_at: new Date().toISOString(),
      });
      if (type === "waiting") sentWaiting++; else sentOffline++;
    } catch (e) {
      console.error("teacher nudge loop error", s.teacher_id, e);
      skipped++;
    }
  }

  return new Response(JSON.stringify({ ok: true, processed: signals.length, sentWaiting, sentOffline, skipped }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
