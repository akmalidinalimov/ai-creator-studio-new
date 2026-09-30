// challenge-tasks-worker — the identity sweep's registrar: the daily-topic twin of the bot's
// autoRegisterDailyTaskPoster (telegram-bot-webhook/index.ts), for a sender the bot could not resolve at post time.
// resolveGroupPoster (_shared/group-poster-identity.ts) calls it ONLY when no profile carries the sender's telegram_id
// or username, so the getChatMember probe below runs only for users WITHOUT a profile (spec §10.2).
//
// Same rules as the bot, deliberately:
//   * chat admins / the creator are never registered (U4) -> 'challenge_task_autoreg_skipped' {reason: chat_admin};
//   * the ONE creation engine, admin-create-students, server to server with x-internal-secret (every dedupe / role
//     rule lives there); account_type is NOT sent, so a matched platform student is never downgraded; 'provisional'
//     is set only when the engine reports status 'created';
//   * every refusal is DB-visible: 'auto_register_failed' {reason} once per (reason, sender) per day, the same action
//     the bot writes (source 'daily_task_post', details.via 'identity_sweep').
import { logHealth, logHealthOnce } from "../_shared/edge.ts";
import { POSTER_PROFILE_COLS } from "../_shared/group-poster-identity.ts";
import { redactSecrets } from "../_shared/redact.ts";
import type { SendResultOutcome } from "../_shared/telegram-send.ts";

// deno-lint-ignore no-explicit-any
type Db = any;

export type SendFn = (
  method: string,
  payload: Record<string, unknown>,
  opts?: { admin?: Db; purpose?: string; recipientId?: string | number | null; record?: boolean; topicMissingAction?: string },
) => Promise<{ outcome: SendResultOutcome; result: any }>;

export interface RegistrarDeps {
  admin: Db;
  send: SendFn;
  fetchFn: typeof fetch;
  supabaseUrl: string;
  serviceKey: string;
}

export interface RegisterInput {
  from: { id: number; username?: string | null; first_name?: string | null; last_name?: string | null; is_bot?: boolean };
  chatId: number;
  threadId: number | null;
  messageId: number | null;
  groupId: string;
  courseId: string;
}

export type AutoRegisterFailReason =
  | "internal_secret_missing" | "engine_error" | "engine_refused" | "profile_not_linked" | "provisional_not_set" | "error";

async function recordFailed(admin: Db, reason: AutoRegisterFailReason, inp: RegisterInput, extra: Record<string, unknown> = {}) {
  await logHealthOnce(admin, "auto_register_failed", `${reason}:daily_task_post:${inp.from.id}`, {
    reason, telegram_id: inp.from.id, telegram_username: inp.from.username || null, group_id: inp.groupId,
    chat_id: inp.chatId, message_id: inp.messageId, via: "identity_sweep", ...extra,
  }, { source: "daily_task_post" });
}

/** The profile (POSTER_PROFILE_COLS) now carrying this telegram_id, or null (declined / refused / failed — recorded). */
export async function registerDailyTaskPoster(d: RegistrarDeps, inp: RegisterInput): Promise<Record<string, unknown> | null> {
  const from = inp.from;
  if (!from?.id || from.is_bot || !inp.groupId || !inp.courseId) return null;
  const admin = d.admin;

  // U4: never the chat's admins. getChatMember is a read (record:false: a probe is never a delivery failure).
  try {
    const { outcome, result } = await d.send("getChatMember", { chat_id: inp.chatId, user_id: from.id }, { record: false });
    const st = outcome.ok ? String(result?.status ?? "") : "";
    if (st === "administrator" || st === "creator") {
      await logHealthOnce(admin, "challenge_task_autoreg_skipped", `chat_admin:${inp.chatId}:${from.id}`, {
        reason: "chat_admin", chat_id: inp.chatId, thread_id: inp.threadId, message_id: inp.messageId,
        telegram_id: from.id, group_id: inp.groupId, via: "identity_sweep",
      }, { source: "challenge-tasks-worker" });
      return null;
    }
  } catch (_e) { /* best-effort, like the bot's registrar — proceed */ }

  try {
    const { data: sec } = await admin.rpc("internal_fn_secret");
    if (!sec) {
      await recordFailed(admin, "internal_secret_missing", inp);
      return null;
    }
    let resp: Response;
    try {
      resp = await d.fetchFn(`${d.supabaseUrl}/functions/v1/admin-create-students`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-internal-secret": String(sec),
          "Authorization": `Bearer ${d.serviceKey}`,
          "apikey": d.serviceKey,
        },
        body: JSON.stringify({
          students: [{
            name: String(from.first_name ?? "").slice(0, 60) || String(from.username ?? "") || `tg-${from.id}`,
            last_name: String(from.last_name ?? "").slice(0, 60) || undefined,
            telegram_user_id: from.id,
            telegram_username: from.username || undefined,
            role: "student",
          }],
          target_group_id: inp.groupId,
          target_course_id: inp.courseId,
        }),
      });
    } catch (e) {
      await recordFailed(admin, "engine_error", inp, { error: redactSecrets(e).slice(0, 200) });
      return null;
    }
    const out = await resp.json().catch(() => ({})) as Record<string, any>;
    const r0 = (Array.isArray(out?.results) ? out.results[0] : null) ?? {};
    if (!r0.userId) {
      await recordFailed(admin, "engine_refused", inp, {
        http_status: resp.status, engine_status: r0.status ?? null,
        engine_error: redactSecrets(r0.error ?? out?.error ?? "").slice(0, 200) || null,
      });
      return null;
    }
    if (r0.status === "created") {
      // A NEW account is a trial account (existing matched accounts keep their type). 0 rows = DB-visible.
      const { data: upd, error: updErr } = await admin.from("profiles").update({ account_type: "provisional" })
        .eq("id", r0.userId).select("id");
      if (updErr || !Array.isArray(upd) || upd.length !== 1) {
        await recordFailed(admin, "provisional_not_set", inp, { user_id: r0.userId, error: updErr?.message ?? null });
      }
      await logHealth(admin, "auto_registered_provisional", {
        telegram_id: from.id, telegram_username: from.username || null, group_id: inp.groupId, source: "daily_task_post",
        via: "identity_sweep",
      }, { source: "daily_task_post", targetUserId: r0.userId, targetResourceType: "profile", targetResourceId: r0.userId });
    }
    const { data: prof } = await admin.from("profiles").select(POSTER_PROFILE_COLS).eq("telegram_id", from.id).maybeSingle();
    if (!prof) {
      await recordFailed(admin, "profile_not_linked", inp, { engine_status: r0.status ?? null, matched_user_id: r0.userId ?? null });
      return null;
    }
    return prof as Record<string, unknown>;
  } catch (e) {
    await recordFailed(admin, "error", inp, { error: redactSecrets(e).slice(0, 200) });
    return null;
  }
}
