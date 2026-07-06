// Weekly teacher digest (Mondays via pg_cron): the hand-off between the
// automatic inactivity ladder and the teacher's personal nudge. Per teacher:
// pending homework + students still inactive after 2+ system reminders
// (last_inactive_warning_day >= 7), with a magic link into their profile.
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

      if (pending === 0 && names.length === 0) continue; // nothing actionable — stay silent

      // Personal magic link into the Mission Control profile.
      const token = randomToken(32);
      await admin.from("telegram_magic_links").insert({
        token, user_id: tch.id, purpose: "login", target_path: "/profile",
        expires_at: new Date(Date.now() + 7 * 86400_000).toISOString(),
      });
      const url = `${SITE_URL}/auth/magic?t=${token}`;

      const loc = ["uz", "ru", "en"].includes(tch.preferred_locale) ? tch.preferred_locale : "uz";
      const L: Record<string, { title: string; pend: (n: number) => string; stub: string; hint: string; btn: string }> = {
        uz: { title: `🗞 <b>Haftalik xulosa</b> — ${tch.name || ""}`,
          pend: (n) => `📝 Baholashni kutmoqda: <b>${n}</b> ta vazifa`,
          stub: "😴 Tizim eslatmalari qaytara olmagan talabalar — shaxsiy 👋 eslatmangiz kuchliroq ishlaydi:",
          hint: "Profil → Talabalarim → 😴 filtri → «Barchasiga eslatma»", btn: "👤 Profilni ochish" },
        ru: { title: `🗞 <b>Итоги недели</b> — ${tch.name || ""}`,
          pend: (n) => `📝 Ждут проверки: <b>${n}</b> заданий`,
          stub: "😴 Студенты, которых не вернули системные напоминания — ваше личное 👋 сработает сильнее:",
          hint: "Профиль → Студенты → фильтр 😴 → «Напомнить всем»", btn: "👤 Открыть профиль" },
        en: { title: `🗞 <b>Weekly summary</b> — ${tch.name || ""}`,
          pend: (n) => `📝 Waiting to grade: <b>${n}</b>`,
          stub: "😴 Students the system reminders couldn't bring back — your personal 👋 works better:",
          hint: "Profile → Students → 😴 filter → “Remind all”", btn: "👤 Open profile" },
      };
      const l = L[loc];
      const lines = [l.title, ""];
      if (pending > 0) lines.push(l.pend(pending));
      if (names.length) { lines.push("", l.stub, names.map((n) => `• ${n}`).join("\n"), "", `💡 ${l.hint}`); }

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
          payload: { pending, stubborn: names.length }, sent_at: new Date().toISOString(),
        });
      }
    } catch (e) { console.error("teacher digest failed", tch.id, e); }
  }
  return new Response(JSON.stringify({ ok: true, sent }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
});
