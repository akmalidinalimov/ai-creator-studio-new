// teacher-broadcast-group — Mini App API for a teacher to DM-broadcast a message to every student
// in one of their groups. This is NOT a post into the Telegram supergroup chat: it fans out an
// individual sendMessage DM to each student, exactly like the existing bot-chat `/tbroadcast` flow
// (telegram-bot-webhook handleTeacherSession, index.ts:4337-4380). Task 2 (the Mini App Broadcast
// screen) is the consumer.
//
// POST { group_id: uuid, message: string } (Authorization: Bearer <session jwt>)
//   -> { ok: true, sent: number, total: number, skipped_no_telegram: number }  (200)
//   -> { error: "unauthorized" }                    (401 — no/invalid session)
//   -> { error: "group_id and message required" }   (400 — missing/blank input)
//   -> { error: "message_too_long" }                (400 — trimmed message > 300 chars)
//   -> { error: "forbidden" }                        (403 — not this group's teacher, not admin/superadmin)
//   -> { error: "rate_limited" }                     (429 — a teacher-scope broadcast within the last hour)
//   -> { error: "no_recipients" }                    (400 — group has zero students with a telegram_id)
//   -> { error: "unknown" }                          (500 — unexpected failure; generic on purpose)
//
// Auth: the caller's Supabase session JWT (verify_jwt = true in supabase/config.toml — the gateway
// rejects unauthenticated calls before this code runs). RBAC is junction-aware (CLAUDE.md): authorized
// via is_group_teacher(_group_id,_uid) RPC (covers groups.teacher_id ∪ group_teachers), never a direct
// groups.teacher_id filter, OR a platform admin/superadmin role.
//
// Rate limits mirror the bot flow exactly: one teacher-scope broadcast per hour (bot_broadcast_rate,
// scope:"teacher"), plus a per-recipient scope:"recipient" row for every DM actually attempted.
//
// SECURITY (bot-token containment): the Telegram bot token is read from TELEGRAM_BOT_TOKEN and used
// ONLY inside the server-side fetch call below. It is never included in any response body, admin_actions
// details, or logError context — only the recipient's internal profile id / user id ever appears there.
//
// Incident doctrine (CLAUDE.md #5): every send exception is captured DB-visibly via logError
// (platform_error_log, mirroring the webhook's logError). On success, an admin_actions row
// (action: "teacher_broadcast_miniapp") makes the whole broadcast DB-visible to the health/detector
// layer — errors that only live in function logs are invisible to the watchdogs.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const MAX_MESSAGE_LEN = 300; // mirrors the bot's /tbroadcast cap (handleTeacherSession)
const RATE_WINDOW_MS = 3600_000; // 1 hour, same window as the bot flow

// Copied verbatim from telegram-bot-webhook/index.ts (T.uz/T.ru/T.en teacherFromTeacher) so the DM
// header is byte-identical to the bot-chat broadcast path.
const TEACHER_FROM_TEACHER: Record<string, (groupName: string) => string> = {
  uz: (n) => `📣 <b>O'qituvchidan xabar — ${n}</b>\n\n`,
  ru: (n) => `📣 <b>Сообщение от преподавателя — ${n}</b>\n\n`,
  en: (n) => `📣 <b>Message from teacher — ${n}</b>\n\n`,
};

// Minimal HTML escaper — copied from the webhook's csvEscapeHtml (index.ts:2863). The broadcast body
// uses parse_mode "HTML", so a teacher's free-text message must never break out of the markup.
function csvEscapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// DB-visible error capture — copied from telegram-bot-webhook's logError (index.ts:1533). Inserts into
// the same platform_error_log table/columns so the existing watchdogs/detectors see it identically.
// Never throws, never blocks the caller, never carries the bot token.
async function logError(
  admin: any, source: string, message: unknown,
  ctx: { action?: string; user_id?: string | null; telegram_id?: number | null; context?: Record<string, unknown> } = {},
): Promise<void> {
  try {
    await admin.from("platform_error_log").insert({
      source,
      action: ctx.action ?? null,
      message: String(message instanceof Error ? message.message : message).slice(0, 1000),
      user_id: ctx.user_id ?? null,
      telegram_id: ctx.telegram_id ?? null,
      context: ctx.context ?? {},
    });
  } catch (_e) { /* error logging must never throw */ }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const admin = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const anon = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") || "" } },
  });

  try {
    const { data: who } = await anon.auth.getUser();
    if (!who?.user) return json({ error: "unauthorized" }, 401);

    const { group_id, message } = await req.json().catch(() => ({}) as any);
    if (!group_id || typeof message !== "string" || !message.trim()) {
      return json({ error: "group_id and message required" }, 400);
    }
    const trimmed = message.trim();
    if (trimmed.length > MAX_MESSAGE_LEN) return json({ error: "message_too_long" }, 400);

    // --- Authorize: junction-aware teacher-of-this-group OR admin/superadmin. Never filter
    // groups.teacher_id directly (CLAUDE.md junction-aware gate). ---
    const [{ data: isTeacher }, { data: roles }] = await Promise.all([
      admin.rpc("is_group_teacher", { _group_id: group_id, _uid: who.user.id }),
      admin.from("user_roles").select("role").eq("user_id", who.user.id),
    ]);
    const roleSet = new Set(((roles || []) as any[]).map((r: any) => r.role));
    if (!isTeacher && !roleSet.has("admin") && !roleSet.has("superadmin")) {
      return json({ error: "forbidden" }, 403);
    }

    // --- Rate limit: one teacher-scope broadcast per hour, same as the bot flow. ---
    const since = new Date(Date.now() - RATE_WINDOW_MS).toISOString();
    const { count: recentTeacherSends } = await admin.from("bot_broadcast_rate")
      .select("id", { count: "exact", head: true })
      .eq("actor_user_id", who.user.id).eq("scope", "teacher").gte("created_at", since);
    if ((recentTeacherSends || 0) >= 1) return json({ error: "rate_limited" }, 429);

    // --- Resolve the group name + recipients (students with a telegram_id). ---
    const [{ data: group }, { data: rows }] = await Promise.all([
      admin.from("groups").select("name").eq("id", group_id).maybeSingle(),
      admin.from("profiles").select("id, telegram_id, preferred_locale, name").eq("group_id", group_id),
    ]);
    const allRows = (rows || []) as any[];
    const recipients = allRows.filter((r) => r.telegram_id);
    const total = recipients.length;
    const skipped_no_telegram = allRows.length - recipients.length;
    if (total === 0) return json({ error: "no_recipients" }, 400);

    // --- Build the DM body: locale-appropriate "message from teacher" prefix + escaped text. ---
    const { data: teacherProfile } = await admin.from("profiles")
      .select("preferred_locale").eq("id", who.user.id).maybeSingle();
    const locale = ["uz", "ru", "en"].includes(teacherProfile?.preferred_locale)
      ? (teacherProfile!.preferred_locale as string) : "uz";
    const groupName = group?.name || "—";
    const body = `${TEACHER_FROM_TEACHER[locale](groupName)}${csvEscapeHtml(trimmed)}`;

    // --- Fan out. A thrown exception (network fault) is logged DB-visibly and skipped; a Telegram-side
    // "blocked bot" ok:false response does NOT throw and is counted as sent, matching the bot flow. ---
    const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") || "";
    let sent = 0;
    for (const r of recipients) {
      try {
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: Number(r.telegram_id), text: body,
            parse_mode: "HTML", disable_web_page_preview: true,
          }),
        });
        await admin.from("bot_broadcast_rate").insert({
          actor_user_id: who.user.id, recipient_user_id: r.id, scope: "recipient",
        });
        sent++;
      } catch (e) {
        await logError(admin, "teacher-broadcast-group", e, {
          action: "teacher_broadcast_miniapp_send", user_id: r.id,
        });
      }
    }

    // --- Stamp the teacher-scope rate row + a DB-visible health/audit row (incident doctrine: new
    // features must emit DB-visible health signals). ---
    await admin.from("bot_broadcast_rate").insert({ actor_user_id: who.user.id, scope: "teacher" });
    try {
      await admin.from("admin_actions").insert({
        actor_user_id: who.user.id,
        action: "teacher_broadcast_miniapp",
        target_user_id: null,
        target_resource_type: "group",
        target_resource_id: group_id,
        details: { group_id, sent, total, skipped_no_telegram },
      });
    } catch (_e) { /* audit best-effort, never blocks the response */ }

    return json({ ok: true, sent, total, skipped_no_telegram });
  } catch (e) {
    await logError(admin, "teacher-broadcast-group", e, { action: "teacher_broadcast_miniapp_unhandled" });
    return json({ error: "unknown" }, 500);
  }
});
