// The WEEKLY APPROVAL buttons in the admins' DM (Daily Tasks PR-9): dtw:a|y|b:<yyyymmdd>.
//
//   dtw:a  ✅ Haftani tasdiqlash -> the message becomes the confirm step «N ta vazifa tasdiqlansinmi?»
//   dtw:y  ✅ Ha, tasdiqlash      -> challenge_tasks_approve_week(week, actor = the REAL clicker): every draft of the
//                                    week through the approve guard; the tapped message becomes the result, and every
//                                    other admin's copy (ask / reminder, from challenge_task_week_approval_messages) is
//                                    edited to the same result (best effort, recorded: challenge_week_approval_copies_updated)
//   dtw:b  ↩️ Orqaga              -> back to the listing
//
// ADMIN ONLY, like ops: -- checked on the server on every tap: the REAL clicker's persona must be "admin" (getPersona,
// injected as isAdmin), and an admin who is impersonating is refused (index.ts refuses ^dtw: under impersonation too;
// this module refuses again, so it is safe on its own). The approval RPC re-checks has_role(actor, 'admin') in SQL.
// Refusals and failures are DB-visible: 'challenge_week_approval_refused' (once per clicker per day) and
// 'challenge_week_approval_failed'. Every approval writes 'challenge_week_approved' (SQL).
//
// PAST DAYS (review fix): an old ask keeps its ✅ after the week starts, but a past day is never approved from here --
// PR-5 never posts it, and an approved-but-never-posted day is a miss in every student's streak. The view says what
// today is (SQL now(), Tashkent): the confirm step counts today-and-later drafts only and marks past days; a week whose
// Sunday is over answers «Bu hafta o‘tib ketdi» without calling the approval ('challenge_week_approval_past_week', once
// per admin, week and day) and loses its approve button. challenge_tasks_approve_week enforces the same rule itself
// (past drafts come back in skipped_past), so a view that fails to load can never approve a past day either.
//
// The text is rendered by _shared/week-approval.ts from public.challenge_task_week_view -- the same renderer the worker
// sent the ask with. parse/render are pure and unit-tested (week-approval.test.ts); the whole flow runs against the
// real SQL in _challenge/testing/daily-tasks-week-approval-check.ts.
import { logHealth, logHealthOnce } from "../_shared/edge.ts";
import { type SendResultOutcome, sendTelegramWithResult } from "../_shared/telegram-send.ts";
import {
  type ApproveResult, parseDtwCallback, type PastSkip, renderAsk, renderConfirm, renderResult, type Rendered, toWeekView,
  weekCounts, type WeekView, weekPhase,
} from "../_shared/week-approval.ts";

export { parseDtwCallback } from "../_shared/week-approval.ts";

// deno-lint-ignore no-explicit-any
type Db = any;

export type SendFn = (
  method: string,
  payload: Record<string, unknown>,
  opts?: { admin?: Db; purpose?: string; recipientId?: string | number | null; record?: boolean },
  // deno-lint-ignore no-explicit-any
) => Promise<{ outcome: SendResultOutcome; result: any }>;

export interface WeekApprovalDeps {
  /** Bot API sender; default sendTelegramWithResult with the bot token. Tests inject a recorder. */
  send?: SendFn;
  botToken?: string;
  answerCallback: (id: string, text?: string) => Promise<unknown>;
  /** true only when the REAL clicker's persona is "admin" (index.ts: getPersona(...) === "admin"). */
  isAdmin: (admin: Db, userId: string) => Promise<boolean>;
}

export type Clicker = { id: string; name?: string | null } | null | undefined;

export const TOAST = {
  readOnly: "👁 Faqat o'qish — /admin",
  adminOnly: "⛔ Faqat admin uchun",
  stale: "Bu tugma eskirgan",
  error: "⚠️ Xato — qayta urinib ko‘ring",
  already: "Allaqachon tasdiqlangan",
  pastWeek: "⌛ Bu hafta o‘tib ketdi",
  pastDays: "⌛ O‘tgan kunlar bu yerdan tasdiqlanmaydi",
  back: "↩️",
} as const;

function errText(e: { code?: string; message?: string } | null | undefined): string {
  return `${String(e?.code ?? "error").slice(0, 20)}: ${String(e?.message ?? "").slice(0, 200)}`;
}

/** The friendly toast for a failed approval call: the SQL's own admin-facing words when it raised one. */
export function approveErrorToast(e: { code?: string; message?: string } | null | undefined): string {
  const m = String(e?.message ?? "");
  if (/Faqat admin/.test(m) || e?.code === "42501") return TOAST.adminOnly;
  if (/dushanba/.test(m)) return TOAST.stale;
  return TOAST.error;
}

export function toApproveResult(raw: unknown): ApproveResult | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o.ok !== true) return null;
  return {
    approved: Number(o.approved) || 0,
    already_approved: Number(o.already_approved) || 0,
    failed: Array.isArray(o.failed) ? o.failed as ApproveResult["failed"] : [],
    skipped_past: Array.isArray(o.skipped_past)
      ? (o.skipped_past as unknown[]).filter((p): p is PastSkip => !!p && typeof p === "object")
      : [],
    past_week: o.past_week === true,
    drafts_left: Number(o.drafts_left) || 0,
    actor_name: typeof o.actor_name === "string" ? o.actor_name : null,
  };
}

/** The toast after an approval call. */
export function approveToast(r: ApproveResult): string {
  const past = r.skipped_past?.length ?? 0;
  if (r.approved === 0 && r.failed.length === 0) return r.past_week ? TOAST.pastWeek : past > 0 ? TOAST.pastDays : TOAST.already;
  if (r.failed.length) return `⚠️ ${r.approved} ta tasdiqlandi, ${r.failed.length} ta xato`;
  return `✅ ${r.approved} ta tasdiqlandi`;
}

export function createWeekApproval(deps: WeekApprovalDeps) {
  const send: SendFn = deps.send ?? ((method, payload, opts) => sendTelegramWithResult(deps.botToken ?? "", method, payload, opts));

  async function loadView(admin: Db, week: string): Promise<WeekView | null> {
    const { data, error } = await admin.rpc("challenge_task_week_view", { _week_start: week });
    if (error) {
      await logHealth(admin, "challenge_week_approval_failed", { step: "view", week, error: errText(error) },
        { source: "telegram-bot-webhook" });
      return null;
    }
    return toWeekView(data, week);
  }

  async function edit(admin: Db, chatId: number, messageId: number, r: Rendered, purpose: string) {
    return await send("editMessageText", {
      chat_id: chatId, message_id: messageId, text: r.text, parse_mode: "HTML", disable_web_page_preview: true,
      reply_markup: r.keyboard ?? { inline_keyboard: [] },
    }, { admin, purpose, recipientId: chatId });
  }

  /** Every OTHER admin's copy of this week's ask / reminder -> the result (best effort, recorded in SQL). */
  async function updateCopies(admin: Db, week: string, actorId: string, r: Rendered, tapped: { chat: number; message: number }) {
    const { data, error } = await admin.from("challenge_task_week_approval_messages")
      .select("id, chat_id, message_id, kind").eq("week_start", week).eq("state", "sent");
    if (error) {
      await logHealth(admin, "challenge_week_approval_failed", { step: "copies_read", week, error: errText(error) },
        { source: "telegram-bot-webhook" });
      return;
    }
    const rows = (Array.isArray(data) ? data : []) as Array<{ id: number; chat_id: number; message_id: number | null; kind: string }>;
    const results: Array<{ id: number; ok: boolean; error?: string | null }> = [];
    for (const m of rows) {
      if (m.kind === "no_tasks" || !m.message_id) continue;
      if (Number(m.chat_id) === tapped.chat && Number(m.message_id) === tapped.message) {
        results.push({ id: Number(m.id), ok: true }); // the tapped message itself (already edited)
        continue;
      }
      const { outcome } = await edit(admin, Number(m.chat_id), Number(m.message_id), r, "challenge_week_approval_copy");
      results.push({ id: Number(m.id), ok: outcome.ok, error: outcome.ok ? null : `${outcome.klass}: ${outcome.error ?? ""}`.slice(0, 200) });
    }
    if (!results.length) return;
    const { error: re } = await admin.rpc("challenge_task_week_edits_record", { _week_start: week, _actor: actorId, _results: results });
    if (re) {
      await logHealth(admin, "challenge_week_approval_failed", { step: "copies_record", week, error: errText(re) },
        { source: "telegram-bot-webhook" });
    }
  }

  // deno-lint-ignore no-explicit-any
  async function onCallback(admin: Db, cq: any, ctx: { clicker: Clicker; impersonating: boolean }): Promise<void> {
    const cb = parseDtwCallback(cq?.data);
    const chatId = Number(cq?.message?.chat?.id);
    const messageId = Number(cq?.message?.message_id);
    if (ctx.impersonating) {
      await deps.answerCallback(cq.id, TOAST.readOnly);
      return;
    }
    const clicker = ctx.clicker;
    if (!clicker?.id || !(await deps.isAdmin(admin, clicker.id))) {
      // only admins ever receive this message; a tap by anyone else (a forwarded copy) is refused and recorded once a
      // day per clicker (logHealthOnce dedupes per Tashkent day)
      await logHealthOnce(admin, "challenge_week_approval_refused", String(cq?.from?.id ?? "?"), {
        tg_user_id: cq?.from?.id ?? null, profile_id: clicker?.id ?? null, data: String(cq?.data ?? "").slice(0, 64),
      }, { source: "telegram-bot-webhook" });
      await deps.answerCallback(cq.id, TOAST.adminOnly);
      return;
    }
    if (!cb || !Number.isSafeInteger(chatId) || !Number.isSafeInteger(messageId) || messageId <= 0) {
      await deps.answerCallback(cq.id, TOAST.stale);
      return;
    }

    // a week that is over: nothing to approve from here (an old ask / confirm still carries the buttons) -- say so, drop
    // the approve button from this copy, and leave a DB-visible trace (graceful is not silent)
    const actorId: string = clicker.id;
    const { week, action } = cb;
    const pastWeek = async (v: WeekView) => {
      await logHealthOnce(admin, "challenge_week_approval_past_week", `${actorId}:${week}`, {
        week, actor: actorId, tg_user_id: cq?.from?.id ?? null, action, today: v.today ?? null,
        past_drafts: weekCounts(v).pastDrafts,
      }, { source: "telegram-bot-webhook", actorUserId: actorId });
      await deps.answerCallback(cq.id, TOAST.pastWeek);
      await edit(admin, chatId, messageId, renderAsk(v, "ask"), "challenge_week_approval_past_week");
    };

    if (cb.action === "a" || cb.action === "b") {
      const v = await loadView(admin, cb.week);
      if (!v) {
        await deps.answerCallback(cq.id, TOAST.error);
        return;
      }
      if (cb.action === "a" && weekPhase(v) === "past") return await pastWeek(v);
      // today-and-later drafts only; nothing left (approved on the web / by another admin, or only past days remain):
      // the listing without the approve button
      const { drafts, pastDrafts } = weekCounts(v);
      const r = cb.action === "a" && drafts > 0 ? renderConfirm(v) : renderAsk(v, "ask");
      await deps.answerCallback(cq.id, cb.action === "a" && drafts === 0 ? (pastDrafts > 0 ? TOAST.pastDays : TOAST.already) : undefined);
      await edit(admin, chatId, messageId, r, cb.action === "a" ? "challenge_week_approval_confirm" : "challenge_week_approval_back");
      return;
    }

    // dtw:y -- the approval itself, as the REAL clicker (the SQL re-checks the admin role and stamps approved_by, and
    // approves today-and-later drafts only). A week already over is refused before the call; when the view cannot be
    // read the call still goes ahead -- the SQL is the guard.
    const pre = await loadView(admin, cb.week);
    if (pre && weekPhase(pre) === "past") return await pastWeek(pre);
    const { data, error } = await admin.rpc("challenge_tasks_approve_week", { _week_start: cb.week, _actor: clicker.id });
    const res = error ? null : toApproveResult(data);
    if (!res) {
      await logHealth(admin, "challenge_week_approval_failed", {
        step: "approve", week: cb.week, actor: clicker.id, error: error ? errText(error) : `bad result: ${JSON.stringify(data).slice(0, 200)}`,
      }, { source: "telegram-bot-webhook" });
      await deps.answerCallback(cq.id, approveErrorToast(error));
      return;
    }
    await deps.answerCallback(cq.id, approveToast(res));
    const v = (await loadView(admin, cb.week)) ?? toWeekView(null, cb.week);
    const r = renderResult(v, res, res.actor_name ?? clicker.name ?? null);
    await edit(admin, chatId, messageId, r, "challenge_week_approval_result");
    // the other admins' copies follow only when something WAS approved (a double tap, or a run where the guard refused
    // every draft, leaves their buttons as they are)
    if (res.approved > 0) await updateCopies(admin, cb.week, clicker.id, r, { chat: chatId, message: messageId });
  }

  return { onCallback };
}
