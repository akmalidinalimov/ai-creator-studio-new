// Sends celebratory Telegram badge CARDS (images) for newly awarded badges.
// Drains badge_award_queue (populated by the queue_badge_dm trigger on
// user_badges, with quiet-hours scheduling). Triggered by pg_cron every minute
// and also callable on-demand for testing.
//
// Delivery reliability (2026-07-21): previously this marked every row sent_at
// unconditionally and swallowed send errors into console.error — failed
// deliveries were invisible to the DB watchdog layer. Now:
//  - tg() returns {ok,error} parsed from the Telegram API response;
//  - rows are CLAIMED atomically (last_attempt_at lease) before sending, so an
//    overlapping cron tick / manual call can't double-send the same badge;
//  - each delivered UNIT (image chunk / follow-up message) marks ITS rows sent
//    immediately, so a transient failure only retries the rows that didn't land —
//    a partially-delivered batch never resends the images it already sent;
//  - terminal failure (recipient blocked / content too long / retry cap) -> sent_at
//    + error kept + 'badge_dm_failed', counted undeliverable;
//  - skip (no telegram_id / notifications off) -> sent_at + error 'skip:%' so it's
//    excluded from both the sent and undeliverable counts.
// badge_dm_health_stats() + badge_dm_watchdog() read these columns.
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

// After this many failed transient attempts, a row is marked terminal so it stops
// retrying forever (kept in sync with the `attempts < 5` filter in the SQL health/watchdog).
const MAX_ATTEMPTS = 5;
// Claim lease: a fetched row is stamped last_attempt_at and won't be re-grabbed by an
// overlapping run until this window passes (> the 60s cron interval, so a normal run finishes first).
const CLAIM_LEASE_MS = 90_000;

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

// Calls a Telegram Bot API method and reports whether Telegram ACCEPTED it.
// Never throws — network errors and non-ok Telegram responses both come back as
// { ok:false, error } so the caller can decide retry vs terminal.
async function tg(method: string, body: unknown): Promise<{ ok: boolean; error: string | null }> {
  try {
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({ ok: false, description: `http_${r.status}` }));
    if (j?.ok) return { ok: true, error: null };
    return { ok: false, error: String(j?.description || `http_${r.status}`).slice(0, 300) };
  } catch (e) {
    return { ok: false, error: `network:${(e instanceof Error ? e.message : String(e)).slice(0, 200)}` };
  }
}

// Content/validation errors — the SAME content never succeeds on retry (over-long caption from an
// admin-edited "Batch matnlar" text, unparseable entities, bad media). Terminal, but distinct from
// recipient-undeliverable so an admin can tell "fix the text" from "student never started".
function isContentTgError(err: string | null): boolean {
  if (!err) return false;
  const e = err.toLowerCase();
  return /too long|can't parse|wrong file identifier|wrong type|failed to get http url|wrong remote file|image_process|webpage_curl|media_empty|caption/.test(e);
}
// Recipient-side errors that will never succeed on retry (the user must act) — also terminal.
function isRecipientTgError(err: string | null): boolean {
  if (!err) return false;
  const e = err.toLowerCase();
  return /bot was blocked|chat not found|user is deactivated|can't initiate|peer_id_invalid|user_is_blocked|have no rights|forbidden|chat_id is empty|bots can't send/.test(e);
}
// Any terminal error: don't retry, mark the row done (with the error kept for the audit/health).
function isTerminalTgError(err: string | null): boolean {
  return isRecipientTgError(err) || isContentTgError(err);
}

// Strip glyphs Cloudinary's Arial text overlay can't render (emoji, flags, symbols) — they make the
// generated badge image error out, so Telegram returns "failed to get HTTP URL content" and the card
// never reaches the student. Keep letters (Latin/Cyrillic/Uzbek), marks, digits, spaces, hyphen,
// apostrophes; drop the rest. Names that are ALL emoji collapse to "" → the "Talaba" fallback below.
function sanitizeName(n: string | null): string {
  return (n || "").replace(/[^\p{L}\p{M}\p{Nd}\s'’ʻʼ-]/gu, " ").replace(/\s+/g, " ").trim();
}
function firstName(n: string | null): string {
  return sanitizeName(n).split(/\s+/)[0] || "Talaba";
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
  // fl_attachment sets the download filename so the Telegram document arrives
  // as "AI-Creators-Yutuq.png" (not the raw public_id).
  return `https://res.cloudinary.com/${CLOUD}/image/upload/l_text:Arial_96_bold:${nm},co_rgb:F7F1E4,c_fit,w_1260/e_shadow:60,x_3,y_5/fl_layer_apply,g_north,y_1545/fl_attachment:AI-Creators-Yutuq/aicreators/${img}${IMG_REV}.png`;
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
  "📲 Bu yutug'ingizni dunyo bilan bo'lishing! Rasmni Instagram Story'ga qo'ying — siz AI'ni o'rganyapsiz, faxrlaning! 🌍\n" +
  "Bizni belgilang: @aicreators.students va @shahlo.alikhanova — sizni qayta ulashamiz! 💛";

function badgeBody(code: string, msgs: Msgs, name: string, badge: { description_uz: string | null }): string {
  const raw = msgs[code] || BADGE_VARIANTS[code] || badge.description_uz || "Yangi yutuq! 🎉";
  return raw.replace(/\{\{name\}\}/g, name);
}
function shareBlock(msgs: Msgs, name: string): string {
  return (msgs["__share__"] || DEFAULT_SHARE).replace(/\{\{name\}\}/g, name);
}

// Delivers all of a user's due badges, marking each SUCCESSFULLY-delivered unit's queue rows sent
// the moment Telegram accepts it (via markSent). Returns the ids actually delivered + the first
// error. Because delivered rows are marked as we go, a later transient failure leaves ONLY the
// undelivered rows for the caller to retry — the images already sent are never resent.
//   • single image-only badge  -> one self-contained document (caption + share + button)
//   • image badges             -> media groups chunked to Telegram's 10-item cap
//   • follow-up / text message  -> share block + inline button (an album can't carry one) + any
//                                  image-less badges' only content
async function deliverBadges(
  admin: any, chatId: number, uid: string, name: string | null, items: any[], badgeById: Map<string, any>,
  msgs: Msgs, markSent: (ids: string[]) => Promise<void>,
): Promise<{ error: string | null; delivered: string[] }> {
  const nm = firstName(name);
  // Map each unique badge -> its queue row id(s); keep insertion order for stable batching.
  const idsByBadge = new Map<string, string[]>();
  const ordered: any[] = [];
  for (const it of items) {
    const b = badgeById.get(it.badge_id);
    if (!b) continue; // unknown badge ids are handled (skip) by the caller
    if (!idsByBadge.has(b.id)) { idsByBadge.set(b.id, []); ordered.push(b); }
    idsByBadge.get(b.id)!.push(it.id);
  }
  const idsFor = (badges: any[]) => badges.flatMap((b) => idsByBadge.get(b.id) || []);
  const withImg = ordered.filter((b) => badgeImageUrl(b.code, name));
  const noImg = ordered.filter((b) => !badgeImageUrl(b.code, name));
  const delivered: string[] = [];

  const url = await magicLink(admin, uid, `/profile?tab=badges`);
  const button = { inline_keyboard: [[{ text: "🏅 Barcha nishonlarim", url }]] };

  // Single image-only badge: one document carrying caption + share + button.
  if (withImg.length === 1 && noImg.length === 0) {
    const b = withImg[0];
    const res = await tg("sendDocument", {
      chat_id: chatId, document: badgeImageUrl(b.code, name),
      caption: `${badgeBody(b.code, msgs, nm, b)}\n\n${shareBlock(msgs, nm)}`, reply_markup: button,
    });
    if (!res.ok) return { error: res.error, delivered };
    const ids = idsFor([b]); await markSent(ids); delivered.push(...ids);
    return { error: null, delivered };
  }

  // Image badges in chunks of 10; mark each chunk sent as soon as it lands.
  for (let i = 0; i < withImg.length; i += 10) {
    const chunk = withImg.slice(i, i + 10);
    const media = chunk.map((b) => ({ type: "document", media: badgeImageUrl(b.code, name), caption: badgeBody(b.code, msgs, nm, b) }));
    const res = media.length === 1
      ? await tg("sendDocument", { chat_id: chatId, document: media[0].media, caption: media[0].caption })
      : await tg("sendMediaGroup", { chat_id: chatId, media });
    if (!res.ok) return { error: res.error, delivered };
    const ids = idsFor(chunk); await markSent(ids); delivered.push(...ids);
  }

  // Follow-up / text-only message: carries the share block, the inline button, and any image-less
  // badges' only content. Required when there are noImg badges, an image album, or no images at all.
  const textOnly = withImg.length === 0;
  if (textOnly || noImg.length > 0 || withImg.length > 1) {
    const text = textOnly
      ? `${ordered.map((b) => `🏅 ${badgeBody(b.code, msgs, nm, b)}`).join("\n\n")}\n\n${shareBlock(msgs, nm)}`
      : `${shareBlock(msgs, nm)}${noImg.length ? `\n\n${noImg.map((b) => `🏅 ${badgeBody(b.code, msgs, nm, b)}`).join("\n\n")}` : ""}`;
    const res = await tg("sendMessage", { chat_id: chatId, text, reply_markup: button });
    if (!res.ok) return { error: res.error, delivered };
    // The follow-up carries the noImg badges' content (their only delivery). For a pure image album
    // (no noImg) the images were already marked; the follow-up is just share+button.
    const ids = textOnly ? idsFor(ordered) : idsFor(noImg);
    if (ids.length) { await markSent(ids); delivered.push(...ids); }
  }
  return { error: null, delivered };
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

  const nowIso = new Date().toISOString();
  const claimCutoff = new Date(Date.now() - CLAIM_LEASE_MS).toISOString();
  const leaseFilter = `last_attempt_at.is.null,last_attempt_at.lt.${claimCutoff}`;

  // Candidates due now, under the retry cap, not currently leased by another run.
  const { data: candidates, error: selErr } = await admin
    .from("badge_award_queue")
    .select("id")
    .is("sent_at", null)
    .lt("attempts", MAX_ATTEMPTS)
    .lte("scheduled_for", nowIso)
    .or(leaseFilter)
    .order("scheduled_for", { ascending: true })
    .limit(200);
  if (selErr) {
    return new Response(JSON.stringify({ ok: false, error: selErr.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
  const candidateIds = (candidates || []).map((r: any) => r.id);
  if (!candidateIds.length) {
    return new Response(JSON.stringify({ ok: true, processed: 0 }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  // Atomic claim: stamp last_attempt_at and take only the rows still free. An overlapping run's
  // claim won't match rows we just leased, so the same badge can't be sent twice.
  const { data: claimed, error: claimErr } = await admin
    .from("badge_award_queue")
    .update({ last_attempt_at: nowIso })
    .in("id", candidateIds)
    .is("sent_at", null)
    .or(leaseFilter)
    .select("id, user_id, badge_id, awarded_at, scheduled_for, attempts");
  if (claimErr) {
    return new Response(JSON.stringify({ ok: false, error: claimErr.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
  const rows = (claimed || []) as any[];
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

  let processed = 0, sent = 0, skipped = 0, retrying = 0, undeliverable = 0;
  const stamp = () => new Date().toISOString();
  const markIds = async (ids: string[], patch: Record<string, unknown>, tag: string, uid: string) => {
    if (!ids.length) return;
    const { error: uerr } = await admin.from("badge_award_queue").update(patch).in("id", ids);
    if (uerr) console.error(`badge ${tag} failed`, uid, uerr.message);
  };

  for (const [uid, items] of byUser.entries()) {
    const prof = profById.get(uid);
    const queueIds = items.map((i: any) => i.id);
    const badgeIdsForUser = items.map((i: any) => i.badge_id);
    // Shared retry budget across a user's simultaneously-due badges: if the chat is unreachable they
    // ALL fail for the same reason, so advancing them together is correct (documented tradeoff).
    const attemptsSoFar = Math.max(0, ...items.map((i: any) => Number(i.attempts) || 0));

    const markSent = (ids: string[]) => markIds(ids, { sent_at: stamp(), error: null, last_attempt_at: stamp() }, "markSent", uid);
    const markTerm = (ids: string[], err: string | null) => markIds(ids, { sent_at: stamp(), error: err, last_attempt_at: stamp() }, "markTerm", uid);
    const markRetry = (ids: string[], err: string) => markIds(ids, { error: err, attempts: attemptsSoFar + 1, last_attempt_at: stamp() }, "markRetry", uid);

    // Skips are not failures — stamped 'skip:%' so they're excluded from sent/undeliverable counts.
    if (!prof || !prof.telegram_id) { await markTerm(queueIds, "skip:no_telegram"); processed += items.length; skipped += items.length; continue; }
    if (prof.notifications_enabled === false) { await markTerm(queueIds, "skip:notifications_off"); processed += items.length; skipped += items.length; continue; }
    // Any queue rows whose badge no longer exists can never be sent — clear them (not a failure).
    const knownIds = items.filter((i: any) => badgeById.has(i.badge_id)).map((i: any) => i.id);
    const unknownIds = queueIds.filter((id: string) => !knownIds.includes(id));
    if (unknownIds.length) { await markTerm(unknownIds, "skip:unknown_badge"); skipped += unknownIds.length; }
    if (!knownIds.length) { processed += items.length; continue; }

    const { error: outErr, delivered } = await deliverBadges(
      admin, Number(prof.telegram_id), uid, prof.name, items, badgeById, msgs, markSent,
    );
    processed += items.length;
    sent += delivered.length;

    const deliveredSet = new Set(delivered);
    const pendingIds = knownIds.filter((id: string) => !deliveredSet.has(id));
    if (!pendingIds.length) {
      // Every badge row landed. A non-null outErr here can only mean a pure-image-album's follow-up
      // (share prompt + CTA button) failed — the badges themselves reached the student, so there's
      // nothing to retry, but we still record it (health-signal rule) so a pattern is visible.
      if (outErr) console.error("badge followup failed (non-blocking)", uid, outErr);
      try {
        await admin.from("admin_actions").insert({
          actor_user_id: uid, action: "badge_dm_sent", target_user_id: uid,
          target_resource_type: "profile", target_resource_id: uid,
          details: {
            badge_ids: badgeIdsForUser, batched: delivered.length > 1, count: delivered.length,
            as_image: items.some((i: any) => { const b = badgeById.get(i.badge_id); return b && badgeImageUrl(b.code, prof.name); }),
            sent_at: stamp(),
            queued_for_quiet_hours: items.some((i: any) => new Date(i.scheduled_for).getTime() - new Date(i.awarded_at).getTime() > 60_000),
            ...(outErr ? { followup_failed: outErr } : {}),
          },
        });
      } catch { /* ignore */ }
    } else if (isTerminalTgError(outErr) || attemptsSoFar + 1 >= MAX_ATTEMPTS) {
      // Give up on the undelivered rows: mark terminal WITH the error (counted undeliverable).
      await markTerm(pendingIds, outErr);
      undeliverable += pendingIds.length;
      try {
        await admin.from("admin_actions").insert({
          actor_user_id: uid, action: "badge_dm_failed", target_user_id: uid,
          target_resource_type: "profile", target_resource_id: uid,
          details: {
            badge_ids: badgeIdsForUser, error: outErr,
            recipient_error: isRecipientTgError(outErr), content_error: isContentTgError(outErr),
            attempts: attemptsSoFar + 1, undelivered: pendingIds.length,
          },
        });
      } catch { /* ignore */ }
    } else {
      // Transient — keep the undelivered rows queued; the every-minute drainer will retry just those.
      await markRetry(pendingIds, outErr!);
      retrying += pendingIds.length;
    }
  }

  return new Response(JSON.stringify({ ok: true, processed, sent, skipped, retrying, undeliverable }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
