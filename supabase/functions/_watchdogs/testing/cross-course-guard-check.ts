// Applies 20260930181000_cross_course_move_guard.sql to a real PostgreSQL (PGlite) on top of the LIVE
// hw_dm_health_stats() and admin_assign_group() definitions, then drives the new guard trigger, the detector,
// the hw_dm_health_stats fields and the watchdog end to end with a stub ops_net_post.
//
//   deno run -A --node-modules-dir=none supabase/functions/_watchdogs/testing/cross-course-guard-check.ts
//   (CCG_MIG=<path> points it at a draft of the migration instead of the committed file)
//
// Run it after ANY change to that migration, and before asking for the migration-approved label.
// TEST INFRASTRUCTURE ONLY: this directory has no index.ts, so it is never deployed, and the file is not
// named *.test.ts, so CI's `deno test supabase/functions/` does not try to fetch PGlite.
//
// Fidelity: hw_dm_health_stats.live-2026-09-30.sql is production's pg_get_functiondef byte for byte (section A
// asserts both md5s), so the migration's md5 pin and its exactly-once replace() checks run against the real
// text. admin_assign_group() is production's text too (its body has CRLF line ends, kept here). The tables are
// stubs carrying the live columns the functions read and write; auth.uid()/auth.role() read
// request.jwt.claims like Supabase's; ops_net_post records each call (or raises, when a test asks it to).

import { PGlite } from "npm:@electric-sql/pglite@0.5.8";

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

const here = (p: string) => new URL(p, import.meta.url);
const lf = (s: string) => s.replace(/\r\n/g, "\n"); // a Windows checkout is CRLF; production text is LF
const LIVE_HEALTH = lf(await Deno.readTextFile(here("./hw_dm_health_stats.live-2026-09-30.sql")));
const MIG = lf(await Deno.readTextFile(
  Deno.env.get("CCG_MIG") ?? here("../../../migrations/20260930181000_cross_course_move_guard.sql")));

// production, 2026-09-30: md5(pg_get_functiondef(oid)) and md5(replace(prosrc, CR, ''))
const PROD_HEALTH = { def: "5964793a61b404e39a1cad7cfd1d24cd", body: "fa76b14cdcfeb3c84e5220852e0e6bef" };
const PROD_ASSIGN_BODY = "f712c9048c7a2dabb9b07cbd8bbdfc0f";

// admin_assign_group(), production's pg_get_functiondef (the body's CRLF line ends are production's).
const LIVE_ASSIGN = "CREATE OR REPLACE FUNCTION public.admin_assign_group(_user_ids uuid[], _group_id uuid)\n" +
  " RETURNS integer\n LANGUAGE plpgsql\n SECURITY DEFINER\n SET search_path TO 'public'\nAS $function$\r\n" +
  [
    "DECLARE",
    "  uid uuid := auth.uid();",
    "  n integer;",
    "BEGIN",
    "  IF uid IS NULL OR NOT public.has_role(uid,'admin'::app_role) THEN",
    "    RAISE EXCEPTION 'forbidden';",
    "  END IF;",
    "  UPDATE public.profiles SET group_id = _group_id WHERE id = ANY(_user_ids);",
    "  GET DIAGNOSTICS n = ROW_COUNT;",
    "  INSERT INTO public.audit_log (actor_user_id, target_user_id, action, old_value, new_value)",
    "    VALUES (uid, NULL, 'bulk_assign_group',",
    "            jsonb_build_object('user_ids', to_jsonb(_user_ids)),",
    "            jsonb_build_object('group_id', _group_id, 'count', n));",
    "  RETURN n;",
    "END;",
    "",
  ].join("\r\n") + "$function$\n";

const C5 = "c5c5c5c5-0000-0000-0000-000000000005"; // AI CREATORS 5.0
const C6 = "c6c6c6c6-0000-0000-0000-000000000006"; // AI CREATORS CHALLENGE 6.0
const C4 = "c4c4c4c4-0000-0000-0000-000000000004"; // AI CREATORS 4.0 (a third course)
const G5A = "5a000000-0000-0000-0000-00000000005a"; // 1-GURUH PRE 5.0, chat -1003718576417
const G5B = "5b000000-0000-0000-0000-00000000005b"; // 2-GURUH VIP 5.0, chat -1004310467008
const G6A = "6a000000-0000-0000-0000-00000000006a"; // AC CHALLENGE | 3-GURUH, chat -1003714608284
const G6B = "6b000000-0000-0000-0000-00000000006b"; // AC CHALLENGE | 4-GURUH, chat via telegram_group_url only
const GNC = "0c000000-0000-0000-0000-00000000000c"; // a group with no course
const M5 = "d5000000-0000-0000-0000-000000000001", M6 = "d6000000-0000-0000-0000-000000000001", M4 = "d4000000-0000-0000-0000-000000000001";
const A5 = "a5000000-0000-0000-0000-000000000001", A6 = "a6000000-0000-0000-0000-000000000001", A4 = "a4000000-0000-0000-0000-000000000001";
const AD1 = "ad000000-0000-0000-0000-000000000001"; // admin, telegram 9001
const AD2 = "ad000000-0000-0000-0000-000000000002"; // superadmin, telegram 9002
const S1 = "51000000-0000-0000-0000-000000000001"; // 5.0 student, 1 waiting 5.0 submission (the self-test vector)
const S2 = "52000000-0000-0000-0000-000000000002"; // 5.0 student, all graded
const S3 = "53000000-0000-0000-0000-000000000003"; // 5.0 student, 1 stale 5.0 submission
const S4 = "54000000-0000-0000-0000-000000000004"; // 5.0 student, 1 waiting 4.0 submission (a third course)

const SCHEMA = `
set timezone = 'UTC';
create role anon; create role authenticated; create role service_role;
create schema auth;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'sub', '')::uuid $$;
create function auth.role() returns text language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'role' $$;
create schema cron;
create table cron.job (jobid bigserial primary key, jobname text unique, schedule text, command text);
create table cron.job_run_details (jobid bigint, start_time timestamptz, status text);
create function cron.schedule(p_name text, p_schedule text, p_command text) returns bigint language plpgsql as $$
declare _id bigint;
begin
  insert into cron.job (jobname, schedule, command) values (p_name, p_schedule, p_command)
  on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command returning jobid into _id;
  return _id;
end $$;
create function cron.unschedule(p_name text) returns boolean language plpgsql as $$
begin
  delete from cron.job where jobname = p_name;
  if not found then raise exception 'could not find valid entry for job ''%''', p_name; end if;
  return true;
end $$;

create type public.app_role as enum ('admin', 'student', 'teacher', 'superadmin');
create table public.courses (id uuid primary key, title text not null, published boolean not null default true);
create table public.groups (id uuid primary key, name text not null, course_id uuid, teacher_id uuid,
  homework_topic_url text, homework_topic_id bigint, telegram_group_url text, daily_task_chat_id bigint);
create table public.group_module_topics (id uuid primary key default gen_random_uuid(), group_id uuid, module_id uuid,
  telegram_topic_url text, telegram_topic_id integer);
create table public.modules (id uuid primary key, course_id uuid, title text, position integer);
create table public.homework_assignments (id uuid primary key, module_id uuid, title text, task_number integer, sap_number integer);
create table public.profiles (id uuid primary key, name text, last_name text, email text, telegram_username text,
  telegram_id bigint, group_id uuid references public.groups(id) on delete set null, status text not null default 'active',
  archived_at timestamptz, updated_at timestamptz);
create table public.user_roles (id uuid primary key default gen_random_uuid(), user_id uuid not null, role public.app_role not null);
create table public.homework_submissions (id uuid primary key default gen_random_uuid(), assignment_id uuid not null,
  user_id uuid not null, submitted_at timestamptz not null default now(), score smallint,
  score_is_stale boolean not null default false, telegram_chat_id bigint, telegram_message_id integer, media jsonb,
  source text);
create table public.homework_teacher_dm_queue (id bigserial primary key, sent_at timestamptz, scheduled_for timestamptz,
  error text, created_at timestamptz default now(), assignment_title text);
create table public.webhook_inbox (id bigserial primary key, from_user_id bigint, update_type text, received_at timestamptz,
  raw_update jsonb, chat_id bigint, message_id bigint, message_thread_id bigint);
create table public.hw_pending_posts (id bigserial primary key, telegram_chat_id bigint, first_message_id bigint,
  media jsonb, user_id uuid, created_at timestamptz default now());
create table public.admin_actions (id uuid primary key default gen_random_uuid(), actor_user_id uuid,
  action text not null, target_user_id uuid, target_resource_type text, target_resource_id uuid,
  details jsonb not null default '{}'::jsonb, created_at timestamptz not null default clock_timestamp());
create table public.audit_log (id uuid primary key default gen_random_uuid(), actor_user_id uuid, target_user_id uuid,
  action text, old_value jsonb, new_value jsonb, created_at timestamptz default now());
create table public.app_settings (key text primary key, value jsonb not null, description text, updated_by uuid,
  updated_at timestamptz not null default now());
create table public.platform_settings (key text primary key, value jsonb not null,
  updated_at timestamptz not null default now(), updated_by uuid);

create function public.has_role(_user_id uuid, _role public.app_role) returns boolean language sql stable as $$
  select exists (select 1 from public.user_roles where user_id = _user_id and role = _role) $$;

-- Stand-ins for the live profiles triggers whose ORDER matters (names and timing are production's).
create table public.test_enrolled (user_id uuid, group_id uuid, at timestamptz default clock_timestamp());
create function public.test_sync_enrollment() returns trigger language plpgsql as $$
begin insert into public.test_enrolled (user_id, group_id) values (new.id, new.group_id); return new; end $$;
create trigger trg_profiles_sync_group_enrollment after insert or update of group_id on public.profiles
  for each row when (new.group_id is not null) execute function public.test_sync_enrollment();
create function public.test_touch() returns trigger language plpgsql as $$ begin new.updated_at := now(); return new; end $$;
create trigger trg_profiles_updated before update on public.profiles for each row execute function public.test_touch();
create function public.test_column_guard() returns trigger language plpgsql as $$ begin return new; end $$;
create trigger trg_profiles_zz_column_guard before insert or update on public.profiles for each row
  execute function public.test_column_guard();

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

insert into public.courses (id, title) values ('${C5}', 'AI CREATORS 5.0'), ('${C6}', 'AI CREATORS CHALLENGE 6.0'),
  ('${C4}', 'AI CREATORS 4.0');
insert into public.groups (id, name, course_id, homework_topic_url, homework_topic_id, telegram_group_url, daily_task_chat_id) values
  ('${G5A}', '1-GURUH PRE 5.0', '${C5}', 'https://t.me/c/3718576417/7', 7, null, null),
  ('${G5B}', '2-GURUH VIP 5.0', '${C5}', 'https://t.me/c/4310467008/7', 7, null, null),
  ('${G6A}', 'AC CHALLENGE | 3-GURUH', '${C6}', 'https://t.me/c/3714608284/5', 5, null, -1003714608284),
  ('${G6B}', 'AC CHALLENGE | 4-GURUH', '${C6}', null, null, 'https://t.me/c/4463424516/1', null),
  ('${GNC}', 'Sandbox', null, 'https://t.me/c/1111111111/2', 2, null, null);
insert into public.modules values ('${M5}', '${C5}', 'AI BILAN PROFESSIONAL RASM', 1), ('${M6}', '${C6}', 'AI BILAN PROFESSIONAL RASM', 1),
  ('${M4}', '${C4}', 'ESKI', 0);
insert into public.homework_assignments values ('${A5}', '${M5}', '2-MODUL ATIR', 3, null), ('${A6}', '${M6}', '2-MODUL ATIR', 3, null),
  ('${A4}', '${M4}', 'ESKI VAZIFA', 1, null);
insert into public.profiles (id, name, last_name, telegram_id, group_id) values
  ('${AD1}', 'Admin', null, 9001, null), ('${AD2}', 'Super', null, 9002, null),
  ('${S1}', 'Aziza', 'Karimova', 1001, '${G5A}'), ('${S2}', 'Bobur', null, 1002, '${G5A}'),
  ('${S3}', 'Dilnoza', null, 1003, '${G5B}'), ('${S4}', 'Eldor', null, 1004, '${G5B}');
insert into public.user_roles (user_id, role) values ('${AD1}', 'admin'), ('${AD2}', 'superadmin');
insert into public.homework_submissions (assignment_id, user_id, submitted_at, score, score_is_stale, telegram_chat_id) values
  ('${A5}', '${S1}', now() - interval '2 days', null, false, -1003718576417),
  ('${A5}', '${S2}', now() - interval '5 days', 9, false, -1003718576417),
  ('${A5}', '${S3}', now() - interval '3 days', 6, true, -1004310467008),
  ('${A4}', '${S4}', now() - interval '90 days', null, false, -1009999999999);
delete from public.test_enrolled;   -- the seed INSERTs above fired the enrollment stand-in; tests count moves only
`;

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail !== undefined ? "  -- " + JSON.stringify(detail) : ""}`); }
}
async function q(db: PGlite, sql: string, params: unknown[] = []): Promise<Row[]> {
  return (await db.query(sql, params)).rows as Row[];
}
async function freshDb(opts: { health?: string; noVector?: boolean } = {}): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(opts.health ?? LIVE_HEALTH);
  await db.exec("revoke execute on function public.hw_dm_health_stats() from public, anon, authenticated;" +
    "grant execute on function public.hw_dm_health_stats() to service_role;");
  await db.exec(LIVE_ASSIGN);
  await db.exec("grant execute on function public.admin_assign_group(uuid[], uuid) to anon, authenticated, service_role;");
  if (opts.noVector) {
    await db.exec(`update public.homework_submissions set score = 8, score_is_stale = false where user_id in ('${S1}', '${S3}')`);
  }
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
async function migratedDb(opts: { noVector?: boolean } = {}): Promise<PGlite> {
  const db = await freshDb(opts);
  const err = await applyMigration(db);
  if (err) throw new Error("migration failed: " + err);
  return db;
}
/** Runs `sql`; returns null on success or the error message. */
async function tryExec(db: PGlite, sql: string, params: unknown[] = []): Promise<string | null> {
  try { await db.query(sql, params); return null; } catch (e) { return String((e as Error).message); }
}
const groupOf = async (db: PGlite, id: string) => (await q(db, "select group_id from public.profiles where id = $1", [id]))[0]?.group_id;
const refusals = async (db: PGlite) =>
  Number((await q(db, "select case when is_called then last_value else 0 end as n from public.course_move_refusals_seq"))[0].n);
const rowsOf = (db: PGlite, action: string) =>
  q(db, "select actor_user_id, target_user_id, details from public.admin_actions where action = $1 order by created_at", [action]);
const health = async (db: PGlite) => (await q(db, "select public.cross_course_health() h"))[0].h as Row;
const stats = async (db: PGlite) => (await q(db, "select public.hw_dm_health_stats() s"))[0].s as Row;

// ───────────── A. fidelity of the live fixtures ─────────────
console.log("A. live fixtures");
{
  const db = await freshDb();
  const r = await q(db, `select proname, md5(pg_get_functiondef(oid)) d, md5(replace(prosrc, E'\\r', '')) b
                           from pg_proc where proname in ('hw_dm_health_stats', 'admin_assign_group') order by proname`);
  const h = r.find((x) => x.proname === "hw_dm_health_stats"), a = r.find((x) => x.proname === "admin_assign_group");
  ok("hw_dm_health_stats: definition byte-identical to production", h?.d === PROD_HEALTH.def, h);
  ok("hw_dm_health_stats: body md5 equals production's (the migration's pin)", h?.b === PROD_HEALTH.body, h);
  ok("admin_assign_group: body md5 equals production's", a?.b === PROD_ASSIGN_BODY, a);
  // The bug, on the live function: an admin moves a 5.0 student with waiting 5.0 homework into a 6.0 group.
  await db.exec(`set request.jwt.claims = '{"sub": "${AD1}", "role": "authenticated"}'`);
  const n = (await q(db, "select public.admin_assign_group(array[$1]::uuid[], $2) n", [S1, G6A]))[0].n;
  ok("LIVE: admin_assign_group moves a student with waiting homework across courses (the gap)",
    n === 1 && (await groupOf(db, S1)) === G6A, n);
  await db.close();
}

// ───────────── B. the migration ─────────────
console.log("B. migration: applies, pinned, replay-safe, grants");
{
  const db = await freshDb();
  const before = (await q(db, `select coalesce(array_to_string(proacl, ','), '') a, proowner::int o, prosecdef s
                                 from pg_proc where proname = 'hw_dm_health_stats'`))[0];
  const err = await applyMigration(db);
  ok("applies on the live definitions", err === null, err);
  const after = (await q(db, `select coalesce(array_to_string(proacl, ','), '') a, proowner::int o, prosecdef s, prosrc
                                from pg_proc where proname = 'hw_dm_health_stats'`))[0];
  ok("hw_dm_health_stats: owner / ACL / SECURITY DEFINER unchanged",
    after.a === before.a && after.o === before.o && after.s === before.s, { before, after: after.a });
  ok("hw_dm_health_stats: carries the marker and the new block", after.prosrc.includes("(20260930181000)") &&
    after.prosrc.includes("from (select public.cross_course_health() as h) x;"));
  // Every live line survives, in order (only additions).
  const bodyOf = (t: string) => t.split("AS $function$")[1].split("$function$")[0].split("\n");
  const live = bodyOf(LIVE_HEALTH), now = after.prosrc.split("\n");
  let j = 0;
  for (const line of now) if (j < live.length && line === live[j]) j++;
  ok("hw_dm_health_stats: every live line is kept, in order", j === live.length, { kept: j, of: live.length });
  const acl = await q(db, `select proname, coalesce(array_to_string(proacl, ','), '') a, prosecdef s, provolatile v
                             from pg_proc where proname in ('course_move_facts', 'profiles_course_move_guard', 'cross_course_health',
                               'cross_course_alert_decision', 'cross_course_alert_text', 'cross_course_watchdog') order by proname`);
  ok("6 new functions", acl.length === 6, acl.map((r) => r.proname));
  for (const r of acl) {
    ok(`${r.proname}: no PUBLIC / anon / authenticated EXECUTE`,
      !/(^|,)=X/.test(r.a) && !r.a.includes("anon=") && !r.a.includes("authenticated="), r.a);
  }
  const by = Object.fromEntries(acl.map((r) => [r.proname, r]));
  ok("SECURITY DEFINER only where needed (guard, watchdog)", by.profiles_course_move_guard.s && by.cross_course_watchdog.s &&
    !by.course_move_facts.s && !by.cross_course_health.s && !by.cross_course_alert_decision.s && !by.cross_course_alert_text.s);
  ok("decision and text are IMMUTABLE (pure); facts and health STABLE",
    by.cross_course_alert_decision.v === "i" && by.cross_course_alert_text.v === "i" &&
    by.course_move_facts.v === "s" && by.cross_course_health.v === "s");
  const seq = await q(db, "select has_sequence_privilege('anon', 'public.course_move_refusals_seq', 'USAGE') a, " +
    "has_sequence_privilege('authenticated', 'public.course_move_refusals_seq', 'USAGE') b");
  ok("refusal counter not usable by anon / authenticated", seq[0].a === false && seq[0].b === false, seq);
  const tg = await q(db, `select tgname, pg_get_triggerdef(oid) d from pg_trigger
                           where tgrelid = 'public.profiles'::regclass and not tgisinternal order by tgname`);
  const g = tg.find((t) => t.tgname === "trg_profiles_aa_course_move_guard");
  ok("trigger: AFTER UPDATE OF group_id, FOR EACH ROW, WHEN both groups set and different",
    !!g && /AFTER UPDATE OF group_id ON public\.profiles FOR EACH ROW WHEN \(\(\(old\.group_id IS DISTINCT FROM new\.group_id\) AND \(old\.group_id IS NOT NULL\) AND \(new\.group_id IS NOT NULL\)\)\)/.test(g.d), g?.d);
  const lastBefore = (await q(db, `select t.tgname from pg_trigger t where t.tgrelid = 'public.profiles'::regclass
      and not t.tgisinternal and t.tgenabled <> 'D' and (t.tgtype & 1) = 1 and (t.tgtype & 2) = 2 order by t.tgname desc limit 1`))[0].tgname;
  ok("#222's rule holds: trg_profiles_zz_column_guard is still the LAST before-row trigger", lastBefore === "trg_profiles_zz_column_guard", lastBefore);
  const job = await q(db, "select schedule, command from cron.job where jobname = 'cross-course-watchdog'");
  ok("cron 'cross-course-watchdog' hourly at :49", job.length === 1 && job[0].schedule === "49 * * * *" &&
    job[0].command.includes("public.cross_course_watchdog()"), job);
  const inst = await rowsOf(db, "cross_course_move_guard_installed");
  ok("audit row once; the live guard self-test REFUSED the real vector",
    inst.length === 1 && String(inst[0].details.live_guard_selftest).startsWith("refused as expected: cross_course_refused:"), inst);
  // The oldest waiting submission is S3's stale one (3 days), so S3 is the vector; nobody may have moved.
  ok("the self-test's refused move left everyone in place", (await groupOf(db, S3)) === G5B && (await groupOf(db, S1)) === G5A);
  ok("the self-test used the oldest waiting submission's student (S3, stale)",
    String((await rowsOf(db, "cross_course_move_guard_installed"))[0].details.live_guard_selftest).includes("Dilnoza"));
  ok("the self-test's refusal bumped the counter once", (await refusals(db)) === 1);
  const st = (await q(db, "select value from public.app_settings where key = 'cross_course_watchdog_state'"))[0]?.value;
  ok("state seeded with refusals_seen = 1 (the self-test's own refusal is not a new event)",
    st?.refusals_seen === 1 && st?.alerting === false && st?.seeded_by === "20260930181000", st);
  ok("nothing leaked from the rolled-back self-test (no enrollment, no move row)",
    (await q(db, "select count(*)::int n from public.test_enrolled"))[0].n === 0 &&
    (await rowsOf(db, "cross_course_move")).length === 0);
  // Replay: a second application is a no-op for the rewrite and never duplicates the audit row.
  const err2 = await applyMigration(db);
  ok("replay: applies again cleanly", err2 === null, err2);
  const after2 = (await q(db, "select prosrc from pg_proc where proname = 'hw_dm_health_stats'"))[0].prosrc;
  ok("replay: hw_dm_health_stats unchanged (marker skip)", after2 === after.prosrc);
  ok("replay: audit row still once", (await rowsOf(db, "cross_course_move_guard_installed")).length === 1);
  ok("replay: one cron job", (await q(db, "select count(*)::int n from cron.job where jobname = 'cross-course-watchdog'"))[0].n === 1);
  await db.close();
}
{
  const db = await freshDb({ noVector: true });
  const err = await applyMigration(db);
  ok("no live vector: applies, and records the live self-test as skipped", err === null &&
    String((await rowsOf(db, "cross_course_move_guard_installed"))[0]?.details.live_guard_selftest).startsWith("skipped"), err);
  ok("no live vector: counter untouched, state refusals_seen = 0", (await refusals(db)) === 0 &&
    (await q(db, "select value->>'refusals_seen' v from public.app_settings where key = 'cross_course_watchdog_state'"))[0].v === "0");
  await db.close();
}
{
  const drifted = LIVE_HEALTH.replace("-- U13: active-course groups", "-- U13: active course groups");
  const db = await freshDb({ health: drifted });
  const err = await applyMigration(db);
  ok("pin: a drifted live hw_dm_health_stats aborts the whole migration", !!err && err.includes("changed since it was verified"), err);
  const t = await q(db, "select count(*)::int n from pg_trigger where tgname = 'trg_profiles_aa_course_move_guard'");
  ok("pin: nothing was left behind (atomic)", t[0].n === 0, t);
  await db.close();
}
{
  // The exactly-once check on its own (the pin cannot be bypassed from outside, so exercise the same loop on a
  // text with a doubled anchor): the migration's counting expression must say 2, not 1.
  const db = await freshDb();
  const n = (await q(db, `select (length(t) - length(replace(t, a, ''))) / length(a) as n
                            from (select $1::text as t, $2::text as a) x`,
    [LIVE_HEALTH + LIVE_HEALTH, "  return jsonb_build_object(\n"]))[0].n;
  ok("exactly-once counting sees a doubled anchor as 2", n === 2, n);
  await db.close();
}

// ───────────── C. the guard ─────────────
console.log("C. guard: every path, every case");
{
  const db = await migratedDb();
  await db.exec(`set request.jwt.claims = '{"sub": "${AD1}", "role": "authenticated"}'`);
  const r0 = await refusals(db);
  let e = await tryExec(db, "select public.admin_assign_group(array[$1]::uuid[], $2)", [S1, G6A]);
  ok("admin_assign_group: 5.0 -> 6.0 with 1 waiting -> refused", !!e && e.startsWith("cross_course_refused: Aziza Karimova boshqa kursga (AI CREATORS CHALLENGE 6.0) o'tkazilmadi: eski kursda (AI CREATORS 5.0) 1 ta vazifa hali baholanmagan."), e);
  ok("... not moved, no enrollment, no audit_log row, counter +1", (await groupOf(db, S1)) === G5A &&
    (await q(db, "select count(*)::int n from public.test_enrolled"))[0].n === 0 &&
    (await q(db, "select count(*)::int n from public.audit_log"))[0].n === 0 && (await refusals(db)) === r0 + 1);
  e = await tryExec(db, "select public.admin_assign_group(array[$1, $2]::uuid[], $3)", [S2, S1, G6A]);
  ok("admin_assign_group bulk: one blocked student -> NOBODY moved (all-or-nothing)",
    !!e && (await groupOf(db, S2)) === G5A && (await groupOf(db, S1)) === G5A, e);
  e = await tryExec(db, "update public.profiles set group_id = $2 where id = $1", [S3, G6A]);
  ok("direct UPDATE (dashboard / CSV path): a STALE-graded submission counts as waiting -> refused",
    !!e && e.includes("1 ta vazifa hali baholanmagan") && (await groupOf(db, S3)) === G5B, e);
  const n = (await q(db, "select public.admin_assign_group(array[$1]::uuid[], $2) n", [S2, G6A]))[0].n;
  const mv = await rowsOf(db, "cross_course_move");
  ok("0 waiting (all graded): the admin's move goes through", n === 1 && (await groupOf(db, S2)) === G6A, n);
  ok("... and is recorded: cross_course_move {actor, facts, override=false, jwt_role}", mv.length === 1 &&
    mv[0].actor_user_id === AD1 && mv[0].target_user_id === S2 && mv[0].details.override === false &&
    mv[0].details.from_course_id === C5 && mv[0].details.to_course_id === C6 && mv[0].details.old_course_waiting === 0 &&
    mv[0].details.jwt_role === "authenticated", mv);
  ok("... and enrollment sync runs after the guard", (await q(db, "select count(*)::int n from public.test_enrolled where user_id = $1", [S2]))[0].n === 1);
  e = await tryExec(db, "update public.profiles set group_id = $2 where id = $1", [S4, G6A]);
  ok("waiting homework of a THIRD course (4.0) does not block a 5.0 -> 6.0 move", e === null && (await groupOf(db, S4)) === G6A, e);
  e = await tryExec(db, "update public.profiles set group_id = $2 where id = $1", [S1, G5B]);
  ok("same course (5.0 -> 5.0) with waiting work: allowed, nothing recorded (PR-3a's same-course flow)",
    e === null && (await groupOf(db, S1)) === G5B && (await rowsOf(db, "cross_course_move")).length === 2, e);
  e = await tryExec(db, "update public.profiles set group_id = $2 where id = $1", [S1, GNC]);
  ok("into a group with no course: allowed (not provably a course change)", e === null, e);
  e = await tryExec(db, "update public.profiles set group_id = $2 where id = $1", [S1, G5A]);
  e = await tryExec(db, "update public.profiles set group_id = null where id = $1", [S1]);
  ok("clearing the group (-> NULL): allowed", e === null && (await groupOf(db, S1)) === null, e);
  e = await tryExec(db, "update public.profiles set group_id = $2 where id = $1", [S1, G6A]);
  ok("placing a student with no group: allowed (not a move)", e === null && (await groupOf(db, S1)) === G6A, e);
  await db.exec("update public.profiles set group_id = null where id = '" + S1 + "'");
  await db.exec("update public.profiles set group_id = '" + G5A + "' where id = '" + S1 + "'");
  e = await tryExec(db, "update public.profiles set name = 'Aziza' where id = $1", [S1]);
  ok("an UPDATE that does not touch group_id never runs the guard", e === null);
  // The owner's escape hatch.
  await db.exec("begin; set local app.course_move_override = 'on';");
  e = await tryExec(db, "update public.profiles set group_id = $2 where id = $1", [S1, G6A]);
  await db.exec("commit;");
  const ov = (await rowsOf(db, "cross_course_move")).at(-1);
  ok("override (set local app.course_move_override = 'on'): moved, recorded override=true with the waiting count",
    e === null && (await groupOf(db, S1)) === G6A && ov?.details.override === true && ov?.details.old_course_waiting === 1, { e, ov });
  const leak = await q(db, "select coalesce(current_setting('app.course_move_override', true), '') v");
  ok("override is transaction-local (gone after commit)", leak[0].v === "" , leak);
  await db.close();
}

// ───────────── D. the detector + hw_dm_health_stats ─────────────
console.log("D. detector: cross_course_pending, cross_chat_captures, guard_down, hw_dm_health_stats");
{
  const db = await migratedDb();
  let h = await health(db);
  // S4 (in a 5.0 group) still has a WAITING 4.0 submission: old-course work outside the current group's course
  // is exactly what cross_course_pending counts.
  ok("a waiting submission of an older course (4.0) while in a 5.0 group is counted", h.cross_course_pending === 1 &&
    h.pending[0]?.student === "Eldor" && h.pending[0]?.task_course === "AI CREATORS 4.0", h.pending);
  await db.exec(`update public.homework_submissions set score = 5 where user_id = '${S4}'`);
  h = await health(db);
  ok("clean: guard_ok, 0 / 0, no keys, no alarm", h.guard_ok === true && h.cross_course_pending === 0 &&
    h.cross_chat_captures === 0 && h.keys.length === 0 && h.alarm === false, h);
  ok("the retired-chat submission (no current group) is not counted", h.cross_chat_captures === 0);
  let s = await stats(db);
  ok("hw_dm_health_stats: both fields 0, every old field still there",
    s.cross_course_pending === 0 && s.cross_chat_captures === 0 && "voice_dm_failed_24h" in s && "stale_watchdogs" in s &&
    Object.keys(s).length === 17, s);
  // A move that escaped (the owner override) leaves waiting 5.0 work with a 6.0 student.
  await db.exec("begin; set local app.course_move_override = 'on'; update public.profiles set group_id = '" + G6A +
    "' where id = '" + S1 + "'; commit;");
  h = await health(db);
  const sid = (await q(db, "select id from public.homework_submissions where user_id = $1", [S1]))[0].id;
  ok("escaped move: cross_course_pending = 1, key p:<submission>", h.cross_course_pending === 1 &&
    JSON.stringify(h.keys) === JSON.stringify([`p:${sid}`]) && h.alarm === true, h);
  ok("sample names the student, the task's course/module/title and the student's group", h.pending[0]?.student === "Aziza Karimova" &&
    h.pending[0]?.label === "AI CREATORS 5.0 · M2 — 2-MODUL ATIR" && h.pending[0]?.group === "AC CHALLENGE | 3-GURUH" &&
    h.pending[0]?.group_course === "AI CREATORS CHALLENGE 6.0", h.pending);
  ok("moves_24h / overrides_24h count the recorded move", h.moves_24h === 1 && h.overrides_24h === 1, h);
  s = await stats(db);
  ok("hw_dm_health_stats.cross_course_pending = 1", s.cross_course_pending === 1 && s.cross_chat_captures === 0, s);
  await db.exec("update public.homework_submissions set score = 7 where id = '" + sid + "'");
  ok("graded -> cleared", (await health(db)).cross_course_pending === 0);
  // Capture in another course's chat: a 5.0 task filed from the Challenge chat (shared-topic URL / daily chat id).
  await db.exec(`insert into public.homework_submissions (assignment_id, user_id, score, telegram_chat_id)
                 values ('${A5}', '${S2}', 8, -1003714608284)`);
  h = await health(db);
  ok("5.0 task captured in a 6.0 chat (even graded): cross_chat_captures = 1", h.cross_chat_captures === 1 &&
    h.chat[0]?.chat_group === "AC CHALLENGE | 3-GURUH" && h.chat[0]?.chat_course === "AI CREATORS CHALLENGE 6.0" &&
    h.keys.some((k: string) => k.startsWith("c:")), h);
  await db.exec(`insert into public.homework_submissions (assignment_id, user_id, score, telegram_chat_id)
                 values ('${A6}', '${S2}', 8, -1004463424516)`);
  ok("a 6.0 task in a chat known only by telegram_group_url: same course, not counted", (await health(db)).cross_chat_captures === 1);
  await db.exec(`insert into public.homework_submissions (assignment_id, user_id, score, telegram_chat_id)
                 values ('${A5}', '${S2}', 8, -1004463424516)`);
  ok("a 5.0 task in that chat: counted (telegram_group_url is part of the chat map)", (await health(db)).cross_chat_captures === 2);
  await db.exec(`insert into public.group_module_topics (group_id, module_id, telegram_topic_url, telegram_topic_id)
                 values ('${G6B}', '${M6}', 'https://t.me/c/5555555555/9', 9)`);
  await db.exec(`insert into public.homework_submissions (assignment_id, user_id, score, telegram_chat_id)
                 values ('${A5}', '${S2}', 8, -1005555555555)`);
  ok("a per-module topic URL maps its chat too", (await health(db)).cross_chat_captures === 3);
  await db.exec(`insert into public.homework_submissions (assignment_id, user_id, score, telegram_chat_id)
                 values ('${A5}', '${S2}', 8, -1001111111111)`);
  ok("a chat of a group with NO course is not a course mismatch", (await health(db)).cross_chat_captures === 3);
  s = await stats(db);
  ok("hw_dm_health_stats.cross_chat_captures = 3", s.cross_chat_captures === 3, s);
  // Guard disabled: the detector says so.
  await db.exec("alter table public.profiles disable trigger trg_profiles_aa_course_move_guard");
  h = await health(db);
  ok("guard disabled -> guard_ok false, key guard_down, alarm", h.guard_ok === false && h.keys[0] === "guard_down" && h.alarm === true, h.keys);
  await db.exec("alter table public.profiles enable trigger trg_profiles_aa_course_move_guard");
  // The health check itself failing: -1, loud, and the endpoint still answers.
  await db.exec("alter table public.group_module_topics rename to gmt_gone");
  s = await stats(db);
  ok("health failing -> both fields -1, hw_dm_health_stats still returns", s.cross_course_pending === -1 &&
    s.cross_chat_captures === -1 && typeof s.unsent_overdue === "number", s);
  await db.exec("alter table public.gmt_gone rename to group_module_topics");
  await db.close();
}

// ───────────── E. the watchdog ─────────────
console.log("E. watchdog: episodes, de-dup, reminders, recovery, events, failures");
{
  const db = await migratedDb();
  const setToken = (on: boolean) => on
    ? db.exec(`insert into public.platform_settings (key, value) values ('telegram', '{"bot_token": "TEST:TOKEN"}')
               on conflict (key) do update set value = excluded.value`)
    : db.exec(`delete from public.platform_settings where key = 'telegram'`);
  let seenSent = 0, seenRows = 0;
  const reset = async () => {
    seenSent = (await q(db, "select coalesce(max(id), 0)::int m from public.test_sent"))[0].m;
    seenRows = (await q(db, "select count(*)::int n from public.admin_actions"))[0].n;
  };
  const run = async () => {
    const ret = (await q(db, "select public.cross_course_watchdog() r"))[0].r as Row;
    const sent = await q(db, "select id::int, url, body, headers, purpose from public.test_sent where id > $1 order by id", [seenSent]);
    const rows = (await q(db, "select action, details from public.admin_actions order by created_at, id")).slice(seenRows);
    const state = (await q(db, "select value from public.app_settings where key = 'cross_course_watchdog_state'"))[0]?.value;
    await reset();
    return { ret, sent, rows, state };
  };
  const patchState = (p: Row) => db.query(`update public.app_settings set value = value || $1::jsonb
                                             where key = 'cross_course_watchdog_state'`, [JSON.stringify(p)]);
  await db.exec(`update public.homework_submissions set score = 5 where user_id = '${S4}'`); // start clean (see D)
  await reset();
  await setToken(true);
  let r = await run();
  ok("clean: 'none', nothing sent, no rows, checked_at stamped", r.ret.decision === "none" && r.sent.length === 0 &&
    r.rows.length === 0 && typeof r.state.checked_at === "string", r);
  const stale = (await q(db, `select count(*)::int n from public.app_settings where key like '%\\_watchdog\\_state'
      and coalesce((value->>'checked_at')::timestamptz, 'epoch'::timestamptz) < now() - interval '25 hours'`))[0].n;
  ok("state row name is covered by hw_dm_health_stats().stale_watchdogs (fresh = 0)", stale === 0 &&
    (await stats(db)).stale_watchdogs === 0);
  // An escaped move -> alert.
  await db.exec("begin; set local app.course_move_override = 'on'; update public.profiles set group_id = '" + G6A +
    "' where id = '" + S1 + "'; commit;");
  await reset();
  r = await run();
  const text = String(r.sent[0]?.body.text ?? "");
  ok("episode start: DM to the 2 admins, one ALARM row", r.ret.decision === "alert" && r.sent.length === 2 &&
    r.rows.filter((x) => x.action === "cross_course_watchdog_ALARM").length === 1, r);
  ok("DM goes through ops_net_post with Content-Type and purpose", r.sent.every((x) =>
    x.headers["Content-Type"] === "application/json" && x.purpose === "cross_course_watchdog" &&
    x.url.endsWith("/botTEST:TOKEN/sendMessage")), r.sent);
  ok("DM text names the student, the task and the new group", text.startsWith("🔀 Kurslararo nazorat") &&
    text.includes("1 ta baholanmagan vazifa") && text.includes("• Aziza Karimova — AI CREATORS 5.0 · M2 — 2-MODUL ATIR · hozir: AC CHALLENGE | 3-GURUH (AI CREATORS CHALLENGE 6.0)") &&
    text.includes("24 soatda 1 ta talaba boshqa kursga o‘tkazildi"), text);
  ok("state: alerting, notified_keys = the item", r.state.alerting === true && r.state.notified_keys.length === 1, r.state);
  r = await run();
  ok("same item next hour: 'none', silent, no row", r.ret.decision === "none" && r.sent.length === 0 && r.rows.length === 0, r);
  await db.exec(`insert into public.homework_submissions (assignment_id, user_id, score, telegram_chat_id)
                 values ('${A5}', '${S2}', 8, -1003714608284)`);
  r = await run();
  ok("a NEW item (a cross-chat capture): alert again", r.ret.decision === "alert" && r.sent.length === 2 &&
    String(r.sent[0].body.text).includes("1 ta vazifa boshqa kurs guruhining Telegram chatidan olingan"), r.sent[0]?.body);
  r = await run();
  ok("then silent", r.ret.decision === "none" && r.sent.length === 0);
  await patchState({ last_alert_ms: Date.now() - 86400000 - 1000 });
  r = await run();
  ok("24 h later, still there: one reminder", r.ret.decision === "alert" && r.sent.length === 2);
  await patchState({ last_alert_ms: Date.now() + 10 * 86400000 });
  r = await run();
  ok("a future last_alert_ms (clock skew / hand edit) is clamped: no reminder storm, no silence forever",
    r.ret.decision === "none" && r.state.last_alert_ms <= Date.now() + 1000, r.state.last_alert_ms);
  // Clear both items -> recovered.
  await db.exec("update public.homework_submissions set score = 9 where user_id = '" + S1 + "'");
  await db.exec("delete from public.homework_submissions where telegram_chat_id = -1003714608284 and user_id = '" + S2 + "'");
  r = await run();
  ok("cleared: one 'recovered' DM + row, alerting off", r.ret.decision === "recovered" && r.sent.length === 2 &&
    String(r.sent[0].body.text).startsWith("✅") && r.rows.some((x) => x.action === "cross_course_watchdog_recovered") &&
    r.state.alerting === false, r);
  r = await run();
  ok("then quiet", r.ret.decision === "none" && r.sent.length === 0 && r.rows.length === 0);
  // A guard refusal is an event: one alert, then nothing (no persistent keys, so no 'recovered').
  await db.exec(`set request.jwt.claims = '{"sub": "${AD1}", "role": "authenticated"}'`);
  await db.exec("update public.homework_submissions set score = null where user_id = '" + S3 + "'");
  const e = await tryExec(db, "select public.admin_assign_group(array[$1]::uuid[], $2)", [S3, G6A]);
  r = await run();
  ok("a refusal since the last run: alert (event), text says it changed nothing", !!e && r.ret.decision === "alert" &&
    r.ret.refusals_new === 1 && String(r.sent[0]?.body.text).includes("1 marta talabani boshqa kursga o‘tkazishni rad etdi"), r.ret);
  r = await run();
  ok("the event is reported once; no 'recovered' for an event", r.ret.decision === "none" && r.sent.length === 0, r.ret);
  // No bot token: nothing sent, the episode does not start, ONE undelivered ALARM row (not one per hour).
  await setToken(false);
  await db.exec("begin; set local app.course_move_override = 'on'; update public.profiles set group_id = '" + G6A +
    "' where id = '" + S3 + "'; commit;");
  const r1 = await run(), r2 = await run(), r3 = await run();
  ok("no bot token, 3 runs: 0 sent, 1 ALARM row, episode not started",
    r1.sent.length + r2.sent.length + r3.sent.length === 0 &&
    [r1, r2, r3].flatMap((x) => x.rows).filter((x) => x.action === "cross_course_watchdog_ALARM").length === 1 &&
    r3.state.alerting === false, [r1.rows.length, r2.rows.length, r3.rows.length, r3.state]);
  await setToken(true);
  await db.exec("insert into public.test_knobs values ('ops_net_post_raises')");
  r = await run();
  ok("ops_net_post raising: dm_attempted 0, the episode does not start (retried next run)",
    r.ret.dm_attempted === 0 && r.state.alerting === false, r.ret);
  await db.exec("delete from public.test_knobs");
  r = await run();
  ok("token back and pg_net healthy: the alert goes out", r.ret.decision === "alert" && r.sent.length === 2);
  // The health function failing is an alarm ('unreadable'), with the error in the text.
  await db.exec("alter table public.group_module_topics rename to gmt_gone");
  r = await run();
  ok("health() raising -> 'unreadable' alert with the error", r.ret.decision === "alert" &&
    String(r.sent[0]?.body.text).includes("cross_course_health() o‘qilmadi"), r.sent[0]?.body);
  await db.exec("alter table public.gmt_gone rename to group_module_topics");
  // Telegram's 4096 limit.
  ok("DM text capped at 3900", r.sent.every((x) => String(x.body.text).length <= 3900));
  await db.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) Deno.exit(1);
