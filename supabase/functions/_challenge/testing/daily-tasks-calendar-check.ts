// PGlite harness for 20260930122010_challenge_daily_tasks_calendar.sql (Daily Tasks PR-2: the task calendar).
//
//   deno test -A --node-modules-dir=none --no-lock supabase/functions/_challenge/testing/daily-tasks-calendar-check.ts
//
// Builds production's state on a real PostgreSQL -- the live reconcilers, #218 (20260930100010) and PR-1
// (20260930121000, which seeds the four «KUNLIK VAZIFALAR» topics) -- then applies THIS migration and checks:
// it refuses to run before PR-1; applies + replays cleanly (one audit row); grants and RLS (anon nothing, a student
// nothing, an admin through RLS, the CHECK's function callable by the inserting role); the SQL validator, approve
// rule and link parser agree with src/lib/dailyTasksPlan.ts fixture-by-fixture; the approve guard matrix (scope,
// test group, window dates, requires vs type/accepts, the 4000-character render limit, unforgeable stamps); the
// one-live-task-per-day index; delete rules; the REAL 25-task plan imports as drafts through the RPC, re-imports
// as a no-op and approves end to end; the preview RPC; the manual-post RPC (every refusal, the bot-seen checks,
// clearing, bot-sent posts protected).
// Run it after ANY change to the migration and before asking for the migration-approved label.
// MIG_PATH=<file> tests a draft before it is written into its (edit-guarded) slot.
//
// CI NOTE: named *-check.ts, not *_test.ts, so CI's `deno test supabase/functions/` never collects it -- the
// convention of its siblings (daily-topic-check.ts: collecting a PGlite harness failed #220's CI run with "Could not
// find @types/node"). Run it by path as above. The pure rules it cross-checks are ALSO covered by vitest
// (src/lib/dailyTasksPlan.test.ts + src/test/AdminChallengeTasks.test.tsx), which does gate merges; the SQL side
// also self-tests at apply time.
// TEST INFRASTRUCTURE ONLY: this directory has no index.ts, so it is never deployed.

import {
  buildImportRows, deriveFromFormat, parseMessageUrl, parsePlan, requiresProblem, requiresValid, REQUIRES_MSG,
} from "../../../../src/lib/dailyTasksPlan.ts";

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;
interface PG {
  query(sql: string, params?: unknown[]): Promise<{ rows: Row[] }>;
  exec(sql: string): Promise<unknown>;
  close(): Promise<void>;
}

const granted = (name: "read" | "env" | "net") => {
  try { return Deno.permissions.querySync({ name }).state === "granted"; } catch { return false; }
};
const CAN_RUN = granted("read") && granted("env") && granted("net");

const here = (p: string) => new URL(p, import.meta.url);
const lf = (s: string) => s.replace(/\r\n/g, "\n"); // a Windows checkout is CRLF; production text is LF

// ── the same fixture world as daily-topic-check.ts (PR-1's harness), so PR-1's seed assertions hold ──
const C6 = "f502f631-2104-4834-b6c2-702cd3080e27";
const C5 = "78011384-4024-49b0-b72d-b0b2e3a04ee8";
const CT = "cccccccc-0000-0000-0000-00000000000e";   // a separate E2E test course (G26)
const G1 = "f675a2fd-b1ce-4d28-94a4-7fc0e1a91515", G2 = "c092a0db-b55f-4fa7-8548-befad285037b";
const G3 = "3a7ebea8-80eb-4b64-a282-471a0fa12ef4", G4 = "93e8e7b0-275c-47a9-a97d-ff28e26c8f5b";
const CH1 = -1004440955972, CH2 = -1004390902020;
const D1 = 144, D2 = 99;
const G5 = "55555555-5555-5555-5555-555555555555"; // a 5.0 group (outside the challenge), chat -100555
const G6 = "66666666-6666-6666-6666-666666666666";
const G7 = "77777777-7777-7777-7777-777777777777";
const G8 = "88888888-8888-8888-8888-888888888888"; // the E2E test group (course CT), chat -100888
const U = (n: number) => `aaaaaaaa-0000-0000-0000-${String(n).padStart(12, "0")}`;
const S1 = U(1), S2 = U(2), S3 = U(3), S4 = U(4), S5 = U(5), S6 = U(6), X1 = U(7), T1 = U(8), AD = U(11);

// SCHEMA: a VERBATIM copy of daily-topic-check.ts's (PR-1). Keep the two identical.
const SCHEMA = `
set timezone = 'UTC';
create role anon; create role authenticated; create role service_role;
create schema auth;
create table auth.users (id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create type public.app_role as enum ('admin','student','teacher','superadmin');
create type public.user_status as enum ('active','inactive','archived');
create table public.user_roles (id uuid primary key default gen_random_uuid(), user_id uuid not null, role public.app_role not null,
  unique (user_id, role));
create table public.groups (id uuid primary key default gen_random_uuid(), name text not null, course_id uuid, teacher_id uuid,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), is_default boolean not null default false,
  telegram_group_url text, homework_topic_url text, homework_topic_id bigint, tier_id uuid);
create table public.group_teachers (group_id uuid not null, teacher_id uuid not null, is_primary boolean not null default false,
  primary key (group_id, teacher_id));
create table public.modules (id uuid primary key);
create table public.group_module_topics (id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade, module_id uuid not null references public.modules(id) on delete cascade,
  telegram_topic_url text not null, telegram_topic_id integer, created_by uuid, created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(), unique (group_id, module_id));
create table public.profiles (id uuid primary key, group_id uuid, telegram_id bigint unique, status public.user_status not null default 'active',
  archived_at timestamptz);
create table public.webhook_inbox (id bigserial primary key, received_at timestamptz not null default now(), update_type text,
  chat_id bigint, message_id bigint, raw_update jsonb not null);
create table public.group_message_events (id uuid primary key default gen_random_uuid(), group_id uuid not null, profile_id uuid,
  telegram_user_id bigint not null, telegram_chat_id bigint not null, telegram_message_id bigint not null,
  telegram_thread_id bigint, sent_at timestamptz not null default now(), created_at timestamptz not null default now(),
  reply_to_message_id bigint, reply_to_user_id bigint, mentions_teacher boolean not null default false,
  has_ustoz boolean not null default false, is_anon_admin boolean not null default false,
  unique (telegram_chat_id, telegram_message_id));
create table public.xp_events (id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
  amount integer not null check (amount > 0), reason text not null, ref_key text not null, created_at timestamptz not null default now(),
  unique (user_id, ref_key));
create table public.user_xp (user_id uuid primary key references auth.users(id) on delete cascade, total_xp integer not null default 0,
  level integer not null default 1, updated_at timestamptz not null default now());
create table public.admin_actions (id uuid primary key default gen_random_uuid(), actor_user_id uuid, action text not null,
  target_user_id uuid, target_resource_type text, target_resource_id uuid, details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now());
create table public.platform_settings (key text primary key, value jsonb not null, updated_at timestamptz not null default now(), updated_by uuid);
create table public.app_settings (key text primary key, value jsonb not null, description text, updated_by uuid,
  updated_at timestamptz not null default now());
create table public.challenge_weekly_results (id uuid primary key default gen_random_uuid(), week_start date not null, kind text not null default 'individual',
  group_id uuid, user_id uuid, points integer not null default 0, rank integer, created_at timestamptz not null default now(),
  details jsonb not null default '{}'::jsonb);

create schema cron;
create table cron.job (jobid bigserial primary key, jobname text unique, schedule text, command text, active boolean not null default true);
create function cron.schedule(_name text, _schedule text, _command text) returns bigint language sql as $$
  insert into cron.job (jobname, schedule, command) values (_name, _schedule, _command)
  on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command returning jobid $$;
create function cron.unschedule(_id bigint) returns boolean language sql as $$ delete from cron.job where jobid = _id returning true $$;
create table public.ops_net_calls (id bigserial primary key, url text, body jsonb, headers jsonb, purpose text, timeout_ms int);
create function public.ops_net_post(p_url text, p_body jsonb default '{}'::jsonb, p_headers jsonb default '{}'::jsonb,
  p_purpose text default null, p_timeout_ms integer default 30000) returns bigint language sql as $$
  insert into public.ops_net_calls (url, body, headers, purpose, timeout_ms) values (p_url, p_body, p_headers, p_purpose, p_timeout_ms) returning id $$;

CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role app_role)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role);
$function$;

CREATE OR REPLACE FUNCTION public.xp_level_for(_total integer)
 RETURNS integer LANGUAGE sql IMMUTABLE
AS $function$ select greatest(1, floor((50 + sqrt(2500 + 200.0 * greatest(_total, 0))) / 100))::int $function$;

CREATE OR REPLACE FUNCTION public.challenge_config()
 RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  select coalesce((select value from platform_settings where key = 'challenge'), '{}'::jsonb);
$function$;

CREATE OR REPLACE FUNCTION public.challenge_active(_at timestamp with time zone DEFAULT now())
 RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
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

CREATE OR REPLACE FUNCTION public.challenge_scope_group_ids()
 RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  select g.id
  from groups g
  where g.id::text in (select jsonb_array_elements_text(coalesce(public.challenge_config()->'group_ids', '[]'::jsonb)))
     or g.course_id::text in (select jsonb_array_elements_text(coalesce(public.challenge_config()->'course_ids', '[]'::jsonb)));
$function$;

revoke execute on function public.challenge_config() from public;
grant execute on function public.challenge_config() to service_role;
revoke execute on function public.challenge_active(timestamptz) from public;
grant execute on function public.challenge_active(timestamptz) to service_role;
revoke execute on function public.challenge_scope_group_ids() from public;
grant execute on function public.challenge_scope_group_ids() to service_role;

-- live trigger functions (bodies byte-identical to production once \\r is stripped; section A checks)
CREATE OR REPLACE FUNCTION public.update_updated_at_column() RETURNS trigger LANGUAGE plpgsql AS $$ begin NEW.updated_at := now(); return NEW; end $$;
CREATE OR REPLACE FUNCTION public.groups_extract_homework_topic_id()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  m text[];
BEGIN
  IF NEW.homework_topic_url IS NULL OR length(trim(NEW.homework_topic_url)) = 0 THEN
    NEW.homework_topic_url := NULL;
    NEW.homework_topic_id := NULL;
    RETURN NEW;
  END IF;
  -- Match https://t.me/c/<chat>/<topic>[/...]
  m := regexp_match(NEW.homework_topic_url, '^https?://t\\.me/c/\\d+/(\\d+)');
  IF m IS NOT NULL THEN
    NEW.homework_topic_id := (m[1])::bigint;
  ELSE
    NEW.homework_topic_id := NULL;
  END IF;
  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION public.gmt_parse_topic_id()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  m text[];
BEGIN
  -- match trailing /<digits> at end of URL
  m := regexp_match(NEW.telegram_topic_url, '/(\\d+)/?$');
  IF m IS NOT NULL THEN
    NEW.telegram_topic_id := m[1]::int;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$function$;
create trigger groups_set_updated_at before update on public.groups for each row execute function update_updated_at_column();
create trigger trg_groups_extract_homework_topic_id before insert or update of homework_topic_url on public.groups
  for each row execute function groups_extract_homework_topic_id();
create trigger trg_gmt_parse_topic_id before insert or update on public.group_module_topics for each row execute function gmt_parse_topic_id();

insert into auth.users select unnest(array['${S1}','${S2}','${S3}','${S4}','${S5}','${S6}','${X1}','${T1}','${AD}'])::uuid;
insert into public.groups (id, name, course_id, homework_topic_url) values
  ('${G1}', 'AC CHALLENGE | 1-GURUH', '${C6}', 'https://t.me/c/4440955972/3'),
  ('${G2}', 'AC CHALLENGE | 2-GURUH', '${C6}', 'https://t.me/c/4390902020/6'),
  ('${G3}', 'AC CHALLENGE | 3-GURUH', '${C6}', 'https://t.me/c/3714608284/5'),
  ('${G4}', 'AC CHALLENGE | 4-GURUH', '${C6}', 'https://t.me/c/4463424516/7'),
  ('${G5}', '5.0 | A', '${C5}', 'https://t.me/c/555/9'),
  ('${G6}', '5.0 | B', '${C5}', 'https://t.me/c/555/8'),
  ('${G7}', '5.0 | C', '${C5}', null);
insert into public.profiles (id, group_id, telegram_id) values
  ('${S1}', '${G1}', 1001), ('${S2}', '${G1}', 1002), ('${S3}', '${G1}', 1003), ('${S4}', '${G1}', 1004),
  ('${S5}', '${G5}', 1005), ('${S6}', '${G5}', 1006), ('${X1}', '${G2}', 1007), ('${T1}', '${G1}', 1008), ('${AD}', null, 1011);
insert into public.user_roles (user_id, role) values ('${T1}', 'teacher'), ('${AD}', 'admin');
insert into public.platform_settings (key, value) values
  ('challenge', '{"caps": {"ig_post_per_day": 2, "group_media_per_day": 3}, "points": {"ig_post": 30, "question": 2, "group_media": 5}, "window": {"end": null, "start": "2026-10-01T00:00:00+05:00"}, "enabled": true, "group_ids": [], "course_ids": ["${C6}"]}'),
  ('community_xp', '{"help": 3, "question": 2, "daily_cap": 10}'),
  ('telegram', '{"bot_token": "123:TESTTOKEN", "bot_username": "x"}');
`;

// What this PR adds to the world: the courses table (challenge_tasks.course_id references it) and an E2E test
// course + group. Kept out of SCHEMA (a verbatim copy of PR-1's) so a diff between the two harnesses stays empty.
const EXTRA = `
create table public.courses (id uuid primary key, title text not null default '');
insert into public.courses (id, title) values ('${C6}', 'AI CREATORS CHALLENGE 6.0'), ('${C5}', '5.0'), ('${CT}', 'E2E test course');
insert into public.groups (id, name, course_id, homework_topic_url) values ('${G8}', 'E2E | TEST', '${CT}', 'https://t.me/c/888/9');
grant usage on schema auth to authenticated, anon;
`;

Deno.test({
  name: CAN_RUN
    ? "daily_tasks_calendar: 20260930122010 on PGlite (#218 + PR-1 + calendar; guard, RLS, importer, manual posts)"
    : "daily_tasks_calendar: SKIPPED -- needs `deno test -A --node-modules-dir=none` (PGlite reads its own files)",
  ignore: !CAN_RUN,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: run,
});

async function run() {
  const spec = "npm:@electric-sql/pglite@0.5.8"; // non-literal: never resolved or type-checked unless this runs
  // deno-lint-ignore no-explicit-any
  const { PGlite } = (await import(spec)) as any;

  const MIG_PATH = Deno.env.get("MIG_PATH");
  const MIG = lf(await Deno.readTextFile(MIG_PATH ?? here("../../../migrations/20260930122010_challenge_daily_tasks_calendar.sql")));
  const PR1 = lf(await Deno.readTextFile(here("../../../migrations/20260930121000_challenge_daily_task_topic.sql")));
  const MIG218 = lf(await Deno.readTextFile(here("../../../migrations/20260930100010_challenge_social_points.sql")));
  const RCX_LIVE = lf(await Deno.readTextFile(here("./reconcile_challenge_xp.live-2026-09-30.sql")));
  const COMMUNITY_LIVE = lf(await Deno.readTextFile(here("./reconcile_community_xp.live-2026-09-30.sql")));
  const PLAN = await Deno.readTextFile(here("../../../../src/lib/__fixtures__/challenge6-daily-tasks-plan.json"));

  let pass = 0, fail = 0;
  const ok = (name: string, cond: boolean, detail?: unknown) => {
    if (cond) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}${detail !== undefined ? "  — " + JSON.stringify(detail) : ""}`); }
  };
  const q = async (db: PG, sql: string, params: unknown[] = []): Promise<Row[]> => (await db.query(sql, params)).rows;
  const one = async (db: PG, sql: string, params: unknown[] = []): Promise<Row> => (await q(db, sql, params))[0];
  const errOf = async (db: PG, sql: string, params: unknown[] = []): Promise<string | null> => {
    try { await db.query(sql, params); return null; } catch (e) { return String((e as Error).message); }
  };
  const tx = async (db: PG, sql: string): Promise<string | null> => {
    try { await db.exec("begin;\n" + sql + "\ncommit;"); return null; }
    catch (e) { try { await db.exec("rollback;"); } catch { /* none open */ } return String((e as Error).message); }
  };

  /** Production's state before this PR: SCHEMA + the live reconcilers + #218 (+ PR-1 unless withPr1 is false). */
  async function freshDb(opts: { withPr1?: boolean } = {}): Promise<PG> {
    const db: PG = new PGlite();
    await db.exec(SCHEMA);
    await db.exec(EXTRA);
    await db.exec(COMMUNITY_LIVE + ";\nrevoke execute on function public.reconcile_community_xp(timestamptz) from public;\n" +
      "grant execute on function public.reconcile_community_xp(timestamptz) to service_role;");
    await db.exec(RCX_LIVE + ";\nrevoke execute on function public.reconcile_challenge_xp(timestamptz) from public;\n" +
      "grant execute on function public.reconcile_challenge_xp(timestamptz) to service_role;");
    const e = await tx(db, MIG218);
    if (e) throw new Error("#218 did not apply: " + e);
    if (opts.withPr1 !== false) {
      const e1 = await tx(db, PR1);
      if (e1) throw new Error("PR-1 did not apply: " + e1);
    }
    return db;
  }

  /** Runs `sql` as `role` with auth.uid() = uid (the PostgREST shape: SET ROLE + the JWT sub claim). */
  async function as<T = Row[]>(db: PG, uid: string | null, sql: string, params: unknown[] = [], role = "authenticated"):
    Promise<{ rows: T | null; err: string | null }> {
    await db.exec(`select set_config('request.jwt.claim.sub', '${uid ?? ""}', false)`);
    await db.exec(`set role ${role}`);
    try { return { rows: (await db.query(sql, params)).rows as unknown as T, err: null }; }
    catch (e) { return { rows: null, err: String((e as Error).message) }; }
    finally { await db.exec("reset role"); await db.exec("select set_config('request.jwt.claim.sub', '', false)"); }
  }
  const admin = (db: PG, sql: string, params: unknown[] = []) => as(db, AD, sql, params);

  const LONG = (n: number, ch = "x") => ch.repeat(n);
  const SHOT = { any: ["photo", "image_doc"], min: 1, label: "screenshot" };
  const TEXT = { any: ["text"], min: 1, label: "text" };
  const IGL = { any: ["ig_link"], min: 1, label: "ig_link" };
  const insertSql = `insert into challenge_tasks (course_id, task_date, type, title, body, accepts, requires, status, source,
                       learn_line, submit_hint, approved_by, created_by, points, requires_tag)
                     values ($1, $2, $3, $4, $5, $6::text[], $7::jsonb, $8, coalesce($9, 'manual'), $10, $11, $12, $13, $14, $15)
                     returning id, status, approved_by, approved_at, created_by, accepts`;
  type Ins = { course?: string; date: string; type?: string; title?: string; body?: string; accepts?: string[]; requires?: unknown;
               status?: string; source?: string; learn?: string | null; hint?: string | null; approvedBy?: string | null;
               createdBy?: string | null; points?: number | null; tag?: boolean | null };
  const insParams = (o: Ins) => [o.course ?? C6, o.date, o.type ?? "general", o.title ?? "Sinov vazifa", o.body ?? "Vazifa matni",
    `{${(o.accepts ?? ["text", "photo", "document"]).join(",")}}`, JSON.stringify(o.requires ?? [SHOT]), o.status ?? "draft",
    o.source ?? null, o.learn ?? null, o.hint ?? null, o.approvedBy ?? null, o.createdBy ?? null, o.points ?? null, o.tag ?? null];
  const insAsAdmin = (db: PG, o: Ins) => admin(db, insertSql, insParams(o));

  // ───────────── P. prerequisite ─────────────
  console.log("P. refuses to run before PR-1");
  {
    const d0 = await freshDb({ withPr1: false });
    const e = await tx(d0, MIG);
    ok("P1 without 20260930121000 the file aborts with a clear message", !!e && e.includes("ABORT: 20260930121000"), e);
    ok("P2 ...and leaves nothing behind", (await one(d0, "select to_regclass('public.challenge_tasks') r")).r === null);
    await d0.close();
  }

  // ───────────── M. the migration applies, audits once, replays ─────────────
  console.log("M. migration: applies (self-test included), audit once, replay");
  const db = await freshDb();
  {
    const e = await tx(db, MIG);
    ok("M1 applies (including its self-test)", e === null, e);
    if (e !== null) throw new Error(`daily_tasks_calendar: the migration did not apply -- ${e}`);
    ok("M2 PR-1 seeded the four daily topics this suite relies on",
      (await one(db, "select count(*)::int n from groups where daily_task_topic_id is not null")).n === 4);
    ok("M3 one audit row", (await one(db, "select count(*)::int n from admin_actions where action = 'challenge_tasks_calendar_applied'")).n === 1);
    const e2 = await tx(db, MIG);
    ok("M4 replay is a clean no-op", e2 === null, e2);
    ok("M5 replay: still one audit row", (await one(db, "select count(*)::int n from admin_actions where action = 'challenge_tasks_calendar_applied'")).n === 1);
    ok("M6 nothing is scheduled (inert)", (await one(db, "select count(*)::int n from cron.job where jobname ilike '%task%'")).n === 0);
    ok("M7 no outbound call was made", (await one(db, "select count(*)::int n from ops_net_calls")).n === 0);
  }

  // ───────────── G. grants and RLS ─────────────
  console.log("G. grants and RLS");
  {
    const priv = async (role: string, table: string, p: string) =>
      (await one(db, "select has_table_privilege($1, $2, $3) v", [role, table, p])).v as boolean;
    ok("G1 anon: no privilege on either table",
      !(await priv("anon", "public.challenge_tasks", "SELECT")) && !(await priv("anon", "public.challenge_tasks", "INSERT")) &&
      !(await priv("anon", "public.challenge_task_posts", "SELECT")));
    ok("G2 authenticated: SELECT/INSERT/UPDATE/DELETE on tasks (RLS decides), only SELECT on posts",
      (await priv("authenticated", "public.challenge_tasks", "INSERT")) && (await priv("authenticated", "public.challenge_task_posts", "SELECT")) &&
      !(await priv("authenticated", "public.challenge_task_posts", "INSERT")) && !(await priv("authenticated", "public.challenge_task_posts", "UPDATE")) &&
      !(await priv("authenticated", "public.challenge_tasks", "TRUNCATE")));
    const acl = await q(db, `select p.proname, coalesce(array_to_string(p.proacl, ','), '') a from pg_proc p
                              join pg_namespace n on n.oid = p.pronamespace
                             where n.nspname = 'public' and (p.proname like 'challenge_task%' or p.proname like 'admin_challenge%')
                               and p.proname not in ('challenge_task_parse_topic_url', 'challenge_task_topics') order by 1`);
    const aclOf = Object.fromEntries(acl.map((r) => [r.proname, r.a]));
    ok("G3 11 new functions, none reachable by PUBLIC or anon",
      acl.length === 11 && acl.every((r) => r.a !== "" && !/(^|,)=/.test(r.a) && !/(^|,)anon=/.test(r.a)), aclOf);
    const authed = ["admin_challenge_task_preview", "admin_challenge_task_set_manual_post", "admin_challenge_tasks_import", "challenge_task_requires_valid"];
    ok("G4 exactly the 3 admin RPCs + the CHECK's validator are granted to authenticated",
      acl.every((r) => /(^|,)authenticated=/.test(r.a) === authed.includes(r.proname)), aclOf);
    ok("G5 the renderer / context / parser / consistency rule are service_role only",
      ["challenge_task_render_post", "challenge_task_render_post_text", "challenge_task_post_context", "challenge_task_parse_message_url",
       "challenge_task_requires_problem", "challenge_task_post_length"].every((n) => /service_role=X/.test(aclOf[n]) && !/authenticated=/.test(aclOf[n])), aclOf);

    // a real task, then who can see / write what
    await db.exec(`insert into challenge_tasks (course_id, task_date, type, title, body, accepts, requires)
                   values ('${C6}', '2026-10-01', 'general', 'Seed', 'x', '{text,photo,document}', '[]')`);
    const st = await as(db, S1, "select id from challenge_tasks");
    ok("G6 a student reads nothing", st.err === null && (st.rows as Row[]).length === 0, st);
    const stIns = await as(db, S1, insertSql, insParams({ date: "2026-10-02" }));
    ok("G7 a student cannot insert (RLS)", !!stIns.err && /row-level security/.test(stIns.err), stIns.err);
    const stUpd = await as(db, S1, "update challenge_tasks set title = 'hacked' returning id");
    ok("G8 a student's update touches 0 rows", stUpd.err === null && (stUpd.rows as Row[]).length === 0, stUpd);
    const an = await as(db, null, "select id from challenge_tasks", [], "anon");
    ok("G9 anon: permission denied", !!an.err && /permission denied/.test(an.err), an.err);
    const ad = await admin(db, "select id from challenge_tasks");
    ok("G10 an admin reads the calendar", ad.err === null && (ad.rows as Row[]).length === 1, ad);
    const adIns = await insAsAdmin(db, { date: "2026-10-02" });
    ok("G11 an admin inserts through RLS (identity column + the CHECK's validator work for authenticated)", adIns.err === null, adIns.err);
    const stPosts = await as(db, S1, "select * from challenge_task_posts");
    ok("G12 posts: a student reads nothing", stPosts.err === null && (stPosts.rows as Row[]).length === 0);
    const adPostIns = await admin(db, `insert into challenge_task_posts (task_id, group_id, chat_id) select id, '${G1}', ${CH1} from challenge_tasks limit 1`);
    ok("G13 posts: even an admin cannot write the table directly (RPC / service_role only)", !!adPostIns.err && /permission denied/.test(adPostIns.err), adPostIns.err);
    const direct = await admin(db, "select challenge_task_render_post_text('general','a','b',null,null,null,5,3,1,null,null)");
    ok("G14 the pure renderer is not callable by authenticated", !!direct.err && /permission denied/.test(direct.err), direct.err);
    await db.exec("delete from challenge_tasks");
  }

  // ───────────── V. SQL == TypeScript (the admin page's instant checks) ─────────────
  console.log("V. SQL mirrors == src/lib/dailyTasksPlan.ts");
  const { tasks: planTasks, errors: planErrors } = parsePlan(PLAN);
  {
    ok("V0 the fixture plan parses: 25 tasks", planErrors.length === 0 && planTasks.length === 25, planErrors);
    const REQS: unknown[] = [
      [], [SHOT], [SHOT, TEXT], [SHOT, IGL], [{ any: ["text", "photo", "image_doc", "link"], min: 1, label: "text" }],
      [{ any: ["voice", "video_note", "audio"], min: 20, label: "voice" }], null, {}, [1], [[]], "x",
      [{ any: [], min: 1, label: "text" }], [{ any: ["pdf"], min: 1, label: "file" }], [{ any: ["text", "text"], min: 1, label: "text" }],
      [{ any: ["text"], min: 0, label: "text" }], [{ any: ["text"], min: 21, label: "text" }], [{ any: ["text"], min: 1.5, label: "text" }],
      [{ any: ["text"], min: "1", label: "text" }], [{ any: ["text"], min: 1 }], [{ any: ["text"], min: 1, label: "image" }],
      [{ any: ["text"], min: 1, label: "text", x: 1 }], [{ any: "text", min: 1, label: "text" }], [{ any: [1], min: 1, label: "text" }],
      Array.from({ length: 8 }, () => TEXT), Array.from({ length: 9 }, () => TEXT), [{ any: [...Array(11).keys()].map(() => "text"), min: 1, label: "text" }],
      [{ any: ["text", "photo", "image_doc", "video", "video_doc", "document", "voice", "video_note", "audio", "link", "ig_link"], min: 1, label: "text" }],
      ...planTasks.map((t) => deriveFromFormat(t.format, t.type).requires),
    ];
    const bad: unknown[] = [];
    for (const r of REQS) {
      const s = (await one(db, "select challenge_task_requires_valid($1::jsonb) v", [r === null ? null : JSON.stringify(r)])).v;
      if (s !== (r === null ? false : requiresValid(r))) bad.push({ r, sql: s });
    }
    ok(`V1 requires_valid: SQL == requiresValid on ${REQS.length} shapes (incl. every plan task's derived requires)`, bad.length === 0, bad);

    const TYPES = ["general", "instagram"];
    const ACCEPTS = [["text"], ["text", "photo"], ["text", "photo", "document"], ["text", "photo", "document", "link"], ["photo", "link"],
      ["text", "voice", "video_note", "audio"], ["text", "video", "document"]];
    const bad2: unknown[] = [];
    let n2 = 0;
    for (const t of TYPES) for (const r of REQS.slice(0, 27)) for (const a of ACCEPTS) {
      n2++;
      const s = (await one(db, "select challenge_task_requires_problem($1, $2::jsonb, $3::text[]) v",
        [t, r === null ? null : JSON.stringify(r), `{${a.join(",")}}`])).v;
      const ts = requiresProblem(t, r, a);
      if (s !== ts) bad2.push({ t, r, a, sql: s, ts });
    }
    ok(`V2 requires_problem: SQL == requiresProblem on ${n2} (type, requires, accepts) triples`, bad2.length === 0, bad2.slice(0, 5));

    const LINKS = ["https://t.me/c/4440955972/144/5321", "  https://t.me/c/4440955972/144/5321/  ", "https://t.me/c/4440955972/5321?thread=144",
      "https://t.me/c/4440955972/144/5321?single&thread=99", "HTTPS://T.ME/c/4390902020/99/7", "https://t.me/c/4440955972/144",
      "https://t.me/c/4440955972/144?single", "https://t.me/c/4440955972/5321?thread=abc", "https://t.me/c/4440955972/144/5321#x",
      "https://t.me/somegroup/144/5", "t.me/c/1/2/3", "", "\thttps://t.me/c/1/2/3\n", "https://t.me/c/1/2/3/4", "https://t.me/c/0/2/3",
      "https://t.me/c/1/2?thread=", "https://t.me/c/1/2/3?comment=4", "https://t.me/c/1234567890123456/2/3", "https://t.me/c/12/0/0"];
    const bad3: unknown[] = [];
    for (const u of LINKS) {
      const s = await one(db, "select chat::text c, topic::int t, msg::int m from challenge_task_parse_message_url($1)", [u]);
      const ts = parseMessageUrl(u);
      const sv = s.c === null ? null : [s.c, s.t, s.m];
      const tv = ts === null ? null : [ts.chat, ts.topic, ts.msg];
      if (JSON.stringify(sv) !== JSON.stringify(tv)) bad3.push({ u, sql: sv, ts: tv });
    }
    ok(`V3 parse_message_url: SQL == parseMessageUrl on ${LINKS.length} links`, bad3.length === 0, bad3);
  }

  // ───────────── A. the approve guard ─────────────
  console.log("A. challenge_tasks_guard v1");
  {
    const approve = (id: number) => admin(db, "update challenge_tasks set status = 'approved' where id = $1 returning status, approved_by, approved_at", [id]);
    const idOf = (r: { rows: Row[] | null }) => Number((r.rows as Row[])[0].id);

    const d1 = await insAsAdmin(db, { date: "2026-10-01", title: "  Birinchi vazifa  ", accepts: ["link", "text", "photo", "document", "photo"],
                                      createdBy: S1, approvedBy: S1 });
    const r1 = (d1.rows as Row[])[0];
    ok("A1 a draft saves; created_by is the caller (not the forged value); approved stamps stay empty",
      d1.err === null && r1.created_by === AD && r1.approved_by === null && r1.approved_at === null, d1);
    ok("A2 accepts is normalized to canonical order, duplicates dropped",
      JSON.stringify(r1.accepts) === JSON.stringify(["text", "photo", "document", "link"]), r1.accepts);
    ok("A3 the title is trimmed", (await one(db, "select title from challenge_tasks where id = $1", [r1.id])).title === "Birinchi vazifa");
    const a1 = await approve(idOf(d1));
    ok("A4 approving stamps approved_by = the admin and approved_at", a1.err === null && (a1.rows as Row[])[0].approved_by === AD &&
      (a1.rows as Row[])[0].approved_at !== null, a1);
    const forged = await admin(db, "update challenge_tasks set approved_by = $2, approved_at = now() - interval '9 days', created_by = $2, title = 'Birinchi vazifa (tahrir)' where id = $1 returning approved_by, approved_at, created_by",
      [idOf(d1), S1]);
    const f0 = (forged.rows as Row[])[0];
    ok("A5 editing an approved task keeps the original stamps (approved_by / created_by unforgeable)",
      forged.err === null && f0.approved_by === AD && f0.created_by === AD && String(f0.approved_at) === String((a1.rows as Row[])[0].approved_at), forged);
    const un = await admin(db, "update challenge_tasks set status = 'draft' where id = $1 returning approved_by, approved_at", [idOf(d1)]);
    ok("A6 un-approving clears the stamps", un.err === null && (un.rows as Row[])[0].approved_by === null && (un.rows as Row[])[0].approved_at === null);
    await approve(idOf(d1));

    const out = await insAsAdmin(db, { course: C5, date: "2026-10-05", status: "approved" });
    ok("A7 a course outside the challenge cannot be approved", out.err?.includes("challenge doirasida emas") === true, out.err);
    const ct = await insAsAdmin(db, { course: CT, date: "2026-10-05" });
    ok("A8 ...the E2E test course cannot either, until its group is in challenge_tasks.test_group_ids",
      (await approve(idOf(ct))).err?.includes("challenge doirasida emas") === true);
    await db.query("update platform_settings set value = jsonb_set(value, '{test_group_ids}', $1::jsonb) where key = 'challenge_tasks'", [JSON.stringify([G8])]);
    ok("A9 ...and can once it is (G26)", (await approve(idOf(ct))).err === null);
    await db.query("update platform_settings set value = jsonb_set(value, '{test_group_ids}', '[]'::jsonb) where key = 'challenge_tasks'");
    await db.query("update platform_settings set value = jsonb_set(value, '{group_ids}', $1::jsonb) where key = 'challenge'", [JSON.stringify([G5])]);
    const viaGroup = await insAsAdmin(db, { course: C5, date: "2026-10-06", status: "approved" });
    ok("A10 a course whose GROUP is in challenge.group_ids is in scope", viaGroup.err === null, viaGroup.err);
    await db.query("update platform_settings set value = jsonb_set(value, '{group_ids}', '[]'::jsonb) where key = 'challenge'");

    const early = await insAsAdmin(db, { date: "2026-09-30", status: "approved" });
    ok("A11 a date before the window (2026-10-01 Tashkent) cannot be approved", early.err?.includes("challenge oynasidan oldin (boshlanishi: 2026-10-01)") === true, early.err);
    const earlyDraft = await insAsAdmin(db, { date: "2026-09-30" });
    ok("A12 ...but a draft on that date saves (only approval is gated)", earlyDraft.err === null, earlyDraft.err);
    await db.query(`update platform_settings set value = jsonb_set(value, '{window,end}', '"2026-11-30T23:59:59+05:00"') where key = 'challenge'`);
    const late = await insAsAdmin(db, { date: "2026-12-01", status: "approved" });
    ok("A13 a date after window.end cannot be approved", late.err?.includes("challenge oynasidan keyin (tugashi: 2026-11-30)") === true, late.err);
    await db.query(`update platform_settings set value = jsonb_set(value, '{window,end}', '"banana"') where key = 'challenge'`);
    const junk = await insAsAdmin(db, { date: "2026-10-07", status: "approved" });
    ok("A14 a malformed window refuses approval with its own message", junk.err?.includes("Challenge oynasi") === true, junk.err);
    await db.query(`update platform_settings set value = jsonb_set(value, '{window,end}', 'null') where key = 'challenge'`);

    const igNoLink = await insAsAdmin(db, { date: "2026-10-07", type: "instagram", accepts: ["text", "photo", "document", "link"], requires: [SHOT], status: "approved" });
    ok("A15 an instagram task without an ig_link group cannot be approved", igNoLink.err?.includes(REQUIRES_MSG.igNeedsShotAndLink) === true, igNoLink.err);
    const genIg = await insAsAdmin(db, { date: "2026-10-07", requires: [SHOT, IGL], accepts: ["text", "photo", "document", "link"], status: "approved" });
    ok("A16 ig_link on a general task cannot be approved", genIg.err?.includes(REQUIRES_MSG.igLinkOnGeneral) === true, genIg.err);
    const notAcc = await insAsAdmin(db, { date: "2026-10-07", requires: [SHOT], accepts: ["text", "photo"], status: "approved" });
    ok("A17 a required kind that is not accepted cannot be approved", notAcc.err?.includes(REQUIRES_MSG.notAccepted("image_doc")) === true, notAcc.err);
    const badReq = await insAsAdmin(db, { date: "2026-10-07", requires: [{ any: ["text"], min: 0, label: "text" }] });
    ok("A18 an invalid requires cannot even be saved as a draft (CHECK)", /challenge_tasks_requires_check/.test(badReq.err ?? ""), badReq.err);
    const badAcc = await insAsAdmin(db, { date: "2026-10-07", accepts: ["text", "sticker"] });
    ok("A19 an unknown accepts kind is rejected, never silently dropped", /challenge_tasks_accepts_check/.test(badAcc.err ?? ""), badAcc.err);

    const huge = await insAsAdmin(db, { date: "2026-10-07", title: LONG(120, "T"), body: LONG(3000, "&"), learn: LONG(500), hint: LONG(500) });
    const hugeA = await approve(idOf(huge));
    ok("A20 a draft whose rendered post exceeds 4000 characters saves, but cannot be approved", huge.err === null &&
      /E’lon matni juda uzun: \d+ \/ 4000/.test(hugeA.err ?? ""), hugeA.err);
    const fit = await insAsAdmin(db, { date: "2026-10-08", title: LONG(120, "T"), body: LONG(3000, "y"), learn: LONG(300), hint: LONG(200) });
    const fitA = await approve(idOf(fit));
    const fitLen = (await one(db, "select challenge_task_post_length(challenge_task_render_post(t)) n from challenge_tasks t where id = $1", [idOf(fit)])).n;
    ok("A21 a long task that fits approves (the limit is on the rendered text)", fitA.err === null && fitLen <= 4000 && fitLen > 3500, { e: fitA.err, fitLen });

    // one live task per course per day
    const dup = await insAsAdmin(db, { date: "2026-10-01" });
    ok("A22 a second live task on the same (course, date) is refused", /uq_challenge_tasks_course_date/.test(dup.err ?? ""), dup.err);
    await admin(db, "update challenge_tasks set status = 'cancelled' where course_id = $1 and task_date = '2026-10-01'", [C6]);
    const after = await insAsAdmin(db, { date: "2026-10-01" });
    ok("A23 ...a cancelled one frees the day", after.err === null, after.err);
    ok("A24 the other course's calendar is independent", (await insAsAdmin(db, { course: CT, date: "2026-10-01" })).err === null);

    // deletes
    const delAppr = await admin(db, "delete from challenge_tasks where id = $1 returning id", [idOf(fit)]);
    ok("A25 an approved task cannot be deleted (0 rows under RLS) -- cancel it instead", delAppr.err === null && (delAppr.rows as Row[]).length === 0);
    const delDraft = await admin(db, "delete from challenge_tasks where id = $1 returning id", [idOf(earlyDraft)]);
    ok("A26 a draft can be deleted", delDraft.err === null && (delDraft.rows as Row[]).length === 1);

    // render: day number, points, the tag line
    await db.exec("delete from challenge_tasks");
  }

  // ───────────── I. the importer: the real 25-task plan ─────────────
  console.log("I. admin_challenge_tasks_import with the owner's plan");
  {
    const rows = buildImportRows(planTasks, { startDate: "2026-10-01", weekdays: [1, 2, 3, 4, 5], occupiedDates: new Set(),
      existingRefs: new Set(), defaultPoints: { general: 5, instagram: 8 } });
    const items = rows.map((r) => r.item);
    ok("I0 the TS planner produces 25 valid items", items.every((x) => x !== null) && items.length === 25);
    const st = await as(db, S1, "select admin_challenge_tasks_import($1, $2::jsonb) r", [C6, JSON.stringify(items)]);
    ok("I1 a student cannot import", !!st.err && /admin only/.test(st.err), st.err);
    const imp = await admin(db, "select admin_challenge_tasks_import($1, $2::jsonb) r", [C6, JSON.stringify(items)]);
    const r = (imp.rows as Row[] | null)?.[0]?.r;
    ok("I2 an admin imports all 25 as drafts", imp.err === null && r?.created === 25 && r?.skipped.length === 0, imp.err ?? r);
    const cal = await q(db, `select task_date::text d, type, status, source, plan_ref, points, requires_tag, requires, accepts, min_duration_sec, created_by
                               from challenge_tasks where course_id = $1 order by task_date`, [C6]);
    ok("I3 every row: draft / import / created_by = the admin", cal.length === 25 &&
      cal.every((c) => c.status === "draft" && c.source === "import" && c.created_by === AD), cal.slice(0, 2));
    ok("I4 dates: Thu 10-01, Fri 10-02, then Mon 10-05 ... no weekend, no repeat",
      cal[0].d === "2026-10-01" && cal[1].d === "2026-10-02" && cal[2].d === "2026-10-05" && cal[24].d === "2026-11-04" &&
      cal.every((c) => ![0, 6].includes(new Date(`${c.d}T00:00:00Z`).getUTCDay())), cal.map((c) => c.d));
    ok("I5 7 instagram tasks, each requiring a screenshot + ig_link, tag required; points left to config",
      cal.filter((c) => c.type === "instagram").length === 7 &&
      cal.filter((c) => c.type === "instagram").every((c) => c.requires_tag === true && JSON.stringify(c.requires) === JSON.stringify([SHOT, IGL])) &&
      cal.every((c) => c.points === null), cal.filter((c) => c.type === "instagram"));
    ok("I6 the voice task keeps min_duration_sec 20", cal.find((c) => c.plan_ref === "W5D4")?.min_duration_sec === 20);
    const audit = await q(db, "select actor_user_id, details from admin_actions where action = 'challenge_tasks_imported'");
    ok("I7 the import is audited (admin_actions)", audit.length === 1 && audit[0].actor_user_id === AD && audit[0].details.created === 25);

    const again = await admin(db, "select admin_challenge_tasks_import($1, $2::jsonb) r", [C6, JSON.stringify(items)]);
    const r2 = (again.rows as Row[])[0].r;
    ok("I8 re-importing the same plan creates nothing: 25 skipped as plan_ref_exists", r2.created === 0 && r2.skipped.length === 25 &&
      r2.skipped.every((s: Row) => s.reason === "plan_ref_exists"), r2);
    const clash = await admin(db, "select admin_challenge_tasks_import($1, $2::jsonb) r",
      [C6, JSON.stringify([{ ...items[0], plan_ref: "X1", task_date: "2026-10-01" }])]);
    ok("I9 an item on a taken date is skipped as date_taken", (clash.rows as Row[])[0].r.skipped[0]?.reason === "date_taken");
    const broken = await admin(db, "select admin_challenge_tasks_import($1, $2::jsonb) r",
      [C6, JSON.stringify([{ ...items[0], plan_ref: "Y1", task_date: "2026-12-01" }, { ...items[1], plan_ref: "Y2", task_date: "2026-12-02", title: "ab" }])]);
    ok("I10 one invalid item aborts the whole import, named by position", /Reja elementi #2 \(Y2\)/.test(broken.err ?? "") &&
      (await one(db, "select count(*)::int n from challenge_tasks where plan_ref like 'Y%'")).n === 0, broken.err);
    ok("I11 a bad date is named too", /#1 \(Z\): sana/.test((await admin(db, "select admin_challenge_tasks_import($1, $2::jsonb)",
      [C6, JSON.stringify([{ ...items[0], plan_ref: "Z", task_date: "2026-13-45" }])])).err ?? ""));
    ok("I12 an unknown course / empty list are refused",
      /Kurs topilmadi/.test((await admin(db, "select admin_challenge_tasks_import($1, '[{}]'::jsonb)", [U(99)])).err ?? "") &&
      /bo‘sh/.test((await admin(db, "select admin_challenge_tasks_import($1, '[]'::jsonb)", [C6])).err ?? ""));

    // a human approves them all: every plan task passes the guard (render <= 4000, requires consistent)
    const appr = await admin(db, "update challenge_tasks set status = 'approved' where course_id = $1 and status = 'draft' returning id", [C6]);
    ok("I13 all 25 imported drafts approve through the guard", appr.err === null && (appr.rows as Row[]).length === 25, appr.err);
    const lens = await q(db, `select plan_ref, challenge_task_post_length(challenge_task_render_post(t)) n, challenge_task_render_post(t) txt
                                from challenge_tasks t where course_id = $1 order by task_date`, [C6]);
    ok("I14 every rendered post is <= 4000 UTF-16 units, and the SQL count equals JavaScript's String.length",
      lens.every((l) => l.n <= 4000 && l.n === l.txt.length), lens.map((l) => [l.n, l.txt.length]));
    ok("I15 day numbers follow the approved dates (3rd = '3-kun', 25th = '25-kun')",
      lens[2].txt.startsWith("📅 <b>3-kun vazifasi</b> · 5-oktabr, dushanba") && lens[24].txt.startsWith("📅 <b>25-kun vazifasi</b>"), lens[2].txt.slice(0, 60));
    const ig = lens.find((l) => l.plan_ref === "W1D5")!;
    ok("I16 an instagram post carries +8 / +4 and the @aicreators.students line", ig.txt.includes("🏆 +8 ball") && ig.txt.includes("+4 ball.") &&
      ig.txt.includes("📸 Postda @aicreators.students ni belgilang."), ig.txt);
    ok("I17 a general post carries +5 / +3 and no instagram line", lens[0].txt.includes("🏆 +5 ball") && lens[0].txt.includes("+3 ball.") &&
      !lens[0].txt.includes("📸"));
    ok("I18 every post ends with the 'this topic only' line", lens.every((l) => l.txt.endsWith("📍 Faqat shu «Kunlik vazifalar» topikiga yuboring (uy vazifasi topikiga emas).")));
    await db.query(`update platform_settings set value = value || '{"points": {"general": 6, "instagram": 10}, "late_factor": 0.5}' where key = 'challenge_tasks'`);
    const p2 = await one(db, "select challenge_task_render_post(t) txt from challenge_tasks t where plan_ref = 'W1D5' and course_id = $1", [C6]);
    ok("I19 points come from config when the task has no override (+10 / +5)", p2.txt.includes("🏆 +10 ball") && p2.txt.includes("+5 ball."), p2.txt);
    await db.query(`update platform_settings set value = value || '{"points": {"general": 5, "instagram": 8}}' where key = 'challenge_tasks'`);
  }

  // ───────────── R. the preview RPC ─────────────
  console.log("R. admin_challenge_task_preview");
  {
    const draft = { course_id: C6, task_date: "2026-10-06", type: "instagram", title: "Sinov", body: "Matn <b>", requires: [SHOT, IGL],
                    accepts: ["text", "photo", "document", "link"], minutes: 15 };
    const p = await admin(db, "select admin_challenge_task_preview($1::jsonb) p", [JSON.stringify(draft)]);
    const pv = (p.rows as Row[] | null)?.[0]?.p;
    ok("R1 renders an unsaved draft: text, length, day number among APPROVED tasks, points",
      p.err === null && pv.length === pv.text.length && pv.max === 4000 && pv.day_no === 4 && pv.points === 8 && pv.late_points === 4 &&
      pv.text.includes("Matn &lt;b&gt;") && pv.requires_problem === null, pv);
    const p2 = await admin(db, "select admin_challenge_task_preview($1::jsonb) p", [JSON.stringify({ ...draft, requires: [SHOT] })]);
    ok("R2 reports the approve guard's requires problem", (p2.rows as Row[])[0].p.requires_problem === REQUIRES_MSG.igNeedsShotAndLink);
    const p3 = await admin(db, "select admin_challenge_task_preview($1::jsonb) p", [JSON.stringify({ ...draft, minutes: "abc" })]);
    ok("R3 an unrepresentable draft answers {error}, not an exception", p3.err === null && typeof (p3.rows as Row[])[0].p.error === "string", p3);
    const p4 = await as(db, S1, "select admin_challenge_task_preview('{}'::jsonb) p");
    ok("R4 a student cannot call it", !!p4.err && /admin only/.test(p4.err));
    const p5 = await admin(db, "select admin_challenge_task_preview('{}'::jsonb) p");
    ok("R5 an empty draft still renders (no NULL post)", typeof (p5.rows as Row[])[0].p.text === "string" && (p5.rows as Row[])[0].p.text.length > 50);
  }

  // ───────────── S. manual posts ─────────────
  console.log("S. admin_challenge_task_set_manual_post");
  {
    const t1 = Number((await one(db, "select id from challenge_tasks where course_id = $1 and task_date = '2026-10-01'", [C6])).id);
    const t2 = Number((await one(db, "select id from challenge_tasks where course_id = $1 and task_date = '2026-10-02'", [C6])).id);
    const set = (task: number, group: string, url: string | null, uid = AD) =>
      as(db, uid, "select admin_challenge_task_set_manual_post($1, $2, $3) r", [task, group, url]);
    const val = (r: { rows: Row[] | null }) => (r.rows as Row[])[0].r;

    const s1 = await set(t1, G1, "https://t.me/c/4440955972/144/5321");
    ok("S1 a topic message link registers a 'manual' post (bot never saw it: seen_by_bot false)",
      s1.err === null && val(s1).state === "manual" && val(s1).seen_by_bot === false && val(s1).message_id === 5321, s1);
    const row1 = await one(db, "select state, chat_id::text c, thread_id::int th, message_id::int m from challenge_task_posts where task_id = $1 and group_id = $2", [t1, G1]);
    ok("S2 ...stored with the Bot API chat id and the topic", row1.state === "manual" && row1.c === String(CH1) && row1.th === D1 && row1.m === 5321, row1);

    const date = 1759302000; // 2025-10-01 07:00 UTC as a unix time; any value works
    await db.query(`insert into webhook_inbox (update_type, chat_id, message_id, raw_update) values
      ('message', $1, 5400, $2::jsonb), ('message', $1, 5401, $3::jsonb)`, [CH1,
      JSON.stringify({ message: { message_id: 5400, date, message_thread_id: D1, is_topic_message: true, text: "1-kun vazifasi: ChatGPT sozlamalari" } }),
      JSON.stringify({ message: { message_id: 5401, date, message_thread_id: 3, is_topic_message: true, text: "homework topic" } })]);
    const s3 = await set(t1, G1, "https://t.me/c/4440955972/5400?thread=144");
    ok("S3 re-pointing to a message the bot saw: seen_by_bot, its text as the preview, sent_at from its date",
      s3.err === null && val(s3).seen_by_bot === true && val(s3).preview === "1-kun vazifasi: ChatGPT sozlamalari" && val(s3).sent_at !== null, s3);
    const s4 = await set(t1, G1, "https://t.me/c/4440955972/144/5401");
    ok("S4 a link that claims the daily topic for a message the bot saw elsewhere is refused",
      s4.err?.includes("«Kunlik vazifalar» topikida ko‘rmagan") === true, s4.err);
    ok("S5 another chat is refused", (await set(t1, G1, "https://t.me/c/4390902020/99/10")).err?.includes("boshqa guruhdagi") === true);
    ok("S6 another topic of the same chat is refused", (await set(t1, G1, "https://t.me/c/4440955972/3/600")).err?.includes("topikidagi xabarga emas") === true);
    ok("S7 a topic link (no message) is refused with the example", (await set(t1, G1, "https://t.me/c/4440955972/144")).err?.includes("Xabar havolasi noto‘g‘ri") === true);
    ok("S8 the topic-creation message itself is refused", (await set(t1, G1, "https://t.me/c/4440955972/144/144")).err?.includes("topikning o‘zi") === true);
    const s9 = await set(t2, G1, "https://t.me/c/4440955972/144/5400");
    ok("S9 the same message cannot be the post of a second task", s9.err?.includes("boshqa vazifaga (2026-10-01)") === true, s9.err);
    ok("S10 a group with no daily topic is refused", (await set(t1, G5, "https://t.me/c/555/21/30")).err?.includes("topiki sozlanmagan") === true);
    await db.exec(`update groups set daily_task_topic_url = 'https://t.me/c/555/21' where id = '${G5}'`);
    ok("S11 a group of another course is refused", (await set(t1, G5, "https://t.me/c/555/21/30")).err?.includes("kursiga tegishli emas") === true);
    ok("S12 a student cannot call it", /admin only/.test((await set(t1, G1, "https://t.me/c/4440955972/144/5500", S1)).err ?? ""));
    const s13 = await set(t2, G2, "https://t.me/c/4390902020/99/700");
    ok("S13 another group, another task: fine", s13.err === null && val(s13).state === "manual");

    // a post the bot sent is protected
    await db.exec(`insert into challenge_task_posts (task_id, group_id, kind, state, chat_id, thread_id, message_id, sent_at)
                   values (${t2}, '${G3}', 'task', 'sent', -1003714608284, 38, 900, now())`);
    ok("S14 a bot-sent post cannot be overwritten", (await set(t2, G3, "https://t.me/c/3714608284/38/901")).err?.includes("allaqachon e’lon qilgan") === true);
    ok("S15 ...nor cleared", (await set(t2, G3, "")).err?.includes("o‘chirib bo‘lmaydi") === true);
    const s16 = await set(t1, G1, "  ");
    ok("S16 a blank link clears a manual post", s16.err === null && val(s16).changed === true &&
      (await one(db, "select count(*)::int n from challenge_task_posts where task_id = $1 and group_id = $2", [t1, G1])).n === 0);
    ok("S17 clearing nothing is a no-op", val(await set(t1, G1, null)).changed === false);
    const au = await q(db, "select action, count(*)::int n from admin_actions where action like 'challenge_task_manual_post%' group by 1 order by 1");
    ok("S18 every change is audited", JSON.stringify(au) === JSON.stringify([{ action: "challenge_task_manual_post_cleared", n: 1 },
      { action: "challenge_task_manual_post_set", n: 3 }]), au);
    const rd = await admin(db, "select state from challenge_task_posts order by state");
    ok("S19 admins read the posts table", rd.err === null && (rd.rows as Row[]).length === 2);
    const delT = await admin(db, "update challenge_tasks set status = 'draft' where id = $1 returning id", [t2]);
    const delT2 = await errOf(db, `delete from challenge_tasks where id = ${t2}`);
    ok("S20 a task with a post row cannot be deleted, even by the owner role (FK RESTRICT)", delT.err === null && /foreign key/.test(delT2 ?? ""), delT2);
  }

  await db.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) throw new Error(`daily_tasks_calendar: ${fail} check(s) failed`);
}
