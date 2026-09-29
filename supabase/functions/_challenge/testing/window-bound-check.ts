// Applies 20260929193000_challenge_window_bound.sql to a real PostgreSQL (PGlite) on top of the LIVE
// reconcile_challenge_xp and exercises the rewritten function end to end.
//
//   deno run -A --node-modules-dir=none supabase/functions/_challenge/testing/window-bound-check.ts
//
// Run it after ANY change to that migration, and before asking for the migration-approved label.
// TEST INFRASTRUCTURE ONLY: this directory has no index.ts, so it is never deployed.
//
// Fidelity: the fixture next to this file is the live pg_get_functiondef of reconcile_challenge_xp as
// of 2026-09-29, byte for byte -- section A asserts its md5 equals production's (definition AND body),
// so the migration's own md5 pin and exactly-once replace() checks run against the real text. The
// helper functions below (challenge_config/active/group_ids/scope_group_ids, xp_level_for) are their
// live definitions; the tables are stubs carrying the live columns and constraints the reconciler uses.

import { PGlite } from "npm:@electric-sql/pglite@0.5.8";
import { createHash } from "node:crypto";

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

const here = (p: string) => new URL(p, import.meta.url);
const lf = (s: string) => s.replace(/\r\n/g, "\n"); // a Windows checkout is CRLF; production text is LF
const LIVE = lf(await Deno.readTextFile(here("./reconcile_challenge_xp.live-2026-09-29.sql")));
const MIG = await Deno.readTextFile(
  here("../../../migrations/20260929193000_challenge_window_bound.sql"));

const PROD_DEF_MD5 = "41d9d81471624552d5afe05fd8aef794";  // md5(pg_get_functiondef), prod 2026-09-29
const PROD_BODY_MD5 = "156153ca36bb425b379b3110c1eebb47"; // md5(prosrc), the migration's pin

const C6 = "f502f631-2104-4834-b6c2-702cd3080e27";
const G1 = "11111111-1111-1111-1111-111111111111";
const G5 = "55555555-5555-5555-5555-555555555555"; // a group outside the challenge
const S1 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const S5 = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const T1 = "cccccccc-cccc-cccc-cccc-cccccccccccc"; // a teacher
const CHAT = -1001234, CHAT5 = -1005555;

const SCHEMA = `
set timezone = 'UTC';
create schema auth;
create table auth.users (id uuid primary key);
create type public.app_role as enum ('student','teacher','admin','superadmin');
create table public.user_roles (id uuid primary key default gen_random_uuid(), user_id uuid not null, role public.app_role not null);
create table public.groups (id uuid primary key, course_id uuid, homework_topic_id bigint, name text);
create table public.profiles (id uuid primary key, group_id uuid, status text default 'active', archived_at timestamptz);
create table public.webhook_inbox (id bigserial primary key, received_at timestamptz not null default now(), update_type text,
  chat_id bigint, message_id bigint, raw_update jsonb not null);
create table public.group_message_events (id uuid primary key default gen_random_uuid(), group_id uuid not null, profile_id uuid,
  telegram_user_id bigint not null default 0, telegram_chat_id bigint not null, telegram_message_id bigint not null,
  telegram_thread_id bigint, sent_at timestamptz not null default now(), is_anon_admin boolean not null default false,
  unique (telegram_chat_id, telegram_message_id));
create table public.xp_events (id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
  amount integer not null check (amount > 0), reason text not null, ref_key text not null, created_at timestamptz not null default now(),
  unique (user_id, ref_key));
create table public.user_xp (user_id uuid primary key references auth.users(id) on delete cascade, total_xp integer not null default 0,
  level integer not null default 1, updated_at timestamptz not null default now());
create table public.admin_actions (id uuid primary key default gen_random_uuid(), actor_user_id uuid, action text not null,
  target_user_id uuid, details jsonb not null default '{}'::jsonb, created_at timestamptz not null default now());
create table public.platform_settings (key text primary key, value jsonb not null, updated_at timestamptz not null default now());
create table public.challenge_weekly_results (id uuid primary key default gen_random_uuid(), week_start date not null);

CREATE OR REPLACE FUNCTION public.xp_level_for(_total integer)
 RETURNS integer
 LANGUAGE sql
 IMMUTABLE
AS $function$ select greatest(1, floor((50 + sqrt(2500 + 200.0 * greatest(_total, 0))) / 100))::int $function$;

CREATE OR REPLACE FUNCTION public.challenge_config()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce((select value from platform_settings where key = 'challenge'), '{}'::jsonb);
$function$;

CREATE OR REPLACE FUNCTION public.challenge_active(_at timestamp with time zone DEFAULT now())
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare _cfg jsonb; _s text; _e text;
begin
  _cfg := public.challenge_config();
  if not coalesce((_cfg->>'enabled')::boolean, false) then
    return false;
  end if;
  _s := nullif(_cfg->'window'->>'start', '');
  _e := nullif(_cfg->'window'->>'end', '');
  if _s is not null and _at < _s::timestamptz then return false; end if;
  if _e is not null and _at > _e::timestamptz then return false; end if;
  return true;
exception when others then
  return false;
end;
$function$;

CREATE OR REPLACE FUNCTION public.challenge_group_ids()
 RETURNS SETOF uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select g.id
  from groups g
  where public.challenge_active()
    and (
      g.id::text in (select jsonb_array_elements_text(coalesce(public.challenge_config()->'group_ids', '[]'::jsonb)))
      or g.course_id::text in (select jsonb_array_elements_text(coalesce(public.challenge_config()->'course_ids', '[]'::jsonb)))
    );
$function$;

CREATE OR REPLACE FUNCTION public.challenge_scope_group_ids()
 RETURNS SETOF uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select g.id
  from groups g
  where g.id::text in (select jsonb_array_elements_text(coalesce(public.challenge_config()->'group_ids', '[]'::jsonb)))
     or g.course_id::text in (select jsonb_array_elements_text(coalesce(public.challenge_config()->'course_ids', '[]'::jsonb)));
$function$;

-- Live ACLs: {postgres=X/postgres,service_role=X/postgres}
create role service_role;
revoke execute on function public.challenge_config() from public;
grant execute on function public.challenge_config() to service_role;
revoke execute on function public.challenge_active(timestamptz) from public;
grant execute on function public.challenge_active(timestamptz) to service_role;
revoke execute on function public.challenge_group_ids() from public;
grant execute on function public.challenge_group_ids() to service_role;
revoke execute on function public.challenge_scope_group_ids() from public;
grant execute on function public.challenge_scope_group_ids() to service_role;

insert into auth.users values ('${S1}'), ('${S5}'), ('${T1}');
insert into public.groups values ('${G1}', '${C6}', 3, 'AC CHALLENGE | 1-GURUH'),
                                 ('${G5}', '00000000-0000-0000-0000-000000000005', 9, '5.0');
insert into public.profiles (id, group_id) values ('${S1}', '${G1}'), ('${S5}', '${G5}'), ('${T1}', '${G1}');
insert into public.user_roles (user_id, role) values ('${T1}', 'teacher');
insert into public.platform_settings values ('challenge', '{}'::jsonb);
`;

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail !== undefined ? "  — " + JSON.stringify(detail) : ""}`); }
}

async function freshDb(liveText = LIVE): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(liveText + ";\n" +
    "revoke execute on function public.reconcile_challenge_xp(timestamptz) from public;\n" +
    "grant execute on function public.reconcile_challenge_xp(timestamptz) to service_role;");
  return db;
}

/** The deploy pipeline wraps each migration file in one transaction. */
async function applyMigration(db: PGlite): Promise<string | null> {
  try {
    await db.exec("begin;\n" + MIG + "\ncommit;");
    return null;
  } catch (e) {
    try { await db.exec("rollback;"); } catch { /* not in a transaction */ }
    return String((e as Error).message);
  }
}

async function q(db: PGlite, sql: string, params: unknown[] = []): Promise<Row[]> {
  return (await db.query(sql, params)).rows as Row[];
}

/** Clean slate: no posts/awards, one heartbeat `heartbeatAgo` ago (so _since = that - 30 min). */
async function reset(db: PGlite, cfg: Row, heartbeatAgo = "10 minutes") {
  await db.exec(`
    delete from public.xp_events; delete from public.user_xp; delete from public.webhook_inbox;
    delete from public.group_message_events;
    delete from public.admin_actions
     where action in ('challenge_xp_reconciled','challenge_config_invalid','challenge_xp_reconcile_skipped');
    insert into public.admin_actions (action, details, created_at)
    values ('challenge_xp_reconciled', '{"active":false}', now() - interval '${heartbeatAgo}');`);
  await db.query("update public.platform_settings set value = $1::jsonb where key = 'challenge'", [JSON.stringify(cfg)]);
}

let msgId = 1000;
interface PostOpts { user?: string; group?: string; chat?: number; thread?: number; kind?: "photo" | "text"; mgid?: string }
/** A group post: sent at `sentExpr` (SQL timestamptz), received by the webhook now. */
async function post(db: PGlite, sentExpr: string, o: PostOpts = {}) {
  const { user = S1, group = G1, chat = CHAT, thread = 10, kind = "photo", mgid } = o;
  const id = ++msgId;
  const m: Row = { message_id: id, from: { id: 111 }, chat: { id: chat } };
  if (kind === "photo") m.photo = [{ file_id: "x" }];
  if (kind === "text") m.text = "hi";
  if (mgid) m.media_group_id = mgid;
  await db.query(
    `insert into public.webhook_inbox (received_at, update_type, chat_id, message_id, raw_update)
     values (now(), 'message', $1, $2, $3::jsonb)`, [chat, id, JSON.stringify({ message: m })]);
  await db.query(
    `insert into public.group_message_events
       (group_id, profile_id, telegram_chat_id, telegram_message_id, telegram_thread_id, sent_at)
     values ($1, $2, $3, $4, $5, ${sentExpr})`, [group, user, chat, id, thread]);
}

async function run(db: PGlite, sinceExpr?: string) {
  const r = await q(db, `select * from public.reconcile_challenge_xp(${sinceExpr ?? ""})`);
  const hb = await q(db,
    "select details from public.admin_actions where action = 'challenge_xp_reconciled' order by created_at desc limit 1");
  const events = await q(db, "select ref_key, created_at, amount from public.xp_events order by created_at");
  return { awarded: r[0].awarded as number, capped: r[0].capped as number, hb: hb[0].details as Row, events };
}

/** A timestamptz computed by the database, as an ISO string for the config / later SQL. */
async function ts(db: PGlite, expr: string): Promise<string> {
  return String((await q(db, `select to_json(${expr})::text as v`))[0].v).replace(/"/g, "");
}

const base: Row = {
  enabled: true, course_ids: [C6], group_ids: [],
  points: { group_media: 5 }, caps: { group_media_per_day: 3 },
};

// ───────────── A. fidelity, and both bugs reproduced on the LIVE function ─────────────
console.log("A. live function: fidelity, and the bug");
{
  const db = await freshDb();
  const d = (await q(db, `select md5(pg_get_functiondef('public.reconcile_challenge_xp(timestamptz)'::regprocedure)) d,
                                 md5(replace(prosrc, E'\\r', '')) b
                            from pg_proc where proname = 'reconcile_challenge_xp'`))[0];
  ok("fixture definition is byte-identical to production", d.d === PROD_DEF_MD5, d);
  ok("fixture body md5 equals the migration's pin", d.b === PROD_BODY_MD5, d);

  const start = await ts(db, "now() - interval '5 minutes'");
  await reset(db, { ...base, window: { start, end: null } });
  await post(db, "now() - interval '7 minutes'");  // before the start
  await post(db, "now() - interval '4 minutes'");  // inside the window
  let r = await run(db);
  ok("LIVE: the first active tick pays a pre-start post (the bug): awarded=2", r.awarded === 2, r);

  const s2 = await ts(db, "now() - interval '2 days'"), e2 = await ts(db, "now() - interval '3 minutes'");
  await reset(db, { ...base, window: { start: s2, end: e2 } });
  await post(db, "now() - interval '4 minutes'");  // one minute before the end, scanned after it
  r = await run(db);
  ok("LIVE: a post in the final minutes, scanned after window.end, is never paid (mirror bug)", r.awarded === 0, r);
  await db.close();
}

// ───────────── B. the migration ─────────────
console.log("B. migration: exact, pinned, replay-safe");
const db = await freshDb();
{
  const before = (await q(db, `select coalesce(array_to_string(proacl, ','), '') a, proowner o, prosecdef s
                                 from pg_proc where proname = 'reconcile_challenge_xp'`))[0];
  const err = await applyMigration(db);
  ok("applies", err === null, err);
  const after = (await q(db, `select coalesce(array_to_string(proacl, ','), '') a, proowner o, prosecdef s, prosrc
                                from pg_proc where proname = 'reconcile_challenge_xp'`))[0];
  ok("owner / ACL / SECURITY DEFINER unchanged",
    after.a === before.a && after.o === before.o && after.s === before.s, { before, after: after.a });
  ok("still service_role-only (no PUBLIC entry)", after.a.includes("service_role=X") && !/(^|,)=X/.test(after.a), after.a);
  const audit = await q(db, "select details from public.admin_actions where action = 'challenge_window_bound_applied'");
  ok("audit row written", audit.length === 1, audit);
  ok("audit records the new body md5",
    audit[0]?.details.reconciler_body_md5 === createHash("md5").update(after.prosrc).digest("hex"), audit[0]?.details);

  const err2 = await applyMigration(db);
  ok("replay is a clean no-op", err2 === null, err2);
  const n = (await q(db, "select count(*)::int n from public.admin_actions where action = 'challenge_window_bound_applied'"))[0].n;
  ok("replay does not duplicate the audit row", n === 1, n);
  const src2 = (await q(db, "select prosrc from pg_proc where proname = 'reconcile_challenge_xp'"))[0].prosrc;
  ok("replay leaves the body unchanged", src2 === after.prosrc);

  // Outside the six edit sites the body is byte-identical: every live line survives, in order.
  const liveLines = LIVE.slice(LIVE.indexOf("$function$") + 10, LIVE.lastIndexOf("$function$")).split("\n");
  const newLines = String(after.prosrc).split("\n");
  const replaced = new Set([
    "  if _active then",
    "        -- this cheap. Deliberately NOT also bounded on g.sent_at: that helped the planner but was a",
    "        -- real filter that could silently drop a row with unusual clock skew (see review note c).",
    "          and g.group_id in (select public.challenge_group_ids())",
    "  -- `config_invalid` surface a bad hand-edit of the config.",
    "                               'media_off', _media_off, 'at', now()));",
  ]);
  let k = 0;
  const missing: string[] = [];
  for (const line of liveLines) {
    if (replaced.has(line)) continue;
    while (k < newLines.length && newLines[k] !== line) k++;
    if (k === newLines.length) { missing.push(line); k = 0; } else k++;
  }
  ok("every live line outside the six edits is kept, in order", missing.length === 0, missing);
}

// ───────────── C. the rewritten reconciler ─────────────
console.log("C. the rewritten reconciler");
{
  // C1 the start bound
  const start = await ts(db, "now() - interval '5 minutes'");
  await reset(db, { ...base, window: { start, end: null } });
  await post(db, "now() - interval '7 minutes'");
  await post(db, "now() - interval '4 minutes'");
  let r = await run(db);
  ok("C1 pre-start post not paid, in-window post paid", r.awarded === 1 && r.events.length === 1, r);
  ok("C1 heartbeat: active=true tail=false window_invalid=false config_invalid=false",
    r.hb.active === true && r.hb.tail === false && r.hb.window_invalid === false && r.hb.config_invalid === false, r.hb);
  ok("C1 the award is dated at its sent_at, inside the window",
    new Date(r.events[0].created_at) >= new Date(start), r.events);

  // C2 inclusive start, like challenge_active()
  const s2 = await ts(db, "date_trunc('second', now()) - interval '6 minutes'");
  await reset(db, { ...base, window: { start: s2, end: null } });
  await post(db, `'${s2}'::timestamptz`);
  await post(db, `'${s2}'::timestamptz - interval '1 second'`);
  r = await run(db);
  ok("C2 a post at exactly window.start is paid, one second earlier is not", r.awarded === 1, r);

  // C3 the W2 tail: ended three minutes ago
  const s3 = await ts(db, "now() - interval '2 days'");
  const e3 = await ts(db, "date_trunc('second', now()) - interval '3 minutes'");
  await reset(db, { ...base, window: { start: s3, end: e3 } });
  await post(db, `'${e3}'::timestamptz - interval '1 minute'`);  // final minute: paid
  await post(db, `'${e3}'::timestamptz`);                         // exactly at the end: paid (inclusive)
  await post(db, `'${e3}'::timestamptz + interval '1 second'`);   // after the end: never
  await post(db, `'${e3}'::timestamptz + interval '2 minutes'`);  // after the end: never
  r = await run(db);
  ok("C3 a tail run pays the final minutes (incl. exactly at end) and nothing after", r.awarded === 2, r);
  ok("C3 heartbeat: active=false (truthful), tail=true", r.hb.active === false && r.hb.tail === true, r.hb);
  r = await run(db);
  ok("C3 a second tail run is idempotent", r.awarded === 0 && r.events.length === 2, r);

  // C4 the tail stops 24 h after the end (the D1 clamp's horizon)
  const s4 = await ts(db, "now() - interval '5 days'"), e4 = await ts(db, "now() - interval '25 hours'");
  await reset(db, { ...base, window: { start: s4, end: e4 } });
  await post(db, `'${e4}'::timestamptz - interval '1 minute'`);
  r = await run(db);
  ok("C4 more than 24 h after the end: no scan, tail=false", r.awarded === 0 && r.hb.tail === false && r.hb.active === false, r);

  // C5 the kill-switch stops the tail
  await reset(db, { ...base, enabled: false, window: { start: s3, end: e3 } });
  await post(db, `'${e3}'::timestamptz - interval '1 minute'`);
  r = await run(db);
  ok("C5 enabled=false: the tail does not run", r.awarded === 0 && r.hb.tail === false && r.hb.active === false, r);

  // C6-C8 a malformed window: no crash, fails closed, flagged
  await reset(db, { ...base, window: { start: "garbage", end: null } });
  await post(db, "now() - interval '1 minute'");
  r = await run(db);
  ok("C6 malformed window.start: no crash, nothing paid, config_invalid + window_invalid",
    r.awarded === 0 && r.hb.config_invalid === true && r.hb.window_invalid === true && r.hb.active === false, r);

  const s7 = await ts(db, "now() - interval '1 day'");
  await reset(db, { ...base, window: { start: s7, end: "2026-13-45" } });
  await post(db, "now() - interval '1 minute'");
  r = await run(db);
  ok("C7 malformed window.end with a valid start: no crash, nothing paid, flagged",
    r.awarded === 0 && r.hb.window_invalid === true && r.hb.config_invalid === true, r);

  await reset(db, { ...base, window: { start: 12345, end: null } });
  await post(db, "now() - interval '1 minute'");
  r = await run(db);
  ok("C8 numeric window.start: no crash, nothing paid, flagged", r.awarded === 0 && r.hb.window_invalid === true, r);

  // C9 a normal active run: cap, staff, scope, homework-topic and non-media rules unchanged
  const s9 = await ts(db, "now() - interval '1 day'"), e9 = await ts(db, "now() + interval '1 day'");
  await reset(db, { ...base, window: { start: s9, end: e9 } });
  for (let i = 1; i <= 4; i++) await post(db, `now() - interval '${i} minutes'`);
  await post(db, "now() - interval '1 minute'", { user: T1 });                         // staff
  await post(db, "now() - interval '1 minute'", { user: S5, group: G5, chat: CHAT5 }); // out of scope
  await post(db, "now() - interval '1 minute'", { thread: 3 });                        // homework topic
  await post(db, "now() - interval '1 minute'", { kind: "text" });                     // not media
  r = await run(db);
  ok("C9 active run: 3 paid + 1 capped; staff, out-of-scope, homework-topic, text excluded",
    r.awarded === 3 && r.capped === 1, r);
  const ux = await q(db, `select total_xp from public.user_xp where user_id = '${S1}'`);
  ok("C9 user_xp rebuilt (15)", ux[0]?.total_xp === 15, ux);
  ok("C9 heartbeat: active=true tail=false", r.hb.active === true && r.hb.tail === false, r.hb);

  // C10 an explicit admin back-fill is window-bounded too
  const s10 = await ts(db, "now() - interval '30 minutes'");
  await reset(db, { ...base, window: { start: s10, end: null } });
  await post(db, "now() - interval '90 minutes'");
  await post(db, "now() - interval '20 minutes'");
  r = await run(db, "now() - interval '3 hours'");
  ok("C10 explicit _since back-fill pays only in-window posts", r.awarded === 1, r);

  // C11 / C12 before the start, and disabled: no scan
  const s11 = await ts(db, "now() + interval '1 hour'");
  await reset(db, { ...base, window: { start: s11, end: null } });
  await post(db, "now() - interval '1 minute'");
  r = await run(db);
  ok("C11 before the start: nothing, active=false tail=false", r.awarded === 0 && r.hb.active === false && r.hb.tail === false, r);
  await reset(db, { ...base, enabled: false, window: { start: s9, end: null } });
  await post(db, "now() - interval '1 minute'");
  r = await run(db);
  ok("C12 disabled: nothing", r.awarded === 0 && r.hb.tail === false, r);

  // C13 an album straddling the start
  const s13 = await ts(db, "date_trunc('second', now()) - interval '5 minutes'");
  await reset(db, { ...base, window: { start: s13, end: null } });
  await post(db, `'${s13}'::timestamptz - interval '1 second'`, { mgid: "alb1" });
  await post(db, `'${s13}'::timestamptz`, { mgid: "alb1" });
  await post(db, `'${s13}'::timestamptz + interval '1 second'`, { mgid: "alb1" });
  r = await run(db);
  ok("C13 an album straddling the start is paid once, dated at/after the start",
    r.awarded === 1 && new Date(r.events[0].created_at) >= new Date(s13), r);
}
await db.close();

// ───────────── D. history heal ─────────────
console.log("D. history heal (the migration lands after the first active tick)");
{
  const db2 = await freshDb();
  const start = await ts(db2, "now() - interval '5 minutes'");
  await reset(db2, { ...base, window: { start, end: null } });
  await post(db2, "now() - interval '7 minutes'");
  await post(db2, "now() - interval '4 minutes'");
  const r = await run(db2); // the LIVE function pays both
  ok("D0 the live function paid 2 (one pre-start)", r.awarded === 2, r);
  await db2.exec(`
    insert into public.xp_events (user_id, amount, reason, ref_key, created_at)
    values ('${S1}', 20, 'lesson_complete', 'lc:x', now() - interval '3 days');
    update public.user_xp set total_xp = 30 where user_id = '${S1}';`);
  const err = await applyMigration(db2);
  ok("D1 applies", err === null, err);
  const ev = await q(db2, "select reason, created_at from public.xp_events order by created_at");
  ok("D2 the pre-start challenge row is removed; the in-window and unrelated rows are kept",
    ev.length === 2 && ev.every((e) => e.reason !== "challenge_group_media" || new Date(e.created_at) >= new Date(start)), ev);
  const ux = await q(db2, `select total_xp from public.user_xp where user_id = '${S1}'`);
  ok("D3 user_xp rebuilt to 25", ux[0].total_xp === 25, ux);
  const audit = await q(db2, "select details from public.admin_actions where action = 'challenge_window_bound_applied'");
  ok("D4 audit: 1 removed, 1 student rebuilt",
    audit[0].details.pre_start_points_removed === 1 && audit[0].details.students_rebuilt === 1, audit);
  await db2.close();
}

// ───────────── E. the md5 pin ─────────────
console.log("E. a drifted live body is refused and nothing changes");
{
  const drifted = LIVE.replace("-- TRY-lock, not a blocking lock.", "-- TRY-lock (drifted), not a blocking lock.");
  const db3 = await freshDb(drifted);
  const before = (await q(db3, "select prosrc from pg_proc where proname = 'reconcile_challenge_xp'"))[0].prosrc;
  const err = await applyMigration(db3);
  ok("E1 aborts with the md5 message", !!err && err.includes("changed since it was verified"), err);
  const after = (await q(db3, "select prosrc from pg_proc where proname = 'reconcile_challenge_xp'"))[0].prosrc;
  ok("E2 the function is untouched", before === after);
  const n = (await q(db3, "select count(*)::int n from public.admin_actions where action = 'challenge_window_bound_applied'"))[0].n;
  ok("E3 no audit row", n === 0, n);
  await db3.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
Deno.exit(fail ? 1 : 0);
