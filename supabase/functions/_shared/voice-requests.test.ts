// Run: deno test supabase/functions/_shared/voice-requests.test.ts
// The Mini App → bot voice bridge keeps ONE request per submission and never re-points one (audit FB-4). Every
// scenario here interleaves two requests — Aziza's card, then Bobur's — because that is the sequence that sent
// Aziza's feedback to Bobur before.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { FakeConvDb } from "./conv-state-fake.ts";
import {
  addVoiceRequest, claimHeldVoice, dropHeldVoice, emptyVoiceState, holdVoice, MAX_HELD_VOICES, MAX_PENDING_VOICE_REQUESTS,
  normalizeVoiceState, parkVoiceRequest, parseVoicePick, pruneVoiceState, resolveVoiceTarget, restoreVoiceRequest,
  stampVoicePrompt, stampVoicePromptIo, VOICE_REQUEST_TTL_MS, voicePickData, voiceStateExpiry, type VoiceState,
  withdrawVoiceRequest,
} from "./voice-requests.ts";

const T0 = Date.parse("2026-10-01T09:00:00Z");
const MIN = 60_000;
const SUB_A = "aaaaaaaa-1111-4111-8111-111111111111"; // Aziza's homework
const SUB_B = "bbbbbbbb-2222-4222-8222-222222222222"; // Bobur's homework
const A = { submission_id: SUB_A, label: "5.0 · 1-GURUH PRE · M2 V1 — Prompt", student: "Aziza Karimova" };
const B = { submission_id: SUB_B, label: "CH6 · AC CHALLENGE | 3-GURUH · M2 V1 — Prompt", student: "Bobur Aliyev" };
const TEACHER = 777001;

/** Aziza requested at T0 (prompt 101), Bobur at T0+2min (prompt 102). */
function twoPending(): VoiceState {
  let s = addVoiceRequest(emptyVoiceState(), A, T0, "aaaa0001").state;
  s = stampVoicePrompt(s, "aaaa0001", 101)!;
  s = addVoiceRequest(s, B, T0 + 2 * MIN, "bbbb0002").state;
  return stampVoicePrompt(s, "bbbb0002", 102)!;
}

// ---- pure state ----

Deno.test("add: a second card gets its OWN request — the first is never re-pointed", () => {
  const s = twoPending();
  assertEquals(s.reqs.map((r) => [r.submission_id, r.mids]), [[SUB_A, [101]], [SUB_B, [102]]]);
});

Deno.test("add: the same card again refreshes its request (keeps its prompts), never duplicates it", () => {
  const s0 = twoPending();
  const r = addVoiceRequest(s0, A, T0 + 5 * MIN, "zzzz9999");
  assertEquals(r.outcome, "refreshed");
  assertEquals(r.req?.rid, "aaaa0001");
  assertEquals(r.state.reqs.length, 2);
  assertEquals(r.state.reqs[0].exp, new Date(T0 + 5 * MIN + VOICE_REQUEST_TTL_MS).toISOString());
  const s1 = stampVoicePrompt(r.state, "aaaa0001", 105)!;
  assertEquals(s1.reqs[0].mids, [101, 105]);
});

Deno.test("add: past the cap the answer is too_many — nothing pending is dropped", () => {
  let s = emptyVoiceState();
  for (let i = 0; i < MAX_PENDING_VOICE_REQUESTS; i++) {
    s = addVoiceRequest(s, { submission_id: `sub-${i}`, label: null, student: `S${i}` }, T0, `r000000${i}`.slice(-8)).state;
  }
  const r = addVoiceRequest(s, B, T0, "bbbb0002");
  assertEquals(r.outcome, "too_many");
  assertEquals(r.state.reqs.length, MAX_PENDING_VOICE_REQUESTS);
});

Deno.test("resolve: a reply picks ITS prompt's student, whichever was requested last", () => {
  const s = twoPending();
  const now = T0 + 3 * MIN;
  const toA = resolveVoiceTarget(s, 101, now);
  assertEquals(toA.kind === "target" && toA.req.submission_id, SUB_A);
  const toB = resolveVoiceTarget(s, 102, now);
  assertEquals(toB.kind === "target" && toB.req.submission_id, SUB_B);
});

Deno.test("resolve: THE FB-4 CASE — two pending, no reply → ask, never the newest", () => {
  const r = resolveVoiceTarget(twoPending(), null, T0 + 3 * MIN);
  assertEquals(r.kind, "ask");
  if (r.kind === "ask") {
    assertEquals(r.reason, "multiple_pending");
    assertEquals(r.options.map((o) => o.student), ["Aziza Karimova", "Bobur Aliyev"]);
  }
});

Deno.test("resolve: a reply to a message that is not a pending prompt asks, even with one request", () => {
  const one = addVoiceRequest(emptyVoiceState(), A, T0, "aaaa0001").state;
  const r = resolveVoiceTarget(stampVoicePrompt(one, "aaaa0001", 101)!, 99, T0 + MIN);
  assertEquals(r.kind === "ask" && r.reason, "reply_not_pending");
});

Deno.test("resolve: exactly one request, no reply → that request", () => {
  const one = addVoiceRequest(emptyVoiceState(), A, T0, "aaaa0001").state;
  const r = resolveVoiceTarget(one, null, T0 + MIN, T0 + MIN);
  assertEquals(r.kind === "target" && r.how, "only");
});

Deno.test("resolve: a request parked AFTER the note was sent is never taken silently", () => {
  const one = addVoiceRequest(emptyVoiceState(), B, T0 + 10_000, "bbbb0002").state;
  // Note sent at T0 (Telegram date, +1 s slack) — Bobur's request appeared 10 s later.
  const r = resolveVoiceTarget(one, null, T0 + 11_000, T0 + 1_000);
  assertEquals(r.kind, "ask");
});

Deno.test("resolve: a reply to an EXPIRED request's prompt is 'expired' — not re-routed to the live one", () => {
  const s = twoPending(); // A expires at T0+15, B at T0+17
  const now = T0 + 16 * MIN;
  const r = resolveVoiceTarget(s, 101, now);
  assertEquals(r.kind, "expired");
  if (r.kind === "expired") assertEquals(r.req?.submission_id, SUB_A);
  // …and with no reply, A's expiry does not make B "the only one": still ask (among the live ones).
  const r2 = resolveVoiceTarget(s, null, now);
  assertEquals(r2.kind === "ask" && r2.options.map((o) => o.submission_id), [SUB_B]);
});

Deno.test("resolve: 'ever pending' is sticky — once A is ANSWERED (claimed away), B alone is still asked about", () => {
  const s = removeA(twoPending()); // A's claim removes it in the same write that answers it
  assertEquals(s.reqs.map((r) => r.submission_id), [SUB_B]);
  assert(s.multi);
  const r = resolveVoiceTarget(s, null, T0 + 3 * MIN, T0 + 3 * MIN);
  assertEquals(r.kind === "ask" && r.options.map((o) => o.submission_id), [SUB_B]);
  // A reply to B's own prompt is unaffected.
  const toB = resolveVoiceTarget(s, 102, T0 + 3 * MIN);
  assertEquals(toB.kind === "target" && toB.how, "reply");
});

Deno.test("resolve: …and once A EXPIRED and was pruned (or a claim/hold/stamp wrote the pruned state), B alone still asks", () => {
  const now = T0 + 16 * MIN; // A expired at T0+15
  let s = pruneVoiceState(twoPending(), now);
  assertEquals(s.reqs.map((r) => r.submission_id), [SUB_B]);
  assertEquals(resolveVoiceTarget(s, null, now).kind, "ask");
  // Every other transition keeps the mark too.
  s = stampVoicePrompt(s, "bbbb0002", 103)!;
  s = holdVoice(s, { tok: "0a1b2c3d", file_id: "V", key: null, mid: 1, at: "x", exp: new Date(now + 15 * MIN).toISOString() }).state;
  s = dropHeldVoice(s, "0a1b2c3d");
  s = addVoiceRequest(s, B, now, "zzzz9999").state; // B refreshed
  assert(s.multi);
  assertEquals(resolveVoiceTarget(s, null, now).kind, "ask");
});

Deno.test("add: a request next to an EXPIRED-but-stored one sets the mark; a fresh state or the same card does not", () => {
  const one = addVoiceRequest(emptyVoiceState(), A, T0, "aaaa0001").state;
  assert(!one.multi);
  assert(!addVoiceRequest(one, A, T0 + MIN, "zzzz9999").state.multi); // refresh of the same card
  const afterExpiry = addVoiceRequest(one, B, T0 + 16 * MIN, "bbbb0002").state; // A expired, not yet pruned
  assertEquals(afterExpiry.reqs.map((r) => r.submission_id), [SUB_B]);
  assert(afterExpiry.multi);
});

Deno.test("normalize: the mark round-trips; >1 stored requests imply it; the legacy shape starts without it", () => {
  const one = addVoiceRequest(emptyVoiceState(), A, T0, "aaaa0001").state;
  assertEquals(normalizeVoiceState(JSON.parse(JSON.stringify({ ...one, multi: true })), "x", "y").multi, true);
  assertEquals(normalizeVoiceState(JSON.parse(JSON.stringify(one)), "x", "y").multi, false);
  const two = JSON.parse(JSON.stringify({ ...twoPending(), multi: undefined }));
  assertEquals(normalizeVoiceState(two, "x", "y").multi, true);
  assertEquals(normalizeVoiceState({ submission_id: SUB_A, label: "L" }, "x", "y").multi, false);
  assertEquals(emptyVoiceState().multi, false);
});

Deno.test("resolve: nothing live → expired; never anything → none", () => {
  assertEquals(resolveVoiceTarget(twoPending(), null, T0 + 60 * MIN).kind, "expired");
  assertEquals(resolveVoiceTarget(emptyVoiceState(), null, T0).kind, "none");
  assertEquals(resolveVoiceTarget(emptyVoiceState(), 5, T0).kind, "none");
});

Deno.test("claim: the pick takes the held note AND the request together; a stale pick is refused", () => {
  const held = { tok: "0a1b2c3d", file_id: "VOICE-1", key: "tg:u1", mid: 200, at: new Date(T0).toISOString(), exp: new Date(T0 + 15 * MIN).toISOString() };
  const s = holdVoice(twoPending(), held).state;
  const c = claimHeldVoice(s, "0a1b2c3d", "aaaa0001", T0 + 3 * MIN);
  assert(c.ok);
  if (c.ok) {
    assertEquals(c.req.submission_id, SUB_A);
    assertEquals(c.held.file_id, "VOICE-1");
    assertEquals(c.state.reqs.map((r) => r.submission_id), [SUB_B]);
    assertEquals(c.state.held.length, 0);
    assert(c.state.multi); // the pick answered Aziza; Bobur is left alone but NOT "the only one ever"
    // The same buttons again: the note is gone.
    assertEquals(claimHeldVoice(c.state, "0a1b2c3d", "bbbb0002", T0 + 3 * MIN), { ok: false, reason: "held_gone" });
  }
  // Another held note, but Aziza's request was already answered → req_gone, with who is still pending.
  const s2 = holdVoice(removeA(s), { ...held, tok: "0a1b2c3e" }).state;
  const c2 = claimHeldVoice(s2, "0a1b2c3e", "aaaa0001", T0 + 3 * MIN);
  assertEquals(!c2.ok && c2.reason === "req_gone" && c2.options.map((o) => o.submission_id), [SUB_B]);
});

function removeA(s: VoiceState): VoiceState {
  return { ...s, reqs: s.reqs.filter((r) => r.rid !== "aaaa0001") };
}

Deno.test("hold: past the cap the oldest held note is dropped (its buttons then say so)", () => {
  let s = twoPending();
  for (let i = 0; i < MAX_HELD_VOICES + 1; i++) {
    s = holdVoice(s, { tok: `0000000${i}`, file_id: `V${i}`, key: null, mid: i, at: "x", exp: new Date(T0 + 15 * MIN).toISOString() }).state;
  }
  assertEquals(s.held.length, MAX_HELD_VOICES);
  assertEquals(s.held[0].tok, "00000001");
});

Deno.test("callback_data: the pick fits Telegram's 64 bytes and parses back; junk does not", () => {
  const d = voicePickData("0a1b2c3d", "aaaa0001");
  assert(new TextEncoder().encode(d).length <= 64);
  assertEquals(parseVoicePick(d), { tok: "0a1b2c3d", rid: "aaaa0001" });
  assertEquals(parseVoicePick(voicePickData("0a1b2c3d", "x")), { tok: "0a1b2c3d", rid: "x" });
  assertEquals(parseVoicePick("gvp:0a1b2c3d:aaaa0001:extra"), null);
  assertEquals(parseVoicePick("gvp:ZZZZZZZZ:aaaa0001"), null);
});

Deno.test("normalize: the legacy one-request shape becomes one button-pickable request with no prompts", () => {
  const s = normalizeVoiceState({ submission_id: SUB_A, label: "L" }, "2026-10-01T09:00:00Z", "2026-10-01T09:15:00Z");
  assertEquals(s.reqs.length, 1);
  assertEquals(s.reqs[0].rid, "laaaaaaa");
  assertEquals(s.reqs[0].mids, []);
  assert(parseVoicePick(voicePickData("0a1b2c3d", s.reqs[0].rid)));
  assertEquals(normalizeVoiceState({ state: "junk" }, "x", "y"), emptyVoiceState());
  // Garbage entries inside a v2 context are dropped, not trusted.
  const v2 = normalizeVoiceState({ v: 2, cas: "c", reqs: [{ rid: "BAD" }, { rid: "aaaa0001", submission_id: SUB_A, at: "a", exp: "b", mids: [1, "x"] }], held: [{}] }, "x", "y");
  assertEquals(v2.reqs.map((r) => [r.rid, r.mids]), [["aaaa0001", [1]]]);
  assertEquals(v2.held, []);
});

Deno.test("prune + expiry: the row lives as long as its latest request", () => {
  const s = twoPending();
  assertEquals(voiceStateExpiry(s, T0), new Date(T0 + 17 * MIN).toISOString());
  assertEquals(pruneVoiceState(s, T0 + 16 * MIN).reqs.map((r) => r.submission_id), [SUB_B]);
});

// ---- compare-and-swap I/O (in-memory bot_conversation_state) ----

const clock = (ms: number) => () => ms;

Deno.test("park: Aziza then Bobur → BOTH pending in one row; the prompt ids are stamped on their own requests", async () => {
  const db = new FakeConvDb();
  const a = await parkVoiceRequest(db, TEACHER, A, { now: clock(T0), rid: "aaaa0001" });
  assert(a.ok && a.result.kind === "parked" && a.result.pending === 1 && !a.result.replyNeeded);
  await stampVoicePromptIo(db, TEACHER, "aaaa0001", 101, { now: clock(T0) });
  const b = await parkVoiceRequest(db, TEACHER, B, { now: clock(T0 + 2 * MIN), rid: "bbbb0002" });
  assert(b.ok && b.result.kind === "parked" && b.result.pending === 2 && b.result.replyNeeded);
  await stampVoicePromptIo(db, TEACHER, "bbbb0002", 102, { now: clock(T0 + 2 * MIN) });
  const row = db.row(TEACHER)!;
  assertEquals(row.state, "grade_voice");
  const s = normalizeVoiceState(row.context, row.updated_at, row.expires_at);
  assertEquals(s.reqs.map((r) => [r.submission_id, r.mids]), [[SUB_A, [101]], [SUB_B, [102]]]);
  assertEquals(row.expires_at, new Date(T0 + 2 * MIN + VOICE_REQUEST_TTL_MS).toISOString());
});

Deno.test("park: two taps racing (same clock ms) — the compare-and-swap loses neither request", async () => {
  const db = new FakeConvDb();
  await parkVoiceRequest(db, TEACHER, A, { now: clock(T0), rid: "aaaa0001" });
  // Bobur's park reads the row, then a concurrent tap for a third card writes first (same millisecond).
  db.raceOnce(() => {
    const row = db.row(TEACHER)!;
    const s = normalizeVoiceState(row.context, row.updated_at, row.expires_at);
    const next = addVoiceRequest(s, { submission_id: "cccccccc-3333-4333-8333-333333333333", label: null, student: "Charos" }, T0, "cccc0003").state;
    db.seed({ ...row, context: { ...next, cas: "concurrent" } }); // same updated_at: only the cas nonce differs
  });
  const b = await parkVoiceRequest(db, TEACHER, B, { now: clock(T0), rid: "bbbb0002" });
  assert(b.ok && b.result.kind === "parked" && b.result.pending === 3);
  const row = db.row(TEACHER)!;
  assertEquals(normalizeVoiceState(row.context, row.updated_at, row.expires_at).reqs.map((r) => r.student), ["Aziza Karimova", "Charos", "Bobur Aliyev"]);
});

Deno.test("park: a live in-bot grading flow is never clobbered (busy); an expired one or the nm_cache is taken over", async () => {
  const db = new FakeConvDb();
  const live = { telegram_id: TEACHER, state: "grade_score", context: { submission_id: SUB_B }, updated_at: new Date(T0).toISOString(), expires_at: new Date(T0 + 10 * MIN).toISOString() };
  db.seed(live);
  const r = await parkVoiceRequest(db, TEACHER, A, { now: clock(T0 + MIN) });
  assertEquals(r.ok && r.result, { kind: "busy", state: "grade_score" });
  assertEquals(db.row(TEACHER)!.state, "grade_score");
  const r2 = await parkVoiceRequest(db, TEACHER, A, { now: clock(T0 + 11 * MIN), rid: "aaaa0001" });
  assert(r2.ok && r2.result.kind === "parked");
  assertEquals(db.row(TEACHER)!.state, "grade_voice");
  const db2 = new FakeConvDb();
  db2.seed({ ...live, state: "nm_cache", context: {} });
  const r3 = await parkVoiceRequest(db2, TEACHER, A, { now: clock(T0 + MIN), rid: "aaaa0001" });
  assert(r3.ok && r3.result.kind === "parked");
});

Deno.test("park: a legacy one-request row (pre-deploy) is kept alongside the new request", async () => {
  const db = new FakeConvDb();
  db.seed({ telegram_id: TEACHER, state: "grade_voice", context: { submission_id: SUB_A, label: "L" }, updated_at: new Date(T0).toISOString(), expires_at: new Date(T0 + 15 * MIN).toISOString() });
  const r = await parkVoiceRequest(db, TEACHER, B, { now: clock(T0 + MIN), rid: "bbbb0002" });
  assert(r.ok && r.result.kind === "parked" && r.result.pending === 2);
});

Deno.test("withdraw (prompt undeliverable) removes only that request; the last one deletes the row", async () => {
  const db = new FakeConvDb();
  await parkVoiceRequest(db, TEACHER, A, { now: clock(T0), rid: "aaaa0001" });
  await parkVoiceRequest(db, TEACHER, B, { now: clock(T0), rid: "bbbb0002" });
  await withdrawVoiceRequest(db, TEACHER, "bbbb0002", { now: clock(T0) });
  const row = db.row(TEACHER)!;
  assertEquals(normalizeVoiceState(row.context, row.updated_at, row.expires_at).reqs.map((r) => r.rid), ["aaaa0001"]);
  await withdrawVoiceRequest(db, TEACHER, "aaaa0001", { now: clock(T0) });
  assertEquals(db.row(TEACHER), null);
});

Deno.test("restore: a claimed request whose save failed comes back (fresh expiry, same prompts)", async () => {
  const db = new FakeConvDb();
  const req = { rid: "aaaa0001", submission_id: SUB_A, label: "L", student: "Aziza", mids: [101], at: new Date(T0).toISOString(), exp: new Date(T0 + 15 * MIN).toISOString() };
  const r = await restoreVoiceRequest(db, TEACHER, req, { now: clock(T0 + 14 * MIN) });
  assert(r.ok && r.result === true);
  const row = db.row(TEACHER)!;
  const s = normalizeVoiceState(row.context, row.updated_at, row.expires_at);
  assertEquals(s.reqs[0].mids, [101]);
  assertEquals(s.reqs[0].exp, new Date(T0 + 29 * MIN).toISOString());
  // Restored with the mark: her next note WITHOUT a reply is asked about (resend or another take?); a reply to
  // the restored prompt still goes straight through.
  assert(s.multi);
  assertEquals(resolveVoiceTarget(s, null, T0 + 15 * MIN).kind, "ask");
  assertEquals(resolveVoiceTarget(s, 101, T0 + 15 * MIN).kind, "target");
  // Not twice.
  const again = await restoreVoiceRequest(db, TEACHER, req, { now: clock(T0 + 14 * MIN) });
  assert(again.ok && again.result === false);
});
