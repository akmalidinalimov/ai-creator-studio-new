import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendTelegram } from "../_shared/telegram-send.ts";
import { verifyInternalSecret } from "../_shared/internal-secret.ts";
import { type GroupRanking, loadGroupRanking, rankOf } from "../_shared/group-rank.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-internal-secret",
};

// Sends via the Telegram Bot API directly (was Lovable's connector gateway,
// which needed LOVABLE_API_KEY + TELEGRAM_API_KEY — not available off Lovable).
const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") || "";

const __admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  // Shared rotation-safe verifier (_shared/internal-secret.ts): cached, re-fetched once on mismatch.
  if (!(await verifyInternalSecret(req, __admin))) {
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
    .select("id, name, telegram_id, preferred_language, digest_opt_in, group_id")
    .eq("digest_opt_in", true)
    .eq("status", "active")
    .not("telegram_id", "is", null);

  let sent = 0, skipped = 0, errors = 0;
  const since = new Date(Date.now() - 7 * 86400_000).toISOString();

  // The rank line is the student's GROUP rank from the same GroupRanking the bot's 👤 card, 📊 Statistika and
  // 👥 Guruh reytingi print (_shared/group-rank.ts → group_leaderboard). It used to be leaderboard_cache.rank: a
  // global 30-day ACTIVITY rank across every cohort (e.g. "245-o'rin"), a third number no other screen showed.
  // One group_leaderboard read per group (the ranks are the same for every member); no rank line without a
  // group, with 0 points, or when the read failed (loadGroupRanking records that failure, DB-visible).
  const rankings = new Map<string, GroupRanking | null>();
  const groupRankFor = async (groupId: string | null, userId: string) => {
    if (!groupId) return null;
    if (!rankings.has(groupId)) {
      const { ranking, failed } = await loadGroupRanking(admin, userId, "weekly-digest");
      rankings.set(groupId, failed ? null : ranking);
    }
    const r = rankings.get(groupId);
    return r ? rankOf(r, userId) : null;
  };

  for (const p of profiles || []) {
    try {
      const [{ data: prog }, { data: streak }, rank] = await Promise.all([
        admin.from("lesson_progress").select("watch_seconds_total, completed_at").eq("user_id", p.id).gte("updated_at", since),
        admin.from("streaks").select("current_streak").eq("user_id", p.id).maybeSingle(),
        groupRankFor(p.group_id ?? null, p.id),
      ]);
      const minutes = Math.round((prog || []).reduce((s: number, r: any) => s + (Number(r.watch_seconds_total) || 0), 0) / 60);
      const lessons = (prog || []).filter((r: any) => r.completed_at && new Date(r.completed_at) >= new Date(since)).length;
      const cur = streak?.current_streak || 0;

      if (minutes === 0 && lessons === 0 && cur === 0) { skipped++; continue; }

      const lang = (p.preferred_language || "uz").slice(0, 2);
      const name = p.name || "Talaba";
      const rankLine = !rank ? ""
        : lang === "ru" ? `\n• Место в группе: ${rank.rank}/${rank.size}`
        : lang === "en" ? `\n• Group rank: ${rank.rank}/${rank.size}`
        : `\n• Guruhdagi o'rningiz: ${rank.rank}/${rank.size}`;
      const txt = lang === "ru"
        ? `Привет, ${name}! 📊 Итоги недели:\n• ${minutes} минут учёбы\n• ${lessons} уроков завершено\n• Серия: 🔥 ${cur} дней${rankLine}`
        : lang === "en"
        ? `Hi ${name}! 📊 Your week:\n• ${minutes} min studied\n• ${lessons} lessons completed\n• Streak: 🔥 ${cur} days${rankLine}`
        : `Salom, ${name}! 📊 Bu hafta natijalaringiz:\n• ${minutes} daqiqa o'rgandingiz\n• ${lessons} ta dars tugatdingiz\n• Streak: 🔥 ${cur} kun${rankLine}`;

      if (dryRun) { sent++; continue; }
      if (!BOT_TOKEN) { errors++; continue; }

      const out = await sendTelegram(BOT_TOKEN, "sendMessage", { chat_id: p.telegram_id, text: txt }, { admin, purpose: "weekly_digest", recipientId: p.telegram_id });
      if (!out.ok) errors++; else sent++;
      await new Promise(res => setTimeout(res, 50));
    } catch (_) { errors++; }
  }

  return new Response(JSON.stringify({ sent, skipped, errors, dryRun }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
