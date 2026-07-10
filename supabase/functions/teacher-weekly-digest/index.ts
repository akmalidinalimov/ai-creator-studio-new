// Weekly teacher digest (Mondays via pg_cron). Personalized "your cohort this week" recap —
// the mechanic with the strongest evidence for lifting teacher engagement (RCT over ~140k
// teachers: a specific, self-relevant progress nudge beat every generic/gimmick alternative).
// Per teacher, framed as IMPACT first (active students, completion, what you graded, on-time %,
// XP earned + level), then the ACTIONABLE tail (pending homework, students the system reminders
// couldn't recover — last_inactive_warning_day >= 7), with a magic link into their profile.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-internal-secret",
};
const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") || "";
const SITE_URL = Deno.env.get("SITE_URL") || "https://aicreator.academy";

function randomToken(len = 32): string {
  const b = new Uint8Array(len / 2);
  crypto.getRandomValues(b);
  return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.headers.get("x-internal-secret") !== Deno.env.get("INTERNAL_FN_SECRET")) {
    return new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const { data: tRoles } = await admin.from("user_roles").select("user_id").eq("role", "teacher");
  const tIds = (((tRoles || []) as any[]).map((r) => r.user_id));
  const { data: teachers } = tIds.length
    ? await admin.from("profiles").select("id, name, telegram_id, preferred_locale")
        .in("id", tIds).not("telegram_id", "is", null)
    : { data: [] as any[] };

  let sent = 0;
  for (const tch of ((teachers || []) as any[])) {
    try {
      const { data: gs } = await admin.rpc("teacher_groups", { uid: tch.id });
      const groups = ((gs || []) as any[]);
      if (!groups.length) continue;
      const pending = groups.reduce((s, g) => s + (g.pending_homework || 0), 0);

      // Students of this teacher who got a 7d/14d/30d system reminder and are
      // STILL flagged inactive — the "system couldn't bring them back" list.
      const gids = groups.map((g: any) => g.group_id);
      const { data: stubborn } = await admin
        .from("profiles")
        .select("name, last_name, last_inactive_warning_day")
        .in("group_id", gids)
        .gte("last_inactive_warning_day", 7)
        .eq("status", "active")
        .order("last_inactive_warning_day", { ascending: false })
        .limit(6);
      const names = ((stubborn || []) as any[])
        .map((s) => `${s.name || ""} ${s.last_name ? s.last_name[0] + "." : ""}`.trim() + ` (${s.last_inactive_warning_day}k)`)
        .filter((n) => n.length > 4);

      // ---- Impact recap (the RCT-winning mechanic: personalized "your cohort this week") ----
      const totalStudents = groups.reduce((s, g: any) => s + (g.total_students || 0), 0);
      const activeStudents = groups.reduce((s, g: any) => s + (g.active_7d || 0), 0);
      const avgCompletion = totalStudents > 0
        ? Math.round(groups.reduce((s, g: any) => s + (g.avg_completion_pct || 0) * (g.total_students || 0), 0) / totalStudents)
        : null;
      // The teacher's own week (grading speed / on-time / responsiveness). RPC is new — tolerate absence.
      let week: any = null;
      try {
        const { data: wd } = await admin.rpc("teacher_weekly_self", { uid: tch.id, p_days: 7 });
        week = Array.isArray(wd) ? wd[0] : wd;
      } catch { /* migration not applied yet — skip the block */ }
      // XP earned this week + current level (mastery framing).
      const weekAgo = new Date(Date.now() - 7 * 86400_000).toISOString();
      const { data: xpEv } = await admin.from("xp_events").select("amount")
        .eq("user_id", tch.id).like("reason", "teacher_%").gte("created_at", weekAgo);
      const xpWeek = ((xpEv || []) as any[]).reduce((s, e) => s + (e.amount || 0), 0);
      const { data: uxp } = await admin.from("user_xp").select("level").eq("user_id", tch.id).maybeSingle();
      const tLevel = (uxp as any)?.level ?? 1;

      const hasImpact = activeStudents > 0 || (week && week.graded > 0) || xpWeek > 0;
      if (pending === 0 && names.length === 0 && !hasImpact) continue; // truly nothing — stay silent

      // Personal magic link into the Mission Control profile.
      const token = randomToken(32);
      await admin.from("telegram_magic_links").insert({
        token, user_id: tch.id, purpose: "login", target_path: "/profile",
        expires_at: new Date(Date.now() + 7 * 86400_000).toISOString(),
      });
      const url = `${SITE_URL}/auth/magic?t=${token}`;

      const loc = ["uz", "ru", "en"].includes(tch.preferred_locale) ? tch.preferred_locale : "uz";
      const LVL: Record<string, string[]> = {
        uz: ["Yangi ustoz", "Ustoz", "Katta ustoz", "Tajribali ustoz", "Top ustoz"],
        ru: ["Молодой педагог", "Педагог", "Старший педагог", "Опытный педагог", "Топ-педагог"],
        en: ["Rising teacher", "Teacher", "Senior teacher", "Expert teacher", "Top teacher"],
      };
      const lvlName = LVL[loc][Math.min(tLevel, LVL[loc].length) - 1] || `Lv ${tLevel}`;
      const L: Record<string, any> = {
        uz: {
          title: `🗞 <b>Haftalik xulosa</b> — ${tch.name || ""}`,
          impactTitle: "📊 Bu hafta guruhlaringizda:",
          active: (a: number, t: number) => `👥 Faol talabalar: <b>${a}/${t}</b> (7 kun)`,
          completion: (p: number) => `✅ O'rtacha tugallanish: <b>${p}%</b>`,
          graded: (g: number, ot: number | null) => `✍️ Siz baholadingiz: <b>${g}</b>${ot != null ? ` · ${ot}% vaqtida` : ""}`,
          answered: (r: number) => `💬 Savollarga javob berildi: <b>${r}%</b>`,
          xpGain: (n: number, lv: string) => `⭐ Bu hafta: <b>+${n} XP</b> · ${lv}`,
          pend: (n: number) => `📝 Baholashni kutmoqda: <b>${n}</b> ta vazifa`,
          stub: "😴 Tizim eslatmalari qaytara olmagan talabalar — shaxsiy 👋 eslatmangiz kuchliroq ishlaydi:",
          hint: "Profil → Talabalarim → 😴 filtri → «Barchasiga eslatma»", btn: "👤 Profilni ochish",
        },
        ru: {
          title: `🗞 <b>Итоги недели</b> — ${tch.name || ""}`,
          impactTitle: "📊 На этой неделе в ваших группах:",
          active: (a: number, t: number) => `👥 Активных студентов: <b>${a}/${t}</b> (7 дн.)`,
          completion: (p: number) => `✅ Средн. завершение: <b>${p}%</b>`,
          graded: (g: number, ot: number | null) => `✍️ Вы проверили: <b>${g}</b>${ot != null ? ` · ${ot}% вовремя` : ""}`,
          answered: (r: number) => `💬 Отвечено на вопросы: <b>${r}%</b>`,
          xpGain: (n: number, lv: string) => `⭐ За неделю: <b>+${n} XP</b> · ${lv}`,
          pend: (n: number) => `📝 Ждут проверки: <b>${n}</b> заданий`,
          stub: "😴 Студенты, которых не вернули системные напоминания — ваше личное 👋 сработает сильнее:",
          hint: "Профиль → Студенты → фильтр 😴 → «Напомнить всем»", btn: "👤 Открыть профиль",
        },
        en: {
          title: `🗞 <b>Weekly summary</b> — ${tch.name || ""}`,
          impactTitle: "📊 This week in your groups:",
          active: (a: number, t: number) => `👥 Active students: <b>${a}/${t}</b> (7d)`,
          completion: (p: number) => `✅ Avg. completion: <b>${p}%</b>`,
          graded: (g: number, ot: number | null) => `✍️ You graded: <b>${g}</b>${ot != null ? ` · ${ot}% on time` : ""}`,
          answered: (r: number) => `💬 Questions answered: <b>${r}%</b>`,
          xpGain: (n: number, lv: string) => `⭐ This week: <b>+${n} XP</b> · ${lv}`,
          pend: (n: number) => `📝 Waiting to grade: <b>${n}</b>`,
          stub: "😴 Students the system reminders couldn't bring back — your personal 👋 works better:",
          hint: "Profile → Students → 😴 filter → “Remind all”", btn: "👤 Open profile",
        },
      };
      const l = L[loc];
      const lines = [l.title, ""];
      // Lead with impact (positive, self-relevant) — the part that actually drives engagement.
      const impact: string[] = [];
      if (totalStudents > 0) impact.push(l.active(activeStudents, totalStudents));
      if (avgCompletion != null) impact.push(l.completion(avgCompletion));
      if (week && week.graded > 0) impact.push(l.graded(week.graded, week.on_time_pct));
      if (week && week.questions > 0 && week.answer_rate != null) impact.push(l.answered(week.answer_rate));
      if (xpWeek > 0) impact.push(l.xpGain(xpWeek, lvlName));
      if (impact.length) lines.push(l.impactTitle, ...impact);
      // Then the actionable tail.
      if (pending > 0) lines.push("", l.pend(pending));
      if (names.length) lines.push("", l.stub, names.map((n) => `• ${n}`).join("\n"), "", `💡 ${l.hint}`);

      const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: Number(tch.telegram_id), text: lines.join("\n"), parse_mode: "HTML",
          disable_web_page_preview: true,
          reply_markup: { inline_keyboard: [[{ text: l.btn, url }]] },
        }),
      });
      const jr = await r.json().catch(() => ({}));
      if (jr?.ok) {
        sent++;
        await admin.from("notifications_log").insert({
          user_id: tch.id, notification_type: "teacher_weekly_digest",
          payload: { pending, stubborn: names.length, graded: week?.graded ?? 0, xp_week: xpWeek }, sent_at: new Date().toISOString(),
        });
      }
    } catch (e) { console.error("teacher digest failed", tch.id, e); }
  }
  return new Response(JSON.stringify({ ok: true, sent }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
});
