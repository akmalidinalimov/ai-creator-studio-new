// challenge-tasks-worker — ONE run: posts -> receipts -> DMs -> identity sweep -> heartbeat (Daily Tasks PR-5, build
// spec v2 §10.2). pg_cron's challenge_tasks_tick() (every minute) calls the function ONLY when
// challenge_tasks_worker_due() says a claim would lease something; while the feature is paused it is never called.
// challenge_task_identity_sweep_request() (PR-8's pre-step) calls it with mode 'identity_sweep' and a window.
//
//   posts     challenge_task_post_claim / _record      (PR-3) the 09:00 task post (text rendered by SQL, the one the
//                                                      approve guard measured) and the 20:00 summary, + the dt_ button
//   receipts  challenge_task_receipt_claim / _record   (PR-3) receipts the bot did not send (reconciler captures, AI
//                                                      results, a queued welcome, a crashed bot): renderReceipt from
//                                                      _shared (byte-identical to the bot's), paced per chat
//   DMs       challenge_task_outbox_claim / _record    (PR-3) morning / evening / result / backfill_summary
//   identity  challenge_task_identity_candidates       (this PR) -> resolveGroupPoster (_shared, PR-0b): the gated
//                                                      username link, then the registrar (registrar.ts)
//   heartbeat admin_actions 'challenge_task_worker_run' (every run that did or failed something) and
//             'challenge_task_identity_sweep' {linked, registered, unresolved, attempted}
//
// Telegram limits (G7): every send goes through sendTelegramWithResult; 'message is not modified' is a success;
// rate_limited (429) blocks THAT chat for retry_after and leaves the lease to expire (the claim re-offers it after 5
// minutes) — never a failure row; topic_missing is terminal and recorded as challenge_task_topic_missing. Group sends
// keep >= 3.1 s between two messages into one chat (~20 / minute); DMs >= 40 ms apart.
import { logHealth, logHealthOnce } from "../_shared/edge.ts";
import { resolveGroupPoster } from "../_shared/group-poster-identity.ts";
import { type DtPayload, type Locale, type Rendered, renderReceipt } from "../_shared/daily-task-render.ts";
import { redactSecrets } from "../_shared/redact.ts";
import type { SendResultOutcome } from "../_shared/telegram-send.ts";
import {
  postKeyboard, renderBackfillDm, renderEveningDm, renderMorningDm, renderResultDm, renderSummary, toLocale,
} from "./render.ts";
import { registerDailyTaskPoster, type RegisterInput, type SendFn } from "./registrar.ts";

// A service-role Supabase client (typed loosely, like the rest of the codebase).
// deno-lint-ignore no-explicit-any
type Db = any;
// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

export const BUDGET_MS = 45_000;       // the tick's ops_net_post waits 60 s
export const CHAT_GAP_MS = 3_100;      // >= 3.1 s between two sends into one group chat (~20 / minute)
export const DM_GAP_MS = 40;           // <= 25 DMs a second (the bot-wide limit is ~30)
export const POST_LIMIT = 20;          // posts: ONE claim per run (a failed post is retried by the NEXT run, never in a loop)
export const RECEIPT_BATCH = 10;
export const DM_BATCH = 20;
export const SWEEP_REGULAR_LIMIT = 20; // spec §10.2: up to 20 senders per run
export const SWEEP_WINDOW_BATCH = 10;
export const RECEIPT_GIVE_UP_MIN = 60; // a receipt failing transiently for this long is recorded failed (DB-visible)
const TOPIC_MISSING = "challenge_task_topic_missing";

export interface WorkerEnv {
  botToken: string;
  botUsername: string;
  supabaseUrl: string;
  serviceKey: string;
}

export interface WorkerIO {
  admin: Db;
  send: SendFn;
  fetchFn: typeof fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Injected in tests; default: the shared resolver and this function's registrar. */
  resolvePoster?: typeof resolveGroupPoster;
  register?: (inp: RegisterInput) => Promise<Record<string, unknown> | null>;
}

export interface WorkerRequest {
  mode?: string;
  since?: string | null;
  until?: string | null;
  due?: unknown;
}

export interface RunResult {
  httpStatus: number;
  body: Record<string, unknown>;
}

function errCode(e: { code?: string; message?: string } | null | undefined): string {
  return `${String(e?.code ?? "error").slice(0, 20)}: ${String(e?.message ?? "").slice(0, 160)}`;
}

function isIso(s: unknown): s is string {
  return typeof s === "string" && s.length <= 40 && Number.isFinite(Date.parse(s));
}

/** Items interleaved by key (round robin), so one busy chat never starves the others. Stable within a key. */
export function roundRobin<T>(items: T[], key: (t: T) => string): T[] {
  const groups = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    const g = groups.get(k);
    if (g) g.push(it);
    else groups.set(k, [it]);
  }
  const out: T[] = [];
  const lists = [...groups.values()];
  for (let i = 0; out.length < items.length; i++) {
    for (const l of lists) if (i < l.length) out.push(l[i]);
  }
  return out;
}

/** Per-key pacing + retry_after blocks, on the injected clock (tests run it instantly). */
export function createPacer(io: Pick<WorkerIO, "now" | "sleep">, gapMs: number) {
  const last = new Map<string, number>();
  const blockedUntil = new Map<string, number>();
  return {
    blocked(key: string): boolean {
      const b = blockedUntil.get(key);
      return b !== undefined && b > io.now();
    },
    block(key: string, retryAfterSec: number | null | undefined) {
      blockedUntil.set(key, io.now() + Math.max(1, Math.min(Number(retryAfterSec) || 30, 3600)) * 1000);
    },
    /** Waits for this key's next slot. false = the slot is past the budget (the caller leaves the work for later). */
    async wait(key: string, budgetLeft: () => number): Promise<boolean> {
      const prev = last.get(key);
      const w = prev === undefined ? 0 : prev + gapMs - io.now();
      if (w > 0) {
        if (w > budgetLeft() - 2_000) return false;
        await io.sleep(w);
      }
      last.set(key, io.now());
      return true;
    },
  };
}

type Tally = Record<string, number>;
const inc = (t: Tally, k: string, n = 1) => { t[k] = (t[k] ?? 0) + n; };

export async function runWorker(env: WorkerEnv, io: WorkerIO, req: WorkerRequest | null): Promise<RunResult> {
  const admin = io.admin;
  const t0 = io.now();
  const left = () => BUDGET_MS - (io.now() - t0);
  const mode = req?.mode === "identity_sweep" ? "identity_sweep" : "run";
  const errors: string[] = [];
  const posts: Tally = {};
  const receipts: Tally = {};
  const dms: Tally = {};
  const identity: Tally = {};
  const resolve = io.resolvePoster ?? resolveGroupPoster;
  const register = io.register ?? ((inp: RegisterInput) =>
    registerDailyTaskPoster({ admin, send: io.send, fetchFn: io.fetchFn, supabaseUrl: env.supabaseUrl, serviceKey: env.serviceKey }, inp));

  const heartbeat = async (status: string, extra: Record<string, unknown> = {}) => {
    const did = [posts, receipts, dms, identity].some((t) => Object.keys(t).length > 0);
    const body = {
      status, mode, posts, receipts, dms, identity, errors: errors.slice(0, 20), elapsed_ms: io.now() - t0,
      due: req?.due ?? null, ...extra,
    };
    if (did || errors.length > 0 || status !== "ok" || mode === "identity_sweep") {
      await logHealth(admin, "challenge_task_worker_run", body, { source: "challenge-tasks-worker" });
    }
    return body;
  };

  // ── config (one read per run) ────────────────────────────────────────────────────────────────────────
  const { data: cfg, error: cfgErr } = await admin.rpc("challenge_tasks_config");
  if (cfgErr || !cfg || typeof cfg !== "object") {
    errors.push(`config: ${errCode(cfgErr)}`);
    return { httpStatus: 500, body: await heartbeat("crashed") };
  }
  const maxMoves = Number(cfg.max_moves_per_submission) || 5;
  const maxAttempts = Number(cfg.max_attempts_per_task) || 3;
  const tagHandle = typeof cfg?.ig?.tag_handle === "string" ? cfg.ig.tag_handle : null;

  // ── identity sweep (shared by both modes) ────────────────────────────────────────────────────────────
  const sweep = async (window: { since: string; until: string | null } | null) => {
    const exclude: number[] = [];
    const attempted: number[] = [];
    const unresolved: Array<{ tg_user_id: number; reason: string }> = [];
    const maxBatches = window ? 100 : 1;
    for (let b = 0; b < maxBatches && left() > 10_000; b++) {
      const { data, error } = await admin.rpc("challenge_task_identity_candidates", {
        _since: window?.since ?? null, _until: window?.until ?? null, _exclude: exclude,
        _limit: window ? SWEEP_WINDOW_BATCH : SWEEP_REGULAR_LIMIT,
      });
      if (error) {
        errors.push(`identity_candidates: ${errCode(error)}`);
        break;
      }
      const cands = Array.isArray(data?.candidates) ? data.candidates as Row[] : [];
      if (!cands.length) break;
      for (const c of cands) {
        const tg = Number(c.tg_user_id);
        if (!Number.isSafeInteger(tg) || tg <= 0) continue;
        exclude.push(tg);
        if (left() < 6_000) break;
        attempted.push(tg);
        const fromRaw = (c.from && typeof c.from === "object") ? c.from as Row : {};
        const from = { ...fromRaw, id: tg, is_bot: fromRaw.is_bot === true };
        const chatId = Number(c.chat_id);
        const threadId = Number(c.thread_id);
        const messageId = Number(c.message_id) || null;
        const canRegister = c.kind === "unknown" && cfg.auto_register !== false && typeof c.group_id === "string" &&
          typeof c.course_id === "string";
        try {
          const res = await resolve(admin, {
            from, chatId, threadId, messageId, topicKinds: ["daily_task"], source: "daily_task_post",
          }, canRegister
            ? {
              autoRegister: () => register({
                from: from as RegisterInput["from"], chatId, threadId: Number.isFinite(threadId) ? threadId : null, messageId,
                groupId: String(c.group_id), courseId: String(c.course_id),
              }),
            }
            : {});
          if (res.via === "username_link") inc(identity, "linked");
          else if (res.via === "auto_register") inc(identity, "registered");
          else if (res.via === "telegram_id") inc(identity, "already");
          else {
            inc(identity, "unresolved");
            unresolved.push({ tg_user_id: tg, reason: String(res.reason) });
          }
        } catch (e) {
          inc(identity, "unresolved");
          unresolved.push({ tg_user_id: tg, reason: "threw" });
          errors.push(`identity: ${redactSecrets(e).slice(0, 160)}`);
        }
      }
    }
    if (attempted.length > 0) {
      await logHealth(admin, "challenge_task_identity_sweep", {
        mode: window ? "window" : "regular", since: window?.since ?? null, until: window?.until ?? null,
        linked: identity.linked ?? 0, registered: identity.registered ?? 0, already: identity.already ?? 0,
        unresolved: identity.unresolved ?? 0, unresolved_senders: unresolved.slice(0, 100), attempted,
      }, { source: "challenge-tasks-worker" });
    }
  };

  if (mode === "identity_sweep") {
    if (!isIso(req?.since) || (req?.until != null && !isIso(req.until))) {
      errors.push("identity_sweep: bad since / until");
      return { httpStatus: 400, body: await heartbeat("bad_request") };
    }
    await sweep({ since: req!.since as string, until: (req?.until as string | null | undefined) ?? null });
    return { httpStatus: 200, body: await heartbeat(errors.length ? "partial" : "ok") };
  }

  if (cfg.active !== true) {
    // Never kicked while paused; a manual call changes nothing.
    return { httpStatus: 200, body: await heartbeat("inactive") };
  }
  if (!env.botToken) {
    // Nothing is claimed without a way to send (a claim would burn an attempt).
    await logHealthOnce(admin, "challenge_task_worker_no_bot_token", "no_bot_token", {}, { source: "challenge-tasks-worker" });
    return { httpStatus: 200, body: { status: "no_bot_token" } };
  }

  const chatPacer = createPacer(io, CHAT_GAP_MS);
  const dmPacer = createPacer(io, DM_GAP_MS);

  // topics: group -> (chat, thread), so a receipt reply lands in the daily topic even if its target was deleted
  const topicByGroup = new Map<string, { chat_id: number; thread_id: number }>();
  {
    const { data, error } = await admin.rpc("challenge_task_topics");
    if (error) errors.push(`topics: ${errCode(error)}`);
    for (const t of (Array.isArray(data) ? data : []) as Row[]) {
      topicByGroup.set(String(t.group_id), { chat_id: Number(t.chat_id), thread_id: Number(t.thread_id) });
    }
  }

  const profiles = new Map<string, { name: string; locale: Locale }>();
  const loadProfiles = async (ids: unknown[]) => {
    const want = [...new Set(ids.filter((x): x is string => typeof x === "string" && !profiles.has(x)))];
    if (!want.length) return;
    const { data, error } = await admin.from("profiles").select("id, name, preferred_locale, preferred_language").in("id", want);
    if (error) errors.push(`profiles: ${errCode(error)}`);
    for (const p of (Array.isArray(data) ? data : []) as Row[]) {
      profiles.set(String(p.id), { name: typeof p.name === "string" ? p.name : "", locale: toLocale(p.preferred_locale ?? p.preferred_language) });
    }
  };

  // ── 1. posts ─────────────────────────────────────────────────────────────────────────────────────────
  const postRecord = async (it: Row, messageId: number | null, error: string | null) => {
    const { data, error: e } = await admin.rpc("challenge_task_post_record", {
      _task_id: Number(it.task_id), _group_id: String(it.group_id), _kind: String(it.kind), _token: String(it.token),
      _message_id: messageId, _error: error,
    });
    if (e) errors.push(`post_record: ${errCode(e)}`);
    else if (data?.ok !== true) inc(posts, "stale");
  };
  if (cfg.post !== false) {
    const { data, error } = await admin.rpc("challenge_task_post_claim", { _limit: POST_LIMIT });
    if (error) errors.push(`post_claim: ${errCode(error)}`);
    const items = data?.ok === true && Array.isArray(data.items) ? data.items as Row[] : [];
    for (const it of roundRobin(items, (x) => String(x.chat_id))) {
      const chat = Number(it.chat_id);
      const key = String(chat);
      if (chatPacer.blocked(key) || !(await chatPacer.wait(key, left))) {
        inc(posts, "deferred"); // the lease expires in 5 minutes and the next run takes it
        continue;
      }
      const text = it.kind === "task" ? String(it.text ?? "") : renderSummary(it.summary);
      if (!text.trim()) {
        await postRecord(it, null, "empty_text");
        inc(posts, "failed");
        continue;
      }
      const kb = postKeyboard(Number(it.task_id), env.botUsername, it.miniapp_link);
      const { outcome, result } = await io.send("sendMessage", {
        chat_id: chat,
        ...(Number(it.thread_id) > 1 ? { message_thread_id: Number(it.thread_id) } : {}),
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        ...(kb ? { reply_markup: kb } : {}),
      }, { admin, purpose: `challenge_task_post_${it.kind}`, recipientId: chat, topicMissingAction: TOPIC_MISSING });
      const mid = Number(result?.message_id);
      if (outcome.ok && Number.isSafeInteger(mid) && mid > 0) {
        await postRecord(it, mid, null);
        inc(posts, "sent");
      } else if (outcome.klass === "rate_limited") {
        chatPacer.block(key, outcome.retryAfterSec);
        inc(posts, "deferred");
      } else {
        await postRecord(it, null, `${outcome.klass}: ${outcome.error ?? "no message id"}`.slice(0, 300));
        inc(posts, "failed");
      }
    }
  }

  // ── 2. receipts ──────────────────────────────────────────────────────────────────────────────────────
  const receiptRecord = async (sub: number, version: number | null, chat: number | null, mid: number | null, ok: boolean,
                               error: string | null, token: string | null) => {
    const { error: e } = await admin.rpc("challenge_task_receipt_record", {
      _sub: sub, _version: version, _chat_id: chat, _message_id: mid, _ok: ok, _error: error, _token: token,
    });
    if (e) errors.push(`receipt_record: ${errCode(e)}`);
  };
  const receiptTooOld = async (sub: number): Promise<boolean> => {
    const { data } = await admin.from("challenge_task_submissions").select("updated_at").eq("id", sub).maybeSingle();
    const t = Date.parse(String(data?.updated_at ?? ""));
    return Number.isFinite(t) && io.now() - t > RECEIPT_GIVE_UP_MIN * 60_000;
  };
  const threadFor = async (it: Row, chat: number, replyTo: number | null): Promise<number | null> => {
    const t = topicByGroup.get(String(it.group_id ?? ""));
    if (t && t.chat_id === chat && t.thread_id > 1) return t.thread_id;
    if (replyTo) {
      const { data } = await admin.from("challenge_task_messages").select("thread_id").eq("chat_id", chat).eq("message_id", replyTo).maybeSingle();
      const th = Number(data?.thread_id);
      if (Number.isSafeInteger(th) && th > 1) return th;
    }
    return null;
  };
  const sendReceipt = async (it: Row): Promise<"sent" | "failed" | "deferred" | "skipped"> => {
    const r = (it.receipt ?? {}) as Row;
    const sub = Number(it.submission?.id);
    const version = Number(r.version) || null;
    const token = typeof it.token === "string" ? it.token : null;
    if (!Number.isSafeInteger(sub) || sub <= 0) return "skipped";
    const chat = Number(r.chat_id);
    if (!Number.isSafeInteger(chat) || chat === 0 || r.chat_id == null) {
      await receiptRecord(sub, version, null, null, false, "no_chat", token);
      return "failed";
    }
    const key = String(chat);
    if (chatPacer.blocked(key) || !(await chatPacer.wait(key, left))) return "deferred";
    const who = profiles.get(String(it.user_id ?? ""));
    const rendered: Rendered = renderReceipt(it as DtPayload, {
      locale: "uz", name: who?.name ?? "", welcome: r.carries_welcome === true, botUsername: env.botUsername,
      maxMoves, maxAttempts, tagHandle,
    });
    const replyTo = r.reply_to_message_id != null && Number.isSafeInteger(Number(r.reply_to_message_id)) ? Number(r.reply_to_message_id) : null;
    const reply = async () => {
      const thread = await threadFor(it, chat, replyTo);
      const { outcome, result } = await io.send("sendMessage", {
        chat_id: chat,
        ...(thread ? { message_thread_id: thread } : {}),
        text: rendered.text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
        ...(rendered.keyboard ? { reply_markup: rendered.keyboard } : {}),
      }, { admin, purpose: "challenge_task_receipt", recipientId: chat, topicMissingAction: TOPIC_MISSING });
      const mid = Number(result?.message_id);
      return { outcome, mid: Number.isSafeInteger(mid) && mid > 0 ? mid : null };
    };
    let res: { outcome: SendResultOutcome; mid: number | null };
    const editId = r.receipt_message_id != null ? Number(r.receipt_message_id) : NaN;
    if (r.mode === "edit" && Number.isSafeInteger(editId) && editId > 0) {
      const { outcome } = await io.send("editMessageText", {
        chat_id: chat,
        message_id: editId,
        text: rendered.text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        reply_markup: rendered.keyboard ?? { inline_keyboard: [] },
      }, { admin, purpose: "challenge_task_receipt_edit", recipientId: chat, topicMissingAction: TOPIC_MISSING });
      res = { outcome, mid: editId };
      if (outcome.klass === "message_gone") {
        // the receipt was deleted (or is too old to edit): a fresh one under the student's work
        inc(receipts, "reposted");
        res = await reply();
      }
    } else {
      res = await reply();
    }
    const o = res.outcome;
    if (o.ok) {
      await receiptRecord(sub, version, chat, res.mid, true, null, token);
      return "sent";
    }
    if (o.klass === "rate_limited") {
      chatPacer.block(key, o.retryAfterSec);
      return "deferred";
    }
    if (o.terminal || (await receiptTooOld(sub))) {
      await receiptRecord(sub, version, chat, null, false, `${o.klass}: ${o.error ?? ""}`.slice(0, 300), token);
      return "failed";
    }
    return "deferred"; // transient: the lease expires in 5 minutes and a later run retries
  };
  if (cfg.receipts !== false) {
    while (left() > 8_000) {
      const { data, error } = await admin.rpc("challenge_task_receipt_claim", { _limit: RECEIPT_BATCH });
      if (error) {
        errors.push(`receipt_claim: ${errCode(error)}`);
        break;
      }
      const items = data?.ok === true && Array.isArray(data.items) ? data.items as Row[] : [];
      if (!items.length) break;
      await loadProfiles(items.map((x) => x.user_id));
      let sent = 0;
      for (const it of roundRobin(items, (x) => String(x?.receipt?.chat_id ?? ""))) {
        const r = await sendReceipt(it);
        inc(receipts, r);
        if (r === "sent") sent++;
      }
      if (sent === 0) break; // every chat blocked / failing: stop claiming (the rest waits for the next run)
    }
  }

  // ── 3. DMs ───────────────────────────────────────────────────────────────────────────────────────────
  const outboxRecord = async (it: Row, ok: boolean, error: string | null, terminal: boolean) => {
    const { error: e } = await admin.rpc("challenge_task_outbox_record", {
      _id: Number(it.id), _token: String(it.token), _ok: ok, _error: error, _terminal: terminal,
    });
    if (e) errors.push(`outbox_record: ${errCode(e)}`);
  };
  const renderDm = async (it: Row, locale: Locale, name: string): Promise<Rendered | null> => {
    const p = (it.payload && typeof it.payload === "object") ? it.payload as Row : {};
    switch (it.kind) {
      case "morning":
        return renderMorningDm(p, { locale, name, botUsername: env.botUsername });
      case "evening":
        return renderEveningDm(p, { locale, name, botUsername: env.botUsername });
      case "backfill_summary":
        return renderBackfillDm(p, { locale, name });
      case "result": {
        const sid = Number(it.submission_id);
        if (!Number.isSafeInteger(sid) || sid <= 0) return null;
        const { data: s, error: se } = await admin.from("challenge_task_submissions")
          .select("status, reason, points_awarded, late_days, task_id, group_id").eq("id", sid).maybeSingle();
        if (se) throw new Error(`submission read: ${errCode(se)}`); // a read failure is retried, never a skipped DM
        if (!s) return null;
        const { data: t, error: te } = await admin.from("challenge_tasks").select("id, title, task_date").eq("id", Number(s.task_id)).maybeSingle();
        if (te) throw new Error(`task read: ${errCode(te)}`);
        let topicUrl: string | null = null;
        if (typeof s.group_id === "string") {
          const { data: g } = await admin.from("groups").select("daily_task_topic_url").eq("id", s.group_id).maybeSingle();
          topicUrl = typeof g?.daily_task_topic_url === "string" ? g.daily_task_topic_url : null;
        }
        return renderResultDm({
          status: String(s.status), reason: s.reason ?? null, points_awarded: s.points_awarded, late_days: s.late_days,
          task_id: Number(s.task_id), task_date: t?.task_date ?? "", title: t?.title ?? "", topic_url: topicUrl, tag_handle: tagHandle,
        }, { locale, botUsername: env.botUsername });
      }
      default:
        return null;
    }
  };
  if (cfg.dm !== false) {
    let stop = false;
    while (!stop && left() > 6_000) {
      const { data, error } = await admin.rpc("challenge_task_outbox_claim", { _limit: DM_BATCH });
      if (error) {
        errors.push(`outbox_claim: ${errCode(error)}`);
        break;
      }
      const items = data?.ok === true && Array.isArray(data.items) ? data.items as Row[] : [];
      if (!items.length) break;
      await loadProfiles(items.map((x) => x.user_id));
      for (const it of items) {
        if (stop || left() < 3_000) {
          inc(dms, "deferred"); // the lease expires in 5 minutes
          continue;
        }
        const tg = Number(it.telegram_id);
        if (!Number.isSafeInteger(tg) || tg <= 0) {
          await outboxRecord(it, false, "no_telegram_id", true);
          inc(dms, "skipped");
          continue;
        }
        const exp = Date.parse(String(it.payload?.expires_at ?? ""));
        if (Number.isFinite(exp) && io.now() > exp) {
          // a morning / evening DM that could not go out in its window is dropped, never sent late (DB-visible)
          await outboxRecord(it, false, "expired", true);
          inc(dms, "expired");
          continue;
        }
        const who = profiles.get(String(it.user_id)) ?? { name: "", locale: "uz" as Locale };
        let r: Rendered | null = null;
        try {
          r = await renderDm(it, who.locale, who.name);
        } catch (e) {
          // a transient read failure: failed (re-queued in 10 minutes by outbox_record), not skipped
          errors.push(`dm_render: ${redactSecrets(e).slice(0, 160)}`);
          await outboxRecord(it, false, `render_error: ${redactSecrets(e).slice(0, 200)}`, false);
          inc(dms, "failed");
          continue;
        }
        if (!r || !r.text.trim()) {
          await outboxRecord(it, false, "nothing_to_send", true);
          inc(dms, "skipped");
          continue;
        }
        if (!(await dmPacer.wait("dm", left))) {
          inc(dms, "deferred");
          continue;
        }
        const { outcome } = await io.send("sendMessage", {
          chat_id: tg, text: r.text, parse_mode: "HTML", disable_web_page_preview: true,
          ...(r.keyboard ? { reply_markup: r.keyboard } : {}),
        }, { admin, purpose: `challenge_task_dm_${it.kind}`, recipientId: tg });
        if (outcome.ok) {
          await outboxRecord(it, true, null, false);
          inc(dms, "sent");
        } else if (outcome.klass === "rate_limited") {
          await outboxRecord(it, false, `rate_limited: retry_after ${outcome.retryAfterSec ?? "?"}`, false);
          inc(dms, "deferred");
          stop = true; // flood control is bot-wide: no more DMs this run
        } else {
          await outboxRecord(it, false, `${outcome.klass}: ${outcome.error ?? ""}`.slice(0, 300), outcome.terminal);
          inc(dms, outcome.terminal ? "skipped" : "failed");
        }
      }
    }
  }

  // ── 4. identity sweep (spec §10.2 / G1): up to 20 pending senders, each through resolveGroupPoster ────────
  if (left() > 10_000) await sweep(null);

  const status = errors.length ? "partial" : "ok";
  return { httpStatus: 200, body: await heartbeat(status) };
}
