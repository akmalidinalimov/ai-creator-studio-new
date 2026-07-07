// Sends celebratory Telegram badge CARDS (images) for newly awarded badges.
// Drains badge_award_queue (populated by the queue_badge_dm trigger on
// user_badges, with quiet-hours scheduling). Triggered by pg_cron every minute
// and also callable on-demand for testing.
//
// The badge card is rendered by Cloudinary: a pre-baked 1080x1920 background
// (aicreators/badge_<img>) with the student's FIRST name overlaid as the only
// variable. No server-side image rendering — Cloudinary composites on delivery.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") || "";
const SITE_URL = (Deno.env.get("SITE_URL") || "https://aicreator.academy").replace(/\/$/, "");
const CLOUD = Deno.env.get("CLOUDINARY_CLOUD") || "lnx5igsj";

// badge.code -> Cloudinary background public_id (under folder "aicreators/").
const CODE_TO_IMG: Record<string, string> = {
  first_lesson: "badge_first_lesson",
  first_homework: "badge_first_homework",
  five_lessons: "badge_five_lessons",
  ten_lessons: "badge_ten_lessons",
  module_complete: "badge_module",
  streak_3: "badge_streak_3",
  streak_7: "badge_streak_7",
  streak_14: "badge_streak_14",
  streak_30: "badge_streak_30",
  streak_60: "badge_streak_60",
  streak_100: "badge_streak_100",
  course_complete: "badge_course_complete",
};

function tg(method: string, body: unknown) {
  return fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function firstName(n: string | null): string {
  return (n || "").trim().split(/\s+/)[0] || "Talaba";
}

// Cloudinary name overlay on the 3x base (1620x2880). Only the first name
// varies; y_1545 aligns with the empty name slot; c_fit,w_1260 keeps long names
// in the IG-safe zone; e_shadow adds a soft drop-shadow so the name stays sharp
// after Telegram's JPEG recompression. "_g4" = current baked-background revision.
const IMG_REV = "_g4";
function badgeImageUrl(code: string, name: string | null): string | null {
  const img = CODE_TO_IMG[code];
  if (!img) return null;
  const raw = firstName(name).slice(0, 24);
  const nm = encodeURIComponent(raw).replace(/'/g, "%27").replace(/\./g, "%2E");
  return `https://res.cloudinary.com/${CLOUD}/image/upload/l_text:Arial_96_bold:${nm},co_rgb:F7F1E4,c_fit,w_1260/e_shadow:60,x_3,y_5/fl_layer_apply,g_north,y_1545/aicreators/${img}${IMG_REV}.png`;
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

// Badge-specific celebratory tail by code.
const BADGE_VARIANTS: Record<string, string> = {
  first_lesson: "Birinchi darsingizni tugatdingiz! Sayohat boshlandi 🚀",
  first_homework: "Birinchi uy vazifangizni topshirdingiz! A'lo ish 📝",
  five_lessons: "5 ta darsni tugatdingiz! Sur'atingiz a'lo.",
  ten_lessons: "10 ta darsni tugatdingiz! Siz haqiqiy o'rganuvchisiz ⭐",
  module_complete: "Modulni to'liq tugatdingiz! Endi keyingisi sari!",
  streak_3: "3 kun ketma-ket! Odat shakllanmoqda 🔥",
  streak_7: "7 kun ketma-ket o'qidingiz! Disipplina — muvaffaqiyat kaliti 🔥",
  streak_14: "14 kun ketma-ket! Bu endi odat emas — bu SIZ 🔥",
  streak_30: "30 kun ketma-ket! Siz 1% ichidasiz 🔥",
  streak_60: "60 kun ketma-ket! Kamdan-kam uchraydigan sabr 🔥",
  streak_100: "100 kun ketma-ket! Bu — afsona 👑",
  course_complete: "Butun kursni tugatdingiz! Bu — katta yutuq 🏆",
};

// Editable captions live in public.badge_messages ("Batch texts" admin page).
// These are only fallbacks if a row is missing. {{name}} → student first name.
type Msgs = Record<string, string>;
const DEFAULT_SHARE =
  "📲 Buni dunyoga ko'rsating! Rasmni Instagram Story'ga qo'ying — siz AI'ni o'rganyapsiz, faxrlaning! 🌍\n" +
  "Bizni belgilang: @aicreators.students va @shahlo.alikhanova — sizni qayta ulashamiz! 💛";

function badgeBody(code: string, msgs: Msgs, name: string, badge: { description_uz: string | null }): string {
  const raw = msgs[code] || BADGE_VARIANTS[code] || badge.description_uz || "Yangi yutuq! 🎉";
  return raw.replace(/\{\{name\}\}/g, name);
}
function shareBlock(msgs: Msgs, name: string): string {
  return (msgs["__share__"] || DEFAULT_SHARE).replace(/\{\{name\}\}/g, name);
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

  const [{ data: profiles }, { data: badges }, { data: msgRows }] = await Promise.all([
    admin.from("profiles").select("id, name, telegram_id, notifications_enabled").in("id", userIds),
    admin.from("badges").select("id, code, name_uz, description_uz, icon").in("id", badgeIds),
    admin.from("badge_messages").select("code, body_uz"),
  ]);
  const profById = new Map<string, any>((profiles || []).map((p: any) => [p.id, p]));
  const badgeById = new Map<string, any>((badges || []).map((b: any) => [b.id, b]));
  const msgs: Msgs = {};
  (msgRows || []).forEach((m: any) => { if (m?.code) msgs[m.code] = m.body_uz || ""; });

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

    // Dedupe badges within this user's batch (same badge can't repeat, but be safe)
    const seen = new Set<string>();
    const enriched = items
      .map((i: any) => badgeById.get(i.badge_id))
      .filter((b: any) => b && !seen.has(b.id) && seen.add(b.id));
    if (!enriched.length) { await markSent(); processed += items.length; continue; }

    const chatId = Number(prof.telegram_id);
    const nm = firstName(prof.name);
    const url = await magicLink(admin, uid, `/profile?tab=badges`);
    const button = { inline_keyboard: [[{ text: "🏅 Barcha nishonlarim", url }]] };

    // Split into image-backed badges and text-only fallbacks.
    const withImg = enriched.filter((b: any) => badgeImageUrl(b.code, prof.name));
    const noImg = enriched.filter((b: any) => !badgeImageUrl(b.code, prof.name));

    try {
      if (withImg.length === 1 && noImg.length === 0) {
        // Single card: sent as a DOCUMENT so Telegram doesn't recompress it —
        // the student gets the full-quality PNG to save + post to their Story.
        const b = withImg[0];
        await tg("sendDocument", {
          chat_id: chatId,
          document: badgeImageUrl(b.code, prof.name),
          caption: `${badgeBody(b.code, msgs, nm, b)}\n\n${shareBlock(msgs, nm)}`,
          reply_markup: button,
        });
      } else if (withImg.length >= 1) {
        // Album of full-quality badge documents (media groups: 2..10, no buttons);
        // each card gets its own praise; the shared block + button follow once.
        const media = withImg.slice(0, 10).map((b: any) => ({
          type: "document",
          media: badgeImageUrl(b.code, prof.name),
          caption: badgeBody(b.code, msgs, nm, b),
        }));
        if (media.length === 1) {
          await tg("sendDocument", { chat_id: chatId, document: media[0].media, caption: media[0].caption });
        } else {
          await tg("sendMediaGroup", { chat_id: chatId, media });
        }
        const extra = noImg.length ? `\n\n${noImg.map((b: any) => `🏅 ${badgeBody(b.code, msgs, nm, b)}`).join("\n\n")}` : "";
        await tg("sendMessage", {
          chat_id: chatId,
          text: `${shareBlock(msgs, nm)}${extra}`,
          reply_markup: button,
        });
      } else {
        // No images at all — plain text (legacy path): praise per badge + share.
        const bodies = enriched.map((b: any) => `🏅 ${badgeBody(b.code, msgs, nm, b)}`).join("\n\n");
        await tg("sendMessage", { chat_id: chatId, text: `${bodies}\n\n${shareBlock(msgs, nm)}`, reply_markup: button });
      }
      sent += enriched.length;
    } catch (e) {
      console.error("badge card send exception", uid, e);
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
          as_image: withImg.length > 0,
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
