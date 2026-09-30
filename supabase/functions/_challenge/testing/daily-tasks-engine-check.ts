// PGlite harness for 20260930150000_challenge_daily_tasks_engine.sql (Daily Tasks PR-3: the SQL engine).
//
//   deno test -A --node-modules-dir=none --no-lock supabase/functions/_challenge/testing/daily-tasks-engine-check.ts
//
// Builds production's state on a real PostgreSQL (PGlite, PG 17): the live reconcilers, #218 (20260930100010),
// PR-1 (20260930121000: the four seeded «KUNLIK VAZIFALAR» topics), PR-2 (20260930122010: the calendar) and the LIVE
// xp_award_integrity_watchdog (md5-verified fixture) -- then applies THIS migration and proves, end to end:
//   inertness (enabled=false: no row, no award, no send, heartbeats only) and replay; the pinned rewrite; grants;
//   routing by (chat, thread) incl. two groups sharing thread 10; every sender outcome (anonymous, bot, staff,
//   unknown + shaped, username_match, held no_group / out_of_scope / inactive with once-a-day signals, wrong_group,
//   voided); option-1 ATTRIBUTION (today, missed, reply-to-post incl. a MANUAL post, album, burst, fix-up, back-burst
//   adoption of a text-first comment, the C18 comment rule both directions, reply to own receipt, closed, before
//   open, daily cap, attempts exhausted, IG affinity / share link / handle, image reuse, text-only held while ai=false);
//   LATE points (ceil half, closed after 2 days); STREAK (+10 per 5 on-time task days, rest days skipped, late breaks);
//   the FREEZE rule; CORRECTIONS (move, merge, future refused, withdraw / restore / slot taken, owner lock + admin
//   override, max moves); pause -> resume re-derivation; held -> fixed -> captured; RACE SAFETY (duplicate from bot +
//   reconciler, a racing live-slot insert, settle / reconcile idempotent, one bad message never blocks the batch);
//   edits; legacy swap; Mini App claim-time lateness + idempotency + heal; reassign_user; AI claim / record (general,
//   instagram handle / recency / stale), fail-open; expire; health invariants + the watchdog (rest day silent, task-day
//   alarm DM'd once with Content-Type, bot status); guard v2; the handle lock; backfill (retro task, no_slot re-open,
//   receipts suppressed, summary outbox, unresolved report).
// Run it after ANY change to the migration and before asking for the migration-approved label.
// MIG_PATH=<file> tests a draft before it is written into its (edit-guarded) slot.
//
// CI NOTE: named *-check.ts, not *_test.ts, so CI's `deno test supabase/functions/` never collects it (the sibling
// harnesses' convention: collecting a PGlite harness failed #220's CI with "Could not find @types/node"). Run it by
// path as above. The migration ALSO self-tests its pure functions at apply time.
// TEST INFRASTRUCTURE ONLY: this directory has no index.ts, so it is never deployed.

// deno-lint-ignore-file no-explicit-any
type Row = Record<string, any>;
interface PG {
  query(sql: string, params?: unknown[]): Promise<{ rows: Row[] }>;
  exec(sql: string): Promise<unknown>;
  close(): Promise<void>;
}

// ── the fixture world: a VERBATIM copy of daily-tasks-calendar-check.ts (PR-2) lines 36-240 (itself PR-1's world) ──
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

// What PR-3 adds to the world: the profile columns PR-0 created, the webhook_inbox columns the bot fills, a student
// row policy (to prove the handle lock through RLS), 40 more G1 students, two groups that share thread 10 (5- and
// 6-GURUH), and the LIVE xp_award_integrity_watchdog with its production ACL.
const ST = (n: number) => `aaaaaaaa-0000-0000-0001-${String(n).padStart(12, "0")}`;
const TG = (n: number) => 2000 + n;
const G9 = "99999999-0000-0000-0000-000000000009", G10 = "99999999-0000-0000-0000-000000000010";
const CH9 = -1004396568866, CH10 = -1004423411304;
const S7 = U(20), S8 = U(21), IU = U(22), Y1 = U(23), Y2 = U(24);
const ENGINE_EXTRA = `
create extension if not exists citext;
alter table public.profiles add column name text, add column telegram_username citext, add column instagram_username citext,
  add column account_type text not null default 'paid', add column telegram_write_access_at timestamptz;
alter table public.webhook_inbox add column message_thread_id bigint, add column from_user_id bigint, add column chat_type text;
insert into auth.users select ('aaaaaaaa-0000-0000-0001-' || lpad(n::text, 12, '0'))::uuid from generate_series(1, 60) n;
insert into auth.users values ('${S7}'), ('${S8}'), ('${IU}'), ('${Y1}'), ('${Y2}');
insert into public.profiles (id, group_id, telegram_id, name)
  select ('aaaaaaaa-0000-0000-0001-' || lpad(n::text, 12, '0'))::uuid, '${G1}', 2000 + n, 'Student ' || n from generate_series(1, 60) n;
insert into public.profiles (id, group_id, telegram_id, name, status, archived_at, telegram_username) values
  ('${S7}', null, 1020, 'No group', 'active', null, null),
  ('${S8}', '${G1}', 1021, 'Archived', 'archived', now() - interval '3 days', null),
  ('${IU}', '${G1}', null, 'Intake kid', 'active', null, 'intake_kid'),
  ('${Y1}', '${G9}', 1061, 'Five', 'active', null, null),
  ('${Y2}', '${G10}', 1062, 'Six', 'active', null, null);
alter table public.profiles enable row level security;
create policy "profiles own or admin" on public.profiles for all to authenticated
  using (id = auth.uid() or public.has_role(auth.uid(), 'admin')) with check (id = auth.uid() or public.has_role(auth.uid(), 'admin'));
grant select, update on public.profiles to authenticated;
grant usage on schema public to authenticated, anon, service_role;
`;
// After PR-1 (the daily_task_* columns and their trigger): 5- and 6-GURUH, both with daily topic thread 10 (#221).
const AFTER_PR1 = `
insert into public.groups (id, name, course_id, homework_topic_url, daily_task_topic_url) values
  ('${G9}', 'AC CHALLENGE | 5-GURUH', '${C6}', 'https://t.me/c/4396568866/4', 'https://t.me/c/4396568866/10'),
  ('${G10}', 'AC CHALLANGE | 6-GURUH', '${C6}', 'https://t.me/c/4423411304/6', 'https://t.me/c/4423411304/10');
`;

Deno.test({
  name: CAN_RUN
    ? "daily_tasks_engine: 20260930150000 on PGlite (#218 + PR-1 + PR-2 + engine; attribution, late, streak, corrections, races)"
    : "daily_tasks_engine: SKIPPED -- needs `deno test -A --node-modules-dir=none` (PGlite reads its own files)",
  ignore: !CAN_RUN,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: run,
});

async function run() {
  const spec = "npm:@electric-sql/pglite@0.5.8"; // non-literal: never resolved or type-checked unless this runs
  const { PGlite } = (await import(spec)) as any;
  const { citext } = (await import(spec + "/contrib/citext")) as any;

  const MIG_PATH = Deno.env.get("MIG_PATH");
  const MIG = lf(await Deno.readTextFile(MIG_PATH ?? here("../../../migrations/20260930150000_challenge_daily_tasks_engine.sql")));
  const PR2 = lf(await Deno.readTextFile(here("../../../migrations/20260930122010_challenge_daily_tasks_calendar.sql")));
  const PR1 = lf(await Deno.readTextFile(here("../../../migrations/20260930121000_challenge_daily_task_topic.sql")));
  const MIG218 = lf(await Deno.readTextFile(here("../../../migrations/20260930100010_challenge_social_points.sql")));
  const RCX_LIVE = lf(await Deno.readTextFile(here("./reconcile_challenge_xp.live-2026-09-30.sql")));
  const COMMUNITY_LIVE = lf(await Deno.readTextFile(here("./reconcile_community_xp.live-2026-09-30.sql")));
  const INTEGRITY_LIVE = lf(await Deno.readTextFile(here("./xp_award_integrity_watchdog.live-2026-09-30.sql")));

  let pass = 0, fail = 0;
  const ok = (name: string, cond: boolean, detail?: unknown) => {
    if (cond) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}${detail !== undefined ? "  — " + JSON.stringify(detail) : ""}`); }
  };
  const q = async (db: PG, sql: string, params: unknown[] = []): Promise<Row[]> => (await db.query(sql, params)).rows;
  const one = async (db: PG, sql: string, params: unknown[] = []): Promise<Row> => (await q(db, sql, params))[0];
  const tx = async (db: PG, sql: string): Promise<string | null> => {
    try { await db.exec("begin;\n" + sql + "\ncommit;"); return null; }
    catch (e) { try { await db.exec("rollback;"); } catch { /* none open */ } return String((e as Error).message); }
  };

  async function freshDb(opts: { withPr2?: boolean } = {}): Promise<PG> {
    const db: PG = await PGlite.create({ extensions: { citext } });
    await db.exec(SCHEMA);
    await db.exec(EXTRA);
    await db.exec(ENGINE_EXTRA);
    await db.exec(COMMUNITY_LIVE + ";\nrevoke execute on function public.reconcile_community_xp(timestamptz) from public;\n" +
      "grant execute on function public.reconcile_community_xp(timestamptz) to service_role;");
    await db.exec(RCX_LIVE + ";\nrevoke execute on function public.reconcile_challenge_xp(timestamptz) from public;\n" +
      "grant execute on function public.reconcile_challenge_xp(timestamptz) to service_role;");
    await db.exec(INTEGRITY_LIVE + ";\nrevoke execute on function public.xp_award_integrity_watchdog() from public;\n" +
      "grant execute on function public.xp_award_integrity_watchdog() to service_role;");
    for (const [name, sql] of [["#218", MIG218], ["PR-1", PR1], ...(opts.withPr2 === false ? [] : [["PR-2", PR2]])]) {
      const e = await tx(db, sql);
      if (e) throw new Error(`${name} did not apply: ${e}`);
      if (name === "PR-1") await db.exec(AFTER_PR1);
    }
    return db;
  }

  async function as<T = Row[]>(db: PG, uid: string | null, sql: string, params: unknown[] = [], role = "authenticated"):
    Promise<{ rows: T | null; err: string | null }> {
    await db.exec(`select set_config('request.jwt.claim.sub', '${uid ?? ""}', false)`);
    await db.exec(`set role ${role}`);
    try { return { rows: (await db.query(sql, params)).rows as unknown as T, err: null }; }
    catch (e) { return { rows: null, err: String((e as Error).message) }; }
    finally { await db.exec("reset role"); await db.exec("select set_config('request.jwt.claim.sub', '', false)"); }
  }

  // ── Telegram message builder: Tashkent local times; a topic post with no explicit reply "replies" to the
  //    topic-creation message (the forum-topic reply farm), exactly as production payloads do ──
  const epoch = (local: string) => Math.floor(Date.parse(local + "+05:00") / 1000);
  let nextId = 20000;
  type M = Record<string, any>;
  const tgm = (o: {
    chat?: number; thread?: number; from?: number | null; username?: string; at: string; text?: string; caption?: string;
    photo?: string; doc?: { mime: string; id: string; thumb?: boolean }; voice?: { dur: number; id: string };
    replyTo?: { id: number; from?: number; isBot?: boolean; anon?: boolean }; mgid?: string; fwdFrom?: number; id?: number;
    senderChat?: boolean; isBot?: boolean;
  }): M => {
    const chat = o.chat ?? CH1, thread = o.thread ?? D1;
    const m: M = { message_id: o.id ?? nextId++, date: epoch(o.at), chat: { id: chat, type: "supergroup", is_forum: true },
                   message_thread_id: thread, is_topic_message: true };
    if (o.from !== null) m.from = { id: o.from ?? 1001, is_bot: !!o.isBot, first_name: "X", ...(o.username ? { username: o.username } : {}) };
    if (o.senderChat) m.sender_chat = { id: chat, type: "supergroup" };
    if (o.text !== undefined) m.text = o.text;
    if (o.caption !== undefined) m.caption = o.caption;
    if (o.photo) m.photo = [{ file_unique_id: o.photo + "_s" }, { file_unique_id: o.photo }];
    if (o.doc) m.document = { mime_type: o.doc.mime, file_unique_id: o.doc.id, ...(o.doc.thumb ? { thumbnail: {} } : {}) };
    if (o.voice) m.voice = { duration: o.voice.dur, file_unique_id: o.voice.id };
    if (o.mgid) m.media_group_id = o.mgid;
    if (o.fwdFrom) m.forward_origin = { type: "user", sender_user: { id: o.fwdFrom } };
    m.reply_to_message = o.replyTo
      ? { message_id: o.replyTo.id, ...(o.replyTo.anon ? { sender_chat: { id: chat } } : {}),
          from: { id: o.replyTo.from ?? 1, is_bot: !!o.replyTo.isBot } }
      : { message_id: thread, message_thread_id: thread, forum_topic_created: { name: "KUNLIK VAZIFALAR" } };
    return m;
  };
  const T25 = "Mana bugungi vazifam, ko'ring!";           // 30 characters: satisfies min_text_chars 20
  const cap = async (db: PG, m: M, src = "topic", opts: M = {}) =>
    (await one(db, "select challenge_task_capture($1::jsonb, $2, $3::jsonb) r", [JSON.stringify(m), src, JSON.stringify(opts)])).r as Row;
  let upd = 1;
  const inbox = async (db: PG, m: M, received = "now()") =>
    await db.query(`insert into webhook_inbox (received_at, update_type, chat_id, message_id, message_thread_id, from_user_id, chat_type, raw_update)
                    values (${received}, 'message', $1, $2, $3, $4, 'supergroup', $5::jsonb)`,
      [m.chat.id, m.message_id, m.message_thread_id ?? null, m.from?.id ?? null, JSON.stringify({ update_id: upd++, message: m })]);
  const subOf = async (db: PG, user: string, task: number) =>
    await one(db, "select * from challenge_task_submissions where user_id = $1 and task_id = $2 order by id desc limit 1", [user, task]);
  const liveOf = async (db: PG, user: string, task: number) =>
    await one(db, "select * from challenge_task_submissions where user_id = $1 and task_id = $2 and status in ('needs_more','checking','accepted')", [user, task]);
  const xpOf = async (db: PG, user: string, ref: string) =>
    await one(db, "select amount, created_at from xp_events where user_id = $1 and ref_key = $2", [user, ref]);
  const rowOf = async (db: PG, chat: number, id: number) =>
    await one(db, "select * from challenge_task_messages where chat_id = $1 and message_id = $2", [chat, id]);
  const count = async (db: PG, sql: string, params: unknown[] = []) => Number((await one(db, sql, params)).n);
  const cfgSet = async (db: PG, path: string, value: unknown) =>
    await db.query(`update platform_settings set value = jsonb_set(value, $1::text[], $2::jsonb) where key = 'challenge_tasks'`,
      [`{${path}}`, JSON.stringify(value)]);
  const reconcile = async (db: PG, at?: string) =>
    (await one(db, at ? "select reconcile_challenge_tasks(null, $1::timestamptz) r" : "select reconcile_challenge_tasks() r", at ? [at] : [])).r as Row;
  const userXpOk = async (db: PG) => (await count(db, `select count(*) n from user_xp x
    where x.total_xp <> coalesce((select sum(amount) from xp_events e where e.user_id = x.user_id), 0)`)) === 0;

  // ───────────── P. prerequisites ─────────────
  console.log("P. refuses to run before PR-2");
  {
    const d0 = await freshDb({ withPr2: false });
    const e = await tx(d0, MIG);
    ok("P1 without 20260930122010 the file aborts with a clear message", !!e && e.includes("ABORT: 20260930122010"), e);
    ok("P2 ...and leaves nothing behind", (await one(d0, "select to_regclass('public.challenge_task_submissions') r")).r === null);
    await d0.close();
  }

  // ───────────── M. apply, replay, audit ─────────────
  console.log("M. migration: applies (self-test included), audit once, replay");
  const db = await freshDb();
  const integrityBefore = await one(db, `select coalesce(array_to_string(proacl, ','), '') acl, proowner, prosecdef
                                           from pg_proc where oid = 'public.xp_award_integrity_watchdog()'::regprocedure`);
  {
    const e = await tx(db, MIG);
    ok("M1 applies (including its self-test)", e === null, e);
    if (e !== null) throw new Error(`daily_tasks_engine: the migration did not apply -- ${e}`);
    ok("M2 one audit row", await count(db, "select count(*) n from admin_actions where action = 'challenge_tasks_engine_applied'") === 1);
    const e2 = await tx(db, MIG);
    ok("M3 replay is a clean no-op", e2 === null, e2);
    ok("M4 replay: still one audit row", await count(db, "select count(*) n from admin_actions where action = 'challenge_tasks_engine_applied'") === 1);
    const jobs = await q(db, "select jobname, schedule, command from cron.job where jobname like 'challenge-tasks%' order by 1");
    ok("M5 exactly two cron jobs: reconcile 4-59/10 and watchdog :47",
      JSON.stringify(jobs.map((j) => [j.jobname, j.schedule])) ===
        JSON.stringify([["challenge-tasks-reconcile", "4-59/10 * * * *"], ["challenge-tasks-watchdog", "47 * * * *"]]), jobs);
    ok("M6 no outbound call was made", await count(db, "select count(*) n from ops_net_calls") === 0);
    ok("M7 the config stays inert (enabled / ai / miniapp false)",
      (await one(db, "select challenge_tasks_config() c")).c.enabled === false &&
      (await one(db, "select challenge_tasks_config() c")).c.ai === false && (await one(db, "select challenge_tasks_config() c")).c.miniapp === false);
    ok("M8 the config parses clean", (await one(db, "select jsonb_array_length(challenge_tasks_config()->'invalid') n")).n === 0);
  }

  // ───────────── W. the pinned rewrite ─────────────
  console.log("W. xp_award_integrity_watchdog pinned rewrite");
  {
    const src = (await one(db, "select prosrc, md5(replace(prosrc, E'\\r', '')) m, coalesce(array_to_string(proacl, ','), '') acl, proowner, prosecdef from pg_proc where oid = 'public.xp_award_integrity_watchdog()'::regprocedure"));
    console.log(`     (rewritten md5 = ${src.m})`);
    ok("W1 the four reasons are now unverifiable_by_design",
      ["'challenge_chat'", "'challenge_answer'", "'challenge_task'", "'challenge_task_streak'"].every((k) => src.prosrc.includes(k)));
    ok("W2 owner, ACL and SECURITY DEFINER unchanged",
      src.acl === integrityBefore.acl && src.proowner === integrityBefore.proowner && src.prosecdef === integrityBefore.prosecdef, [src.acl, integrityBefore.acl]);
    ok("W3 nothing else changed: the rewrite is the anchor alone",
      src.prosrc.replace(/,\n {6}-- 20260930150000[^\n]*\n {6}'challenge_chat','challenge_answer','challenge_task','challenge_task_streak'\)/, ")") ===
        INTEGRITY_LIVE.slice(INTEGRITY_LIVE.indexOf("AS $function$") + 13, INTEGRITY_LIVE.lastIndexOf("$function$")));
    const d2 = await freshDb();
    await d2.exec("create or replace function public.xp_award_integrity_watchdog() returns jsonb language plpgsql security definer as $$ begin return '{}'; end $$;");
    const e = await tx(d2, MIG);
    ok("W4 a drifted live body aborts the whole file (md5 pin)", !!e && e.includes("xp_award_integrity_watchdog changed since it was verified"), e);
    await d2.close();
  }

  // ───────────── G. grants ─────────────
  console.log("G. grants");
  {
    const priv = async (role: string, fn: string) => (await one(db, "select has_function_privilege($1, $2, 'EXECUTE') v", [role, fn])).v as boolean;
    ok("G1 anon and authenticated cannot capture; service_role can",
      !(await priv("anon", "public.challenge_task_capture(jsonb,text,jsonb)")) && !(await priv("authenticated", "public.challenge_task_capture(jsonb,text,jsonb)")) &&
      (await priv("service_role", "public.challenge_task_capture(jsonb,text,jsonb)")));
    let svcOnly = true;
    for (const f of ["public.reconcile_challenge_tasks(timestamptz,timestamptz)", "public.challenge_tasks_backfill(timestamptz,timestamptz)",
                     "public.challenge_task_settle_ut(uuid,bigint,jsonb)", "public.challenge_task_reassign_user(uuid,uuid)",
                     "public.challenge_tasks_watchdog(timestamptz)", "public.challenge_task_check_record(bigint,uuid,integer,jsonb,jsonb)"]) {
      if ((await priv("authenticated", f)) || (await priv("anon", f)) || !(await priv("service_role", f))) svcOnly = false;
    }
    ok("G2 reconcile / backfill / settle / reassign / watchdog / check_record are service_role only", svcOnly);
    ok("G3 the student RPCs are callable by authenticated, never anon",
      (await priv("authenticated", "public.my_challenge_tasks()")) && !(await priv("anon", "public.my_challenge_tasks()")) &&
      (await priv("authenticated", "public.my_challenge_task_move(bigint,bigint)")) && (await priv("authenticated", "public.my_telegram_write_access_granted()")));
    const sel = await as(db, ST(1), "select * from challenge_task_submissions");
    ok("G4 a student cannot read the engine tables", !!sel.err && /permission denied/.test(sel.err), sel.err);
    const anonSel = await as(db, null, "select * from challenge_task_messages", [], "anon");
    ok("G5 anon cannot either", !!anonSel.err && /permission denied/.test(anonSel.err));
    const adminCall = await as(db, ST(1), "select admin_challenge_task_results(1)");
    ok("G6 admin RPCs refuse a student", !!adminCall.err && /admin only/.test(adminCall.err), adminCall.err);
  }

  // ───────────── calendar ─────────────
  const SHOT = { any: ["photo", "image_doc"], min: 1, label: "screenshot" };
  const TEXT = { any: ["text"], min: 1, label: "text" };
  const IGL = { any: ["ig_link"], min: 1, label: "ig_link" };
  const T: Record<string, number> = {};
  const addTask = async (date: string, type: string, requires: unknown, accepts: string[], status = "approved", source = "manual", course = C6) => {
    const r = await one(db, `insert into challenge_tasks (course_id, task_date, type, title, body, accepts, requires, status, source)
                             values ($1, $2, $3, $4, 'Vazifa matni', $5::text[], $6::jsonb, $7, $8) returning id`,
      [course, date, type, `Vazifa ${date}`, `{${accepts.join(",")}}`, JSON.stringify(requires), status, source]);
    T[date] = Number(r.id);
    return Number(r.id);
  };
  await addTask("2026-10-05", "general", [SHOT, TEXT], ["text", "photo", "document"]);   // Mon: screenshot + text
  await addTask("2026-10-06", "general", [SHOT], ["text", "photo", "document"]);         // Tue: screenshot
  await addTask("2026-10-07", "instagram", [SHOT, IGL], ["text", "photo", "document", "link"]); // Wed: instagram
  await addTask("2026-10-08", "general", [TEXT], ["text"]);                             // Thu: text-only
  for (const d of ["2026-10-09", "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16"]) {
    await addTask(d, "general", [SHOT], ["text", "photo", "document"]);
  }
  const TMON = T["2026-10-05"], TTUE = T["2026-10-06"], TWED = T["2026-10-07"], TTHU = T["2026-10-08"];

  // ───────────── I. inert while disabled ─────────────
  console.log("I. inert: enabled=false writes nothing, awards nothing, sends nothing");
  {
    const m = tgm({ from: TG(1), at: "2026-10-05T10:00:00", photo: "inert1", caption: T25 });
    await inbox(db, m);
    const r = await cap(db, m);
    ok("I1 capture answers 'disabled' and writes no row", r.outcome === "disabled" && (await rowOf(db, CH1, m.message_id)) === undefined, r);
    const hb = await reconcile(db);
    ok("I2 the reconciler writes its heartbeat only (active false, the waiting message counted)", hb.active === false && hb.paused >= 1, hb);
    ok("I3 ...no ledger row, no submission, no award", await count(db, "select count(*) n from challenge_task_messages") === 0 &&
      await count(db, "select count(*) n from challenge_task_submissions") === 0 &&
      await count(db, "select count(*) n from xp_events where reason like 'challenge_task%'") === 0);
    const wd = (await one(db, "select challenge_tasks_watchdog() r")).r;
    ok("I4 the watchdog only stamps its state (inactive) -- no DM", wd.state === "inactive" &&
      await count(db, "select count(*) n from ops_net_calls") === 0 &&
      (await one(db, "select value->>'last_state' s from app_settings where key = 'challenge_tasks_watchdog_state'")).s === "inactive");
    const claims = await one(db, `select challenge_task_check_claim() a, challenge_task_receipt_claim() b, challenge_task_post_claim() c,
                                         challenge_task_outbox_claim() d, challenge_task_prepare_miniapp($1) e`, [ST(1)]);
    ok("I5 every worker claim answers 'disabled' (nothing to post, send or check)",
      [claims.a, claims.b, claims.c, claims.d].every((x: Row) => x.reason === "disabled") && claims.e.reason === "disabled", claims);
    await db.exec("delete from webhook_inbox");
  }

  await cfgSet(db, "enabled", true);
  ok("E0 enabled: the config is active", (await one(db, "select challenge_tasks_config()->>'active' a")).a === "true");

  // ───────────── R. routing ─────────────
  console.log("R. routing by (chat, thread)");
  {
    const hw = await cap(db, tgm({ from: TG(1), at: "2026-10-05T10:00:00", thread: 3, photo: "r1", caption: T25 }));
    ok("R1 the homework topic is not a task topic", hw.outcome === "not_task_topic", hw);
    const wrongChat = await cap(db, tgm({ chat: CH2, thread: D1, from: TG(1), at: "2026-10-05T10:00:00", photo: "r2", caption: T25 }));
    ok("R2 thread 144 in ANOTHER chat is not G1's topic (the chat is part of the key)", wrongChat.outcome === "not_task_topic", wrongChat);
    const y1 = await cap(db, tgm({ chat: CH9, thread: 10, from: 1061, at: "2026-10-05T10:00:00", photo: "y1", caption: T25 }));
    const y2 = await cap(db, tgm({ chat: CH10, thread: 10, from: 1062, at: "2026-10-05T10:00:00", photo: "y2", caption: T25 }));
    ok("R3 5-GURUH and 6-GURUH both use thread 10: each post lands in its OWN group", y1.outcome === "created" && y2.outcome === "created" &&
      y1.group_id === G9 && y2.group_id === G10, [y1.group_id, y2.group_id]);
    const cross = await cap(db, tgm({ chat: CH10, thread: 10, from: 1061, at: "2026-10-05T11:00:00", photo: "y3", caption: T25 }));
    ok("R4 a 5-GURUH student posting in 6-GURUH's topic 10 is wrong_group, with their own topic URL", cross.outcome === "wrong_group" &&
      cross.own_topic_url === "https://t.me/c/4396568866/10" && cross.hint?.kind === "wrong_group", cross);
    const early = await cap(db, tgm({ from: TG(1), at: "2026-09-30T12:00:00", photo: "r5", caption: T25 }));
    ok("R5 a message dated before the window (by DATE) is a final outside_window row", early.outcome === "outside_window" &&
      (await count(db, "select count(*) n from challenge_task_messages where outcome = 'outside_window'")) === 1, early);
  }

  // ───────────── C. senders ─────────────
  console.log("C. senders");
  {
    const anon = await cap(db, tgm({ from: 1087968824, isBot: true, senderChat: true, at: "2026-10-05T09:00:00", text: "Bugungi vazifa: ..." }));
    ok("C1 an anonymous admin is a silent 'anonymous' row", anon.outcome === "anonymous", anon);
    const bot = await cap(db, tgm({ from: 555, isBot: true, at: "2026-10-05T09:01:00", text: "some bot text here, long enough" }));
    ok("C2 a bot is a silent 'bot' row", bot.outcome === "bot", bot);
    const staff = await cap(db, tgm({ from: 1008, at: "2026-10-05T09:02:00", photo: "staff1", caption: T25 }));
    ok("C3 a teacher is 'staff' and never earns", staff.outcome === "staff" && (await count(db, `select count(*) n from challenge_task_submissions where user_id = '${T1}'`)) === 0, staff);
    const unk = await cap(db, tgm({ from: 9999, username: "Stranger", at: "2026-10-05T10:00:00", photo: "unk1", caption: T25 }));
    ok("C4 an unknown sender: no row, shaped=true (for the bot's auto-register), username passed on",
      unk.outcome === "unknown_sender" && unk.shaped === true && unk.username === "stranger" && (await rowOf(db, CH1, unk.message_id ?? -1)) === undefined, unk);
    const unkChat = await cap(db, tgm({ from: 9998, at: "2026-10-05T10:00:00", text: "salom" }));
    ok("C5 ...chatter from an unknown sender is not 'shaped'", unkChat.outcome === "unknown_sender" && unkChat.shaped === false, unkChat);
    const im = tgm({ from: 7777, username: "Intake_Kid", at: "2026-10-05T10:05:00", photo: "intake1", caption: T25 });
    const intake = await cap(db, im);
    ok("C6 an intake student (telegram_id NULL, same-group username) is credited via username_match", intake.outcome === "created" &&
      intake.resolved_via === "username_match" && intake.user_id === IU && intake.submission?.status === "accepted", intake);
    ok("C7 ...with ONE 'challenge_task_username_match' signal (for the edge sweep to link)",
      await count(db, `select count(*) n from admin_actions where action = 'challenge_task_username_match' and target_user_id = '${IU}'`) === 1);
    await cap(db, tgm({ from: 7777, username: "intake_kid", at: "2026-10-05T10:07:00", text: "yana bir izoh, bu yetarlicha uzun matn" }));
    ok("C8 ...once per day", await count(db, `select count(*) n from admin_actions where action = 'challenge_task_username_match' and target_user_id = '${IU}'`) === 1);
    const other = await cap(db, tgm({ chat: CH9, thread: 10, from: 7778, username: "intake_kid", at: "2026-10-05T10:05:00", photo: "intake2", caption: T25 }));
    ok("C9 the username match is SAME-GROUP only", other.outcome === "unknown_sender", other);

    const held1 = await cap(db, tgm({ from: 1020, at: "2026-10-05T10:00:00", photo: "held1", caption: T25 }));
    const held2 = await cap(db, tgm({ from: 1020, at: "2026-10-05T10:30:00", photo: "held2", caption: T25 }));
    ok("C10 no group: HELD, no row, a neutral hint once a day", held1.outcome === "no_group" && held1.hint?.kind === "held" &&
      held2.outcome === "no_group" && held2.hint == null && await count(db, "select count(*) n from challenge_task_messages where tg_user_id = 1020") === 0, [held1, held2]);
    ok("C11 ...one 'challenge_task_sender_held' signal", await count(db, `select count(*) n from admin_actions where action = 'challenge_task_sender_held' and target_user_id = '${S7}'`) === 1);
    const oos = await cap(db, tgm({ from: 1005, at: "2026-10-05T10:00:00", photo: "oos1", caption: T25 }));
    ok("C12 a 5.0 student in a 6.0 chat is sender_out_of_scope (held)", oos.outcome === "sender_out_of_scope" && oos.hint?.kind === "held", oos);
    const inact = await cap(db, tgm({ from: 1021, at: "2026-10-05T10:00:00", photo: "inact1", caption: T25 }));
    ok("C13 an archived student is 'inactive' (held)", inact.outcome === "inactive", inact);
  }

  // ───────────── D. attribution (option 1) ─────────────
  console.log("D. attribution");
  {
    // D1 photo + caption on Monday: today, accepted on format (ai=false), +5 at the Telegram time
    const m1 = tgm({ from: TG(1), at: "2026-10-05T10:00:00", photo: "p1", caption: T25 });
    const r1 = await cap(db, m1);
    const x1 = await xpOf(db, ST(1), `ch_task:${TMON}`);
    ok("D1 screenshot + text: created for today, accepted, +5, receipt 'reply' with 👍", r1.outcome === "created" && r1.submission?.status === "accepted" &&
      r1.submission?.points === 5 && r1.slot?.rel === "today" && r1.receipt?.mode === "reply" && r1.reaction === "👍", r1);
    ok("D2 ...the ledger row's created_at is the Telegram time (Mon 10:00 Tashkent)", x1?.amount === 5 &&
      new Date(x1.created_at).toISOString() === "2026-10-05T05:00:00.000Z", x1);
    const dup = await cap(db, m1);
    ok("D3 the same message again (bot + reconciler) is 'duplicate', nothing doubles", dup.outcome === "duplicate" &&
      await count(db, `select count(*) n from xp_events where user_id = '${ST(1)}'`) === 1, dup);

    // D4 text first ("I'll send it tomorrow"), then the screenshot: the comment is ADOPTED into one submission
    const t2 = tgm({ from: TG(2), at: "2026-10-05T10:00:00", text: "Ertaga yuboraman, bugun vaqtim yo'q edi" });
    const r2a = await cap(db, t2);
    ok("D4 a text-only message on a screenshot task CANNOT create: silent comment 'text_for_media_task'",
      r2a.outcome === "comment" && r2a.reason === "text_for_media_task" && r2a.reaction == null && r2a.receipt?.send === false, r2a);
    const r2b = await cap(db, tgm({ from: TG(2), at: "2026-10-05T10:02:00", photo: "p2" }));
    ok("D5 ...the screenshot 2 minutes later creates the submission AND adopts the text (back-burst): accepted",
      r2b.outcome === "created" && r2b.adopted === 1 && r2b.submission?.status === "accepted" &&
      (await rowOf(db, CH1, t2.message_id)).outcome === "adopted", r2b);

    // D6 album
    const a1 = await cap(db, tgm({ from: TG(3), at: "2026-10-05T10:00:00", photo: "alb1", caption: T25, mgid: "ALB1" }));
    const a2 = await cap(db, tgm({ from: TG(3), at: "2026-10-05T10:00:00", photo: "alb2", mgid: "ALB1" }));
    ok("D6 an album: the first item creates, the rest are 'appended_album' with no receipt", a1.outcome === "created" &&
      a2.outcome === "appended_album" && a2.receipt?.send === false && a2.submission?.id === a1.submission?.id, [a1.outcome, a2.outcome, a2.receipt]);

    // D7 burst
    const b1 = await cap(db, tgm({ from: TG(9), at: "2026-10-05T11:00:00", photo: "b1" }));
    ok("D7 a lone screenshot: needs_more (missing text), ✍", b1.outcome === "created" && b1.submission?.status === "needs_more" &&
      JSON.stringify(b1.submission?.missing) === '["text"]' && b1.reaction === "✍", b1);
    const b2 = await cap(db, tgm({ from: TG(9), at: "2026-10-05T11:03:00", text: T25 }));
    ok("D8 ...a text 3 minutes later is the BURST: appended, accepted", b2.outcome === "appended" && b2.submission?.status === "accepted" &&
      b2.submission?.id === b1.submission?.id, b2);

    // D9 fix-up
    const f1 = await cap(db, tgm({ from: TG(10), at: "2026-10-05T11:00:00", photo: "f1" }));
    const f2 = await cap(db, tgm({ from: TG(10), at: "2026-10-05T11:40:00", text: T25 }));
    ok("D9 FIX-UP: the missing text 40 minutes later completes it", f2.outcome === "appended" && f2.submission?.id === f1.submission?.id &&
      f2.submission?.status === "accepted", f2);

    // D10 missed: today first, then the next fills the most recent missed task (late, half)
    const m11a = await cap(db, tgm({ from: TG(11), at: "2026-10-06T10:00:00", photo: "m11a" }));
    const m11b = await cap(db, tgm({ from: TG(11), at: "2026-10-06T10:30:00", photo: "m11b", caption: T25 }));
    ok("D10 Tuesday's first screenshot is Tuesday's task (+5)", m11a.outcome === "created" && m11a.slot?.date === "2026-10-06" &&
      m11a.submission?.points === 5, m11a);
    ok("D11 ...the next one fills MONDAY (missed, late 1 day): +3 = ceil(5 x 0.5)", m11b.outcome === "created" &&
      m11b.slot?.date === "2026-10-05" && m11b.slot?.kind === "missed" && m11b.submission?.late_days === 1 && m11b.submission?.points === 3, m11b);

    // D11b (d3) a missed day's screenshot sent 2 minutes after today's is NOT swallowed by the burst rule
    const q4a = await cap(db, tgm({ from: TG(4), at: "2026-10-06T10:00:00", photo: "q4a" }));
    const q4b = await cap(db, tgm({ from: TG(4), at: "2026-10-06T10:02:00", photo: "q4b", caption: T25 }));
    const q4c = await cap(db, tgm({ from: TG(4), at: "2026-10-06T10:03:00", text: "Ikkalasini ham yubordim, rahmat ustoz!" }));
    ok("D11b media 2 minutes after an ACCEPTED submission fills the missed task (never swallowed); text still bursts",
      q4a.submission?.status === "accepted" && q4b.outcome === "created" && q4b.slot?.date === "2026-10-05" &&
      q4c.outcome === "appended", [q4a.outcome, q4b.outcome, q4b.slot, q4c.outcome]);

    // D12 text-only never fills a missed task
    await cap(db, tgm({ from: TG(12), at: "2026-10-06T10:00:00", photo: "m12a" }));
    const m12b = await cap(db, tgm({ from: TG(12), at: "2026-10-06T10:30:00", text: "Bugun juda zo'r vazifa bo'ldi, rahmat!" }));
    ok("D12 a later TEXT-ONLY message never takes a missed task: appended_extra (👍), no Monday submission",
      m12b.outcome === "appended_extra" && m12b.reaction === "👍" && (await liveOf(db, ST(12), TMON)) === undefined, m12b);

    // D13 before 09:00: goes to a missed task, or a once-a-day hint
    const e13 = await cap(db, tgm({ from: TG(13), at: "2026-10-06T08:00:00", photo: "e13", caption: T25 }));
    ok("D13 a screenshot at 08:00 (today's task not open) fills the missed Monday task", e13.outcome === "created" &&
      e13.slot?.date === "2026-10-05" && e13.submission?.late_days === 1, e13);
    const e14 = await cap(db, tgm({ from: TG(14), at: "2026-10-06T08:00:00", text: "Salom, bugungi vazifa qachon chiqadi, bilasizlarmi" }));
    const e14b = await cap(db, tgm({ from: TG(14), at: "2026-10-06T08:05:00", text: "Hali ham kutyapman bugungi vazifani albatta" }));
    ok("D14 text before 09:00 with nothing missed: no_slot 'before_open', hinted once a day", e14.outcome === "no_slot" &&
      e14.reason === "before_open" && e14.hint?.kind === "no_slot_before_open" && e14b.outcome === "no_slot" && e14b.hint == null, [e14, e14b]);

    // D15 a reply to a MANUAL staff post targets that task (R3); the manual post also opens the task early
    await db.query(`insert into challenge_task_posts (task_id, group_id, kind, state, chat_id, thread_id, message_id, sent_at)
                    values ($1, $2, 'task', 'manual', $3, $4, 5000, '2026-10-05T08:30:00+05:00')`, [TMON, G1, CH1, D1]);
    const rp = await cap(db, tgm({ from: TG(15), at: "2026-10-06T12:00:00", photo: "rp15", caption: T25, replyTo: { id: 5000, from: 6542876935 } }));
    ok("D15 a reply to Monday's MANUAL post on Tuesday is Monday's work (reply_to_post, late 1)", rp.outcome === "created" &&
      rp.slot?.date === "2026-10-05" && rp.submission?.attributed_via === "reply_to_post" && rp.submission?.late_days === 1, rp);
    const op = await cap(db, tgm({ from: TG(16), at: "2026-10-05T08:45:00", photo: "op16", caption: T25 }));
    ok("D16 staff posted by hand at 08:30: work at 08:45 counts for today, on time", op.outcome === "created" &&
      op.slot?.date === "2026-10-05" && op.submission?.late_days === 0, op);

    // D17 the comment rule (C18), both directions
    const cl = await cap(db, tgm({ from: TG(2), at: "2026-10-05T12:00:00", text: "Zo'r chiqibdi, menga ham o'rgating!", replyTo: { id: m1.message_id, from: TG(1) } }));
    ok("D17 a TEXT reply to a classmate is a silent comment 'reply_classmate'", cl.outcome === "comment" && cl.reason === "reply_classmate", cl);
    const clp = await cap(db, tgm({ from: TG(17), at: "2026-10-05T12:00:00", photo: "clp17", caption: T25, replyTo: { id: m1.message_id, from: TG(1) } }));
    ok("D18 a PHOTO reply to a classmate is attributed (created for today)", clp.outcome === "created" && clp.slot?.date === "2026-10-05", clp);
    await db.query("select challenge_task_receipt_record($1, 1, $2, 7001, true)", [r1.submission.id, CH1]);
    const rr = await cap(db, tgm({ from: TG(18), at: "2026-10-05T12:10:00", text: "Bu qanday qilinadi, tushuntirib bera olasizmi", replyTo: { id: 7001, from: 42, isBot: true } }));
    ok("D19 a text reply to a CLASSMATE'S RECEIPT (a bot message tied to another student) is a comment", rr.outcome === "comment" &&
      rr.reason === "reply_classmate" && rr.reply_kind === "classmate_bot_msg", rr);
    const staffReply = await cap(db, tgm({ from: TG(19), at: "2026-10-05T12:20:00", text: "Men bugun shu vazifani bajardim, mana javobim", replyTo: { id: 5000, from: 6542876935 } }));
    ok("D20 a text reply to the (manual) task post goes to attribution, never 'comment'", staffReply.outcome !== "comment" &&
      staffReply.reply_kind === "task_post", staffReply);

    // D21 reply to OWN receipt appends
    const o1 = await cap(db, tgm({ from: TG(20), at: "2026-10-05T13:00:00", photo: "o20" }));
    await db.query("select challenge_task_receipt_record($1, $2, $3, 7003, true)", [o1.submission.id, o1.submission.receipt_version, CH1]);
    const o2 = await cap(db, tgm({ from: TG(20), at: "2026-10-05T13:30:00", text: T25, replyTo: { id: 7003, from: 42, isBot: true } }));
    ok("D21 a text reply to the student's OWN receipt appends (R2): accepted, receipt EDITED",
      o2.outcome === "appended" && o2.submission?.status === "accepted" && o2.receipt?.mode === "edit", o2);

    // D22 closed: the task closes at 00:00 after task_date + 2
    const cz = await cap(db, tgm({ from: TG(21), at: "2026-10-08T10:00:00", photo: "cz21", caption: T25, replyTo: { id: 5000, from: 6542876935 } }));
    ok("D22 a reply to Monday's post on Thursday: no_slot 'target_closed' with a hint", cz.outcome === "no_slot" &&
      cz.reason === "target_closed" && cz.hint?.kind === "no_slot_target_closed", cz);

    // D23 daily cap
    await cfgSet(db, "max_items_per_day", 3);
    await cap(db, tgm({ from: TG(22), at: "2026-10-05T14:00:00", photo: "cap1" }));
    await cap(db, tgm({ from: TG(22), at: "2026-10-05T14:01:00", photo: "cap2" }));
    await cap(db, tgm({ from: TG(22), at: "2026-10-05T14:02:00", text: T25 }));
    const c4 = await cap(db, tgm({ from: TG(22), at: "2026-10-05T14:03:00", photo: "cap4" }));
    ok("D23 the 4th item of the day with max_items_per_day=3 is a silent 'daily_cap' row", c4.outcome === "daily_cap", c4);
    await cfgSet(db, "max_items_per_day", 40);

    // D24 image reuse
    const reuse = await cap(db, tgm({ from: TG(23), at: "2026-10-05T15:00:00", photo: "p1", caption: T25 }));
    ok("D24 another student's exact screenshot (file_unique_id) is rejected 'image_seen_before' (🤔)",
      reuse.submission?.status === "rejected" && reuse.submission?.reason === "image_seen_before" && reuse.reaction === "🤔", reuse);
    ok("D25 ...and the ORIGINAL owner is untouched", (await liveOf(db, ST(1), TMON))?.status === "accepted");

    // D26 forward from someone else / a sticker
    const fw = await cap(db, tgm({ from: TG(24), at: "2026-10-05T15:00:00", photo: "fw24", caption: T25, fwdFrom: 123 }));
    ok("D26 a forward of someone else's message is 'forward_other' (silent)", fw.outcome === "forward_other", fw);
    const sticker = tgm({ from: TG(24), at: "2026-10-05T15:01:00" });
    sticker.sticker = { file_unique_id: "st1" };
    const st = await cap(db, sticker);
    ok("D27 a sticker is 'ignored_kind'", st.outcome === "ignored_kind", st);
    const qn = await cap(db, tgm({ from: TG(24), at: "2026-10-05T15:02:00", text: "Vazifani qayerga yuborish kerak?" }));
    ok("D28 a question is a silent comment 'question'", qn.outcome === "comment" && qn.reason === "question", qn);

    // D29 Instagram
    const ig = await cap(db, tgm({ from: TG(25), at: "2026-10-07T10:00:00", photo: "ig25", caption: "https://www.instagram.com/p/SHORTcode01/" }));
    ok("D29 IG task: screenshot + post link -> created via ig_link; no handle yet -> needs_more 'instagram_handle'",
      ig.outcome === "created" && ig.submission?.attributed_via === "ig_link" && ig.submission?.status === "needs_more" &&
      JSON.stringify(ig.submission?.missing) === '["instagram_handle"]', ig);
    await db.query(`update profiles set instagram_username = 'kid_twentyfive' where id = $1`, [ST(25)]);
    await reconcile(db);
    const igs = await subOf(db, ST(25), TWED);
    ok("D30 ...the handle is added: the reconciler re-evaluates -> checking, HELD 'ig_waiting_ai' (never paid unchecked), snapshot taken",
      igs.status === "checking" && igs.hold_reason === "ig_waiting_ai" && igs.ig_handle_snapshot === "kid_twentyfive" && igs.points_awarded === 0, igs);
    await db.query(`update profiles set instagram_username = 'kid_twentysix' where id = $1`, [ST(26)]);
    const sh = await cap(db, tgm({ from: TG(26), at: "2026-10-07T10:00:00", photo: "ig26", caption: "https://www.instagram.com/share/p/BXyz123/" }));
    ok("D31 a /share/ link: needs_more 'ig_link_share'", sh.submission?.status === "needs_more" && sh.submission?.reason === "ig_link_share" &&
      JSON.stringify(sh.submission?.missing) === '["ig_link"]', sh);

    // D32 text-only task while ai=false: HELD, not paid
    const tt = await cap(db, tgm({ from: TG(27), at: "2026-10-08T10:00:00", text: "Bugun men ChatGPT bilan uchta prompt yozib ko'rdim va natijani solishtirdim" }));
    ok("D32 a text-only task with ai=false: checking, hold 'ai_off', 0 points (👀)", tt.submission?.status === "checking" &&
      tt.submission?.hold_reason === "ai_off" && tt.submission?.points === 0 && tt.reaction === "👀", tt);

    // D32b a photo attached to a TEXT-ONLY task does not make it "media": still held while ai=false (C16)
    const tp = await cap(db, tgm({ from: TG(41), at: "2026-10-08T10:00:00", photo: "tp41", caption: "Bugungi fikrlarim: prompt yozishni o'rgandim va sinab ko'rdim" }));
    ok("D32b text-only task + a photo: still checking / ai_off (only a met MEDIA group pays on format)",
      tp.submission?.status === "checking" && tp.submission?.hold_reason === "ai_off", tp);

    // D33 attempts exhausted (three rejections)
    await cfgSet(db, "max_attempts_per_task", 2);
    const at1 = await cap(db, tgm({ from: TG(28), at: "2026-10-05T16:00:00", photo: "p1" }));           // another student's image
    const at2 = await cap(db, tgm({ from: TG(28), at: "2026-10-05T16:30:00", photo: "p2" }));           // ditto (ST(2)'s)
    const at3 = await cap(db, tgm({ from: TG(28), at: "2026-10-05T17:00:00", photo: "own28", caption: T25 }));
    ok("D33 after max_attempts_per_task rejections the task is 'attempts_exhausted' (hint once)",
      at1.submission?.status === "rejected" && at2.submission?.status === "rejected" && at3.outcome === "attempts_exhausted" &&
      at3.hint?.kind === "attempts_exhausted", [at1.outcome, at2.outcome, at3]);
    await cfgSet(db, "max_attempts_per_task", 3);
    ok("D34 user_xp equals the ledger for every student", await userXpOk(db));
  }

  // ───────────── L. late points, streak, freeze ─────────────
  console.log("L. late points, streak (+10 per 5 on-time task days), freeze");
  {
    const pf = async (task: number, late: number, points: number | null = null) =>
      Number((await one(db, `select challenge_task_points_for(jsonb_populate_record(x, jsonb_build_object('points', $3::int)), $2,
                                                              challenge_tasks_config()) p
                               from challenge_tasks x where x.id = $1`, [task, late, points])).p);
    ok("L1 general 5 / late 1-2 days 3 / closed 0; instagram 8 / late 4; a points override wins",
      (await pf(TMON, 0)) === 5 && (await pf(TMON, 1)) === 3 && (await pf(TMON, 2)) === 3 && (await pf(TMON, 3)) === 0 &&
      (await pf(TWED, 0)) === 8 && (await pf(TWED, 2)) === 4 && (await pf(TMON, 0, 12)) === 12 && (await pf(TMON, 1, 12)) === 6);

    // S4-like student ST(30): on time Fri, Mon, Tue, Wed, Thu (the weekend is a rest day)
    const days = ["2026-10-09", "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15"];
    let last: Row = {};
    for (const d of days) last = await cap(db, tgm({ from: TG(30), at: `${d}T10:00:00`, photo: `st30_${d}` }));
    const aw = await one(db, "select * from challenge_task_streak_awards where user_id = $1", [ST(30)]);
    const sx = await xpOf(db, ST(30), "ch_task_streak:2026-10-15");
    ok("L2 5 on-time task days in a row across a weekend: ONE +10 award dated the 5th day", aw?.task_date?.toISOString?.().slice(0, 10) === "2026-10-15" &&
      aw.streak_len === 5 && sx?.amount === 10 && last.streak?.days === 5 && last.streak?.milestone_bonus === 10, { aw, sx, streak: last.streak });
    ok("L3 ...its ledger row is freeze-aware (unfrozen week: the moment the run completed)",
      new Date(sx.created_at).toISOString() === "2026-10-15T05:00:00.000Z", sx);
    ok("L4 the 🔥 reaction once the streak is >= 3", last.reaction === "🔥", last.reaction);
    // late breaks the run
    for (const d of ["2026-10-09", "2026-10-12"]) await cap(db, tgm({ from: TG(31), at: `${d}T10:00:00`, photo: `st31_${d}` }));
    await cap(db, tgm({ from: TG(31), at: "2026-10-14T10:00:00", photo: "st31_14" }));
    const late13 = await cap(db, tgm({ from: TG(31), at: "2026-10-14T11:00:00", photo: "st31_13" }));   // Tuesday's, a day late
    await cap(db, tgm({ from: TG(31), at: "2026-10-15T10:00:00", photo: "st31_15" }));
    await cap(db, tgm({ from: TG(31), at: "2026-10-16T10:00:00", photo: "st31_16" }));
    ok("L5 a LATE day breaks the run: no award for 5 accepted days that were not all on time", late13.submission?.late_days === 1 &&
      await count(db, "select count(*) n from challenge_task_streak_awards where user_id = $1", [ST(31)]) === 0);
    ok("L6 re-settling is idempotent: the award is sticky and never doubled",
      (await one(db, "select challenge_task_streak_recompute($1, $2, challenge_tasks_config()) r", [ST(30), C6])).r >= 5 &&
      await count(db, "select count(*) n from xp_events where user_id = $1 and reason = 'challenge_task_streak'", [ST(30)]) === 1);

    // freeze: the week of Mon 2026-10-05 is frozen -> a new award in it lands NOW
    await db.query("insert into challenge_weekly_results (week_start, kind, group_id, user_id, points, rank) values ('2026-10-05', 'team', $1, null, 10, 1)", [G1]);
    const fr = await cap(db, tgm({ from: TG(32), at: "2026-10-06T10:00:00", photo: "fr32" }));
    const fx = await xpOf(db, ST(32), `ch_task:${TTUE}`);
    ok("L7 an award whose week is already FROZEN gets created_at = now() (the current board, C11)", fr.submission?.points === 5 &&
      Math.abs(Date.now() - new Date(fx.created_at).getTime()) < 60_000, fx);
    ok("L8 ...and awards_after_freeze stays 0 by construction",
      (await one(db, "select challenge_tasks_health()->'invariants'->>'awards_after_freeze_7d' n")).n === "0");
    await db.exec("delete from challenge_weekly_results");
  }

  // ───────────── K. corrections ─────────────
  console.log("K. one-tap corrections");
  {
    const monSub = await liveOf(db, ST(11), TMON);   // D11: Monday's, filled late on Tuesday
    const fut = (await one(db, "select challenge_task_move_by_tg($1, $2, $3) r", [TG(11), monSub.id, TWED])).r;
    ok("K1 moving to a FUTURE task is refused (I5)", fut.ok === false && fut.reason === "future_task", fut);
    const notMine = (await one(db, "select challenge_task_move_by_tg($1, $2, $3) r", [TG(12), monSub.id, TTUE])).r;
    ok("K2 a classmate's tap is refused by the SQL owner lock", notMine.ok === false && notMine.reason === "not_owner", notMine);
    const merged = (await one(db, "select challenge_task_move_by_tg($1, $2, $3) r", [TG(11), monSub.id, TTUE])).r;
    const tueSub = await liveOf(db, ST(11), TTUE);
    ok("K3 'Bugungi deb belgilash' onto a task that already has a live submission MERGES (earliest submitted_at kept)",
      merged.ok === true && merged.submission?.id === tueSub.id && (await one(db, "select status from challenge_task_submissions where id = $1", [monSub.id])).status === "merged", merged);
    ok("K4 ...Monday's +3 is removed, Tuesday keeps +5", (await xpOf(db, ST(11), `ch_task:${TMON}`)) === undefined &&
      (await xpOf(db, ST(11), `ch_task:${TTUE}`))?.amount === 5);

    // move (no merge): ST(13) did Monday's at Tue 08:00 -> move it to Tuesday: posted Tue, so ON TIME for Tuesday
    const s13 = await liveOf(db, ST(13), TMON);
    const mv = (await one(db, "select challenge_task_move_by_tg($1, $2, $3) r", [TG(13), s13.id, TTUE])).r;
    ok("K5 a plain move re-derives lateness from the POST date: Monday late(3) -> Tuesday on time(5)", mv.ok === true &&
      mv.submission?.late_days === 0 && mv.submission?.points === 5 && mv.submission?.attributed_via === "moved" &&
      (await xpOf(db, ST(13), `ch_task:${TMON}`)) === undefined, mv);
    const back = (await one(db, "select challenge_task_move_by_tg($1, $2, $3) r", [TG(13), s13.id, TMON])).r;
    ok("K6 ...and back: late 1 again (+3); a correction never pays on-time for a date it was not posted on", back.ok === true &&
      back.submission?.late_days === 1 && back.submission?.points === 3, back);
    await cfgSet(db, "max_moves_per_submission", 2);
    const third = (await one(db, "select challenge_task_move_by_tg($1, $2, $3) r", [TG(13), s13.id, TTUE])).r;
    ok("K7 max_moves_per_submission is enforced", third.ok === false && third.reason === "too_many_moves", third);
    await cfgSet(db, "max_moves_per_submission", 5);

    // withdraw / restore
    const s16 = await liveOf(db, ST(16), TMON);
    const wd = (await one(db, "select challenge_task_withdraw_by_tg($1, $2) r", [TG(16), s16.id])).r;
    ok("K8 '❌ Bu topshiriq emas' withdraws: points removed", wd.ok === true && wd.submission?.status === "withdrawn" &&
      (await xpOf(db, ST(16), `ch_task:${TMON}`)) === undefined, wd);
    const rs = (await one(db, "select challenge_task_restore_by_tg($1, $2) r", [TG(16), s16.id])).r;
    ok("K9 undo restores it (re-judged from its items): accepted, +5 again", rs.ok === true && rs.submission?.status === "accepted" &&
      (await xpOf(db, ST(16), `ch_task:${TMON}`))?.amount === 5, rs);
    await one(db, "select challenge_task_withdraw_by_tg($1, $2) r", [TG(16), s16.id]);
    await cap(db, tgm({ from: TG(16), at: "2026-10-05T20:00:00", photo: "p16new", caption: T25 }));
    const rs2 = (await one(db, "select challenge_task_restore_by_tg($1, $2) r", [TG(16), s16.id])).r;
    ok("K10 restore is refused when a newer live submission holds the slot", rs2.ok === false && rs2.reason === "slot_taken", rs2);

    // admin override through the bot (logged) and the admin RPC
    const adm = (await one(db, "select challenge_task_withdraw_by_tg(1011, $1) r", [(await liveOf(db, ST(17), TMON)).id])).r;
    ok("K11 an admin's tap is allowed and LOGGED as an override", adm.ok === true &&
      await count(db, "select count(*) n from admin_actions where action = 'challenge_task_admin_override' and details->>'op' = 'withdraw'") === 1, adm);
    const ov = await as(db, AD, "select admin_challenge_task_override($1, 'restore') r", [(await subOf(db, ST(17), TMON)).id]);
    ok("K12 admin_challenge_task_override (restore) works for an admin", ov.err === null && (ov.rows as Row[])[0].r.ok === true, ov);
    const mine = await as(db, ST(1), "select my_challenge_task_withdraw($1) r", [(await liveOf(db, ST(2), TMON)).id]);
    ok("K13 my_challenge_task_withdraw refuses someone else's submission", mine.err === null && (mine.rows as Row[])[0].r.reason === "not_owner", mine);
    const myList = await as(db, ST(1), "select my_challenge_tasks() r");
    const tasks = (myList.rows as Row[])[0].r;
    ok("K14 my_challenge_tasks: the student's own view (Monday accepted +5)", tasks.ok === true &&
      tasks.tasks.some((t: Row) => t.date === "2026-10-05" && t.submission?.status === "accepted" && t.submission?.points === 5), tasks);
    ok("K15 user_xp still equals the ledger", await userXpOk(db));
  }

  // ───────────── A. pause -> resume, held -> fixed (the 26-hour rolling scan) ─────────────
  console.log("A. pause / resume and held senders are re-derived by the rolling scan");
  {
    await db.query("update platform_settings set value = jsonb_set(value, '{enabled}', 'false') where key = 'challenge'");
    const pm = tgm({ from: TG(33), at: "2026-10-06T11:00:00", photo: "pause33", caption: T25 });
    await inbox(db, pm);
    const pr = await cap(db, pm);
    ok("A1 challenge.enabled=false: 'disabled', NO row (C20: never a final outside_window)", pr.outcome === "disabled" &&
      (await rowOf(db, CH1, pm.message_id)) === undefined, pr);
    const hb = await reconcile(db);
    ok("A2 the paused reconciler counts it and changes nothing", hb.active === false && hb.paused >= 1, hb);
    await db.query("update platform_settings set value = jsonb_set(value, '{enabled}', 'true') where key = 'challenge'");
    const hb2 = await reconcile(db);
    ok("A3 resumed: the next run captures it (source reconciler, receipt left for the worker)",
      (await rowOf(db, CH1, pm.message_id))?.outcome === "created" && (await liveOf(db, ST(33), TTUE))?.source === "reconciler", hb2);
    const hm = tgm({ from: 1020, at: "2026-10-06T11:00:00", photo: "held3", caption: T25 });
    await inbox(db, hm);
    const h1 = await reconcile(db);
    ok("A4 a HELD sender stays in the retry state (DB-visible), no row", (await rowOf(db, CH1, hm.message_id)) === undefined &&
      await count(db, "select count(*) n from challenge_task_retry where message_id = $1 and outcome = 'no_group'", [hm.message_id]) === 1, h1.by_outcome);
    await db.query("update profiles set group_id = $1 where id = $2", [G1, S7]);
    await reconcile(db);
    ok("A5 an admin fixes the group: the next run credits the work and clears the retry row",
      (await rowOf(db, CH1, hm.message_id))?.outcome === "created" && await count(db, "select count(*) n from challenge_task_retry where message_id = $1", [hm.message_id]) === 0);
  }

  // ───────────── X. race safety ─────────────
  console.log("X. race safety");
  {
    const rm = tgm({ from: TG(34), at: "2026-10-06T12:00:00", photo: "race34", caption: T25 });
    await inbox(db, rm);
    const botFirst = await cap(db, rm);
    await reconcile(db);
    ok("X1 bot + reconciler on one message: one row, one submission, one award", botFirst.outcome === "created" &&
      await count(db, "select count(*) n from challenge_task_messages where message_id = $1", [rm.message_id]) === 1 &&
      await count(db, "select count(*) n from xp_events where user_id = $1", [ST(34)]) === 1);
    // serialization: capture holds the per-student lock (and settle the per-student user_xp lock) until commit
    const lockKey = (k: string) => `((hashtext('${k}')::bigint >> 32) & 4294967295)`;
    await db.exec("begin");
    const rc = await cap(db, tgm({ from: TG(35), at: "2026-10-06T12:00:00", photo: "race35", caption: T25 }));
    const held = await one(db, `select
        count(*) filter (where classid::bigint = ${lockKey("ctask:" + ST(35))} and objid::bigint = (hashtext('ctask:${ST(35)}')::bigint & 4294967295)) as ctask,
        count(*) filter (where classid::bigint = ${lockKey("user_xp:" + ST(35))} and objid::bigint = (hashtext('user_xp:${ST(35)}')::bigint & 4294967295)) as uxp
      from pg_locks where locktype = 'advisory' and pid = pg_backend_pid() and granted`);
    await db.exec("commit");
    const after0 = await count(db, "select count(*) n from pg_locks where locktype = 'advisory' and pid = pg_backend_pid()");
    ok("X2 capture holds ctask:<student> and user_xp:<student> advisory locks until commit (two writers for one student serialize)",
      rc.outcome === "created" && Number(held.ctask) === 1 && Number(held.uxp) === 1 && after0 === 0, { held, after0 });
    const dupLive = await tx(db, `insert into challenge_task_submissions (task_id, user_id, group_id, source, attributed_via, status, submitted_at, last_item_at)
                                  values (${TTUE}, '${ST(35)}', '${G1}', 'topic', 'today', 'needs_more', now(), now());`);
    ok("X2b ...and the unique index is the backstop: a second LIVE submission for (student, task) cannot exist", !!dupLive && /uq_ctask_sub_live/.test(dupLive), dupLive);
    const before = await one(db, "select count(*)::int n, max(created_at) c from admin_actions where action = 'challenge_task_points_changed'");
    await db.query("select challenge_task_settle_ut($1, $2, challenge_tasks_config())", [ST(1), TMON]);
    await db.query("select challenge_task_settle_ut($1, $2, challenge_tasks_config())", [ST(1), TMON]);
    const after = await one(db, "select count(*)::int n from admin_actions where action = 'challenge_task_points_changed'");
    ok("X3 settle is idempotent: re-settling writes nothing", before.n === after.n &&
      await count(db, "select count(*) n from xp_events where user_id = $1 and ref_key = $2", [ST(1), `ch_task:${TMON}`]) === 1);
    const r1 = await reconcile(db);
    const r2 = await reconcile(db);
    ok("X4 two reconciler runs in a row: the second captures and heals nothing", r2.captured === 0 && r2.healed === 0 && r2.orphans_removed === 0, [r1, r2]);
    // one bad message never blocks the batch
    await db.exec(`create or replace function pg_temp.boom() returns trigger language plpgsql as $$
      begin if NEW.message_id = 999999 then raise exception 'boom'; end if; return NEW; end $$`);
    await db.exec("create trigger boom before insert on public.challenge_task_messages for each row execute function pg_temp.boom()");
    const bad = tgm({ id: 999999, from: TG(36), at: "2026-10-06T13:00:00", photo: "bad36", caption: T25 });
    const good = tgm({ from: TG(37), at: "2026-10-06T13:01:00", photo: "good37", caption: T25 });
    await inbox(db, bad); await inbox(db, good);
    const r3 = await reconcile(db);
    await db.exec("drop trigger boom on public.challenge_task_messages");
    ok("X5 an exception on one message is isolated: the next message is captured, the bad one is a DB-visible retry 'error'",
      (await rowOf(db, CH1, good.message_id))?.outcome === "created" &&
      await count(db, "select count(*) n from challenge_task_retry where message_id = 999999 and outcome = 'error'") === 1 &&
      (r3.by_outcome?.error ?? 0) === 1, r3.by_outcome);
    await reconcile(db);
    ok("X6 ...and the next run captures it", (await rowOf(db, CH1, 999999))?.outcome === "created");
    ok("X7 no live duplicates anywhere; user_xp equals the ledger", (await one(db, "select challenge_tasks_health()->'invariants' i")).i.live_duplicates === 0 && await userXpOk(db));
  }

  // ───────────── E. edits, legacy swap ─────────────
  console.log("E. edits and the legacy swap");
  {
    const em = tgm({ from: TG(38), at: "2026-10-06T14:00:00", doc: { mime: "image/png", id: "edit38" }, caption: "qisqa" });
    const e1 = await cap(db, em);
    ok("E1 an image document counts as a screenshot (image_doc)", e1.outcome === "created" && e1.submission?.status === "accepted", e1);
    const em2 = tgm({ from: TG(39), at: "2026-10-05T14:00:00", photo: "edit39", caption: "qisqa" });
    const e2 = await cap(db, em2);
    ok("E2 Monday: screenshot + a 5-char caption = needs_more text", e2.submission?.status === "needs_more", e2);
    const edited = { ...em2, caption: T25, edit_date: epoch("2026-10-05T14:05:00") };
    const e3 = (await one(db, "select challenge_task_item_edited($1::jsonb) r", [JSON.stringify(edited)])).r;
    ok("E3 editing the caption re-evaluates the item: accepted", e3.submission?.status === "accepted", e3);
    const e4 = (await one(db, "select challenge_task_item_edited($1::jsonb) r", [JSON.stringify(edited)])).r;
    ok("E4 an edit to an accepted submission changes nothing", e4.outcome === "edit_ignored", e4);
    const e5 = (await one(db, "select challenge_task_item_edited($1::jsonb) r", [JSON.stringify(tgm({ from: TG(39), at: "2026-10-05T14:00:00", text: "x" }))])).r;
    ok("E5 an edit to a message that was never captured is ignored", e5.outcome === "ignored_uncaptured", e5);

    const lm = tgm({ from: TG(40), at: "2026-10-06T15:00:00", photo: "leg40", caption: T25 });
    await db.query("insert into xp_events (user_id, amount, reason, ref_key, created_at) values ($1, 5, 'challenge_group_media', $2, now())",
      [ST(40), `ch_img:${CH1}:${lm.message_id}`]);
    await cap(db, lm);
    ok("E6 LEGACY SWAP: media points paid earlier on the same message are removed, with a signal",
      (await xpOf(db, ST(40), `ch_img:${CH1}:${lm.message_id}`)) === undefined &&
      await count(db, "select count(*) n from admin_actions where action = 'challenge_task_legacy_swap' and target_user_id = $1", [ST(40)]) === 1 &&
      await userXpOk(db));
  }

  // ───────────── N. Mini App ─────────────
  console.log("N. Mini App: claim time is the submission time; idempotent; healed");
  {
    const off = (await one(db, "select challenge_task_prepare_miniapp($1, $2) r", [ST(5), TTUE])).r;
    ok("N1 miniapp=false: prepare answers 'miniapp_off'", off.reason === "miniapp_off", off);
    await cfgSet(db, "miniapp", true);
    await db.query("select challenge_task_submit_claim($1, 'req-mini-0005', $2)", [ST(5), TTUE]);
    await db.query("update challenge_task_submit_claims set claimed_at = '2026-10-06T23:59:30+05:00' where request_id = 'req-mini-0005'");
    const posted = [{ message_id: 8001, date: epoch("2026-10-07T00:00:40"), chat: { id: CH1 }, message_thread_id: D1, from: { id: 42, is_bot: true },
                      photo: [{ file_unique_id: "mini5" }], caption: T25 }];
    const c1 = (await one(db, "select challenge_task_capture_miniapp($1, $2, 'req-mini-0005', null, $3::jsonb) r", [ST(5), TTUE, JSON.stringify(posted)])).r;
    ok("N2 claimed 23:59:30, posted after midnight: still ON TIME (+5)", c1.outcome === "created" && c1.submission?.late_days === 0 &&
      c1.submission?.points === 5 && c1.submission?.attributed_via === "miniapp", c1);
    const c2 = (await one(db, "select challenge_task_capture_miniapp($1, $2, 'req-mini-0005', null, $3::jsonb) r", [ST(5), TTUE, JSON.stringify(posted)])).r;
    ok("N3 the same request again is 'duplicate'", c2.outcome === "duplicate" && await count(db, "select count(*) n from challenge_task_messages where message_id = 8001") === 1, c2);
    const rep = await cap(db, tgm({ from: TG(6), at: "2026-10-07T01:00:00", text: "Juda chiroyli chiqibdi, qaysi dasturda qildingiz", replyTo: { id: 8001, from: 42, isBot: true } }));
    ok("N4 a text reply to a classmate's Mini App repost is a comment", rep.outcome === "comment" && rep.reply_kind === "classmate_bot_msg", rep);
    await db.query("select challenge_task_submit_claim($1, 'req-mini-0007', $2)", [ST(7), TTUE]);
    await db.query("update challenge_task_submit_claims set claimed_at = '2026-10-06T18:00:05+05:00' where request_id = 'req-mini-0007'");
    await db.query("select challenge_task_submit_record($1, 'req-mini-0007', $2::jsonb)",
      [ST(7), JSON.stringify([{ message_id: 8002, date: epoch("2026-10-06T18:00:00"), chat: { id: CH1 }, message_thread_id: D1,
                                photo: [{ file_unique_id: "mini7" }] }])]);
    await db.query("update challenge_task_submit_claims set updated_at = now() - interval '10 minutes' where request_id = 'req-mini-0007'");
    const hb = await reconcile(db);
    ok("N5 posted but never captured (the edge function died): the reconciler's Mini App heal captures it",
      hb.miniapp_healed === 1 && (await liveOf(db, ST(7), TTUE))?.status === "accepted", hb);
    await db.query("select challenge_task_submit_claim($1, 'req-mini-0020', $2)", [S7, TTUE]);
    await db.query("update profiles set status = 'inactive' where id = $1", [S7]);
    const refused = (await one(db, "select challenge_task_capture_miniapp($1, $2, 'req-mini-0020', null, $3::jsonb) r",
      [S7, TTUE, JSON.stringify([{ message_id: 8003, date: epoch("2026-10-06T18:00:00"), chat: { id: CH1 }, photo: [{ file_unique_id: "mini20" }] }])])).r;
    ok("N6 an inactive student is refused FINALLY (claim failed, signal written; the heal never loops on it)", refused.outcome === "refused" &&
      (await one(db, "select state from challenge_task_submit_claims where request_id = 'req-mini-0020'")).state === "failed" &&
      await count(db, "select count(*) n from admin_actions where action = 'challenge_task_miniapp_refused'") === 1, refused);
    await db.query("update profiles set status = 'active' where id = $1", [S7]);
    await cfgSet(db, "miniapp", false);
  }

  // ───────────── U. reassign_user (duplicate merge) ─────────────
  console.log("U. reassign_user");
  {
    // ST(21) and ST(24) both have live Monday work? ST(24) has none; give them both Tuesday work at different times
    const a = await cap(db, tgm({ from: TG(21), at: "2026-10-06T09:30:00", photo: "ra21", caption: T25 }));
    const b = await cap(db, tgm({ from: TG(24), at: "2026-10-06T16:00:00", photo: "ra24", caption: T25 }));
    const r = (await one(db, "select challenge_task_reassign_user($1, $2) r", [ST(21), ST(24)])).r;
    const kept = await liveOf(db, ST(24), TTUE);
    ok("U1 the EARLIER live submission keeps the slot, the later becomes 'merged'", r.ok === true && r.merged === 1 &&
      kept.id === a.submission.id && (await one(db, "select status from challenge_task_submissions where id = $1", [b.submission.id])).status === "merged", r);
    ok("U2 the duplicate owns no task rows or points any more; the canonical student is paid once",
      await count(db, "select count(*) n from challenge_task_submissions where user_id = $1", [ST(21)]) === 0 &&
      await count(db, "select count(*) n from xp_events where user_id = $1 and reason like 'challenge_task%'", [ST(21)]) === 0 &&
      (await xpOf(db, ST(24), `ch_task:${TTUE}`))?.amount === 5 && await userXpOk(db));
  }

  // ───────────── C2. AI checks, fail-open, expire ─────────────
  console.log("Q. AI claim / record (SQL decides), fail-open, expire");
  {
    await cfgSet(db, "ai", true);
    await reconcile(db);
    const released = await subOf(db, ST(27), TTHU);
    ok("Q1 ai=true: holds taken while ai was off are released to the checker", released.status === "checking" && released.hold_reason === null, released);
    const claim = (await one(db, "select challenge_task_check_claim(10) r")).r;
    const it = claim.items.find((i: Row) => i.submission_id === Number(released.id));
    const igClaim = claim.items.find((i: Row) => i.type === "instagram");
    ok("Q2 the checker leases it with the text and the task rubric", claim.ok === true && !!it && it.items[0].text.startsWith("Bugun men ChatGPT"), claim);
    const gv = { reason: "ok", placeholder: false, inappropriate: false, secret: false, manipulation: false, on_task: "yes", confidence: 0.9 };
    const stale = (await one(db, "select challenge_task_check_record($1, gen_random_uuid(), $2, $3::jsonb, '[]') r", [it.submission_id, it.version, JSON.stringify({ verdict: gv })])).r;
    ok("Q3 a stale token changes nothing", stale.reason === "stale", stale);
    const rec = (await one(db, "select challenge_task_check_record($1, $2, $3, $4::jsonb, $5::jsonb) r",
      [it.submission_id, it.token, it.version, JSON.stringify({ verdict: gv }), JSON.stringify([{ provider: "openai", model: "gpt-5-mini", cost_usd: 0.001 }])])).r;
    ok("Q4 a clean general verdict: accepted, +5 (paid at the Telegram time), the call is costed",
      rec.decision === "accepted" && rec.submission?.points === 5 && await count(db, "select count(*) n from challenge_task_ai_calls") === 1, rec);
    ok("Q5 the instagram submission is leased with its handle snapshot", igClaim?.handle === "kid_twentyfive", igClaim);
    const iv = { reason: "r", is_instagram_screenshot: true, handle_seen: "@kid_twentyfiv", tag_seen: true, post_age_text: "2 soat", posted_recently: "yes",
                 inappropriate: false, manipulation: false, confidence: 0.9 };
    const igr = (await one(db, "select challenge_task_check_record($1, $2, $3, $4::jsonb, '[]') r",
      [igClaim.submission_id, igClaim.token, igClaim.version, JSON.stringify({ verdict: iv, link_status: "ok", dhash: ["ffffffffffffff00"] })])).r;
    ok("Q6 instagram: one misread character is tolerated -> accepted, +8, the shortcode claimed once-ever",
      igr.decision === "accepted" && igr.submission?.points === 8 && await count(db, "select count(*) n from challenge_ig_posts where shortcode = 'SHORTcode01'") === 1, igr);
    // another student: same shortcode -> needs_more ig_link_reused; old post -> rejected
    await db.query(`update profiles set instagram_username = 'real_handle' where id = $1`, [ST(29)]);
    const rs = await cap(db, tgm({ from: TG(29), at: "2026-10-07T12:00:00", photo: "ig29", caption: "https://instagram.com/reel/SHORTcode01" }));
    ok("Q7 a shortcode already paid is refused: needs_more 'ig_link_reused'", rs.submission?.status === "needs_more" &&
      rs.submission?.reason === "ig_link_reused", rs);
    const rs2 = await cap(db, tgm({ from: TG(29), at: "2026-10-07T12:02:00", text: "https://www.instagram.com/p/NEWcode029/" }));
    ok("Q8 ...a new link completes it -> checking", rs2.outcome === "appended" && rs2.submission?.status === "checking", rs2);
    const c29 = (await one(db, "select challenge_task_check_claim(10) r")).r.items.find((i: Row) => i.submission_id === rs2.submission.id);
    const old = (await one(db, "select challenge_task_check_record($1, $2, $3, $4::jsonb, '[]') r",
      [c29.submission_id, c29.token, c29.version, JSON.stringify({ verdict: { ...iv, handle_seen: "real_handle", posted_recently: "no", confidence: 0.9 }, link_status: "ok" })])).r;
    ok("Q9 posted_recently=no at confidence 0.9: rejected 'ig_post_old' (attempts left shown)", old.decision === "rejected" &&
      old.submission?.reason === "ig_post_old" && old.submission?.attempts_left === 2, old);
    await db.query(`update profiles set instagram_username = 'another_one' where id = $1`, [ST(26)]);
    const sh2 = await cap(db, tgm({ from: TG(26), at: "2026-10-07T13:00:00", text: "https://www.instagram.com/p/CODEtwentysix/" }));
    const c26 = (await one(db, "select challenge_task_check_claim(10) r")).r.items.find((i: Row) => i.submission_id === sh2.submission.id);
    const mis = (await one(db, "select challenge_task_check_record($1, $2, $3, $4::jsonb, '[]') r",
      [c26.submission_id, c26.token, c26.version, JSON.stringify({ verdict: { ...iv, handle_seen: "somebody_else", confidence: 0.95 }, link_status: "ok" })])).r;
    ok("Q10 a handle that is not the student's: rejected 'ig_handle_mismatch'", mis.submission?.reason === "ig_handle_mismatch", mis);

    // fail-open: a general checking item with no verdict for 60 minutes; instagram never
    const fo = await cap(db, tgm({ from: TG(19), at: "2026-10-08T11:00:00", text: "Bugun o'rganganlarim: prompt yozish va natijani tekshirish usullari" }));
    ok("Q11 ai=true: text-only work waits in 'checking' (no hold)", fo.submission?.status === "checking" && fo.submission?.hold_reason === null, fo);
    const later = new Date(Date.now() + 2 * 3600_000).toISOString();
    const hb = await reconcile(db, later);
    ok("Q12 after fail_open_after_min with no verdict, GENERAL work is accepted 'fail_open'", hb.fail_open >= 1 &&
      (await subOf(db, ST(19), TTHU)).status === "accepted" && (await subOf(db, ST(19), TTHU)).reason === "fail_open", hb);
    await cfgSet(db, "ai", false);

    // expire: needs_more whose task closed
    const hb2 = await reconcile(db, "2026-11-01T00:00:00+05:00");
    ok("Q13 needs_more work whose task closed is 'expired'", hb2.expired >= 1 &&
      await count(db, "select count(*) n from challenge_task_submissions where status = 'needs_more'") === 0, hb2);
    ok("Q14 user_xp equals the ledger", await userXpOk(db));
  }

  // ───────────── H. health + watchdog ─────────────
  console.log("H. health and the watchdog");
  {
    const h = (await one(db, "select challenge_tasks_health() h")).h;
    ok("H1 health: invariants all zero after everything above", h.invariants.ledger_drift === 0 && h.invariants.streak_awards_without_xp === 0 &&
      h.invariants.topic_points_leak_24h === 0 && h.invariants.live_duplicates === 0, h.invariants);
    ok("H2 health carries every counter the watchdog reads", ["retry", "held_24h", "username_match_unlinked_24h", "rate_limited_24h", "topic_missing_24h",
      "legacy_swaps_7d", "handle_changes_7d", "ig_link_unverified_7d", "fingerprint_unavailable_7d", "misplaced_homework_autotag_24h",
      "held_checks", "checks", "groups", "paused_messages_24h"].every((k) => k in h), Object.keys(h));
    // a leak: challenge media paid on a daily-topic message
    await db.query(`insert into group_message_events (group_id, profile_id, telegram_user_id, telegram_chat_id, telegram_message_id, telegram_thread_id, sent_at)
                    values ($1, $2, 2001, $3, 424242, $4, now())`, [G1, ST(1), CH1, D1]);
    await db.query("insert into xp_events (user_id, amount, reason, ref_key, created_at) values ($1, 5, 'challenge_group_media', $2, now())", [ST(1), `ch_img:${CH1}:424242`]);
    ok("H3 a media award on a daily-topic message is counted as topic_points_leak_24h",
      (await one(db, "select challenge_tasks_health()->'invariants'->>'topic_points_leak_24h' n")).n === "1");
    await db.query("delete from xp_events where ref_key = $1", [`ch_img:${CH1}:424242`]);
    await db.query("select challenge_task_rebuild_user_xp($1)", [ST(1)]);

    await reconcile(db);
    const calls0 = await count(db, "select count(*) n from ops_net_calls");
    const sat = (await one(db, "select challenge_tasks_watchdog('2026-10-10T12:00:00+05:00') r")).r;
    ok("H4 Saturday (a rest day, no task): no 'no_task_today' / 'post_missing' alarm", !sat.alarms.includes("no_task_today") &&
      !sat.alarms.includes("post_missing"), sat.alarms);
    const thu1 = (await one(db, "select challenge_tasks_watchdog('2026-10-01T10:00:00+05:00') r")).r;
    ok("H4b a weekday BEFORE the first approved task (Thu 2026-10-01; the calendar starts Mon 10-05): not a task day, no alarm",
      !thu1.alarms.includes("no_task_today"), thu1.alarms);
    const mon = (await one(db, "select challenge_tasks_watchdog('2026-10-19T10:00:00+05:00') r")).r;
    const calls1 = await count(db, "select count(*) n from ops_net_calls");
    const call = await one(db, "select * from ops_net_calls order by id desc limit 1");
    ok("H5 a TASK day with no approved task: 'no_task_today', DM'd to the admin through ops_net_post with Content-Type",
      mon.alarms.includes("no_task_today") && calls1 > calls0 && call.headers["Content-Type"] === "application/json" &&
      call.purpose === "challenge-tasks-watchdog" && call.body.chat_id === 1011, { alarms: mon.alarms, call });
    const mon2 = (await one(db, "select challenge_tasks_watchdog('2026-10-19T10:30:00+05:00') r")).r;
    ok("H6 the same alarm 30 minutes later is not DM'd again (24 h dedupe)", mon2.alarms.includes("no_task_today") && mon2.dm_sent === 0 &&
      await count(db, "select count(*) n from ops_net_calls") === calls1, mon2.new_alarms);
    await db.query(`insert into admin_actions (action, details) values ('challenge_bot_status_changed', $1::jsonb)`,
      [JSON.stringify({ chat: CH1, old_status: "administrator", new_status: "member", can_delete_messages: false })]);
    const bs = (await one(db, "select challenge_tasks_watchdog('2026-10-19T10:40:00+05:00') r")).r;
    ok("H7 the bot demoted in a scope chat: an immediate 'bot_status' alarm (a NEW alarm is DM'd)", bs.alarms.includes("bot_status") &&
      bs.new_alarms.includes("bot_status") && bs.dm_sent === 1, bs.alarms);
    ok("H8 every run leaves 'challenge_tasks_watchdog_run' and stamps checked_at",
      await count(db, "select count(*) n from admin_actions where action = 'challenge_tasks_watchdog_run'") >= 4 &&
      (await one(db, "select value->>'checked_at' c from app_settings where key = 'challenge_tasks_watchdog_state'")).c !== null);
  }

  // ───────────── V. guard v2 and the handle lock ─────────────
  console.log("V. guard v2 (tasks lock) and the Instagram handle lock");
  {
    const e1 = await as(db, AD, "update challenge_tasks set requires = '[]' where id = $1", [TMON]);
    ok("V1 a task with live submissions: requires can no longer change", !!e1.err && /o‘zgartirib bo‘lmaydi/.test(e1.err), e1.err);
    const e2 = await as(db, AD, "update challenge_tasks set title = 'Yangi sarlavha' where id = $1 returning title", [TMON]);
    ok("V2 ...its wording can", e2.err === null, e2.err);
    const e3 = await as(db, AD, "update challenge_tasks set status = 'draft' where id = $1", [TMON]);
    ok("V3 ...it cannot be un-approved (only cancelled)", !!e3.err && /qoralamaga qaytarib bo‘lmaydi/.test(e3.err), e3.err);
    const fresh = await addTask("2026-10-20", "general", [SHOT], ["text", "photo", "document"]);
    const e4 = await as(db, AD, "update challenge_tasks set requires = $2::jsonb where id = $1", [fresh, JSON.stringify([SHOT, TEXT])]);
    ok("V4 a task nobody touched stays fully editable", e4.err === null, e4.err);
    const lock = await as(db, ST(25), "update profiles set instagram_username = 'new_handle' where id = $1", [ST(25)]);
    ok("V5 after an ACCEPTED instagram task the student cannot change their own handle", !!lock.err && /admin bilan bog‘laning/.test(lock.err), lock.err);
    const other = await as(db, ST(27), "update profiles set instagram_username = 'free_to_change' where id = $1 returning instagram_username", [ST(27)]);
    ok("V6 a student without an accepted instagram task can", other.err === null && (other.rows as Row[])[0]?.instagram_username === "free_to_change", other);
    const adm = await as(db, AD, "update profiles set instagram_username = 'fixed_by_admin' where id = $1 returning instagram_username", [ST(25)]);
    ok("V7 an admin can always change it", adm.err === null && (adm.rows as Row[])[0]?.instagram_username === "fixed_by_admin", adm);
    const wa = await as(db, ST(3), "select my_telegram_write_access_granted() r");
    ok("V8 my_telegram_write_access_granted stamps the caller only", wa.err === null &&
      (await one(db, "select telegram_write_access_at is not null s from profiles where id = $1", [ST(3)])).s === true &&
      (await one(db, "select telegram_write_access_at is null s from profiles where id = $1", [ST(4)])).s === true, wa);
  }

  // ───────────── B. backfill ─────────────
  console.log("B. backfill (retro credit)");
  {
    const old = tgm({ from: TG(8), at: "2026-10-02T12:00:00", photo: "retro8", caption: T25 });
    await inbox(db, old, "now() - interval '3 days'");
    const pre = await cap(db, old);
    ok("B1 before the retro task exists, the post is a no_slot row", pre.outcome === "no_slot" && pre.reason === "no_open_task", pre);
    const unk = tgm({ from: 9555, username: "someone", at: "2026-10-02T12:05:00", photo: "retro_unk", caption: T25 });
    await inbox(db, unk, "now() - interval '3 days'");
    await db.query(`insert into webhook_inbox (received_at, update_type, chat_id, message_id, from_user_id, chat_type, raw_update)
                    values (now() - interval '5 days', 'message', $1, 1, $1, 'private', '{}')`, [TG(8)]);
    const retro = await addTask("2026-10-02", "general", [SHOT, TEXT], ["text", "photo", "document"], "approved", "retro");
    const bf = (await one(db, "select challenge_tasks_backfill(now() - interval '4 days') r")).r;
    const s8 = await liveOf(db, ST(8), retro);
    ok("B2 the backfill re-opens the no_slot row and credits it to the retro task (on time, +5)", bf.ok === true && bf.reopened_no_slot >= 1 &&
      s8?.status === "accepted" && s8.source === "backfill" && s8.points_awarded === 5, { bf, s8 });
    ok("B3 ...receipts suppressed (no group spam for old posts)", s8.receipt_state === "suppressed");
    ok("B4 ...one 'backfill_summary' DM queued for the DM-eligible student", await count(db,
      "select count(*) n from challenge_task_outbox where kind = 'backfill_summary' and user_id = $1", [ST(8)]) === 1);
    ok("B5 ...and the senders it still cannot resolve are reported", await count(db,
      "select count(*) n from admin_actions where action = 'challenge_task_backfill_unresolved' and details::text like '%9555%'") === 1);
    const bf2 = (await one(db, "select challenge_tasks_backfill(now() - interval '4 days') r")).r;
    ok("B6 a second backfill is a no-op (idempotent)", bf2.ok === true && (bf2.by_outcome.created ?? 0) === 0 &&
      await count(db, "select count(*) n from challenge_task_outbox where kind = 'backfill_summary'") === 1, bf2);
    ok("B7 final: user_xp equals the ledger; health invariants zero", await userXpOk(db) &&
      (await one(db, "select challenge_tasks_health()->'invariants'->>'ledger_drift' n")).n === "0");
  }

  // ───────────── Z. every remaining RPC runs on real rows (plpgsql checks columns only at run time) ─────────────
  console.log("Z. the remaining RPCs, end to end");
  {
    const card = (await one(db, "select challenge_task_card($1, $2) r", [TMON, TG(1)])).r;
    ok("Z1 challenge_task_card: the rendered post, the student's own topic URL, their status", card.ok === true &&
      card.text.includes("Yangi sarlavha") && card.topic_url === "https://t.me/c/4440955972/144" && card.submission?.status === "accepted", card);
    const res = await as(db, AD, "select admin_challenge_task_results($1) r", [TMON]);
    const rr = (res.rows as Row[])?.[0]?.r;
    ok("Z2 admin_challenge_task_results lists the task's submissions with names", res.err === null &&
      rr.submissions.length > 10 && rr.submissions.some((x: Row) => x.name === "Student 1" && x.points === 5), res.err ?? rr.submissions.length);
    const s2 = await liveOf(db, ST(2), TMON);
    const rej = await as(db, AD, `select admin_challenge_task_override($1, 'reject', '{"reason":"off_task"}'::jsonb) r`, [s2.id]);
    ok("Z3 admin override 'reject' removes the points, audited", rej.err === null && (rej.rows as Row[])[0].r.submission?.status === "rejected" &&
      (await xpOf(db, ST(2), `ch_task:${TMON}`)) === undefined, rej);
    const acc = await as(db, AD, "select admin_challenge_task_override($1, 'accept') r", [s2.id]);
    ok("Z4 admin override 'accept' pays again (the Telegram-time created_at)", acc.err === null && (acc.rows as Row[])[0].r.submission?.points === 5 &&
      new Date((await xpOf(db, ST(2), `ch_task:${TMON}`)).created_at).toISOString() === "2026-10-05T05:02:00.000Z", acc);
    const mv = await as(db, AD, "select admin_challenge_task_override($1, 'move', $2::jsonb) r", [s2.id, JSON.stringify({ task_id: TTUE })]);
    ok("Z5 admin override 'move' to a FUTURE task is refused like any move", mv.err === null && (mv.rows as Row[])[0].r.reason === "future_task", mv);
    const s12 = await liveOf(db, ST(34), TTUE);   // photo + caption: satisfies Monday (screenshot + text) too
    const myMove = await as(db, ST(34), "select my_challenge_task_move($1, $2) r", [s12.id, TMON]);
    ok("Z6 my_challenge_task_move (web / Mini App): Tuesday's work re-labelled as Monday's, late 1 (+3)", myMove.err === null &&
      (myMove.rows as Row[])[0].r.submission?.late_days === 1 && (myMove.rows as Row[])[0].r.submission?.points === 3, myMove);
    const myW = await as(db, ST(34), "select my_challenge_task_withdraw($1) r", [s12.id]);
    const myR = await as(db, ST(34), "select my_challenge_task_restore($1) r", [s12.id]);
    ok("Z7 my_challenge_task_withdraw / restore round-trip", myW.err === null && myR.err === null &&
      (myR.rows as Row[])[0].r.submission?.status === "accepted", [myW, myR]);

    const rc = (await one(db, "select challenge_task_receipt_claim(50) r")).r;
    const item = rc.items[0];
    ok("Z8 receipt_claim leases pending receipts (reconciler captures, corrections) with the reply target",
      rc.ok === true && rc.items.length >= 1 && !!item.token && item.receipt?.chat_id === CH1, rc.items.length);
    const rr2 = (await one(db, "select challenge_task_receipt_record($1, $2, $3, 9100, true, null, $4) r",
      [item.submission.id, item.receipt.version, CH1, item.token])).r;
    ok("Z9 receipt_record stores the sent message and version", rr2.ok === true &&
      String((await one(db, "select receipt_message_id from challenge_task_submissions where id = $1", [item.submission.id])).receipt_message_id) === "9100");
    const fr = (await one(db, "select challenge_task_receipt_record($1, 1, $2, null, false, 'Bad Request: message thread not found') r", [s2.id, CH1])).r;
    ok("Z10 a failed receipt is DB-visible (state failed + signal)", fr.ok === true &&
      (await one(db, "select receipt_state from challenge_task_submissions where id = $1", [s2.id])).receipt_state === "failed" &&
      await count(db, "select count(*) n from admin_actions where action = 'challenge_task_receipt_failed'") === 1);

    await db.query(`insert into challenge_task_posts (task_id, group_id, kind, state, chat_id, thread_id) values ($1, $2, 'task', 'queued', $3, $4)`,
      [T["2026-10-16"], G1, CH1, D1]);
    const pc = (await one(db, "select challenge_task_post_claim(5) r")).r;
    const pi = pc.items.find((x: Row) => x.task_id === T["2026-10-16"]);
    ok("Z11 post_claim leases a queued post with the SAME rendered text the approve guard measured", pc.ok === true && !!pi &&
      pi.text.startsWith("📅 <b>") && pi.text.includes("📍 Faqat shu «Kunlik vazifalar» topikiga yuboring"), pc);
    const pr = (await one(db, "select challenge_task_post_record($1, $2, 'task', $3, 9200) r", [pi.task_id, G1, pi.token])).r;
    const stale = (await one(db, "select challenge_task_post_record($1, $2, 'task', gen_random_uuid(), 9201) r", [pi.task_id, G1])).r;
    ok("Z12 post_record marks it sent (a stale token cannot)", pr.ok === true && stale.ok === false &&
      String((await one(db, "select message_id from challenge_task_posts where task_id = $1 and group_id = $2", [pi.task_id, G1])).message_id) === "9200");

    await cfgSet(db, "quiet_start", "00:00");
    await cfgSet(db, "quiet_end", "00:00");
    const oc = (await one(db, "select challenge_task_outbox_claim(10) r")).r;
    ok("Z13 outbox_claim leases the queued backfill summary with the student's Telegram id", oc.ok === true &&
      oc.items.some((x: Row) => x.kind === "backfill_summary" && Number(x.telegram_id) === TG(8)), oc);
    const ob = oc.items.find((x: Row) => x.kind === "backfill_summary");
    const orec = (await one(db, "select challenge_task_outbox_record($1, $2, true) r", [ob.id, ob.token])).r;
    ok("Z14 outbox_record marks it sent", orec.ok === true && (await one(db, "select state from challenge_task_outbox where id = $1", [ob.id])).state === "sent");
    await cfgSet(db, "quiet_start", "22:00");
    await cfgSet(db, "quiet_end", "08:00");

    const ip = (await one(db, "select challenge_task_identity_pending(20, now() - interval '30 days') r")).r;
    ok("Z15 identity_pending lists shaped unknown senders for the PR-5 sweep", Array.isArray(ip.unknown) &&
      ip.unknown.some((u: Row) => Number(u.tg_user_id) === 9555) && Array.isArray(ip.username_matched), ip);

    await cfgSet(db, "task_weekdays", "x");
    const bad = (await one(db, "select challenge_tasks_config() c")).c;
    ok("Z16 a malformed key falls back to its default and is listed in invalid[]", JSON.stringify(bad.task_weekdays) === "[1,2,3,4,5]" &&
      bad.invalid.includes("task_weekdays") && bad.active === true, bad.invalid);
    await cap(db, tgm({ from: TG(42), at: "2026-10-06T10:00:00", photo: "z42" }));
    await cap(db, tgm({ from: TG(43), at: "2026-10-06T10:00:00", photo: "z43" }));
    ok("Z17 ...one 'challenge_task_config_invalid' row per Tashkent day, however many captures",
      await count(db, "select count(*) n from admin_actions where action = 'challenge_task_config_invalid'") === 1);
    await cfgSet(db, "task_weekdays", [1, 2, 3, 4, 5]);

    // recovery: a clean run after an alert that went out
    await db.query(`insert into admin_actions (action, details, created_at) values ('challenge_task_reconciled', '{"active":true,"section_errors":{}}', '2026-10-10T12:00:00+05:00')`);
    await db.query(`insert into admin_actions (action, details) values ('challenge_bot_status_changed', $1::jsonb)`,
      [JSON.stringify({ chat: CH1, old_status: "member", new_status: "administrator", can_delete_messages: true })]);
    const calls0 = await count(db, "select count(*) n from ops_net_calls");
    const clean = (await one(db, "select challenge_tasks_watchdog('2026-10-10T12:20:00+05:00') r")).r;
    const last = await one(db, "select body from ops_net_calls order by id desc limit 1");
    ok("Z18 all clear after an alert: ONE recovery DM", clean.state === "ok" && clean.recovered === true &&
      await count(db, "select count(*) n from ops_net_calls") === calls0 + 1 && String(last.body.text).startsWith("✅"), { alarms: clean.alarms });
    const clean2 = (await one(db, "select challenge_tasks_watchdog('2026-10-10T12:30:00+05:00') r")).r;
    ok("Z19 ...and silence after that", clean2.state === "ok" && clean2.dm_sent === 0);
    ok("Z20 final: user_xp equals the ledger; every invariant is zero", await userXpOk(db) &&
      Object.values((await one(db, "select challenge_tasks_health()->'invariants' i")).i).every((v) => Number(v) === 0));
  }

  await db.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) throw new Error(`daily_tasks_engine: ${fail} check(s) failed`);
}
