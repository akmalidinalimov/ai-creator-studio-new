// Tests for submit-daily-task/core.ts (Daily Tasks PR-7): validation, the plan / header / capture view, the posting
// fallbacks, and the request flow against a fake engine + a recording poster. The same module runs against the REAL
// PR-3 engine in _challenge/testing/daily-tasks-miniapp-check.ts (PGlite).
// Run: deno test supabase/functions/submit-daily-task/core.test.ts
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  acceptsFile, buildHeader, CAPTION_MAX, CAPTION_TEXT_SAFE, captionTextMax, captureView, type Deps, fileKindOf, handlePrepare,
  handleSubmit, type InFile, MAX_MESSAGES, MAX_PHOTO_BYTES, plannedMessages, planParts, postParts, type SendResult, validateInput,
} from "./core.ts";
import type { MediaGroupItem, SendResultOutcome } from "../_shared/telegram-send.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

const U = "aaaaaaaa-0000-0000-0000-000000000001";
const CHAT = -1004440955972, THREAD = 144;

const out = (klass: SendResultOutcome["klass"] = "ok", retryAfterSec: number | null = null): SendResultOutcome => {
  const ok = klass === "ok" || klass === "not_modified";
  return { ok, status: ok ? 200 : klass === "rate_limited" ? 429 : 400, error: ok ? null : `err_${klass}`, klass, retryAfterSec,
           terminal: ["recipient", "content", "topic_missing", "message_gone"].includes(klass), recipient: klass === "recipient",
           content: klass === "content" };
};

const file = (kind: InFile["kind"], name = `${kind}.bin`, size = 1000, mime?: string): InFile => ({
  kind, blob: new Blob(["x"]), name, size,
  mime: mime ?? (kind === "photo" ? "image/jpeg" : kind === "video" ? "video/mp4" : "application/pdf"),
});

let mid = 500;
const msg = (extra: Record<string, unknown>) => ({
  message_id: mid++, date: 1_790_000_000, chat: { id: CHAT, type: "supergroup", title: "G" }, message_thread_id: THREAD,
  is_topic_message: true, from: { id: 42, is_bot: true, first_name: "Bot" },
  reply_to_message: { message_id: THREAD, forum_topic_created: { name: "KUNLIK VAZIFALAR" } }, ...extra,
});
const photoMsg = (caption?: string, mgid?: string) =>
  msg({ photo: [{ file_id: "s", file_unique_id: "s1" }, { file_id: "L", file_unique_id: `u${mid}` }],
        ...(caption ? { caption, caption_entities: [{ type: "bold", offset: 0, length: 2 }] } : {}), ...(mgid ? { media_group_id: mgid } : {}) });

type Call = { kind: "text" | "single" | "album"; method?: string; fields: Any; items?: MediaGroupItem[] };

/** A recording poster: `script` answers each call (default: success with a plausible Message). */
function recorder(script?: (c: Call, n: number) => SendResult | { outcome: SendResultOutcome; result: Any[] | null } | null) {
  const calls: Call[] = [];
  const ok = (c: Call): Any => {
    if (c.kind === "text") return { outcome: out(), result: msg({ text: c.fields.text }) };
    if (c.kind === "album") return { outcome: out(), result: c.items!.map((it, i) => it.type === "document"
      ? msg({ document: { file_id: `d${i}`, file_unique_id: `du${mid}`, mime_type: "application/pdf" }, media_group_id: "G1", ...(it.caption ? { caption: it.caption } : {}) })
      : it.type === "video" ? msg({ video: { file_id: `v${i}`, file_unique_id: `vu${mid}`, duration: 12 }, media_group_id: "G1", ...(it.caption ? { caption: it.caption } : {}) })
      : photoMsg(it.caption, "G1")) };
    const cap = c.fields.caption as string | undefined;
    if (c.method === "sendPhoto") return { outcome: out(), result: photoMsg(cap) };
    if (c.method === "sendVideo") return { outcome: out(), result: msg({ video: { file_unique_id: `vu${mid}`, duration: 9 }, ...(cap ? { caption: cap } : {}) }) };
    return { outcome: out(), result: msg({ document: { file_unique_id: `du${mid}`, mime_type: "image/heic" }, ...(cap ? { caption: cap } : {}) }) };
  };
  const answer = (c: Call) => {
    calls.push(c);
    return Promise.resolve((script?.(c, calls.length) ?? ok(c)) as Any);
  };
  return {
    calls,
    poster: {
      text: (fields: Any) => answer({ kind: "text", fields }),
      single: (method: Any, fields: Any, f: Any) => answer({ kind: "single", method, fields: { ...fields, _file: f.filename } }),
      album: (fields: Any, items: MediaGroupItem[]) => answer({ kind: "album", fields, items }),
    },
  };
}

/** A fake engine: rpc answers by name; the claims table for readClaim / takeClaim. */
function fakeEngine(opts: {
  prep?: Any; claimRow?: Any; claimNew?: boolean; capture?: (args: Any) => { data: Any; error: Any }; card?: Any; prepErr?: Any;
  recent?: number;
} = {}) {
  const rpcs: { name: string; args: Any }[] = [];
  const health: { action: string; details: Any; once?: string }[] = [];
  const sleeps: number[] = [];
  let claimRow: Any = opts.claimRow ?? null;
  const updates: Any[] = [];
  const admin = {
    rpc: (name: string, args: Any = {}) => {
      rpcs.push({ name, args });
      if (name === "challenge_task_prepare_miniapp") {
        if (opts.prepErr) return Promise.resolve({ data: null, error: opts.prepErr });
        return Promise.resolve({ data: opts.prep ?? PREP_OK, error: null });
      }
      if (name === "challenge_task_submit_claim") {
        return Promise.resolve({ data: { ok: true, new: opts.claimNew ?? true, claimed_at: "2026-10-05T18:58:00+00:00", state: "claimed" }, error: null });
      }
      if (name === "challenge_task_submit_record") return Promise.resolve({ data: { ok: true }, error: null });
      if (name === "challenge_task_capture_miniapp") {
        return Promise.resolve(opts.capture?.(args) ?? { data: { status: "ok", outcome: "created", submission: { id: 9, status: "accepted", points: 5 } }, error: null });
      }
      if (name === "challenge_task_card") return Promise.resolve({ data: opts.card ?? { ok: true, text: "📅 <b>1-kun vazifasi</b>" }, error: null });
      return Promise.resolve({ data: null, error: { code: "PGRST202", message: "could not find the function" } });
    },
    from: (table: string) => {
      assertEquals(table, "challenge_task_submit_claims");
      const st: Any = { op: "select", where: {} as Record<string, unknown> };
      const b: Any = {
        select: () => b,
        update: (row: Any) => { st.op = "update"; st.row = row; return b; },
        eq: (c: string, v: unknown) => { st.where[c] = v; return b; },
        gte: (c: string, v: unknown) => { st.where[`${c}>=`] = v; return b; },
        limit: () => Promise.resolve({ data: Array.from({ length: opts.recent ?? 0 }, (_, i) => ({ request_id: `r${i}` })), error: null }),
        maybeSingle: () => {
          if (st.op === "select") return Promise.resolve({ data: claimRow, error: null });
          updates.push({ row: st.row, where: st.where });
          const hit = claimRow && claimRow.state === st.where.state && claimRow.updated_at === st.where.updated_at;
          if (hit) claimRow = { ...claimRow, ...st.row };
          return Promise.resolve({ data: hit ? { claimed_at: claimRow.claimed_at } : null, error: null });
        },
      };
      return b;
    },
  };
  return { admin, rpcs, health, sleeps, updates };
}

const PREP_OK = {
  ok: true, topic: { group_id: "g1", chat_id: CHAT, thread_id: THREAD, url: "https://t.me/c/4440955972/144" },
  task: { id: 7, date: "2026-10-05", type: "general", title: "Birinchi vazifa", accepts: ["text", "photo", "document"],
          requires: [{ any: ["photo", "image_doc"], min: 1, label: "screenshot" }, { any: ["text"], min: 1, label: "text" }] },
};

function depsOf(e: ReturnType<typeof fakeEngine>, poster: Any, now = Date.parse("2026-10-05T19:00:00Z")): Deps {
  return {
    admin: e.admin, poster,
    health: (action, details) => { e.health.push({ action, details }); return Promise.resolve(); },
    healthOnce: (action, once, details) => { e.health.push({ action, details, once }); return Promise.resolve(); },
    sleep: (ms) => { e.sleeps.push(ms); return Promise.resolve(); },
    now: () => now,
  };
}

const PROFILE = { name: "Ali", last_name: "Valiyev", telegram_username: "ali_v" };
const TEXT = "Mana bugungi vazifam, ko'ring!";

// ─────────────────────────────── pure parts ───────────────────────────────
Deno.test("validateInput: ids, emptiness, counts and Telegram's upload ceilings", () => {
  const ok = { taskId: 7, requestId: "req_12345678", text: "salom", files: [] as InFile[] };
  assertEquals(validateInput(ok), null);
  assertEquals(validateInput({ ...ok, taskId: 0 })?.error, "bad_task_id");
  assertEquals(validateInput({ ...ok, requestId: "short" })?.error, "bad_request_id");
  assertEquals(validateInput({ ...ok, requestId: "bad id with spaces" })?.error, "bad_request_id");
  assertEquals(validateInput({ ...ok, text: "  " })?.error, "empty");
  assertEquals(validateInput({ ...ok, text: "x".repeat(3501) })?.error, "text_too_long");
  assertEquals(validateInput({ ...ok, files: Array.from({ length: 11 }, () => file("photo")) })?.error, "too_many_files");
  assertEquals(validateInput({ ...ok, files: [file("photo", "a.jpg", MAX_PHOTO_BYTES + 1)] })?.status, 413);
  assertEquals(validateInput({ ...ok, files: [file("document", "a.pdf", 11 * 1024 * 1024)] }), null); // a document may be 50 MB
  assertEquals(validateInput({ ...ok, files: Array.from({ length: 4 }, () => file("video", "v.mp4", 45 * 1024 * 1024)) })?.error, "batch_too_large");
});

Deno.test("fileKindOf / acceptsFile: sendPhoto formats are photos, anything else goes as a document", () => {
  assertEquals(fileKindOf("image/jpeg"), "photo");
  assertEquals(fileKindOf("image/png"), "photo");
  assertEquals(fileKindOf("image/heic"), "document");
  assertEquals(fileKindOf("video/mp4"), "video");
  assertEquals(fileKindOf("application/pdf"), "document");
  assertEquals(acceptsFile(["text", "photo"], file("photo")), true);
  assertEquals(acceptsFile(["text", "photo"], file("video")), false);
  assertEquals(acceptsFile(["text", "photo"], file("document", "s.heic", 10, "image/heic")), true); // an image file on a photo task
  assertEquals(acceptsFile(["text", "photo"], file("document", "a.pdf")), false);
  assertEquals(acceptsFile(["document"], file("video")), true);
});

Deno.test("buildHeader: plain text, the student's name + a valid @username, the task date and title", () => {
  const h = buildHeader(PROFILE, { id: 7, date: "2026-10-05", title: "Birinchi vazifa" });
  assertEquals(h, "📱 Ali Valiyev (@ali_v) — ilova orqali\n📅 5-oktabr · Birinchi vazifa");
  assert(!buildHeader({ name: "A<b>", telegram_username: "bad name!" }, { id: 1 }).includes("@"));
  assert(buildHeader(null, { id: 1 }).includes("O‘quvchi"));
});

Deno.test("planParts: the text rides the first caption when it fits, else it is its own message first", () => {
  const H = "HEADER";
  const two = [file("photo"), file("photo")];
  const p1 = planParts(two, "short", H);
  assertEquals(p1.length, 1);
  assertEquals(p1[0], { kind: "media", files: two, caption: `${H}\n\nshort`, carriesText: true });

  const long = "y".repeat(CAPTION_MAX);
  const p2 = planParts(two, long, H);
  assertEquals(p2.map((p) => p.kind), ["text", "media"]);
  assertEquals((p2[0] as Any).carriesText, true);
  assertEquals((p2[1] as Any).caption, H);
  assertEquals((p2[1] as Any).carriesText, false);

  assertEquals(planParts([], "only text", H), [{ kind: "text", text: `${H}\n\nonly text`, carriesText: true }]);

  const mixed = planParts([file("document"), file("photo")], "t", H);
  assertEquals(mixed.map((p) => (p as Any).files.map((f: InFile) => f.kind)), [["photo"], ["document"]]);
  assertEquals(mixed.map((p) => (p as Any).carriesText), [true, false]);

  const one = [file("photo")];
  assertEquals(planParts(one, "", H), [{ kind: "media", files: one, caption: H, carriesText: false }]);
});

Deno.test("plannedMessages / captionTextMax: a text past the caption room is one more message; the safe room fits any header", () => {
  const H = buildHeader(PROFILE, { id: 7, date: "2026-10-05", title: "Birinchi vazifa" });
  const room = captionTextMax(H);
  assertEquals(room, CAPTION_MAX - H.length - 2);
  const ten = Array.from({ length: 10 }, () => file("photo"));
  assertEquals(plannedMessages(planParts(ten, "x".repeat(room), H)), 10);       // rides the caption
  assertEquals(plannedMessages(planParts(ten, "x".repeat(room + 1), H)), 11);   // its own message: past capture_miniapp's 10
  assertEquals(plannedMessages(planParts(ten.slice(0, 9), "x".repeat(room + 1), H)), MAX_MESSAGES);
  assertEquals(plannedMessages(planParts([file("photo"), file("document")], "t", H)), 2); // two albums, still one message per file
  assertEquals(plannedMessages(planParts([], "only text", H)), 1);
  // the Mini App's fallback room fits under the LONGEST header buildHeader can make (every month, clipped name / title)
  for (let mo = 1; mo <= 12; mo++) {
    const worst = buildHeader({ name: "N".repeat(80), last_name: "L".repeat(80), telegram_username: "u".repeat(32) },
      { id: 1, date: `2026-${String(mo).padStart(2, "0")}-30`, title: "T".repeat(300) });
    assert(CAPTION_TEXT_SAFE <= captionTextMax(worst), `month ${mo}: header ${worst.length}`);
  }
});

Deno.test("captureView: the engine sees the STUDENT's text only (our header removed), media and ids kept", () => {
  const posted = photoMsg("📱 Ali Valiyev — ilova orqali\n📅 5-oktabr · X\n\nMatn", "G9");
  const v = captureView(posted, "Matn");
  assertEquals(v.caption, "Matn");
  assertEquals(v.chat, { id: CHAT, type: "supergroup" });
  assertEquals(v.message_thread_id, THREAD);
  assertEquals(v.media_group_id, "G9");
  assert(Array.isArray(v.photo));
  for (const k of ["from", "reply_to_message", "caption_entities", "text"]) assertEquals(k in v, false, k);
  const bare = captureView(photoMsg("📱 header only"), null);
  assertEquals("caption" in bare, false);
  const t = captureView(msg({ text: "📱 header\n\nhttps://instagram.com/p/ABCDE1/", entities: [] }), "https://instagram.com/p/ABCDE1/");
  assertEquals(t.text, "https://instagram.com/p/ABCDE1/");
  assertEquals("entities" in t, false);
});

// ─────────────────────────────── posting ───────────────────────────────
Deno.test("postParts: one album; the student text is attributed to its first message only", async () => {
  const e = fakeEngine();
  const r = recorder();
  const run = await postParts(depsOf(e, r.poster), CHAT, THREAD, planParts([file("photo"), file("video")], TEXT, "H"), TEXT);
  assertEquals(r.calls.map((c) => c.kind), ["album"]);
  assertEquals(r.calls[0].fields, { chat_id: CHAT, message_thread_id: THREAD });
  assertEquals(r.calls[0].items!.map((i) => i.caption ?? null), [`H\n\n${TEXT}`, null]);
  assertEquals(run.posted.map((p) => p.studentText), [TEXT, null]);
  assertEquals(run.failed, 0);
});

Deno.test("postParts: a failed album falls back to single items; a photo Telegram refuses goes as a document", async () => {
  const e = fakeEngine();
  const r = recorder((c) => {
    if (c.kind === "album") return { outcome: out("content"), result: null };
    if (c.method === "sendPhoto" && c.fields._file === "a.jpg") return { outcome: out("content"), result: null };
    return null;
  });
  const run = await postParts(depsOf(e, r.poster), CHAT, THREAD, planParts([file("photo", "a.jpg"), file("photo", "b.jpg")], TEXT, "H"), TEXT);
  assertEquals(r.calls.map((c) => c.method ?? c.kind), ["album", "sendPhoto", "sendDocument", "sendPhoto"]);
  assertEquals(r.calls[2].fields.caption, `H\n\n${TEXT}`); // the caption follows the first item that lands
  assertEquals(r.calls[3].fields.caption, undefined);
  assertEquals(run.posted.length, 2);
  assertEquals(run.posted.map((p) => p.studentText), [TEXT, null]);
});

Deno.test("postParts: a short 429 is waited out once; a persisting one stops the run and the rest count as failed", async () => {
  const e = fakeEngine();
  let n = 0;
  const r = recorder((c) => (c.kind === "text" && ++n === 1 ? { outcome: out("rate_limited", 3), result: null } : null));
  const run = await postParts(depsOf(e, r.poster), CHAT, THREAD, planParts([], TEXT, "H"), TEXT);
  assertEquals(e.sleeps, [3500]);
  assertEquals(run.posted.length, 1);

  const e2 = fakeEngine();
  const r2 = recorder((c) => (c.kind === "text" ? { outcome: out("rate_limited", 90), result: null } : null));
  const long = "z".repeat(CAPTION_MAX + 5);
  const run2 = await postParts(depsOf(e2, r2.poster), CHAT, THREAD, planParts([file("photo"), file("photo")], long, "H"), long);
  assertEquals(e2.sleeps, []);            // 90 s is never waited inside a request
  assertEquals(r2.calls.length, 1);       // nothing after the rate limit is attempted
  assertEquals(run2.failed, 3);
  assertEquals(run2.stoppedEarly, true);
});

Deno.test("postParts: a missing / closed topic stops at once", async () => {
  const e = fakeEngine();
  const r = recorder(() => ({ outcome: out("topic_missing"), result: null }));
  const run = await postParts(depsOf(e, r.poster), CHAT, THREAD, planParts([file("photo"), file("photo"), file("document")], "", "H"), "");
  assertEquals(r.calls.length, 1);
  assertEquals(run.failed, 3);
  assertEquals(run.lastError?.klass, "topic_missing");
});

// ─────────────────────────────── the request ───────────────────────────────
const input = (o: Partial<{ taskId: number; requestId: string; text: string; files: InFile[] }> = {}) =>
  ({ taskId: 7, requestId: "req_abcdef12", text: TEXT, files: [file("photo")], ...o });

Deno.test("handleSubmit: prepare → claim → post into the student's own topic → record the views → capture at the CLAIM time", async () => {
  const e = fakeEngine();
  const r = recorder();
  const rep = await handleSubmit(depsOf(e, r.poster), U, input(), PROFILE);
  assertEquals(rep.status, 200);
  assertEquals(rep.body.ok, true);
  assertEquals(e.rpcs.map((x) => x.name), ["challenge_task_prepare_miniapp", "challenge_task_submit_claim", "challenge_task_submit_record",
    "challenge_task_capture_miniapp"]);
  assertEquals(r.calls[0].method, "sendPhoto");
  assertEquals(r.calls[0].fields.chat_id, CHAT);
  assertEquals(r.calls[0].fields.message_thread_id, THREAD);
  assert(String(r.calls[0].fields.caption).startsWith("📱 Ali Valiyev (@ali_v) — ilova orqali\n📅 5-oktabr · Birinchi vazifa\n\n"));
  const rec = e.rpcs[2].args, cap = e.rpcs[3].args;
  assertEquals(rec._error, null);
  assertEquals(rec._messages[0].caption, TEXT); // the header is NOT part of what the engine judges
  assertEquals(cap._claimed_at, "2026-10-05T18:58:00+00:00");
  assertEquals(cap._messages, rec._messages);
  assertEquals(cap._user, U);
  assertEquals(e.health.length, 0);
});

Deno.test("handleSubmit: the engine says no → nothing claimed, nothing posted, one refusal signal", async () => {
  const e = fakeEngine({ prep: { ok: false, reason: "miniapp_off" } });
  const r = recorder();
  const rep = await handleSubmit(depsOf(e, r.poster), U, input(), PROFILE);
  assertEquals(rep.status, 409);
  assertEquals(rep.body, { error: "not_allowed", reason: "miniapp_off", detail: null, topic_url: null });
  assertEquals(r.calls.length, 0);
  assertEquals(e.rpcs.map((x) => x.name), ["challenge_task_prepare_miniapp"]);
  assertEquals(e.health.map((h) => h.action), ["challenge_task_miniapp_submit_refused"]);
});

Deno.test("handleSubmit: a kind the task does not accept is refused before any claim or post", async () => {
  const e = fakeEngine({ prep: { ...PREP_OK, task: { ...PREP_OK.task, accepts: ["text", "photo"] } } });
  const r = recorder();
  const rep = await handleSubmit(depsOf(e, r.poster), U, input({ files: [file("video")] }), PROFILE);
  assertEquals(rep.status, 400);
  assertEquals(rep.body.error, "kind_not_accepted");
  assertEquals(r.calls.length, 0);
  assertEquals(e.rpcs.some((x) => x.name === "challenge_task_submit_claim"), false);
});

Deno.test("handleSubmit: a retry of a request that already posted captures its recorded items — never a repost", async () => {
  const items = [captureView(photoMsg("x"), TEXT)];
  const e = fakeEngine({
    prep: { ok: false, reason: "done" }, // accepted since: the gate says no, the posted request still finishes
    claimRow: { state: "posted", items, claimed_at: "2026-10-05T18:10:00+00:00", updated_at: "2026-10-05T18:10:05+00:00", error: null, task_id: 7 },
    capture: () => ({ data: { status: "ok", outcome: "duplicate" }, error: null }),
  });
  const r = recorder();
  const rep = await handleSubmit(depsOf(e, r.poster), U, input(), PROFILE);
  assertEquals(rep.status, 200);
  assertEquals(rep.body.replayed, true);
  assertEquals(r.calls.length, 0);
  const cap = e.rpcs.find((x) => x.name === "challenge_task_capture_miniapp")!.args;
  assertEquals(cap._messages, items);
  assertEquals(cap._claimed_at, "2026-10-05T18:10:00+00:00");
});

Deno.test("handleSubmit: a fresh 'claimed' twin is in progress; a failed claim is taken back and keeps its time", async () => {
  const fresh = fakeEngine({ claimRow: { state: "claimed", items: null, claimed_at: "2026-10-05T18:59:00+00:00", updated_at: "2026-10-05T18:59:30+00:00", error: null, task_id: 7 } });
  const r1 = recorder();
  assertEquals((await handleSubmit(depsOf(fresh, r1.poster), U, input(), PROFILE)).body, { error: "in_progress" });
  assertEquals(r1.calls.length, 0);

  const failed = fakeEngine({ claimRow: { state: "failed", items: null, claimed_at: "2026-10-05T18:59:50+00:00", updated_at: "2026-10-05T19:00:10+00:00", error: "Too Many Requests", task_id: 7 } });
  const r2 = recorder();
  const rep = await handleSubmit(depsOf(failed, r2.poster, Date.parse("2026-10-05T19:05:00Z")), U, input(), PROFILE);
  assertEquals(rep.status, 200);
  assertEquals(failed.updates.length, 1);
  assertEquals(failed.updates[0].where, { user_id: U, request_id: "req_abcdef12", state: "failed", updated_at: "2026-10-05T19:00:10+00:00" });
  assertEquals(failed.rpcs.some((x) => x.name === "challenge_task_submit_claim"), false);
  assertEquals(failed.rpcs.find((x) => x.name === "challenge_task_capture_miniapp")!.args._claimed_at, "2026-10-05T18:59:50+00:00");

  const refused = fakeEngine({ claimRow: { state: "failed", items: null, claimed_at: "x", updated_at: "y", error: "not_allowed", task_id: 7 } });
  assertEquals((await handleSubmit(depsOf(refused, recorder().poster), U, input(), PROFILE)).body, { error: "refused", reason: "not_allowed" });
  const reused = fakeEngine({ claimRow: { state: "captured", items: [{}], claimed_at: "x", updated_at: "y", error: null, task_id: 99 } });
  assertEquals((await handleSubmit(depsOf(reused, recorder().poster), U, input(), PROFILE)).body, { error: "request_id_reused" });
});

Deno.test("handleSubmit: nothing lands → the claim is closed as failed with Telegram's reason, 502 with retry_after", async () => {
  const e = fakeEngine();
  const r = recorder(() => ({ outcome: out("rate_limited", 120), result: null }));
  const rep = await handleSubmit(depsOf(e, r.poster), U, input(), PROFILE);
  assertEquals(rep.status, 502);
  assertEquals(rep.body.error, "telegram_post_failed");
  assertEquals(rep.body.retry_after, 120);
  const rec = e.rpcs.find((x) => x.name === "challenge_task_submit_record")!.args;
  assertEquals(rec._messages, null);
  assertEquals(rec._error, "err_rate_limited");
  assertEquals(e.rpcs.some((x) => x.name === "challenge_task_capture_miniapp"), false);
});

Deno.test("handleSubmit: a capture error after the post is 202 pending (the reconciler heals the 'posted' claim), loudly", async () => {
  const e = fakeEngine({ capture: () => ({ data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } }) });
  const rep = await handleSubmit(depsOf(e, recorder().poster), U, input(), PROFILE);
  assertEquals(rep.status, 202);
  assertEquals(rep.body.pending, true);
  assertEquals(e.health.map((h) => h.action), ["challenge_task_miniapp_capture_failed"]);
  assertEquals(e.rpcs.find((x) => x.name === "challenge_task_submit_record")!.args._error, null);
});

Deno.test("handleSubmit: 10 files + a text too long for the caption (11 messages) is refused before any claim or post", async () => {
  const long = "Batafsil hisobot. ".repeat(56); // ~1000 characters: past the caption room under the header
  const e = fakeEngine();
  const r = recorder();
  const rep = await handleSubmit(depsOf(e, r.poster), U, input({ text: long, files: Array.from({ length: 10 }, () => file("photo")) }), PROFILE);
  assertEquals(rep.status, 400);
  assertEquals(rep.body.error, "too_many_files_with_text");
  assertEquals(rep.body.max, 9);
  assertEquals(rep.body.caption_text_max, captionTextMax(buildHeader(PROFILE, { id: 7, date: "2026-10-05", title: "Birinchi vazifa" })));
  assertEquals(r.calls.length, 0);
  assertEquals(e.rpcs.map((x) => x.name), ["challenge_task_prepare_miniapp"]); // no claim, no record, no capture
  assertEquals(e.health.map((h) => h.action), ["challenge_task_miniapp_submit_refused"]);
  assertEquals(e.health[0].details.reason, "too_many_files_with_text");

  // 9 files + the same text: the text message first, then an album of 9 = 10 messages, all recorded and captured
  const e2 = fakeEngine();
  const r2 = recorder();
  const ok = await handleSubmit(depsOf(e2, r2.poster), U, input({ text: long, files: Array.from({ length: 9 }, () => file("photo")) }), PROFILE);
  assertEquals(ok.status, 200);
  assertEquals(r2.calls.map((c) => c.kind), ["text", "album"]);
  assertEquals(r2.calls[1].items!.length, 9);
  const views = e2.rpcs.find((x) => x.name === "challenge_task_capture_miniapp")!.args._messages;
  assertEquals(views.length, MAX_MESSAGES);
  assertEquals(views[0].text, long); // the student's text rides the text message; the album carries the header only
  assertEquals(views.slice(1).some((v: Any) => "caption" in v), false);
});

Deno.test("handleSubmit: capture refused as 'bad_messages' is final — 422, the claim closed as failed, loud, never reposted", async () => {
  const e = fakeEngine({ capture: () => ({ data: { status: "error", outcome: "error", reason: "bad_messages" }, error: null }) });
  const r = recorder();
  const rep = await handleSubmit(depsOf(e, r.poster), U, input(), PROFILE);
  assertEquals(rep.status, 422);
  assertEquals(rep.body.error, "capture_rejected");
  assertEquals(rep.body.reason, "bad_messages");
  const recs = e.rpcs.filter((x) => x.name === "challenge_task_submit_record").map((x) => x.args._error);
  assertEquals(recs, [null, "bad_messages"]); // recorded as posted, then closed (so the heal never loops on it)
  assertEquals(e.health.map((h) => h.action), ["challenge_task_miniapp_capture_rejected"]);

  // a retry of that request: the same answer, nothing taken back, posted or captured
  const again = fakeEngine({ claimRow: { state: "failed", items: [{ message_id: 1 }], claimed_at: "a", updated_at: "b", error: "bad_messages", task_id: 7 } });
  const r2 = recorder();
  const rep2 = await handleSubmit(depsOf(again, r2.poster), U, input(), PROFILE);
  assertEquals(rep2.status, 422);
  assertEquals(rep2.body.error, "capture_rejected");
  assertEquals(r2.calls.length, 0);
  assertEquals(again.updates.length, 0);
  assertEquals(again.rpcs.map((x) => x.name), ["challenge_task_prepare_miniapp"]);

  // any OTHER capture error stays transient: 202 pending, the claim left 'posted' for the reconciler's heal
  const other = fakeEngine({ capture: () => ({ data: { status: "error", reason: "something_else" }, error: null }) });
  const rep3 = await handleSubmit(depsOf(other, recorder().poster), U, input(), PROFILE);
  assertEquals(rep3.status, 202);
  assertEquals(other.rpcs.filter((x) => x.name === "challenge_task_submit_record").length, 1);
});

Deno.test("handleSubmit: a burst of NEW requests is throttled before any claim or post (the bot's group budget)", async () => {
  const e = fakeEngine({ recent: 6 });
  const r = recorder();
  const rep = await handleSubmit(depsOf(e, r.poster), U, input(), PROFILE);
  assertEquals(rep.status, 429);
  assertEquals(rep.body.error, "too_many_requests");
  assertEquals(r.calls.length, 0);
  assertEquals(e.rpcs.some((x) => x.name === "challenge_task_submit_claim"), false);
  assertEquals(e.health.map((h) => h.action), ["challenge_task_miniapp_submit_refused"]);
  // a retry of an EXISTING request is never throttled (it may be finishing work already in the topic)
  const e2 = fakeEngine({ recent: 6, claimRow: { state: "posted", items: [{ message_id: 1 }], claimed_at: "a", updated_at: "b", error: null, task_id: 7 } });
  assertEquals((await handleSubmit(depsOf(e2, recorder().poster), U, input(), PROFILE)).status, 200);
});

Deno.test("handleSubmit: a partial post is captured AND signalled", async () => {
  const e = fakeEngine();
  const r = recorder((c) => (c.kind === "album" ? { outcome: out("content"), result: null } : c.fields._file === "b.jpg" ? { outcome: out("recipient"), result: null } : null));
  const rep = await handleSubmit(depsOf(e, r.poster), U, input({ files: [file("photo", "a.jpg"), file("photo", "b.jpg")] }), PROFILE);
  assertEquals(rep.status, 200);
  assertEquals(rep.body.posted, 1);
  assertEquals(rep.body.failed, 1);
  assertEquals(e.health.map((h) => h.action), ["challenge_task_miniapp_post_partial"]);
});

Deno.test("handlePrepare: the task text only for the student's own posted task; RPC failure is 503 + a signal", async () => {
  const e = fakeEngine();
  const ok = await handlePrepare(depsOf(e, recorder().poster), U, 7);
  assertEquals(ok.body.ok, true);
  assertEquals(ok.body.text, "📅 <b>1-kun vazifasi</b>");
  assertEquals(ok.body.topic_url, "https://t.me/c/4440955972/144");
  assertEquals(e.rpcs[1].args, { _task_id: 7, _tg_user: null });

  for (const reason of ["not_open", "wrong_course", "no_task", "miniapp_off"]) {
    const e2 = fakeEngine({ prep: { ok: false, reason } });
    const rep = await handlePrepare(depsOf(e2, recorder().poster), U, 7);
    assertEquals(rep.body.text, null, reason);
    assertEquals(e2.rpcs.length, 1, reason);
  }
  const done = fakeEngine({ prep: { ok: false, reason: "done", submission_id: 3 } });
  assertEquals((await handlePrepare(depsOf(done, recorder().poster), U, 7)).body.text, "📅 <b>1-kun vazifasi</b>");

  // the caption room: exact under THIS student's header when the profile is given, the safe room otherwise
  assertEquals((await handlePrepare(depsOf(fakeEngine(), recorder().poster), U, 7, PROFILE)).body.limits,
    { max_items: 10, max_photo_bytes: MAX_PHOTO_BYTES, max_file_bytes: 50 * 1024 * 1024, max_text: 3500, max_messages: MAX_MESSAGES,
      caption_text_max: captionTextMax(buildHeader(PROFILE, { id: 7, date: "2026-10-05", title: "Birinchi vazifa" })) });
  assertEquals(((await handlePrepare(depsOf(fakeEngine(), recorder().poster), U, 7)).body.limits as Any)?.caption_text_max, CAPTION_TEXT_SAFE);
  assertEquals(((await handlePrepare(depsOf(fakeEngine(), recorder().poster), U, null, null)).body.limits as Any)?.caption_text_max, CAPTION_TEXT_SAFE);

  const broken = fakeEngine({ prepErr: { code: "PGRST202", message: "Could not find the function" } });
  const rep = await handlePrepare(depsOf(broken, recorder().poster), U, null);
  assertEquals(rep.status, 503);
  assertEquals(broken.health[0].action, "challenge_task_miniapp_rpc_failed");
});
