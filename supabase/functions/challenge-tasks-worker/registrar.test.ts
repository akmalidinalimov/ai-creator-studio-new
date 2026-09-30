// Unit tests for the identity sweep's registrar (registrar.ts) over a fake client, a recording sender and a stubbed
// admin-create-students engine. No network, no permissions.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { SendResultOutcome } from "../_shared/telegram-send.ts";
import { registerDailyTaskPoster, type RegisterInput, type SendFn } from "./registrar.ts";

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

const ok: SendResultOutcome = { ok: true, status: 200, error: null, terminal: false, recipient: false, content: false, klass: "ok", retryAfterSec: null };
const INPUT: RegisterInput = {
  from: { id: 4242, username: "new_kid", first_name: "Nodira", last_name: "Q" }, chatId: -1004390902020, threadId: 99, messageId: 7,
  groupId: "g2", courseId: "c6",
};

function world(opts: { secret?: string | null; profileAfter?: Row | null; updRows?: number } = {}) {
  const inserts: Row[] = [];
  const updates: Row[] = [];
  const admin = {
    rpc: (name: string) => Promise.resolve({ data: name === "internal_fn_secret" ? (opts.secret === undefined ? "s3cret" : opts.secret) : null, error: null }),
    from(table: string) {
      let op = "select";
      let payload: Row | null = null;
      const b: Row = {
        select: () => b, eq: () => b, gte: () => b, limit: () => b,
        update: (row: Row) => { op = "update"; payload = row; return b; },
        insert: (row: Row) => { inserts.push({ table, ...row }); return Promise.resolve({ data: null, error: null }); },
        maybeSingle: () => Promise.resolve({ data: table === "profiles" ? (opts.profileAfter ?? null) : null, error: null }),
        then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => {
          if (op === "update") updates.push({ table, ...payload });
          const data = op === "update" ? Array.from({ length: opts.updRows ?? 1 }, () => ({ id: "x" })) : [];
          return Promise.resolve({ data, error: null }).then(res, rej);
        },
      };
      return b;
    },
  };
  return { admin, inserts, updates };
}

function engine(result: Row, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(new Response(JSON.stringify(result), { status }));
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

const member = (status: string): SendFn => () => Promise.resolve({ outcome: ok, result: { status } });

Deno.test("a chat admin is never registered: one skip row, no engine call", async () => {
  const w = world();
  const e = engine({});
  const p = await registerDailyTaskPoster({ admin: w.admin, send: member("administrator"), fetchFn: e.fetchFn, supabaseUrl: "https://x", serviceKey: "k" }, INPUT);
  assertEquals(p, null);
  assertEquals(e.calls.length, 0);
  assertEquals(w.inserts.map((i) => [i.action, i.details.reason]), [["challenge_task_autoreg_skipped", "chat_admin"]]);
});

Deno.test("a member: the engine (x-internal-secret, no account_type), provisional only when CREATED, audited", async () => {
  const w = world({ profileAfter: { id: "u-new", telegram_id: 4242 } });
  const e = engine({ results: [{ userId: "u-new", status: "created" }] });
  const sent: Row[] = [];
  const send: SendFn = (method, payload, opts) => { sent.push({ method, payload, opts }); return Promise.resolve({ outcome: ok, result: { status: "member" } }); };
  const p = await registerDailyTaskPoster({ admin: w.admin, send, fetchFn: e.fetchFn, supabaseUrl: "https://x", serviceKey: "k" }, INPUT);
  assertEquals(p?.id, "u-new");
  assertEquals(sent[0].method, "getChatMember");
  assertEquals(sent[0].opts.record, false, "a probe is never a delivery failure");
  assertEquals(e.calls[0].url, "https://x/functions/v1/admin-create-students");
  const h = e.calls[0].init.headers as Row;
  assertEquals(h["x-internal-secret"], "s3cret");
  const body = JSON.parse(String(e.calls[0].init.body));
  assertEquals(body.target_group_id, "g2");
  assertEquals(body.target_course_id, "c6");
  assertEquals(body.students[0].telegram_user_id, 4242);
  assertEquals(body.students[0].name, "Nodira");
  assert(!("account_type" in body.students[0]), "a matched platform student is never downgraded");
  assertEquals(w.updates, [{ table: "profiles", account_type: "provisional" }]);
  assert(w.inserts.some((i) => i.action === "auto_registered_provisional" && i.target_user_id === "u-new"));
});

Deno.test("an existing account matched by the engine keeps its type; a refusal / missing secret is DB-visible", async () => {
  const w1 = world({ profileAfter: { id: "u-old" } });
  const p1 = await registerDailyTaskPoster({ admin: w1.admin, send: member("member"), fetchFn: engine({ results: [{ userId: "u-old", status: "linked" }] }).fetchFn,
    supabaseUrl: "https://x", serviceKey: "k" }, INPUT);
  assertEquals(p1?.id, "u-old");
  assertEquals(w1.updates.length, 0);

  const w2 = world();
  const p2 = await registerDailyTaskPoster({ admin: w2.admin, send: member("member"), fetchFn: engine({ results: [{ status: "role_conflict", error: "staff" }] }).fetchFn,
    supabaseUrl: "https://x", serviceKey: "k" }, INPUT);
  assertEquals(p2, null);
  assertEquals(w2.inserts.map((i) => [i.action, i.details.reason, i.details.via]), [["auto_register_failed", "engine_refused", "identity_sweep"]]);

  const w3 = world({ secret: null });
  const e3 = engine({});
  assertEquals(await registerDailyTaskPoster({ admin: w3.admin, send: member("member"), fetchFn: e3.fetchFn, supabaseUrl: "https://x", serviceKey: "k" }, INPUT), null);
  assertEquals(e3.calls.length, 0);
  assertEquals(w3.inserts[0].details.reason, "internal_secret_missing");

  const w4 = world({ profileAfter: null });
  assertEquals(await registerDailyTaskPoster({ admin: w4.admin, send: member("member"), fetchFn: engine({ results: [{ userId: "u9", status: "created" }] }).fetchFn,
    supabaseUrl: "https://x", serviceKey: "k" }, INPUT), null);
  assert(w4.inserts.some((i) => i.action === "auto_register_failed" && i.details.reason === "profile_not_linked"));
});

Deno.test("a bot sender or a missing group never reaches the engine", async () => {
  const w = world();
  const e = engine({});
  const d = { admin: w.admin, send: member("member"), fetchFn: e.fetchFn, supabaseUrl: "https://x", serviceKey: "k" };
  assertEquals(await registerDailyTaskPoster(d, { ...INPUT, from: { id: 1, is_bot: true } }), null);
  assertEquals(await registerDailyTaskPoster(d, { ...INPUT, groupId: "" }), null);
  assertEquals(e.calls.length, 0);
});
