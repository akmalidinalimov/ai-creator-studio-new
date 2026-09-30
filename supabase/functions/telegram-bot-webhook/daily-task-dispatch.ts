// KUNLIK VAZIFALAR — the bot's pure decision layer (Daily Tasks PR-4, spec §11). No Telegram, no database:
// the I/O lives in daily-tasks.ts, which asks this module WHAT to do and then does it.
//
// 1. The 60-second topics cache (§11.1). A daily-task topic is (chat_id, thread_id) — NEVER the thread number
//    alone: thread 10 is the daily topic of both 5-GURUH and 6-GURUH, in different chats. The snapshot holds
//    challenge_task_topics() (PR-1) and the parsed challenge_tasks_config() (PR-3) separately:
//      - topics unavailable (RPC error)  → 'unavailable': the caller FAILS CLOSED to today's behaviour;
//      - config unavailable (PR-3 not applied yet, or an RPC error) → treated as inactive: fail closed too;
//      - config.active = false (challenge_tasks.enabled=false or challenge.enabled=false — INERT at merge)
//        → 'inactive': today's behaviour, and not one engine RPC per message.
//    A failed load is cached for a short errorTtl so a broken RPC cannot be hammered by a busy chat.
// 2. planCapture(): what the bot does with challenge_task_capture's payload (the engine decided everything).
// 3. botStatusDetails(): the my_chat_member → 'challenge_bot_status_changed' row (G15).

export interface DailyTopic {
  group_id: string;
  course_id: string | null;
  chat_id: number;
  thread_id: number;
  is_test: boolean;
}

export interface DailyConfig {
  active: boolean;
  autoRegister: boolean;
  receipts: boolean;
  maxMoves: number;
  maxAttempts: number;
  tagHandle: string;
}

export interface DailySnapshot {
  topics: Map<string, DailyTopic>; // key `${chat}:${thread}`
  groups: Map<string, DailyTopic>; // key group_id
  chats: Set<number>;
  config: DailyConfig | null; // null = the config RPC failed / is missing → inactive (fail closed)
  configError: string | null;
  loadedAt: number;
}

export interface DailyLoadResult {
  topics: unknown[] | null;
  topicsError: string | null;
  config: unknown | null;
  configError: string | null;
}

export type DailyCacheResult = { ok: true; snap: DailySnapshot } | { ok: false; error: string };

export function topicKey(chatId: number | string, threadId: number | string): string {
  return `${Number(chatId)}:${Number(threadId)}`;
}

/** Normalises challenge_task_topics() rows; a malformed row is skipped (never widens the match). */
export function parseTopics(rows: unknown[] | null | undefined): DailyTopic[] {
  const out: DailyTopic[] = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    const o = r as Record<string, unknown>;
    const chat = Number(o?.chat_id);
    const thread = Number(o?.thread_id);
    const gid = typeof o?.group_id === "string" ? o.group_id : "";
    if (!gid || !Number.isSafeInteger(chat) || chat >= 0 || !Number.isSafeInteger(thread) || thread <= 1) continue;
    out.push({
      group_id: gid,
      course_id: typeof o.course_id === "string" ? o.course_id : null,
      chat_id: chat,
      thread_id: thread,
      is_test: o.is_test === true,
    });
  }
  return out;
}

/** challenge_tasks_config() → the few flags the bot needs. Absent / malformed = the engine's defaults. */
export function parseDailyConfig(v: unknown): DailyConfig | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const int = (x: unknown, d: number) => (Number.isSafeInteger(Number(x)) && Number(x) > 0 ? Number(x) : d);
  const ig = (o.ig && typeof o.ig === "object") ? o.ig as Record<string, unknown> : {};
  return {
    active: o.active === true,
    autoRegister: o.auto_register !== false,
    receipts: o.receipts !== false,
    maxMoves: int(o.max_moves_per_submission, 5),
    maxAttempts: int(o.max_attempts_per_task, 3),
    tagHandle: typeof ig.tag_handle === "string" && ig.tag_handle.trim() ? ig.tag_handle.trim() : "aicreators.students",
  };
}

export function buildSnapshot(load: DailyLoadResult, now: number): DailySnapshot {
  const topics = new Map<string, DailyTopic>();
  const groups = new Map<string, DailyTopic>();
  const chats = new Set<number>();
  for (const t of parseTopics(load.topics)) {
    topics.set(topicKey(t.chat_id, t.thread_id), t);
    groups.set(t.group_id, t);
    chats.add(t.chat_id);
  }
  const config = load.configError ? null : parseDailyConfig(load.config);
  return { topics, groups, chats, config, configError: load.configError ?? (config ? null : "config_unparseable"), loadedAt: now };
}

export interface DailyTopicsCache {
  get(): Promise<DailyCacheResult>;
  /** Test / ops hook: forget the snapshot. */
  reset(): void;
}

/**
 * One snapshot per isolate, refreshed every ttlMs (60 s). Concurrent callers share one in-flight load. A failed
 * TOPICS load is remembered for errorTtlMs (10 s) and reported as unavailable; the loader never throws out.
 */
export function createDailyTopicsCache(
  loader: () => Promise<DailyLoadResult>,
  opts: { ttlMs?: number; errorTtlMs?: number; now?: () => number } = {},
): DailyTopicsCache {
  const ttl = opts.ttlMs ?? 60_000;
  const errTtl = opts.errorTtlMs ?? 10_000;
  const now = opts.now ?? (() => Date.now());
  let snap: DailySnapshot | null = null;
  let failed: { at: number; error: string } | null = null;
  let inflight: Promise<DailyCacheResult> | null = null;
  return {
    reset() {
      snap = null;
      failed = null;
      inflight = null;
    },
    get(): Promise<DailyCacheResult> {
      const t = now();
      if (snap && t - snap.loadedAt < ttl) return Promise.resolve({ ok: true, snap });
      if (failed && t - failed.at < errTtl) return Promise.resolve({ ok: false, error: failed.error });
      if (inflight) return inflight;
      inflight = (async (): Promise<DailyCacheResult> => {
        try {
          const load = await loader();
          if (load.topicsError || !Array.isArray(load.topics)) {
            failed = { at: now(), error: load.topicsError ?? "topics_unavailable" };
            return { ok: false, error: failed.error };
          }
          snap = buildSnapshot(load, now());
          failed = null;
          return { ok: true, snap };
        } catch (e) {
          failed = { at: now(), error: `loader_threw: ${String(e).slice(0, 120)}` };
          return { ok: false, error: failed.error };
        } finally {
          inflight = null;
        }
      })();
      return inflight;
    },
  };
}

export type DailyRoute =
  | { kind: "not_daily" }
  | { kind: "unavailable"; error: string }
  | { kind: "inactive"; topic: DailyTopic; reason: string }
  | { kind: "capture"; topic: DailyTopic; config: DailyConfig };

/** Where a group message goes. Only a (chat, thread) pair that IS a daily topic ever leaves 'not_daily'. */
export function routeDaily(res: DailyCacheResult, chatId: unknown, threadId: unknown): DailyRoute {
  const chat = Number(chatId);
  const thread = Number(threadId);
  if (!Number.isSafeInteger(chat) || !Number.isSafeInteger(thread) || thread <= 1) return { kind: "not_daily" };
  if (!res.ok) return { kind: "unavailable", error: res.error };
  const topic = res.snap.topics.get(topicKey(chat, thread));
  if (!topic) return { kind: "not_daily" };
  const cfg = res.snap.config;
  if (!cfg) return { kind: "inactive", topic, reason: res.snap.configError ?? "config_unavailable" };
  if (!cfg.active) return { kind: "inactive", topic, reason: "disabled" };
  return { kind: "capture", topic, config: cfg };
}

// ── The capture plan ────────────────────────────────────────────────────────────────────────────────────
// Outcomes the engine returns WITHOUT having handled the message: the bot falls through to today's behaviour.
const FALL_THROUGH = new Set(["disabled", "not_task_topic", "error"]);
// Held senders (C23) — no ledger row; the engine returns a hint only on the first one of the day.
const HELD = new Set(["no_group", "sender_out_of_scope", "inactive"]);

export interface CapturePlan {
  /** The engine did not handle it (paused, not a topic, an error): run today's handler. */
  fallThrough: boolean;
  /** unknown_sender whose message looks like work (shaped): resolve / register the poster, then capture again. */
  needsIdentity: boolean;
  /** Send (reply) or edit the receipt. */
  receipt: "reply" | "edit" | null;
  submissionId: number | null;
  receiptVersion: number | null;
  receiptMessageId: number | null;
  replyTo: number | null;
  welcome: boolean;
  /** A reaction on the student's own message (validated later by reactionFor). */
  reactWith: string | null;
  /** A once-a-day hint (held / wrong_group / no_slot_* / attempts_exhausted). */
  hint: string | null;
  /** C19: resolved by a unique same-group username — link the telegram_id now (edge code owns links). */
  linkUsername: boolean;
}

function n(v: unknown): number | null {
  const x = Number(v);
  return v !== null && v !== undefined && Number.isSafeInteger(x) ? x : null;
}

export function planCapture(p: Record<string, any> | null | undefined, opts: { identityTried?: boolean } = {}): CapturePlan {
  const outcome = String(p?.outcome ?? "error");
  const plan: CapturePlan = {
    fallThrough: false, needsIdentity: false, receipt: null, submissionId: null, receiptVersion: null,
    receiptMessageId: null, replyTo: null, welcome: false, reactWith: null, hint: null, linkUsername: false,
  };
  if (!p || p.status === "error" || FALL_THROUGH.has(outcome)) {
    plan.fallThrough = true;
    return plan;
  }
  if (outcome === "unknown_sender") {
    plan.needsIdentity = p.shaped === true && !opts.identityTried;
    return plan;
  }
  plan.hint = typeof p.hint?.kind === "string" && p.hint.kind ? p.hint.kind : null;
  if (HELD.has(outcome) || outcome === "duplicate") return plan; // a replay never re-sends anything
  plan.linkUsername = p.resolved_via === "username_match";
  const sub = n(p.submission?.id);
  plan.submissionId = sub;
  const mode = String(p.receipt?.mode ?? "none");
  if (sub !== null && (mode === "reply" || mode === "edit")) {
    plan.receipt = mode;
    plan.receiptVersion = n(p.receipt?.version);
    plan.receiptMessageId = n(p.receipt?.receipt_message_id);
    plan.replyTo = n(p.receipt?.reply_to_message_id);
    plan.welcome = p.receipt?.carries_welcome === true;
    if (mode === "edit" && plan.receiptMessageId === null) plan.receipt = null; // nothing to edit (engine guard)
  }
  // A reply receipt IS the acknowledgement; anything else (an edit of the first receipt, a degraded reaction-only
  // receipt under load, a queued welcome, an extra) is acknowledged on the message itself.
  if (plan.receipt !== "reply" && typeof p.reaction === "string" && p.reaction) plan.reactWith = p.reaction;
  return plan;
}

// ── my_chat_member → 'challenge_bot_status_changed' (G15) ──────────────────────────────────────────────
export function botStatusDetails(mcm: Record<string, any> | null | undefined): Record<string, unknown> | null {
  const chat = n(mcm?.chat?.id);
  const newStatus = typeof mcm?.new_chat_member?.status === "string" ? mcm.new_chat_member.status : null;
  if (chat === null || !newStatus) return null;
  const oldStatus = typeof mcm?.old_chat_member?.status === "string" ? mcm.old_chat_member.status : null;
  const nm = mcm?.new_chat_member ?? {};
  return {
    chat,
    old_status: oldStatus,
    new_status: newStatus,
    can_delete_messages: typeof nm.can_delete_messages === "boolean" ? nm.can_delete_messages : null,
    can_manage_topics: typeof nm.can_manage_topics === "boolean" ? nm.can_manage_topics : null,
    changed_by: n(mcm?.from?.id),
    at_unix: n(mcm?.date),
  };
}
