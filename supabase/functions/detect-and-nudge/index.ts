// Smart nudges: detects 3 patterns, respects opt-in, paused_until, quiet hours, weekly rate limit.
// Modes: { mode: "test", nudge_type: "inactive_3d"|"inactive_7d"|"stuck_lesson"|"module_complete" }
//          → sends one nudge to @alikhanova_admin (always allowed, bypasses filters).
//        { mode: "cron" } → invoked by pg_cron; runs inactive_3d, inactive_7d and module_complete.
//
// 2026-09-30: the nudge button opens the MINI APP (web_app → /continue, the next unfinished lesson) instead
// of a 24-hour magic link in Telegram's browser; the click is reported by the Mini App against the nudge_log
// id (see nudge.ts). Flag platform_settings.student_miniapp off → today's magic link, unchanged.
// stuck_lesson is RETIRED from the cron run: nudge_candidates_stuck() can never return a row
// (lesson_progress is unique per user+lesson, so "the same lesson on >= 2 distinct days" is always 1 day),
// it has never sent one (nudge_log: 0 rows ever), and its link (/lesson/<lesson id>) was a broken route.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { verifyInternalSecret } from "../_shared/internal-secret.ts";
import { redactSecrets } from "../_shared/redact.ts";
import { loadStudentMiniAppFlag, type WatchFlag } from "../_shared/miniapp-button.ts";
import { type NudgeType, sendNudgeWith } from "./nudge.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") || "";
const SITE_URL = (Deno.env.get("SITE_URL") || "https://aicreator.academy").replace(/\/$/, "");

// tgSend takes the PREBUILT message (nudge.ts builds the watch button: Mini App web_app, or the magic link).
async function tgSend(payload: Record<string, unknown>) {
  // Kept raw on purpose: this drainer stores the raw Telegram result (nudge_log.telegram_message_id)
  // + echoes the body in test mode, which sendTelegram's SendOutcome intentionally does not expose.
  // Non-delivery is already DB-visible via nudge_log.error, so there is no silent-failure gap; adopting
  // the primitive would drop behavior for zero classification gain.
  let r: Response;
  try {
    // eslint-disable-next-line no-restricted-syntax
    r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    // TOKEN CONTAINMENT (same class as the webhook's tgApi): a Deno transport error embeds the full
    // token-bearing URL, and this function's failures surface BOTH in nudge_log.error and in the
    // handler's 500 body -- which the hourly cron and the admin Nudges page both receive.
    throw new Error(`telegram_transport_error (sendMessage): ${redactSecrets(e)}`);
  }
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok && data?.ok, status: r.status, data };
}

function pickTpl(templates: any, type: NudgeType, locale: string) {
  const loc = (locale || "uz").toLowerCase().slice(0, 2);
  const block = templates?.[type] || {};
  return block[loc] || block.uz || { body: "", button: "Open" };
}

function render(tpl: string, vars: Record<string, string>) {
  let out = tpl || "";
  for (const [k, v] of Object.entries(vars)) {
    out = out.replaceAll(`{{${k}}}`, v ?? "");
  }
  return out;
}

function localHour(offsetMinutes: number) {
  const ms = Date.now() + offsetMinutes * 60_000;
  return new Date(ms).getUTCHours();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function makeMagicLink(admin: any, userId: string, targetPath: string) {
  const token = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  await admin.from("telegram_magic_links").insert({
    token,
    user_id: userId,
    purpose: "nudge",
    target_path: targetPath,
    expires_at: expiresAt,
  });
  return { token, url: `${SITE_URL}/auth/magic?t=${token}` };
}

// The student Mini App kill-switch, read once per invocation (fail-closed → today's magic links).
let runFlag: WatchFlag = { on: false, watch: false };

async function sendNudge(
  admin: any,
  templates: any,
  profile: any,
  type: NudgeType,
  extra: Record<string, string>,
  targetPath: string,
) {
  const tpl = pickTpl(templates, type, profile.preferred_locale || profile.preferred_language || "uz");
  const name = (profile.name || "").trim() || "do'stim";
  const body = render(tpl.body, { name, ...extra });
  const button = tpl.button || "Open";
  // A TRANSPORT failure (tgSend throws) used to propagate out of the whole run: the nudge_log row was
  // never written, the remaining candidates were skipped, and so were the later run types — the only
  // trace was an HTTP 500 body. sendNudgeWith contains it per candidate so one flaky send costs one nudge,
  // and the failure stays DB-visible in nudge_log.error (graceful is not silent).
  return await sendNudgeWith({
    admin,
    flag: runFlag,
    newId: () => crypto.randomUUID(),
    makeMagicLink: (userId, path) => makeMagicLink(admin, userId, path),
    send: tgSend,
    insertLog: (row) => admin.from("nudge_log").insert(row),
    redact: (e) => redactSecrets(e),
  }, profile, type, body, button, extra, targetPath);
}

async function recentCount(admin: any, profileId: string, days = 7) {
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const { count } = await admin
    .from("nudge_log")
    .select("id", { count: "exact", head: true })
    .eq("profile_id", profileId)
    .gte("sent_at", since);
  return count || 0;
}

async function lastSentOfType(admin: any, profileId: string, type: NudgeType) {
  const { data } = await admin
    .from("nudge_log")
    .select("sent_at, clicked_at")
    .eq("profile_id", profileId)
    .eq("nudge_type", type)
    .order("sent_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data;
}

async function isEligible(admin: any, profile: any, type: NudgeType): Promise<{ ok: boolean; reason?: string }> {
  if (!profile.telegram_id) return { ok: false, reason: "no_telegram" };
  const { data: prefs } = await admin
    .from("nudge_preferences")
    .select("opt_in, paused_until")
    .eq("profile_id", profile.id)
    .maybeSingle();
  if (prefs && prefs.opt_in === false) return { ok: false, reason: "opt_out" };
  if (prefs?.paused_until) {
    const today = new Date().toISOString().slice(0, 10);
    if (prefs.paused_until >= today) return { ok: false, reason: "paused" };
  }
  // Quiet hours
  const hr = localHour(profile.tashkent_offset_minutes ?? 300);
  if (hr < 8 || hr >= 22) return { ok: false, reason: "quiet" };
  // Weekly rate limit (module_complete is exempt)
  if (type !== "module_complete") {
    const cnt = await recentCount(admin, profile.id, 7);
    if (cnt >= 3) return { ok: false, reason: "rate_limit" };
  }
  return { ok: true };
}

async function runInactive3d(admin: any, templates: any) {
  const { data: candidates } = await admin.rpc("nudge_candidates_inactive", { _days: 3 });
  let sent = 0, skipped = 0, failed = 0;
  for (const p of candidates || []) {
    // Skip if any nudge in last 7 days
    const recent = await recentCount(admin, p.id, 7);
    if (recent > 0) { skipped++; continue; }
    const elig = await isEligible(admin, p, "inactive_3d");
    if (!elig.ok) { skipped++; continue; }
    // `sent` must mean DELIVERED: a transport failure is now caught inside sendNudge (it writes the
    // nudge_log row and returns ok:false), so counting it here would over-report success to anything
    // that later reads this summary.
    const r = await sendNudge(admin, templates, p, "inactive_3d", {}, "/dashboard");
    if (r.ok) sent++; else failed++;
    await sleep(50);
  }
  return { sent, failed, skipped, total: candidates?.length || 0 };
}

async function runInactive7d(admin: any, templates: any) {
  const { data: candidates } = await admin.rpc("nudge_candidates_inactive", { _days: 7 });
  let sent = 0, skipped = 0, failed = 0;
  for (const p of candidates || []) {
    const last3 = await lastSentOfType(admin, p.id, "inactive_3d");
    if (last3?.clicked_at) { skipped++; continue; }
    const recent = await recentCount(admin, p.id, 7);
    if (recent > 0) { skipped++; continue; }
    const elig = await isEligible(admin, p, "inactive_7d");
    if (!elig.ok) { skipped++; continue; }
    let teacherLine = "";
    if (p.teacher_name) {
      const loc = (p.preferred_locale || "uz").toLowerCase().slice(0, 2);
      if (loc === "ru") teacherLine = `Учитель ${p.teacher_name} ждёт вас. `;
      else if (loc === "en") teacherLine = `Your teacher ${p.teacher_name} is waiting. `;
      else teacherLine = `Ustozingiz ${p.teacher_name} sizni kutmoqda. `;
    }
    const r = await sendNudge(admin, templates, p, "inactive_7d", { teacher_line: teacherLine }, "/dashboard");
    if (r.ok) sent++; else failed++;
    await sleep(50);
  }
  return { sent, failed, skipped, total: candidates?.length || 0 };
}

async function runModuleComplete(admin: any, templates: any) {
  const { data: queue } = await admin
    .from("nudge_module_celebrations")
    .select("profile_id, module_id")
    .is("sent_at", null)
    .limit(500);
  let sent = 0, skipped = 0, failed = 0;
  for (const q of queue || []) {
    const { data: p } = await admin
      .from("profiles")
      .select("id, name, telegram_id, preferred_locale, preferred_language, tashkent_offset_minutes, status")
      .eq("id", q.profile_id)
      .maybeSingle();
    if (!p?.telegram_id) { skipped++; continue; }
    if ((p as any).status === "archived") { skipped++; continue; }
    // Quiet hours: defer (don't mark sent)
    const hr = localHour(p.tashkent_offset_minutes ?? 300);
    if (hr < 8 || hr >= 22) { skipped++; continue; }
    // Opt-out still respected
    const { data: prefs } = await admin.from("nudge_preferences").select("opt_in, paused_until").eq("profile_id", p.id).maybeSingle();
    if (prefs && prefs.opt_in === false) { skipped++; continue; }
    if (prefs?.paused_until && prefs.paused_until >= new Date().toISOString().slice(0, 10)) { skipped++; continue; }
    const { data: m } = await admin.from("modules").select("title").eq("id", q.module_id).maybeSingle();
    const r = await sendNudge(admin, templates, p, "module_complete", { module_name: m?.title || "" }, "/dashboard");
    // sent_at is still stamped regardless of delivery — unchanged on purpose: this queue is at-most-once,
    // so a blocked recipient can't have the celebration retried every hour. nudge_log carries the error.
    await admin.from("nudge_module_celebrations").update({ sent_at: new Date().toISOString() }).eq("profile_id", q.profile_id).eq("module_id", q.module_id);
    if (r.ok) sent++; else failed++;
    await sleep(50);
  }
  return { sent, failed, skipped, total: queue?.length || 0 };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    if (!BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN not configured");
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    const body = await req.json().catch(() => ({}));
    const mode = body?.mode || "cron";

    // Cron mode requires the internal-secret header (test mode authenticates via admin JWT below).
    if (mode !== "test") {
      if (!(await verifyInternalSecret(req, admin))) {
        return new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
    }

    // Load templates
    const { data: settings } = await admin.from("platform_settings").select("value").eq("key", "nudge_templates").maybeSingle();
    const templates = settings?.value || {};
    runFlag = await loadStudentMiniAppFlag(admin);

    if (mode === "test") {
      // Verify admin
      const authHeader = req.headers.get("Authorization") || "";
      const jwt = authHeader.replace(/^Bearer\s+/i, "");
      if (!jwt) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: `Bearer ${jwt}` } } });
      const { data: userData } = await userClient.auth.getUser();
      const callerId = userData?.user?.id;
      if (!callerId) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      const { data: roleRow } = await admin.from("user_roles").select("role").eq("user_id", callerId).eq("role", "admin").maybeSingle();
      if (!roleRow) return new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });

      const type: NudgeType = body?.nudge_type || "inactive_3d";
      const { data: setting } = await admin.rpc("get_setting", { _key: "bot.test_recipient_username" });
      const testUsername = (typeof setting === "string" ? setting : (setting as any)) || "alikhanova_admin";
      const { data: me } = await admin
        .from("profiles")
        .select("id, name, telegram_id, preferred_locale, preferred_language, tashkent_offset_minutes")
        .eq("telegram_username", testUsername)
        .maybeSingle();
      if (!me?.telegram_id) {
        return new Response(JSON.stringify({ error: `test recipient @${testUsername} not found or has no telegram_id` }), { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      const extra: Record<string, string> = {};
      let path = "/dashboard";
      if (type === "inactive_7d") extra.teacher_line = "";
      if (type === "stuck_lesson") { extra.lesson_title = "Test lesson"; path = "/dashboard"; }
      if (type === "module_complete") extra.module_name = "Test module";
      const r = await sendNudge(admin, templates, me, type, extra, path);
      return new Response(JSON.stringify({ ok: r.ok, status: r.status, data: r.data }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Cron mode
    const i3 = await runInactive3d(admin, templates);
    const i7 = await runInactive7d(admin, templates);
    const stuck = { retired: true, sent: 0, failed: 0, skipped: 0, total: 0 }; // see the header
    const mc = await runModuleComplete(admin, templates);
    return new Response(JSON.stringify({ ok: true, inactive_3d: i3, inactive_7d: i7, stuck_lesson: stuck, module_complete: mc, miniapp: runFlag }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: redactSecrets((e as any)?.message ?? e) }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
