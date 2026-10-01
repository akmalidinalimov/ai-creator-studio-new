// Pending "record voice in Telegram" requests (the Mini App → bot voice bridge), ONE PER SUBMISSION.
//
// THE BUG THIS REPLACES (teacher audit 2026-09-30, FB-4 / R7): teacher-voice-request parked ONE grade_voice
// request per teacher and silently re-pointed it at the newest card. A teacher who tapped "Telegramda ovoz
// yozish" on Aziza's card, then on Bobur's, then recorded Aziza's feedback had it saved on Bobur's homework
// and sent to Bobur at once — no undo — and her second recording found no request and was lost.
//
// THE CONTRACT NOW:
//   * every request is its own entry, keyed by submission, remembering the bot prompt(s) it sent (message_id);
//   * a request is NEVER re-pointed: asking again for the same card refreshes that entry, another card adds one;
//   * a voice note that REPLIES to a prompt goes to that prompt's student;
//   * a voice note that does not reply goes to the one pending request ONLY when exactly one was ever pending;
//     otherwise the bot holds the note and asks "who is this for?" with one button per student. "Ever" is the
//     sticky `multi` mark (below): answering, expiring or discarding one of two requests leaves the other
//     pending ALONE, but a note without a reply may still be a second take for the first student — so it asks;
//   * a reply to anything that is not a pending prompt is never guessed either — it asks.
//
// Storage: bot_conversation_state has ONE row per telegram_id (PK), so the whole set lives in that row's
// `context` jsonb (state "grade_voice"). Every write is a compare-and-swap on the row's (state, updated_at,
// context->>cas), retried on conflict — two taps in the Mini App, or a voice note racing a new request, can
// never lose each other's entry (no read-modify-write window, and no migration needed).
//
// Pure state functions first (tested in voice-requests.test.ts), then the CAS I/O helpers.

/** A request lives this long after it was (last) asked for — the bot grading flow's own conversation TTL. */
export const VOICE_REQUEST_TTL_MS = 15 * 60_000;
/** More pending requests than this is not a to-do list any more; the Mini App says so instead of queueing. */
export const MAX_PENDING_VOICE_REQUESTS = 10;
/** Recordings waiting for a "who is this for?" answer. The oldest is dropped (its buttons then say so). */
export const MAX_HELD_VOICES = 5;
/** Prompt message_ids remembered per request (a re-request adds one; bounded so the row stays small). */
export const MAX_PROMPTS_PER_REQUEST = 5;

export type VoiceRequest = {
  /** 8 chars [0-9a-z]: the request's id inside callback_data ("gvp:<tok>:<rid>" stays far under 64 bytes). */
  rid: string;
  submission_id: string;
  /** The shared hw-label "<course> · <group> · M<n> V<step> — <title>" (plain text), or null. */
  label: string | null;
  /** The student's display name (plain text), or null for a request parked before this change. */
  student: string | null;
  /** Bot prompt message_ids that point at this request. A reply to any of them targets it. */
  mids: number[];
  at: string;
  exp: string;
};

export type HeldVoice = {
  /** 8 hex chars: the "who is this for?" question's token in callback_data. */
  tok: string;
  file_id: string;
  /** botVoiceKey(msg): the note's identity for the grade_voice_dm_skipped dedupe. */
  key: string | null;
  /** The teacher's voice message_id. */
  mid: number | null;
  at: string;
  exp: string;
};

export type VoiceState = {
  v: 2;
  cas: string;
  reqs: VoiceRequest[];
  held: HeldVoice[];
  /**
   * More than one request has been pending in this row's lifetime. STICKY: set when a request is added while
   * another is stored (live or expired-but-unpruned); claims, prunes, discards and stamps never clear it. It
   * ends only with the row — deleted when the state empties (casWrite), or expired as a whole. `reqs` alone
   * cannot say this: a claim or a prune removes the other request in the same write (audit PR-5 review).
   */
  multi: boolean;
};

export const emptyVoiceState = (): VoiceState => ({ v: 2, cas: "", reqs: [], held: [], multi: false });

const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const iso = (ms: number) => new Date(ms).toISOString();
const ms = (s: string) => {
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : 0;
};
const RID_RE = /^[0-9a-z]{8}$/;
const TOK_RE = /^[0-9a-f]{8}$/;

/**
 * Any stored context → a VoiceState. Understands the v2 shape and the legacy one-request shape
 * `{ submission_id, label }` (a request parked by the previous teacher-voice-request, still live during the
 * deploy window) — the legacy request gets a deterministic rid and no prompt ids, so it can be picked with a
 * button or taken as the only pending request, never matched by a reply.
 */
export function normalizeVoiceState(ctx: unknown, rowUpdatedAt: string, rowExpiresAt: string): VoiceState {
  const c = (ctx && typeof ctx === "object") ? ctx as Record<string, unknown> : {};
  if (c.v === 2) {
    const reqs: VoiceRequest[] = [];
    for (const r of Array.isArray(c.reqs) ? c.reqs : []) {
      const o = (r && typeof r === "object") ? r as Record<string, unknown> : {};
      if (!isStr(o.rid) || !RID_RE.test(o.rid) || !isStr(o.submission_id) || !isStr(o.at) || !isStr(o.exp)) continue;
      if (reqs.some((x) => x.rid === o.rid || x.submission_id === o.submission_id)) continue;
      reqs.push({
        rid: o.rid, submission_id: o.submission_id, label: strOrNull(o.label), student: strOrNull(o.student),
        mids: (Array.isArray(o.mids) ? o.mids : []).filter(isInt).slice(-MAX_PROMPTS_PER_REQUEST),
        at: o.at, exp: o.exp,
      });
    }
    const held: HeldVoice[] = [];
    for (const h of Array.isArray(c.held) ? c.held : []) {
      const o = (h && typeof h === "object") ? h as Record<string, unknown> : {};
      if (!isStr(o.tok) || !TOK_RE.test(o.tok) || !isStr(o.file_id) || !isStr(o.at) || !isStr(o.exp)) continue;
      if (held.some((x) => x.tok === o.tok)) continue;
      held.push({ tok: o.tok, file_id: o.file_id, key: strOrNull(o.key), mid: isInt(o.mid) ? o.mid : null, at: o.at, exp: o.exp });
    }
    return { v: 2, cas: isStr(c.cas) ? c.cas : "", reqs, held, multi: c.multi === true || reqs.length > 1 };
  }
  if (isStr(c.submission_id)) {
    const hex = c.submission_id.replace(/[^0-9a-f]/gi, "").toLowerCase();
    return {
      v: 2, cas: "", held: [], multi: false,
      reqs: [{
        rid: `l${(hex + "0000000").slice(0, 7)}`, submission_id: c.submission_id, label: strOrNull(c.label),
        student: null, mids: [], at: rowUpdatedAt, exp: rowExpiresAt,
      }],
    };
  }
  return emptyVoiceState();
}

const liveReq = (r: VoiceRequest, nowMs: number) => ms(r.exp) > nowMs;
const liveHeld = (h: HeldVoice, nowMs: number) => ms(h.exp) > nowMs;

/** Drop expired requests and held recordings. */
export function pruneVoiceState(s: VoiceState, nowMs: number): VoiceState {
  return { ...s, reqs: s.reqs.filter((r) => liveReq(r, nowMs)), held: s.held.filter((h) => liveHeld(h, nowMs)) };
}

export const isEmptyVoiceState = (s: VoiceState) => s.reqs.length === 0 && s.held.length === 0;

/** The row's expires_at: the latest expiry of anything it still holds. */
export function voiceStateExpiry(s: VoiceState, nowMs: number): string {
  let max = nowMs;
  for (const r of s.reqs) max = Math.max(max, ms(r.exp));
  for (const h of s.held) max = Math.max(max, ms(h.exp));
  return iso(max);
}

export type AddOutcome = "added" | "refreshed" | "too_many";

/**
 * Ask for a voice note on one submission. The same submission again refreshes ITS entry (new expiry, fresh
 * label/name — the next prompt's id is stamped on it separately); another submission gets its own entry.
 * Nothing already pending is ever re-pointed or dropped: past the cap the answer is "too_many".
 * A new entry next to ANY other stored one (checked before pruning, so an expired one counts) sets the sticky
 * `multi` mark: from then on a note without a reply is asked about, even once only one request is left.
 */
export function addVoiceRequest(
  s: VoiceState,
  input: { submission_id: string; label: string | null; student: string | null },
  nowMs: number,
  rid: string,
): { state: VoiceState; outcome: AddOutcome; req: VoiceRequest | null } {
  const base = pruneVoiceState(s, nowMs);
  const exp = iso(nowMs + VOICE_REQUEST_TTL_MS);
  const i = base.reqs.findIndex((r) => r.submission_id === input.submission_id);
  if (i >= 0) {
    const req: VoiceRequest = {
      ...base.reqs[i], label: input.label ?? base.reqs[i].label, student: input.student ?? base.reqs[i].student, exp,
    };
    const reqs = base.reqs.slice();
    reqs[i] = req;
    return { state: { ...base, reqs }, outcome: "refreshed", req };
  }
  if (base.reqs.length >= MAX_PENDING_VOICE_REQUESTS) return { state: base, outcome: "too_many", req: null };
  const req: VoiceRequest = {
    rid, submission_id: input.submission_id, label: input.label, student: input.student, mids: [], at: iso(nowMs), exp,
  };
  const multi = base.multi || s.reqs.some((r) => r.submission_id !== input.submission_id);
  return { state: { ...base, reqs: [...base.reqs, req], multi }, outcome: "added", req };
}

/** Remember that prompt `mid` points at request `rid`. null when that request is gone (nothing to stamp). */
export function stampVoicePrompt(s: VoiceState, rid: string, mid: number): VoiceState | null {
  const i = s.reqs.findIndex((r) => r.rid === rid);
  if (i < 0) return null;
  const mids = s.reqs[i].mids.includes(mid) ? s.reqs[i].mids : [...s.reqs[i].mids, mid].slice(-MAX_PROMPTS_PER_REQUEST);
  const reqs = s.reqs.slice();
  reqs[i] = { ...s.reqs[i], mids };
  return { ...s, reqs };
}

export function removeVoiceRequest(s: VoiceState, rid: string): VoiceState {
  return { ...s, reqs: s.reqs.filter((r) => r.rid !== rid) };
}

export type VoiceTarget =
  | { kind: "target"; req: VoiceRequest; how: "reply" | "only" }
  | { kind: "ask"; reason: "multiple_pending" | "reply_not_pending"; options: VoiceRequest[] }
  | { kind: "expired"; req: VoiceRequest | null }
  | { kind: "none" };

/**
 * Where does a voice note go? `replyMid` = the message it replies to (null when it is not a reply).
 *   reply to a pending prompt           → that request;
 *   reply to an EXPIRED request's prompt → "expired" (never re-routed to someone else);
 *   reply to anything else              → ask (a reply names a target; if it isn't a pending one, don't guess);
 *   no reply, exactly one request ever pending (live), asked for BEFORE the note was sent → that request;
 *   no reply, several — even if the others were since answered, expired or pruned (the sticky `multi` mark) —
 *     or one that appeared after the note → ask among the live ones;
 *   nothing live                        → "expired" (or "none" when there never was a request).
 * `sentAtMs` = when the note was sent (Telegram's `date`, 1 s resolution — pass (date + 1) * 1000): a request
 * parked while the note was in flight cannot be what she recorded it for, so it is never taken silently.
 * Pure: the caller prunes/claims in the same compare-and-swap write.
 */
export function resolveVoiceTarget(
  s: VoiceState, replyMid: number | null, nowMs: number, sentAtMs: number | null = null,
): VoiceTarget {
  const live = s.reqs.filter((r) => liveReq(r, nowMs));
  if (replyMid != null) {
    const hit = s.reqs.find((r) => r.mids.includes(replyMid));
    if (hit) return liveReq(hit, nowMs) ? { kind: "target", req: hit, how: "reply" } : { kind: "expired", req: hit };
    if (!live.length) return s.reqs.length ? { kind: "expired", req: s.reqs.length === 1 ? s.reqs[0] : null } : { kind: "none" };
    return { kind: "ask", reason: "reply_not_pending", options: live };
  }
  if (!live.length) return s.reqs.length ? { kind: "expired", req: s.reqs.length === 1 ? s.reqs[0] : null } : { kind: "none" };
  if (live.length === 1 && s.reqs.length === 1 && !s.multi && (sentAtMs == null || ms(live[0].at) <= sentAtMs)) {
    return { kind: "target", req: live[0], how: "only" };
  }
  return { kind: "ask", reason: "multiple_pending", options: live };
}

/** Park a recording until the teacher says whose it is. Past the cap the OLDEST held one is dropped. */
export function holdVoice(s: VoiceState, h: HeldVoice): { state: VoiceState; dropped: HeldVoice | null } {
  const held = [...s.held.filter((x) => x.tok !== h.tok), h];
  const dropped = held.length > MAX_HELD_VOICES ? held.shift() ?? null : null;
  return { state: { ...s, held }, dropped };
}

export function dropHeldVoice(s: VoiceState, tok: string): VoiceState {
  return { ...s, held: s.held.filter((h) => h.tok !== tok) };
}

export type ClaimResult =
  | { ok: true; state: VoiceState; held: HeldVoice; req: VoiceRequest }
  | { ok: false; reason: "held_gone" }
  | { ok: false; reason: "req_gone"; held: HeldVoice; options: VoiceRequest[] };

/**
 * The teacher tapped a student on a "who is this for?" question: take the held recording AND that request out
 * of the state together (one CAS write), so neither can be used twice.
 */
export function claimHeldVoice(s: VoiceState, tok: string, rid: string, nowMs: number): ClaimResult {
  const held = s.held.find((h) => h.tok === tok);
  if (!held || !liveHeld(held, nowMs)) return { ok: false, reason: "held_gone" };
  const req = s.reqs.find((r) => r.rid === rid);
  if (!req || !liveReq(req, nowMs)) {
    return { ok: false, reason: "req_gone", held, options: s.reqs.filter((r) => liveReq(r, nowMs)) };
  }
  return { ok: true, state: dropHeldVoice(removeVoiceRequest(s, rid), tok), held, req };
}

// ---- callback_data ----

/** "gvp:<tok>:<rid>" (21 bytes) — or "gvp:<tok>:x" to discard the held recording. */
export const voicePickData = (tok: string, rid: string | "x") => `gvp:${tok}:${rid}`;

export function parseVoicePick(data: string): { tok: string; rid: string | "x" } | null {
  const m = /^gvp:([0-9a-f]{8}):([0-9a-z]{8}|x)$/.exec(data);
  return m ? { tok: m[1], rid: m[2] } : null;
}

/** 8 random hex chars (rid / tok / cas). */
export function shortId(): string {
  const b = new Uint8Array(4);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

// ---- compare-and-swap I/O on bot_conversation_state ----

// A service-role Supabase client (typed loosely, like the rest of the codebase).
// deno-lint-ignore no-explicit-any
type Db = any;

export type ConvRow = { state: string; context: unknown; updated_at: string; expires_at: string };

/** The live grade_voice state in `row`, or null (no row, another state, or expired). */
export function liveVoiceState(row: ConvRow | null, nowMs: number): VoiceState | null {
  if (!row || row.state !== "grade_voice" || ms(row.expires_at) <= nowMs) return null;
  return normalizeVoiceState(row.context, row.updated_at, row.expires_at);
}

export type VoiceDecision<R> = { write: VoiceState; result: R } | { abort: R };

export type MutateOutcome<R> = { ok: true; result: R } | { ok: false; reason: "contended" | "db_error"; error?: string };

/**
 * Read the teacher's row, let `decide` compute the next voice state from it, and write that state back ONLY if
 * the row is still exactly what was read (state + updated_at, plus the v2 cas nonce). A lost race re-reads and
 * re-decides, so every decision is made on the row it replaces. An empty next state deletes the row (same
 * guard). `decide` sees the raw row too, so a caller can refuse to take over a live non-voice flow.
 */
export async function mutateVoiceState<R>(
  admin: Db,
  telegramId: number,
  decide: (cur: VoiceState | null, row: ConvRow | null, nowMs: number) => VoiceDecision<R>,
  opts: { now?: () => number; attempts?: number } = {},
): Promise<MutateOutcome<R>> {
  const now = opts.now ?? (() => Date.now());
  const attempts = opts.attempts ?? 4;
  for (let i = 0; i < attempts; i++) {
    const nowMs = now();
    const { data: row, error: rErr } = await admin.from("bot_conversation_state")
      .select("state, context, updated_at, expires_at").eq("telegram_id", telegramId).maybeSingle();
    if (rErr) return { ok: false, reason: "db_error", error: String(rErr.message ?? rErr) };
    const prev = (row ?? null) as ConvRow | null;
    const d = decide(liveVoiceState(prev, nowMs), prev, nowMs);
    if ("abort" in d) return { ok: true, result: d.abort };
    const next: VoiceState = { ...d.write, v: 2, cas: shortId() };
    const w = await casWrite(admin, telegramId, prev, next, nowMs);
    if (w === "ok") return { ok: true, result: d.result };
    if (w !== "conflict") return { ok: false, reason: "db_error", error: w.error };
  }
  return { ok: false, reason: "contended" };
}

async function casWrite(
  admin: Db, telegramId: number, prev: ConvRow | null, next: VoiceState, nowMs: number,
): Promise<"ok" | "conflict" | { error: string }> {
  if (!prev) {
    if (isEmptyVoiceState(next)) return "ok";
    const { error } = await admin.from("bot_conversation_state").insert({
      telegram_id: telegramId, state: "grade_voice", context: next,
      updated_at: iso(nowMs), expires_at: voiceStateExpiry(next, nowMs),
    });
    if (!error) return "ok";
    return error.code === "23505" ? "conflict" : { error: String(error.message ?? error) };
  }
  const prevCas = prev.state === "grade_voice" && prev.context && typeof prev.context === "object"
    ? (prev.context as Record<string, unknown>).cas
    : undefined;
  const guard = (q: Db) => {
    let g = q.eq("telegram_id", telegramId).eq("state", prev.state).eq("updated_at", prev.updated_at);
    if (isStr(prevCas)) g = g.eq("context->>cas", prevCas);
    return g;
  };
  const q = isEmptyVoiceState(next)
    ? guard(admin.from("bot_conversation_state").delete())
    : guard(admin.from("bot_conversation_state").update({
      state: "grade_voice", context: next, updated_at: iso(nowMs), expires_at: voiceStateExpiry(next, nowMs),
    }));
  const { data, error } = await q.select("telegram_id");
  if (error) return { error: String(error.message ?? error) };
  return Array.isArray(data) && data.length > 0 ? "ok" : "conflict";
}

// ---- the request side (teacher-voice-request) ----

/**
 * `replyNeeded`: a recording for this request must REPLY to its prompt to be taken without a question — true
 * whenever more than one request has been pending in this row (the sticky `multi` mark), even if this one is
 * the only one left. The prompt copy says so (teacher-voice-request).
 */
export type ParkResult =
  | { kind: "parked"; req: VoiceRequest; outcome: "added" | "refreshed"; pending: number; replyNeeded: boolean }
  | { kind: "busy"; state: string }
  | { kind: "too_many"; pending: number };

/**
 * Park one more voice request for this teacher. Takes the row over only when it holds no live flow (none, a
 * previous grade_voice set, the non-member cache, or anything expired); a live bot flow (grading, name
 * capture, …) is "busy" — the standing rule is never to clobber a flow she is in the middle of.
 */
export function parkVoiceRequest(
  admin: Db,
  telegramId: number,
  input: { submission_id: string; label: string | null; student: string | null },
  opts: { now?: () => number; rid?: string } = {},
): Promise<MutateOutcome<ParkResult>> {
  const rid = opts.rid ?? shortId();
  return mutateVoiceState<ParkResult>(admin, telegramId, (cur, row, nowMs) => {
    if (!cur && row && ms(row.expires_at) > nowMs && row.state !== "nm_cache" && row.state !== "grade_voice") {
      return { abort: { kind: "busy", state: row.state } };
    }
    const r = addVoiceRequest(cur ?? emptyVoiceState(), input, nowMs, rid);
    if (r.outcome === "too_many" || !r.req) return { abort: { kind: "too_many", pending: r.state.reqs.length } };
    return {
      write: r.state,
      result: { kind: "parked", req: r.req, outcome: r.outcome, pending: r.state.reqs.length, replyNeeded: r.state.multi },
    };
  }, opts);
}

/** After the prompt went out: remember its message_id on the request (no-op if the request is gone). */
export function stampVoicePromptIo(
  admin: Db, telegramId: number, rid: string, mid: number, opts: { now?: () => number } = {},
): Promise<MutateOutcome<boolean>> {
  return mutateVoiceState<boolean>(admin, telegramId, (cur) => {
    const next = cur ? stampVoicePrompt(cur, rid, mid) : null;
    return next ? { write: next, result: true } : { abort: false };
  }, opts);
}

/**
 * A claimed request whose note could NOT be saved (the homework write failed): put it back, with a fresh expiry
 * and its prompt ids, so the teacher can simply resend. Skipped when the row now holds another live flow, the
 * same submission is pending again, or the cap is reached.
 * It comes back with the `multi` mark set: the claim may have emptied (and deleted) a row that had several
 * requests, and her next note without a reply may be the resend or a take for someone else — so that note is
 * asked about (one tap); a reply to the restored prompt still goes straight through.
 */
export function restoreVoiceRequest(
  admin: Db, telegramId: number, req: VoiceRequest, opts: { now?: () => number } = {},
): Promise<MutateOutcome<boolean>> {
  return mutateVoiceState<boolean>(admin, telegramId, (cur, row, nowMs) => {
    if (!cur && row && ms(row.expires_at) > nowMs && row.state !== "nm_cache" && row.state !== "grade_voice") {
      return { abort: false };
    }
    const base = pruneVoiceState(cur ?? emptyVoiceState(), nowMs);
    if (base.reqs.some((r) => r.submission_id === req.submission_id || r.rid === req.rid)) return { abort: false };
    if (base.reqs.length >= MAX_PENDING_VOICE_REQUESTS) return { abort: false };
    return {
      write: { ...base, reqs: [...base.reqs, { ...req, exp: iso(nowMs + VOICE_REQUEST_TTL_MS) }], multi: true },
      result: true,
    };
  }, opts);
}

/** The prompt could not be delivered: withdraw the request it would have announced (only a NEW one). */
export function withdrawVoiceRequest(
  admin: Db, telegramId: number, rid: string, opts: { now?: () => number } = {},
): Promise<MutateOutcome<boolean>> {
  return mutateVoiceState<boolean>(admin, telegramId, (cur) => {
    if (!cur || !cur.reqs.some((r) => r.rid === rid)) return { abort: false };
    return { write: removeVoiceRequest(cur, rid), result: true };
  }, opts);
}
