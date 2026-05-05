// Sends celebratory Telegram DMs for newly awarded badges. Drains badge_award_queue.
// Triggered by pg_cron every minute and also callable on-demand for testing.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") || "";
const SITE_URL = (Deno.env.get("SITE_URL") || "https://aicreator.academy").replace(/\/$/, "");

function tg(method: string, body: unknown) {
  return fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function randomToken(len = 32): string {
  const b = new Uint8Array(len);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("").slice(0, len);
}

async function magicLink(admin: any, user_id: string, target_path: string): Promise<string> {
  const token = randomToken(32);
  await admin.from("telegram_magic_links").insert({ token, user_id, purpose: "badge_celebration", target_path });
  return `${SITE_URL}/auth/magic?t=${token}`;
}

const SINGLE_INTROS = [
  "🎉 Tabriklayman, {{name}}!",
  "🥳 Zo'r yangilik, {{name}}!",
  "✨ Ofarin, {{name}}!",
];

// Badge-specific celebratory text by code
const BADGE_VARIANTS: Record<string, string> = {
  first_lesson: "Birinchi darsingizni tugatdingiz! Sayohat boshlandi 🚀",
  five_lessons: "5 ta darsni tugatdingiz! Sur'atingiz a'lo.",
  ten_lessons: "10 ta darsni tugatdingiz! Siz haqiqiy o'rganuvchisiz ⭐",
  module_complete: "Birinchi modulni tugatdingiz! Endi keyingisi sari!",
  course_complete: "Butun kursni tugatdingiz! Bu — katta yutuq 🏆",
  streak_7: "7 kun ketma-ket o'qidingiz! Disipplina — muvaffaqiyat kaliti.",
  streak_30: "30 kun ketma-ket! Bu allaqachon odat — tabriklaymiz! 🔥",
  first_homework: "Birinchi uy vazifangizni topshirdingiz! A'lo ish 📝",
};

function buildSingleMessage(name: string, badge: { code: string; name_uz: string; description_uz: string | null; icon: string | null }): string {
  const intro = SINGLE_INTROS[Math.floor(Math.random() * SINGLE_INTROS.length)].replace("{{name}}", name || "talaba");
  const tail = BADGE_VARIANTS[badge.code] || badge.description_uz || "Yangi muvaffaqiyat!";
  const emoji = badge.icon || "🏅";
  return `${intro}\n\nSiz yangi nishonni qo'lga kiritdingiz: ${emoji} <b>${badge.name_uz}</b>\n\n${tail}\n\nDavom eting — sizning faolligingiz boshqa talabalarga ham ilhom beradi! 💪`;
}

function buildBatchMessage(name: string, badges: { name_uz: string; icon: string | null }[]): string {
  const lines = badges.map((b) => `• ${b.icon || "🏅"} ${b.name_uz}`).join("\n");
  return `🎉 Tabriklayman, ${name || "talaba"}! Bugun <b>${badges.length} ta yangi nishon</b> qo'lga kiritdingiz!\n\n${lines}\n\nZo'r ish, davom eting! 🚀`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // Optional debug: { user_id, badge_code } awards a test badge to that user immediately
  if (req.method === "POST") {
    try {
      const body = await req.json().catch(() => ({}));
      if (body?.user_id && body?.badge_code) {
        await admin.rpc("award_badge", { uid: body.user_id, _code: body.badge_code });
      }
    } catch { /* ignore */ }
  }

  if (!BOT_TOKEN) {
    return new Response(JSON.stringify({ ok: false, error: "bot not configured" }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  // Fetch up to N pending rows due now
  const { data: pending, error } = await admin
    .from("badge_award_queue")
    .select("id, user_id, badge_id, awarded_at, scheduled_for")
    .is("sent_at", null)
    .lte("scheduled_for", new Date().toISOString())
    .order("scheduled_for", { ascending: true })
    .limit(200);
  if (error) {
    return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
  const rows = (pending || []) as any[];
  if (!rows.length) {
    return new Response(JSON.stringify({ ok: true, processed: 0 }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  // Group by user
  const byUser = new Map<string, any[]>();
  rows.forEach((r) => {
    const arr = byUser.get(r.user_id) || [];
    arr.push(r);
    byUser.set(r.user_id, arr);
  });

  const userIds = Array.from(byUser.keys());
  const badgeIds = Array.from(new Set(rows.map((r) => r.badge_id)));

  const [{ data: profiles }, { data: badges }] = await Promise.all([
    admin.from("profiles").select("id, name, telegram_id, notifications_enabled").in("id", userIds),
    admin.from("badges").select("id, code, name_uz, description_uz, icon").in("id", badgeIds),
  ]);
  const profById = new Map<string, any>((profiles || []).map((p: any) => [p.id, p]));
  const badgeById = new Map<string, any>((badges || []).map((b: any) => [b.id, b]));

  let processed = 0;
  let sent = 0;
  let skipped = 0;

  for (const [uid, items] of byUser.entries()) {
    const prof = profById.get(uid);
    const queueIds = items.map((i: any) => i.id);
    const badgeIdsForUser = items.map((i: any) => i.badge_id);

    // Always mark processed so we don't loop on broken rows
    const markSent = async () => {
      await admin.from("badge_award_queue").update({ sent_at: new Date().toISOString() }).in("id", queueIds);
    };

    if (!prof || !prof.telegram_id || prof.notifications_enabled === false) {
      await markSent();
      processed += items.length;
      skipped += items.length;
      continue;
    }

    const enriched = items
      .map((i: any) => badgeById.get(i.badge_id))
      .filter(Boolean);
    if (!enriched.length) { await markSent(); processed += items.length; continue; }

    const chatId = Number(prof.telegram_id);
    const url = await magicLink(admin, uid, `/profile?tab=badges`);
    const reply_markup = { inline_keyboard: [[{ text: "🏅 Barcha nishonlarim", url }]] };

    let text: string;
    if (enriched.length >= 3) {
      text = buildBatchMessage(prof.name || "", enriched);
    } else if (enriched.length === 2) {
      text = buildBatchMessage(prof.name || "", enriched);
    } else {
      text = buildSingleMessage(prof.name || "", enriched[0]);
    }

    try {
      const resp = await tg("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", reply_markup });
      if (!resp.ok) {
        const errTxt = await resp.text().catch(() => "");
        console.error("badge dm send fail", uid, resp.status, errTxt);
      } else {
        sent += enriched.length;
      }
    } catch (e) {
      console.error("badge dm exception", uid, e);
    }

    await markSent();
    processed += items.length;

    // Audit
    try {
      await admin.from("admin_actions").insert({
        actor_user_id: uid,
        action: "badge_dm_sent",
        target_user_id: uid,
        target_resource_type: "profile",
        target_resource_id: uid,
        details: {
          badge_ids: badgeIdsForUser,
          batched: enriched.length > 1,
          count: enriched.length,
          sent_at: new Date().toISOString(),
          queued_for_quiet_hours: items.some((i: any) => new Date(i.scheduled_for).getTime() - new Date(i.awarded_at).getTime() > 60_000),
        },
      });
    } catch { /* ignore */ }
  }

  return new Response(JSON.stringify({ ok: true, processed, sent, skipped }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
