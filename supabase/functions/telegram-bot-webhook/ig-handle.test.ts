import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { captureIgReply, IG_STATE, saveHandle, startIgFlow } from "./ig-handle.ts";

// A small fake of the supabase-js chains ig-handle.ts uses. Each query records its table, op, filters and payload;
// `answer` decides the result.
type Q = { table: string; op: string; filters: Record<string, unknown>; payload?: any };
function fakeDb(o: {
  parse?: (input: string) => { data: any; error: any };
  answer: (q: Q) => { data?: any; error?: any };
}) {
  const log: Q[] = [];
  const builder = (table: string) => {
    const q: Q = { table, op: "select", filters: {} };
    const run = () => {
      log.push(q);
      const r = o.answer(q) ?? {};
      return Promise.resolve({ data: r.data ?? null, error: r.error ?? null });
    };
    const b: any = {
      select: (_c?: string) => { if (q.op === "select") q.op = "select"; return b; },
      update: (p: any) => { q.op = "update"; q.payload = p; return b; },
      upsert: (p: any) => { q.op = "upsert"; q.payload = p; return run(); },
      insert: (p: any) => { q.op = "insert"; q.payload = p; return run(); },
      delete: () => { q.op = "delete"; return b; },
      eq: (k: string, v: unknown) => { q.filters[k] = v; return b; },
      in: (k: string, v: unknown) => { q.filters[k] = v; return b; },
      gte: (k: string, v: unknown) => { q.filters[`gte:${k}`] = v; return b; },
      lt: (k: string, v: unknown) => { q.filters[`lt:${k}`] = v; return b; },
      limit: (_n: number) => b,
      maybeSingle: () => run(),
      then: (res: any, rej: any) => run().then(res, rej),
    };
    return b;
  };
  const admin = {
    from: (t: string) => builder(t),
    rpc: (name: string, args: any) => {
      log.push({ table: `rpc:${name}`, op: "rpc", filters: args });
      return Promise.resolve(o.parse ? o.parse(args.p_input) : { data: null, error: null });
    },
  };
  return { admin, log };
}

// public.instagram_handle_parse, the same rule as the DB (only the cases the tests use)
const parse = (input: string) => {
  const v = input.trim().toLowerCase().replace(/^@+/, "");
  if (!v) return { data: { handle: null, reason: null }, error: null };
  if (/instagram\.com\/p\//.test(v)) return { data: { handle: null, reason: "not_profile_link" }, error: null };
  if (!/^[a-z0-9._]+$/.test(v)) return { data: [{ handle: null, reason: "bad_chars" }], error: null };
  return { data: [{ handle: v, reason: null }], error: null };
};

const P = "11111111-1111-1111-1111-111111111111";

function world(o: { current?: string | null; locked?: boolean; admin?: boolean; updateErr?: any; storedAfter?: string | null; lockCfg?: boolean } = {}) {
  return fakeDb({
    parse,
    answer: (q) => {
      if (q.table === "profiles" && q.op === "select") return { data: { instagram_username: o.current ?? null } };
      if (q.table === "platform_settings") return { data: { value: { ig: { lock_handle_after_accept: o.lockCfg ?? true } } } };
      if (q.table === "user_roles") return { data: o.admin ? [{ role: "admin" }] : [] };
      if (q.table === "challenge_task_submissions") return { data: o.locked ? [{ id: 1 }] : [] };
      if (q.table === "profiles" && q.op === "update") {
        if (o.updateErr) return { error: o.updateErr };
        const stored = o.storedAfter === undefined ? q.payload.instagram_username : o.storedAfter;
        return { data: [{ instagram_username: stored }] };
      }
      return { data: null };
    },
  });
}

Deno.test("saveHandle: a clean handle is parsed, written and verified", async () => {
  const { admin, log } = world();
  assertEquals(await saveHandle(admin, P, "  @Aziza.Creates "), { kind: "saved", handle: "aziza.creates" });
  const upd = log.find((q) => q.table === "profiles" && q.op === "update");
  assertEquals(upd?.payload, { instagram_username: "aziza.creates" });
  assertEquals(upd?.filters.id, P);
});

Deno.test("saveHandle: the website's parse reasons come back, nothing is written", async () => {
  const { admin, log } = world();
  assertEquals(await saveHandle(admin, P, "Азиза"), { kind: "rejected", reason: "bad_chars" });
  assertEquals(await saveHandle(admin, P, "https://instagram.com/p/AbC123/"), { kind: "rejected", reason: "not_profile_link" });
  assertEquals(log.some((q) => q.op === "update"), false);
});

Deno.test("saveHandle: a blank message never clears a saved handle (rejected as empty)", async () => {
  const { admin, log } = world({ current: "aziza" });
  assertEquals(await saveHandle(admin, P, "   "), { kind: "rejected", reason: "empty" });
  assertEquals(log.some((q) => q.op === "update"), false);
});

Deno.test("saveHandle: the same handle is 'same', no write", async () => {
  const { admin, log } = world({ current: "aziza" });
  assertEquals(await saveHandle(admin, P, "@AZIZA"), { kind: "same", handle: "aziza" });
  assertEquals(log.some((q) => q.op === "update"), false);
});

Deno.test("saveHandle: after an accepted Instagram task the handle is locked (the service role skips the DB guard)", async () => {
  const { admin, log } = world({ current: "aziza", locked: true });
  assertEquals(await saveHandle(admin, P, "@other"), { kind: "locked", handle: "aziza" });
  assertEquals(log.some((q) => q.op === "update"), false);
  const sub = log.find((q) => q.table === "challenge_task_submissions");
  assertEquals(sub?.filters.status, "accepted");
  assertEquals(sub?.filters["challenge_tasks.type"], "instagram");
});

Deno.test("saveHandle: the lock is off when the config says so, and admins are never locked", async () => {
  assertEquals((await saveHandle(world({ current: "a", locked: true, lockCfg: false }).admin, P, "b")).kind, "saved");
  assertEquals((await saveHandle(world({ current: "a", locked: true, admin: true }).admin, P, "b")).kind, "saved");
});

Deno.test("saveHandle: a unique violation is 'taken'; any other DB error is 'error'", async () => {
  assertEquals(await saveHandle(world({ updateErr: { code: "23505", message: "dup" } }).admin, P, "x"), { kind: "taken" });
  assertEquals(await saveHandle(world({ updateErr: { code: "XX000", message: "boom" } }).admin, P, "x"), { kind: "error" });
});

Deno.test("saveHandle: a write the DB silently kept at the old value is NOT reported as saved", async () => {
  const { admin } = world({ current: "aziza", storedAfter: "aziza" });
  assertEquals(await saveHandle(admin, P, "newname"), { kind: "error" });
});

Deno.test("saveHandle: a failed parse RPC is 'error', never a write", async () => {
  const db = fakeDb({ parse: () => ({ data: null, error: { message: "down" } }), answer: () => ({ data: null }) });
  assertEquals(await saveHandle(db.admin, P, "aziza"), { kind: "error" });
  assertEquals(db.log.some((q) => q.op === "update"), false);
});

// ── the conversation ────────────────────────────────────────────────────────────────────────────────────────
function convo(state: any, w: Parameters<typeof world>[0] = {}) {
  const base = world(w);
  const sent: string[] = [];
  const admin = {
    ...base.admin,
    from: (t: string) => {
      if (t !== "bot_conversation_state") return base.admin.from(t);
      const b: any = {
        _op: "select",
        select: () => b, eq: () => b,
        delete: () => { b._op = "delete"; base.log.push({ table: t, op: "delete", filters: {} }); return b; },
        upsert: (p: any) => { base.log.push({ table: t, op: "upsert", filters: {}, payload: p }); return Promise.resolve({ error: null }); },
        maybeSingle: () => Promise.resolve({ data: state, error: null }),
        then: (res: any) => Promise.resolve({ error: null }).then(res),
      };
      return b;
    },
  };
  const deps = { send: (_c: number, html: string) => { sent.push(html); return Promise.resolve(); }, isMenuButton: (t: string) => t === "📚 Davom etish" };
  return { admin, log: base.log, sent, deps };
}
const msg = { chat: { id: 5 }, from: { id: 777 } };
const live = (extra: any = {}) => ({ state: IG_STATE, expires_at: new Date(Date.now() + 60_000).toISOString(), context: { profile_id: P }, ...extra });

Deno.test("capture: not waiting → not consumed, nothing sent", async () => {
  const c = convo(null);
  assertEquals(await captureIgReply(c.admin, msg, P, "uz", "aziza", c.deps), false);
  assertEquals(c.sent.length, 0);
});

Deno.test("capture: a good reply saves, answers in Uzbek and ends the flow", async () => {
  const c = convo(live());
  assertEquals(await captureIgReply(c.admin, msg, P, "uz", "@aziza", c.deps), true);
  assertStringIncludes(c.sent[0], "Saqlandi");
  assertStringIncludes(c.sent[0], "@aziza");
  assertEquals(c.log.some((q) => q.table === "bot_conversation_state" && q.op === "delete"), true);
});

Deno.test("capture: a bad reply explains the rule and keeps waiting for another try", async () => {
  const c = convo(live());
  assertEquals(await captureIgReply(c.admin, msg, P, "uz", "Азиза", c.deps), true);
  assertStringIncludes(c.sent[0], "lotin harflari");
  assertEquals(c.log.some((q) => q.table === "bot_conversation_state" && q.op === "delete"), false);
  assertEquals(c.log.some((q) => q.table === "admin_actions" || q.op === "insert"), true); // ig_handle_bot_refused
});

Deno.test("capture: a menu button while waiting is NOT a username — the flow ends and the button works", async () => {
  const c = convo(live());
  assertEquals(await captureIgReply(c.admin, msg, P, "uz", "📚 Davom etish", c.deps), false);
  assertEquals(c.sent.length, 0);
  assertEquals(c.log.some((q) => q.op === "update"), false);
});

Deno.test("capture: an expired or someone else's state is dropped, not consumed", async () => {
  const c1 = convo(live({ expires_at: new Date(Date.now() - 1000).toISOString() }));
  assertEquals(await captureIgReply(c1.admin, msg, P, "uz", "aziza", c1.deps), false);
  const c2 = convo(live({ context: { profile_id: "someone-else" } }));
  assertEquals(await captureIgReply(c2.admin, msg, P, "uz", "aziza", c2.deps), false);
  assertEquals(c2.log.some((q) => q.op === "update"), false);
});

Deno.test("capture: locked → the curator message, flow ends", async () => {
  const c = convo(live(), { current: "aziza", locked: true });
  assertEquals(await captureIgReply(c.admin, msg, P, "ru", "other", c.deps), true);
  assertStringIncludes(c.sent[0], "куратору");
});

Deno.test("start: shows the current handle when there is one, and opens the 15-minute wait", async () => {
  const c = convo(null, { current: "aziza" });
  await startIgFlow(c.admin, 5, 777, P, "uz", c.deps);
  assertStringIncludes(c.sent[0], "@aziza");
  const up = c.log.find((q) => q.table === "bot_conversation_state" && q.op === "upsert");
  assertEquals(up?.payload.state, IG_STATE);
  assertEquals(up?.payload.context, { profile_id: P });
  const c2 = convo(null, { current: null });
  await startIgFlow(c2.admin, 5, 777, P, "uz", c2.deps);
  assertStringIncludes(c2.sent[0], "yozib yuboring");
});
