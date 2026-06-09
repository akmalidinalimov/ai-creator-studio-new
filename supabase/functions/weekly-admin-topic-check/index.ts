// Weekly check: DM all admins listing groups+modules with no Telegram topic configured.
// Scheduled Sundays 19:00 Asia/Tashkent (= 14:00 UTC) via pg_cron.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

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

async function tgSend(chatId: number, text: string) {
  if (!BOT_TOKEN) return;
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const __p = req.headers.get("x-internal-secret");
  const __s = await __internalSecret();
  if (!__p || __p !== __s) {
    return new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  const admin = __admin;

  try {
    // Active courses → modules
    const { data: courses } = await admin.from("courses").select("id, title").eq("published", true);
    const courseIds = (courses || []).map((c: any) => c.id);
    const { data: modules } = courseIds.length
      ? await admin.from("modules").select("id, title, position, course_id").in("course_id", courseIds)
      : { data: [] };
    const { data: groups } = await admin.from("groups").select("id, name, course_id, homework_topic_url");
    const { data: topics } = await admin.from("group_module_topics").select("group_id, module_id");

    const tset = new Set((topics || []).map((t: any) => `${t.group_id}::${t.module_id}`));
    const sharedByGroup = new Map<string, string | null>(
      ((groups || []) as any[]).map((g: any) => [g.id, g.homework_topic_url || null]),
    );
    type Missing = { groupName: string; moduleTitle: string; modulePos: number };
    const missing: Missing[] = [];
    for (const g of (groups || []) as any[]) {
      const mods = (modules || []).filter((m: any) => m.course_id === g.course_id);
      for (const m of mods as any[]) {
        const hasPerModule = tset.has(`${g.id}::${m.id}`);
        const hasShared = !!sharedByGroup.get(g.id);
        if (!hasPerModule && !hasShared) {
          missing.push({ groupName: g.name, moduleTitle: m.title, modulePos: m.position });
        }
      }
    }


    // Admin recipients
    const { data: roles } = await admin.from("user_roles").select("user_id").eq("role", "admin");
    const adminIds = (roles || []).map((r: any) => r.user_id);
    const { data: profs } = adminIds.length
      ? await admin.from("profiles").select("id, telegram_id, name").in("id", adminIds)
      : { data: [] };
    const recipients = (profs || []).filter((p: any) => p.telegram_id);

    let body: string;
    if (missing.length === 0) {
      body = "✅ <b>Haftalik topik tekshiruvi</b>\n\nBarcha guruh×modul juftliklari uchun Telegram topiklari sozlangan. 🎉";
    } else {
      const lines = ["⚠️ <b>Haftalik topik tekshiruvi</b>", "", `Sozlanmagan: <b>${missing.length}</b> ta`, ""];
      const grouped = new Map<string, string[]>();
      for (const m of missing) {
        const arr = grouped.get(m.groupName) || [];
        arr.push(`Modul ${(m.modulePos ?? 0) + 1} — ${m.moduleTitle}`);
        grouped.set(m.groupName, arr);
      }
      for (const [g, arr] of grouped.entries()) {
        lines.push(`<b>${g}</b>`);
        for (const it of arr.slice(0, 10)) lines.push(`  • ${it}`);
        if (arr.length > 10) lines.push(`  … va yana ${arr.length - 10} ta`);
        lines.push("");
      }
      lines.push("👉 /admin/groups sahifasida sozlang.");
      body = lines.join("\n");
    }

    let sent = 0;
    for (const r of recipients) {
      try { await tgSend(r.telegram_id, body); sent++; } catch (_e) { /* ignore */ }
      await admin.from("admin_notification_log").insert({
        notification_type: "weekly_topic_check",
        user_id: r.id,
        payload: { missing_count: missing.length },
      });
    }

    return new Response(JSON.stringify({ ok: true, missing: missing.length, sent }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("weekly-admin-topic-check error", e);
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
