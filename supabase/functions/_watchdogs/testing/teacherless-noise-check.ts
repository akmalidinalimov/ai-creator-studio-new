// Applies 20260930083000_teacherless_watchdog_noise.sql to a real PostgreSQL (PGlite) on top of the LIVE
// teacherless-homework watchdog functions, reproduces each review finding on the live code, and drives the
// rewritten watchdog end to end with a stub ops_net_post.
//
//   deno run -A --node-modules-dir=none supabase/functions/_watchdogs/testing/teacherless-noise-check.ts
//
// Run it after ANY change to that migration, and before asking for the migration-approved label.
// TEST INFRASTRUCTURE ONLY: this directory has no index.ts, so it is never deployed, and the file is not
// named *.test.ts, so CI's `deno test supabase/functions/` does not try to fetch PGlite.
//
// Fidelity: the fixture next to this file is the live pg_get_functiondef of the four functions as of
// 2026-09-30, byte for byte -- section A asserts each md5 equals production's (definition AND body), so the
// migration's md5 pins and exactly-once replace() checks run against the real text. The tables are stubs
// carrying the live columns the functions read and write. ops_net_post is a stub that records each call
// (or raises, when a test asks it to), so "a DM went out" is observable without a network.

import { PGlite } from "npm:@electric-sql/pglite@0.5.8";

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

const here = (p: string) => new URL(p, import.meta.url);
const lf = (s: string) => s.replace(/\r\n/g, "\n"); // a Windows checkout is CRLF; production text is LF
const LIVE = lf(await Deno.readTextFile(here("./teacherless_homework.live-2026-09-30.sql")));
const MIG = lf(await Deno.readTextFile(
  here("../../../migrations/20260930083000_teacherless_watchdog_noise.sql")));

// md5(pg_get_functiondef(oid)) and md5(prosrc), production, 2026-09-30.
const PROD: Record<string, { def: string; body: string }> = {
  teacherless_homework_health:         { def: "b483fd3424a4b2592204211cb210ec79", body: "6863224f0f9b66ab8de4dda68dfe8148" },
  teacherless_homework_alert_decision: { def: "9db33140729e086dc4338b2468590f11", body: "41c55716aa0a067325a393ed8aa1009d" },
  teacherless_homework_alert_text:     { def: "a3a0e260f36e359be9d199f85475562e", body: "1ae1c1c0daf7bc647cc244d12c1176a3" },
  teacherless_homework_watchdog:       { def: "16f41f377ec9ccd3f05417872cac13be", body: "9c92531b4672cbfade65c74e63a60c92" },
};

// The live state row, 2026-09-30 07:13 (seeded by 20260929191000; the cron had not run yet).
const LIVE_STATE = {
  alerting: false, seeded_by: "20260929191000", checked_at: "2026-09-30T07:13:26.944162+00:00",
  last_report: {
    keys: [], alarm: false, groups: [], window: "7 days", pending: 0,
    checked_at: "2026-09-30T07:13:26.944162+00:00", pending_stage: 0, pending_no_group: 0,
    pending_over_24h: 0, pending_over_48h: 0, no_teacher_groups: 0, teacherless_groups: 0,
    no_group_events_24h: 0, pending_oldest_hours: null, no_teacher_events_24h: 0,
    unreachable_teacher_groups: 0,
  },
  last_alert_ms: 0, notified_keys: null, notified_stage: 0,
};

const C5 = "c5c5c5c5-0000-0000-0000-000000000005";      // AI CREATORS 5.0 (published)
const C6 = "f502f631-2104-4834-b6c2-702cd3080e27";      // CHALLENGE 6.0 (published)
const G1 = "11111111-1111-1111-1111-111111111111";      // 6.0 group, no teacher
const G2 = "22222222-2222-2222-2222-222222222222";      // 6.0 group, no teacher
const G5 = "55555555-5555-5555-5555-555555555555";      // 5.0 group, reachable teacher
const T5 = "70000000-0000-0000-0000-000000000005";      // 5.0 teacher
const T6 = "70000000-0000-0000-0000-000000000006";      // a teacher assigned later
const AD1 = "a0000000-0000-0000-0000-000000000001";     // admin, telegram 9001
const AD2 = "a0000000-0000-0000-0000-000000000002";     // superadmin, telegram 9002
const STF = "a0000000-0000-0000-0000-000000000003";     // admin, NO group (8 of 9 live staff)
const S1 = "51000000-0000-0000-0000-000000000001";
const S2 = "52000000-0000-0000-0000-000000000002";
const S5 = "55000000-0000-0000-0000-000000000005";
const SNG = "59000000-0000-0000-0000-000000000009";     // a student with no group

const SCHEMA = `
set timezone = 'UTC';
create role anon; create role authenticated; create role service_role;
create type public.app_role as enum ('admin', 'student', 'teacher', 'superadmin');
create type public.user_status as enum ('active', 'inactive', 'archived');
create table public.courses (id uuid primary key default gen_random_uuid(), title text not null,
  published boolean not null default false);
create table public.groups (id uuid primary key default gen_random_uuid(), name text not null, course_id uuid,
  teacher_id uuid);
create table public.group_teachers (group_id uuid not null, teacher_id uuid not null);
create table public.profiles (id uuid primary key, name text, group_id uuid,
  status public.user_status not null default 'active', archived_at timestamptz, telegram_id bigint,
  notifications_enabled boolean default true);
create table public.user_roles (id uuid primary key default gen_random_uuid(), user_id uuid not null,
  role public.app_role not null);
create table public.homework_submissions (id uuid primary key default gen_random_uuid(), user_id uuid not null,
  submitted_at timestamptz not null default now(), score smallint, score_is_stale boolean not null default false);
create table public.admin_actions (id uuid primary key default gen_random_uuid(), actor_user_id uuid,
  action text not null, target_user_id uuid, target_resource_type text, target_resource_id text,
  details jsonb not null default '{}'::jsonb, created_at timestamptz not null default now());
create table public.app_settings (key text primary key, value jsonb not null, description text, updated_by uuid,
  updated_at timestamptz not null default now());
create table public.platform_settings (key text primary key, value jsonb not null,
  updated_at timestamptz not null default now(), updated_by uuid);

-- ops_net_post stub (same name and parameter names as production): records the call, or raises on demand.
create table public.test_sent (id bigserial primary key, url text, body jsonb, headers jsonb, purpose text);
create table public.test_knobs (k text primary key);
create function public.ops_net_post(p_url text, p_body jsonb, p_headers jsonb default '{}'::jsonb,
  p_purpose text default null, p_timeout_ms integer default 30000) returns bigint language plpgsql as $f$
declare _id bigint;
begin
  if exists (select 1 from public.test_knobs where k = 'ops_net_post_raises') then
    raise exception 'pg_net queue unavailable (test)';
  end if;
  insert into public.test_sent (url, body, headers, purpose) values (p_url, p_body, p_headers, p_purpose)
  returning id into _id;
  return _id;
end $f$;

insert into public.courses values ('${C5}', 'AI CREATORS 5.0', true), ('${C6}', 'AI CREATORS CHALLENGE 6.0', true);
insert into public.profiles (id, name, telegram_id) values
  ('${T5}', 'T5', 5005), ('${T6}', 'T6', 6006), ('${AD1}', 'AD1', 9001), ('${AD2}', 'AD2', 9002), ('${STF}', 'STF', null);
insert into public.user_roles (user_id, role) values
  ('${T5}', 'teacher'), ('${T6}', 'teacher'), ('${AD1}', 'admin'), ('${AD2}', 'superadmin'), ('${STF}', 'admin');
insert into public.groups values ('${G1}', 'CHALLENGE | 1-GURUH', '${C6}', null),
                                 ('${G2}', 'CHALLENGE | 2-GURUH', '${C6}', null),
                                 ('${G5}', '5.0 | 1-GURUH', '${C5}', '${T5}');
insert into public.profiles (id, name, group_id) values ('${S5}', 'S5', '${G5}');
`;

const LIVE_GRANTS = `
revoke execute on function public.teacherless_homework_health() from public, anon, authenticated;
grant  execute on function public.teacherless_homework_health() to service_role;
revoke execute on function public.teacherless_homework_alert_decision(boolean, jsonb, integer, jsonb, bigint) from public, anon, authenticated;
grant  execute on function public.teacherless_homework_alert_decision(boolean, jsonb, integer, jsonb, bigint) to service_role;
revoke execute on function public.teacherless_homework_alert_text(jsonb, text) from public, anon, authenticated;
grant  execute on function public.teacherless_homework_alert_text(jsonb, text) to service_role;
revoke execute on function public.teacherless_homework_watchdog() from public, anon, authenticated;
grant  execute on function public.teacherless_homework_watchdog() to service_role;
`;

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail !== undefined ? "  -- " + JSON.stringify(detail) : ""}`); }
}

async function q(db: PGlite, sql: string, params: unknown[] = []): Promise<Row[]> {
  return (await db.query(sql, params)).rows as Row[];
}

async function freshDb(liveText = LIVE): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(liveText);
  await db.exec(LIVE_GRANTS);
  await db.query("insert into public.app_settings (key, value) values ('teacherless_homework_watchdog_state', $1::jsonb)",
    [JSON.stringify(LIVE_STATE)]);
  return db;
}

/** The deploy pipeline sends each migration file as one query: one implicit transaction. */
async function applyMigration(db: PGlite): Promise<string | null> {
  try {
    await db.exec("begin;\n" + MIG + "\ncommit;");
    return null;
  } catch (e) {
    try { await db.exec("rollback;"); } catch { /* not in a transaction */ }
    return String((e as Error).message);
  }
}

async function migratedDb(): Promise<PGlite> {
  const db = await freshDb();
  const err = await applyMigration(db);
  if (err) throw new Error("migration failed: " + err);
  return db;
}

const setToken = (db: PGlite, on: boolean) => on
  ? db.exec(`insert into public.platform_settings (key, value) values ('telegram', '{"bot_token": "TEST:TOKEN"}')
             on conflict (key) do update set value = excluded.value`)
  : db.exec(`delete from public.platform_settings where key = 'telegram'`);
const setEnabled = (db: PGlite, on: boolean) =>
  db.exec(`update public.platform_settings set value = value || '{"enabled": ${on}}'
            where key = 'teacherless_homework_watchdog'`);
const netRaises = (db: PGlite, on: boolean) => on
  ? db.exec(`insert into public.test_knobs values ('ops_net_post_raises') on conflict do nothing`)
  : db.exec(`delete from public.test_knobs`);
/** A student in a teacherless 6.0 group: the groups leg alarms. */
const addStudent = (db: PGlite, id: string, group: string | null) =>
  db.query("insert into public.profiles (id, name, group_id) values ($1, 'S', $2)", [id, group]);
/** A reachable teacher assigned to G1: G1's alarm clears. */
const assignTeacher = (db: PGlite, group: string, teacher: string) =>
  db.query("update public.groups set teacher_id = $2 where id = $1", [group, teacher]);

interface RunResult { ret: Row; sent: Row[]; rows: Row[]; state: Row }
let seenSent = 0, seenRows = 0;
async function resetCounters(db: PGlite) {
  seenSent = (await q(db, "select coalesce(max(id), 0)::int m from public.test_sent"))[0].m;
  seenRows = (await q(db, "select count(*)::int n from public.admin_actions"))[0].n;
}
/** One cron run; returns what it sent and which admin_actions rows it wrote, and the state after it. */
async function run(db: PGlite): Promise<RunResult> {
  const ret = (await q(db, "select public.teacherless_homework_watchdog() r"))[0].r as Row;
  const sent = await q(db, "select id::int, body from public.test_sent where id > $1 order by id", [seenSent]);
  const all = await q(db, "select action, details from public.admin_actions order by created_at, id");
  const rows = all.slice(seenRows);
  const state = (await q(db,
    "select value from public.app_settings where key = 'teacherless_homework_watchdog_state'"))[0]?.value ?? null;
  await resetCounters(db);
  return { ret, sent, rows, state };
}
const actions = (r: RunResult) => r.rows.map((x) => x.action);
const alarmRows = async (db: PGlite) =>
  (await q(db, "select count(*)::int n from public.admin_actions where action = 'teacherless_homework_watchdog_ALARM'"))[0].n;

async function decision(db: PGlite, alarm: boolean | null, keys: unknown, stage: number, state: unknown, nowMs: number) {
  return (await q(db, "select public.teacherless_homework_alert_decision($1, $2::jsonb, $3, $4::jsonb, $5::bigint) d",
    [alarm, keys === null ? null : JSON.stringify(keys), stage, state === null ? null : JSON.stringify(state), nowMs]))[0].d;
}

const nowMs = async (db: PGlite) => Number((await q(db, "select (extract(epoch from now()) * 1000)::bigint::text v"))[0].v);
async function patchState(db: PGlite, patch: Row) {
  await db.query(`update public.app_settings set value = value || $1::jsonb
                   where key = 'teacherless_homework_watchdog_state'`, [JSON.stringify(patch)]);
}
// hw_dm_health_stats().stale_watchdogs, verbatim predicate.
const staleWatchdogs = async (db: PGlite) => (await q(db, `
  select count(*)::int n from public.app_settings
   where key like '%\\_watchdog\\_state'
     and coalesce((value->>'checked_at')::timestamptz, 'epoch'::timestamptz) < now() - interval '25 hours'`))[0].n;

// ───────────── A. live functions: fidelity, and each finding reproduced ─────────────
console.log("A. live functions: fidelity, and each finding reproduced");
{
  const db = await freshDb();
  const rows = await q(db, `select proname, md5(pg_get_functiondef(oid)) d, md5(replace(prosrc, E'\\r', '')) b
                              from pg_proc where proname like 'teacherless_homework%' order by proname`);
  ok("fixture has the 4 live functions", rows.length === 4, rows.map((r) => r.proname));
  for (const r of rows) {
    ok(`${r.proname}: definition byte-identical to production`, r.d === PROD[r.proname]?.def, r);
    ok(`${r.proname}: body md5 equals production's (the migration's pin)`, r.b === PROD[r.proname]?.body, r);
  }
  await db.close();
}
{ // (a) recovery announced for an episode nobody was told about
  const db = await freshDb();
  await resetCounters(db);
  await setToken(db, false);
  await addStudent(db, S1, G1);
  let r = await run(db);
  ok("LIVE (a): no bot token -> the alert is not sent", r.sent.length === 0 && r.state.alerting === true, r);
  await assignTeacher(db, G1, T6);
  await setToken(db, true);
  r = await run(db);
  ok("LIVE (a): the episode ends -> a 'recovered' DM goes out anyway (the bug)",
    r.sent.length === 2 && String(r.sent[0].body.text).startsWith("✅"), r.sent);
  await db.close();
}
{ // (b) an ALARM row every hour
  const db = await freshDb();
  await resetCounters(db);
  await setToken(db, false);
  await addStudent(db, S1, G1);
  for (let i = 0; i < 3; i++) await run(db);
  ok("LIVE (b): no bot token, 3 hourly runs -> 3 ALARM rows (the bug)", (await alarmRows(db)) === 3);
  await db.close();
}
{ // (c) staff counted in the submissions and sender-rows legs
  const db = await freshDb();
  await db.query("insert into public.homework_submissions (user_id) values ($1)", [STF]);
  await db.query(`insert into public.admin_actions (actor_user_id, action, details)
                  values ($1::uuid, 'homework_submission_dm_sent', jsonb_build_object('reason', 'no_group', 'student_id', $2::text,
                          'source', 'miniapp', 'queued', false))`, [STF, STF]);
  const h = (await q(db, "select public.teacherless_homework_health() h"))[0].h;
  ok("LIVE (c): a staff account's own submission raises the alarm (the bug)",
    h.alarm === true && h.pending === 1 && h.no_group_events_24h === 1, h);
  await db.close();
}
{ // (d) no kill-switch that keeps the verifier green; (e) 24 h minus cron jitter
  const db = await freshDb();
  await resetCounters(db);
  await setToken(db, true);
  await db.exec(`insert into public.platform_settings values ('teacherless_homework_watchdog', '{"enabled": false}')`);
  await addStudent(db, S1, G1);
  const r = await run(db);
  ok("LIVE (d): an enabled=false flag is not honoured (there is no such switch)", r.sent.length === 2, r.sent.length);
  const t = 1790000000000;
  const st = { alerting: true, notified_keys: ["a:g1:no_teacher"], notified_stage: 0, last_alert_ms: t - 86400000 + 36 };
  ok("LIVE (e): 24 h minus 36 ms of cron jitter -> no reminder, it slips to the 25th hour (the bug)",
    (await decision(db, true, ["a:g1:no_teacher"], 0, st, t)) === "none");
  await db.close();
}

// ───────────── B. the migration ─────────────
console.log("B. migration: exact, pinned, replay-safe");
{
  const db = await freshDb();
  const meta = `select proname, coalesce(array_to_string(proacl, ','), '') a, proowner::int o, prosecdef s, prosrc
                  from pg_proc where proname like 'teacherless_homework%' order by proname`;
  const before = await q(db, meta);
  const err = await applyMigration(db);
  ok("applies on the live definitions and the live state row", err === null, err);
  const after = await q(db, meta);
  const byName = (rs: Row[]) => Object.fromEntries(rs.map((r) => [r.proname, r]));
  const b = byName(before), a = byName(after);
  for (const n of Object.keys(b)) {
    ok(`${n}: owner / ACL / SECURITY DEFINER unchanged`,
      a[n].a === b[n].a && a[n].o === b[n].o && a[n].s === b[n].s, { before: b[n].a, after: a[n].a });
  }
  ok("alert_text is not touched", a.teacherless_homework_alert_text.prosrc === b.teacherless_homework_alert_text.prosrc);
  for (const n of ["teacherless_homework_health", "teacherless_homework_alert_decision", "teacherless_homework_watchdog"]) {
    ok(`${n}: rewritten, carries the marker`, a[n].prosrc !== b[n].prosrc && a[n].prosrc.includes("20260930083000"));
  }
  const nf = a.teacherless_homework_alarm_row_due;
  ok("new alarm_row_due(): service_role only, no PUBLIC entry, not SECURITY DEFINER",
    !!nf && nf.a.includes("service_role=X") && !/(^|,)=X/.test(nf.a) && !nf.a.includes("anon") &&
      !nf.a.includes("authenticated") && nf.s === false, nf?.a);
  const vol = await q(db, "select provolatile v from pg_proc where proname = 'teacherless_homework_alarm_row_due'");
  ok("new alarm_row_due() is IMMUTABLE (pure)", vol[0]?.v === "i", vol);

  const st = (await q(db, "select value from public.app_settings where key = 'teacherless_homework_watchdog_state'"))[0].value;
  ok("the live state row is not touched", JSON.stringify(st) === JSON.stringify(
    (await q(db, "select $1::jsonb v", [JSON.stringify(LIVE_STATE)]))[0].v), st);
  const ps = await q(db, "select value from public.platform_settings where key = 'teacherless_homework_watchdog'");
  ok("kill-switch row seeded as enabled", ps.length === 1 && ps[0].value.enabled === true, ps);
  const audit = await q(db, "select details from public.admin_actions where action = 'teacherless_homework_watchdog_noise_fixed'");
  ok("audit row written once, with the new body md5s",
    audit.length === 1 && audit[0].details.watchdog_md5?.length === 32 && audit[0].details.decision_at_deploy === "none", audit);

  // Every live line outside the edit sites survives, in order.
  const bodies = (text: string) => {
    const out: Record<string, string[]> = {};
    for (const m of text.matchAll(/FUNCTION public\.(\w+)\([\s\S]*?AS \$function\$([\s\S]*?)\$function\$/g)) {
      out[m[1]] = m[2].split("\n");
    }
    return out;
  };
  const live = bodies(LIVE);
  const changed = new Set([
    "                              p_now_ms) >= 86400000",
    "    when coalesce(p_state->>'alerting', '') = 'true' then 'recovered'",
    "    begin",
    "      insert into public.admin_actions (actor_user_id, action, details)",
    "      values (null,",
    "              case when _action = 'alert' then 'teacherless_homework_watchdog_ALARM'",
    "                   else 'teacherless_homework_watchdog_recovered' end,",
    "              coalesce(_r, jsonb_build_object('error', _err)) || jsonb_build_object('dm_attempted', _dm));",
    "    exception when others then null; end;",
  ]);
  for (const n of ["teacherless_homework_health", "teacherless_homework_alert_decision", "teacherless_homework_watchdog"]) {
    const newLines = String(a[n].prosrc).split("\n");
    let k = 0;
    const missing: string[] = [];
    for (const line of live[n]) {
      if (changed.has(line)) continue;
      while (k < newLines.length && newLines[k] !== line) k++;
      if (k === newLines.length) { missing.push(line); k = 0; } else k++;
    }
    ok(`${n}: every live line outside the edits is kept, in order`, missing.length === 0, missing);
  }

  const err2 = await applyMigration(db);
  ok("replay is a clean no-op", err2 === null, err2);
  const again = byName(await q(db, meta));
  ok("replay leaves every body unchanged",
    Object.keys(a).every((n) => again[n].prosrc === a[n].prosrc), Object.keys(again));
  const n = (await q(db, "select count(*)::int n from public.admin_actions where action = 'teacherless_homework_watchdog_noise_fixed'"))[0].n;
  ok("replay does not duplicate the audit row", n === 1, n);
  await db.close();
}
{ // An owner's kill-switch value survives the seed.
  const db = await freshDb();
  await db.exec(`insert into public.platform_settings values ('teacherless_homework_watchdog', '{"enabled": false}')`);
  const err = await applyMigration(db);
  const ps = await q(db, "select value from public.platform_settings where key = 'teacherless_homework_watchdog'");
  ok("the seed never overwrites an owner's enabled=false", err === null && ps[0].value.enabled === false, { err, ps });
  await db.close();
}
{ // The pin refuses a body that drifted, and nothing is half-applied.
  const drifted = LIVE.replace("-- (alert with no DM attempted: keep the old values, so the next hourly run retries)",
                               "-- (alert with no DM attempted: keep the old values; the next run retries)");
  const db = await freshDb(drifted);
  const beforeHealth = (await q(db, "select prosrc from pg_proc where proname = 'teacherless_homework_health'"))[0].prosrc;
  const err = await applyMigration(db);
  ok("a drifted watchdog body is refused by the md5 pin",
    !!err && err.includes("teacherless_homework_watchdog changed since it was verified"), err);
  const afterHealth = (await q(db, "select prosrc from pg_proc where proname = 'teacherless_homework_health'"))[0].prosrc;
  const fn = await q(db, "select 1 from pg_proc where proname = 'teacherless_homework_alarm_row_due'");
  ok("...and the whole file rolls back (health() unchanged, no new function)",
    afterHealth === beforeHealth && fn.length === 0);
  await db.close();
}
{ // An unreadable report (health() raising) never crashes the self-test's pure calls; the file still applies
  // when the verdict is TRUE at deploy time (students added before a teacher).
  const db = await freshDb();
  await addStudent(db, S1, G1);
  const err = await applyMigration(db);
  const audit = await q(db, "select details from public.admin_actions where action = 'teacherless_homework_watchdog_noise_fixed'");
  ok("applies while the alarm is live at deploy time (decision 'alert', nothing sent)",
    err === null && audit[0]?.details.alarm_at_deploy === true && audit[0]?.details.decision_at_deploy === "alert" &&
      (await q(db, "select count(*)::int n from public.test_sent"))[0].n === 0, { err, audit });
  await db.close();
}

// ───────────── C. the rewritten watchdog, end to end ─────────────
console.log("C. the rewritten watchdog");
{ // C1 (a): an episode that was never announced ends silently
  const db = await migratedDb();
  await resetCounters(db);
  await setToken(db, false);
  await addStudent(db, S1, G1);
  let r = await run(db);
  ok("C1 no bot token: alert not sent, one ALARM row with dm_attempted 0",
    r.sent.length === 0 && actions(r).join() === "teacherless_homework_watchdog_ALARM" &&
      r.rows[0].details.dm_attempted === 0 && r.state.notified_keys === null, r);
  await assignTeacher(db, G1, T6);
  await setToken(db, true);
  r = await run(db);
  ok("C1 the episode ends: NO 'recovered' DM and no recovered row", r.sent.length === 0 && r.rows.length === 0, r);
  ok("C1 state closed: alerting false, notified_keys null", r.state.alerting === false && r.state.notified_keys === null, r.state);
  r = await run(db);
  ok("C1 next run: still silent", r.sent.length === 0 && r.rows.length === 0, r);
  await db.close();
}
{ // C2 (a) regression: a delivered alert still gets exactly one recovery
  const db = await migratedDb();
  await resetCounters(db);
  await setToken(db, true);
  await addStudent(db, S1, G1);
  let r = await run(db);
  ok("C2 first alarm: 2 admins DMed, 1 ALARM row (dm_attempted 2)",
    r.sent.length === 2 && actions(r).join() === "teacherless_homework_watchdog_ALARM" && r.rows[0].details.dm_attempted === 2, r);
  ok("C2 DM goes through ops_net_post with a Content-Type and the watchdog's purpose",
    r.sent.length === 2 && (await q(db, "select headers, purpose from public.test_sent limit 1"))
      .every((x) => x.headers["Content-Type"] === "application/json" && x.purpose === "teacherless_homework_watchdog"));
  r = await run(db);
  ok("C2 same alarm an hour later: silent", r.sent.length === 0 && r.rows.length === 0, r);
  await assignTeacher(db, G1, T6);
  r = await run(db);
  ok("C2 cleared: 2 'recovered' DMs and 1 recovered row",
    r.sent.length === 2 && String(r.sent[0].body.text).startsWith("✅") &&
      actions(r).join() === "teacherless_homework_watchdog_recovered", r);
  r = await run(db);
  ok("C2 next run: silent", r.sent.length === 0 && r.rows.length === 0, r);
  await db.close();
}
{ // C3 (b): one ALARM row per undelivered key set + stage, while the hourly retries go on
  const db = await migratedDb();
  await resetCounters(db);
  await setToken(db, false);
  await addStudent(db, S1, G1);
  const r1 = await run(db), r2 = await run(db), r3 = await run(db);
  ok("C3 3 failed runs -> 1 ALARM row", (await alarmRows(db)) === 1, [actions(r1), actions(r2), actions(r3)]);
  ok("C3 every run still retries (last_action 'alert', dm 0)",
    [r1, r2, r3].every((r) => r.state.last_action === "alert" && r.state.dm_attempted_last_run === 0), r3.state);
  ok("C3 state.undelivered = {keys, stage}",
    JSON.stringify(r3.state.undelivered) === JSON.stringify({ keys: [`a:${G1}:no_teacher`], stage: 0 }), r3.state.undelivered);
  await addStudent(db, S2, G2);
  let r = await run(db);
  ok("C3 a new teacherless group -> 1 more row", actions(r).join() === "teacherless_homework_watchdog_ALARM" && (await alarmRows(db)) === 2, r.rows);
  r = await run(db);
  ok("C3 ...and not again next hour", r.rows.length === 0 && (await alarmRows(db)) === 2, r.rows);
  await db.query("insert into public.homework_submissions (user_id, submitted_at) values ($1, now() - interval '25 hours')", [S1]);
  r = await run(db);
  ok("C3 the stage escalates (a submission 25 h old) -> 1 more row", (await alarmRows(db)) === 3 && r.state.undelivered?.stage === 2, r.state);
  r = await run(db);
  ok("C3 ...and not again next hour", r.rows.length === 0, r.rows);
  await setToken(db, true);
  r = await run(db);
  ok("C3 the token comes back -> the alert goes out, with its row (dm_attempted 2)",
    r.sent.length === 2 && r.rows.length === 1 && r.rows[0].details.dm_attempted === 2, r);
  ok("C3 ...and the undelivered marker is cleared", r.state.undelivered === null && Array.isArray(r.state.notified_keys), r.state);
  r = await run(db);
  ok("C3 next run: silent", r.sent.length === 0 && r.rows.length === 0, r);
  await db.close();
}
{ // C4 (b): ops_net_post raising behaves like a missing token
  const db = await migratedDb();
  await resetCounters(db);
  await setToken(db, true);
  await netRaises(db, true);
  await addStudent(db, S1, G1);
  for (let i = 0; i < 3; i++) await run(db);
  ok("C4 ops_net_post raising, 3 runs -> 1 ALARM row, nothing sent",
    (await alarmRows(db)) === 1 && (await q(db, "select count(*)::int n from public.test_sent"))[0].n === 0);
  await netRaises(db, false);
  const r = await run(db);
  ok("C4 pg_net back -> the retry sends the alert", r.sent.length === 2 && (await alarmRows(db)) === 2, r);
  await db.close();
}
{ // C5 (c): staff excluded from every leg; students still counted
  const db = await migratedDb();
  await db.query("insert into public.homework_submissions (user_id) values ($1)", [STF]);
  await db.query(`insert into public.admin_actions (actor_user_id, action, details)
                  values ($1::uuid, 'homework_submission_dm_sent', jsonb_build_object('reason', 'no_group', 'student_id', $2::text))`, [STF, STF]);
  await db.query(`insert into public.admin_actions (actor_user_id, action, details)
                  values (null, 'homework_submission_dm_sent', jsonb_build_object('reason', 'no_teacher', 'student_id', $1::text))`, [T5]);
  let h = (await q(db, "select public.teacherless_homework_health() h"))[0].h;
  ok("C5 staff submission + staff sender rows (by actor, or by details.student_id) -> no alarm",
    h.alarm === false && h.pending === 0 && h.no_group_events_24h === 0 && h.no_teacher_events_24h === 0, h);
  await addStudent(db, SNG, null);
  await db.query("insert into public.homework_submissions (user_id) values ($1)", [SNG]);
  await db.query(`insert into public.admin_actions (actor_user_id, action, details)
                  values ($1::uuid, 'homework_submission_dm_sent', jsonb_build_object('reason', 'no_group', 'student_id', $2::text))`, [SNG, SNG]);
  h = (await q(db, "select public.teacherless_homework_health() h"))[0].h;
  ok("C5 control: a STUDENT with no group still alarms (pending 1, key b:none, 1 sender row)",
    h.alarm === true && h.pending === 1 && h.pending_no_group === 1 && h.keys.includes("b:none") && h.no_group_events_24h === 1, h);
  await db.query(`insert into public.admin_actions (actor_user_id, action, details)
                  values (null, 'homework_submission_dm_sent', jsonb_build_object('reason', 'no_group', 'student_id', 'not-a-uuid'))`);
  h = (await q(db, "select public.teacherless_homework_health() h"))[0].h;
  ok("C5 a malformed details.student_id neither crashes nor hides the row", h.no_group_events_24h === 2, h);
  await db.close();
}
{ // C6 (d): the kill-switch keeps the verifier green and resumes the same episode
  const db = await migratedDb();
  await resetCounters(db);
  await setToken(db, true);
  await addStudent(db, S1, G1);
  let r = await run(db);
  ok("C6 alarm delivered while enabled", r.sent.length === 2, r.sent.length);
  const keysBefore = JSON.stringify(r.state.notified_keys), lastBefore = r.state.last_alert_ms;
  await setEnabled(db, false);
  await patchState(db, { checked_at: "2020-01-01T00:00:00Z" });
  ok("C6 (setup) a stale checked_at would fail the verifier", (await staleWatchdogs(db)) === 1);
  await addStudent(db, S2, G2);                                     // news that would normally alert
  r = await run(db);
  ok("C6 disabled: returns {disabled: true}, sends nothing, writes one 'disabled' row",
    r.ret.disabled === true && r.sent.length === 0 && actions(r).join() === "teacherless_homework_watchdog_disabled", r);
  ok("C6 disabled: checked_at refreshed -> stale_watchdogs = 0", (await staleWatchdogs(db)) === 0);
  ok("C6 disabled: the episode's state is kept",
    JSON.stringify(r.state.notified_keys) === keysBefore && r.state.last_alert_ms === lastBefore &&
      r.state.alerting === true && r.state.enabled === false && r.state.last_action === "disabled", r.state);
  r = await run(db);
  ok("C6 disabled, next run: no second 'disabled' row", r.rows.length === 0 && r.sent.length === 0, r.rows);
  await setEnabled(db, true);
  r = await run(db);
  ok("C6 re-enabled: the news that arrived meanwhile alerts (same episode, new key)",
    r.sent.length === 2 && actions(r).join() === "teacherless_homework_watchdog_ALARM" && r.state.enabled === true, r);
  r = await run(db);
  ok("C6 re-enabled: then silent within the cooldown", r.sent.length === 0 && r.rows.length === 0, r);
  await db.exec("delete from public.app_settings where key = 'teacherless_homework_watchdog_state'");
  await setEnabled(db, false);
  r = await run(db);
  ok("C6 disabled with no state row: creates one with checked_at, no crash",
    r.ret.disabled === true && typeof r.state?.checked_at === "string" && (await staleWatchdogs(db)) === 0, r.state);
  await db.exec(`update public.platform_settings set value = '"garbage"' where key = 'teacherless_homework_watchdog'`);
  r = await run(db);
  ok("C6 a malformed kill-switch value fails OPEN (the watchdog runs)", r.ret.disabled === undefined && r.state.enabled === true, r.ret);
  await db.close();
}
{ // C7 (e): the reminder lands on the 24th hourly run
  const db = await migratedDb();
  await resetCounters(db);
  await setToken(db, true);
  await addStudent(db, S1, G1);
  await run(db);
  await patchState(db, { last_alert_ms: (await nowMs(db)) - 86400000 + 36 });
  let r = await run(db);
  ok("C7 24 h minus 36 ms after the alert -> the reminder goes out", r.sent.length === 2, r.state);
  await patchState(db, { last_alert_ms: (await nowMs(db)) - 82800000 - 36 });
  r = await run(db);
  ok("C7 23 h (+36 ms) after the alert -> no reminder yet", r.sent.length === 0 && r.rows.length === 0, r.state);
  const t = 1790000000000;
  const st = { alerting: true, notified_keys: ["k"], notified_stage: 0 };
  const cases: [number, string][] = [[86400000 - 36, "alert"], [84600000, "alert"], [84599999, "none"], [82800036, "none"]];
  for (const [ago, want] of cases) {
    ok(`C7 decision ${ago} ms after the last alert -> ${want}`,
      (await decision(db, true, ["k"], 0, { ...st, last_alert_ms: t - ago }, t)) === want);
  }
  await db.close();
}
{ // C8: the live state row, as it is today, under the new code
  const db = await migratedDb();
  await resetCounters(db);
  await setToken(db, true);
  let r = await run(db);
  ok("C8 live state, no alarm -> 'none', nothing sent, no rows",
    r.state.last_action === "none" && r.sent.length === 0 && r.rows.length === 0, r);
  ok("C8 state gains enabled=true and undelivered=null", r.state.enabled === true && r.state.undelivered === null, r.state);
  await addStudent(db, S1, G1);
  r = await run(db);
  ok("C8 first alarm from the live state -> alert", r.sent.length === 2 && r.rows.length === 1, r);
  await db.close();
}
{ // C9 (b): an unreadable report (health() raising) is deduped the same way
  const db = await migratedDb();
  await resetCounters(db);
  await setToken(db, false);
  await db.exec("alter table public.group_teachers rename to group_teachers_gone");
  const r1 = await run(db), r2 = await run(db), r3 = await run(db);
  ok("C9 health() raising, no token, 3 runs -> 1 ALARM row carrying the error",
    (await alarmRows(db)) === 1 && typeof r1.rows[0]?.details.error === "string" && r1.ret.alarm === true,
    [actions(r1), actions(r2), actions(r3)]);
  await setToken(db, true);
  const r4 = await run(db);
  ok("C9 token back -> the 'unreadable' alert goes out", r4.sent.length === 2 &&
    String(r4.sent[0].body.text).includes("oʻqiy olmadi"), r4.sent);
  await db.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) Deno.exit(1);
