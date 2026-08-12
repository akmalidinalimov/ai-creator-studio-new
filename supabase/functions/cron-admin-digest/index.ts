// Admin daily brief: per-admin local-time delivery (~08:00) of platform metrics.
// Designed to be invoked every 30 minutes by the same scheduler as cron-engagement.
// Uses notification_templates(admin_daily_brief, locale) for message body.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { verifyInternalSecret } from "../_shared/internal-secret.ts";

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

const FALLBACK: Record<Locale, string> = {
  uz: "📊 Kunlik hisobot ({{date}})\n\n👥 Jami: {{total_students}} | 🟢 Faol 7k: {{active_7d}}\n😴 3 kun faolsiz: {{inactive_3d}} | 💤 7 kun: {{inactive_7d}}\n🚫 Hech qachon kirmagan: {{never_logged_in}}\n🆕 Yangi (24s): {{new_today}} | ✅ Darslar (24s): {{lessons_completed_today}}",
  ru: "📊 Ежедневный отчёт ({{date}})\n\n👥 Всего: {{total_students}} | 🟢 Активно 7д: {{active_7d}}\n😴 3 дня без активности: {{inactive_3d}} | 💤 7 дней: {{inactive_7d}}\n🚫 Никогда не входили: {{never_logged_in}}\n🆕 Новых (24ч): {{new_today}} | ✅ Уроков (24ч): {{lessons_completed_today}}",
  en: "📊 Daily brief ({{date}})\n\n👥 Total: {{total_students}} | 🟢 Active 7d: {{active_7d}}\n😴 Inactive 3d: {{inactive_3d}} | 💤 7d: {{inactive_7d}}\n🚫 Never logged in: {{never_logged_in}}\n🆕 New (24h): {{new_today}} | ✅ Lessons (24h): {{lessons_completed_today}}",
};

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") || "";

const __admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

function tg(method: string, body: unknown) {
  return fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function interpolate(s: string, vars: Record<string, string | number>): string {
  return s.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, k) => String(vars[k] ?? ""));
}

function localTimeParts(tz: string): { hour: number; minute: number; ymd: string } {
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    });
    const parts = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
    let h = parseInt(parts.hour || "0", 10);
    if (h === 24) h = 0;
    return { hour: h, minute: parseInt(parts.minute || "0", 10), ymd: `${parts.year}-${parts.month}-${parts.day}` };
  } catch {
    const d = new Date();
    return { hour: d.getUTCHours(), minute: d.getUTCMinutes(), ymd: d.toISOString().slice(0, 10) };
  }
}

const minutesBetween = (h1: number, m1: number, h2: number, m2: number) =>
  Math.abs(h1 * 60 + m1 - (h2 * 60 + m2));

async function loadTemplate(admin: any, locale: Locale): Promise<string> {
  const { data } = await admin
    .from("notification_templates")
    .select("locale, body")
    .eq("template_key", "admin_daily_brief");
  const map = new Map<string, string>();
  for (const r of (data || []) as any[]) map.set(r.locale, r.body);
  return map.get(locale) || map.get("uz") || FALLBACK[locale];
}

async function computeMetrics(admin: any) {
  const now = Date.now();
  const day = 86_400_000;
  const since24h = new Date(now - day).toISOString();
  const since7d = new Date(now - 7 * day).toISOString();

  const { data: users, error: usersErr } = await admin.rpc("admin_list_users_internal");
  if (usersErr) console.error("admin_list_users_internal failed", usersErr);
  const students = (users || []).filter((u: any) => !u.is_admin);
  const total = students.length;
  const studentIds = students.map((u: any) => u.id);

  const neverLoggedIn = students.filter((u: any) => !u.last_sign_in_at).length;
  const newToday = students.filter((u: any) => u.created_at && u.created_at >= since24h).length;

  // Activity: max(auth_events.created_at, lesson_progress.updated_at)
  const lastByUser = new Map<string, number>();
  if (studentIds.length > 0) {
    const { data: auth } = await admin
      .from("auth_events").select("user_id, created_at")
      .in("user_id", studentIds).gte("created_at", new Date(now - 30 * day).toISOString());
    for (const r of (auth || []) as any[]) {
      const t = new Date(r.created_at).getTime();
      const cur = lastByUser.get(r.user_id) || 0;
      if (t > cur) lastByUser.set(r.user_id, t);
    }
    const { data: prog } = await admin
      .from("lesson_progress").select("user_id, updated_at")
      .in("user_id", studentIds).gte("updated_at", new Date(now - 30 * day).toISOString());
    for (const r of (prog || []) as any[]) {
      const t = new Date(r.updated_at).getTime();
      const cur = lastByUser.get(r.user_id) || 0;
      if (t > cur) lastByUser.set(r.user_id, t);
    }
  }

  let active7d = 0, inactive3d = 0, inactive7d = 0;
  for (const u of students) {
    if (!u.last_sign_in_at) continue; // never-logged-in handled separately
    const last = lastByUser.get(u.id) || new Date(u.last_sign_in_at).getTime();
    const days = (now - last) / day;
    if (days <= 7) active7d++;
    if (days >= 3) inactive3d++;
    if (days >= 7) inactive7d++;
  }

  const { count: lessonsCompletedToday } = await admin
    .from("lesson_progress")
    .select("id", { count: "exact", head: true })
    .gte("completed_at", since24h);

  return {
    total_students: total,
    active_7d: active7d,
    inactive_3d: inactive3d,
    inactive_7d: inactive7d,
    never_logged_in: neverLoggedIn,
    new_today: newToday,
    lessons_completed_today: lessonsCompletedToday || 0,
    since7d, // unused but reserved
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (!(await verifyInternalSecret(req, __admin))) {
    return new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
  if (!BOT_TOKEN) return new Response(JSON.stringify({ error: "bot not configured" }), { status: 200, headers: corsHeaders });

  const admin = __admin;
  const reqBody = await req.json().catch(() => ({}));
  const force: boolean = !!reqBody?.force;

  // Find admin users with telegram_id and notifications enabled
  const { data: roles } = await admin.from("user_roles").select("user_id").eq("role", "admin");
  const adminIds = (roles || []).map((r: any) => r.user_id);
  if (adminIds.length === 0) {
    return new Response(JSON.stringify({ ok: true, sent: 0, reason: "no admins" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  const { data: admins } = await admin
    .from("profiles")
    .select("id, telegram_id, timezone, preferred_locale, notifications_enabled, name")
    .in("id", adminIds)
    .eq("notifications_enabled", true)
    .not("telegram_id", "is", null);

  if (!admins?.length) {
    return new Response(JSON.stringify({ ok: true, sent: 0, reason: "no eligible admins" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  // Compute metrics once (shared across all admins)
  let metrics: any = null;
  let sent = 0, skipped = 0;

  for (const a of admins) {
    try {
      const tz = a.timezone || "Asia/Tashkent";
      const { hour, minute, ymd } = localTimeParts(tz);
      // Deliver at ~08:00 local time (within ±20 min window)
      if (!force && minutesBetween(hour, minute, 8, 0) > 20) { skipped++; continue; }

      // Dedup per local day via admin_notification_log
      const dayStartUtc = new Date(`${ymd}T00:00:00Z`).toISOString(); // approximate; cheap dedup
      const { data: prior } = await admin
        .from("admin_notification_log")
        .select("id, sent_at")
        .eq("user_id", a.id)
        .eq("notification_type", "admin_daily_brief")
        .gte("sent_at", new Date(Date.now() - 22 * 3600 * 1000).toISOString())
        .limit(1);
      if (!force && prior && prior.length > 0) { skipped++; continue; }

      if (!metrics) metrics = await computeMetrics(admin);

      const locale = normLocale(a.preferred_locale);
      const tpl = await loadTemplate(admin, locale);
      const body = interpolate(tpl, { ...metrics, date: ymd });

      const resp = await tg("sendMessage", { chat_id: Number(a.telegram_id), text: body, parse_mode: "HTML" });
      if (!resp.ok) {
        console.error("sendMessage failed", await resp.text());
        continue;
      }
      await admin.from("admin_notification_log").insert({
        user_id: a.id,
        notification_type: "admin_daily_brief",
        payload: { ymd, ...metrics },
      });
      sent++;
    } catch (e) {
      console.error("admin loop error", a.id, e);
    }
  }

  return new Response(JSON.stringify({ ok: true, sent, skipped, eligible: admins.length }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
