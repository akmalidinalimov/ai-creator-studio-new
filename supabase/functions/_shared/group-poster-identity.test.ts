// Tests for the group-poster identity resolver. Run: deno test supabase/functions/_shared/group-poster-identity.test.ts
//
// Two layers: the pure core over hand-written deps (every gate, every outcome), and the real I/O layer over an
// in-memory PostgREST stand-in (the exact query chains: the escaped ilike, the .is("telegram_id", null) guard,
// the defensive daily_task_topic_id retry, the admin_actions rows).
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type ChatGroup, type GroupPosterDeps, type GroupPosterInput, type GroupPosterUnresolvedReason, resolveGroupPoster,
  resolveGroupPosterWith, topicMatches, type UsernameCandidate, usernameLinkVerdict,
} from "./group-poster-identity.ts";

// ---------------------------------------------------------------------------------------------------------
// Pure helpers.

const G = (o: Partial<ChatGroup> & { id: string }): ChatGroup => ({
  course_id: "c-6", homework_topic_id: null, module_topic_ids: [], daily_task_topic_id: null, ...o,
});

Deno.test("topicMatches: homework / module / daily kinds, course-less groups never match", () => {
  const g = G({ id: "g1", homework_topic_id: 3, module_topic_ids: [11], daily_task_topic_id: 144 });
  assertEquals(topicMatches(g, 3, ["homework", "module"]), true);
  assertEquals(topicMatches(g, 11, ["homework", "module"]), true);
  assertEquals(topicMatches(g, 144, ["homework", "module"]), false); // the daily topic is not a homework topic
  assertEquals(topicMatches(g, 144, ["daily_task"]), true);
  assertEquals(topicMatches(g, 3, ["daily_task"]), false);
  assertEquals(topicMatches(g, 1, ["homework", "module", "daily_task"]), false); // General
  assertEquals(topicMatches({ ...g, course_id: null }, 3, ["homework"]), false);
});

const cand = (o: Partial<UsernameCandidate> = {}): UsernameCandidate => ({
  id: "p-intake", telegram_username: "Malika_07", telegram_id: null, group_id: "g1", status: "active", archived_at: null,
  roles: ["student"], ...o,
});
const chat = new Set(["g1", "g1-old-cohort"]);

Deno.test("verdict: the intake student (student, unlinked, active, group in this chat) → link", () => {
  assertEquals(usernameLinkVerdict([cand()], "@malika_07", chat, 42), { kind: "link", profileId: "p-intake" });
});

Deno.test("verdict: a group that shares the chat (a reused cohort chat) still counts as this chat", () => {
  assertEquals(usernameLinkVerdict([cand({ group_id: "g1-old-cohort" })], "malika_07", chat, 42).kind, "link");
});

Deno.test("verdict: every refusal, each with its own reason", () => {
  const r = (c: UsernameCandidate[]) => {
    const v = usernameLinkVerdict(c, "malika_07", chat, 42);
    return v.kind === "refuse" ? v.reason : v.kind;
  };
  assertEquals(r([cand(), cand({ id: "p-2" })]), "username_ambiguous");
  assertEquals(r([cand({ telegram_id: 999 })]), "username_linked_elsewhere");
  assertEquals(r([cand({ roles: ["student", "teacher"] })]), "username_not_student");
  assertEquals(r([cand({ roles: ["admin"] })]), "username_not_student");
  assertEquals(r([cand({ roles: [] })]), "username_not_student");
  assertEquals(r([cand({ status: "archived" })]), "username_inactive");
  assertEquals(r([cand({ archived_at: "2026-07-18T00:00:00Z" })]), "username_inactive");
  assertEquals(r([cand({ group_id: null })]), "username_no_group");
  assertEquals(r([cand({ group_id: "g-other-chat" })]), "username_other_chat");
});

Deno.test("verdict: already linked to THIS sender → link (the guarded write is a no-op, the re-read finds it)", () => {
  assertEquals(usernameLinkVerdict([cand({ telegram_id: "42" })], "malika_07", chat, 42), { kind: "link", profileId: "p-intake" });
});

Deno.test("verdict: rows that are not an EXACT username match are ignored (a sloppy lookup cannot widen it)", () => {
  assertEquals(usernameLinkVerdict([cand({ telegram_username: "malika_071" }), cand({ telegram_username: "malikax07" })], "malika_07", chat, 42),
    { kind: "none" });
  assertEquals(usernameLinkVerdict([cand()], "", chat, 42), { kind: "none" });
});

// ---------------------------------------------------------------------------------------------------------
// Core over hand-written deps.

type P = { id: string; telegram_id: number };

function deps(o: {
  byId?: Record<number, P>;
  groups?: ChatGroup[] | null;
  cands?: UsernameCandidate[] | null;
  link?: "linked" | "not_linked" | "error";
  linkSideEffect?: (pid: string, tg: number) => void;
} = {}) {
  const byId: Record<number, P> = { ...(o.byId ?? {}) };
  const calls = { usernameLookups: 0, links: [] as Array<[string, number]>, linked: [] as string[], unresolved: [] as Array<{ reason: GroupPosterUnresolvedReason; target: string | null; d: Record<string, unknown> }> };
  const d: GroupPosterDeps<P> = {
    findByTelegramId: async (tg) => byId[tg] ?? null,
    groupsInChat: async () => o.groups === undefined ? [G({ id: "g1", homework_topic_id: 3 })] : o.groups,
    findByUsername: async () => { calls.usernameLookups++; return o.cands === undefined ? [] : o.cands; },
    linkTelegramId: async (pid, tg) => {
      calls.links.push([pid, tg]);
      const res = o.link ?? "linked";
      if (res === "linked") byId[tg] = { id: pid, telegram_id: tg };
      o.linkSideEffect?.(pid, tg);
      return res;
    },
    recordLinked: async (_d, pid) => { calls.linked.push(pid); },
    recordUnresolved: async (reason, dd, target) => { calls.unresolved.push({ reason, target, d: dd }); },
  };
  return { d, calls, byId };
}

const input = (o: Partial<GroupPosterInput> = {}): GroupPosterInput => ({
  from: { id: 42, username: "Malika_07" }, chatId: -1004440955972, threadId: 3, messageId: 900,
  topicKinds: ["homework", "module"], source: "homework_topic_post", ...o,
});

function registrar(ret: P | null = null) {
  const r = { calls: 0, fn: async () => { r.calls++; return ret; } };
  return r;
}

Deno.test("core: a linked sender resolves by telegram_id — no username lookup, no registration, no signal", async () => {
  const { d, calls } = deps({ byId: { 42: { id: "p-1", telegram_id: 42 } } });
  const reg = registrar();
  const r = await resolveGroupPosterWith(d, input(), reg.fn);
  assertEquals([r.via, r.reason, r.profile?.id], ["telegram_id", "telegram_id", "p-1"]);
  assertEquals([calls.usernameLookups, reg.calls, calls.unresolved.length], [0, 0, 0]);
});

Deno.test("core: no sender / a bot → silent, nothing called", async () => {
  for (const from of [null, undefined, {}, { id: 7, is_bot: true }, { id: -5 }]) {
    const { d, calls } = deps();
    const reg = registrar();
    const r = await resolveGroupPosterWith(d, input({ from: from as GroupPosterInput["from"] }), reg.fn);
    assertEquals(r.reason, "no_sender");
    assertEquals([calls.usernameLookups, reg.calls, calls.unresolved.length], [0, 0, 0]);
  }
});

Deno.test("core: a post outside a registered topic (general chat) → silent: no link, no registration, no signal", async () => {
  const { d, calls } = deps({ cands: [cand()] });
  const reg = registrar();
  const r = await resolveGroupPosterWith(d, input({ threadId: 1 }), reg.fn);
  assertEquals(r.reason, "not_registered_topic");
  assertEquals([calls.usernameLookups, calls.links.length, reg.calls, calls.unresolved.length], [0, 0, 0, 0]);
});

Deno.test("core: THE FIX — an intake student (username only) posting homework is linked and resolved", async () => {
  const { d, calls } = deps({ cands: [cand()] });
  const reg = registrar();
  const r = await resolveGroupPosterWith(d, input(), reg.fn);
  assertEquals([r.via, r.reason, r.profile?.id], ["username_link", "username_link", "p-intake"]);
  assertEquals(calls.links, [["p-intake", 42]]);
  assertEquals(calls.linked, ["p-intake"]);
  assertEquals([reg.calls, calls.unresolved.length], [0, 0]); // the engine is never asked
});

Deno.test("core: a refused username match is recorded and NEVER handed to the registration engine", async () => {
  const cases: Array<[Partial<UsernameCandidate>, GroupPosterUnresolvedReason]> = [
    [{ telegram_id: 7658778572 }, "username_linked_elsewhere"],
    [{ roles: ["teacher"] }, "username_not_student"],
    [{ status: "archived" }, "username_inactive"],
    [{ group_id: null }, "username_no_group"],
    [{ group_id: "g-5-0" }, "username_other_chat"],
  ];
  for (const [o, reason] of cases) {
    const { d, calls } = deps({ cands: [cand(o)] });
    const reg = registrar({ id: "should-not-happen", telegram_id: 42 });
    const r = await resolveGroupPosterWith(d, input(), reg.fn);
    assertEquals([r.profile, r.via, r.reason], [null, null, reason]);
    assertEquals([calls.links.length, reg.calls], [0, 0]);
    assertEquals(calls.unresolved.map((u) => [u.reason, u.target]), [[reason, "p-intake"]]);
    assertEquals(calls.unresolved[0].d.matched_user_id, "p-intake");
    assertEquals(calls.unresolved[0].d.group_ids, ["g1"]);
  }
});

Deno.test("core: ambiguous username → recorded, no link, no registration", async () => {
  const { d, calls } = deps({ cands: [cand(), cand({ id: "p-2" })] });
  const reg = registrar();
  const r = await resolveGroupPosterWith(d, input(), reg.fn);
  assertEquals(r.reason, "username_ambiguous");
  assertEquals([calls.links.length, reg.calls, calls.unresolved.length], [0, 0, 1]);
});

Deno.test("core: an album sibling linked first (0 rows) → resolved by telegram_id, no second audit row", async () => {
  const h = deps({ cands: [cand()], link: "not_linked", linkSideEffect: (pid, tg) => { h.byId[tg] = { id: pid, telegram_id: tg }; } });
  const r = await resolveGroupPosterWith(h.d, input(), registrar().fn);
  assertEquals([r.via, r.reason, r.profile?.id], ["telegram_id", "telegram_id", "p-intake"]);
  assertEquals([h.calls.linked.length, h.calls.unresolved.length], [0, 0]);
});

Deno.test("core: 0 rows and nobody holds the id → link_race_lost; a write error → link_failed", async () => {
  for (const [link, reason] of [["not_linked", "link_race_lost"], ["error", "link_failed"]] as const) {
    const { d, calls } = deps({ cands: [cand()], link });
    const reg = registrar();
    const r = await resolveGroupPosterWith(d, input(), reg.fn);
    assertEquals([r.profile, r.reason], [null, reason]);
    assertEquals([calls.linked.length, reg.calls], [0, 0]);
    assertEquals(calls.unresolved.map((u) => u.reason), [reason]);
  }
});

Deno.test("core: nobody carries the username (or the sender has none) → the registrar runs", async () => {
  for (const from of [{ id: 42, username: "brand_new" }, { id: 42 }]) {
    const { d } = deps({ cands: [] });
    const reg = registrar({ id: "p-new", telegram_id: 42 });
    const r = await resolveGroupPosterWith(d, input({ from }), reg.fn);
    assertEquals([r.via, r.profile?.id, reg.calls], ["auto_register", "p-new", 1]);
  }
});

Deno.test("core: the registrar declines → silent here (it wrote its own row)", async () => {
  const { d, calls } = deps({ cands: [] });
  const r = await resolveGroupPosterWith(d, input(), registrar(null).fn);
  assertEquals([r.profile, r.reason, calls.unresolved.length], [null, "auto_register_declined", 0]);
});

Deno.test("core: no registrar supplied and nothing matched → no_account is recorded", async () => {
  const { d, calls } = deps({ cands: [] });
  const r = await resolveGroupPosterWith(d, input());
  assertEquals(r.reason, "no_account");
  assertEquals(calls.unresolved.map((u) => u.reason), ["no_account"]);
});

Deno.test("core: a failed lookup fails CLOSED (recorded, no link, no registration)", async () => {
  for (const o of [{ groups: null }, { cands: null }] as const) {
    const { d, calls } = deps(o as { groups?: null; cands?: null });
    const reg = registrar({ id: "x", telegram_id: 42 });
    const r = await resolveGroupPosterWith(d, input(), reg.fn);
    assertEquals([r.profile, r.reason, reg.calls, calls.links.length], [null, "lookup_failed", 0, 0]);
    assertEquals(calls.unresolved.map((u) => u.reason), ["lookup_failed"]);
  }
});

// ---------------------------------------------------------------------------------------------------------
// The real I/O layer over an in-memory PostgREST stand-in.

type Row = Record<string, unknown>;

function likeToRegex(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\" && i + 1 < pattern.length) { out += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); continue; }
    if (c === "%") out += ".*";
    else if (c === "_") out += ".";
    else out += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`, "i");
}

function fakeDb(tables: Record<string, Row[]>, opts: { missingColumns?: Record<string, string[]>; failTable?: string } = {}) {
  const log: string[] = [];
  const db = {
    from(table: string) {
      const rows = (tables[table] ??= []);
      const filters: Array<(r: Row) => boolean> = [];
      let op: "select" | "update" | "insert" = "select";
      let cols = "*";
      let patch: Row = {};
      let lim = Infinity;
      let err: { code: string; message: string } | null = null;
      const q: Record<string, unknown> = {
        select(c?: string) {
          if (op === "select") cols = c ?? "*";
          for (const m of opts.missingColumns?.[table] ?? []) {
            if (op === "select" && cols.includes(m)) err = { code: "42703", message: `column ${table}.${m} does not exist` };
          }
          log.push(`${table}.${op}(${c ?? ""})`);
          return q;
        },
        update(p: Row) { op = "update"; patch = p; return q; },
        insert(row: Row) {
          rows.push({ ...row, created_at: new Date().toISOString() });
          return Promise.resolve({ error: null });
        },
        eq(col: string, v: unknown) {
          log.push(`${table}.eq(${col})`);
          filters.push((r) => col.includes("->>")
            ? String((r[col.split("->>")[0]] as Row | undefined)?.[col.split("->>")[1]]) === String(v)
            : String(r[col]) === String(v));
          return q;
        },
        neq(col: string, v: unknown) { filters.push((r) => String(r[col]) !== String(v)); return q; },
        is(col: string, v: null) { log.push(`${table}.is(${col},${v})`); filters.push((r) => r[col] === v || r[col] === undefined); return q; },
        in(col: string, vs: unknown[]) { filters.push((r) => vs.map(String).includes(String(r[col]))); return q; },
        gte(col: string, v: string) { filters.push((r) => String(r[col]) >= v); return q; },
        ilike(col: string, pat: string) {
          log.push(`${table}.ilike(${col},${pat})`);
          const re = likeToRegex(pat);
          filters.push((r) => r[col] != null && re.test(String(r[col])));
          return q;
        },
        or(expr: string) {
          log.push(`${table}.or(${expr})`);
          const parts = expr.split(",").map((p) => { const [c, , ...rest] = p.split("."); return { c, re: likeToRegex(rest.join(".")) }; });
          filters.push((r) => parts.some(({ c, re }) => r[c] != null && re.test(String(r[c]))));
          return q;
        },
        limit(n: number) { lim = n; return q; },
        maybeSingle() { return run().then((res) => ({ data: (res.data as Row[] | null)?.[0] ?? null, error: res.error })); },
        then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) { return run().then(resolve, reject); },
      };
      const run = (): Promise<{ data: unknown; error: unknown }> => {
        if (opts.failTable === table) return Promise.resolve({ data: null, error: { code: "XX000", message: "db down" } });
        if (err) return Promise.resolve({ data: null, error: err });
        const hit = rows.filter((r) => filters.every((f) => f(r))).slice(0, lim);
        if (op === "update") {
          for (const r of hit) Object.assign(r, patch);
          return Promise.resolve({ data: hit.map((r) => ({ id: r.id })), error: null });
        }
        // Project the selected columns, as PostgREST does (a column you did not ask for is not there).
        const pick = cols === "*" ? null : cols.split(",").map((c) => c.trim());
        return Promise.resolve({
          data: hit.map((r) => pick ? Object.fromEntries(pick.map((c) => [c, r[c] ?? null])) : { ...r }),
          error: null,
        });
      };
      return q;
    },
  };
  return { db, tables, log };
}

// Chat ids are unique per test: logHealthOnce keeps an isolate-local dedupe memo (shared module state).
let nextChat = 4440955972;
const nextChatId = () => Number(`-100${++nextChat}`);

function world(chatId: number, extra: { profiles?: Row[]; groups?: Row[] } = {}) {
  const stripped = String(chatId).replace(/^-100/, "");
  return {
    profiles: [
      { id: "p-intake", telegram_username: "Malika_07", telegram_id: null, group_id: "g-6", status: "active", archived_at: null },
      { id: "p-linked", telegram_username: "zamira2013", telegram_id: 8622111901, group_id: "g-6", status: "active", archived_at: null },
      { id: "p-teacher", telegram_username: "ustoz_ali", telegram_id: null, group_id: "g-6", status: "active", archived_at: null },
      { id: "p-alice", telegram_username: "alice1", telegram_id: null, group_id: "g-6", status: "active", archived_at: null },
      { id: "p-5", telegram_username: "vip_5", telegram_id: null, group_id: "g-5", status: "active", archived_at: null },
      ...(extra.profiles ?? []),
    ],
    user_roles: [
      { user_id: "p-intake", role: "student" }, { user_id: "p-linked", role: "student" }, { user_id: "p-teacher", role: "teacher" },
      { user_id: "p-alice", role: "student" }, { user_id: "p-5", role: "student" },
    ],
    groups: [
      { id: "g-6", course_id: "c-6", homework_topic_id: 3, homework_topic_url: `https://t.me/c/${stripped}/3`, telegram_group_url: null },
      { id: "g-5", course_id: "c-5", homework_topic_id: 7, homework_topic_url: "https://t.me/c/4249393939/8", telegram_group_url: null },
      ...(extra.groups ?? []),
    ],
    group_module_topics: [] as Row[],
    admin_actions: [] as Row[],
  };
}

const ioInput = (chatId: number, o: Partial<GroupPosterInput> = {}): GroupPosterInput => ({
  from: { id: 5550001, username: "malika_07" }, chatId, threadId: 3, messageId: 77,
  topicKinds: ["homework", "module"], source: "homework_topic_post", ...o,
});

Deno.test("io: the intake student is linked with ONE guarded write and one audit row; the engine is not called", async () => {
  const chatId = nextChatId();
  const { db, tables, log } = fakeDb(world(chatId));
  let engine = 0;
  const r = await resolveGroupPoster(db, ioInput(chatId), { autoRegister: async () => { engine++; return null; } });
  assertEquals([r.via, (r.profile as Row | null)?.id], ["username_link", "p-intake"]);
  assertEquals(tables.profiles.find((p) => p.id === "p-intake")?.telegram_id, 5550001);
  assert(log.includes("profiles.is(telegram_id,null)"), "the link must be guarded by .is('telegram_id', null)");
  assert(log.some((l) => l === "profiles.ilike(telegram_username,malika\\_07)"), `the username must be LIKE-escaped: ${log.join(" ")}`);
  assert(log.some((l) => l.startsWith(`groups.or(homework_topic_url.ilike.%/c/${String(chatId).slice(4)}/%`)), "same chat match as auto-register");
  assertEquals(engine, 0);
  const rows = tables.admin_actions.filter((a) => a.action === "group_poster_linked_by_username");
  assertEquals(rows.length, 1);
  assertEquals(rows[0].target_user_id, "p-intake");
  assertEquals((rows[0].details as Row).telegram_id, 5550001);
  assertEquals((rows[0].details as Row).chat_id, chatId);
  assertEquals(tables.admin_actions.filter((a) => a.action === "group_poster_unresolved").length, 0);
});

Deno.test("io: a second post from the linked student resolves by telegram_id (no second audit row)", async () => {
  const chatId = nextChatId();
  const { db, tables } = fakeDb(world(chatId));
  await resolveGroupPoster(db, ioInput(chatId));
  const r2 = await resolveGroupPoster(db, ioInput(chatId, { messageId: 78 }));
  assertEquals(r2.via, "telegram_id");
  assertEquals(tables.admin_actions.filter((a) => a.action === "group_poster_linked_by_username").length, 1);
});

Deno.test("io: '_' is not a wildcard — 'a_ice1' does not claim 'alice1'; it goes to the registrar instead", async () => {
  const chatId = nextChatId();
  const { db, tables } = fakeDb(world(chatId));
  let engine = 0;
  const r = await resolveGroupPoster(db, ioInput(chatId, { from: { id: 5550002, username: "a_ice1" } }), {
    autoRegister: async () => { engine++; return null; },
  });
  assertEquals([r.reason, engine], ["auto_register_declined", 1]);
  assertEquals(tables.profiles.find((p) => p.id === "p-alice")?.telegram_id, null);
});

Deno.test("io: refusals write ONE group_poster_unresolved row per (reason, chat, sender, day) and link nothing", async () => {
  const cases: Array<[string, string, string]> = [
    ["zamira2013", "username_linked_elsewhere", "p-linked"],
    ["ustoz_ali", "username_not_student", "p-teacher"],
    ["vip_5", "username_other_chat", "p-5"],
  ];
  for (const [username, reason, target] of cases) {
    const chatId = nextChatId();
    const { db, tables } = fakeDb(world(chatId));
    const before = JSON.stringify(tables.profiles);
    let engine = 0;
    const inp = ioInput(chatId, { from: { id: 5550003, username } });
    const reg = { autoRegister: async () => { engine++; return null; } };
    const r = await resolveGroupPoster(db, inp, reg);
    await resolveGroupPoster(db, { ...inp, messageId: 78 }, reg); // same sender, same day: deduped
    assertEquals([r.profile, r.reason, engine], [null, reason, 0]);
    assertEquals(JSON.stringify(tables.profiles), before, "no profile may change on a refusal");
    const rows = tables.admin_actions.filter((a) => a.action === "group_poster_unresolved");
    assertEquals(rows.length, 1, `${reason}: one row`);
    assertEquals(rows[0].target_user_id, target);
    assertEquals((rows[0].details as Row).reason, reason);
    assertEquals((rows[0].details as Row).dedupe_key, `${reason}:${chatId}:5550003`);
  }
});

Deno.test("io: general-chat media from an unknown member → silent (no rows, no link, no registrar)", async () => {
  const chatId = nextChatId();
  const { db, tables } = fakeDb(world(chatId));
  let engine = 0;
  const r = await resolveGroupPoster(db, ioInput(chatId, { threadId: 1 }), { autoRegister: async () => { engine++; return null; } });
  assertEquals([r.reason, engine, tables.admin_actions.length], ["not_registered_topic", 0, 0]);
  assertEquals(tables.profiles.find((p) => p.id === "p-intake")?.telegram_id, null);
});

Deno.test("io: daily_task kind before PR-1 — the missing column is retried away and simply matches nothing", async () => {
  const chatId = nextChatId();
  const { db, tables, log } = fakeDb(world(chatId), { missingColumns: { groups: ["daily_task_topic_id"] } });
  const r = await resolveGroupPoster(db, ioInput(chatId, { threadId: 144, topicKinds: ["daily_task"], source: "daily_task_post" }));
  assertEquals(r.reason, "not_registered_topic");
  assertEquals(tables.admin_actions.length, 0);
  assert(log.includes("groups.select(id, course_id, homework_topic_id, daily_task_topic_id)"), log.join(" "));
  assert(log.includes("groups.select(id, course_id, homework_topic_id)"), "retried without the column");
  // Homework kind is unaffected: it never asks for the column.
  const chat2 = nextChatId();
  const w2 = fakeDb(world(chat2), { missingColumns: { groups: ["daily_task_topic_id"] } });
  assertEquals((await resolveGroupPoster(w2.db, ioInput(chat2))).via, "username_link");
});

Deno.test("io: daily_task kind after PR-1 — the daily topic resolves like a homework topic", async () => {
  const chatId = nextChatId();
  const w = world(chatId);
  (w.groups[0] as Row).daily_task_topic_id = 144;
  const { db } = fakeDb(w);
  const r = await resolveGroupPoster(db, ioInput(chatId, { threadId: 144, topicKinds: ["daily_task"], source: "daily_task_post" }));
  assertEquals([r.via, (r.profile as Row | null)?.id], ["username_link", "p-intake"]);
});

Deno.test("io: per-module topics (group_module_topics) count as homework topics", async () => {
  const chatId = nextChatId();
  const w = world(chatId);
  w.group_module_topics.push({ group_id: "g-6", telegram_topic_id: 21 });
  const { db } = fakeDb(w);
  assertEquals((await resolveGroupPoster(db, ioInput(chatId, { threadId: 21 }))).via, "username_link");
});

Deno.test("io: a DB failure on the gate's reads fails closed with one lookup_failed row", async () => {
  const chatId = nextChatId();
  const { db, tables } = fakeDb(world(chatId), { failTable: "user_roles" });
  let engine = 0;
  const r = await resolveGroupPoster(db, ioInput(chatId), { autoRegister: async () => { engine++; return null; } });
  assertEquals([r.reason, engine], ["lookup_failed", 0]);
  assertEquals(tables.profiles.find((p) => p.id === "p-intake")?.telegram_id, null);
  assertEquals(tables.admin_actions.filter((a) => a.action === "group_poster_unresolved").map((a) => (a.details as Row).step), ["username_lookup"]);
});
