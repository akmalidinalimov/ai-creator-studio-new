// PGlite harness for 20260930182000_grading_queue_course_filter.sql (teacher audit PR-4).
//
//   deno test -A --node-modules-dir=none --no-lock supabase/functions/_teacher/testing/grading-queue-filter-check.ts
//
// Builds production's shape of everything the migration touches on a real PostgreSQL (PGlite, PG 17): Supabase's
// roles and default privileges, auth.uid()/auth.role(), the tables the functions read, a stub ops_net_post that
// records each call, and the LIVE definitions of teacher_pending_submissions, teacher_groups,
// hw_dm_fallback_deliver, teacher_group_ids and is_group_teacher from grading_queue.live-2026-09-30.sql (section
// L asserts each one's md5 equals production's, so the migration's pins and exactly-once replace() checks run
// against the real text). Then:
//   P  the pins refuse a drifted body of each rewritten function, and a refused file changes nothing;
//   B  the bugs, reproduced on the live bodies (badge != queue; the fallback DM has no group or course);
//   A  the file applies, its self-tests pass, it replays cleanly, one audit row;
//   G  grants: the queue RPC keeps exactly its ACL; the label helpers are service_role only;
//   Q  the queue: old columns + course_id/course_title of the TASK, the zero-argument call, both filters, scope,
//      order, a moved student, co-teachers, students and anon;
//   T  teacher_groups: badge == queue for every group, the other columns unchanged;
//   F  the fallback (hour gate pinned to noon in a COPY): the DM text equals the drainer's (TypeScript) text,
//      the post button only for a t.me/c link, RBAC still applies, rows are stamped as before;
//   X  SQL = TypeScript: hw_submission_dm_text_uz on the migration's parity cases plus a fuzz set, and hw_label on
//      every live course x group x task combination.
// MIG_PATH=<file> tests a draft before it is written into its (edit-guarded) slot.
//
// CI NOTE: named *-check.ts, so CI's `deno test supabase/functions/` never collects it (PGlite needs -A). The
// SQL = TypeScript property is ALSO gated in CI by src/test/hw-label-sql-parity.test.ts (vitest) and at apply
// time by the migration's own self-test. TEST INFRASTRUCTURE ONLY: no index.ts, never deployed.

import { submissionDmText } from "../../notify-homework-submission/copy.ts";
import { hwLabel } from "../../_shared/hw-label.ts";

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

const granted = (name: "read" | "env" | "net") => {
  try { return Deno.permissions.querySync({ name }).state === "granted"; } catch { return false; }
};
const CAN_RUN = granted("read") && granted("env") && granted("net");

const here = (p: string) => new URL(p, import.meta.url);
const lf = (s: string) => s.replace(/\r\n/g, "\n"); // a Windows checkout is CRLF; production text is LF

// md5(pg_get_functiondef(oid)) and md5(prosrc), production, 2026-09-30.
const PROD: Record<string, { def: string; body: string }> = {
  teacher_pending_submissions: { def: "b90de4d5b6e5122988a2c17ee694697a", body: "c9e8e54f0a6f6cfdc821340e49f740cd" },
  teacher_groups: { def: "0d51a7e30b57942a64a717f45b55085f", body: "9665d53f561cc39f5487f3c983236019" },
  hw_dm_fallback_deliver: { def: "f18b076690a00d55aa7f54aa28ba717d", body: "a9d0d84d6f4bfb5ed3d155808ecec8aa" },
  teacher_group_ids: { def: "7875d8fb8ead69d2f57926f6737db867", body: "1d12b3f354c6d021fa342edd6f127cbc" },
  is_group_teacher: { def: "4369611511cd3466c441bcbaee51baf0", body: "94f43876ad4f105b1a58a5120ace57ca" },
};

const C5 = "c5000000-0000-0000-0000-000000000005", C5T = "AI CREATORS 5.0";
const C6 = "c6000000-0000-0000-0000-000000000006", C6T = "AI CREATORS CHALLENGE 6.0";
const M51 = "a5100000-0000-0000-0000-000000000001", M56 = "a5600000-0000-0000-0000-000000000006";
const M61 = "a6100000-0000-0000-0000-000000000001", M64 = "a6400000-0000-0000-0000-000000000004";
const A51 = "b5100000-0000-0000-0000-000000000001", A56 = "b5600000-0000-0000-0000-000000000006";
const A61 = "b6100000-0000-0000-0000-000000000001", A64 = "b6400000-0000-0000-0000-000000000004";
const G5A = "95a00000-0000-0000-0000-00000000000a";   // 1-GURUH VIP 5.0 — T1 primary
const G5B = "95b00000-0000-0000-0000-00000000000b";   // 2-GURUH VIP 5.0 — T2 primary, T1 co-teacher
const G6 = "96000000-0000-0000-0000-000000000006";    // AC CHALLENGE | 3-GURUH — no primary, T1 co-teacher
const G6X = "96000000-0000-0000-0000-0000000000ff";   // AC CHALLENGE | 4-GURUH — T3 only
const T1 = "71000000-0000-0000-0000-000000000001", T2 = "72000000-0000-0000-0000-000000000002";
const T3 = "73000000-0000-0000-0000-000000000003", AD = "ad000000-0000-0000-0000-000000000001";
const S1 = "51000000-0000-0000-0000-000000000001";   // G5A
const S2 = "52000000-0000-0000-0000-000000000002";   // G5B, a resubmission waiting for a re-grade
const S3 = "53000000-0000-0000-0000-000000000003";   // G5B, status inactive
const S4 = "54000000-0000-0000-0000-000000000004";   // G6
const S5 = "55000000-0000-0000-0000-000000000005";   // moved 5.0 -> G6: one 5.0 task, one 6.0 task
const S6 = "56000000-0000-0000-0000-000000000006";   // G6X

const SCHEMA = `
set timezone = 'UTC';
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant anon, authenticated, service_role to postgres;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges revoke execute on functions from public;
alter default privileges in schema public grant execute on functions to authenticated, service_role;

create schema auth;
grant usage on schema auth to anon, authenticated, service_role;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create function auth.role() returns text language sql stable as $$
  select nullif(current_setting('request.jwt.claim.role', true), '') $$;
grant execute on function auth.uid(), auth.role() to anon, authenticated, service_role;

create type public.app_role as enum ('admin', 'student', 'teacher', 'superadmin');
create type public.user_status as enum ('active', 'inactive', 'archived');
create table public.user_roles (id uuid primary key default gen_random_uuid(), user_id uuid not null,
  role public.app_role not null, unique (user_id, role));
create function public.has_role(_user_id uuid, _role public.app_role) returns boolean
  language sql stable security definer set search_path to 'public' as $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role); $$;
grant execute on function public.has_role(uuid, public.app_role) to anon, authenticated, service_role;

create table public.courses (id uuid primary key, title text not null);
create table public.modules (id uuid primary key, course_id uuid not null references public.courses(id) on delete cascade,
  title text not null default 'M', position integer not null);
create table public.lessons (id uuid primary key default gen_random_uuid(), module_id uuid not null references public.modules(id));
create table public.lesson_progress (user_id uuid not null, lesson_id uuid not null, completed_at timestamptz);
create table public.daily_watch_summary (user_id uuid not null, watch_date date not null);
create table public.homework_assignments (id uuid primary key,
  module_id uuid not null references public.modules(id) on delete cascade, title text not null,
  max_score smallint not null default 10, task_number integer not null default 1, parent_id uuid, sap_number integer);
create table public.groups (id uuid primary key, name text not null, course_id uuid, teacher_id uuid);
create table public.group_teachers (group_id uuid not null, teacher_id uuid not null, is_primary boolean not null default false);
create table public.profiles (id uuid primary key, name text, last_name text, telegram_username text, group_id uuid,
  status public.user_status not null default 'active', archived_at timestamptz, telegram_id bigint,
  notifications_enabled boolean, preferred_locale text);
create table public.homework_submissions (id uuid primary key default gen_random_uuid(), user_id uuid not null,
  assignment_id uuid not null references public.homework_assignments(id) on delete cascade, score integer,
  score_is_stale boolean not null default false, submitted_at timestamptz not null default now(),
  previous_score integer, attempt_number integer not null default 1, media jsonb, submitted_image_url text);
create table public.homework_teacher_dm_queue (id uuid primary key default gen_random_uuid(), submission_id uuid not null,
  teacher_id uuid not null, student_id uuid not null, group_id uuid not null, module_id uuid not null,
  assignment_id uuid not null, module_number integer not null, task_number integer not null, assignment_title text,
  student_name text, message_url text not null, scheduled_for timestamptz not null default now(),
  queued_for_quiet_hours boolean not null default false, sent_at timestamptz, error text,
  created_at timestamptz not null default now(), retry_count integer not null default 0);
create table public.platform_settings (key text primary key, value jsonb not null);
create table public.notifications_log (id uuid primary key default gen_random_uuid(), user_id uuid not null,
  notification_type text not null, payload jsonb not null default '{}'::jsonb, sent_at timestamptz not null default now());
create table public.admin_actions (id uuid primary key default gen_random_uuid(), actor_user_id uuid,
  action text not null, details jsonb not null default '{}'::jsonb, created_at timestamptz not null default now());

create table public.test_sent (id bigserial primary key, url text, body jsonb, headers jsonb, purpose text);
create function public.ops_net_post(p_url text, p_body jsonb default '{}'::jsonb, p_headers jsonb default '{}'::jsonb,
  p_purpose text default null, p_timeout_ms integer default 30000) returns bigint
  language plpgsql security definer set search_path to 'public' as $$
begin
  insert into public.test_sent (url, body, headers, purpose) values (p_url, p_body, p_headers, p_purpose);
  return 1;
end $$;
revoke execute on function public.ops_net_post(text, jsonb, jsonb, text, integer) from public, anon, authenticated;
`;

// The live grants (proacl, 2026-09-30).
const LIVE_GRANTS = `
revoke execute on function public.teacher_pending_submissions() from public, anon, authenticated;
grant execute on function public.teacher_pending_submissions() to authenticated, service_role;
revoke execute on function public.teacher_groups(uuid) from public, anon, authenticated;
grant execute on function public.teacher_groups(uuid) to authenticated, service_role;
revoke execute on function public.teacher_group_ids(uuid) from public, anon, authenticated;
grant execute on function public.teacher_group_ids(uuid) to authenticated, service_role;
revoke execute on function public.is_group_teacher(uuid, uuid) from public, anon, authenticated;
grant execute on function public.is_group_teacher(uuid, uuid) to authenticated, service_role;
revoke execute on function public.hw_dm_fallback_deliver() from public, anon, authenticated;
grant execute on function public.hw_dm_fallback_deliver() to service_role;
`;

const SEED = `
insert into public.courses (id, title) values ('${C5}', '${C5T}'), ('${C6}', '${C6T}');
insert into public.modules (id, course_id, title, position) values
  ('${M51}', '${C5}', '1- MODUL', 0), ('${M56}', '${C5}', '6- MODUL', 5),
  ('${M61}', '${C6}', '1- MODUL', 0), ('${M64}', '${C6}', '4- MODUL', 3);
insert into public.lessons (module_id) values ('${M51}'), ('${M51}'), ('${M61}');
insert into public.homework_assignments (id, module_id, title, task_number) values
  ('${A51}', '${M51}', '1- MODUL: PROMPT ENGINEERING', 1), ('${A56}', '${M56}', '4-MODUL UYGA VAZIFASI', 4),
  ('${A61}', '${M61}', '1- MODUL: PROMPT ENGINEERING', 1), ('${A64}', '${M64}', '4-MODUL UYGA VAZIFASI', 4);
insert into public.groups (id, name, course_id, teacher_id) values
  ('${G5A}', '1-GURUH VIP 5.0', '${C5}', '${T1}'), ('${G5B}', '2-GURUH VIP 5.0', '${C5}', '${T2}'),
  ('${G6}', 'AC CHALLENGE | 3-GURUH', '${C6}', null), ('${G6X}', 'AC CHALLENGE | 4-GURUH', '${C6}', '${T3}');
insert into public.group_teachers (group_id, teacher_id, is_primary) values
  ('${G5A}', '${T1}', true), ('${G5B}', '${T2}', true), ('${G5B}', '${T1}', false), ('${G6}', '${T1}', false),
  ('${G6X}', '${T3}', true);
insert into public.user_roles (user_id, role) values
  ('${T1}', 'teacher'), ('${T2}', 'teacher'), ('${T3}', 'teacher'), ('${AD}', 'admin'),
  ('${S1}', 'student'), ('${S2}', 'student'), ('${S3}', 'student'), ('${S4}', 'student'), ('${S5}', 'student'), ('${S6}', 'student');
insert into public.profiles (id, name, last_name, telegram_username, group_id, status, telegram_id) values
  ('${T1}', 'Rano', null, null, null, 'active', 7001), ('${T2}', 'Feruza', null, null, null, 'active', 7002),
  ('${T3}', 'Guli', null, null, null, 'active', 7003), ('${AD}', 'Admin', null, null, null, 'active', 9001),
  ('${S1}', 'Aziza', 'Karimova', '@aziza', '${G5A}', 'active', 5001),
  ('${S2}', 'Bobur', null, 'bobur', '${G5B}', 'active', 5002),
  ('${S3}', 'Dilnoza', null, null, '${G5B}', 'inactive', 5003),
  ('${S4}', 'Eldor', null, null, '${G6}', 'active', 5004),
  ('${S5}', 'Bek', null, 'bek', '${G6}', 'active', 5005),
  ('${S6}', 'Farrux', null, null, '${G6X}', 'active', 5006);
insert into public.daily_watch_summary (user_id, watch_date) values ('${S1}', current_date), ('${S4}', current_date);
insert into public.homework_submissions (user_id, assignment_id, score, score_is_stale, submitted_at, previous_score, attempt_number) values
  ('${S1}', '${A51}', null, false, now() - interval '5 hours', null, 1),
  ('${S1}', '${A56}', 9,    false, now() - interval '9 hours', null, 1),
  ('${S2}', '${A51}', 7,    true,  now() - interval '4 hours', 7, 2),
  ('${S3}', '${A51}', null, false, now() - interval '3 hours', null, 1),
  ('${S4}', '${A61}', null, false, now() - interval '2 hours', null, 1),
  ('${S5}', '${A56}', null, false, now() - interval '1 hours', null, 1),
  ('${S5}', '${A64}', null, false, now() - interval '30 minutes', null, 1),
  ('${S6}', '${A61}', null, false, now() - interval '20 minutes', null, 1);
insert into public.platform_settings (key, value) values ('telegram', '{"bot_token": "TESTTOKEN"}');
`;

// The queue rows the fallback sees (all 20 minutes overdue).
const QUEUE = `
insert into public.homework_teacher_dm_queue (submission_id, teacher_id, student_id, group_id, module_id, assignment_id,
  module_number, task_number, assignment_title, student_name, message_url, scheduled_for) values
  -- a moved student's 5.0 task, delivered to a 6.0 group's teacher: the text must show the mismatch
  ((select id from public.homework_submissions where user_id = '${S5}' and assignment_id = '${A56}'), '${T1}', '${S5}', '${G6}',
   '${M56}', '${A56}', 6, 4, '4-MODUL UYGA VAZIFASI', 'Bek (@bek)', 'https://t.me/c/123/7/99', now() - interval '20 minutes'),
  -- a Mini App submission: message_url is a bot deep link, so no post button
  ((select id from public.homework_submissions where user_id = '${S1}' and assignment_id = '${A51}'), '${T1}', '${S1}', '${G5A}',
   '${M51}', '${A51}', 1, 1, '1- MODUL: PROMPT ENGINEERING', 'Aziza <K> & co', 'https://t.me/aicreatorsdarsliklari_bot?start=hw_x_1',
   now() - interval '19 minutes'),
  -- an assignment that no longer exists: the label drops the course, delivery goes on
  ((select id from public.homework_submissions where user_id = '${S4}'), '${T1}', '${S4}', '${G6}',
   '${M61}', gen_random_uuid(), 1, 1, 'Eski vazifa', 'Eldor', 'https://t.me/c/123/7/100', now() - interval '18 minutes'),
  -- RBAC: T3 is not a teacher of G6 -- never sent
  ((select id from public.homework_submissions where user_id = '${S4}'), '${T3}', '${S4}', '${G6}',
   '${M61}', '${A61}', 1, 1, 'x', 'Eldor', 'https://t.me/c/123/7/100', now() - interval '18 minutes');
`;

const HOUR_LINE = "  _tash_hour int := extract(hour from now() + interval '5 hours')::int;\n";

Deno.test({
  name: CAN_RUN
    ? "grading_queue_course_filter: 20260930182000 on PGlite (pins, queue columns + filters, badge = queue, fallback text, SQL = TS)"
    : "grading_queue_course_filter: SKIPPED -- needs `deno test -A --node-modules-dir=none` (PGlite reads its own files)",
  ignore: !CAN_RUN,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: run,
});

async function run() {
  const spec = "npm:@electric-sql/pglite@" + "0.5.8"; // non-literal: never resolved or type-checked unless this runs
  // deno-lint-ignore no-explicit-any
  const { PGlite } = (await import(spec)) as any;

  const LIVE = lf(await Deno.readTextFile(here("./grading_queue.live-2026-09-30.sql")));
  const MIG_PATH = Deno.env.get("MIG_PATH");
  const MIG = lf(await Deno.readTextFile(MIG_PATH ?? here("../../../migrations/20260930182000_grading_queue_course_filter.sql")));

  let pass = 0, fail = 0;
  const ok = (name: string, cond: boolean, detail?: unknown) => {
    if (cond) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}${detail !== undefined ? "  — " + JSON.stringify(detail) : ""}`); }
  };
  // deno-lint-ignore no-explicit-any
  const freshDb = async (live = LIVE): Promise<any> => {
    const db = await PGlite.create();
    await db.exec(SCHEMA);
    // The fixture is in name order, not dependency order (as a dump would load it).
    await db.exec("set check_function_bodies = off;\n" + live + "\nset check_function_bodies = on;");
    await db.exec(LIVE_GRANTS);
    await db.exec(SEED);
    return db;
  };
  // deno-lint-ignore no-explicit-any
  const q = async (db: any, sql: string, params: unknown[] = []): Promise<Row[]> => (await db.query(sql, params)).rows;
  // deno-lint-ignore no-explicit-any
  const one = async (db: any, sql: string, params: unknown[] = []): Promise<Row> => (await q(db, sql, params))[0];
  // deno-lint-ignore no-explicit-any
  const tx = async (db: any, sql: string): Promise<string | null> => {
    try { await db.exec("begin;\n" + sql + "\ncommit;"); return null; }
    catch (e) { try { await db.exec("rollback;"); } catch { /* none open */ } return String((e as Error).message); }
  };
  /** Runs `sql` in its own transaction as `role` with auth.uid() = uid (the PostgREST shape). */
  // deno-lint-ignore no-explicit-any
  const as = async (db: any, role: string, uid: string | null, sql: string, params: unknown[] = []):
    Promise<{ rows: Row[] | null; err: string | null }> => {
    try {
      // deno-lint-ignore no-explicit-any
      const rows = await db.transaction(async (t: any) => {
        await t.query("select set_config('request.jwt.claim.sub', $1, true)", [uid ?? ""]);
        await t.query("select set_config('request.jwt.claim.role', $1, true)", [role]);
        await t.exec(`set local role ${role}`);
        return (await t.query(sql, params)).rows as Row[];
      });
      return { rows, err: null };
    } catch (e) {
      return { rows: null, err: String((e as Error).message) };
    }
  };
  // deno-lint-ignore no-explicit-any
  const md5s = async (db: any, sig: string) =>
    await one(db, `select md5(pg_get_functiondef('${sig}'::regprocedure)) def, md5(replace(prosrc, E'\\r', '')) body,
                          array(select x::text from unnest(proacl) x order by 1) acl, prosecdef, proconfig
                     from pg_proc where oid = '${sig}'::regprocedure`);
  // deno-lint-ignore no-explicit-any
  const queueAs = async (db: any, uid: string, args = "") =>
    await as(db, "authenticated", uid, `select * from public.teacher_pending_submissions(${args})`);
  // deno-lint-ignore no-explicit-any
  const badges = async (db: any, uid: string) => {
    const r = await as(db, "authenticated", uid, "select * from public.teacher_groups($1)", [uid]);
    return new Map((r.rows ?? []).map((g) => [g.group_id as string, g]));
  };
  /** A copy of the STORED fallback with the Tashkent-hour gate pinned to noon, so it runs at any hour. */
  // deno-lint-ignore no-explicit-any
  const noonCopy = async (db: any) => {
    const def = (await one(db, "select pg_get_functiondef('public.hw_dm_fallback_deliver()'::regprocedure) d")).d as string;
    if (def.split(HOUR_LINE).length !== 2) throw new Error("hour line not found exactly once");
    await db.exec(def.replace(HOUR_LINE, "  _tash_hour int := 12;\n")
      .replace("FUNCTION public.hw_dm_fallback_deliver()", "FUNCTION public.hw_dm_fallback_deliver_at_noon()"));
  };

  // ───────────── L. the fixture is production's text ─────────────
  console.log("L. the live definitions are production's, byte for byte");
  {
    const d = await freshDb();
    for (const [name, want] of Object.entries(PROD)) {
      const sig = (await one(d, `select oid::regprocedure::text s from pg_proc where proname = $1 and pronamespace = 'public'::regnamespace`, [name])).s;
      const m = await md5s(d, sig);
      ok(`L ${name}: definition and body md5 = production`, m.def === want.def && m.body === want.body, m);
    }
    const acl = await md5s(d, "public.teacher_pending_submissions()");
    ok("L teacher_pending_submissions ACL = production's {authenticated, postgres, service_role}",
      JSON.stringify(acl.acl) === JSON.stringify(["authenticated=X/postgres", "postgres=X/postgres", "service_role=X/postgres"]), acl.acl);
    await d.close();
  }

  // ───────────── P. the pins ─────────────
  console.log("P. refuses a drifted body, and a refused file changes nothing");
  for (const [name, needle, patched] of [
    ["teacher_pending_submissions", "order by hs.submitted_at asc;", "order by hs.submitted_at asc; "],
    ["teacher_groups", "where hs.score is null\n", "where hs.score is null \n"],
    ["hw_dm_fallback_deliver", "limit 50\n", "limit 49\n"],
  ] as const) {
    const live = LIVE.split(needle);
    if (live.length !== 2) throw new Error(`P: needle for ${name} not unique`);
    const d = await freshDb(live.join(patched));
    const e = await tx(d, MIG);
    ok(`P ${name}: a changed body aborts with 'regenerate'`, !!e && e.includes(`ABORT: ${name} changed`), e);
    const still = await one(d, `select to_regprocedure('public.teacher_pending_submissions()') is not null old_sig,
                                       to_regprocedure('public.hw_label(text,text,integer,integer,text)') is null no_helper,
                                       (select count(*) from public.admin_actions)::int audits`);
    ok(`P ${name}: ...and nothing was changed (old queue RPC, no helper, no audit)`, still.old_sig && still.no_helper && still.audits === 0, still);
    await d.close();
  }

  // ───────────── B. the bugs on the live bodies ─────────────
  console.log("B. the live bodies (before this migration)");
  {
    const d = await freshDb();
    const queue = (await queueAs(d, T1)).rows ?? [];
    const b = await badges(d, T1);
    const inG5B = queue.filter((r) => r.group_id === G5B).length;
    ok("B1 live: 2-GURUH VIP 5.0 badge 0 while the queue has 2 (a stale resubmission + an inactive student)",
      b.get(G5B)?.pending_homework === 0 && inG5B === 2, { badge: b.get(G5B)?.pending_homework, queue: inG5B });
    ok("B2 live: the queue rows carry no course", queue.length > 0 && !("course_id" in queue[0]) && !("course_title" in queue[0]), Object.keys(queue[0] ?? {}));
    await d.exec(QUEUE);
    await noonCopy(d);
    await d.exec("select public.hw_dm_fallback_deliver_at_noon()");
    const sent = await q(d, "select body from public.test_sent where body->>'chat_id' = '7001' order by id");
    ok("B3 live: the fallback DM names no group and no course", sent.length === 3 &&
      String(sent[0].body.text).includes("Modul 6 · Vazifa 4 ni topshirdi") && !String(sent[0].body.text).includes("GURUH"), sent.map((s) => s.body.text));
    ok("B4 live: a Mini App row still gets 'Postni ko'rish' with its bot deep link",
      sent[1].body.reply_markup.inline_keyboard[0].length === 2 && String(sent[1].body.reply_markup.inline_keyboard[0][0].url).includes("?start="),
      sent[1].body.reply_markup);
    await d.close();
  }

  const db = await freshDb();
  const before = await badges(db, T1);

  // ───────────── A. apply + replay ─────────────
  console.log("A. applies and replays");
  {
    const e1 = await tx(db, MIG);
    ok("A1 the migration applies (its own self-tests pass)", e1 === null, e1);
    if (e1 !== null) {
      console.log(`\n${pass} passed, ${fail} failed`);
      throw new Error("the migration did not apply: " + e1);
    }
    const sigs = ["public.teacher_pending_submissions(uuid, uuid)", "public.teacher_groups(uuid)", "public.hw_dm_fallback_deliver()"];
    const m1 = await Promise.all(sigs.map((s) => md5s(db, s)));
    console.log("       new body md5s:", sigs.map((s, i) => `${s} ${m1[i].body}`).join(" | "));
    const e2 = await tx(db, MIG);
    ok("A2 a replay applies cleanly", e2 === null, e2);
    const m2 = await Promise.all(sigs.map((s) => md5s(db, s)));
    ok("A3 the replay left every body as it was", JSON.stringify(m1) === JSON.stringify(m2));
    const audit = await q(db, "select details from public.admin_actions where action = 'grading_queue_course_filter_applied'");
    ok("A4 exactly one audit row, with the parity-case count", audit.length === 1 && audit[0].details.parity_cases >= 25, audit);
    ok("A5 the self-test sent nothing", Number((await one(db, "select count(*) n from public.test_sent")).n) === 0);
  }

  // ───────────── G. grants ─────────────
  console.log("G. grants");
  {
    const m = await md5s(db, "public.teacher_pending_submissions(uuid, uuid)");
    ok("G1 the queue RPC keeps exactly its ACL and stays SECURITY DEFINER with search_path=public",
      JSON.stringify(m.acl) === JSON.stringify(["authenticated=X/postgres", "postgres=X/postgres", "service_role=X/postgres"])
        && m.prosecdef === true && JSON.stringify(m.proconfig) === JSON.stringify(["search_path=public"]), m);
    const r = await one(db, `select
        has_function_privilege('anon', 'public.hw_label(text,text,integer,integer,text)', 'EXECUTE') a1,
        has_function_privilege('authenticated', 'public.hw_label(text,text,integer,integer,text)', 'EXECUTE') a2,
        has_function_privilege('anon', 'public.hw_submission_dm_text_uz(text,text,text,integer,integer,text)', 'EXECUTE') a3,
        has_function_privilege('authenticated', 'public.hw_submission_dm_text_uz(text,text,text,integer,integer,text)', 'EXECUTE') a4,
        has_function_privilege('service_role', 'public.hw_submission_dm_text_uz(text,text,text,integer,integer,text)', 'EXECUTE') s1`);
    ok("G2 the label helpers: anon and authenticated no, service_role yes", !r.a1 && !r.a2 && !r.a3 && !r.a4 && r.s1, r);
    const tg = await md5s(db, "public.teacher_groups(uuid)");
    const fb = await md5s(db, "public.hw_dm_fallback_deliver()");
    ok("G3 teacher_groups and the fallback keep their ACLs",
      JSON.stringify(tg.acl) === JSON.stringify(["authenticated=X/postgres", "postgres=X/postgres", "service_role=X/postgres"])
        && JSON.stringify(fb.acl) === JSON.stringify(["postgres=X/postgres", "service_role=X/postgres"]), { tg: tg.acl, fb: fb.acl });
  }

  // ───────────── Q. the queue ─────────────
  console.log("Q. teacher_pending_submissions");
  {
    const all = await queueAs(db, T1);
    const rows = all.rows ?? [];
    ok("Q1 the zero-argument call still works (the app's only call) and returns T1's six waiting items",
      all.err === null && rows.length === 6, all.err ?? rows.map((r) => r.student_name));
    ok("Q2 the columns are the old ones in the old order, then course_id, course_title",
      JSON.stringify(Object.keys(rows[0] ?? {})) === JSON.stringify(["submission_id", "user_id", "student_name", "group_id", "group_name",
        "module_number", "task_number", "assignment_id", "assignment_title", "max_score", "submitted_at", "previous_score",
        "is_resubmission", "media", "submitted_image_url", "course_id", "course_title"]), Object.keys(rows[0] ?? {}));
    const times = rows.map((r) => new Date(r.submitted_at).getTime());
    ok("Q3 still oldest first", times.every((t, i) => i === 0 || times[i - 1] <= t));
    const moved = rows.filter((r) => r.user_id === S5);
    ok("Q4 a moved student's 5.0 task says 5.0 (the TASK's course) under the 6.0 group; the 6.0 task says 6.0",
      moved.length === 2 && moved.some((r) => r.assignment_id === A56 && r.course_id === C5 && r.course_title === C5T && r.group_id === G6)
        && moved.some((r) => r.assignment_id === A64 && r.course_id === C6 && r.course_title === C6T), moved);
    ok("Q5 every row has its course", rows.every((r) => r.course_id && r.course_title));
    const c6 = (await queueAs(db, T1, `p_course_id => '${C6}'`)).rows ?? [];
    const c5 = (await queueAs(db, T1, `p_course_id => '${C5}'`)).rows ?? [];
    ok("Q6 p_course_id: 6.0 -> 2 rows, 5.0 -> 4 rows, and together they are the whole queue",
      c6.length === 2 && c5.length === 4 && c6.every((r) => r.course_id === C6) && c5.every((r) => r.course_id === C5), { c6: c6.length, c5: c5.length });
    const g6 = (await queueAs(db, T1, `p_group_id => '${G6}'`)).rows ?? [];
    const g6c5 = (await queueAs(db, T1, `'${G6}', '${C5}'`)).rows ?? [];
    ok("Q7 p_group_id: 3-GURUH -> 3 rows; with 5.0 -> only the moved student's 5.0 task",
      g6.length === 3 && g6c5.length === 1 && g6c5[0].assignment_id === A56, { g6: g6.length, g6c5: g6c5.map((r) => r.assignment_id) });
    const other = (await queueAs(db, T1, `p_group_id => '${G6X}'`)).rows ?? [];
    ok("Q8 a group the teacher does not teach -> nothing (the scope still applies)", other.length === 0, other);
    const t2 = (await queueAs(db, T2)).rows ?? [];
    ok("Q9 T2 (primary of 2-GURUH only) sees 2-GURUH's two items", t2.length === 2 && t2.every((r) => r.group_id === G5B), t2.length);
    const stu = await queueAs(db, S1);
    ok("Q10 a student gets nothing", stu.err === null && (stu.rows ?? []).length === 0, stu);
    const anon = await as(db, "anon", null, "select * from public.teacher_pending_submissions()");
    ok("Q11 anon is refused", anon.err !== null && /permission denied/i.test(anon.err), anon.err);
  }

  // ───────────── T. the badge ─────────────
  console.log("T. teacher_groups: badge == queue");
  {
    const after = await badges(db, T1);
    const mismatches: unknown[] = [];
    for (const g of [G5A, G5B, G6]) {
      const n = ((await queueAs(db, T1, `p_group_id => '${g}'`)).rows ?? []).length;
      if (after.get(g)?.pending_homework !== n) mismatches.push({ g, badge: after.get(g)?.pending_homework, queue: n });
    }
    ok("T1 for every group of T1, pending_homework = the queue's count for that group", mismatches.length === 0 && after.size === 3, mismatches);
    ok("T2 2-GURUH VIP 5.0: 0 -> 2 (the stale resubmission and the inactive student's work now count)",
      before.get(G5B)?.pending_homework === 0 && after.get(G5B)?.pending_homework === 2);
    const same = [G5A, G5B, G6].every((g) => {
      const a = before.get(g), b = after.get(g);
      return a && b && a.group_name === b.group_name && a.course_name === b.course_name && a.total_students === b.total_students
        && a.active_7d === b.active_7d && a.avg_completion_pct === b.avg_completion_pct;
    });
    ok("T3 every other column is unchanged", same, { before: [...before.values()], after: [...after.values()] });
    const srv = await as(db, "service_role", null, "select * from public.teacher_groups($1)", [T3]);
    ok("T4 service_role (digest, bot) reads T3's badge: 4-GURUH -> 1", (srv.rows ?? []).length === 1 && srv.rows![0].pending_homework === 1, srv);
    const stranger = await as(db, "authenticated", S1, "select * from public.teacher_groups($1)", [T1]);
    ok("T5 a student reading a teacher's groups still gets nothing", (stranger.rows ?? []).length === 0, stranger);
  }

  // ───────────── F. the fallback ─────────────
  console.log("F. hw_dm_fallback_deliver (a noon copy of the stored body, stub ops_net_post)");
  {
    await db.exec("delete from public.test_sent");
    await db.exec(QUEUE);
    await noonCopy(db);
    const n = (await one(db, "select public.hw_dm_fallback_deliver_at_noon() n")).n;
    ok("F1 three DMs to T1; the RBAC-refused row is not sent", n === 3, n);
    const sent = await q(db, "select body, headers, purpose, url from public.test_sent where body->>'chat_id' = '7001' order by id");
    const want = [
      submissionDmText("uz", "Bek (@bek)", { courseTitle: C5T, groupName: "AC CHALLENGE | 3-GURUH", moduleNumber: 6, step: 4, title: "4-MODUL UYGA VAZIFASI" }),
      submissionDmText("uz", "Aziza <K> & co", { courseTitle: C5T, groupName: "1-GURUH VIP 5.0", moduleNumber: 1, step: 1, title: "1- MODUL: PROMPT ENGINEERING" }),
      submissionDmText("uz", "Eldor", { courseTitle: null, groupName: "AC CHALLENGE | 3-GURUH", moduleNumber: 1, step: 1, title: "Eski vazifa" }),
    ];
    ok("F2 each text is the drainer's text, byte for byte (moved student: '5.0 · AC CHALLENGE | 3-GURUH · M6 V4 — …')",
      sent.length === 3 && sent.every((s, i) => s.body.text === want[i]), { got: sent.map((s) => s.body.text), want });
    ok("F3 a missing assignment: the label drops the course, the DM still goes", String(sent[2]?.body.text).includes("AC CHALLENGE | 3-GURUH · M1 V1 — Eski vazifa"));
    const kb = sent.map((s) => s.body.reply_markup.inline_keyboard);
    const s1Sub = (await one(db, `select id from public.homework_submissions where user_id = '${S1}' and assignment_id = '${A51}'`)).id;
    ok("F4 t.me/c link: [Postni ko'rish, Baholash]; bot deep link: [Baholash] only",
      kb[0].length === 1 && kb[0][0].length === 2 && kb[0][0][0].url === "https://t.me/c/123/7/99"
        && kb[1].length === 1 && kb[1][0].length === 1 && kb[1][0][0].callback_data === `gs:open:${s1Sub}`
        && kb[1][0][0].text === "🎯 Baholash", kb);
    ok("F5 callback_data 'gs:open:<submission>' fits Telegram's 64 bytes",
      kb.every((k) => k[0].every((b: Row) => !b.callback_data || new TextEncoder().encode(b.callback_data).length <= 64)));
    ok("F6 ops_net_post: purpose, Content-Type, parse_mode HTML, as before",
      sent.every((s) => s.purpose === "hw_dm_fallback_deliver" && s.headers["Content-Type"] === "application/json"
        && s.body.parse_mode === "HTML" && String(s.url).endsWith("/botTESTTOKEN/sendMessage")), sent.map((s) => [s.purpose, s.headers, s.url]));
    const stamped = await q(db, "select teacher_id, sent_at is not null sent, error from public.homework_teacher_dm_queue order by created_at, scheduled_for");
    ok("F7 the three sent rows are stamped 'sql_fallback_delivery'; T3's row stays open",
      stamped.filter((s) => s.sent && s.error === "sql_fallback_delivery").length === 3
        && stamped.some((s) => s.teacher_id === T3 && !s.sent), stamped);
    const admin = await q(db, "select body from public.test_sent where body->>'chat_id' = '9001'");
    ok("F8 the admin alert still fires once", admin.length === 1 && String(admin[0].body.text).includes("Zaxira kanal 3 ta"), admin);
  }

  // ───────────── X. SQL = TypeScript ─────────────
  console.log("X. SQL = TypeScript");
  {
    const block = MIG.split("$cases$[")[1]?.split("]$cases$")[0] ?? "";
    const cases = JSON.parse("[" + block + "]") as Row[];
    ok("X1 the migration carries its parity cases", cases.length >= 25, cases.length);
    const ch = (n: number) => String.fromCharCode(n);
    const WS = [ch(0xa0), ch(0x1680), ch(0x2003), ch(0x2028), ch(0x202f), ch(0x3000), ch(0xfeff), "\t", "\n", "\v", "\f", "\r"];
    const fuzz: Row[] = [];
    const courses = [C5T, C6T, "AI CREATORS 4.0", "Midjourney masterclass pro", "", null, "CHALLENGE", "ЯCHALLENGE 6.0",
      "ÉCHALLENGE 6.0", "challenge_x 6.0", "x-challenge-7.0", "AI 5.05", "v5.0", "5..0", "5.0.0", "Кино", "🎬🎬🎬🎬🎬🎬🎬🎬🎬🎬🎬🎬🎬🎬🎬",
      ...WS.map((w) => `AI${w}CREATORS${w}CHALLENGE${w}6.0`), ...WS.map((w) => `AI CREATORS${w}5.0`)];
    const groups = ["1-GURUH PRE 5.0", "AC CHALLENGE | 3-GURUH", "CHALLENGE|", "|", "·", " · | ", "5.0 5.0", "x_challenge | 1",
      "ЯCHALLENGE | 2", "AC CHALLENGE | a | b", "", null, ...WS.map((w) => `AC${w}CHALLENGE${w}|${w}4-GURUH${w}5.0`)];
    for (const c of courses) for (const g of groups) fuzz.push({ name: "S & <n>", course: c, group: g, m: 2, s: 3, title: `t${ch(0xa0)}x` });
    for (const w of WS) fuzz.push({ name: w, course: C5T, group: `1-GURUH${w}PRE${w}5.0`, m: 0, s: 0, title: `${w}a${w}${w}b${w}` });
    const mism: unknown[] = [];
    for (const c of [...cases, ...fuzz]) {
      const sql = (await one(db, "select public.hw_submission_dm_text_uz($1, $2, $3, $4, $5, $6) t",
        [c.name, c.course, c.group, c.m, c.s, c.title])).t;
      const ts = submissionDmText("uz", c.name, { courseTitle: c.course, groupName: c.group, moduleNumber: c.m, step: c.s, title: c.title });
      if (sql !== ts || ("want" in c && c.want !== ts)) mism.push({ c, sql, ts });
    }
    ok(`X2 hw_submission_dm_text_uz = submissionDmText('uz') on ${cases.length} parity cases + ${fuzz.length} fuzz inputs`, mism.length === 0, mism.slice(0, 5));
    const tasks: Array<[number | null, number | null, string | null]> = [[1, 1, "1- MODUL: PROMPT ENGINEERING"], [3, 2, "3-MODUL (taxminiy)"], [null, null, "Task"], [4, null, null], [-2, 5, " "]];
    const lm: unknown[] = [];
    for (const c of [C5T, C6T, "AI CREATORS 4.0", "", null]) {
      for (const g of ["1-GURUH PRE 5.0", "1-GURUH VIP 5.0", "2-GURUH VIP 5.0", "AC CHALLENGE | 1-GURUH", "AC CHALLENGE | 6-GURUH", "5.0", "GURUH 5", "", null]) {
        for (const [m, s, t] of tasks) {
          const sql = (await one(db, "select public.hw_label($1, $2, $3, $4, $5) l", [c, g, m, s, t])).l;
          const ts = hwLabel({ courseTitle: c, groupName: g, moduleNumber: m, step: s, title: t });
          if (sql !== ts) lm.push({ c, g, m, s, t, sql, ts });
        }
      }
    }
    ok("X3 hw_label = hwLabel on every live course x group x task combination", lm.length === 0, lm.slice(0, 5));
  }

  await db.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) throw new Error(`${fail} check(s) failed`);
}
