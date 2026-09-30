// broadcast-drainer: sends pending broadcast_deliveries as Telegram DMs. Cron-invoked every minute
// (x-internal-secret gated). Same hardened model as notify-badge-award: atomic claim (last_attempt_at
// lease) so overlapping ticks can't double-send; check the Telegram `ok` field; terminal failures
// (blocked / never-started / bad content) are recorded, transient ones retried (cap 5). Never marks a
// failed send as sent. Recomputes broadcasts.sent/failed from the deliveries and flips status→done.
//
// 2026-09-30: a button whose url is OUR site opens inside the student Mini App (web_app, signed in) instead of
// Telegram's built-in browser, when platform_settings.student_miniapp is on. Other urls are untouched; a
// rejected web_app button is resent once with the original url.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { isTerminal } from "../_shared/telegram-classify.ts";
import { sendTelegram, type SendOutcome } from "../_shared/telegram-send.ts";
import { verifyInternalSecret } from "../_shared/internal-secret.ts";
import {
  DEFAULT_MINIAPP_BASE,
  loadStudentMiniAppFlag,
  MINIAPP_BASE,
  sendWithWatchFallback,
  watchButton,
} from "../_shared/miniapp-button.ts";
import { siteButtonPath } from "./site-link.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-internal-secret",
};

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") || "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const MAX_ATTEMPTS = 5;
// Our site, in every spelling a broadcast author might paste.
const SITE_ORIGINS = [MINIAPP_BASE, DEFAULT_MINIAPP_BASE, "https://aicreator.academy", Deno.env.get("SITE_URL") || ""].filter(Boolean);
const CLAIM_LEASE_MS = 90_000;
const BATCH = 100;

// Internal-secret check via the Vault RPC (single source of truth) — the shared rotation-safe verifier
// (_shared/internal-secret.ts: cached, re-fetched once on mismatch, debounced, fail-closed).
const __admin = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

type Locale = "uz" | "ru" | "en";
function normLocale(l: string | null): Locale {
  return l === "ru" || l === "en" ? l : "uz";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (!(await verifyInternalSecret(req, __admin))) {
    return new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
  if (!BOT_TOKEN) {
    return new Response(JSON.stringify({ ok: false, error: "bot not configured" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  const admin = __admin;
  const nowIso = new Date().toISOString();
  const claimCutoff = new Date(Date.now() - CLAIM_LEASE_MS).toISOString();
  const leaseFilter = `last_attempt_at.is.null,last_attempt_at.lt.${claimCutoff}`;

  // Candidates due now, under the retry cap, not currently leased.
  const { data: cand, error: selErr } = await admin
    .from("broadcast_deliveries")
    .select("id")
    .eq("status", "pending")
    .lt("attempts", MAX_ATTEMPTS)
    .lte("scheduled_for", nowIso)
    .or(leaseFilter)
    .order("scheduled_for", { ascending: true })
    .limit(BATCH);
  if (selErr) return new Response(JSON.stringify({ ok: false, error: selErr.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  const candIds = (cand || []).map((r: any) => r.id);
  if (!candIds.length) return new Response(JSON.stringify({ ok: true, processed: 0 }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  // Atomic claim — only rows still free come back.
  const { data: claimed } = await admin
    .from("broadcast_deliveries")
    .update({ last_attempt_at: nowIso })
    .in("id", candIds)
    .eq("status", "pending")
    .or(leaseFilter)
    .select("id, broadcast_id, user_id, telegram_id, attempts");
  const rows = (claimed || []) as any[];
  if (!rows.length) return new Response(JSON.stringify({ ok: true, processed: 0 }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  // Load the broadcasts + recipient locales for this batch.
  const bIds = Array.from(new Set(rows.map((r) => r.broadcast_id)));
  const uIds = Array.from(new Set(rows.map((r) => r.user_id)));
  const [{ data: bcasts }, { data: profs }] = await Promise.all([
    admin.from("broadcasts").select("id, image_path, body_uz, body_ru, body_en, button_label, button_url, mode").in("id", bIds),
    admin.from("profiles").select("id, preferred_locale").in("id", uIds),
  ]);
  const bById = new Map<string, any>((bcasts || []).map((b: any) => [b.id, b]));
  const localeById = new Map<string, Locale>((profs || []).map((p: any) => [p.id, normLocale(p.preferred_locale)]));

  const stamp = () => new Date().toISOString();
  let processed = 0, sent = 0, failed = 0, retrying = 0, deferred = 0;
  const flag = await loadStudentMiniAppFlag(admin);

  // Quiet hours (22:00–08:00 Tashkent, UTC+5): mode='all' rows that come due at night — e.g. a
  // transient retry landing just after 22:00 — are re-deferred to the next 08:00 rather than sent,
  // so students are never DM'd overnight. Test sends always go (the admin asked for them now).
  const tHour = (new Date().getUTCHours() + 5) % 24;
  const quiet = tHour >= 22 || tHour < 8;
  let nextMorningIso = "";
  if (quiet) {
    const t = new Date(); t.setUTCMinutes(0, 0, 0); t.setUTCHours(3); // 08:00 Tashkent
    if (t <= new Date()) t.setUTCDate(t.getUTCDate() + 1);
    nextMorningIso = t.toISOString();
  }

  for (const d of rows) {
    processed++;
    const b = bById.get(d.broadcast_id);
    if (!b) { await admin.from("broadcast_deliveries").update({ status: "failed", error: "broadcast_gone" }).eq("id", d.id); failed++; continue; }
    if (quiet && b.mode === "all") {
      await admin.from("broadcast_deliveries").update({ scheduled_for: nextMorningIso }).eq("id", d.id);
      deferred++; continue;
    }

    const loc = localeById.get(d.user_id) || "uz";
    const body: string = (loc === "ru" ? b.body_ru : loc === "en" ? b.body_en : null) || b.body_uz;
    const plain = b.button_label && b.button_url
      ? { inline_keyboard: [[{ text: b.button_label, url: b.button_url }]] }
      : undefined;
    // A site link → the Mini App (private DM, flag on); flag off / other urls → the plain url button above.
    const sitePath = plain ? siteButtonPath(b.button_url, SITE_ORIGINS) : null;
    const w = sitePath
      ? await watchButton({
        chat: "private", text: b.button_label, flag, fn: "broadcast-drainer", admin,
        miniPath: sitePath, legacyPath: sitePath, track: { src: "broadcast", ref: b.id },
        magicLink: () => Promise.resolve(b.button_url as string), // the "legacy" link is the author's own url
      })
      : null;
    const button = w?.button ? { inline_keyboard: [[w.button]] } : plain;
    const chatId = Number(d.telegram_id);

    // Drainer adoption: send via the shared primitive but CLASSIFY ONLY (record:false) — this loop
    // writes its own per-row broadcast_deliveries status below, so recording here would double-log.
    const payload: Record<string, unknown> = b.image_path
      ? { chat_id: chatId, photo: `${SUPABASE_URL}/storage/v1/object/public/broadcast-images/${b.image_path}`, caption: body, parse_mode: "HTML", reply_markup: button }
      : { chat_id: chatId, text: body, parse_mode: "HTML", disable_web_page_preview: true, reply_markup: button };
    const method = b.image_path ? "sendPhoto" : "sendMessage";
    const { result: res }: { result: SendOutcome } = await sendWithWatchFallback(
      (p) => sendTelegram(BOT_TOKEN, method, p, { record: false }),
      payload,
      () => Promise.resolve({ ...payload, reply_markup: plain }),
      { fn: "broadcast-drainer", admin },
    );

    if (res.ok) {
      await admin.from("broadcast_deliveries").update({ status: "sent", sent_at: stamp(), error: null }).eq("id", d.id);
      sent++;
    } else if (isTerminal(res.error) || d.attempts + 1 >= MAX_ATTEMPTS) {
      await admin.from("broadcast_deliveries").update({ status: "failed", error: res.error, last_attempt_at: stamp() }).eq("id", d.id);
      failed++;
    } else {
      await admin.from("broadcast_deliveries").update({ error: res.error, attempts: d.attempts + 1, last_attempt_at: stamp() }).eq("id", d.id);
      retrying++;
    }
    await new Promise((r) => setTimeout(r, 40)); // ~25 msg/sec, under Telegram's cap
  }

  // Recompute counts per affected broadcast from the source-of-truth deliveries; flip → done.
  for (const bid of bIds) {
    const { data: agg } = await admin.from("broadcast_deliveries").select("status").eq("broadcast_id", bid);
    const rowsB = (agg || []) as any[];
    const nSent = rowsB.filter((x) => x.status === "sent").length;
    const nFail = rowsB.filter((x) => x.status === "failed").length;
    const nPend = rowsB.filter((x) => x.status === "pending").length;
    await admin.from("broadcasts").update({
      sent: nSent, failed: nFail,
      ...(nPend === 0 ? { status: "done", finished_at: stamp() } : { status: "sending" }),
    }).eq("id", bid);
  }

  return new Response(JSON.stringify({ ok: true, processed, sent, failed, retrying, deferred }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
});
