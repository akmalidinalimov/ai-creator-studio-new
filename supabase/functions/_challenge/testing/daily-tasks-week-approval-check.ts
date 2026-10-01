// PGlite harness for the WEEKLY TELEGRAM APPROVAL (Daily Tasks PR-9): migration 20260930200010 (the settings merge,
// the ledger, challenge_tasks_week_approval_tick, the claim / record RPCs, challenge_tasks_approve_week, the view, the
// health and the watchdog's new alarms) plus the edge code that reads it -- challenge-tasks-worker's {mode:
// 'week_approval'} run (runWorker -> week-approval.ts) and the bot's dtw: buttons (telegram-bot-webhook/week-approval.ts)
// -- against the REAL PR-2 / PR-3 / PR-5 SQL on a real PostgreSQL.
//
//   deno test -A --node-modules-dir=none --no-lock supabase/functions/_challenge/testing/daily-tasks-week-approval-check.ts
//   (WEEK_MIG_PATH=<file> points it at a draft of the migration)
//
// The world is a VERBATIM copy of daily-tasks-worker-check.ts's (itself PR-3's harness: #218 + PR-1 + PR-2 + the LIVE
// fixtures, pinned clock) and its PostgREST-shaped adapter; then 20260930150020 (PR-3) and 20260930152010 (PR-5) apply,
// auth.uid() / auth.role() take their LIVE definitions (the approve RPC's claims handling depends on them), and THIS
// PR's migration applies. Two admins have a telegram_id (the recipients); a superadmin-only account and an admin with no
// telegram_id are not recipients.
//
//   A0 the migration: over the LIVE PR-5 watchdog body (md5-pinned), replays clean, the settings merge keeps every other
//      key and never overwrites an owner's 'approval';
//   A1 INERT: paused -> a heartbeat stamp only (nothing queued, sent or kicked), the worker sends nothing;
//   A2 timing: Thursday 11:59 no ask, 12:00 ask (one per admin, ledger, audit, ONE kick), the worker sends the listing
//      (weekday + date, type, points, «Topshirish:», both buttons); dedupe; Saturday 19:00 one reminder, not twice;
//   A3 the bot: dtw:a -> confirm, refusals (a student, an impersonating admin, a forged date), dtw:y as the REAL admin
//      -> every draft approved THROUGH the guard with approved_by = that admin, the tapped message + every other copy
//      edited, recorded; a second tap -> «allaqachon tasdiqlangan»; after it: no Sunday reminder (no draft left);
//   A4 the RPC: anon / a student / a forged actor / a service call without an actor refused; the web path (authenticated
//      admin); a guard-rejected draft reported in failed[] while the others are approved; claims restored after the call;
//      idempotent; Saturday + Sunday reminders while a draft remains;
//   A5 a go-live on Friday asks at once; A6 quiet hours (a go-live at 23:00 asks at 08:00); A7 approval.enabled = false;
//   A8 a week with no task -> one «vazifa yo‘q» note; A9 claim edges: expired / nothing-to-approve rows skipped;
//   A10 undelivered: a 429 then terminal errors -> 'challenge_week_approval_undelivered' once; the watchdog alarms
//      'week_approval_undelivered' only after 2 h (never at night) and 'week_approval_silent' on a stale heartbeat;
//   A12 past days (review fix): a mid-week tap approves today and later only (past drafts in skipped_past, marked and
//      left out of N in the confirm), the web path includes today, a week that is over approves nothing (bot and RPC),
//      and a student's streak is unchanged through all of it; A11 invariants run last.
//
// CI NOTE: named *-check.ts (never *_test.ts) so CI's `deno test supabase/functions/` never collects it. Run it by path.
// TEST INFRASTRUCTURE ONLY: this directory has no index.ts, so it is never deployed.
import { runWorker, type WorkerEnv } from "../../challenge-tasks-worker/worker.ts";
import type { SendFn } from "../../challenge-tasks-worker/registrar.ts";
import type { SendResultOutcome } from "../../_shared/telegram-send.ts";
import { createWeekApproval } from "../../telegram-bot-webhook/week-approval.ts";
import { BTN } from "../../_shared/week-approval.ts";

// ═══ BEGIN VERBATIM: daily-tasks-worker-check.ts lines 42-329 (itself daily-tasks-engine-check.ts's fixture world; keep identical) ═══
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

// What the BOT reads beyond PR-3's world (a verbatim copy of daily-tasks-bot-check.ts's BOT_EXTRA).
const BOT_EXTRA = `
alter table public.profiles add column if not exists last_name text, add column if not exists telegram_onboarded_at timestamptz,
  add column if not exists preferred_locale text;
`;

// What the WORKER / TICK need beyond that: the locale + updated_at columns the worker and the username link write, the
// two secret readers the tick's kick calls (stubs: never a real credential), pg_net's response table (filled by hand),
// the intake kid's student role (the gated username link requires it), a real bot username for the buttons.
const WORKER_EXTRA = `
alter table public.profiles add column if not exists preferred_language text,
  add column if not exists updated_at timestamptz not null default now();
create function public.cron_service_key() returns text language sql as $$ select 'test-service-key' $$;
create function public.internal_fn_secret() returns text language sql as $$ select 'test-internal-secret' $$;
create schema if not exists net;
create table net._http_response (id bigint primary key, status_code integer, content text, error_msg text, timed_out boolean,
  created timestamptz not null default now());
`;
const WORKER_DATA = `
insert into public.user_roles (user_id, role) values ('${IU}', 'student');
update public.platform_settings set value = jsonb_set(value, '{bot_username}', '"aicreatorsdarsliklari_bot"') where key = 'telegram';
`;

Deno.test({
  name: CAN_RUN
    ? "daily_tasks_week_approval: the weekly Telegram approval against the REAL engine on PGlite (tick, RPC, worker, bot, watchdog)"
    : "daily_tasks_week_approval: SKIPPED -- needs `deno test -A --node-modules-dir=none` (PGlite reads its own files)",
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
  // ═══════════════════════════════ the WORKER + the TICK against the engine ═══════════════════════════════
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
    // arrays of numbers (the sweep's _exclude bigint[]) as a Postgres array literal; objects as json
    const val = (v: unknown) => (Array.isArray(v) && v.every((x) => typeof x === "number") ? `{${v.join(",")}}`
      : v !== null && typeof v === "object" ? JSON.stringify(v) : v);
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
          const rest = (v: unknown) => !(v instanceof Date) ? v
            : v.getHours() === 0 && v.getMinutes() === 0 && v.getSeconds() === 0 && v.getMilliseconds() === 0
              ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`
              : v.toISOString();
          const rows = ((await db.query(sql, st.params)).rows as Row[])
            .map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, rest(v)])));
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

  // ═══════════════════════════════ the WEEKLY APPROVAL against the engine ═══════════════════════════════
  const WMIG = lf(await Deno.readTextFile(here("../../../migrations/20260930152010_challenge_daily_tasks_worker.sql")));
  const AMIG_PATH = Deno.env.get("WEEK_MIG_PATH");
  const AMIG = lf(await Deno.readTextFile(AMIG_PATH ?? here("../../../migrations/20260930200010_challenge_tasks_week_approval.sql")));
  const PR5_WATCHDOG_MD5 = "ab091a8a4dfba493296490c558d6d198"; // live md5(replace(prosrc, E'\r', '')) read 2026-09-30 (= PR-5's _new_pin)
  const PINNED_NEW = /_new_pin constant text := '([0-9a-fPENDING_NEW]+)'/.exec(AMIG)?.[1] ?? "";

  const db = await freshDb();
  await db.exec(BOT_EXTRA);
  await db.exec(WORKER_EXTRA);
  for (const [name, sql] of [["PR-3", MIG], ["PR-5", WMIG]]) {
    const e = await tx(db, sql);
    if (e !== null) throw new Error(`daily_tasks_week_approval: ${name} did not apply -- ${e}`);
  }
  await db.exec(WORKER_DATA);
  // the LIVE auth.uid() / auth.role() (2026-09-30): claim.sub first, then the claims json
  await db.exec(`
    create or replace function auth.uid() returns uuid language sql stable as $$
      select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $$;
    create or replace function auth.role() returns text language sql stable as $$
      select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''),
                      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'))::text $$;
    grant execute on function auth.uid() to anon, authenticated, service_role;
    grant execute on function auth.role() to anon, authenticated, service_role;
    grant usage on schema auth to service_role;`);
  // admins: AD (tg 1011) + AD2 (tg 1012) are the recipients; SA (superadmin only) and AD3 (no telegram_id) are not
  const AD2 = U(31), SA = U(32), AD3 = U(33);
  await db.exec(`
    insert into auth.users values ('${AD2}'), ('${SA}'), ('${AD3}');
    insert into public.profiles (id, group_id, telegram_id, name) values ('${AD2}', null, 1012, 'Bahrom'), ('${SA}', null, 1013, 'Super'),
      ('${AD3}', null, null, 'No TG');
    update public.profiles set name = 'Admin' where id = '${AD}';
    insert into public.user_roles (user_id, role) values ('${AD2}', 'admin'), ('${SA}', 'superadmin'), ('${AD3}', 'admin');`);

  const wdMd5 = async () => String((await one(db, "select md5(replace(prosrc, E'\\r', '')) m from pg_proc where oid = 'public.challenge_tasks_watchdog(timestamptz)'::regprocedure")).m);
  const settings = async () => (await one(db, "select value v from platform_settings where key = 'challenge_tasks'")).v as Row;

  // ───────────── A0. the migration ─────────────
  console.log("A0. the migration: pinned watchdog rewrite, replay, the settings merge");
  {
    ok("A0a the PR-5 watchdog body in this world IS the live one (md5)", await wdMd5() === PR5_WATCHDOG_MD5, await wdMd5());
    const before = await settings();
    const e = await tx(db, AMIG);
    const m = await wdMd5();
    console.log(`     challenge_tasks_watchdog md5 after the rewrite: ${m} (pinned: ${PINNED_NEW})`);
    ok("A0b 20260930200010 applies (prerequisites, tables, functions, rewrite, grants, setting, cron, self-test, audit)", e === null, e);
    ok("A0c the rewritten watchdog md5 is the pinned one", m === PINNED_NEW, { m, PINNED_NEW });
    const after = await settings();
    const { approval, ...rest } = after;
    // jsonb orders keys its own way: compare canonically (keys sorted, recursively)
    const canon = (v: unknown): string => JSON.stringify(v, (_k, x) => x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, (x as Row)[k]])) : x);
    ok("A0d the setting is MERGED: approval = the defaults, every other key identical",
      canon(approval) === canon({ enabled: true, ask_dow: 4, ask_time: "12:00", remind_dows: [6, 7], remind_time: "19:00" }) &&
      canon(rest) === canon(before) && Object.keys(after).length === Object.keys(before).length + 1, approval);
    await db.query(`update platform_settings set value = jsonb_set(value, '{approval,ask_dow}', '5') where key = 'challenge_tasks'`);
    const e2 = await tx(db, AMIG);
    ok("A0e replay: applies again, watchdog untouched, one cron row, one audit row, the owner's edit NOT overwritten",
      e2 === null && await wdMd5() === m &&
      await count(db, "select count(*) n from cron.job where jobname = 'challenge-tasks-week-approval' and schedule = '*/5 * * * *'") === 1 &&
      await count(db, "select count(*) n from admin_actions where action = 'challenge_tasks_week_approval_applied'") === 1 &&
      (await settings()).approval.ask_dow === 5, e2);
    await db.query(`update platform_settings set value = jsonb_set(value, '{approval,ask_dow}', '4') where key = 'challenge_tasks'`);
    const acl = await q(db, `select p.proname, coalesce(array_to_string(p.proacl, ','), '') acl from pg_proc p
      where p.proname in ('challenge_tasks_approve_week', 'challenge_tasks_week_approval_tick', 'challenge_task_week_view',
                          'challenge_task_week_msg_claim', 'challenge_task_week_msg_record', 'challenge_task_week_edits_record',
                          'challenge_task_week_approval_health')`);
    ok("A0f ACLs: never PUBLIC / anon; authenticated only on the approve RPC", acl.length === 7 && acl.every((r) =>
      /service_role=X/.test(r.acl) && !/(^|,)=/.test(r.acl) && !/(^|,)anon=/.test(r.acl) &&
      /(^|,)authenticated=/.test(r.acl) === (r.proname === "challenge_tasks_approve_week")), acl);
    const st = await as(db, ST(1), "select challenge_tasks_week_approval_tick() r");
    const rd = await as(db, ST(1), "select count(*) n from challenge_task_week_approval_messages");
    const ad = await as(db, AD, "select count(*) n from challenge_task_week_approval_messages");
    ok("A0g a student can neither run the tick nor read the ledger (RLS); an admin can read it",
      st.err !== null && /permission denied/.test(st.err) && rd.err === null && Number((rd.rows as Row[])[0].n) === 0 && ad.err === null,
      { st: st.err, rd, ad: ad.err });
    const rec = await q(db, "select user_id, telegram_id from challenge_task_week_recipients() order by telegram_id");
    ok("A0h recipients: the two admins with a telegram_id (never the superadmin-only account, never an admin without one)",
      rec.length === 2 && rec.map((r) => Number(r.telegram_id)).join(",") === "1011,1012", rec);
  }

  // ── the harness's clock, SQL helpers, the worker and the bot ──
  const utc = (local: string) => new Date(Date.parse(local + "+05:00")).toISOString();
  const at = (local: string) => setClock(utc(local));
  const tick = async () => (await one(db, "select challenge_tasks_week_approval_tick() r")).r as Row;
  const state = async () => (await one(db, "select value v from app_settings where key = 'challenge_tasks_week_approval_state'"))?.v as Row;
  const kicks = async () => await q(db, "select * from ops_net_calls where purpose = 'challenge-tasks-week-approval' order by id");
  const msgs = async (week: string, kind?: string) =>
    await q(db, `select * from challenge_task_week_approval_messages where week_start = $1 ${kind ? "and kind = $2" : ""} order by id`,
      kind ? [week, kind] : [week]);
  const ledger = async (week: string) => await one(db, "select * from challenge_task_week_approvals where week_start = $1", [week]);
  const audits = async (action: string) => await q(db, "select * from admin_actions where action = $1 order by created_at, id", [action]);
  const health = async () => (await one(db, "select challenge_task_week_approval_health() h")).h as Row;
  const watchdog = async () => (await one(db, "select challenge_tasks_watchdog() w")).w as Row;
  const SHOT = { any: ["photo", "image_doc"], min: 1, label: "screenshot" };
  const TEXT = { any: ["text"], min: 1, label: "text" };
  const IGL = { any: ["ig_link"], min: 1, label: "ig_link" };
  const addTask = async (date: string, o: { type?: string; requires?: unknown; accepts?: string[]; status?: string; title?: string } = {}) =>
    Number((await one(db, `insert into challenge_tasks (course_id, task_date, type, title, body, accepts, requires, status, source)
                           values ($1, $2, $3, $4, 'Vazifa matni', $5::text[], $6::jsonb, $7, 'import') returning id`,
      [C6, date, o.type ?? "general", o.title ?? `Vazifa ${date}`, `{${(o.accepts ?? ["text", "photo", "document"]).join(",")}}`,
       JSON.stringify(o.requires ?? [SHOT, TEXT]), o.status ?? "draft"])).id);
  const claimsAs = async (claims: Row | null, role: string, sql: string, params: unknown[] = []): Promise<{ rows: Row[] | null; err: string | null }> => {
    await db.exec(`select set_config('request.jwt.claims', '${claims ? JSON.stringify(claims) : ""}', false)`);
    await db.exec(`set role ${role}`);
    try { return { rows: (await db.query(sql, params)).rows as Row[], err: null }; }
    catch (e) { return { rows: null, err: String((e as Error).message) }; }
    finally { await db.exec("reset role"); await db.exec("select set_config('request.jwt.claims', '', false)"); }
  };

  // the service-role client: PostgREST sets request.jwt.claims {role: service_role} (no sub) for the service key
  const base = pgAdmin(db);
  const admin = {
    from: base.from,
    rpc: async (name: string, args: Record<string, unknown> = {}) => {
      await db.exec(`select set_config('request.jwt.claims', '{"role":"service_role"}', false)`);
      try { return await base.rpc(name, args); }
      finally { await db.exec("select set_config('request.jwt.claims', '', false)"); }
    },
  };
  const sent: { method: string; payload: Row; opts: Row }[] = [];
  let script: ((method: string, payload: Row) => { outcome: SendResultOutcome; result: unknown } | null) | null = null;
  let nextMid = 90_000;
  const send: SendFn = (method, payload, opts) => {
    sent.push({ method, payload, opts: opts ?? {} });
    const r = script?.(method, payload) ?? null;
    return Promise.resolve(r ?? { outcome: okOut(), result: method === "sendMessage" ? { message_id: nextMid++ } : true });
  };
  const since = () => sent.length;
  const sentFrom = (i: number, method?: string) => sent.slice(i).filter((s) => !method || s.method === method);
  let virt = 0;
  const ENV: WorkerEnv = { botToken: "123:TESTTOKEN", botUsername: "aicreatorsdarsliklari_bot", supabaseUrl: "https://example.test", serviceKey: "svc" };
  const work = (req: Row = { mode: "week_approval" }) => runWorker(ENV, {
    admin, send, fetchFn: fetch, now: () => Date.now() + virt, sleep: (ms) => { virt += ms; return Promise.resolve(); },
  }, req);
  const toasts: Array<string | undefined> = [];
  const bot = createWeekApproval({
    send,
    answerCallback: (_id, text) => { toasts.push(text); return Promise.resolve(); },
    // index.ts: getPersona(admin, id) === "admin" (an exact 'admin' role row)
    isAdmin: async (_a, uid) => (await count(db, "select count(*) n from user_roles where user_id = $1 and role = 'admin'", [uid])) > 0,
  });
  const tap = (data: string, fromTg: number, clicker: string | null, msg: { chat: number; id: number }, impersonating = false) =>
    bot.onCallback(admin, { id: "cq", data, from: { id: fromTg }, message: { message_id: msg.id, chat: { id: msg.chat } } },
      { clicker: clicker ? { id: clicker } : null, impersonating });

  // week 1 (5-9 October): five drafts, Mon..Fri (the imported plan's shape)
  const W1 = "2026-10-05";
  const w1 = [] as number[];
  for (const d of ["05", "06", "07", "08", "09"]) w1.push(await addTask(`2026-10-${d}`, d === "06" ? { type: "instagram", requires: [SHOT, IGL], accepts: ["text", "photo", "document", "link"] } : {}));

  // ───────────── A1. INERT ─────────────
  console.log("A1. inert: challenge_tasks.enabled = false");
  at("2026-10-01T12:00:30");
  {
    const r = await tick();
    const st = await state();
    ok("A1a paused: 'inactive' + a heartbeat stamp", r.state === "inactive" && st?.state === "inactive" && !!st?.checked_at, { r, st });
    ok("A1b nothing queued, audited or kicked",
      await count(db, "select count(*) n from challenge_task_week_approval_messages") === 0 &&
      await count(db, "select count(*) n from challenge_task_week_approvals") === 0 && (await kicks()).length === 0 &&
      await count(db, "select count(*) n from admin_actions where action like 'challenge_week_approval%'") === 0);
    const i = since();
    const w = await work();
    ok("A1c a manual worker call while paused sends nothing", w.body.status === "inactive" && sentFrom(i).length === 0, w.body);
    const h = await health();
    ok("A1d health while paused: never an alarm", h.enabled === false && h.undelivered_alarm === false && h.silent === false, h);
  }
  await cfgSet(db, "enabled", true);

  // ───────────── A2. timing: Thursday 11:59 / 12:00, the worker, dedupe, the Saturday reminder ─────────────
  console.log("A2. Thursday 12:00 ask, the worker sends it, dedupe, the Saturday reminder");
  at("2026-10-01T11:59:30");
  {
    const r = await tick();
    ok("A2a Thursday 11:59: active, waiting for 12:00 -- nothing queued, no kick", r.state === "active" && Object.keys(r.out ?? {}).length === 0 &&
      r.week === W1 && (await kicks()).length === 0 && (await msgs(W1)).length === 0, r);
  }
  at("2026-10-01T12:00:30");
  {
    const r = await tick();
    const ms = await msgs(W1, "ask");
    const l = await ledger(W1);
    const a = await audits("challenge_week_approval_asked");
    ok("A2b 12:00: one ask per recipient admin (2), the ledger's asked_at, one audit row with the counts",
      r.out?.ask === 2 && ms.length === 2 && ms.every((m) => m.state === "pending") && [1011, 1012].every((c) => ms.some((m) => Number(m.chat_id) === c)) &&
      !!l?.asked_at && a.length === 1 && a[0].details.counts.drafts === 5 && a[0].details.recipients === 2, { r, ms, a });
    const k = await kicks();
    const h = k[0]?.headers ?? {};
    ok("A2c ONE kick through ops_net_post: the worker URL, Content-Type, the service bearer, x-internal-secret, mode week_approval",
      k.length === 1 && /\/functions\/v1\/challenge-tasks-worker$/.test(k[0].url) && h["Content-Type"] === "application/json" &&
      h["Authorization"] === "Bearer test-service-key" && h["x-internal-secret"] === "test-internal-secret" &&
      k[0].body?.mode === "week_approval" && k[0].timeout_ms === 60000, k[0]);
  }
  at("2026-10-01T12:05:30");
  {
    const r = await tick();
    ok("A2d 12:05: no second ask (ledger dedupe); the unsent messages get ONE retry kick (> 4 min)",
      Object.keys(r.out ?? {}).length === 0 && (await msgs(W1)).length === 2 && (await audits("challenge_week_approval_asked")).length === 1 &&
      (await kicks()).length === 2, r);
    const i = since();
    const w = await work();
    const out = sentFrom(i, "sendMessage");
    const t = String(out[0]?.payload.text ?? "");
    ok("A2e the worker sends both asks: HTML, to each admin's own chat, run row mode week_approval",
      out.length === 2 && out.every((s) => s.payload.parse_mode === "HTML" && s.opts.purpose === "challenge_week_approval_ask") &&
      [1011, 1012].every((c) => out.some((s) => s.payload.chat_id === c)) && w.body.status === "ok" && (w.body.week as Row)?.sent === 2 &&
      w.body.mode === "week_approval", w.body);
    ok("A2f the listing: the week label, every day (weekday + date), type, points (the post's own), «Topshirish:»",
      t.startsWith("📅 <b>Keyingi hafta vazifalari (5–9 oktabr)</b>") &&
      ["Du, 5-oktabr", "Se, 6-oktabr", "Ch, 7-oktabr", "Pa, 8-oktabr", "Ju, 9-oktabr"].every((d) => t.includes(`<b>${d}</b>`)) &&
      t.includes("<b>Du, 5-oktabr</b> · 📝 umumiy · 5 ball") && t.includes("<b>Se, 6-oktabr</b> · 📸 Instagram · 8 ball") &&
      t.includes("Topshirish: Skrinshot / rasm + Matn") && t.includes("Topshirish: Skrinshot / rasm + Instagram havolasi") &&
      t.includes("Jami: 5 ta qoralama.") && t.length <= 4000, t);
    const kb = out[0]?.payload.reply_markup;
    ok("A2g the buttons: [✅ Haftani tasdiqlash dtw:a:20261005] [👀 Ko‘rib chiqish -> the calendar on that week]",
      JSON.stringify(kb) === JSON.stringify({ inline_keyboard: [[{ text: BTN.approve, callback_data: "dtw:a:20261005" }],
        [{ text: BTN.review, url: "https://www.aicreator.academy/admin/challenge/tasks?week=2026-10-05" }]] }), kb);
    ok("A2h both rows 'sent' with Telegram's message id",
      (await msgs(W1, "ask")).every((m) => m.state === "sent" && Number(m.message_id) >= 90000 && m.sent_at !== null));
  }
  at("2026-10-01T12:10:30");
  {
    const r = await tick();
    ok("A2i 12:10: nothing pending -> no kick", r.kicked === false && r.pending === 0 && (await kicks()).length === 2, r);
  }
  at("2026-10-02T10:00:30");
  ok("A2j Friday: asked already, not a reminder day -> nothing", Object.keys((await tick()).out ?? {}).length === 0 && (await msgs(W1)).length === 2);
  at("2026-10-03T18:55:30");
  ok("A2k Saturday 18:55: before remind_time -> nothing", Object.keys((await tick()).out ?? {}).length === 0);
  at("2026-10-03T19:00:30");
  {
    const r = await tick();
    const rm = await msgs(W1, "remind");
    ok("A2l Saturday 19:00: ONE reminder per admin (drafts remain), reminded_on = [Saturday], audited",
      r.out?.remind === 2 && rm.length === 2 && JSON.stringify((await ledger(W1)).reminded_on) !== "[]" &&
      (await audits("challenge_week_approval_reminded")).length === 1, { r, l: await ledger(W1) });
    const i = since();
    await work();
    const out = sentFrom(i, "sendMessage");
    ok("A2m the reminder: «Eslatma: … hali tasdiqlanmagan (5–9 oktabr)» with the approve button",
      out.length === 2 && out.every((s) => String(s.payload.text).startsWith("⏰ <b>Eslatma: keyingi hafta vazifalari hali tasdiqlanmagan (5–9 oktabr)</b>") &&
        s.payload.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data === "dtw:a:20261005"), out.map((s) => s.payload.text));
  }
  at("2026-10-03T19:05:30");
  ok("A2n Saturday 19:05: not reminded twice", Object.keys((await tick()).out ?? {}).length === 0 && (await msgs(W1, "remind")).length === 2);

  // ───────────── A3. the bot's dtw: buttons against the real SQL ─────────────
  console.log("A3. the bot: confirm, refusals, the approval as the real admin, copies edited, a second tap");
  at("2026-10-03T20:00:30");
  const adAsk = (await msgs(W1, "ask")).find((m) => Number(m.chat_id) === 1011)!;
  const adMsg = { chat: 1011, id: Number(adAsk.message_id) };
  {
    const i = since();
    await tap("dtw:a:20261005", 1011, AD, adMsg);
    const e = sentFrom(i, "editMessageText");
    ok("A3a dtw:a -> the SAME message becomes «5 ta vazifa tasdiqlansinmi?» [✅ Ha, tasdiqlash] [↩️ Orqaga]",
      e.length === 1 && e[0].payload.message_id === adMsg.id && e[0].payload.chat_id === 1011 &&
      String(e[0].payload.text).includes("❓ <b>5 ta vazifa tasdiqlansinmi?</b>") &&
      JSON.stringify(e[0].payload.reply_markup) === JSON.stringify({ inline_keyboard: [[{ text: BTN.yes, callback_data: "dtw:y:20261005" },
        { text: BTN.back, callback_data: "dtw:b:20261005" }]] }), e[0]?.payload);
    const j = since();
    await tap("dtw:b:20261005", 1011, AD, adMsg);
    ok("A3b dtw:b -> back to the listing with the approve button", sentFrom(j, "editMessageText")[0]?.payload.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data === "dtw:a:20261005");
    const k = since();
    const t0 = toasts.length;
    await tap("dtw:y:20261005", 2001, ST(1), adMsg);                 // a student (a forwarded copy)
    await tap("dtw:y:20261005", 1011, AD, adMsg, true);             // the admin while impersonating
    await tap("dtw:y:20261006", 1011, AD, adMsg);                   // a forged / stale date (not a Monday)
    await tap("dtw:y:20261005", 1013, SA, { chat: 1013, id: 5 });  // superadmin-only: getPersona is not "admin"
    ok("A3c refused: a student, an impersonating admin, a forged date, a superadmin-only account -- toasts only, nothing approved",
      JSON.stringify(toasts.slice(t0)) === JSON.stringify(["⛔ Faqat admin uchun", "👁 Faqat o'qish — /admin", "Bu tugma eskirgan", "⛔ Faqat admin uchun"]) &&
      sentFrom(k).length === 0 && await count(db, "select count(*) n from challenge_tasks where status = 'approved'") === 0 &&
      (await audits("challenge_week_approved")).length === 0, toasts.slice(t0));
    ok("A3d the refusals are DB-visible (once per clicker per day)", (await audits("challenge_week_approval_refused")).length === 2);

    const m = since();
    await tap("dtw:y:20261005", 1011, AD, adMsg);
    const rows = await q(db, "select id, status, approved_by, approved_at, created_by from challenge_tasks where id = any($1::bigint[]) order by id", [`{${w1.join(",")}}`]);
    ok("A3e dtw:y as the REAL admin: all 5 drafts approved THROUGH the guard, approved_by = that admin",
      rows.length === 5 && rows.every((r) => r.status === "approved" && r.approved_by === AD && r.approved_at !== null && r.created_by === null), rows);
    const au = await audits("challenge_week_approved");
    ok("A3f audited: 'challenge_week_approved' actor AD, via telegram, approved 5, failed 0",
      au.length === 1 && au[0].actor_user_id === AD && au[0].details.via === "telegram" && au[0].details.approved === 5 &&
      au[0].details.failed_count === 0, au[0]?.details);
    const edits = sentFrom(m, "editMessageText");
    ok("A3g the tapped message -> «✅ … 5/5 tasdiqlandi … — Admin» with the review link only",
      edits[0]?.payload.message_id === adMsg.id && String(edits[0]?.payload.text).startsWith("✅ <b>Keyingi hafta vazifalari: 5/5 tasdiqlandi</b> (5–9 oktabr) — Admin") &&
      JSON.stringify(edits[0]?.payload.reply_markup) === JSON.stringify({ inline_keyboard: [[{ text: BTN.review, url: "https://www.aicreator.academy/admin/challenge/tasks?week=2026-10-05" }]] }),
      edits[0]?.payload);
    const others = edits.slice(1).map((e) => `${e.payload.chat_id}:${e.payload.message_id}`).sort();
    const want = (await msgs(W1)).filter((x) => !(Number(x.chat_id) === 1011 && Number(x.message_id) === adMsg.id))
      .map((x) => `${x.chat_id}:${x.message_id}`).sort();
    ok("A3h every OTHER copy (AD2's ask, both reminders) edited to the same result",
      JSON.stringify(others) === JSON.stringify(want) && edits.slice(1).every((e) => e.payload.text === edits[0].payload.text), { others, want });
    ok("A3i the edits are recorded: edited_at on every copy, one 'copies_updated' row",
      (await msgs(W1)).every((x) => x.edited_at !== null) && (await audits("challenge_week_approval_copies_updated")).length === 1 &&
      (await ledger(W1)).approved_by === AD);
    const n = since();
    await tap("dtw:y:20261005", 1012, AD2, { chat: 1012, id: Number((await msgs(W1, "ask")).find((x) => Number(x.chat_id) === 1012)!.message_id) });
    ok("A3j a second admin's (stale) tap: «Allaqachon tasdiqlangan», only that message edited, stamps unchanged",
      toasts.at(-1) === "Allaqachon tasdiqlangan" && sentFrom(n, "editMessageText").length === 1 &&
      String(sentFrom(n, "editMessageText")[0].payload.text).startsWith("ℹ️ <b>Bu hafta allaqachon tasdiqlangan") &&
      await count(db, "select count(*) n from challenge_tasks where id = any($1::bigint[]) and approved_by = $2", [`{${w1.join(",")}}`, AD]) === 5 &&
      (await audits("challenge_week_approved")).at(-1)?.details.noop === true);
  }
  at("2026-10-04T19:00:30");
  ok("A3k Sunday 19:00 after the approval: no reminder (no draft left)",
    Object.keys((await tick()).out ?? {}).length === 0 && (await msgs(W1, "remind")).length === 2);

  // ───────────── A4. the RPC ─────────────
  console.log("A4. the RPC: refusals, the web path, a guard-rejected draft, claims restored, idempotent; weekend reminders");
  const W2 = "2026-10-12";
  const t2mon = await addTask("2026-10-12");
  const t2bad = await addTask("2026-10-13", { type: "instagram", requires: [SHOT], accepts: ["text", "photo", "document", "link"], title: "IG xato" });
  const t2wed = await addTask("2026-10-14");
  at("2026-10-08T12:00:30");
  {
    const r = await tick();
    ok("A4a Thursday 8 Oct 12:00: the week-2 ask (3 drafts)", r.out?.ask === 2 && r.week === W2 && (await audits("challenge_week_approval_asked")).at(-1)?.details.counts.drafts === 3, r);
    await work();
  }
  at("2026-10-08T13:00:30");
  {
    const call = "select challenge_tasks_approve_week($1::date, $2::uuid) r";
    const anon = await claimsAs({ role: "anon" }, "anon", call, [W2, null]);
    const stud = await claimsAs({ sub: ST(1), role: "authenticated" }, "authenticated", call, [W2, null]);
    const forged = await claimsAs({ sub: AD, role: "authenticated" }, "authenticated", call, [W2, AD2]);
    const noActor = await claimsAs({ role: "service_role" }, "service_role", call, [W2, null]);
    const stActor = await claimsAs({ role: "service_role" }, "service_role", call, [W2, ST(1)]);
    const saActor = await claimsAs({ role: "service_role" }, "service_role", call, [W2, SA]);
    const notMonday = await claimsAs({ role: "service_role" }, "service_role", call, ["2026-10-13", AD]);
    ok("A4b refused: anon (no grant), a student, a forged actor, a service call without an actor / with a non-admin actor, a non-Monday",
      /permission denied/.test(anon.err ?? "") && /Faqat admin/.test(stud.err ?? "") && /not allowed/.test(forged.err ?? "") &&
      /_actor is required/.test(noActor.err ?? "") && /Faqat admin/.test(stActor.err ?? "") && /Faqat admin/.test(saActor.err ?? "") &&
      /dushanba/.test(notMonday.err ?? "") &&
      await count(db, "select count(*) n from challenge_tasks where task_date between '2026-10-12' and '2026-10-18' and status = 'approved'") === 0,
      { anon: anon.err, stud: stud.err, forged: forged.err, noActor: noActor.err, stActor: stActor.err, saActor: saActor.err, notMonday: notMonday.err });

    // the web path: an authenticated admin (the page passes its course)
    const web = await claimsAs({ sub: AD2, role: "authenticated" }, "authenticated",
      "select challenge_tasks_approve_week($1::date, null, $2::uuid) r", [W2, C6]);
    const res = (web.rows?.[0]?.r ?? {}) as Row;
    ok("A4c the web path: 2 approved, the guard-rejected instagram draft in failed[] with the guard's own words, 1 draft left",
      web.err === null && res.approved === 2 && res.already_approved === 0 && res.drafts_left === 1 && res.via === "web" &&
      res.failed?.length === 1 && res.failed[0].task_id === t2bad && res.failed[0].date === "2026-10-13" && res.failed[0].title === "IG xato" &&
      /Instagram vazifasi skrinshot va Instagram havolasini talab qilishi kerak/.test(res.failed[0].error), { err: web.err, res });
    const st2 = await q(db, "select id, status, approved_by from challenge_tasks where id = any($1::bigint[]) order by id", [`{${[t2mon, t2bad, t2wed].join(",")}}`]);
    ok("A4d approved_by = the web admin on the two that passed; the rejected one is still a draft, unstamped",
      st2.find((x) => Number(x.id) === t2mon)?.approved_by === AD2 && st2.find((x) => Number(x.id) === t2wed)?.approved_by === AD2 &&
      st2.find((x) => Number(x.id) === t2bad)?.status === "draft" && st2.find((x) => Number(x.id) === t2bad)?.approved_by === null, st2);

    // the service-role path inside ONE transaction: the claims are the caller's again after the call
    await db.exec("begin");
    await db.exec(`select set_config('request.jwt.claims', '{"role":"service_role"}', true)`);
    await db.exec("set local role service_role");
    const again = (await one(db, "select challenge_tasks_approve_week($1::date, $2::uuid) r", [W2, AD])).r as Row;
    const after = await one(db, "select auth.uid()::text u, auth.role() r, current_setting('request.jwt.claims', true) c, current_setting('request.jwt.claim.sub', true) s");
    await db.exec("commit");
    ok("A4e idempotent: a second call approves nothing new (already 2), the bad draft is reported again; nothing re-stamped",
      again.approved === 0 && again.already_approved === 2 && again.failed?.length === 1 && again.via === "telegram" &&
      await count(db, "select count(*) n from challenge_tasks where id = any($1::bigint[]) and approved_by = $2", [`{${[t2mon, t2wed].join(",")}}`, AD2]) === 2, again);
    ok("A4f the actor's claims were LOCAL to the loop: after the call auth.uid() is null again, auth.role() service_role",
      after.u === null && after.r === "service_role" && after.c === '{"role":"service_role"}' && (after.s ?? "") === "", after);
  }
  at("2026-10-10T19:00:30");
  ok("A4g Saturday 10 Oct 19:00: a draft remains -> reminder", (await tick()).out?.remind === 2);
  await work();
  at("2026-10-11T19:00:30");
  {
    const r = await tick();
    ok("A4h Sunday 11 Oct 19:00: still a draft -> reminder again (one per day)", r.out?.remind === 2 && (await msgs(W2, "remind")).length === 4, r);
    await work();
  }

  // ───────────── A5. a go-live on Friday asks at once ─────────────
  console.log("A5. go-live after Thursday 12:00 -> the ask at once");
  const W3 = "2026-10-19";
  await cfgSet(db, "enabled", false);
  await addTask("2026-10-19");
  await addTask("2026-10-20");
  at("2026-10-16T15:00:30");
  ok("A5a Friday 15:00 while paused: nothing", (await tick()).state === "inactive" && (await msgs(W3)).length === 0);
  await cfgSet(db, "enabled", true);
  at("2026-10-16T15:05:30");
  {
    const r = await tick();
    const a = (await audits("challenge_week_approval_asked")).at(-1);
    ok("A5b the first run after go-live asks immediately (27 hours after Thursday 12:00)",
      r.out?.ask === 2 && r.week === W3 && a?.details.late_min === 27 * 60 + 5, { r, late: a?.details.late_min });
    const st = await state();
    ok("A5c the heartbeat's active_since is the go-live run", st.active_since === st.checked_at, st);
    await work();
  }

  // ───────────── A6. quiet hours ─────────────
  console.log("A6. quiet hours: a go-live at 23:00 asks at 08:00");
  const W4 = "2026-10-26";
  await cfgSet(db, "enabled", false);
  await addTask("2026-10-26");
  at("2026-10-23T22:00:30");
  await tick();
  await cfgSet(db, "enabled", true);
  at("2026-10-23T23:00:30");
  {
    const r = await tick();
    ok("A6a Friday 23:00 (quiet): no ask, no kick", r.quiet === true && Object.keys(r.out ?? {}).length === 0 && (await msgs(W4)).length === 0, r);
    at("2026-10-23T23:47:30");
    const h = await health();
    ok("A6b the watchdog's view at night: never 'undelivered' in quiet hours", h.undelivered_alarm === false, h);
  }
  at("2026-10-24T07:55:30");
  ok("A6c 07:55: still quiet", Object.keys((await tick()).out ?? {}).length === 0);
  at("2026-10-24T08:00:30");
  ok("A6d 08:00: the ask goes out", (await tick()).out?.ask === 2 && (await msgs(W4, "ask")).length === 2);
  await work();

  // ───────────── A7. approval.enabled = false ─────────────
  console.log("A7. approval.enabled = false: nothing");
  const W5 = "2026-11-02";
  await addTask("2026-11-02");
  await db.query(`update platform_settings set value = jsonb_set(value, '{approval,enabled}', 'false') where key = 'challenge_tasks'`);
  at("2026-10-29T12:00:30");
  {
    const r = await tick();
    const h = await health();
    ok("A7a disabled: state 'disabled', nothing queued; the health never alarms", r.state === "disabled" && (await msgs(W5)).length === 0 &&
      (await state()).state === "disabled" && h.enabled === false && h.undelivered_alarm === false, { r, h });
  }
  await db.query(`update platform_settings set value = jsonb_set(value, '{approval,enabled}', 'true') where key = 'challenge_tasks'`);
  // a malformed setting falls back to the defaults, loudly
  await db.query(`update platform_settings set value = jsonb_set(value, '{approval,ask_time}', '"noon"') where key = 'challenge_tasks'`);
  at("2026-10-29T12:05:30");
  {
    const r = await tick();
    ok("A7b a malformed ask_time: the default 12:00 is used (the ask goes out) and 'config_invalid' is recorded once",
      r.out?.ask === 2 && (await audits("challenge_week_approval_config_invalid")).length === 1 &&
      JSON.stringify((await audits("challenge_week_approval_config_invalid"))[0].details.keys) === '["approval.ask_time"]', r);
    at("2026-10-29T12:10:30");
    await tick();
    ok("A7c ... once a day", (await audits("challenge_week_approval_config_invalid")).length === 1);
  }
  await db.query(`update platform_settings set value = jsonb_set(value, '{approval,ask_time}', '"12:00"') where key = 'challenge_tasks'`);
  await work();

  // ───────────── A8. a week with no task ─────────────
  console.log("A8. no task next week -> one «vazifa yo‘q» note");
  const W6 = "2026-11-09";
  at("2026-11-05T12:00:30");
  {
    const r = await tick();
    ok("A8a Thursday: the week has configured task days and no task -> one no_tasks note per admin, audited",
      r.out?.no_tasks === 2 && (await msgs(W6, "no_tasks")).length === 2 && !!(await ledger(W6)).no_tasks_at &&
      (await audits("challenge_week_approval_no_tasks")).length === 1, r);
    const i = since();
    await work();
    const out = sentFrom(i, "sendMessage");
    ok("A8b the note: «📭 Keyingi haftaga vazifa yo‘q (9–13 noyabr)», the task days, the review link only",
      out.length === 2 && out.every((s) => String(s.payload.text).startsWith("📭 <b>Keyingi haftaga vazifa yo‘q (9–13 noyabr)</b>") &&
        s.payload.reply_markup?.inline_keyboard?.length === 1 && s.payload.reply_markup.inline_keyboard[0][0].url?.endsWith("?week=2026-11-09")),
      out.map((s) => s.payload.text));
    at("2026-11-05T12:05:30");
    ok("A8c not twice", Object.keys((await tick()).out ?? {}).length === 0 && (await msgs(W6)).length === 2);
    // a draft added later that week -> the ask still comes
    await addTask("2026-11-09");
    at("2026-11-05T12:10:30");
    ok("A8d a draft added afterwards -> the ask follows", (await tick()).out?.ask === 2);
    await work();
  }

  // ───────────── A9. claim edges ─────────────
  console.log("A9. claim: expired and nothing-to-approve rows are skipped, never sent late");
  {
    // a pending ask of week 1 (already started), a reminder from an earlier day, an ask of a future week with no draft
    await db.query("insert into challenge_task_week_approvals (week_start) values ('2026-11-23')");
    const ids = (await q(db, `insert into challenge_task_week_approval_messages (week_start, kind, sent_on, user_id, chat_id)
                    values ('2026-10-05', 'ask', '2026-11-04', $1, 1011), ('2026-11-09', 'remind', '2026-11-01', $1, 1011),
                           ('2026-11-23', 'ask', '2026-11-05', $1, 1011) returning id`, [AD])).map((r) => Number(r.id));
    const i = since();
    const w = await work();
    const sk = await q(db, `select week_start::text w, kind, state, error from challenge_task_week_approval_messages
                            where id = any($1::bigint[]) order by id`, [`{${ids.join(",")}}`]);
    ok("A9a the three are 'skipped' (expired / expired / nothing_to_approve), nothing sent",
      sentFrom(i).length === 0 && sk.length === 3 && sk.every((x) => x.state === "skipped") &&
      /^expired/.test(sk[0].error) && /^expired/.test(sk[1].error) && sk[2].error === "nothing_to_approve", { sk, body: w.body });
    // a lease abandoned on its LAST attempt ends failed (never 'sending' forever)
    const lid = Number((await one(db, `insert into challenge_task_week_approval_messages (week_start, kind, sent_on, user_id, chat_id, state,
                                         attempts, claimed_at, claim_token)
                                       values ('2026-11-09', 'ask', '2026-11-03', $1, 1011, 'sending', 3, now() - interval '6 minutes',
                                               gen_random_uuid()) returning id`, [AD])).id);
    const j = since();
    await work();
    const lr = await one(db, "select state, terminal, error from challenge_task_week_approval_messages where id = $1", [lid]);
    ok("A9b a lease abandoned on its 3rd attempt -> failed, terminal, 'lease_expired'; not re-sent",
      lr.state === "failed" && lr.terminal === true && /lease_expired/.test(lr.error) && sentFrom(j).length === 0, lr);
  }

  // ───────────── A10. undelivered + the watchdog ─────────────
  console.log("A10. undelivered: 429 then terminal errors; the watchdog's two new alarms");
  const W7 = "2026-11-16";
  await addTask("2026-11-16");
  at("2026-11-12T12:00:30");
  {
    const r = await tick();
    ok("A10a the week-7 ask queued", r.out?.ask === 2, r);
    script = (method) => method === "sendMessage" ? { outcome: okOut("rate_limited", { retryAfterSec: 30 }), result: null } : null;
    const w = await work();
    const ms = await msgs(W7, "ask");
    ok("A10b a 429: the first send recorded failed (retry later), the second deferred (the run stops) -- no failure alarm yet",
      (w.body.week as Row)?.deferred === 2 && ms.filter((m) => m.state === "failed" && !m.terminal).length === 1 &&
      ms.filter((m) => m.state === "sending").length === 1 && (await audits("challenge_week_approval_undelivered")).length === 0, { body: w.body, ms });
    at("2026-11-12T12:11:30");
    script = (method) => method === "sendMessage" ? { outcome: okOut("recipient", { error: "Forbidden: bot was blocked by the user" }), result: null } : null;
    await work();
    script = null;
    const ms2 = await msgs(W7, "ask");
    const und = (await audits("challenge_week_approval_undelivered")).filter((a) => a.details.week === W7);
    ok("A10c blocked by both admins: both terminal -> ONE 'challenge_week_approval_undelivered' with the errors",
      ms2.every((m) => m.state === "failed" && m.terminal) && und.length === 1 && und[0].details.errors?.length === 2, { ms2, und });
    at("2026-11-12T13:59:30");
    let h = await health();
    ok("A10d 1 h 59 after the ask: not yet an alarm", h.undelivered_alarm === false && h.enabled === true, h);
    at("2026-11-12T14:01:30");
    h = await health();
    ok("A10e 2 h after the ask with nobody reached: undelivered_alarm, due since the ask", h.undelivered_alarm === true &&
      Math.abs(Date.parse(h.due_since) - Date.parse(utc("2026-11-12T12:00:30"))) < 60_000, h);
    await tick(); // keeps the heartbeat fresh (the tick itself would not re-ask: asked_at is set)
    const wd = await watchdog();
    ok("A10f the watchdog alarms 'week_approval_undelivered' with the calendar link, and DMs admins through pg_net",
      (wd.alarms as string[]).includes("week_approval_undelivered") && !(wd.alarms as string[]).includes("week_approval_silent") &&
      (wd.messages as string[]).some((m) => m.includes("Keyingi hafta (2026-11-16) vazifalarini tasdiqlash so‘rovi 2 soatdan beri") &&
        m.includes("https://www.aicreator.academy/admin/challenge/tasks?week=2026-11-16")) &&
      (await q(db, "select * from ops_net_calls where purpose = 'challenge-tasks-watchdog'")).length > 0, { alarms: wd.alarms, messages: wd.messages });
    // a delivered reminder clears it (any ask / reminder reaching an admin)
    await db.query(`update challenge_task_week_approval_messages set state = 'sent', message_id = 1 where week_start = $1 and kind = 'ask' and chat_id = 1011`, [W7]);
    ok("A10g one delivered copy -> no alarm", (await health()).undelivered_alarm === false);
    // the approval tick stops: the heartbeat goes stale -> 'week_approval_silent'
    await db.query(`update app_settings set value = jsonb_set(value, '{checked_at}', to_jsonb(now() - interval '25 minutes'))
                    where key = 'challenge_tasks_week_approval_state'`);
    const wd2 = await watchdog();
    ok("A10h a heartbeat older than 20 minutes -> 'week_approval_silent'", (wd2.alarms as string[]).includes("week_approval_silent") &&
      !(wd2.alarms as string[]).includes("week_approval_watch_crashed"), wd2.alarms);
  }

  // ───────────── A12. past days are never approved in bulk (review fix) ─────────────
  // PR-5 never posts a past task date (tick (0) skips it, (a) posts only today's), and challenge_task_streak_current
  // walks EVERY approved date: a past day approved after the fact is a miss for every student. So the week button (bot
  // and web) approves today and later only; past drafts come back in skipped_past[]; a week already over approves nothing.
  console.log("A12. past days: a mid-week tap approves today and later only, a past week approves nothing, streaks unchanged");
  {
    at("2026-12-10T10:00:30");
    const d11 = await addTask("2026-12-11", { title: "Juma 11" });
    const d14 = await addTask("2026-12-14", { title: "Dushanba 14" });
    const d15 = await addTask("2026-12-15", { title: "Seshanba 15" });
    const d16 = await addTask("2026-12-16", { title: "Chorshanba 16" });
    const d17 = await addTask("2026-12-17", { title: "Payshanba 17" });
    const d18 = await addTask("2026-12-18", { title: "Juma 18" });
    // Fri 11 and Wed 16 approved one by one (the calendar's own path) by AD: the guard stamps AD
    const e0 = await tx(db, `select set_config('request.jwt.claim.sub', '${AD}', true);
      update challenge_tasks set status = 'approved' where id = any('{${d11},${d16}}'::bigint[]);`);
    if (e0) throw new Error(`A12 setup: ${e0}`);
    const S1 = ST(1);
    for (const [id, day] of [[d11, "2026-12-11"], [d16, "2026-12-16"]] as const) {
      await db.query(`insert into challenge_task_submissions (task_id, user_id, group_id, source, attributed_via, status, submitted_at,
                                                              last_item_at, late_days, accepted_at)
                      values ($1, $2, $3, 'admin', 'admin', 'accepted', $4::timestamptz, $4::timestamptz, 0, $4::timestamptz)`,
        [id, S1, G1, `${day}T10:00:00+05:00`]);
    }
    const streak = async () => Number((await one(db, "select challenge_task_streak_current($1, $2) s", [S1, C6])).s);
    at("2026-12-16T15:00:30"); // Wednesday 16 December 15:00: Mon 14 and Tue 15 went by as drafts (never posted)
    const s0 = await streak();
    ok("A12a before: the student's streak is 2 (Fri 11 + Wed 16, both on time)", s0 === 2, s0);
    const msg = { chat: 1011, id: 777001 };
    const i = since();
    await tap("dtw:a:20261214", 1011, AD, msg);
    const conf = String(sentFrom(i, "editMessageText")[0]?.payload.text ?? "");
    ok("A12b dtw:a mid-week: «Shu hafta», N counts today and later only (Thu 17 + Fri 18 = 2), past days marked and left out",
      conf.startsWith("📅 <b>Shu hafta vazifalari") && conf.includes("❓ <b>2 ta vazifa tasdiqlansinmi?</b>") &&
      conf.includes("<b>Du, 14-dekabr</b> · 📝 umumiy · 5 ball · ⌛ o‘tgan kun") &&
      /O‘tgan kunlardagi 2 ta qoralama kiritilmaydi/.test(conf) && !conf.includes("<b>Pa, 17-dekabr</b> · 📝 umumiy · 5 ball · ⌛"), conf);
    const j = since();
    const au0 = (await audits("challenge_week_approved")).length;
    await tap("dtw:y:20261214", 1011, AD, msg);
    const st = await q(db, "select id, status, approved_by from challenge_tasks where id = any($1::bigint[]) order by id",
      [`{${[d14, d15, d17, d18].join(",")}}`]);
    const byId = (id: number) => st.find((r) => Number(r.id) === id);
    ok("A12c dtw:y mid-week: Thu 17 + Fri 18 approved (by AD); Mon 14 + Tue 15 (past) stay drafts",
      byId(d17)?.status === "approved" && byId(d18)?.status === "approved" && byId(d17)?.approved_by === AD &&
      byId(d14)?.status === "draft" && byId(d15)?.status === "draft", st);
    const au = (await audits("challenge_week_approved")).at(-1);
    ok("A12d audited with the past days in skipped_past (with the reason), never as failures",
      (await audits("challenge_week_approved")).length === au0 + 1 && au?.details.approved === 2 && au?.details.failed_count === 0 &&
      au?.details.skipped_past_count === 2 && au?.details.past_week === false &&
      (au?.details.skipped_past ?? []).map((x: Row) => x.date).join(",") === "2026-12-14,2026-12-15" &&
      /o‘tgan kun/.test(au?.details.skipped_past?.[0]?.reason ?? ""), au?.details);
    const res = String(sentFrom(j, "editMessageText")[0]?.payload.text ?? "");
    ok("A12e the result: «Shu hafta vazifalari: 2/2 tasdiqlandi» + the past days listed as not approved (the retro hint)",
      toasts.at(-1) === "✅ 2 ta tasdiqlandi" && res.startsWith("✅ <b>Shu hafta vazifalari: 2/2 tasdiqlandi</b>") &&
      res.includes("• Du, 14-dekabr — «Dushanba 14»") && res.includes("• Se, 15-dekabr — «Seshanba 15»") && res.includes("retro"),
      { toast: toasts.at(-1), res });
    const s1 = await streak();
    ok("A12f the student's streak is unchanged (2)", s1 === 2, s1);

    // today counts: Tuesday 22 December 10:00, drafts Mon 21 / Tue 22 / Wed 23 -> the web approves Tue 22 + Wed 23
    const e21 = await addTask("2026-12-21"), e22 = await addTask("2026-12-22"), e23 = await addTask("2026-12-23");
    at("2026-12-22T10:00:30");
    const web = await claimsAs({ sub: AD2, role: "authenticated" }, "authenticated",
      "select challenge_tasks_approve_week($1::date, null, $2::uuid) r", ["2026-12-21", C6]);
    const wr = (web.rows?.[0]?.r ?? {}) as Row;
    const s2 = await q(db, "select id, status from challenge_tasks where id = any($1::bigint[]) order by id", [`{${[e21, e22, e23].join(",")}}`]);
    ok("A12g the web, mid-week: today (Tue 22) + Wed 23 approved, Mon 21 in skipped_past, nothing actionable left",
      web.err === null && wr.approved === 2 && wr.failed?.length === 0 && wr.skipped_past?.length === 1 &&
      wr.skipped_past[0].date === "2026-12-21" && wr.past_week === false && wr.drafts_left === 0 &&
      s2.map((r) => r.status).join(",") === "draft,approved,approved", { err: web.err, wr, s2 });

    // a week long over (the old ask of 26 October still has its ✅): the buttons refuse, the RPC approves nothing
    const k = since();
    const n0 = (await audits("challenge_week_approved")).length;
    await tap("dtw:a:20261026", 1011, AD, msg);
    await tap("dtw:y:20261026", 1011, AD, msg);
    const e = sentFrom(k, "editMessageText");
    ok("A12h a past week's ✅ / Ha: «Bu hafta o‘tib ketdi», no approval call, the message loses its approve button",
      toasts.slice(-2).every((t) => t === "⌛ Bu hafta o‘tib ketdi") && (await audits("challenge_week_approved")).length === n0 &&
      e.length === 2 && e.every((x) => !JSON.stringify(x.payload.reply_markup).includes("dtw:")) &&
      String(e[0].payload.text).startsWith("⌛ <b>Bu hafta o‘tib ketdi"), { toasts: toasts.slice(-2), e: e.map((x) => x.payload) });
    ok("A12i ... DB-visible once (per admin, week and day)", (await audits("challenge_week_approval_past_week")).length === 1);
    const svc = await claimsAs({ role: "service_role" }, "service_role", "select challenge_tasks_approve_week($1::date, $2::uuid) r",
      ["2026-10-26", AD]);
    const sr = (svc.rows?.[0]?.r ?? {}) as Row;
    ok("A12j the RPC on a past week: approved 0, past_week, the draft in skipped_past -- and it is still a draft",
      svc.err === null && sr.approved === 0 && sr.past_week === true && sr.skipped_past?.length === 1 && sr.failed?.length === 0 &&
      await count(db, "select count(*) n from challenge_tasks where task_date = '2026-10-26' and status = 'draft'") === 1, { err: svc.err, sr });
    const s3 = await streak();
    ok("A12k after all of it the student's streak is still 2", s3 === 2, s3);
  }

  // ───────────── A11. invariants ─────────────
  console.log("A11. invariants");
  {
    ok("A11a the tick never failed a section", (await audits("challenge_week_approval_tick_failed")).length === 0,
      await audits("challenge_week_approval_tick_failed"));
    ok("A11b every approved task carries an approver and a time (the guard stamped every one)",
      await count(db, "select count(*) n from challenge_tasks where status = 'approved' and (approved_by is null or approved_at is null)") === 0);
    ok("A11c every worker run of the week_approval mode was ok or inactive",
      await count(db, `select count(*) n from admin_actions where action = 'challenge_task_worker_run' and details->>'mode' = 'week_approval'
                       and details->>'status' not in ('ok', 'inactive')`) === 0,
      await q(db, "select details from admin_actions where action = 'challenge_task_worker_run' and details->>'status' not in ('ok', 'inactive')"));
  }
  await db.close();

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) throw new Error(`daily_tasks_week_approval: ${fail} check(s) failed`);
}
