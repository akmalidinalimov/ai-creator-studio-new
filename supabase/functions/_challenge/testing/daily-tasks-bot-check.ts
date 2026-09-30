// PGlite harness for the BOT side of the daily tasks (Daily Tasks PR-4): the real telegram-bot-webhook modules
// (daily-tasks.ts → daily-task-dispatch.ts → _shared/daily-task-render.ts → the shared resolveGroupPoster) driven
// against the REAL PR-3 SQL engine on a real PostgreSQL.
//
//   deno test -A --node-modules-dir=none --no-lock supabase/functions/_challenge/testing/daily-tasks-bot-check.ts
//
// The world is a VERBATIM copy of daily-tasks-engine-check.ts (PR-3's harness: #218 + PR-1 + PR-2 + the LIVE
// fixtures, pinned clock), then 20260930150020 applies. The bot runs through a small PostgREST-shaped adapter over
// PGlite (rpc = the SECURITY DEFINER functions called AS service_role, so their grants are exercised; from() = the
// few table reads / admin_actions writes the bot makes) and a RECORDING Bot API sender (no network). It proves the
// CONTRACT between the payloads the engine returns and what the bot renders / sends / records:
//   INERT (enabled=false: handled:false, nothing written, nothing sent); a created submission → ONE reply receipt,
//   recorded with Telegram's message id; the extra item → a reaction, never a second receipt; the dt: buttons the
//   renderer builds are accepted by the engine's _by_tg RPCs (owner lock refuses a classmate with a friendly toast;
//   withdraw → undo; move to yesterday → late points on the edited receipt); a held sender's once-a-day hint (no
//   button); wrong group (thread 10 shared by 5- and 6-GURUH routed by chat); an unknown work-shaped sender →
//   resolveGroupPoster → registrar → second capture with the welcome folded into the receipt; an edit completing a
//   needs_more submission refreshes its receipt; /start dt_<id>; my_chat_member → health bot_status; and every
//   invariant stays zero.
//
// CI NOTE: named *-check.ts (never *_test.ts) so CI's `deno test supabase/functions/` never collects it. Run it by path.
// TEST INFRASTRUCTURE ONLY: this directory has no index.ts, so it is never deployed.
import { createDailyTasks, type SendFn } from "../../telegram-bot-webhook/daily-tasks.ts";
import type { SendResultOutcome } from "../../_shared/telegram-send.ts";
import { parseDtCallback } from "../../_shared/daily-task-render.ts";

// ═══ BEGIN VERBATIM: daily-tasks-engine-check.ts, the fixture world (keep identical) ═══
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
// The weekly freeze, so the frozen-week rule is tested against the key production REALLY writes: the LIVE
// freeze_challenge_week body (md5-verified fixture, run with the server's UTC session time zone, as cron runs it) on
// production's challenge_weekly_results constraint. Its two point sources are STUBS -- only the week key and the
// audit row are under test here, never the ranking.
const FREEZE_WORLD = `
alter table public.challenge_weekly_results add constraint uq_challenge_weekly unique nulls not distinct (week_start, kind, group_id, user_id);
create function public.user_group_rating_xp_since(_user uuid, _course uuid, _since timestamptz) returns integer language sql stable
  as $$ select coalesce(sum(e.amount), 0)::int from public.xp_events e where e.user_id = _user and e.created_at >= _since $$;
create function public.challenge_team_board(_from timestamptz, _to timestamptz)
  returns table (group_id uuid, group_name text, members integer, total_points bigint, avg_points numeric) language sql stable
  as $$ select g.id, g.name, 0, 0::bigint, 0::numeric from public.groups g where g.id in (select public.challenge_scope_group_ids()) $$;
`;
const FREEZE_LIVE_MD5 = "e676d00e2c1fdac5436a479c5957f1c6"; // md5(replace(prosrc, E'\r', '')) read live 2026-09-30
// ═══ END VERBATIM ═══

// What the BOT reads beyond PR-3's world: the profile columns resolveGroupPoster / findProfileByTelegramId select.
const BOT_EXTRA = `
alter table public.profiles add column if not exists last_name text, add column if not exists telegram_onboarded_at timestamptz,
  add column if not exists preferred_locale text;
`;

Deno.test({
  name: CAN_RUN
    ? "daily_tasks_bot: the bot modules against the REAL engine on PGlite (receipts, corrections, identity, edits, card, bot status)"
    : "daily_tasks_bot: SKIPPED -- needs `deno test -A --node-modules-dir=none` (PGlite reads its own files)",
  ignore: !CAN_RUN,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: run,
});

// ── the pinned clock: PGlite's now() reads Date.now(), so one fixed calendar for the whole run (restored at the end) ──
const realDateNow = Date.now.bind(Date);
let clockBase = Date.parse("2026-09-30T12:00:00Z"), clockT0 = realDateNow();
const setClock = (iso: string) => { clockBase = Date.parse(iso); clockT0 = realDateNow(); };

async function run() {
  (Date as any).now = () => clockBase + (realDateNow() - clockT0);
  try { await runPinned(); } finally { (Date as any).now = realDateNow; }
}

async function runPinned() {
  // ═══ BEGIN VERBATIM: daily-tasks-engine-check.ts runPinned() setup (keep identical) ═══
  const spec = "npm:@electric-sql/pglite@0.5.8"; // non-literal: never resolved or type-checked unless this runs
  const { PGlite } = (await import(spec)) as any;
  const { citext } = (await import(spec + "/contrib/citext")) as any;

  const MIG_PATH = Deno.env.get("MIG_PATH");
  const MIG = lf(await Deno.readTextFile(MIG_PATH ?? here("../../../migrations/20260930150020_challenge_daily_tasks_engine.sql")));
  const PR2 = lf(await Deno.readTextFile(here("../../../migrations/20260930122010_challenge_daily_tasks_calendar.sql")));
  const PR1 = lf(await Deno.readTextFile(here("../../../migrations/20260930121000_challenge_daily_task_topic.sql")));
  const MIG218 = lf(await Deno.readTextFile(here("../../../migrations/20260930100010_challenge_social_points.sql")));
  const RCX_LIVE = lf(await Deno.readTextFile(here("./reconcile_challenge_xp.live-2026-09-30.sql")));
  const COMMUNITY_LIVE = lf(await Deno.readTextFile(here("./reconcile_community_xp.live-2026-09-30.sql")));
  const INTEGRITY_LIVE = lf(await Deno.readTextFile(here("./xp_award_integrity_watchdog.live-2026-09-30.sql")));
  const FREEZE_LIVE = lf(await Deno.readTextFile(here("./freeze_challenge_week.live-2026-09-30.sql")));

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
    await db.exec(FREEZE_WORLD);
    await db.exec(FREEZE_LIVE + ";\nrevoke execute on function public.freeze_challenge_week(date) from public;\n" +
      "grant execute on function public.freeze_challenge_week(date) to service_role;");
    const fm = (await db.query("select md5(replace(prosrc, E'\\r', '')) m from pg_proc where oid = 'public.freeze_challenge_week(date)'::regprocedure")).rows[0] as Row;
    if (fm.m !== FREEZE_LIVE_MD5) throw new Error(`the freeze_challenge_week fixture is not the live body (md5 ${fm.m})`);
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
  // ═══ END VERBATIM ═══
  // ═══════════════════════════════ the BOT against the engine ═══════════════════════════════
  // ── a PostgREST-shaped adapter over PGlite. rpc(): the function called AS service_role (so the engine's grants are
  //    exercised exactly as the bot's service-role client meets them); from(): the bot's few table reads and its
  //    admin_actions writes (as the owner — production's service_role bypasses RLS the same way). One lane: the
  //    role switch can never interleave between two concurrent calls (loadDaily runs two RPCs in parallel). ──
  function pgAdmin(db: PG) {
    let lane: Promise<unknown> = Promise.resolve();
    const serial = <T>(fn: () => Promise<T>): Promise<T> => {
      const p = lane.then(fn, fn);
      lane = p.catch(() => undefined);
      return p;
    };
    const SETOF = new Set(["challenge_task_topics"]);
    const val = (v: unknown) => (v !== null && typeof v === "object" && !Array.isArray(v) ? JSON.stringify(v) : v);
    const pgErr = (e: unknown) => ({ code: String((e as any)?.code ?? "P0001"), message: String((e as Error)?.message ?? e) });
    const ident = (c: string) => {
      const m = /^([a-z_][a-z0-9_]*)(?:->>([a-z_][a-z0-9_]*))?$/.exec(c.trim());
      if (!m) throw new Error("adapter: bad column " + c);
      return m[2] ? `${m[1]}->>'${m[2]}'` : m[1];
    };
    const cols = (s: string) => s.trim() === "*" ? "*" : s.split(",").map(ident).join(", ");
    const rpc = (name: string, args: Record<string, unknown> = {}) => serial(async () => {
      if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error("adapter: bad rpc " + name);
      const keys = Object.keys(args);
      for (const k of keys) if (!/^_[a-z_]+$/.test(k)) throw new Error("adapter: bad arg " + k);
      const named = keys.map((k, i) => `${k} => $${i + 1}`).join(", ");
      const sql = SETOF.has(name) ? `select * from public.${name}(${named})` : `select public.${name}(${named}) as r`;
      await db.exec("set role service_role");
      try {
        const rows = (await db.query(sql, keys.map((k) => val(args[k])))).rows;
        return { data: SETOF.has(name) ? rows : (rows[0]?.r ?? null), error: null };
      } catch (e) {
        return { data: null, error: pgErr(e) };
      } finally {
        await db.exec("reset role");
      }
    });
    const from = (table: string) => {
      if (!/^[a-z_]+$/.test(table)) throw new Error("adapter: bad table " + table);
      const st = { op: "select", cols: "*", where: [] as string[], params: [] as unknown[], limit: null as number | null,
                   payload: null as Row | null, returning: null as string | null };
      const p = (v: unknown) => { st.params.push(val(v)); return `$${st.params.length}`; };
      const exec = (single: boolean) => serial(async () => {
        try {
          const where = st.where.length ? ` where ${st.where.join(" and ")}` : "";
          let sql: string;
          if (st.op === "insert") {
            const ks = Object.keys(st.payload!);
            sql = `insert into public.${table} (${ks.map(ident).join(", ")}) values (${ks.map((k) => p(st.payload![k])).join(", ")})`;
          } else if (st.op === "update") {
            const ks = Object.keys(st.payload!);
            sql = `update public.${table} set ${ks.map((k) => `${ident(k)} = ${p(st.payload![k])}`).join(", ")}${where}` +
              (st.returning ? ` returning ${cols(st.returning)}` : "");
          } else {
            sql = `select ${cols(st.cols)} from public.${table}${where}${st.limit !== null ? ` limit ${st.limit}` : ""}`;
          }
          const rows = (await db.query(sql, st.params)).rows;
          if (st.op === "insert" || (st.op === "update" && !st.returning)) return { data: null, error: null };
          return { data: single ? (rows[0] ?? null) : rows, error: null };
        } catch (e) {
          return { data: null, error: pgErr(e) };
        }
      });
      const b: any = {
        select: (c: string) => { if (st.op === "select") st.cols = c; else st.returning = c; return b; },
        insert: (row: Row) => { st.op = "insert"; st.payload = row; return exec(false); },
        update: (row: Row) => { st.op = "update"; st.payload = row; return b; },
        eq: (c: string, v: unknown) => { st.where.push(`${ident(c)} = ${p(v)}`); return b; },
        is: (c: string, v: unknown) => { if (v !== null) throw new Error("adapter: is() only null"); st.where.push(`${ident(c)} is null`); return b; },
        not: (c: string, op: string, v: unknown) => {
          if (op !== "is" || v !== null) throw new Error("adapter: not() only 'is null'");
          st.where.push(`${ident(c)} is not null`);
          return b;
        },
        gte: (c: string, v: unknown) => { st.where.push(`${ident(c)} >= ${p(v)}`); return b; },
        in: (c: string, arr: unknown[]) => { st.where.push(`${ident(c)}::text = any(string_to_array(${p(arr.map(String).join(","))}, ','))`); return b; },
        ilike: (c: string, v: string) => { st.where.push(`${ident(c)}::text ilike ${p(v)}`); return b; },
        or: (expr: string) => {
          const parts = expr.split(",").map((x) => {
            const m = /^([a-z_]+)\.ilike\.(.+)$/.exec(x.trim());
            if (!m) throw new Error("adapter: or() only col.ilike.value");
            return `${ident(m[1])}::text ilike ${p(m[2])}`;
          });
          st.where.push(`(${parts.join(" or ")})`);
          return b;
        },
        order: () => b,
        limit: (n: number) => { st.limit = Number(n); return b; },
        maybeSingle: () => exec(true),
        then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => exec(false).then(res, rej),
      };
      return b;
    };
    return { rpc, from };
  }

  const okOut = (klass: SendResultOutcome["klass"] = "ok", extra: Partial<SendResultOutcome> = {}): SendResultOutcome => {
    const good = klass === "ok" || klass === "not_modified";
    return { ok: good, status: good ? 200 : 429, error: good ? null : klass, klass, retryAfterSec: null,
             terminal: ["recipient", "content", "topic_missing", "message_gone"].includes(klass), recipient: klass === "recipient",
             content: klass === "content", ...extra };
  };

  const db = await freshDb();
  await db.exec(BOT_EXTRA);
  {
    const e = await tx(db, MIG);
    if (e !== null) throw new Error(`daily_tasks_bot: the engine migration did not apply -- ${e}`);
  }
  const admin = pgAdmin(db);

  // the calendar (same shapes as the engine harness): Mon screenshot + text, Tue screenshot
  const SHOT = { any: ["photo", "image_doc"], min: 1, label: "screenshot" };
  const TEXT = { any: ["text"], min: 1, label: "text" };
  const addTask = async (date: string, requires: unknown, accepts: string[]) =>
    Number((await one(db, `insert into challenge_tasks (course_id, task_date, type, title, body, accepts, requires, status, source)
                           values ($1, $2, 'general', $3, 'Vazifa matni', $4::text[], $5::jsonb, 'approved', 'manual') returning id`,
      [C6, date, `Vazifa ${date}`, `{${accepts.join(",")}}`, JSON.stringify(requires)])).id);
  const TMON = await addTask("2026-10-05", [SHOT, TEXT], ["text", "photo", "document"]);
  const TTUE = await addTask("2026-10-06", [SHOT], ["text", "photo", "document"]);

  // ── the bot: the REAL modules, a recording sender, a registrar stub (what admin-create-students does for a member) ──
  let botNow = 1_000_000;
  let nextMid = 50_000;
  const sent: { method: string; payload: Row; opts: Row }[] = [];
  let script: ((method: string, payload: Row) => { outcome: SendResultOutcome; result: unknown } | null) | null = null;
  const send: SendFn = (method, payload, opts) => {
    sent.push({ method, payload, opts: opts ?? {} });
    const r = script?.(method, payload) ?? null;
    return Promise.resolve(r ?? { outcome: okOut(), result: method === "sendMessage" ? { message_id: nextMid++ } : true });
  };
  const answers: { id: string; text?: string }[] = [];
  const registered: string[] = [];
  const bot = createDailyTasks({
    send,
    answerCallback: (id, text) => { answers.push({ id, text }); return Promise.resolve(); },
    botUsername: () => "aicreatorsdarsliklari_bot",
    autoRegister: async (_a, msg, grp) => {
      const id = crypto.randomUUID();
      await db.query("insert into auth.users values ($1)", [id]);
      await db.query("insert into profiles (id, group_id, telegram_id, name, telegram_username, account_type) values ($1, $2, $3, $4, $5, 'provisional')",
        [id, grp.id, msg.from.id, msg.from.first_name, msg.from.username ?? null]);
      registered.push(id);
      return { profile: { id, name: msg.from.first_name }, created: true };
    },
    magicLink: () => Promise.resolve("https://example.test/auth/magic?t=x"),
    now: () => botNow,
  });
  const since = () => sent.length;
  const sentFrom = (i: number) => sent.slice(i);
  const everyCallbackOk = (kb: Row | undefined) =>
    ((kb?.inline_keyboard ?? []) as Row[][]).every((row) => row.every((btn) =>
      btn.url ? /^https:\/\/t\.me\//.test(btn.url) : (new TextEncoder().encode(btn.callback_data).length <= 44 && parseDtCallback(btn.callback_data) !== null)));
  const tap = async (data: string, tg: number, msgId: number) => {
    const n = answers.length;
    await bot.onCallback(admin, { id: `cb${n}`, data, from: { id: tg }, message: { message_id: msgId, chat: { id: CH1, type: "supergroup" } } });
    return answers[n]?.text;
  };

  // ───────────── BI. inert ─────────────
  console.log("BI. inert: challenge_tasks.enabled=false (PR-1's seed)");
  {
    const m = tgm({ from: TG(1), at: "2026-10-05T10:00:00", photo: "bi1", caption: T25 });
    const r = await bot.onGroupMessage(admin, m);
    ok("BI1 handled:false → today's handler runs; the engine was never asked", r.handled === false && sent.length === 0 &&
      await count(db, "select count(*) n from challenge_task_messages") === 0, r);
    const mcm = await bot.dailyTopicUrlFor(admin, G1);
    ok("BI2 the U1 hint gets no daily-topic button while inactive", mcm === null);
  }
  await cfgSet(db, "enabled", true);
  botNow += 61_000; // past the 60-s snapshot

  // ───────────── BA. a submission → one receipt, recorded ─────────────
  console.log("BA. created → one reply receipt, recorded with the Bot API message id");
  let subA = 0, receiptA = 0;
  {
    const m = tgm({ from: TG(1), at: "2026-10-05T10:00:00", photo: "ba1", caption: T25 });
    const i = since();
    const r = await bot.onGroupMessage(admin, m);
    const out = sentFrom(i);
    const s = await liveOf(db, ST(1), TMON);
    subA = Number(s?.id);
    ok("BA1 handled, outcome created, the submission accepted +5", r.handled && r.outcome === "created" && s?.status === "accepted" &&
      (await xpOf(db, ST(1), `ch_task:${TMON}`))?.amount === 5, { r, s: s?.status });
    ok("BA2 exactly one Bot API call: the reply receipt, in the topic, replying to the post",
      out.length === 1 && out[0].method === "sendMessage" && out[0].payload.chat_id === CH1 && out[0].payload.message_thread_id === D1 &&
      out[0].payload.reply_parameters?.message_id === m.message_id && out[0].opts.topicMissingAction === "challenge_task_topic_missing", out);
    ok("BA3 the owner's copy", out[0]?.payload.text === "✅ Bugungi vazifa qabul qilindi: +5 ball.", out[0]?.payload.text);
    ok("BA4 the buttons: 'Bu topshiriq emas' for THIS submission, every callback valid (<= 44 bytes)",
      JSON.stringify(out[0]?.payload.reply_markup) === JSON.stringify({ inline_keyboard: [[{ text: "❌ Bu topshiriq emas", callback_data: `dt:x:${subA}` }]] }) &&
      everyCallbackOk(out[0]?.payload.reply_markup), out[0]?.payload.reply_markup);
    receiptA = nextMid - 1;
    const rs = await one(db, "select receipt_state, receipt_message_id, receipt_sent_version, receipt_version from challenge_task_submissions where id = $1", [subA]);
    ok("BA5 recorded: receipt_state sent, the message id stored, sent version = version",
      rs.receipt_state === "sent" && Number(rs.receipt_message_id) === receiptA && rs.receipt_sent_version === rs.receipt_version, rs);
    const m2 = tgm({ from: TG(1), at: "2026-10-05T10:01:00", photo: "ba2" });
    const j = since();
    const r2 = await bot.onGroupMessage(admin, m2);
    const out2 = sentFrom(j);
    ok("BA6 the second screenshot joins the SAME submission: a 👍 reaction, never a second receipt",
      r2.outcome === "appended" && out2.length === 1 && out2[0].method === "setMessageReaction" &&
      out2[0].payload.reaction?.[0]?.emoji === "👍" && out2[0].opts.record === false, out2);
    const dup = await bot.onGroupMessage(admin, m);
    ok("BA7 a replay (Telegram re-delivery) is 'duplicate': nothing sent again", dup.outcome === "duplicate" && sent.length === j + 1, dup);
  }

  // ───────────── BC. the dt: buttons → the engine's _by_tg RPCs ─────────────
  console.log("BC. corrections: the owner lock, withdraw → undo");
  {
    const x = `dt:x:${subA}`;
    const i = since();
    const t1 = await tap(x, TG(2), receiptA);
    ok("BC1 a classmate's tap: a friendly toast, nothing edited, nothing changed",
      t1 === "Bu boshqa o‘quvchining ishi 🙂" && sent.length === i && (await liveOf(db, ST(1), TMON))?.status === "accepted", t1);
    const t2 = await tap(x, TG(1), receiptA);
    const out = sentFrom(i);
    const s = await subOf(db, ST(1), TMON);
    ok("BC2 the owner's tap: withdrawn, points removed, the receipt edited in place to show the undo button",
      t2 === "❌ Hisobdan chiqarildi. Qaytarish uchun «↩️ Qaytarish»." && s.status === "withdrawn" &&
      (await xpOf(db, ST(1), `ch_task:${TMON}`)) === undefined && out.length === 1 && out[0].method === "editMessageText" &&
      out[0].payload.message_id === receiptA &&
      JSON.stringify(out[0].payload.reply_markup) === JSON.stringify({ inline_keyboard: [[{ text: "↩️ Qaytarish", callback_data: `dt:r:${subA}` }]] }),
      { t2, st: s.status, out });
    ok("BC3 ...and recorded (sent version caught up)", s.receipt_state === "sent" && s.receipt_sent_version === s.receipt_version, s);
    const t3 = await tap(`dt:r:${subA}`, TG(1), receiptA);
    const back = await liveOf(db, ST(1), TMON);
    ok("BC4 undo: accepted again with its +5, the receipt shows the accepted copy",
      t3 === "↩️ Qaytarildi" && back?.status === "accepted" && (await xpOf(db, ST(1), `ch_task:${TMON}`))?.amount === 5 &&
      sent[sent.length - 1].payload.text === "✅ Bugungi vazifa qabul qilindi: +5 ball.", { t3, st: back?.status });
    const t4 = await tap(`dt:r:${subA}`, TG(1), receiptA);
    ok("BC5 a stale second undo: 'already counts', friendly", t4 === "Bu ish allaqachon hisobda.", t4);
  }

  console.log("BM. move to yesterday's task via the rendered button");
  {
    const m = tgm({ from: TG(3), at: "2026-10-06T11:00:00", photo: "bm1", caption: T25 }); // meets Monday's requires too
    const i = since();
    await bot.onGroupMessage(admin, m);
    const rc = sentFrom(i)[0];
    const s = await liveOf(db, ST(3), TTUE);
    const move = ((rc?.payload.reply_markup?.inline_keyboard ?? []) as Row[][]).flat().find((b) => b.text === "↩️ Kechagi uchun");
    ok("BM1 Tuesday's work gets '↩️ Kechagi uchun' pointing at Monday's task", !!move && move.callback_data === `dt:m:${s?.id}:${TMON}` &&
      everyCallbackOk(rc?.payload.reply_markup), rc?.payload.reply_markup);
    const t = await tap(move!.callback_data, TG(3), nextMid - 1);
    const moved = await liveOf(db, ST(3), TMON);
    ok("BM2 moved: Monday's task, LATE (1 day) = 3 points; Tuesday's points gone; the receipt shows the late copy",
      t === "✅ Ko‘chirildi" && moved?.late_days === 1 && (await xpOf(db, ST(3), `ch_task:${TMON}`))?.amount === 3 &&
      (await xpOf(db, ST(3), `ch_task:${TTUE}`)) === undefined &&
      sent[sent.length - 1].payload.text === "✅ Kechagi vazifa (5-oktabr) uchun qabul qilindi, +3 ball (kechikkan — yarim ball).",
      { t, moved: moved?.late_days, text: sent[sent.length - 1].payload.text });
    // a move is RE-JUDGED against the target's requires: a bare screenshot moved onto Monday (screenshot + text)
    await bot.onGroupMessage(admin, tgm({ from: TG(6), at: "2026-10-06T11:30:00", photo: "bm3" }));
    const s6 = await liveOf(db, ST(6), TTUE);
    const t6 = await tap(`dt:m:${s6?.id}:${TMON}`, TG(6), nextMid - 1);
    ok("BM3 ...a bare screenshot moved onto Monday's 'screenshot + text' task is needs_more, and the receipt asks for the text",
      t6 === "✅ Ko‘chirildi" && (await liveOf(db, ST(6), TMON))?.status === "needs_more" &&
      sent[sent.length - 1].payload.text === "✍️ Kechagi vazifa (5-oktabr) uchun yana kerak: qisqa matn (izoh). Shu topikka yuboring — o‘zi qo‘shiladi.",
      sent[sent.length - 1].payload.text);
  }

  // ───────────── BH / BW. held and wrong-group hints ─────────────
  console.log("BH. held sender and wrong group: once-a-day hints");
  {
    const i = since();
    const h1 = await bot.onGroupMessage(admin, tgm({ from: 1020, at: "2026-10-05T12:00:00", photo: "bh1", caption: T25 }));
    const out = sentFrom(i);
    ok("BH1 a held member (no group) gets the neutral hint once — NO button — and no row", h1.handled && h1.outcome === "no_group" &&
      out.length === 1 && out[0].payload.text.startsWith("📌 No, ishingizni hisoblash uchun") && out[0].payload.reply_markup === undefined &&
      await count(db, "select count(*) n from challenge_task_messages where tg_user_id = 1020") === 0, { h1, out });
    const j = since();
    await bot.onGroupMessage(admin, tgm({ from: 1020, at: "2026-10-05T12:05:00", photo: "bh2", caption: T25 }));
    ok("BH2 ...and nothing the second time that day", sent.length === j);
    const k = since();
    const w = await bot.onGroupMessage(admin, tgm({ from: 1007, at: "2026-10-05T12:10:00", photo: "bw1", caption: T25 }));
    const wo = sentFrom(k);
    ok("BW1 a 2-GURUH student in 1-GURUH's topic: wrong_group, one hint with a button to HIS OWN topic",
      w.outcome === "wrong_group" && wo.length === 1 &&
      wo[0].payload.reply_markup?.inline_keyboard?.[0]?.[0]?.url === "https://t.me/c/4390902020/99", wo);
    const l = since();
    const y1 = await bot.onGroupMessage(admin, tgm({ chat: CH10, thread: 10, from: 1061, at: "2026-10-05T12:20:00", photo: "by1", caption: T25 }));
    const y2 = await bot.onGroupMessage(admin, tgm({ chat: CH9, thread: 10, from: 1061, at: "2026-10-05T12:21:00", photo: "by2", caption: T25 }));
    ok("BW2 thread 10 is routed by CHAT: 5-GURUH's student in 6-GURUH's topic 10 = wrong_group; in his own topic 10 = created",
      y1.outcome === "wrong_group" && y2.outcome === "created" &&
      sentFrom(l)[0]?.payload.reply_markup?.inline_keyboard?.[0]?.[0]?.url === "https://t.me/c/4396568866/10", { y1, y2 });
  }

  // ───────────── BN. an unknown member's work → identity → registration → welcome ─────────────
  console.log("BN. unknown work-shaped sender → resolveGroupPoster → registrar → second capture with the welcome");
  {
    const m = tgm({ from: 7777, username: "yangi_talaba", at: "2026-10-05T13:00:00", photo: "bn1", caption: T25 });
    const i = since();
    const r = await bot.onGroupMessage(admin, m);
    const out = sentFrom(i);
    const uid = registered[0];
    ok("BN1 registered once, captured on the second pass, accepted", registered.length === 1 && r.outcome === "created" &&
      (await liveOf(db, uid, TMON))?.status === "accepted", { r, registered });
    ok("BN2 the welcome is folded into the ONE receipt, with the group-safe bot button",
      out.length === 1 && out[0].payload.text.startsWith("👋 <b>X</b>, siz AI Creators platformasiga qo‘shildingiz (sinov hisobi).") &&
      out[0].payload.text.endsWith("✅ Bugungi vazifa qabul qilindi: +5 ball.") &&
      ((out[0].payload.reply_markup?.inline_keyboard ?? []) as Row[][]).flat()
        .some((b) => b.url === `https://t.me/aicreatorsdarsliklari_bot?start=dt_${TMON}`) &&
      (await one(db, "select receipt_carries_welcome w from challenge_task_submissions where user_id = $1", [uid])).w === true, out);
    const j = since();
    const shy = await bot.onGroupMessage(admin, tgm({ from: 7778, at: "2026-10-05T13:05:00", text: "rahmat" }));
    ok("BN3 an unknown sender's chatter (not work-shaped): silent, no registration", shy.handled && registered.length === 1 && sent.length === j, shy);
  }

  // ───────────── BE. an edit completes a needs_more submission ─────────────
  console.log("BE. edited_message: the engine re-judges, the bot refreshes the receipt");
  {
    const m = tgm({ from: TG(4), at: "2026-10-05T14:00:00", photo: "be1" });
    const i = since();
    await bot.onGroupMessage(admin, m);
    const rc = sentFrom(i)[0];
    const rid = nextMid - 1;
    ok("BE1 a screenshot without its text: needs_more, the receipt says what is missing",
      rc?.payload.text === "✍️ Bugungi vazifa uchun yana kerak: qisqa matn (izoh). Shu topikka yuboring — o‘zi qo‘shiladi." &&
      (await liveOf(db, ST(4), TMON))?.status === "needs_more", rc?.payload.text);
    const j = since();
    await bot.onEdited(admin, { ...m, caption: T25, edit_date: m.date + 60 });
    const out = sentFrom(j);
    ok("BE2 the student adds the caption by EDITING: accepted +5, the same receipt edited to the accepted copy",
      (await liveOf(db, ST(4), TMON))?.status === "accepted" && (await xpOf(db, ST(4), `ch_task:${TMON}`))?.amount === 5 &&
      out.length === 1 && out[0].method === "editMessageText" && out[0].payload.message_id === rid &&
      out[0].payload.text === "✅ Bugungi vazifa qabul qilindi: +5 ball.", out);
  }

  // ───────────── BR. a rate-limited receipt stays for the worker ─────────────
  console.log("BR. a 429 on the receipt: not recorded, left 'sending' for the PR-5 worker");
  {
    script = (method) => method === "sendMessage" ? { outcome: okOut("rate_limited", { retryAfterSec: 7 }), result: null } : null;
    await bot.onGroupMessage(admin, tgm({ from: TG(5), at: "2026-10-05T15:00:00", photo: "br1", caption: T25 }));
    script = null;
    const s = await liveOf(db, ST(5), TMON);
    ok("BR1 receipt_state 'sending' (re-claimed by challenge_task_receipt_claim after 5 min), never 'failed'",
      s?.status === "accepted" && s?.receipt_state === "sending" && s?.receipt_message_id === null, s);
  }

  // ───────────── BS. /start dt_<id> ─────────────
  console.log("BS. /start dt_<id>: the task card");
  {
    const i = since();
    const answered = await bot.onStart(admin, { message_id: 1, chat: { id: TG(1), type: "private" }, from: { id: TG(1) } }, `dt_${TMON}`, "uz", { id: ST(1) });
    const out = sentFrom(i);
    ok("BS1 one DM: the rendered post, the student's status, where to submit + a button to HIS group's topic",
      answered && out.length === 1 && out[0].payload.chat_id === TG(1) && out[0].payload.text.includes("<b>Vazifa 2026-10-05</b>") &&
      out[0].payload.text.includes("✅ Sizning ishingiz qabul qilingan: +5 ball.") &&
      out[0].payload.reply_markup?.inline_keyboard?.[0]?.[0]?.url === "https://t.me/c/4440955972/144", out[0]?.payload);
  }

  // ───────────── BB. my_chat_member → health bot_status ─────────────
  console.log("BB. my_chat_member → 'challenge_bot_status_changed' → health bot_status");
  {
    await bot.onMyChatMember(admin, { chat: { id: CH1, type: "supergroup" }, from: { id: 1 }, date: 1,
      old_chat_member: { status: "administrator" }, new_chat_member: { status: "member", can_manage_topics: false } });
    await bot.onMyChatMember(admin, { chat: { id: -100555, type: "supergroup" }, from: { id: 1 }, date: 1,
      old_chat_member: { status: "member" }, new_chat_member: { status: "administrator" } });
    const g1 = ((await one(db, "select challenge_tasks_health()->'groups' g")).g as Row[]).find((g) => g.group_id === G1);
    ok("BB1 recorded for the daily-topic chat only; health reads it (the watchdog alarms on a non-admin)",
      await count(db, "select count(*) n from admin_actions where action = 'challenge_bot_status_changed'") === 1 &&
      g1?.bot_status?.status === "member", g1);
  }

  // ───────────── BZ. the ledger stays whole ─────────────
  console.log("BZ. invariants");
  {
    const inv = (await one(db, "select challenge_tasks_health()->'invariants' i")).i as Row;
    ok("BZ1 every health invariant is zero; user_xp equals the ledger", await userXpOk(db) && Object.values(inv).every((v) => Number(v) === 0), inv);
    ok("BZ2 the bot never recorded a capture failure", await count(db, "select count(*) n from admin_actions where action = 'challenge_task_capture_failed'") === 0);
    ok("BZ3 every receipt the bot sent is recorded (only BR's rate-limited one waits for the worker)",
      await count(db, "select count(*) n from challenge_task_submissions where receipt_state in ('pending','sending','failed')") === 1);
  }
  await db.close();

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) throw new Error(`daily_tasks_bot: ${fail} check(s) failed`);
}
