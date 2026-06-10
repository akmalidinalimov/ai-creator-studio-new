// Student of the week: DM each group's weekly winner (one-shot per week per winner).
// Mirrors cron-engagement / detect-and-nudge conventions: internal-secret header guard,
// Tashkent quiet hours, nudge_preferences opt-out, nudge_log logging.
// Idempotent: dm_sent_at guard prevents duplicate DMs within a week.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-internal-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const __admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
let __sec: string | null = null;
async function __internalSecret(): Promise<string> {
  if (__sec) return __sec;
  const { data, error } = await __admin.rpc("internal_fn_secret");
  if (error) throw error;
  __sec = data as string;
  return __sec;
}

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") || "";

type Locale = "uz" | "ru" | "en";
const normLocale = (c?: string | null): Locale => {
  const l = (c || "").toLowerCase().slice(0, 2);
  if (l === "ru") return "ru";
  if (l === "en") return "en";
  return "uz";
};

const MESSAGES: Record<Locale, string> = {
  uz: "🏆 Tabriklaymiz! Bu hafta guruhingizda eng yuqori faollik balini to'pladingiz — siz hafta yulduzisiz! ⭐\n\nAjoyib natija, shu ruhda davom eting! 🚀",
  ru: "🏆 Поздравляем! На этой неделе вы набрали наивысший балл активности в группе — вы звезда недели! ⭐\n\nОтличный результат, так держать! 🚀",
  en: "🏆 Congratulations! You scored the highest activity in your group this week — you're the star of the week! ⭐\n\nGreat work, keep it up! 🚀",
};

async function tgSend(chatId: number, text: string) {
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok && data?.ok, status: r.status, data };
}

function localHour(offsetMinutes: number) {
  const ms = Date.now() + offsetMinutes * 60_000;
  return new Date(ms).getUTCHours();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function currentWeekStartTashkent(): string {
  // date_trunc('week', now() at time zone 'Asia/Tashkent') — Monday-based ISO week.
  const ms = Date.now() + 5 * 60 * 60_000; // +05:00
  const d = new Date(ms);
  // getUTCDay: 0 = Sun .. 6 = Sat. Monday-based: shift so Mon = 0.
  const dow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const provided = req.headers.get("x-internal-secret");
    const expected = await __internalSecret();
    if (!provided || provided !== expected) {
      return new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    if (!BOT_TOKEN) {
      return new Response(JSON.stringify({ error: "bot not configured" }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const admin = __admin;

    // 1) Ensure this week's winners are populated.
    await admin.rpc("pick_weekly_group_stars");

    // 2) Pending winners for current week.
    const weekStart = currentWeekStartTashkent();
    const { data: winners, error: wErr } = await admin
      .from("weekly_group_star")
      .select("group_id, week_start, user_id")
      .eq("week_start", weekStart)
      .is("dm_sent_at", null);
    if (wErr) throw wErr;

    let sent = 0, skipped = 0, failed = 0;
    const today = new Date().toISOString().slice(0, 10);

    for (const w of (winners || [])) {
      // 3) Load profile
      const { data: p } = await admin
        .from("profiles")
        .select("id, name, telegram_id, preferred_locale, preferred_language, tashkent_offset_minutes, status")
        .eq("id", w.user_id)
        .maybeSingle();
      if (!p?.telegram_id) { skipped++; continue; }
      if ((p as any).status === "archived") { skipped++; continue; }

      // Opt-out / paused
      const { data: prefs } = await admin
        .from("nudge_preferences")
        .select("opt_in, paused_until")
        .eq("profile_id", p.id)
        .maybeSingle();
      if (prefs && prefs.opt_in === false) { skipped++; continue; }
      if (prefs?.paused_until && prefs.paused_until >= today) { skipped++; continue; }

      // Quiet hours (defer: leave dm_sent_at NULL so the next run can send)
      const hr = localHour((p as any).tashkent_offset_minutes ?? 300);
      if (hr < 8 || hr >= 22) { skipped++; continue; }

      // 4) Send
      const locale = normLocale((p as any).preferred_locale || (p as any).preferred_language);
      const text = MESSAGES[locale];
      const r = await tgSend(Number(p.telegram_id), text);

      if (r.ok) {
        // 5a) Mark sent
        await admin
          .from("weekly_group_star")
          .update({ dm_sent_at: new Date().toISOString() })
          .eq("group_id", w.group_id)
          .eq("week_start", w.week_start);
        await admin.from("nudge_log").insert({
          profile_id: p.id,
          nudge_type: "student_of_week",
          telegram_message_id: String(r.data?.result?.message_id ?? ""),
          payload: { locale, week_start: w.week_start, group_id: w.group_id, ok: true },
          error: null,
        });
        sent++;
      } else {
        // 5b) Failure → log error, leave dm_sent_at NULL for retry
        await admin.from("nudge_log").insert({
          profile_id: p.id,
          nudge_type: "student_of_week",
          telegram_message_id: null,
          payload: { locale, week_start: w.week_start, group_id: w.group_id, ok: false },
          error: JSON.stringify(r.data).slice(0, 500),
        });
        failed++;
      }
      await sleep(50);
    }

    return new Response(JSON.stringify({ ok: true, week_start: weekStart, total: winners?.length || 0, sent, skipped, failed }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e as any)?.message || e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
