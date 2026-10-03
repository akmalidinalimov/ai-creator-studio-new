// KUNLIK VAZIFALAR — the bot's I/O for the daily-task topic (Daily Tasks PR-4, build spec v2 §7, §10.5, §11).
//
// The SQL engine (PR-3) decides EVERYTHING — is it a submission, which task, status, points, streak, receipts,
// hints (spec I1). This module only: routes a daily-topic message to challenge_task_capture, resolves an unknown
// poster through the shared resolveGroupPoster (PR-0b) and captures again (the welcome folded into the receipt,
// G7), renders the engine's payload (_shared/daily-task-render.ts) and sends it through sendTelegramWithResult,
// then records the receipt with challenge_task_receipt_record. It also runs the dt: correction buttons
// (move / "Bu topshiriq emas" / undo — the owner lock is SQL-side), the edited_message hook, /start dt_<id> and
// /start ig, my_chat_member recording, the U1 topic buttons, and the misplaced-homework counter.
//
// FAIL CLOSED to today's behaviour (§11.1): unless the 60-second snapshot says "this (chat, thread) is a daily topic
// AND challenge_tasks is active", or when the capture RPC errors / is missing, onGroupMessage answers
// handled:false and the caller runs today's handler unchanged. INERT at merge: challenge_tasks.enabled=false means
// not a single engine RPC or Telegram call per message.
//
// DB-visible outcomes (graceful is not silent): challenge_task_capture_failed {reason}, challenge_task_topic_missing,
// telegram_rate_limited (sendTelegramWithResult), challenge_task_reaction_failed, challenge_task_autoreg_skipped,
// challenge_bot_status_changed, challenge_task_misplaced_homework; plus every row the engine writes itself.
import { logHealth, logHealthOnce } from "../_shared/edge.ts";
import { resolveGroupPoster } from "../_shared/group-poster-identity.ts";
import { type SendResultOutcome, sendTelegramWithResult } from "../_shared/telegram-send.ts";
import {
  correctionToast, type DtPayload, isTelegramUrl, type Locale, parseDailyStartArg, parseDtCallback, reactionFor,
  renderCard, renderHint, renderIgStart, renderMergedNote, renderReceipt, type Rendered, renderUnavailable,
} from "../_shared/daily-task-render.ts";
import {
  botStatusDetails, type CapturePlan, createDailyTopicsCache, type DailyCacheResult, type DailyConfig,
  type DailyLoadResult, type DailyTopic, type DailyTopicsCache, planCapture, routeDaily,
} from "./daily-task-dispatch.ts";

// A service-role Supabase client (typed loosely, like the rest of the bot).
// deno-lint-ignore no-explicit-any
type Db = any;
// deno-lint-ignore no-explicit-any
type TgMessage = any;

export type SendFn = (
  method: string,
  payload: Record<string, unknown>,
  opts?: { admin?: Db; purpose?: string; recipientId?: string | number | null; record?: boolean; topicMissingAction?: string },
) => Promise<{ outcome: SendResultOutcome; result: any }>;

export interface DailyTasksDeps {
  /** Bot API sender; default sendTelegramWithResult with the bot token. Tests inject a recorder. */
  send?: SendFn;
  botToken?: string;
  answerCallback: (id: string, text?: string) => Promise<unknown>;
  botUsername: () => string;
  /** The daily-topic registrar (chat-admin exclusion + the admin-create-students engine), from index.ts. */
  autoRegister: (admin: Db, msg: TgMessage, group: { id: string; course_id: string }) =>
    Promise<{ profile: Record<string, unknown>; created: boolean } | null>;
  /** A login magic link to a site path (for /start ig → Settings), or null. */
  magicLink: (admin: Db, userId: string, path: string) => Promise<string | null>;
  cache?: DailyTopicsCache;
  now?: () => number;
}

const TOPIC_MISSING = "challenge_task_topic_missing";

/**
 * Today's 00:00 in Tashkent, as a UTC ISO timestamp. Tashkent is UTC+5 all year (no DST), so "today" there
 * begins at 19:00 UTC the previous evening. Pure; the clock is injectable for tests.
 */
export function tashkentMidnightUtcIso(now: Date = new Date()): string {
  const OFFSET = 5 * 3600_000;
  const wall = new Date(now.getTime() + OFFSET);                                         // Tashkent wall clock, read as UTC
  const midnight = Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate());
  return new Date(midnight - OFFSET).toISOString();
}
const GROUP_LOCALE: Locale = "uz"; // a group chat is shared: receipts and hints are in Uzbek (§7.2)

function errCode(e: { code?: string; message?: string } | null | undefined): string {
  return String(e?.code ?? "").slice(0, 20) || "error";
}

function rpcMissing(e: { code?: string; message?: string } | null | undefined): boolean {
  return e?.code === "PGRST202" || e?.code === "42883" || /could not find the function/i.test(String(e?.message ?? ""));
}

function tenMinuteBucket(now: number): { key: string; iso: string } {
  const t = Math.floor(now / 600_000) * 600_000;
  return { key: String(t), iso: new Date(t).toISOString() };
}

export async function loadDaily(admin: Db): Promise<DailyLoadResult> {
  const [t, c] = await Promise.all([
    admin.rpc("challenge_task_topics"),
    admin.rpc("challenge_tasks_config"),
  ]);
  return {
    topics: t?.error ? null : (t?.data ?? []),
    topicsError: t?.error ? `${errCode(t.error)}: ${String(t.error.message ?? "").slice(0, 160)}` : null,
    config: c?.error ? null : (c?.data ?? null),
    configError: c?.error ? `${errCode(c.error)}: ${String(c.error.message ?? "").slice(0, 160)}` : null,
  };
}

export function createDailyTasks(deps: DailyTasksDeps) {
  const now = deps.now ?? (() => Date.now());
  let loaderAdmin: Db = null;
  const cache = deps.cache ?? createDailyTopicsCache(() => loadDaily(loaderAdmin), { now });
  const send: SendFn = deps.send ?? ((method, payload, opts) => sendTelegramWithResult(deps.botToken ?? "", method, payload, opts));

  function snapshot(admin: Db): Promise<DailyCacheResult> {
    loaderAdmin = admin;
    return cache.get();
  }

  // Display names for receipts (the profile's first name), cached per isolate for 10 minutes.
  const names = new Map<string, { name: string; at: number }>();
  async function displayName(admin: Db, userId: unknown, fallback: unknown): Promise<string> {
    const id = typeof userId === "string" ? userId : "";
    const fb = typeof fallback === "string" ? fallback : "";
    if (!id) return fb;
    const hit = names.get(id);
    if (hit && now() - hit.at < 600_000) return hit.name || fb;
    try {
      const { data } = await admin.from("profiles").select("name").eq("id", id).maybeSingle();
      const nm = typeof data?.name === "string" ? data.name : "";
      if (names.size > 2000) names.clear();
      names.set(id, { name: nm, at: now() });
      return nm || fb;
    } catch (_e) {
      return fb;
    }
  }

  // One row per (reason, key) per 10 minutes — a transient RPC failure stays countable without a busy chat flooding
  // admin_actions. perDay: a standing condition (the config RPC missing = PR-3 not applied) is one row a day.
  async function captureFailed(
    admin: Db, reason: string, details: Record<string, unknown>, dedupe?: string, perDay = false,
  ): Promise<void> {
    const b = tenMinuteBucket(now());
    await logHealthOnce(admin, "challenge_task_capture_failed", perDay ? `${reason}:${dedupe ?? "-"}` : `${reason}:${dedupe ?? "-"}:${b.key}`,
      { reason, ...details }, { source: "telegram-bot-webhook", ...(perDay ? {} : { sinceIso: b.iso }) });
  }

  async function capture(admin: Db, msg: TgMessage, opts: Record<string, unknown>): Promise<Record<string, any> | null> {
    const { data, error } = await admin.rpc("challenge_task_capture", { _msg: msg, _source: "topic", _opts: opts });
    if (error) {
      await captureFailed(admin, rpcMissing(error) ? "rpc_missing" : "rpc_error", {
        code: errCode(error), error: String(error.message ?? "").slice(0, 200),
        chat_id: msg?.chat?.id ?? null, thread_id: msg?.message_thread_id ?? null, message_id: msg?.message_id ?? null,
      }, String(msg?.chat?.id ?? ""));
      return null;
    }
    return (data && typeof data === "object") ? data as Record<string, any> : null;
  }

  // ── receipts ──────────────────────────────────────────────────────────────────────────────────────────
  async function recordReceipt(
    admin: Db, sub: number, version: number | null, chatId: number, messageId: number | null, outcome: SendResultOutcome,
  ): Promise<void> {
    // ok → sent (or pending if a newer version exists); terminal → failed + 'challenge_task_receipt_failed' (engine);
    // rate_limited / transient → NOT recorded: the row stays 'sending' and the PR-5 worker re-claims it after 5 min
    // (challenge_task_receipt_claim), honouring retry_after. health.receipts.pending counts it meanwhile.
    if (!outcome.ok && !outcome.terminal) {
      console.log("dt:receipt-retry-later", JSON.stringify({ sub, klass: outcome.klass, retry_after: outcome.retryAfterSec }));
      return;
    }
    const { error } = await admin.rpc("challenge_task_receipt_record", {
      _sub: sub, _version: version, _chat_id: chatId, _message_id: outcome.ok ? messageId : null,
      _ok: outcome.ok, _error: outcome.ok ? null : `${outcome.klass}: ${String(outcome.error ?? "").slice(0, 250)}`, _token: null,
    });
    if (error) await captureFailed(admin, "receipt_record_error", { code: errCode(error), submission_id: sub }, String(sub));
  }

  async function sendReceiptReply(
    admin: Db, chatId: number, threadId: number | null, replyTo: number, r: Rendered,
  ): Promise<{ outcome: SendResultOutcome; messageId: number | null }> {
    const { outcome, result } = await send("sendMessage", {
      chat_id: chatId,
      ...(threadId ? { message_thread_id: threadId } : {}),
      text: r.text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_parameters: { message_id: replyTo, allow_sending_without_reply: true },
      ...(r.keyboard ? { reply_markup: r.keyboard } : {}),
    }, { admin, purpose: "challenge_task_receipt", recipientId: chatId, topicMissingAction: TOPIC_MISSING });
    const mid = Number(result?.message_id);
    return { outcome, messageId: Number.isSafeInteger(mid) ? mid : null };
  }

  function editReceipt(admin: Db, chatId: number, messageId: number, r: Rendered): Promise<{ outcome: SendResultOutcome; result: any }> {
    return send("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: r.text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: r.keyboard ?? { inline_keyboard: [] },
    }, { admin, purpose: "challenge_task_receipt_edit", recipientId: chatId, topicMissingAction: TOPIC_MISSING });
  }

  async function react(admin: Db, chatId: number, messageId: number, emoji: string | null): Promise<void> {
    const e = reactionFor({ reaction: emoji });
    if (!e) return;
    // record:false — a reaction is a nicety, never a delivery the watchdogs should count as broken; its own
    // once-a-day-per-chat signal keeps a systematic failure (no reaction rights, a bad emoji) visible.
    const { outcome } = await send("setMessageReaction", {
      chat_id: chatId, message_id: messageId, reaction: [{ type: "emoji", emoji: e }], is_big: false,
    }, { admin, purpose: "challenge_task_reaction", record: false });
    if (!outcome.ok) {
      await logHealthOnce(admin, "challenge_task_reaction_failed", `${outcome.klass}:${chatId}`, {
        chat_id: chatId, message_id: messageId, klass: outcome.klass, error: outcome.error,
      }, { source: "telegram-bot-webhook" });
    }
  }

  async function receiptMeta(admin: Db, sub: number): Promise<{ welcome: boolean; chatId: number | null; messageId: number | null }> {
    try {
      const { data } = await admin.from("challenge_task_submissions")
        .select("receipt_carries_welcome, receipt_chat_id, receipt_message_id").eq("id", sub).maybeSingle();
      const c = Number(data?.receipt_chat_id);
      const m = Number(data?.receipt_message_id);
      return {
        welcome: data?.receipt_carries_welcome === true,
        chatId: data?.receipt_chat_id != null && Number.isSafeInteger(c) ? c : null,
        messageId: data?.receipt_message_id != null && Number.isSafeInteger(m) ? m : null,
      };
    } catch (_e) {
      return { welcome: false, chatId: null, messageId: null };
    }
  }

  function renderOpts(cfg: DailyConfig | null, name: string, welcome: boolean) {
    return {
      locale: GROUP_LOCALE, name, welcome, botUsername: deps.botUsername(),
      maxMoves: cfg?.maxMoves ?? 5, maxAttempts: cfg?.maxAttempts ?? 3, tagHandle: cfg?.tagHandle ?? null,
    };
  }

  async function configNow(admin: Db): Promise<DailyConfig | null> {
    const res = await snapshot(admin);
    return res.ok ? res.snap.config : null;
  }

  // ── identity (G1): an unknown poster whose message looks like work ─────────────────────────────────────
  async function identify(admin: Db, msg: TgMessage, topic: DailyTopic): Promise<{ profile: unknown; created: boolean }> {
    let created = false;
    const who = await resolveGroupPoster(admin, {
      from: msg.from, chatId: Number(msg.chat.id), threadId: Number(msg.message_thread_id), messageId: msg.message_id,
      topicKinds: ["daily_task"], source: "daily_task_post",
    }, {
      autoRegister: async () => {
        if (!topic.course_id) return null;
        const r = await deps.autoRegister(admin, msg, { id: topic.group_id, course_id: topic.course_id });
        created = r?.created === true;
        return r?.profile ?? null;
      },
    });
    return { profile: who.profile, created: created && who.via === "auto_register" };
  }

  async function act(admin: Db, msg: TgMessage, p: Record<string, any>, plan: CapturePlan, cfg: DailyConfig): Promise<void> {
    const chatId = Number(msg.chat.id);
    const threadId = Number(msg.message_thread_id) || null;
    const needName = plan.receipt !== null || plan.hint !== null;
    const name = needName ? await displayName(admin, p.user_id, msg?.from?.first_name) : "";
    if (plan.hint) {
      const h = renderHint(p as DtPayload, renderOpts(cfg, name, false));
      if (h) {
        await send("sendMessage", {
          chat_id: chatId,
          ...(threadId ? { message_thread_id: threadId } : {}),
          text: h.text, parse_mode: "HTML", disable_web_page_preview: true,
          reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true },
          ...(h.keyboard ? { reply_markup: h.keyboard } : {}),
        }, { admin, purpose: "challenge_task_hint", recipientId: chatId, topicMissingAction: TOPIC_MISSING });
      }
    }
    if (plan.receipt && plan.submissionId !== null) {
      const r = renderReceipt(p as DtPayload, renderOpts(cfg, name, plan.welcome));
      if (plan.receipt === "reply") {
        const { outcome, messageId } = await sendReceiptReply(admin, chatId, threadId, plan.replyTo ?? msg.message_id, r);
        await recordReceipt(admin, plan.submissionId, plan.receiptVersion, chatId, messageId, outcome);
      } else if (plan.receiptMessageId !== null) {
        const { outcome } = await editReceipt(admin, chatId, plan.receiptMessageId, r);
        await recordReceipt(admin, plan.submissionId, plan.receiptVersion, chatId, plan.receiptMessageId, outcome);
      }
    }
    if (plan.reactWith) await react(admin, chatId, Number(msg.message_id), plan.reactWith);
    if (plan.linkUsername) {
      // C19: the engine credited an intake student by a UNIQUE same-group username. Link the telegram_id now
      // through the gated resolver (no registrar): the next post resolves by id, and the PR-5 sweep has less to do.
      try {
        await resolveGroupPoster(admin, {
          from: msg.from, chatId, threadId: Number(msg.message_thread_id), messageId: msg.message_id,
          topicKinds: ["daily_task"], source: "daily_task_post",
        });
      } catch (e) {
        console.error("dt:username-link-threw", String(e).slice(0, 200));
      }
    }
  }

  return {
    snapshot,

    /**
     * A group message. handled:false = not a daily topic, inactive, unavailable, or the engine did not take it:
     * the caller runs today's handler (handleGroupTopicMessage) exactly as before.
     */
    async onGroupMessage(admin: Db, msg: TgMessage): Promise<{ handled: boolean; outcome?: string }> {
      const chatType = msg?.chat?.type;
      if ((chatType !== "supergroup" && chatType !== "group") || msg?.message_thread_id == null) return { handled: false };
      const route = routeDaily(await snapshot(admin), msg.chat.id, msg.message_thread_id);
      if (route.kind === "not_daily") return { handled: false };
      if (route.kind === "unavailable") {
        await captureFailed(admin, "dispatch_unavailable", { error: route.error, chat_id: msg.chat.id }, "topics");
        return { handled: false };
      }
      if (route.kind === "inactive") {
        if (route.reason !== "disabled") {
          await captureFailed(admin, "config_unavailable", { error: route.reason, chat_id: msg.chat.id }, "config", true);
        }
        return { handled: false };
      }
      let p = await capture(admin, msg, {});
      if (!p) return { handled: false };
      if (p.status === "error") {
        // The engine refused the message itself (bad_message / bad_date): today's handler runs, and it is counted.
        await captureFailed(admin, "engine_error", {
          engine_reason: p.reason ?? null, chat_id: msg.chat.id, message_id: msg.message_id ?? null,
        }, String(msg.chat.id));
        return { handled: false, outcome: "error" };
      }
      let plan = planCapture(p);
      if (plan.needsIdentity && route.config.autoRegister) {
        const who = await identify(admin, msg, route.topic);
        if (who.profile) {
          const p2 = await capture(admin, msg, { welcome: who.created });
          if (p2) {
            p = p2;
            plan = planCapture(p2, { identityTried: true });
          }
        }
      }
      if (plan.fallThrough) return { handled: false, outcome: String(p.outcome ?? "") };
      await act(admin, msg, p, plan, route.config);
      console.log("dt:captured", JSON.stringify({
        chat: msg.chat.id, thread: msg.message_thread_id, msg: msg.message_id, outcome: p.outcome,
        sub: plan.submissionId, receipt: plan.receipt, hint: plan.hint,
      }));
      return { handled: true, outcome: String(p.outcome ?? "") };
    },

    /** edited_message (C17): the engine re-judges a captured item; the bot refreshes its receipt right away. */
    async onEdited(admin: Db, em: TgMessage): Promise<void> {
      const chatType = em?.chat?.type;
      if ((chatType !== "supergroup" && chatType !== "group") || em?.message_thread_id == null) return;
      const route = routeDaily(await snapshot(admin), em.chat.id, em.message_thread_id);
      if (route.kind !== "capture") return;
      const { data, error } = await admin.rpc("challenge_task_item_edited", { _msg: em });
      if (error) {
        await captureFailed(admin, rpcMissing(error) ? "edit_rpc_missing" : "edit_rpc_error", {
          code: errCode(error), chat_id: em.chat.id, message_id: em.message_id,
        }, String(em.chat.id));
        return;
      }
      const p = data as Record<string, any> | null;
      const sub = Number(p?.submission?.id);
      const rid = Number(p?.submission?.receipt_message_id);
      if (p?.outcome !== "edited" || !Number.isSafeInteger(sub) || !Number.isSafeInteger(rid) || p?.submission?.receipt_message_id == null) return;
      const meta = await receiptMeta(admin, sub);
      const chatId = meta.chatId ?? Number(em.chat.id);
      const name = await displayName(admin, p.user_id, em?.from?.first_name);
      const r = renderReceipt(p as DtPayload, renderOpts(route.config, name, meta.welcome));
      const { outcome } = await editReceipt(admin, chatId, rid, r);
      await recordReceipt(admin, sub, Number(p.submission.receipt_version) || null, chatId, rid, outcome);
    },

    /** dt:m|x|r callbacks (§7.4/7.5). The owner lock is SQL-side (challenge_task_tg_actor); admins are logged. */
    async onCallback(admin: Db, cq: Record<string, any>): Promise<void> {
      const cb = parseDtCallback(cq?.data);
      if (!cb) {
        await deps.answerCallback(cq.id);
        return;
      }
      const tg = Number(cq?.from?.id);
      const call = cb.op === "m"
        ? admin.rpc("challenge_task_move_by_tg", { _tg_user: tg, _sub: cb.sub, _target_task: cb.task })
        : cb.op === "x"
        ? admin.rpc("challenge_task_withdraw_by_tg", { _tg_user: tg, _sub: cb.sub })
        : admin.rpc("challenge_task_restore_by_tg", { _tg_user: tg, _sub: cb.sub });
      const { data, error } = await call;
      if (error) {
        await captureFailed(admin, rpcMissing(error) ? "callback_rpc_missing" : "callback_rpc_error", {
          code: errCode(error), op: cb.op, submission_id: cb.sub,
        }, cb.op);
        await deps.answerCallback(cq.id, correctionToast(cb.op, null, GROUP_LOCALE));
        return;
      }
      const res = (data ?? null) as Record<string, any> | null;
      await deps.answerCallback(cq.id, correctionToast(cb.op, res as { ok?: boolean; reason?: string } | null, GROUP_LOCALE));
      if (!res?.ok) return;

      const chatId = Number(cq?.message?.chat?.id);
      const mid = Number(cq?.message?.message_id);
      const target = res.submission as Record<string, any> | undefined;
      if (!Number.isSafeInteger(chatId) || !Number.isSafeInteger(mid) || !target) return;
      const cfg = await configNow(admin);
      const name = await displayName(admin, res.user_id, null);
      const targetId = Number(target.id);
      if (targetId === cb.sub) {
        // The tapped message IS this submission's receipt: show the new state and record it (it also repairs a
        // receipt whose message id was never recorded).
        const meta = await receiptMeta(admin, cb.sub);
        const { outcome } = await editReceipt(admin, chatId, mid, renderReceipt(res as DtPayload, renderOpts(cfg, name, meta.welcome)));
        await recordReceipt(admin, cb.sub, Number(target.receipt_version) || null, chatId, mid, outcome);
        return;
      }
      // MERGED into the student's live submission on the target task: the tapped receipt now reads "merged" (its
      // own version is not in this payload, so it stays for the worker, which renders it identically), and the
      // target's own receipt — if it has one — shows the merged state.
      await editReceipt(admin, chatId, mid, renderMergedNote(cb.sub, GROUP_LOCALE));
      const tm = await receiptMeta(admin, targetId);
      if (tm.messageId !== null && tm.chatId !== null) {
        const { outcome } = await editReceipt(admin, tm.chatId, tm.messageId, renderReceipt(res as DtPayload, renderOpts(cfg, name, tm.welcome)));
        await recordReceipt(admin, targetId, Number(target.receipt_version) || null, tm.chatId, tm.messageId, outcome);
      }
    },

    /** /start dt_<id> (task card, G14) and /start ig (where to set the Instagram handle). true = answered. */
    async onStart(admin: Db, msg: TgMessage, arg: string, locale: Locale, profile: { id?: string } | null): Promise<boolean> {
      const a = parseDailyStartArg(arg);
      if (!a) return false;
      const chatId = Number(msg?.chat?.id);
      const dm = async (r: Rendered, purpose: string) => {
        await send("sendMessage", {
          chat_id: chatId, text: r.text, parse_mode: "HTML", disable_web_page_preview: true,
          ...(r.keyboard ? { reply_markup: r.keyboard } : {}),
        }, { admin, purpose, recipientId: chatId });
      };
      if (a.kind === "task") {
        const { data, error } = await admin.rpc("challenge_task_card", { _task_id: a.taskId, _tg_user: Number(msg?.from?.id) });
        if (error) {
          await captureFailed(admin, rpcMissing(error) ? "card_rpc_missing" : "card_rpc_error", { code: errCode(error), task_id: a.taskId }, "card");
          await dm(renderUnavailable(locale), "challenge_task_card");
          return true;
        }
        for (const part of renderCard(data, locale)) await dm(part, "challenge_task_card");
        return true;
      }
      let handle: string | null = null;
      let url: string | null = null;
      if (profile?.id) {
        try {
          const { data } = await admin.from("profiles").select("instagram_username").eq("id", profile.id).maybeSingle();
          handle = typeof data?.instagram_username === "string" ? data.instagram_username : null;
        } catch (_e) { /* the card still says where to set it */ }
        try {
          url = await deps.magicLink(admin, profile.id, "/settings");
        } catch (_e) { url = null; }
      }
      await dm(renderIgStart(handle, url, locale), "challenge_task_ig_start");
      return true;
    },

    /** my_chat_member for a chat that holds a daily topic → 'challenge_bot_status_changed' (health bot_status, G15). */
    async onMyChatMember(admin: Db, mcm: Record<string, any>): Promise<void> {
      const d = botStatusDetails(mcm);
      if (!d) return;
      // A direct read, not the snapshot: bot-status rows must exist before go-live (liveness baseline) and must not
      // depend on the PR-3 config RPC. Any group with a daily topic in this chat is a scope chat (PR-1).
      const { data, error } = await admin.from("groups").select("id")
        .eq("daily_task_chat_id", d.chat).not("daily_task_topic_id", "is", null).limit(1);
      if (error) {
        await captureFailed(admin, "bot_status_lookup_error", { code: errCode(error), chat_id: d.chat }, String(d.chat));
        return;
      }
      if (!Array.isArray(data) || data.length === 0) return;
      await logHealth(admin, "challenge_bot_status_changed", { ...d, group_id: data[0].id }, { source: "telegram-bot-webhook" });
    },

    /** U1 (G14): the daily-topic link for a challenge student's DM-media hint, or null (inactive / not in scope). */
    async dailyTopicUrlFor(admin: Db, groupId: string | null | undefined): Promise<string | null> {
      if (!groupId) return null;
      const res = await snapshot(admin);
      if (!res.ok || !res.snap.config?.active || !res.snap.groups.has(groupId)) return null;
      try {
        const { data } = await admin.from("groups").select("daily_task_topic_url").eq("id", groupId).maybeSingle();
        const u = data?.daily_task_topic_url;
        return isTelegramUrl(u) ? u.trim() : null;
      } catch (_e) {
        return null;
      }
    },

    /**
     * G14 detector: a picker AUTO-TAG (the student ignored the picker) in a challenge-scope group's homework topic
     * may be daily-task work posted in the wrong topic. health.misplaced_homework_autotag_24h counts these rows;
     * the watchdog alarms at >= 5 a day. Only while challenge_tasks is active.
     */
    async noteMisplacedHomework(admin: Db, pending: Record<string, any>, result: string): Promise<void> {
      const gid = typeof pending?.group_id === "string" ? pending.group_id : "";
      if (!gid) return;
      const res = await snapshot(admin);
      if (!res.ok || !res.snap.config?.active || !res.snap.groups.has(gid)) return;
      // Only meaningful while a daily task is actually OPEN in this group: a task post went out here today
      // (Tashkent). Without that there is nothing to misplace, and every ignored picker is plain homework.
      // Found 2026-10-03: before the first task day (Mon 10-05) the module ladder opened module 1, 162
      // students started handing in real module-1 homework, many ignored the picker, and each auto-tag
      // was counted as "misplaced daily work" — 22 rows and a false 'misplaced_homework' alarm, every
      // one of them a correct homework submission. A failed read is not counted (no false alarm).
      const { count, error: postsErr } = await admin.from("challenge_task_posts")
        .select("task_id", { count: "exact", head: true })
        .eq("group_id", gid).eq("kind", "task").in("state", ["sent", "sent_via_sql"])
        .gte("sent_at", tashkentMidnightUtcIso());
      if (postsErr || !count) return;
      await logHealth(admin, "challenge_task_misplaced_homework", {
        pending_id: pending.id ?? null, group_id: gid, chat_id: Number(pending.telegram_chat_id) || null,
        thread_id: Number(pending.telegram_thread_id) || null, message_id: Number(pending.first_message_id) || null,
        result,
      }, { source: "telegram-bot-webhook", targetUserId: typeof pending.user_id === "string" ? pending.user_id : null });
    },
  };
}

export type DailyTasks = ReturnType<typeof createDailyTasks>;
