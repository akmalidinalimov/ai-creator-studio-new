import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-internal-secret",
};

// Sends via the Telegram Bot API directly (was Lovable's connector gateway,
// which needed LOVABLE_API_KEY + TELEGRAM_API_KEY — not available off Lovable).
const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") || "";

const __admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
let __sec: string | null = null;
async function __internalSecret(): Promise<string> {
  if (__sec) return __sec;
  const { data, error } = await __admin.rpc("internal_fn_secret");
  if (error) throw error;
  __sec = data as string;
  return __sec;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const __p = req.headers.get("x-internal-secret");
  const __s = await __internalSecret();
  if (!__p || __p !== __s) {
    return new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  const admin = __admin;

  let dryRun = false;
  try {
    const body = await req.json();
    dryRun = !!body?.dry_run;
  } catch (_) {}

  const { data: profiles } = await admin
    .from("profiles")
    .select("id, name, telegram_id, preferred_language, digest_opt_in")
    .eq("digest_opt_in", true)
    .eq("status", "active")
    .not("telegram_id", "is", null);

  let sent = 0, skipped = 0, errors = 0;
  const since = new Date(Date.now() - 7 * 86400_000).toISOString();

  for (const p of profiles || []) {
    try {
      const [{ data: prog }, { data: streak }, { data: rank }] = await Promise.all([
        admin.from("lesson_progress").select("watch_seconds_total, completed_at").eq("user_id", p.id).gte("updated_at", since),
        admin.from("streaks").select("current_streak").eq("user_id", p.id).maybeSingle(),
        admin.from("leaderboard_cache").select("rank").eq("user_id", p.id).maybeSingle(),
      ]);
      const minutes = Math.round((prog || []).reduce((s: number, r: any) => s + (Number(r.watch_seconds_total) || 0), 0) / 60);
      const lessons = (prog || []).filter((r: any) => r.completed_at && new Date(r.completed_at) >= new Date(since)).length;
      const cur = streak?.current_streak || 0;
      const r = rank?.rank ?? "—";

      if (minutes === 0 && lessons === 0 && cur === 0) { skipped++; continue; }

      const lang = (p.preferred_language || "uz").slice(0, 2);
      const name = p.name || "Talaba";
      const txt = lang === "ru"
        ? `Привет, ${name}! 📊 Итоги недели:\n• ${minutes} минут учёбы\n• ${lessons} уроков завершено\n• Серия: 🔥 ${cur} дней\n• Место в рейтинге: ${r}`
        : lang === "en"
        ? `Hi ${name}! 📊 Your week:\n• ${minutes} min studied\n• ${lessons} lessons completed\n• Streak: 🔥 ${cur} days\n• Rank: ${r}`
        : `Salom, ${name}! 📊 Bu hafta natijalaringiz:\n• ${minutes} daqiqa o'rgandingiz\n• ${lessons} ta dars tugatdingiz\n• Streak: 🔥 ${cur} kun\n• Reyting: ${r}-o'rin`;

      if (dryRun) { sent++; continue; }
      if (!BOT_TOKEN) { errors++; continue; }

      const r2 = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: p.telegram_id, text: txt }),
      });
      if (!r2.ok) errors++; else sent++;
      await new Promise(res => setTimeout(res, 50));
    } catch (_) { errors++; }
  }

  return new Response(JSON.stringify({ sent, skipped, errors, dryRun }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
