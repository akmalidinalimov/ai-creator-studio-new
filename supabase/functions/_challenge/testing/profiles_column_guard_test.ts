// PGlite harness for 20260930120010_profiles_column_guard.sql (PR-0 of the daily-tasks plan).
//
//   deno test -A --no-lock supabase/functions/_challenge/testing/profiles_column_guard_test.ts
//
// Applies the REAL migration file to a real PostgreSQL (PGlite, PG 17) carrying the live shape of
// everything it touches: the anon/authenticated/service_role roles and Supabase's default
// privileges, auth.uid()/role()/jwt() (live bodies), has_role (live body), profiles with its live
// columns, defaults, unique indexes, RLS policies and the four live triggers (normalize_instagram,
// updated_at, sync_group_enrollment, new_student_alert), and the four fan-out tables with their live
// policies. It then acts as a student, an admin, a teacher, service_role and a SECURITY DEFINER
// function, and drives the watchdog end to end with a stub ops_net_post.
//
// CI runs `deno test supabase/functions/` WITHOUT permission flags, and PGlite has to read its
// wasm/data files, so there this test reports as IGNORED (visible, not silently green). Run it locally
// with -A after any change to the migration. TEST INFRASTRUCTURE ONLY: no index.ts here, never deployed.
// PGlite is imported through a non-literal specifier so CI's type-check never downloads it.

// deno-lint-ignore-file no-explicit-any
type Row = Record<string, any>;

const canRead = Deno.permissions.querySync({ name: "read" }).state === "granted";
const canEnv = Deno.permissions.querySync({ name: "env" }).state === "granted";
const MIGRATION_URL = new URL("../../../migrations/20260930120010_profiles_column_guard.sql", import.meta.url);

// Fixture ids.
const G1 = "11111111-1111-1111-1111-111111111111";
const G2 = "22222222-2222-2222-2222-222222222222";
const C1 = "c1c1c1c1-c1c1-c1c1-c1c1-c1c1c1c1c1c1";
const C2 = "c2c2c2c2-c2c2-c2c2-c2c2-c2c2c2c2c2c2";
const T1 = "71717171-7171-7171-7171-717171717171"; // tier of G1
const T2 = "72727272-7272-7272-7272-727272727272"; // tier of G2
const S1 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"; // student in G1 (the migration self-test's pick)
const S2 = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"; // student in G1
const S3 = "dddddddd-dddd-dddd-dddd-dddddddddddd"; // auth user with NO profile yet
const AD = "adadadad-adad-adad-adad-adadadadadad"; // admin
const TE = "7e7e7e7e-7e7e-7e7e-7e7e-7e7e7e7e7e7e"; // teacher

const SCHEMA = `
set timezone = 'Asia/Tashkent';   -- deliberately not UTC: the snapshot values must not depend on it
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant anon, authenticated, service_role to postgres;

-- Supabase's default privileges as production has them (20260926093000 closed functions to PUBLIC).
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
create table public.groups (id uuid primary key, name text, course_id uuid, tier_id uuid);
create table public.enrollments (id uuid primary key default gen_random_uuid(), user_id uuid not null,
  course_id uuid not null, tier_id uuid, enrolled_at timestamptz not null default now(), unique (user_id, course_id));

-- profiles: the live column list, defaults, constraints, unique indexes.
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

-- The four live triggers (live bodies; new_student_alert is a no-op stand-in with the live name).
create function public.update_updated_at_column() returns trigger language plpgsql as $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;
create function public.normalize_instagram_username() returns trigger language plpgsql as $$
declare _v text;
begin
  if new.instagram_username is null then return new; end if;
  begin
    _v := lower(btrim(new.instagram_username::text));
    if _v like '%instagram.com/%' then
      _v := split_part(split_part(_v, 'instagram.com/', 2), '?', 1);
      _v := split_part(_v, '/', 1);
    end if;
    _v := regexp_replace(_v, '^@+', '');
    _v := nullif(btrim(_v), '');
    if _v is not null and _v !~ '^[a-z0-9._]{1,30}$' then
      if tg_op = 'UPDATE' then new.instagram_username := old.instagram_username; return new; end if;
      _v := null;
    end if;
    new.instagram_username := _v::citext;
  exception when others then return new;
  end;
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
create function public.enqueue_new_student_alert() returns trigger language plpgsql security definer as $$
begin return new; end; $$;
create trigger trg_new_student_alert after insert on public.profiles for each row execute function enqueue_new_student_alert();
create trigger trg_profiles_normalize_instagram before insert or update of instagram_username on public.profiles
  for each row execute function normalize_instagram_username();
create trigger trg_profiles_sync_group_enrollment after insert or update of group_id on public.profiles
  for each row when (new.group_id is not null) execute function sync_group_enrollment();
create trigger trg_profiles_updated before update on public.profiles for each row execute function update_updated_at_column();

create table public.admin_actions (id uuid primary key default gen_random_uuid(), actor_user_id uuid,
  action text not null, target_user_id uuid, target_resource_type text, target_resource_id uuid,
  details jsonb not null default '{}'::jsonb, created_at timestamptz not null default now());
alter table public.admin_actions enable row level security;
create policy "admin_actions admin read" on public.admin_actions for select using (has_role(auth.uid(), 'admin'::app_role));
create table public.app_settings (key text primary key, value jsonb, description text, updated_by uuid,
  updated_at timestamptz not null default now());
create table public.platform_settings (key text primary key, value jsonb not null, updated_at timestamptz not null default now());

-- The fan-out tables with their live policies.
create table public.streaks (user_id uuid primary key, current_streak integer default 0, longest_streak integer default 0,
  last_active_date date, freezes_remaining integer default 0);
alter table public.streaks enable row level security;
create policy "streaks own select" on public.streaks for select using ((auth.uid() = user_id) or has_role(auth.uid(), 'admin'::app_role));
create policy "streaks own update" on public.streaks for update using (auth.uid() = user_id);
create policy "streaks own write" on public.streaks for insert with check (auth.uid() = user_id);
create table public.daily_watch_summary (user_id uuid, watch_date date, total_seconds numeric, updated_at timestamptz,
  primary key (user_id, watch_date));
alter table public.daily_watch_summary enable row level security;
create policy "dws own insert" on public.daily_watch_summary for insert with check (auth.uid() = user_id);
create policy "dws own select" on public.daily_watch_summary for select using ((auth.uid() = user_id) or has_role(auth.uid(), 'admin'::app_role));
create policy "dws own update" on public.daily_watch_summary for update using (auth.uid() = user_id);
create table public.homework_submissions (id uuid primary key default gen_random_uuid(), user_id uuid not null,
  assignment_id uuid, score smallint, scored_by uuid, submitted_at timestamptz default now());
alter table public.homework_submissions enable row level security;
create policy "hws admin delete" on public.homework_submissions for delete to authenticated using (has_role(auth.uid(), 'admin'::app_role));
create policy "hws own insert" on public.homework_submissions for insert to authenticated with check (auth.uid() = user_id);
create policy "hws own select" on public.homework_submissions for select using ((auth.uid() = user_id) or has_role(auth.uid(), 'admin'::app_role));
create policy "hws own update" on public.homework_submissions for update
  using (((auth.uid() = user_id) and (score is null)) or has_role(auth.uid(), 'admin'::app_role));
create table public.quiz_attempts (id uuid primary key default gen_random_uuid(), user_id uuid not null, module_id uuid,
  score integer, answers jsonb, completed_at timestamptz default now());
alter table public.quiz_attempts enable row level security;
create policy "quiz_a own all" on public.quiz_attempts
  using ((auth.uid() = user_id) or has_role(auth.uid(), 'admin'::app_role)) with check (auth.uid() = user_id);

-- ops_net_post stand-in: records what the watchdog would have sent.
create table public.ops_calls (id bigserial primary key, url text, body jsonb, headers jsonb, purpose text, at timestamptz default now());
create function public.ops_net_post(p_url text, p_body jsonb, p_headers jsonb default '{}'::jsonb,
  p_purpose text default null, p_timeout_ms integer default 30000) returns bigint language sql as $$
  insert into public.ops_calls (url, body, headers, purpose) values (p_url, p_body, p_headers, p_purpose) returning id $$;

-- Seed.
insert into public.courses values ('${C1}'), ('${C2}');
insert into public.course_tiers values ('${T1}', '${C1}'), ('${T2}', '${C2}');
insert into public.groups values ('${G1}', 'G1', '${C1}', '${T1}'), ('${G2}', 'G2 (the paid one)', '${C2}', '${T2}');
insert into auth.users values ('${S1}', 's1@x.uz'), ('${S2}', 's2@x.uz'), ('${S3}', 's3@x.uz'), ('${AD}', 'ad@x.uz'), ('${TE}', 'te@x.uz');
insert into public.user_roles (user_id, role) values ('${S1}', 'student'), ('${S2}', 'student'), ('${AD}', 'admin'),
  ('${AD}', 'student'), ('${TE}', 'teacher');
insert into public.profiles (id, email, name, group_id, telegram_id, telegram_username, account_type, created_at)
  values ('${S1}', 's1@x.uz', 'S1', '${G1}', 1001, 's_one', 'provisional', now() - interval '30 days'),
         ('${S2}', 's2@x.uz', 'S2', '${G1}', 1002, 's_two', 'paid', now() - interval '20 days'),
         ('${AD}', 'ad@x.uz', 'Admin', null, 9001, 'the_admin', 'paid', now() - interval '90 days'),
         ('${TE}', 'te@x.uz', 'Teacher', '${G1}', 7001, 'the_teacher', 'paid', now() - interval '60 days');
insert into public.platform_settings (key, value) values ('telegram', '{"bot_token": "123:TEST"}');
`;

async function newDb(): Promise<any> {
  const spec = "npm:@electric-sql/pglite@" + "0.5.8";
  const { PGlite } = await import(spec);
  const { citext } = await import(spec + "/contrib/citext");
  const db = await PGlite.create({ extensions: { citext } });
  await db.exec(SCHEMA);
  return db;
}

async function migrationText(): Promise<string> {
  const override = canEnv ? Deno.env.get("PCG_MIGRATION") : undefined;
  return await Deno.readTextFile(override ?? MIGRATION_URL);
}

/** Run `sql` in its own transaction as `role`, with request.jwt.claims = claims. Returns rows. */
async function as(db: any, role: string | null, claims: Row | null, sql: string, params: unknown[] = []): Promise<Row[]> {
  return await db.transaction(async (tx: any) => {
    if (claims) {
      await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
      await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [String(claims.sub ?? "")]);
    }
    if (role) await tx.exec(`set local role ${role}`);
    const r = await tx.query(sql, params);
    return r.rows as Row[];
  });
}

async function err(p: Promise<unknown>): Promise<{ code?: string; message: string } | null> {
  try {
    await p;
    return null;
  } catch (e: any) {
    return { code: e?.code, message: String(e?.message ?? e) };
  }
}

async function one(db: any, sql: string, params: unknown[] = []): Promise<Row> {
  return (await db.query(sql, params)).rows[0] as Row;
}

const student = (id: string, email?: string) => ({ sub: id, role: "authenticated", ...(email ? { email } : {}) });
const rejections = async (db: any) =>
  Number((await one(db, "select case when is_called then last_value else 0 end as n from public.profiles_guard_rejections_seq")).n);

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
// jsonb does not keep key order, so compare canonically (keys sorted at every level).
const canon = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(canon)
  : v && typeof v === "object" && !(v instanceof Date)
    ? Object.fromEntries(Object.keys(v as Row).sort().map((k) => [k, canon((v as Row)[k])]))
    : v;
function eq(a: unknown, b: unknown, msg: string) {
  const [x, y] = [JSON.stringify(canon(a)), JSON.stringify(canon(b))];
  if (x !== y) throw new Error(`${msg}: got ${x}, want ${y}`);
}
function isGuardRejection(e: { code?: string; message: string } | null, msg: string) {
  assert(e, `${msg}: was NOT rejected`);
  assert(e.code === "P0001" && e.message.includes("faqat admin"), `${msg}: wrong error ${JSON.stringify(e)}`);
}

Deno.test({
  name: "profiles_column_guard migration (PGlite)",
  ignore: !canRead,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async (t) => {
    const db = await newDb();
    const MIG = await migrationText();

    await t.step("applies, and its own end-to-end self-test runs (not skipped)", async () => {
      await db.exec(MIG);
      const m = await one(db, "select details from public.admin_actions where action = 'profiles_column_guard_applied'");
      assert(m, "no audit marker");
      eq(m.details.self_test, "ran", "in-migration e2e self-test");
      eq(m.details.self_test_results.rejections_counted >= 5, true, "self-test counted its rejections");
      eq(await rejections(db), 0, "self-test put the rejection counter back");
      eq(Number((await one(db, "select count(*) n from public.admin_actions where action = 'profile_privileged_change'")).n), 0,
        "self-test left no audit rows");
      eq((await one(db, "select status::text s, telegram_write_access_at from public.profiles where id = $1", [S1])),
        { s: "active", telegram_write_access_at: null }, "self-test left the student untouched");
      const job = await one(db, "select schedule, command from cron.job where jobname = 'profiles-guard-watchdog'");
      eq(job?.schedule, "19 * * * *", "cron schedule");
      const st = await one(db, "select value from public.app_settings where key = 'profiles_guard_watchdog_state'");
      eq(st.value.rejections_seen, 0, "state baseline");
      assert(st.value.checked_at, "state seeded with checked_at (keeps the GitHub verifier green)");
    });

    await t.step("replays cleanly (idempotent)", async () => {
      await db.exec(MIG);
      eq(Number((await one(db, "select count(*) n from public.admin_actions where action = 'profiles_column_guard_applied'")).n), 1, "one marker");
      eq(Number((await one(db, "select count(*) n from cron.job where jobname = 'profiles-guard-watchdog'")).n), 1, "one cron job");
      eq(Number((await one(db, "select count(*) n from pg_trigger where tgrelid = 'public.profiles'::regclass and tgname like 'trg_profiles_zz_%'")).n), 2, "two triggers");
      eq(await rejections(db), 0, "replay put the counter back too");
    });

    await t.step("student: own preferences pass, instagram is audited", async () => {
      const r = await as(db, "authenticated", student(S1),
        "update public.profiles set preferred_language = 'ru', name = 'New', instagram_username = '@My.Handle' where id = $1 returning id", [S1]);
      eq(r.length, 1, "student saved own prefs");
      const a = await one(db, "select actor_user_id, details from public.admin_actions where action = 'instagram_handle_changed' and target_user_id = $1", [S1]);
      eq(a?.details?.new, "my.handle", "audit records the NORMALISED handle");
      eq(a?.details?.old, null, "old handle");
      eq(a?.actor_user_id, S1, "actor");
      eq(a?.details?.request_role, "authenticated", "request role");
      // same value again: no second audit row
      await as(db, "authenticated", student(S1), "update public.profiles set instagram_username = 'my.handle' where id = $1", [S1]);
      eq(Number((await one(db, "select count(*) n from public.admin_actions where action = 'instagram_handle_changed'")).n), 1, "no-op handle update not audited");
    });

    await t.step("student: every guarded column is rejected, nothing leaks", async () => {
      const cases: [string, string][] = [
        ["telegram_id", "telegram_id = 555"],
        ["telegram_username", "telegram_username = 'squatted_name'"],
        ["email", "email = 'other@x.uz'"],
        ["group_id", `group_id = '${G2}'`],
        ["status", "status = 'inactive'"],
        ["archived_at", "archived_at = now()"],
        ["account_type", "account_type = 'paid'"],
        ["telegram_write_access_at", "telegram_write_access_at = now()"],
        ["created_at", "created_at = now() - interval '400 days'"],
      ];
      const before = await rejections(db);
      for (const [col, set] of cases) {
        const e = await err(as(db, "authenticated", student(S1), `update public.profiles set ${set} where id = $1`, [S1]));
        isGuardRejection(e, `student ${col}`);
      }
      eq(await rejections(db) - before, cases.length, "each rejection counted (survives the rollback)");
      const p = await one(db, "select group_id, account_type, telegram_id from public.profiles where id = $1", [S1]);
      eq(p, { group_id: G1, account_type: "provisional", telegram_id: 1001 }, "profile unchanged");
      eq(Number((await one(db, "select count(*) n from public.enrollments where user_id = $1 and course_id = $2", [S1, C2])).n), 0,
        "the blocked group change did NOT enroll the student in the paid course");
      // a value that does not change is fine (e.g. a full-row upsert echoing the current values)
      const r = await as(db, "authenticated", student(S1),
        "update public.profiles set account_type = 'provisional', group_id = $2 where id = $1 returning id", [S1, G1]);
      eq(r.length, 1, "unchanged guarded values pass");
      // mixed: an allowed + a guarded column in one PATCH is rejected as a whole
      isGuardRejection(await err(as(db, "authenticated", student(S1),
        "update public.profiles set name = 'Sneaky', account_type = 'paid' where id = $1", [S1])), "mixed patch");
      eq((await one(db, "select name from public.profiles where id = $1", [S1])).name, "New", "mixed patch rolled back whole");
    });

    await t.step("student INSERT: defaults + own email pass; group/foreign email rejected", async () => {
      isGuardRejection(await err(as(db, "authenticated", student(S3, "s3@x.uz"),
        "insert into public.profiles (id, email, group_id) values ($1, 's3@x.uz', $2)", [S3, G2])), "insert with group");
      isGuardRejection(await err(as(db, "authenticated", student(S3, "s3@x.uz"),
        "insert into public.profiles (id, email) values ($1, 'victim@x.uz')", [S3])), "insert with someone else's email");
      isGuardRejection(await err(as(db, "authenticated", student(S3, "s3@x.uz"),
        "insert into public.profiles (id, email, account_type, telegram_username) values ($1, 's3@x.uz', 'paid', 'squat')", [S3])),
        "insert with a username");
      const r = await as(db, "authenticated", student(S3, "s3@x.uz"),
        "insert into public.profiles (id, email, name) values ($1, 'S3@X.uz', 'Three') returning id", [S3]);
      eq(r.length, 1, "self-heal insert with defaults and own email (case-insensitive)");
      const anon = await err(as(db, "anon", null, "insert into public.profiles (id, email, group_id) values (gen_random_uuid(), 'a@x.uz', $1)", [G2]));
      assert(anon, "anon insert must fail");
    });

    await t.step("admin: passes and is recorded; enrollment follows", async () => {
      const r = await as(db, "authenticated", student(AD),
        "update public.profiles set group_id = $2, account_type = 'paid' where id = $1 returning id", [S2, G2]);
      eq(r.length, 1, "admin moved S2");
      eq(Number((await one(db, "select count(*) n from public.enrollments where user_id = $1 and course_id = $2", [S2, C2])).n), 1,
        "sync trigger enrolled S2 in the group's course");
      const a = await one(db, `select actor_user_id, details from public.admin_actions
                               where action = 'profile_privileged_change' and target_user_id = $1 order by created_at desc limit 1`, [S2]);
      eq(a.actor_user_id, AD, "actor is the admin");
      eq(a.details.caller, "authenticated", "caller role");
      eq(a.details.changes.group_id, { old: G1, new: G2 }, "group change recorded");
      eq(Object.keys(a.details.changes), ["group_id"], "only changed columns recorded (account_type was already paid)");
      // the admin can archive
      const r2 = await as(db, "authenticated", student(AD),
        "update public.profiles set status = 'archived', archived_at = now() where id = $1 returning id", [S2]);
      eq(r2.length, 1, "admin archived S2");
      await as(db, "authenticated", student(AD), "update public.profiles set status = 'active', archived_at = null where id = $1", [S2]);
    });

    await t.step("teacher: no admin powers (RLS hides others; own row guarded)", async () => {
      const r = await as(db, "authenticated", student(TE), "update public.profiles set group_id = $2 where id = $1 returning id", [S1, G2]);
      eq(r.length, 0, "teacher cannot touch a student's row (RLS, unchanged)");
      isGuardRejection(await err(as(db, "authenticated", student(TE), "update public.profiles set group_id = $2 where id = $1", [TE, G2])),
        "teacher own group");
      const ok = await as(db, "authenticated", student(TE), "update public.profiles set active_teacher_group_id = $2 where id = $1 returning id", [TE, G1]);
      eq(ok.length, 1, "teacher picks their active group (not guarded)");
    });

    await t.step("SECURITY DEFINER path and service_role pass (and are recorded)", async () => {
      await db.exec(`
        create function public.test_grant_write_access(_u uuid) returns void language sql security definer set search_path to 'public' as $$
          update public.profiles set telegram_write_access_at = now() where id = _u $$;
        grant execute on function public.test_grant_write_access(uuid) to authenticated;`);
      await as(db, "authenticated", student(S1), "select public.test_grant_write_access($1)", [S1]);
      const p = await one(db, "select telegram_write_access_at from public.profiles where id = $1", [S1]);
      assert(p.telegram_write_access_at, "definer path wrote the guarded column");
      const a = await one(db, `select details from public.admin_actions where action = 'profile_privileged_change'
                               and target_user_id = $1 and details->'changes' ? 'telegram_write_access_at'`, [S1]);
      eq(a?.details?.caller, "postgres", "definer caller = owner");
      await as(db, "service_role", { role: "service_role" }, "update public.profiles set telegram_id = 1111 where id = $1", [S1]);
      const b = await one(db, `select details from public.admin_actions where action = 'profile_privileged_change'
                               and target_user_id = $1 and details->'changes' ? 'telegram_id'`, [S1]);
      eq(b?.details?.caller, "service_role", "service_role recorded");
      eq(b?.details?.changes?.telegram_id, { old: 1001, new: 1111 }, "telegram_id change");
    });

    await t.step("helpers are inert when called directly", async () => {
      const before = await rejections(db);
      await as(db, "authenticated", student(S1), "select public.profiles_guard_note_rejection()");
      await as(db, "authenticated", student(S1),
        "select public.profiles_guard_record_change($1, 'update', '{}'::jsonb, 'forged')", [S1]);
      eq(await rejections(db), before, "direct rpc cannot bump the counter");
      eq(Number((await one(db, "select count(*) n from public.admin_actions where details->>'caller' = 'forged'")).n), 0,
        "direct rpc cannot forge an audit row");
      assert(await err(as(db, "authenticated", student(AD), "select public.profiles_guard_health()")), "health is service-only");
      assert(await err(as(db, "authenticated", student(AD), "select public.profiles_guard_watchdog()")), "watchdog is service-only");
      assert(await err(as(db, "authenticated", student(S1), "select nextval('public.profiles_guard_rejections_seq')")), "sequence is private");
      assert(await err(as(db, "authenticated", student(S1), "select * from public.profiles_guard_snapshot")), "snapshot is private");
    });

    await t.step("fan-out: students can no longer mint streaks, watch days, graded homework or quiz scores", async () => {
      await db.exec(`insert into public.streaks (user_id, current_streak, last_active_date) values ('${S1}', 3, current_date);
                     insert into public.quiz_attempts (user_id, score) values ('${S1}', 40);`);
      assert(await err(as(db, "authenticated", student(S2), "insert into public.streaks (user_id, current_streak) values ($1, 30)", [S2])), "streak insert");
      eq((await as(db, "authenticated", student(S1), "update public.streaks set current_streak = 30 where user_id = $1 returning 1", [S1])).length, 0, "streak update");
      assert(await err(as(db, "authenticated", student(S1),
        "insert into public.daily_watch_summary (user_id, watch_date, total_seconds) values ($1, '2020-01-01', 999)", [S1])), "dws insert");
      assert(await err(as(db, "authenticated", student(S1),
        "insert into public.homework_submissions (user_id, score, scored_by) values ($1, 10, $1)", [S1])), "self-graded homework insert");
      assert(await err(as(db, "authenticated", student(S1), "insert into public.quiz_attempts (user_id, score) values ($1, 100)", [S1])), "quiz insert");
      eq((await as(db, "authenticated", student(S1), "update public.quiz_attempts set score = 100 where user_id = $1 returning 1", [S1])).length, 0, "quiz update");
      eq((await as(db, "authenticated", student(S1), "select score from public.quiz_attempts where user_id = $1", [S1])).map((r) => r.score), [40], "quiz read still works");
      eq((await as(db, "authenticated", student(S1), "select current_streak from public.streaks where user_id = $1", [S1])).map((r) => r.current_streak), [3], "streak read still works");
    });

    await t.step("watchdog: rejections alarm, then quiet; kill-switch", async () => {
      await db.exec("insert into public.app_settings (key, value) values ('x', '{}')"); // unrelated row
      const r1 = await one(db, "select public.profiles_guard_watchdog() r");
      assert(Number(r1.r.rejections_new) >= 13, `rejections seen: ${JSON.stringify(r1.r)}`);
      eq(r1.r.keys, [], "no persistent keys");
      const dm = await one(db, "select count(*) n, max(body->>'text') t, max(url) u from public.ops_calls where purpose = 'profiles_guard_watchdog'");
      eq(Number(dm.n), 1, "one admin DM");
      assert(String(dm.t).includes("rad etildi"), "DM explains the rejections");
      eq(String(dm.u), "https://api.telegram.org/bot123:TEST/sendMessage", "DM goes to Telegram through ops_net_post");
      eq(Number((await one(db, "select count(*) n from public.admin_actions where action = 'profiles_guard_watchdog_ALARM'")).n), 1, "ALARM row");
      const r2 = await one(db, "select public.profiles_guard_watchdog() r");
      eq(Number(r2.r.events), 0, "no new events");
      eq(Number((await one(db, "select count(*) n from public.ops_calls")).n), 1, "no second DM");
      const st = await one(db, "select value from public.app_settings where key = 'profiles_guard_watchdog_state'");
      eq(st.value.last_action, "none", "quiet");
      // explained changes (admin, definer, service_role above) are not drift
      eq(Number(r2.r.drift.unexplained_users), 0, "audited changes are not drift");
    });

    await t.step("watchdog: a bypassed change is drift; an admin change is not", async () => {
      await db.exec(`set session_replication_role = replica;
                     update public.profiles set account_type = 'paid' where id = '${S1}';
                     set session_replication_role = origin;`);
      await as(db, "authenticated", student(AD), "update public.profiles set telegram_id = 2002 where id = $1", [S2]);
      await db.exec("update public.app_settings set value = value || '{\"last_alert_ms\": 0}' where key = 'profiles_guard_watchdog_state'");
      const r = await one(db, "select public.profiles_guard_watchdog() r");
      eq(Number(r.r.drift.unexplained_users), 1, "one unexplained profile");
      eq(r.r.drift.unexplained, [{ user_id: S1, cols: ["account_type"] }], "names the user and column");
      eq(Number(r.r.drift.changed_users), 2, "the admin change is seen and explained");
      const t = (await one(db, "select body->>'text' t from public.ops_calls order by id desc limit 1")).t;
      assert(String(t).includes(S1) && String(t).includes("account_type"), "DM names the drift");
      const again = await one(db, "select public.profiles_guard_watchdog() r");
      eq(Number(again.r.drift.unexplained_users), 0, "snapshot refreshed: drift reported once");
    });

    await t.step("watchdog: guard disabled / not last / rls drift alarm, then recover", async () => {
      await db.exec("alter table public.profiles disable trigger trg_profiles_zz_column_guard");
      const before = Number((await one(db, "select count(*) n from public.ops_calls")).n);
      const r = await one(db, "select public.profiles_guard_watchdog() r");
      eq(r.r.keys, ["guard_down"], "guard_down");
      assert(r.r.problems.includes("guard_trigger_disabled"), "problem named");
      eq(Number((await one(db, "select count(*) n from public.ops_calls")).n), before + 1, "alerted");
      const r2 = await one(db, "select public.profiles_guard_watchdog() r");
      eq(r2.r.keys, ["guard_down"], "still down");
      eq(Number((await one(db, "select count(*) n from public.ops_calls")).n), before + 1, "no repeat within 24 h");
      await db.exec("alter table public.profiles enable trigger trg_profiles_zz_column_guard");
      await db.exec(`create function public.evil() returns trigger language plpgsql as $$ begin return new; end $$;
                     create trigger trg_profiles_zzz_evil before update on public.profiles for each row execute function public.evil();
                     create policy "sneaky" on public.streaks for insert with check (true);`);
      const r3 = await one(db, "select public.profiles_guard_health() r");
      assert(r3.r.problems.includes("guard_not_last:trg_profiles_zzz_evil"), `guard_not_last: ${JSON.stringify(r3.r.problems)}`);
      eq(r3.r.keys, ["guard_down", "rls_drift"], "rls drift");
      await db.exec(`drop trigger trg_profiles_zzz_evil on public.profiles; drop policy "sneaky" on public.streaks;`);
      const r4 = await one(db, "select public.profiles_guard_watchdog() r");
      eq(r4.r.keys, [], "clear");
      const last = (await one(db, "select body->>'text' t from public.ops_calls order by id desc limit 1")).t;
      assert(String(last).startsWith("✅"), `recovered DM: ${last}`);
      eq(Number((await one(db, "select count(*) n from public.admin_actions where action = 'profiles_guard_watchdog_recovered'")).n), 1, "recovered row");
    });

    await t.step("watchdog: a SECURITY DEFINER guard is flagged", async () => {
      await db.exec("alter function public.profiles_column_guard() security definer");
      const r = await one(db, "select public.profiles_guard_health() r");
      assert(r.r.problems.includes("guard_is_security_definer"), "definer guard flagged");
      await db.exec("alter function public.profiles_column_guard() security invoker");
    });

    await t.step("an FK action (group deleted -> SET NULL) passes as the owner, recorded, not drift", async () => {
      await db.exec(`insert into public.groups values ('33333333-3333-3333-3333-333333333333', 'G3 (to delete)', '${C1}', '${T1}');`);
      await as(db, "authenticated", student(AD), "update public.profiles set group_id = '33333333-3333-3333-3333-333333333333' where id = $1", [S2]);
      await db.exec("select public.profiles_guard_watchdog()");   // snapshot now holds G3
      await db.exec("delete from public.groups where id = '33333333-3333-3333-3333-333333333333'");
      eq((await one(db, "select group_id from public.profiles where id = $1", [S2])).group_id, null, "SET NULL applied");
      const a = await one(db, `select details from public.admin_actions where action = 'profile_privileged_change'
                               and target_user_id = $1 and details->'changes'->'group_id'->>'new' is null
                               and details->'changes' ? 'group_id'`, [S2]);
      eq(a?.details?.caller, "postgres", "FK action recorded, as the table owner");
      const r = await one(db, "select public.profiles_guard_watchdog() r");
      eq(Number(r.r.drift.unexplained_users), 0, "FK action is not drift");
    });

    await t.step("the snapshot does not depend on the session TimeZone", async () => {
      await db.exec("select public.profiles_guard_watchdog()");
      await db.exec("set timezone = 'America/Los_Angeles'");
      const r = await one(db, "select public.profiles_guard_drift() r");
      eq(Number(r.r.changed_users), 0, "no phantom changes after a TimeZone switch");
      await db.exec("set timezone = 'Asia/Tashkent'");
    });

    await t.step("watchdog kill-switch stamps checked_at and sends nothing", async () => {
      await db.exec("update public.platform_settings set value = '{\"enabled\": false}' where key = 'profiles_guard_watchdog'");
      const before = Number((await one(db, "select count(*) n from public.ops_calls")).n);
      await as(db, "authenticated", student(S2), "update public.profiles set telegram_id = 4 where id = $1", [S2]).catch(() => {});
      const r = await one(db, "select public.profiles_guard_watchdog() r");
      eq(r.r.disabled, true, "disabled");
      eq(Number((await one(db, "select count(*) n from public.ops_calls")).n), before, "nothing sent");
      const st = await one(db, "select value from public.app_settings where key = 'profiles_guard_watchdog_state'");
      eq(st.value.last_action, "disabled", "state");
      eq(Number((await one(db, "select count(*) n from public.admin_actions where action = 'profiles_guard_watchdog_disabled'")).n), 1, "one disabled row");
      await db.exec("update public.platform_settings set value = '{\"enabled\": true}' where key = 'profiles_guard_watchdog'");
      const r2 = await one(db, "select public.profiles_guard_watchdog() r");
      eq(Number(r2.r.rejections_new), 1, "the rejection during the pause is reported after it");
    });

    await db.close();
  },
});
