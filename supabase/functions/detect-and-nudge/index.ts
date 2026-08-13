// Smart nudges: detects 4 patterns, respects opt-in, paused_until, quiet hours, weekly rate limit.
// Modes: { mode: "test", nudge_type: "inactive_3d"|"inactive_7d"|"stuck_lesson"|"module_complete" }
//          → sends one nudge to @alikhanova_admin (always allowed, bypasses filters).
//        { mode: "cron" } → invoked by pg_cron; runs all 4 types over all eligible students.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { verifyInternalSecret } from "../_shared/internal-secret.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") || "";
const SITE_URL = (Deno.env.get("SITE_URL") || "https://aicreator.academy").replace(/\/$/, "");

type NudgeType = "inactive_3d" | "inactive_7d" | "stuck_lesson" | "module_complete";

async function tgSend(chatId: number, text: string, buttonText: string, url: string) {
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: [[{ text: buttonText, url }]] },
    }),
  });
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
  const { token, url } = await makeMagicLink(admin, profile.id, targetPath);
  const body = render(tpl.body, { name, ...extra });
  const button = tpl.button || "Open";
  const r = await tgSend(Number(profile.telegram_id), body, button, url);
  await admin.from("nudge_log").insert({
    profile_id: profile.id,
    nudge_type: type,
    telegram_message_id: r.ok ? String(r.data?.result?.message_id ?? "") : null,
    magic_token: token,
    payload: { extra, locale: profile.preferred_locale, ok: r.ok },
    error: r.ok ? null : JSON.stringify(r.data).slice(0, 500),
  });
  return r;
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
  let sent = 0, skipped = 0;
  for (const p of candidates || []) {
    // Skip if any nudge in last 7 days
    const recent = await recentCount(admin, p.id, 7);
    if (recent > 0) { skipped++; continue; }
    const elig = await isEligible(admin, p, "inactive_3d");
    if (!elig.ok) { skipped++; continue; }
    await sendNudge(admin, templates, p, "inactive_3d", {}, "/dashboard");
    sent++;
    await sleep(50);
  }
  return { sent, skipped, total: candidates?.length || 0 };
}

async function runInactive7d(admin: any, templates: any) {
  const { data: candidates } = await admin.rpc("nudge_candidates_inactive", { _days: 7 });
  let sent = 0, skipped = 0;
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
    await sendNudge(admin, templates, p, "inactive_7d", { teacher_line: teacherLine }, "/dashboard");
    sent++;
    await sleep(50);
  }
  return { sent, skipped, total: candidates?.length || 0 };
}

async function runStuckLesson(admin: any, templates: any) {
  const { data: candidates } = await admin.rpc("nudge_candidates_stuck");
  let sent = 0, skipped = 0;
  for (const c of candidates || []) {
    const elig = await isEligible(admin, c, "stuck_lesson");
    if (!elig.ok) { skipped++; continue; }
    const recent = await recentCount(admin, c.id, 7);
    if (recent >= 3) { skipped++; continue; }
    await sendNudge(admin, templates, c, "stuck_lesson", { lesson_title: c.lesson_title || "" }, `/lesson/${c.lesson_id}`);
    sent++;
    await sleep(50);
  }
  return { sent, skipped, total: candidates?.length || 0 };
}

async function runModuleComplete(admin: any, templates: any) {
  const { data: queue } = await admin
    .from("nudge_module_celebrations")
    .select("profile_id, module_id")
    .is("sent_at", null)
    .limit(500);
  let sent = 0, skipped = 0;
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
    await sendNudge(admin, templates, p, "module_complete", { module_name: m?.title || "" }, "/dashboard");
    await admin.from("nudge_module_celebrations").update({ sent_at: new Date().toISOString() }).eq("profile_id", q.profile_id).eq("module_id", q.module_id);
    sent++;
    await sleep(50);
  }
  return { sent, skipped, total: queue?.length || 0 };
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
    const stuck = await runStuckLesson(admin, templates);
    const mc = await runModuleComplete(admin, templates);
    return new Response(JSON.stringify({ ok: true, inactive_3d: i3, inactive_7d: i7, stuck_lesson: stuck, module_complete: mc }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e?.message || e) }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
