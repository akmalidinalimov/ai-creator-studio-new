// Sends re-engagement Telegram messages for a campaign.
// Modes: { mode: "test" } -> sends only to @alikhanova_admin (always allowed).
//        { mode: "all", confirm: "YUBORISH" } -> sends to all eligible students (requires campaign.enabled=true).
//
// 2026-09-30: with the student Mini App on, the campaign button opens the Mini App (web_app → /dashboard)
// instead of a 7-day magic link in Telegram's browser. The delivery id is generated before the send and rides
// in the button as ?ref=<id>; the Mini App's open signal stamps re_engagement_deliveries.clicked_at on it
// (magic_token is null on that path). Flag off → the magic link, unchanged.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { sendTelegram } from "../_shared/telegram-send.ts";
import { legacyWatchButton, loadStudentMiniAppFlag, type PrivateWatchOpts, sendWithWatchFallback, watchButton } from "../_shared/miniapp-button.ts";
import { loadStaffOnlyIds, skipStaffOnly } from "../_shared/student-audience.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") || "";
const SITE_URL = (Deno.env.get("SITE_URL") || "https://aicreator.academy").replace(/\/$/, "");

function pickTpl(c: any, locale: string) {
  const loc = (locale || "uz").toLowerCase();
  if (loc.startsWith("ru")) return { body: c.template_ru, btn: c.button_text_ru };
  if (loc.startsWith("en")) return { body: c.template_en, btn: c.button_text_en };
  return { body: c.template_uz, btn: c.button_text_uz };
}

function render(tpl: string, p: any) {
  const name = (p.name || "").trim() || "do'stim";
  return (tpl || "").replaceAll("{{name}}", name);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    if (!BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN not configured");
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    // Verify admin caller
    const authHeader = req.headers.get("Authorization") || "";
    const jwt = authHeader.replace(/^Bearer\s+/i, "");
    if (!jwt) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: `Bearer ${jwt}` } } });
    const { data: userData } = await userClient.auth.getUser();
    const callerId = userData?.user?.id;
    if (!callerId) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    const { data: roleRow } = await admin.from("user_roles").select("role").eq("user_id", callerId).eq("role", "admin").maybeSingle();
    if (!roleRow) return new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    const body = await req.json().catch(() => ({}));
    const { campaign_id, mode, confirm, attempt_num = 1 } = body || {};
    if (!campaign_id) return new Response(JSON.stringify({ error: "missing campaign_id" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    if (!["test", "all"].includes(mode)) return new Response(JSON.stringify({ error: "invalid mode" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    const { data: campaign, error: cErr } = await admin.from("re_engagement_campaigns").select("*").eq("id", campaign_id).single();
    if (cErr || !campaign) return new Response(JSON.stringify({ error: "campaign not found" }), { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    // Build recipients
    let recipients: any[] = [];
    if (mode === "test") {
      const { data: setting } = await admin.rpc("get_setting", { _key: "bot.test_recipient_username" });
      const testUsername = (typeof setting === "string" ? setting : (setting as any)) || "alikhanova_admin";
      const { data: me } = await admin
        .from("profiles")
        .select("id, name, last_name, telegram_id, telegram_username, preferred_locale")
        .eq("telegram_username", testUsername)
        .maybeSingle();
      if (!me?.telegram_id) {
        return new Response(JSON.stringify({ error: `test recipient @${testUsername} not found or has no telegram_id` }), { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      recipients = [me];
    } else {
      if (confirm !== "YUBORISH") {
        return new Response(JSON.stringify({ error: "confirmation required" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      // Enable campaign on first real send
      if (!campaign.enabled) {
        await admin.from("re_engagement_campaigns").update({ enabled: true }).eq("id", campaign_id);
        campaign.enabled = true;
      }
      const { data: list, error: lErr } = await admin.rpc("re_engagement_eligible_profiles");
      if (lErr) throw lErr;
      // A student campaign (_shared/student-audience.ts). The RPC already drops admin/teacher roles; the shared
      // rule also drops a superadmin-only account, so every student sender answers "who is a student" alike.
      const staffOnly = await loadStaffOnlyIds(admin, "re-engagement-send");
      recipients = (list || []).filter((r: any) => !skipStaffOnly(staffOnly, r.id));

      // Skip those already sent for this campaign+attempt
      const ids = recipients.map((r: any) => r.id);
      if (ids.length) {
        const { data: existing } = await admin
          .from("re_engagement_deliveries")
          .select("profile_id")
          .eq("campaign_id", campaign_id)
          .eq("attempt_num", attempt_num)
          .in("profile_id", ids);
        const skip = new Set((existing || []).map((e: any) => e.profile_id));
        recipients = recipients.filter((r: any) => !skip.has(r.id));
      }
    }

    let sent = 0, failed = 0;
    const errors: any[] = [];
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const flag = await loadStudentMiniAppFlag(admin);
    const buttons = { web_app: 0, magic_link: 0 };

    for (const r of recipients) {
      // 25/sec rate limit
      if (sent + failed > 0 && (sent + failed) % 25 === 0) await sleep(1000);

      try {
        if (!r.telegram_id) throw new Error(`profile ${r.id} has no telegram_id`);
        // The delivery row's id, known BEFORE the send: it is the Mini App button's ref.
        const deliveryId = crypto.randomUUID();
        const { body: tplBody, btn } = pickTpl(campaign, r.preferred_locale);
        const text = render(tplBody, r);
        // Today's link (the fallback): a magic-link token in telegram_magic_links — a failed insert still
        // fails this recipient, exactly as before.
        const magicLink = async (targetPath: string) => {
          const token = crypto.randomUUID();
          const { error: tErr } = await admin.from("telegram_magic_links").insert({
            token,
            user_id: r.id,
            purpose: "reengagement",
            target_path: targetPath,
            expires_at: expiresAt,
          });
          if (tErr) throw new Error(`magic_link insert failed: ${tErr.message || JSON.stringify(tErr)}`);
          return { url: `${SITE_URL}/auth/magic?t=${token}`, token };
        };
        const opts: PrivateWatchOpts = {
          chat: "private", text: btn, flag, fn: "re-engagement-send", admin,
          miniPath: "/dashboard", legacyPath: "/dashboard", track: { src: "reengagement", ref: deliveryId }, magicLink,
        };
        const w = await watchButton(opts);
        if (!w.button) throw new Error("magic_link insert failed: no button");
        let token: string | null = w.token ?? null;
        if (w.mode === "web_app") buttons.web_app++; else buttons.magic_link++;
        const payload = (button: Record<string, unknown>) => ({
          chat_id: Number(r.telegram_id),
          text,
          disable_web_page_preview: true,
          reply_markup: { inline_keyboard: [[button]] },
        });
        // Drainer adoption: send via the shared primitive but CLASSIFY ONLY (record:false) — this loop
        // writes its own per-row re_engagement_deliveries status below, so recording here would double-log.
        // Payload is unchanged (no parse_mode; the watch button — Mini App or the magic link — preserved). Note:
        // SendOutcome does not surface the response body, so the (write-only, never-read) telegram_message_id is
        // not captured — the sent/failed status + the Telegram error description are still recorded.
        const { result: send } = await sendWithWatchFallback(
          (p) => sendTelegram(BOT_TOKEN, "sendMessage", p, { record: false }),
          payload(w.button),
          async () => {
            const lg = await legacyWatchButton(opts, "ok");
            if (!lg.button) return null;
            token = lg.token ?? null;
            return payload(lg.button);
          },
          { fn: "re-engagement-send", admin },
        );

        await admin.from("re_engagement_deliveries").insert({
          id: deliveryId,
          campaign_id,
          profile_id: r.id,
          attempt_num: mode === "test" ? 0 : attempt_num,
          magic_token: token,
          telegram_message_id: null,
          status: send.ok ? "sent" : "failed",
          error: send.ok ? null : (send.error || "").slice(0, 500),
        });

        if (send.ok) sent++;
        else {
          failed++;
          const detail = `tg ${send.status}: ${send.error || ""}`.slice(0, 500);
          console.error("re_engagement_send tg failure", { profile_id: r.id, detail });
          errors.push({ profile_id: r.id, err: detail });
        }
      } catch (e) {
        failed++;
        const detail = e instanceof Error
          ? e.message + (e.stack ? "\n" + e.stack : "")
          : (typeof e === "object" ? JSON.stringify(e) : String(e));
        console.error("re_engagement_send caught", { profile_id: r.id, detail });
        errors.push({ profile_id: r.id, err: detail.slice(0, 500) });
      }
    }

    return new Response(
      JSON.stringify({ ok: true, mode, campaign_id, attempted: recipients.length, sent, failed, buttons, errors: errors.slice(0, 10) }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
