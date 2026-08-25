// Evening import digest: per-admin local-time delivery (~18:00) of "N students imported today"
// from the sales Google Sheet. Invoked every 30 min by pg_cron; guarded by the internal secret.
// Sends only when there was at least one import that day (no noise on quiet days).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { verifyInternalSecret } from "../_shared/internal-secret.ts";
import { sendTelegram } from "../_shared/telegram-send.ts";

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
const MSG: Record<Locale, (n: number) => string> = {
  uz: (n) => `📥 Bugun ro'yxatga olingan yangi talabalar: <b>${n}</b>`,
  ru: (n) => `📥 Импортировано новых студентов сегодня: <b>${n}</b>`,
  en: (n) => `📥 New students imported today: <b>${n}</b>`,
};

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") || "";
const __admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

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
const minutesBetween = (h1: number, m1: number, h2: number, m2: number) => Math.abs(h1 * 60 + m1 - (h2 * 60 + m2));

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (!(await verifyInternalSecret(req, __admin))) {
    return new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
  if (!BOT_TOKEN) return new Response(JSON.stringify({ error: "bot not configured" }), { status: 200, headers: corsHeaders });

  const admin = __admin;
  const reqBody = await req.json().catch(() => ({}));
  const force: boolean = !!reqBody?.force;

  const { data: roles } = await admin.from("user_roles").select("user_id").eq("role", "admin");
  const adminIds = (roles || []).map((r: any) => r.user_id);
  if (!adminIds.length) return new Response(JSON.stringify({ ok: true, sent: 0, reason: "no admins" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  const { data: admins } = await admin
    .from("profiles")
    .select("id, telegram_id, timezone, preferred_locale, notifications_enabled")
    .in("id", adminIds)
    .eq("notifications_enabled", true)
    .not("telegram_id", "is", null);
  if (!admins?.length) return new Response(JSON.stringify({ ok: true, sent: 0, reason: "no eligible admins" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  // Count today's imports once (rolling 24h, consistent with the morning brief's "new_today").
  let importedToday: number | null = null;
  let sent = 0, skipped = 0;

  for (const a of admins) {
    try {
      const tz = a.timezone || "Asia/Tashkent";
      const { hour, minute, ymd } = localTimeParts(tz);
      if (!force && minutesBetween(hour, minute, 18, 0) > 20) { skipped++; continue; }

      // One send per admin per local day.
      const { data: prior } = await admin
        .from("admin_notification_log")
        .select("id")
        .eq("user_id", a.id)
        .eq("notification_type", "import_digest")
        .gte("sent_at", new Date(Date.now() - 22 * 3600 * 1000).toISOString())
        .limit(1);
      if (!force && prior && prior.length > 0) { skipped++; continue; }

      if (importedToday === null) {
        const { count } = await admin
          .from("admin_actions")
          .select("id", { count: "exact", head: true })
          .eq("action", "sheet_import")
          .gte("created_at", new Date(Date.now() - 86_400_000).toISOString());
        importedToday = count || 0;
      }
      if (importedToday === 0 && !force) { skipped++; continue; } // no imports → no noise

      const locale = normLocale(a.preferred_locale);
      const out = await sendTelegram(
        BOT_TOKEN,
        "sendMessage",
        { chat_id: Number(a.telegram_id), text: MSG[locale](importedToday), parse_mode: "HTML" },
        { admin, purpose: "import_digest", recipientId: Number(a.telegram_id) },
      );
      if (!out.ok) continue;
      await admin.from("admin_notification_log").insert({
        user_id: a.id, notification_type: "import_digest", payload: { ymd, imported_today: importedToday },
      });
      sent++;
    } catch (e) {
      console.error("import-digest loop error", a.id, e);
    }
  }

  return new Response(JSON.stringify({ ok: true, sent, skipped, eligible: admins.length, imported_today: importedToday }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
