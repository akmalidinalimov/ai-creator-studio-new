// challenge-tasks-worker {mode: 'week_approval'} (Daily Tasks PR-9): sends the weekly approval ask / reminder / "no
// tasks" note that challenge_tasks_week_approval_tick() queued (migration 20260930200010). Every decision is SQL's:
//   challenge_task_week_msg_claim   leases due messages (never in quiet hours; expired / nothing-left rows skipped)
//   challenge_task_week_view        the week, rendered by _shared/week-approval.ts (the bot re-renders the same view)
//   challenge_task_week_msg_record  the outcome (message_id kept: the bot edits every copy after an approval); when a
//                                   batch ends with no admin reached -> 'challenge_week_approval_undelivered'
// Sends go through sendTelegramWithResult (io.send): a 429 stops this run (the lease is recorded failed, re-offered in
// 10 minutes); a recipient / content error is terminal; anything else is retried (3 attempts in all).
import { renderKind, toWeekView, type WeekView } from "../_shared/week-approval.ts";
import { redactSecrets } from "../_shared/redact.ts";
import type { SendFn } from "./registrar.ts";

// deno-lint-ignore no-explicit-any
type Db = any;
// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

export const WEEK_BATCH = 10;
export const WEEK_GAP_MS = 40; // DMs: <= 25 a second (the bot-wide limit is ~30)

export interface WeekApprovalIO {
  admin: Db;
  send: SendFn;
  left: () => number;
  sleep: (ms: number) => Promise<void>;
  errors: string[];
}

function errCode(e: { code?: string; message?: string } | null | undefined): string {
  return `${String(e?.code ?? "error").slice(0, 20)}: ${String(e?.message ?? "").slice(0, 160)}`;
}

/** One pass over the claimable admin messages. Returns a tally {sent, failed, skipped, deferred}. */
export async function sendWeekApprovals(io: WeekApprovalIO): Promise<Record<string, number>> {
  const tally: Record<string, number> = {};
  const inc = (k: string) => { tally[k] = (tally[k] ?? 0) + 1; };
  const views = new Map<string, WeekView | null>();
  const record = async (it: Row, ok: boolean, messageId: number | null, error: string | null, terminal: boolean) => {
    const { error: e } = await io.admin.rpc("challenge_task_week_msg_record", {
      _id: Number(it.id), _token: String(it.token), _ok: ok, _message_id: messageId, _error: error, _terminal: terminal,
    });
    if (e) io.errors.push(`week_msg_record: ${errCode(e)}`);
  };
  const viewOf = async (week: string): Promise<WeekView | null> => {
    if (views.has(week)) return views.get(week) ?? null;
    const { data, error } = await io.admin.rpc("challenge_task_week_view", { _week_start: week });
    if (error) io.errors.push(`week_view: ${errCode(error)}`);
    const v = error ? null : toWeekView(data, week);
    views.set(week, v);
    return v;
  };

  const { data, error } = await io.admin.rpc("challenge_task_week_msg_claim", { _limit: WEEK_BATCH });
  if (error) {
    io.errors.push(`week_msg_claim: ${errCode(error)}`);
    return tally;
  }
  const items = data?.ok === true && Array.isArray(data.items) ? data.items as Row[] : [];
  let stop = false;
  for (const it of items) {
    if (stop || io.left() < 3_000) {
      inc("deferred"); // the lease expires in 5 minutes and a later kick takes it
      continue;
    }
    const chat = Number(it.chat_id);
    if (!Number.isSafeInteger(chat) || chat === 0) {
      await record(it, false, null, "no_chat_id", true);
      inc("skipped");
      continue;
    }
    const week = String(it.week_start ?? "");
    const v = await viewOf(week);
    if (!v) {
      await record(it, false, null, "view_error", false); // retried in 10 minutes
      inc("failed");
      continue;
    }
    let r;
    try {
      r = renderKind(String(it.kind), v);
    } catch (e) {
      io.errors.push(`week_render: ${redactSecrets(e).slice(0, 160)}`);
      r = null;
    }
    if (!r || !r.text.trim()) {
      await record(it, false, null, "nothing_to_send", true);
      inc("skipped");
      continue;
    }
    const { outcome, result } = await io.send("sendMessage", {
      chat_id: chat, text: r.text, parse_mode: "HTML", disable_web_page_preview: true,
      ...(r.keyboard ? { reply_markup: r.keyboard } : {}),
    }, { admin: io.admin, purpose: `challenge_week_approval_${String(it.kind)}`, recipientId: chat });
    const mid = Number(result?.message_id);
    if (outcome.ok && Number.isSafeInteger(mid) && mid > 0) {
      await record(it, true, mid, null, false);
      inc("sent");
    } else if (outcome.klass === "rate_limited") {
      await record(it, false, null, `rate_limited: retry_after ${outcome.retryAfterSec ?? "?"}`, false);
      inc("deferred");
      stop = true; // flood control is bot-wide: no more sends this run
    } else {
      await record(it, false, null, `${outcome.klass}: ${outcome.error ?? "no message id"}`.slice(0, 300), outcome.terminal);
      inc(outcome.terminal ? "skipped" : "failed");
    }
    await io.sleep(WEEK_GAP_MS);
  }
  return tally;
}
