// Applies 20261001060000_profiles_guard_trigger_order.sql to a real PostgreSQL (PGlite, PG 17) carrying production's
// profiles guard stack as of 2026-10-01: the REAL #222 migration (20260930120020, the guard + its watchdog) and the
// REAL #232 Instagram handle lock (its function text cut from 20260930150020), on a profiles table with the live
// columns, policies and trigger set. Then it reproduces the incident, applies the fix, and drives the guard, the
// heal and the detector end to end with a stub ops_net_post.
//
//   deno run -A --node-modules-dir=none supabase/functions/_watchdogs/testing/profiles-guard-order-check.ts
//   (PGO_MIG=<path> points it at a draft of the migration instead of the committed file)
//
// Run it after ANY change to that migration, and before asking for the migration-approved label.
// TEST INFRASTRUCTURE ONLY: this directory has no index.ts, so it is never deployed, and the file is not named
// *.test.ts, so CI's `deno test supabase/functions/` does not try to fetch PGlite.
//
// Fidelity: section A asserts that every function the migration pins has production's md5 (prosrc with CRs
// stripped, and pg_get_functiondef), and that the profiles trigger set (name, type, enabled) is production's, so
// the migration's pins and exactly-once replace() checks run against the real text.

import { PGlite } from "npm:@electric-sql/pglite@0.5.8";
import { citext } from "npm:@electric-sql/pglite@0.5.8/contrib/citext";

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

const here = (p: string) => new URL(p, import.meta.url);
const lf = (s: string) => s.replace(/\r\n/g, "\n"); // a Windows checkout is CRLF; production text is LF
const MIG = lf(await Deno.readTextFile(
  Deno.env.get("PGO_MIG") ?? here("../../../migrations/20261001060000_profiles_guard_trigger_order.sql")));
const PR0 = lf(await Deno.readTextFile(here("../../../migrations/20260930120020_profiles_column_guard.sql")));
const ENGINE = lf(await Deno.readTextFile(here("../../../migrations/20260930150020_challenge_daily_tasks_engine.sql")));

/** #232's Instagram handle lock, cut verbatim from its migration: the function and its trigger. */
function igLockSql(): string {
  const fStart = ENGINE.indexOf("create or replace function public.challenge_task_ig_handle_guard()");
  const bodyOpen = ENGINE.indexOf("$fn$", fStart);
  const bodyClose = ENGINE.indexOf("$fn$;", bodyOpen + 4);
  const tStart = ENGINE.indexOf("drop trigger if exists trg_profiles_zz_ig_handle_lock on public.profiles;");
  const tEnd = ENGINE.indexOf("execute function public.challenge_task_ig_handle_guard();", tStart);
  if (fStart < 0 || bodyOpen < 0 || bodyClose < 0 || tStart < 0 || tEnd < 0) throw new Error("ig lock not found in 20260930150020");
  return ENGINE.slice(fStart, bodyClose + 5) + "\n" +
    "revoke execute on function public.challenge_task_ig_handle_guard() from public, anon, authenticated;\n" +
    ENGINE.slice(tStart, tEnd + "execute function public.challenge_task_ig_handle_guard();".length) + "\n";
}

// production, 2026-10-01: md5(replace(prosrc, CR, '')) and md5(pg_get_functiondef(oid))
const PROD = {
  profiles_guard_health: { body: "42f8156667ea347f1136047ffea07860", def: "44d6ec33e360195eeaee2903f28995d9" },
  profiles_guard_alert_text: { body: "44cb94ccf7365892d2e38a47ce16a483", def: "73f91c0bc9d8b790b41a96312bb13abe" },
  profiles_guard_drift: { body: "4adc2cc0f73c5174ad04f434d284214f", def: "1e4396881901e6167fce75f337dc8f6d" },
  challenge_task_ig_handle_guard: { body: "29319d2e45e7c471d0be2f94f518c4f3", def: "445d831540541db9a774013bcfa8ad22" },
  profiles_column_guard: { body: "8016e666d828887f6b4f9bd2a1b7960f", def: "86cb4d4c91bf98b61329c11039a5f19c" },
  profiles_guard_watchdog: { body: "78ca1f950e271e06ef0c522890a2de2e", def: "127861f69119811f89c37fbed741b00b" },
  profiles_guard_alert_decision: { body: "596d788e230e9c6aaf7ff887db6c30b6", def: "7979a724c452bef42e67ce5fd06fc4e6" },
};
// production's profiles triggers (name, tgtype, tgenabled), 2026-10-01 04:35 UTC, and after this migration.
const LIVE_TRIGGERS_PRE = [
  "trg_new_student_alert 5 O", "trg_profiles_aa_course_move_guard 17 O", "trg_profiles_challenge_retro_credit 21 O",
  "trg_profiles_normalize_instagram 23 O", "trg_profiles_sync_group_enrollment 21 O", "trg_profiles_updated 19 O",
  "trg_profiles_zz_column_guard 23 O", "trg_profiles_zz_ig_handle_lock 19 O", "trg_profiles_zz_instagram_audit 17 O",
];
const LIVE_TRIGGERS_POST = LIVE_TRIGGERS_PRE.filter((t) => !t.startsWith("trg_profiles_zz_column_guard "))
  .concat("trg_profiles_zzz_column_guard 23 O").sort();

const G1 = "11111111-1111-1111-1111-111111111111";
const G2 = "22222222-2222-2222-2222-222222222222";
const C1 = "c1c1c1c1-c1c1-c1c1-c1c1-c1c1c1c1c1c1";
const C2 = "c2c2c2c2-c2c2-c2c2-c2c2-c2c2c2c2c2c2";
const T1 = "71717171-7171-7171-7171-717171717171";
const T2 = "72727272-7272-7272-7272-727272727272";
const S1 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"; // student in G1, provisional
const S2 = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"; // student in G1, Instagram handle LOCKED (accepted task)
const AD = "adadadad-adad-adad-adad-adadadadadad"; // admin, telegram 9001
const SA = "5a5a5a5a-5a5a-5a5a-5a5a-5a5a5a5a5a5a"; // superadmin, telegram 9002
const TE = "7e7e7e7e-7e7e-7e7e-7e7e-7e7e7e7e7e7e"; // teacher of G1
const N1 = "e1e1e1e1-0000-0000-0000-000000000001"; // profiles born during the drift test
const N2 = "e1e1e1e1-0000-0000-0000-000000000002";
const N3 = "e1e1e1e1-0000-0000-0000-000000000003";

const SCHEMA = `
set timezone = 'Asia/Tashkent';
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant anon, authenticated, service_role to postgres;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges revoke execute on functions from public;
alter default privileges in schema public grant execute on functions to authenticated, service_role;

create extension if not exists citext;
create schema auth;
grant usage on schema auth to anon, authenticated, service_role;
create table auth.users (id uuid primary key, email text);
create function auth.uid() returns uuid language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $$;
create function auth.role() returns text language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'))::text $$;
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim', true), ''),
                  nullif(current_setting('request.jwt.claims', true), ''))::jsonb $$;
grant execute on function auth.uid(), auth.role(), auth.jwt() to anon, authenticated, service_role;

create schema cron;
create table cron.job (jobid bigserial primary key, jobname text, schedule text, command text);
create function cron.schedule(p_name text, p_schedule text, p_command text) returns bigint language sql as $$
  insert into cron.job (jobname, schedule, command) values (p_name, p_schedule, p_command) returning jobid $$;
create function cron.unschedule(p_jobid bigint) returns boolean language sql as $$
  delete from cron.job where jobid = p_jobid returning true $$;

create type public.app_role as enum ('admin', 'student', 'teacher', 'superadmin');
create type public.user_status as enum ('active', 'inactive', 'archived');
create table public.user_roles (id uuid primary key default gen_random_uuid(), user_id uuid not null,
  role public.app_role not null, unique (user_id, role));
create function public.has_role(_user_id uuid, _role public.app_role) returns boolean
  language sql stable security definer set search_path to 'public' as $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role); $$;
grant execute on function public.has_role(uuid, public.app_role) to anon, authenticated, service_role;

create table public.courses (id uuid primary key);
create table public.course_tiers (id uuid primary key, course_id uuid);
create table public.groups (id uuid primary key, name text, course_id uuid, tier_id uuid, teacher_id uuid);
create table public.group_teachers (group_id uuid not null references public.groups(id) on delete cascade,
  teacher_id uuid not null, primary key (group_id, teacher_id));
create table public.enrollments (id uuid primary key default gen_random_uuid(), user_id uuid not null,
  course_id uuid not null, tier_id uuid, enrolled_at timestamptz not null default now(), unique (user_id, course_id));

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text, email text not null unique, avatar_url text, timezone text default 'Asia/Tashkent',
  status public.user_status not null default 'active', weekly_goal_lessons integer default 5, goals text,
  onboarding_completed boolean default false, created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(), telegram_username citext, telegram_id bigint,
  preferred_language text default 'uz', last_name text, telegram_onboarded_at timestamptz,
  preferred_locale text not null default 'uz', reminder_time time not null default '20:00:00',
  notifications_enabled boolean not null default true, last_daily_reminder_at timestamptz,
  last_streak_warning_at timestamptz, last_inactive_warning_at timestamptz, last_inactive_warning_day integer,
  group_id uuid references public.groups(id) on delete set null, digest_opt_in boolean not null default true,
  tashkent_offset_minutes integer not null default 300, archived_at timestamptz,
  active_teacher_group_id uuid references public.groups(id) on delete set null,
  name_confirmed_at timestamptz, name_prompt_last_at timestamptz, phone text, bio text,
  account_type text not null default 'paid' check (account_type in ('provisional', 'paid')),
  hide_from_group_boards boolean not null default false, instagram_username citext);
create function public.is_group_teacher(_group_id uuid, _uid uuid) returns boolean
  language sql stable security definer set search_path to 'public' as $$
  select exists (select 1 from public.groups g where g.id = _group_id and g.teacher_id = _uid)
      or exists (select 1 from public.group_teachers gt where gt.group_id = _group_id and gt.teacher_id = _uid); $$;
create function public.is_teacher_of(_student uuid, _teacher uuid) returns boolean
  language sql stable security definer set search_path to 'public' as $$
  select exists (select 1 from profiles p join groups g on g.id = p.group_id
                  where p.id = _student and public.is_group_teacher(p.group_id, _teacher)) $$;
revoke execute on function public.is_group_teacher(uuid, uuid), public.is_teacher_of(uuid, uuid) from public, anon;
grant execute on function public.is_group_teacher(uuid, uuid), public.is_teacher_of(uuid, uuid) to authenticated, service_role;
create unique index profiles_telegram_id_unique on public.profiles (telegram_id) where telegram_id is not null;
create unique index profiles_telegram_username_unique on public.profiles (telegram_username) where telegram_username is not null;
create unique index uq_profiles_instagram_username on public.profiles (instagram_username) where instagram_username is not null;
alter table public.profiles enable row level security;
create policy "profiles delete admin" on public.profiles for delete using (has_role(auth.uid(), 'admin'::app_role));
create policy "profiles insert self" on public.profiles for insert
  with check ((auth.uid() = id) or has_role(auth.uid(), 'admin'::app_role));
create policy "profiles select own or admin" on public.profiles for select
  using ((auth.uid() = id) or has_role(auth.uid(), 'admin'::app_role));
create policy "profiles update own or admin" on public.profiles for update
  using ((auth.uid() = id) or has_role(auth.uid(), 'admin'::app_role));

-- The live trigger set before #222 (names, timing, events; stand-in bodies where the body does not matter here).
create function public.update_updated_at_column() returns trigger language plpgsql set search_path to 'public' as $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;
create function public.normalize_instagram_username() returns trigger language plpgsql as $$
begin
  if new.instagram_username is null then return new; end if;
  new.instagram_username := nullif(regexp_replace(lower(btrim(new.instagram_username::text)), '^@+', ''), '')::citext;
  return new;
end; $$;
create function public.sync_group_enrollment() returns trigger language plpgsql security definer as $$
declare _course uuid; _tier uuid;
begin
  if new.group_id is null then return new; end if;
  select g.course_id, g.tier_id into _course, _tier from public.groups g where g.id = new.group_id;
  if _course is null then return new; end if;
  insert into public.enrollments (user_id, course_id, tier_id) values (new.id, _course, _tier)
  on conflict (user_id, course_id) do update set tier_id = excluded.tier_id;
  return new;
end; $$;
create function public.test_after_noop() returns trigger language plpgsql security definer as $$ begin return null; end; $$;
create trigger trg_new_student_alert after insert on public.profiles for each row execute function test_after_noop();
create trigger trg_profiles_normalize_instagram before insert or update of instagram_username on public.profiles
  for each row execute function normalize_instagram_username();
create trigger trg_profiles_sync_group_enrollment after insert or update of group_id on public.profiles
  for each row when (new.group_id is not null) execute function sync_group_enrollment();
create trigger trg_profiles_updated before update on public.profiles for each row execute function update_updated_at_column();
-- #234 and S3 (AFTER triggers; stand-in bodies)
create trigger trg_profiles_aa_course_move_guard after update of group_id on public.profiles
  for each row when (old.group_id is distinct from new.group_id and new.group_id is not null) execute function test_after_noop();
create trigger trg_profiles_challenge_retro_credit after insert or update of telegram_id, group_id on public.profiles
  for each row when (new.telegram_id is not null and new.group_id is not null) execute function test_after_noop();

create table public.admin_actions (id uuid primary key default gen_random_uuid(), actor_user_id uuid,
  action text not null, target_user_id uuid, target_resource_type text, target_resource_id uuid,
  details jsonb not null default '{}'::jsonb, created_at timestamptz not null default now());
alter table public.admin_actions enable row level security;
create table public.app_settings (key text primary key, value jsonb, description text, updated_by uuid,
  updated_at timestamptz not null default now());
create table public.platform_settings (key text primary key, value jsonb not null, updated_at timestamptz not null default now());

-- The tables #222 closed (already closed in production: created here without the student policies).
create table public.streaks (user_id uuid primary key, current_streak integer default 0, last_active_date date);
alter table public.streaks enable row level security;
create table public.daily_watch_summary (user_id uuid, watch_date date, total_seconds numeric, primary key (user_id, watch_date));
alter table public.daily_watch_summary enable row level security;
create table public.homework_submissions (id uuid primary key default gen_random_uuid(), user_id uuid not null,
  assignment_id uuid, score smallint, scored_by uuid, scored_at timestamptz, submitted_at timestamptz default now(),
  previous_attempts jsonb default '[]'::jsonb, previous_score smallint);
alter table public.homework_submissions enable row level security;
create table public.quiz_attempts (id uuid primary key default gen_random_uuid(), user_id uuid not null, score integer);
alter table public.quiz_attempts enable row level security;

-- ops_net_post stand-in (production's name and parameters): records what a watchdog would have sent.
create table public.ops_calls (id bigserial primary key, url text, body jsonb, headers jsonb, purpose text);
create function public.ops_net_post(p_url text, p_body jsonb, p_headers jsonb default '{}'::jsonb,
  p_purpose text default null, p_timeout_ms integer default 30000) returns bigint language sql as $$
  insert into public.ops_calls (url, body, headers, purpose) values (p_url, p_body, p_headers, p_purpose) returning id $$;

-- #232's helper, cut down to what the lock needs: answers only about the caller; admins are never locked.
create table public.test_ig_locked (user_id uuid primary key);
create function public.challenge_task_ig_handle_locked(_user uuid) returns boolean
  language plpgsql stable security definer set search_path = public as $fn$
begin
  if _user is null or auth.uid() is null or _user <> auth.uid() then return false; end if;
  if public.has_role(auth.uid(), 'admin') or public.has_role(auth.uid(), 'superadmin') then return false; end if;
  return exists (select 1 from public.test_ig_locked where user_id = _user);
end $fn$;
revoke execute on function public.challenge_task_ig_handle_locked(uuid) from public, anon, authenticated;
grant execute on function public.challenge_task_ig_handle_locked(uuid) to authenticated, service_role;

insert into public.courses values ('${C1}'), ('${C2}');
insert into public.course_tiers values ('${T1}', '${C1}'), ('${T2}', '${C2}');
insert into public.groups (id, name, course_id, tier_id, teacher_id)
  values ('${G1}', 'G1', '${C1}', '${T1}', '${TE}'), ('${G2}', 'G2 (the paid one)', '${C2}', '${T2}', null);
insert into auth.users values ('${S1}', 's1@x.uz'), ('${S2}', 's2@x.uz'), ('${AD}', 'ad@x.uz'), ('${SA}', 'sa@x.uz'),
  ('${TE}', 'te@x.uz'), ('${N1}', 'n1@x.uz'), ('${N2}', 'n2@x.uz'), ('${N3}', 'n3@x.uz');
insert into public.user_roles (user_id, role) values ('${S1}', 'student'), ('${S2}', 'student'), ('${AD}', 'admin'),
  ('${SA}', 'superadmin'), ('${TE}', 'teacher');
insert into public.profiles (id, email, name, group_id, telegram_id, telegram_username, account_type, instagram_username, created_at)
  values ('${S1}', 's1@x.uz', 'S1', '${G1}', 1001, 's_one', 'provisional', null, now() - interval '30 days'),
         ('${S2}', 's2@x.uz', 'S2', '${G1}', 1002, 's_two', 'paid', 'locked.handle', now() - interval '20 days'),
         ('${AD}', 'ad@x.uz', 'Admin', null, 9001, 'the_admin', 'paid', null, now() - interval '90 days'),
         ('${SA}', 'sa@x.uz', 'Super', null, 9002, 'the_super', 'paid', null, now() - interval '90 days'),
         ('${TE}', 'te@x.uz', 'Teacher', '${G1}', 7001, 'the_teacher', 'paid', null, now() - interval '60 days');
insert into public.test_ig_locked values ('${S2}');
insert into public.platform_settings (key, value) values ('telegram', '{"bot_token": "123:TEST"}');
delete from public.enrollments;
`;

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail !== undefined ? "  -- " + JSON.stringify(detail) : ""}`); }
}
// jsonb does not keep key order: compare canonically (keys sorted at every level).
const canon = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(canon)
  : v && typeof v === "object" ? Object.fromEntries(Object.keys(v as Row).sort().map((k) => [k, canon((v as Row)[k])]))
  : v;
const same = (a: unknown, b: unknown) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
async function q(db: PGlite, sql: string, params: unknown[] = []): Promise<Row[]> {
  return (await db.query(sql, params)).rows as Row[];
}
async function one(db: PGlite, sql: string, params: unknown[] = []): Promise<Row> {
  return (await q(db, sql, params))[0];
}
/** production as of 2026-10-01 04:35 UTC: #222 applied, then #232's handle lock. */
async function liveDb(opts: { beforeLock?: string } = {}): Promise<PGlite> {
  const db = await PGlite.create({ extensions: { citext } });
  await db.exec(SCHEMA);
  await db.exec(PR0);
  if (opts.beforeLock) await db.exec(opts.beforeLock);
  await db.exec(igLockSql());
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
/** Run `sql` in its own transaction as `role` with request.jwt.claims = claims; returns null or the error. */
async function as(db: PGlite, role: string, claims: Row, sql: string, params: unknown[] = []): Promise<{ rows: Row[]; err: Row | null }> {
  try {
    const rows = await db.transaction(async (tx) => {
      await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
      await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [String(claims.sub ?? "")]);
      await tx.exec(`set local role ${role}`);
      return (await tx.query(sql, params)).rows as Row[];
    });
    return { rows, err: null };
  } catch (e) {
    // deno-lint-ignore no-explicit-any
    const x = e as any;
    return { rows: [], err: { code: x?.code, message: String(x?.message ?? e) } };
  }
}
const student = (id: string, email?: string) => ({ sub: id, role: "authenticated", ...(email ? { email } : {}) });
const isGuardRejection = (e: Row | null) => !!e && e.code === "P0001" && String(e.message).includes("faqat admin");
const rejections = async (db: PGlite) =>
  Number((await one(db, "select case when is_called then last_value else 0 end as n from public.profiles_guard_rejections_seq")).n);
const triggers = async (db: PGlite) =>
  (await q(db, `select tgname::text || ' ' || tgtype::text || ' ' || tgenabled::text as t from pg_trigger
                 where tgrelid = 'public.profiles'::regclass and not tgisinternal order by tgname collate "C"`)).map((r) => r.t);
const health = async (db: PGlite) => (await one(db, "select public.profiles_guard_health() h")).h as Row;
const md5s = async (db: PGlite) => Object.fromEntries((await q(db, `
  select proname, md5(replace(prosrc, E'\\r', '')) b, md5(pg_get_functiondef(oid)) d from pg_proc
   where pronamespace = 'public'::regnamespace and proname = any($1)`, [Object.keys(PROD)])).map((r) => [r.proname, { body: r.b, def: r.d }]));
/** One watchdog run: its return, the DMs it sent, the admin_actions rows it wrote, the state after. */
async function watchdog(db: PGlite) {
  const before = Number((await one(db, "select count(*)::int n from public.admin_actions")).n);
  const sentBefore = Number((await one(db, "select coalesce(max(id), 0)::int m from public.ops_calls")).m);
  const ret = (await one(db, "select public.profiles_guard_watchdog() r")).r as Row;
  const sent = await q(db, "select id::int, url, body, headers, purpose from public.ops_calls where id > $1 order by id", [sentBefore]);
  const rows = (await q(db, "select action, details from public.admin_actions order by created_at, id")).slice(before);
  const state = (await one(db, "select value from public.app_settings where key = 'profiles_guard_watchdog_state'")).value as Row;
  return { ret, sent, rows, state, action: state.last_action as string };
}

// ───────────── A. production's shape, and the incident reproduced ─────────────
console.log("A. live fixture + the 2026-09-30 incident");
const db = await liveDb();
{
  const m = await md5s(db);
  for (const [fn, want] of Object.entries(PROD)) {
    ok(`${fn}: body and definition md5 equal production's`, m[fn]?.body === want.body && m[fn]?.def === want.def, { got: m[fn], want });
  }
  ok("profiles trigger set equals production's (name, type, enabled)",
    JSON.stringify(await triggers(db)) === JSON.stringify(LIVE_TRIGGERS_PRE), await triggers(db));
  const h = await health(db);
  ok("REPRODUCED: health says guard_not_last:trg_profiles_zz_ig_handle_lock, key guard_down (the 18:19 alarm)",
    JSON.stringify(h.problems) === JSON.stringify(["guard_not_last:trg_profiles_zz_ig_handle_lock"]) &&
    JSON.stringify(h.keys) === JSON.stringify(["guard_down"]), h);
  const r = await watchdog(db);
  ok("REPRODUCED: the first run alerts both admins and writes one ALARM row", r.action === "alert" && r.sent.length === 2 &&
    r.rows.filter((x) => x.action === "profiles_guard_watchdog_ALARM").length === 1 &&
    JSON.stringify(r.state.notified_keys) === JSON.stringify(["guard_down"]), r);
  ok("REPRODUCED: the false-alarm text claims students can change their group / paid type",
    String(r.sent[0]?.body.text).includes("Talabalar oʻz guruhi"), r.sent[0]?.body.text);
  // The real weak spot: the latch is blind to a REAL outage that arrives during the episode.
  await db.exec("alter table public.profiles disable trigger trg_profiles_zz_column_guard");
  const blind = await watchdog(db);
  ok("REPRODUCED (the blind latch): a REAL outage (guard disabled) during the episode -> 'none', 0 DMs",
    blind.ret.problems.includes("guard_trigger_disabled") && blind.action === "none" && blind.sent.length === 0, blind.ret);
  await db.exec("alter table public.profiles enable trigger trg_profiles_zz_column_guard");
  // The security assessment, on the pre-fix order: the lock fires AFTER the guard but never assigns NEW.
  const r0 = await rejections(db);
  for (const [col, set] of [["account_type", "account_type = 'paid'"], ["group_id", `group_id = '${G2}'`], ["telegram_id", "telegram_id = 555"]]) {
    const x = await as(db, "authenticated", student(S1), `update public.profiles set ${set}, instagram_username = 'new.one' where id = $1`, [S1]);
    ok(`pre-fix: a student's ${col} change is still refused by the guard (the lock never re-opens it)`, isGuardRejection(x.err), x.err);
  }
  ok("pre-fix: each refusal counted", (await rejections(db)) === r0 + 3);
  const locked = await as(db, "authenticated", student(S2), "update public.profiles set instagram_username = 'other' where id = $1", [S2]);
  ok("pre-fix: the lock itself works (a locked student's handle change raises the lock's message)",
    !!locked.err && String(locked.err.message).includes("Instagram profilingizni"), locked.err);
  const absorb = await watchdog(db);
  ok("pre-fix: those refusals are reported as an ALARM row (no DM within 5.5 h of the alert), production's 0 again",
    absorb.ret.rejections_new === 3 && absorb.action === "none" && absorb.rows.length === 1, absorb.ret);
}

// ───────────── B. the migration ─────────────
console.log("B. migration: applies, pinned, atomic, replay-safe");
{
  const before = await q(db, `select proname, coalesce(array_to_string(proacl, ','), '') a, proowner::int o, prosecdef s
                                from pg_proc where proname = any($1) order by proname`,
    [["profiles_guard_health", "profiles_guard_alert_text", "profiles_guard_drift", "challenge_task_ig_handle_guard"]]);
  const preDef = (await one(db, `select pg_get_triggerdef(oid) d from pg_trigger
                                   where tgrelid = 'public.profiles'::regclass and tgname = 'trg_profiles_zz_column_guard'`)).d;
  const err = await applyMigration(db);
  ok("applies on production's definitions (its in-migration self-test passed)", err === null, err);
  ok("profiles trigger set is production's with only the guard renamed",
    JSON.stringify(await triggers(db)) === JSON.stringify(LIVE_TRIGGERS_POST), await triggers(db));
  const postDef = (await one(db, `select pg_get_triggerdef(oid) d from pg_trigger
                                    where tgrelid = 'public.profiles'::regclass and tgname = 'trg_profiles_zzz_column_guard'`)).d;
  ok("pg_get_triggerdef: the pre-image with only the name changed",
    postDef === preDef.replace("trg_profiles_zz_column_guard", "trg_profiles_zzz_column_guard"), { preDef, postDef });
  const lastBefore = (await one(db, `select t.tgname from pg_trigger t where t.tgrelid = 'public.profiles'::regclass
      and not t.tgisinternal and t.tgenabled <> 'D' and (t.tgtype & 1) = 1 and (t.tgtype & 2) = 2
      order by t.tgname collate "C" desc limit 1`)).tgname;
  ok("the guard is now the LAST before-row trigger (after trg_profiles_zz_ig_handle_lock)", lastBefore === "trg_profiles_zzz_column_guard", lastBefore);
  const after = await q(db, `select proname, coalesce(array_to_string(proacl, ','), '') a, proowner::int o, prosecdef s, prosrc
                               from pg_proc where proname = any($1) order by proname`,
    [["profiles_guard_health", "profiles_guard_alert_text", "profiles_guard_drift", "challenge_task_ig_handle_guard"]]);
  ok("4 rewritten functions: owner / ACL / SECURITY DEFINER unchanged, each carries the marker",
    after.length === 4 && after.every((x, i) => x.a === before[i].a && x.o === before[i].o && x.s === before[i].s &&
      x.prosrc.includes("(20261001060000)")), after.map((x) => [x.proname, x.a, x.s]));
  const m = await md5s(db);
  ok("NOT rewritten: the guard, the watchdog and the decision keep production's md5",
    m.profiles_column_guard.body === PROD.profiles_column_guard.body && m.profiles_guard_watchdog.body === PROD.profiles_guard_watchdog.body &&
    m.profiles_guard_alert_decision.body === PROD.profiles_guard_alert_decision.body, m);
  const codeOf = (s: string) => s.split("\n").filter((l) => !/^\s*(--|$)/.test(l)).join("\n");
  const igNow = after.find((x) => x.proname === "challenge_task_ig_handle_guard")!.prosrc as string;
  const igLive = ENGINE.slice(ENGINE.indexOf("$fn$", ENGINE.indexOf("create or replace function public.challenge_task_ig_handle_guard()")) + 4);
  ok("challenge_task_ig_handle_guard: comment-only (code lines byte-identical to production)",
    codeOf(igNow) === codeOf(igLive.slice(0, igLive.indexOf("$fn$;"))) && !igNow.includes("trg_profiles_zz_column_guard"));
  const audit = await q(db, "select details from public.admin_actions where action = 'profiles_guard_trigger_renamed'");
  ok("one audit row: from/to, the four rewrites with md5s, the detector self-test result", audit.length === 1 &&
    audit[0].details.to === "trg_profiles_zzz_column_guard" && Object.keys(audit[0].details.rewrites).length === 4 &&
    audit[0].details.rewrites["public.profiles_guard_health()"].from_md5 === PROD.profiles_guard_health.body &&
    JSON.stringify(audit[0].details.self_test.detector.problems) === JSON.stringify(["guard_not_last:trg_profiles_zzzz_order_selftest"]),
    audit[0]?.details);
  ok("the self-test's throw-away triggers are gone", (await q(db,
    "select 1 from pg_trigger where tgname like '%order_selftest'")).length === 0);
  const h = await health(db);
  ok("health: guard_ok, no problems, no keys", h.guard_ok === true && h.problems.length === 0 && h.keys.length === 0, h);
  for (const fn of ["profiles_guard_health()", "profiles_guard_drift()", "profiles_guard_alert_text(jsonb,text)"]) {
    const p = await one(db, `select has_function_privilege('anon', 'public.${fn}', 'EXECUTE') a,
                                    has_function_privilege('authenticated', 'public.${fn}', 'EXECUTE') b`);
    ok(`${fn}: still closed to anon and authenticated`, p.a === false && p.b === false, p);
  }
  // Replay: the pipeline never re-applies, but a racing deploy can run the file twice.
  const before2 = await q(db, "select proname, prosrc from pg_proc where proname like 'profiles_guard%' order by proname");
  const err2 = await applyMigration(db);
  ok("replay: applies again cleanly", err2 === null, err2);
  const after2 = await q(db, "select proname, prosrc from pg_proc where proname like 'profiles_guard%' order by proname");
  ok("replay: every function unchanged (marker skip), trigger set unchanged, audit row still one",
    JSON.stringify(after2) === JSON.stringify(before2) && JSON.stringify(await triggers(db)) === JSON.stringify(LIVE_TRIGGERS_POST) &&
    (await q(db, "select 1 from public.admin_actions where action = 'profiles_guard_trigger_renamed'")).length === 1);
}
{
  // A drifted live function aborts EVERYTHING (the rename too): pin, don't patch.
  const x = await liveDb();
  const def = (await one(x, "select pg_get_functiondef('public.profiles_guard_health()'::regprocedure) d")).d as string;
  await x.exec(def.replace("-- tgtype bits: ROW 1, BEFORE 2, INSERT 4, UPDATE 16", "-- tgtype bits (edited by hand)"));
  const err = await applyMigration(x);
  ok("pin: a drifted live profiles_guard_health aborts the whole migration", !!err && err.includes("changed since it was verified"), err);
  ok("pin: atomic -- the guard keeps its old name, nothing else changed",
    JSON.stringify(await triggers(x)) === JSON.stringify(LIVE_TRIGGERS_PRE) &&
    (await q(x, "select 1 from public.admin_actions where action = 'profiles_guard_trigger_renamed'")).length === 0);
  await x.close();
}
{
  // The pre-image is checked: a guard trigger that is not the verified shape is not silently "renamed" into a new one.
  const x = await liveDb();
  await x.exec(`drop trigger trg_profiles_zz_column_guard on public.profiles;
                create trigger trg_profiles_zz_column_guard before insert or update of name on public.profiles
                  for each row execute function public.profiles_column_guard();`);
  const err = await applyMigration(x);
  ok("pre-image: a narrowed guard (UPDATE OF name) aborts the rename", !!err && err.includes("is not the shape verified"), err);
  await x.close();
}
{
  // The exactly-once rule (its loop cannot be reached from outside the pin): a doubled anchor counts 2.
  const x = await PGlite.create();
  const n = (await one(x, `select (length(t) - length(replace(t, a, ''))) / length(a) as n from (select $1::text as t, $2::text as a) s`,
    ["  _last_before text;\n  _last_before text;\n", "  _last_before text;\n"])).n;
  ok("exactly-once counting sees a doubled anchor as 2", n === 2, n);
  await x.close();
}

// ───────────── C. the heal ─────────────
console.log("C. heal: the latched episode clears on the next run");
{
  const r = await watchdog(db);
  ok("next run: 'recovered' -- the ✅ DM to both admins, one 'profiles_guard_watchdog_recovered' row",
    r.action === "recovered" && r.sent.length === 2 && r.sent.every((s) => String(s.body.text).startsWith("✅")) &&
    r.rows.length === 1 && r.rows[0].action === "profiles_guard_watchdog_recovered" && r.rows[0].details.decision === "recovered" &&
    r.rows[0].details.dm_attempted === 2, { action: r.action, rows: r.rows.map((x) => x.action), sent: r.sent.length });
  ok("state reset: notified_keys null, keys []", r.state.notified_keys === null && r.ret.keys.length === 0, r.state);
  const r2 = await watchdog(db);
  ok("the run after: 'none', no DM, no row", r2.action === "none" && r2.sent.length === 0 && r2.rows.length === 0, r2.action);
}

// ───────────── D. the renamed guard still blocks self-escalation ─────────────
console.log("D. guard: a student cannot self-escalate; staff and system paths pass and are recorded");
{
  const r0 = await rejections(db);
  for (const [col, set] of [["account_type", "account_type = 'paid'"], ["group_id", `group_id = '${G2}'`],
                            ["telegram_id", "telegram_id = 555"], ["telegram_username", "telegram_username = 'squat'"],
                            ["status", "status = 'inactive'"]]) {
    const x = await as(db, "authenticated", student(S1), `update public.profiles set ${set} where id = $1`, [S1]);
    ok(`student UPDATE of ${col}: refused by the guard (P0001)`, isGuardRejection(x.err), x.err);
  }
  ok("each refusal counted", (await rejections(db)) === r0 + 5);
  const p = await one(db, "select group_id, account_type, telegram_id from public.profiles where id = $1", [S1]);
  ok("the profile is unchanged and no enrollment in the paid course appeared",
    p.group_id === G1 && p.account_type === "provisional" && Number(p.telegram_id) === 1001 &&
    (await q(db, "select 1 from public.enrollments where user_id = $1 and course_id = $2", [S1, C2])).length === 0, p);
  const ins = await as(db, "authenticated", student(N1, "n1@x.uz"),
    "insert into public.profiles (id, email, group_id) values ($1, 'n1@x.uz', $2)", [N1, G2]);
  ok("student INSERT born in a group: refused", isGuardRejection(ins.err), ins.err);
  const own = await as(db, "authenticated", student(S1), "update public.profiles set name = 'Own', preferred_language = 'ru' where id = $1 returning id", [S1]);
  ok("own preferences still save", own.err === null && own.rows.length === 1, own.err);
  const adm = await as(db, "authenticated", student(AD), "update public.profiles set group_id = $2 where id = $1 returning id", [S1, G2]);
  const rec = await q(db, `select details from public.admin_actions where action = 'profile_privileged_change' and target_user_id = $1
                            and details->>'caller' = 'authenticated'`, [S1]);
  ok("admin moves the student: passes, recorded", adm.err === null && adm.rows.length === 1 && rec.length === 1 &&
    rec[0].details.changes.group_id.new === G2, { e: adm.err, rec });
  const svc = await as(db, "service_role", { role: "service_role" }, "update public.profiles set telegram_id = 1111 where id = $1", [S1]);
  const recS = await q(db, `select 1 from public.admin_actions where action = 'profile_privileged_change' and target_user_id = $1
                             and details->>'caller' = 'service_role'`, [S1]);
  ok("service_role (the bot): passes, recorded", svc.err === null && recS.length === 1, svc.err);
  // The Instagram lock now fires BEFORE the guard: still works, and the guard still judges the final row.
  const lk = await as(db, "authenticated", student(S2), "update public.profiles set instagram_username = 'other' where id = $1", [S2]);
  ok("lock: a locked student's handle change is refused (the lock's own message)",
    !!lk.err && String(lk.err.message).includes("Instagram profilingizni"), lk.err);
  const free = await as(db, "authenticated", student(S1), "update public.profiles set instagram_username = '@Free.Handle' where id = $1 returning instagram_username", [S1]);
  ok("lock: an unlocked student's handle change saves, normalised", free.err === null && free.rows[0]?.instagram_username === "free.handle", free);
  const mixed = await as(db, "authenticated", student(S1), "update public.profiles set instagram_username = 'x2', account_type = 'paid' where id = $1", [S1]);
  ok("an unlocked handle + a guarded column in one PATCH: the guard refuses it", isGuardRejection(mixed.err), mixed.err);
  // BY CONSTRUCTION: a "zz_" trigger that rewrites a guarded column now runs BEFORE the guard, which judges its output.
  await db.exec(`create function public.test_escalate() returns trigger language plpgsql as $$
                   begin if current_user::text = 'authenticated' then new.account_type := 'paid'; end if; return new; end $$;
                 create trigger trg_profiles_zz_zz_escalate before update on public.profiles for each row execute function public.test_escalate();`);
  const esc = await as(db, "authenticated", student(S1), "update public.profiles set name = 'Again' where id = $1", [S1]);
  ok("by construction: a 'zz_' trigger rewriting account_type is judged by the guard -> refused", isGuardRejection(esc.err), esc.err);
  ok("... and the detector does not flag it (it fires before the guard)", (await health(db)).problems.length === 0);
  await db.exec("drop trigger trg_profiles_zz_zz_escalate on public.profiles");
}

// ───────────── E. the detector checks the real property ─────────────
console.log("E. detector: later triggers, narrowed guard, per-problem keys, vetting");
{
  await watchdog(db); // settle: clean
  // An UNVETTED later trigger that rewrites a guarded column: the guard is bypassed -- exactly what must alarm.
  await db.exec(`create trigger trg_profiles_zzzz_escalate before update on public.profiles
                   for each row execute function public.test_escalate();`);
  const esc = await as(db, "authenticated", student(S1), "update public.profiles set name = 'Bypass' where id = $1", [S1]);
  const p = await one(db, "select account_type from public.profiles where id = $1", [S1]);
  ok("THE THREAT: a trigger firing after the guard escalates a student to 'paid' unseen by the guard",
    esc.err === null && p.account_type === "paid", { e: esc.err, p });
  const h = await health(db);
  ok("health: guard_not_last:trg_profiles_zzzz_escalate, keys guard_down + guard_down:<problem>",
    JSON.stringify(h.problems) === JSON.stringify(["guard_not_last:trg_profiles_zzzz_escalate"]) &&
    JSON.stringify(h.keys) === JSON.stringify(["guard_down", "guard_down:guard_not_last:trg_profiles_zzzz_escalate"]), h);
  const r = await watchdog(db);
  ok("watchdog: alert, both admins; the drift check ALSO reports the unexplained account_type change",
    r.action === "alert" && r.sent.length === 2 && Number(r.ret.drift.unexplained_users) === 1 &&
    same(r.ret.drift.unexplained, [{ user_id: S1, cols: ["account_type"] }]), r.ret);
  const text = String(r.sent[0]?.body.text);
  ok("the DM says what it is: a trigger AFTER trg_profiles_zzz_column_guard, a bypass only if it rewrites NEW",
    text.includes("(trg_profiles_zzz_column_guard) KEYIN") && text.includes(": trg_profiles_zzzz_escalate.") && text.includes("audit yozuvisiz"), text);
  // A SECOND problem during the latch now alerts at once (it used to wait 23.5 h).
  await db.exec("alter table public.profiles disable trigger trg_profiles_zzz_column_guard");
  const r2 = await watchdog(db);
  ok("a second problem during the episode (guard disabled): NEW key -> alert at once, the 🚨 text",
    r2.action === "alert" && r2.sent.length === 2 && r2.ret.keys.includes("guard_down:guard_trigger_disabled") &&
    String(r2.sent[0].body.text).includes("🚨 Profil himoyasi (trg_profiles_zzz_column_guard) ishlamayapti"), r2.ret.keys);
  const r3 = await watchdog(db);
  ok("same problems next hour: quiet", r3.action === "none" && r3.sent.length === 0);
  await db.exec("alter table public.profiles enable trigger trg_profiles_zzz_column_guard; drop trigger trg_profiles_zzzz_escalate on public.profiles");
  await db.exec(`update public.profiles set account_type = 'provisional' where id = '${S1}'`); // as postgres: recorded
  const r4 = await watchdog(db);
  ok("all clear: recovered", r4.action === "recovered" && r4.sent.length === 2, r4.action);

  // Names outside the convention sort after the guard too ('u' > 't'); only BEFORE ROW INSERT/UPDATE triggers count.
  await db.exec(`create trigger update_profiles_touch before update on public.profiles for each row execute function public.update_updated_at_column();
                 create trigger trg_profiles_zzzz_delete before delete on public.profiles for each row execute function public.update_updated_at_column();
                 create trigger trg_profiles_zzzz_stmt before update on public.profiles for each statement execute function public.update_updated_at_column();
                 create trigger trg_profiles_zzzz_after after update on public.profiles for each row execute function public.test_after_noop();
                 create trigger trg_profiles_zzzz_off before update on public.profiles for each row execute function public.update_updated_at_column();
                 alter table public.profiles disable trigger trg_profiles_zzzz_off;`);
  let hh = await health(db);
  ok("a non-convention later name is flagged; DELETE-only, statement-level, AFTER and disabled ones are not",
    JSON.stringify(hh.problems) === JSON.stringify(["guard_not_last:update_profiles_touch"]), hh.problems);
  await db.exec("alter table public.profiles enable trigger trg_profiles_zzzz_off");
  hh = await health(db);
  ok("enabling the disabled one flags it", hh.problems.includes("guard_not_last:trg_profiles_zzzz_off"), hh.problems);
  await db.exec(`drop trigger update_profiles_touch on public.profiles; drop trigger trg_profiles_zzzz_delete on public.profiles;
                 drop trigger trg_profiles_zzzz_stmt on public.profiles; drop trigger trg_profiles_zzzz_after on public.profiles;
                 drop trigger trg_profiles_zzzz_off on public.profiles;`);

  // The guard's own shape: a column list or a WHEN would let other writes skip it.
  const restore = `drop trigger trg_profiles_zzz_column_guard on public.profiles;
                   create trigger trg_profiles_zzz_column_guard before insert or update on public.profiles
                     for each row execute function public.profiles_column_guard();`;
  await db.exec(`drop trigger trg_profiles_zzz_column_guard on public.profiles;
                 create trigger trg_profiles_zzz_column_guard before insert or update of name on public.profiles
                   for each row execute function public.profiles_column_guard();`);
  hh = await health(db);
  ok("a guard narrowed to UPDATE OF name: 'guard_trigger_narrowed'", hh.problems.includes("guard_trigger_narrowed") &&
    hh.keys.includes("guard_down:guard_trigger_narrowed"), hh.problems);
  await db.exec(`drop trigger trg_profiles_zzz_column_guard on public.profiles;
                 create trigger trg_profiles_zzz_column_guard before insert or update on public.profiles
                   for each row when (new.name is not null) execute function public.profiles_column_guard();`);
  hh = await health(db);
  ok("a guard with a WHEN clause: 'guard_trigger_narrowed'", hh.problems.includes("guard_trigger_narrowed"), hh.problems);
  await db.exec(`create schema evil;
                 create function evil.profiles_column_guard() returns trigger language plpgsql as $$ begin return new; end $$;
                 drop trigger trg_profiles_zzz_column_guard on public.profiles;
                 create trigger trg_profiles_zzz_column_guard before insert or update on public.profiles
                   for each row execute function evil.profiles_column_guard();`);
  hh = await health(db);
  ok("a same-named function in another schema: 'guard_trigger_wrong_function' (checked by oid)",
    hh.problems.includes("guard_trigger_wrong_function"), hh.problems);
  await db.exec(restore + " drop schema evil cascade;");
  await db.exec("alter function public.profiles_column_guard() security definer");
  hh = await health(db);
  ok("a SECURITY DEFINER guard is still flagged", hh.problems.includes("guard_is_security_definer"), hh.problems);
  await db.exec("alter function public.profiles_column_guard() security invoker");
  await db.exec("drop trigger trg_profiles_zzz_column_guard on public.profiles");
  hh = await health(db);
  ok("a dropped guard: 'guard_trigger_missing'", hh.problems.includes("guard_trigger_missing"), hh.problems);
  await db.exec(restore.replace("drop trigger trg_profiles_zzz_column_guard on public.profiles;", ""));
  ok("restored: healthy", (await health(db)).problems.length === 0);
  await watchdog(db); // the narrowed/missing states above were never seen by a run; settle

  // RLS: one key per re-opened policy, so a second one during a latch alerts too.
  await db.exec(`create policy "sneaky a" on public.streaks for insert with check (true)`);
  let w = await watchdog(db);
  ok("one re-opened policy: alert, key rls_drift:streaks/sneaky a/a", w.action === "alert" &&
    w.ret.keys.includes("rls_drift") && w.ret.keys.includes("rls_drift:streaks/sneaky a/a"), w.ret.keys);
  await db.exec(`create policy "sneaky b" on public.quiz_attempts for update using (true)`);
  w = await watchdog(db);
  ok("a SECOND re-opened policy during the latch: alert at once", w.action === "alert" && w.sent.length === 2 &&
    w.ret.keys.includes("rls_drift:quiz_attempts/sneaky b/w"), w.ret.keys);
  await db.exec(`drop policy "sneaky a" on public.streaks; drop policy "sneaky b" on public.quiz_attempts;`);
  w = await watchdog(db);
  ok("cleared: recovered", w.action === "recovered", w.action);

  // VETTING: a later trigger pinned exactly in _vetted is accepted; any change to it re-arms the alarm.
  await db.exec(`create function public.test_raise_only() returns trigger language plpgsql as $$
                   begin if new.name = 'forbidden' then raise exception 'no'; end if; return new; end $$;
                 create trigger trg_profiles_zzzz_vetted before update of name on public.profiles
                   for each row execute function public.test_raise_only();`);
  const pin = (await one(db, `select jsonb_build_object('tgname', t.tgname::text, 'fn', t.tgfoid::regprocedure::text,
      'body_md5', md5(replace(p.prosrc, chr(13), '')), 'prosecdef', p.prosecdef, 'tgtype', t.tgtype::int,
      'tgattr', t.tgattr::text, 'tgqual', coalesce(pg_get_expr(t.tgqual, t.tgrelid), '')) j
      from pg_trigger t join pg_proc p on p.oid = t.tgfoid where t.tgname = 'trg_profiles_zzzz_vetted'`)).j;
  const liveHealth = (await one(db, "select pg_get_functiondef('public.profiles_guard_health()'::regprocedure) d")).d as string;
  ok("health declares an empty _vetted list", liveHealth.includes("  _vetted constant jsonb := '[]';\n"));
  await db.exec(liveHealth.replace("  _vetted constant jsonb := '[]';\n",
    `  _vetted constant jsonb := '${JSON.stringify([pin])}';\n`));
  ok("a later trigger pinned exactly in _vetted is not a problem", (await health(db)).problems.length === 0, await health(db));
  await db.exec(`create or replace function public.test_raise_only() returns trigger language plpgsql as $$
                   begin new.account_type := 'paid'; return new; end $$;`);
  ok("its function body changes -> flagged again (body md5 pin)",
    (await health(db)).problems.includes("guard_not_last:trg_profiles_zzzz_vetted"));
  await db.exec(`create or replace function public.test_raise_only() returns trigger language plpgsql as $$
                   begin if new.name = 'forbidden' then raise exception 'no'; end if; return new; end $$;
                 drop trigger trg_profiles_zzzz_vetted on public.profiles;
                 create trigger trg_profiles_zzzz_vetted before update on public.profiles
                   for each row execute function public.test_raise_only();`);
  ok("its events widen (UPDATE OF name -> UPDATE) -> flagged again (tgtype/tgattr pin)",
    (await health(db)).problems.includes("guard_not_last:trg_profiles_zzzz_vetted"));
  await db.exec("drop trigger trg_profiles_zzzz_vetted on public.profiles");
  await db.exec(liveHealth);
  ok("restored health: healthy", (await health(db)).problems.length === 0);
}

// ───────────── F. drift: a profile born past the guard ─────────────
console.log("F. drift: rows inserted since the last run are compared with what the guard lets a row be born with");
{
  const x = await liveDb(); // #222 seeded the snapshot with every existing profile
  await x.exec(`set session_replication_role = replica;
                insert into public.profiles (id, email, group_id, account_type) values ('${N1}', 'n1@x.uz', '${G2}', 'provisional');
                set session_replication_role = origin;`);
  const blind = (await one(x, "select public.profiles_guard_drift() d")).d as Row;
  ok("BEFORE the fix: a profile inserted past the guard (replica mode) with a paid group is invisible to drift",
    Number(blind.unexplained_users) === 0 && Number(blind.changed_users) === 0, blind);
  const err = await applyMigration(x);
  ok("migration applies", err === null, err);
  await as(x, "service_role", { role: "service_role" },
    "insert into public.profiles (id, email, group_id, telegram_id) values ($1, 'n2@x.uz', $2, 4242)", [N2, G1]);
  await x.exec(`insert into public.profiles (id, email, name) values ('${N3}', 'n3@x.uz', 'Defaults Only')`);
  const d = (await one(x, "select public.profiles_guard_drift() d")).d as Row;
  ok("AFTER: the bypassed row is unexplained (group_id, account_type); the service_role row is explained by its record; " +
    "a defaults-only row is not a change",
    Number(d.unexplained_users) === 1 && same(d.unexplained, [{ user_id: N1, cols: ["account_type", "group_id"] }]) &&
    Number(d.changed_users) === 2, d);
  const w = await watchdog(x);
  ok("the watchdog reports it as an event: ALARM row, the DM names the user and columns",
    w.ret.events === 1 && w.rows.some((r) => r.action === "profiles_guard_watchdog_ALARM") &&
    String(w.sent.at(-1)?.body.text).includes(N1), { events: w.ret.events, rows: w.rows.map((r) => r.action) });
  const again = (await one(x, "select public.profiles_guard_drift() d")).d as Row;
  ok("the snapshot now holds them: reported once", Number(again.unexplained_users) === 0 && Number(again.changed_users) === 0, again);
  await x.close();
}

await db.close();
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) Deno.exit(1);
