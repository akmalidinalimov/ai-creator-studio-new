// PGlite harness for the WORKER side of the daily tasks (Daily Tasks PR-5): migration 20260930152000 (the per-minute
// challenge_tasks_tick, the SQL fallback poster, the missing-task alert, the identity-sweep input, the watchdog's new
// tick / worker alarms) and the edge function's runWorker() (challenge-tasks-worker/worker.ts: posts, receipts, the DM
// outbox, the identity sweep through the REAL _shared resolveGroupPoster + this function's registrar) against the
// REAL PR-3 SQL engine on a real PostgreSQL.
//
//   deno test -A --node-modules-dir=none --no-lock supabase/functions/_challenge/testing/daily-tasks-worker-check.ts
//   (WORKER_MIG_PATH=<file> points it at a draft of the migration)
//
// The world is a VERBATIM copy of daily-tasks-bot-check.ts's (itself PR-3's harness: #218 + PR-1 + PR-2 + the LIVE
// fixtures, pinned clock), then 20260930150020 and THIS PR's migration apply. The worker runs through the same small
// PostgREST-shaped adapter (rpc = the SECURITY DEFINER functions called AS service_role) with a RECORDING Bot API
// sender, an admin-create-students stub for the registrar, and a virtual sleep. pg_net is the world's ops_net_post
// stub (every call recorded in ops_net_calls) plus a net._http_response table the harness fills.
//
//   W0 the migration applies over the LIVE PR-3 watchdog body (md5-pinned) and replays clean;
//   W1 INERT: paused -> the tick stamps its heartbeat only (nothing queued, posted, sent or kicked), the worker claims nothing;
//   W2-W3 09:00: six task posts + morning DMs to DM-eligible students only (never staff) -> one kick -> the worker posts
//      (thread, button, the SQL-rendered text) and DMs; the next minute does nothing twice;
//   W4 receipts: a reconciler capture -> reply receipt; a re-check -> edit; a deleted receipt -> re-posted; 429 ->
//      deferred (no failure row), re-offered after 5 minutes; a missing topic -> failed (DB-visible);
//   W5 the SQL fallback poster: the worker is down 15 minutes after 09:00 -> ops_net_post with the SAME button; pg_net's
//      answers settle it (sent_via_sql / failed / no answer); a reply to a fallback post targets its task (R3);
//   W6 the missing-task alert at 18:00 (task day tomorrow, no approved task -> row + admin DM, once; a rest day never);
//   W7 evening DMs ('📅 vazifa seriyasi') only to students with an open task not done; stale morning DMs expire;
//      the 20:00 anonymous summary;
//   W8 the identity sweep: an unknown poster registered (the engine stub), an intake username linked, a chat admin
//      declined and backed off 60 minutes, and the WINDOW sweep (PR-8's pre-step) while PAUSED;
//   W9 DM edges (result DM, a blocked student -> skipped); W10 the day rollover and no-task-today;
//   W11 the watchdog alarms tick_silent / worker_receipts / worker_dms / worker_errors; W12 invariants.
//
// CI NOTE: named *-check.ts (never *_test.ts) so CI's `deno test supabase/functions/` never collects it. Run it by path.
// TEST INFRASTRUCTURE ONLY: this directory has no index.ts, so it is never deployed.
import { runWorker, type WorkerEnv } from "../../challenge-tasks-worker/worker.ts";
import { POST_BUTTON_TEXT } from "../../challenge-tasks-worker/render.ts";
import type { SendFn } from "../../challenge-tasks-worker/registrar.ts";
import type { SendResultOutcome } from "../../_shared/telegram-send.ts";

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
    ? "daily_tasks_worker: the tick + challenge-tasks-worker against the REAL engine on PGlite (posts, receipts, DMs, fallback, alert, identity, watchdog)"
    : "daily_tasks_worker: SKIPPED -- needs `deno test -A --node-modules-dir=none` (PGlite reads its own files)",
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


  const WMIG_PATH = Deno.env.get("WORKER_MIG_PATH");
  const WMIG = lf(await Deno.readTextFile(WMIG_PATH ?? here("../../../migrations/20260930152000_challenge_daily_tasks_worker.sql")));
  const LIVE_WATCHDOG_MD5 = "8425d0076060c3501094d611179baaa0"; // md5(replace(prosrc, E'\r', '')) read live 2026-09-30
  // the Bot API host, assembled so no literal of it sits in a .ts file (the footgun lint forbids raw senders; this
  // harness only compares the URL the SQL fallback handed to the ops_net_post stub)
  const TG_HOST = ["api", "telegram", "org"].join(".");
  const PINNED_NEW = /_new_pin constant text := '([0-9a-fPENDING_]+)'/.exec(WMIG)?.[1] ?? "";

  const db = await freshDb();
  await db.exec(BOT_EXTRA);
  await db.exec(WORKER_EXTRA);
  {
    const e = await tx(db, MIG);
    if (e !== null) throw new Error(`daily_tasks_worker: the engine migration did not apply -- ${e}`);
  }
  const admin = pgAdmin(db);
  // the bot already sent (and recorded) the receipt of a topic capture: the worker must not own it
  const botSent = async (user: string) => await db.query(`update challenge_task_submissions set receipt_state = 'sent',
    receipt_sent_version = receipt_version where user_id = $1 and receipt_state in ('sending', 'pending')`, [user]);
  const wdMd5 = async () => String((await one(db, "select md5(replace(prosrc, E'\\r', '')) m from pg_proc where oid = 'public.challenge_tasks_watchdog(timestamptz)'::regprocedure")).m);

  // ───────────── W0. applies over the LIVE watchdog body, replays clean ─────────────
  console.log("W0. the migration: pinned watchdog rewrite, replay");
  {
    ok("W0a the repo's PR-3 challenge_tasks_watchdog body IS the live one (md5)", await wdMd5() === LIVE_WATCHDOG_MD5, await wdMd5());
    const e = await tx(db, WMIG);
    const m = await wdMd5();
    console.log(`     challenge_tasks_watchdog md5 after the rewrite: ${m} (pinned: ${PINNED_NEW})`);
    ok("W0b 20260930152000 applies (prerequisites, rewrite, grants, cron, self-test, audit)", e === null, e);
    ok("W0c the rewritten watchdog md5 is the pinned one", m === PINNED_NEW, { m, PINNED_NEW });
    const e2 = await tx(db, WMIG);
    ok("W0d replay: applies again, the watchdog is untouched, one cron row, one audit row",
      e2 === null && await wdMd5() === m &&
      await count(db, "select count(*) n from cron.job where jobname = 'challenge-tasks-tick'") === 1 &&
      await count(db, "select count(*) n from admin_actions where action = 'challenge_tasks_worker_applied'") === 1, e2);
    const acl = await q(db, `select p.proname, coalesce(array_to_string(p.proacl, ','), '') acl from pg_proc p
      where p.proname in ('challenge_tasks_tick','challenge_tasks_worker_due','challenge_task_identity_candidates',
                          'challenge_task_identity_sweep_request','challenge_tasks_admin_dm')`);
    ok("W0e five functions, service_role only (never PUBLIC / anon / authenticated)", acl.length === 5 &&
      acl.every((r) => /service_role=X/.test(r.acl) && !/(^|,)=/.test(r.acl) && !/(anon|authenticated)=/.test(r.acl)), acl);
    const asStudent = await as(db, ST(1), "select challenge_tasks_worker_due() d");
    ok("W0f a student cannot call the kick's decision", asStudent.err !== null && /permission denied/.test(asStudent.err), asStudent.err);
  }
  await db.exec(WORKER_DATA);

  // the calendar: Mon screenshot + text, Tue screenshot (the bot harness's shapes)
  const SHOT = { any: ["photo", "image_doc"], min: 1, label: "screenshot" };
  const TEXT = { any: ["text"], min: 1, label: "text" };
  const addTask = async (date: string, requires: unknown, accepts: string[], status = "approved") =>
    Number((await one(db, `insert into challenge_tasks (course_id, task_date, type, title, body, accepts, requires, status, source)
                           values ($1, $2, 'general', $3, 'Vazifa matni', $4::text[], $5::jsonb, $6, 'manual') returning id`,
      [C6, date, `Vazifa ${date}`, `{${accepts.join(",")}}`, JSON.stringify(requires), status])).id);
  const TMON = await addTask("2026-10-05", [SHOT, TEXT], ["text", "photo", "document"]);
  const TTUE = await addTask("2026-10-06", [SHOT], ["text", "photo", "document"]);
  // DM-eligible (C15): ST1, ST2, ST4 and the teacher T1 (staff: never DM'd by the tick)
  await db.query("update profiles set telegram_write_access_at = now() where id = any($1::uuid[])", [`{${[ST(1), ST(2), ST(4), T1].join(",")}}`]);

  const utc = (local: string) => new Date(Date.parse(local + "+05:00")).toISOString();
  const tick = async () => (await one(db, "select challenge_tasks_tick() r")).r as Row;
  const due = async () => (await one(db, "select challenge_tasks_worker_due() d")).d as Row;
  const net = async (purpose: string) => await q(db, "select * from ops_net_calls where purpose = $1 order by id", [purpose]);
  const tickState = async () => (await one(db, "select value v from app_settings where key = 'challenge_tasks_tick_state'"))?.v as Row;
  const lastRun = async () => (await one(db, "select details d from admin_actions where action = 'challenge_task_worker_run' order by created_at desc, id desc limit 1"))?.d as Row;
  const TOPICS: Record<string, { chat: number; thread: number }> = {
    [G1]: { chat: CH1, thread: D1 }, [G2]: { chat: CH2, thread: D2 }, [G9]: { chat: CH9, thread: 10 }, [G10]: { chat: CH10, thread: 10 },
  };

  // ── the worker: the REAL runWorker, a recording sender, an admin-create-students stub, a virtual sleep ──
  const sent: { method: string; payload: Row; opts: Row }[] = [];
  let script: ((method: string, payload: Row) => { outcome: SendResultOutcome; result: unknown } | null) | null = null;
  let nextMid = 70_000;
  const send: SendFn = (method, payload, opts) => {
    sent.push({ method, payload, opts: opts ?? {} });
    const r = script?.(method, payload) ?? null;
    return Promise.resolve(r ?? {
      outcome: okOut(),
      result: method === "sendMessage" ? { message_id: nextMid++ } : method === "getChatMember" ? { status: "member" } : true,
    });
  };
  const fetchCalls: { url: string; headers: Row; body: Row }[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    fetchCalls.push({ url: String(input), headers: (init?.headers ?? {}) as Row, body });
    const s = body.students?.[0] ?? {};
    const id = crypto.randomUUID();
    await db.query("insert into auth.users values ($1)", [id]);
    await db.query("insert into profiles (id, group_id, telegram_id, name, telegram_username) values ($1, $2, $3, $4, $5)",
      [id, body.target_group_id, s.telegram_user_id, s.name, s.telegram_username ?? null]);
    return new Response(JSON.stringify({ results: [{ userId: id, status: "created" }] }), { status: 200 });
  }) as typeof fetch;
  let virt = 0;
  const slept: number[] = [];
  const ENV: WorkerEnv = { botToken: "123:TESTTOKEN", botUsername: "aicreatorsdarsliklari_bot", supabaseUrl: "https://example.test", serviceKey: "svc" };
  const work = (req: Row = { mode: "run" }) => runWorker(ENV, {
    admin, send, fetchFn, now: () => Date.now() + virt,
    sleep: (ms) => { slept.push(ms); virt += ms; return Promise.resolve(); },
  }, req);
  const since = () => sent.length;
  const sentFrom = (i: number, method?: string) => sent.slice(i).filter((s) => !method || s.method === method);

  // ───────────── W1. INERT ─────────────
  console.log("W1. inert: challenge_tasks.enabled=false (PR-1's seed)");
  setClock(utc("2026-10-05T09:00:30"));
  {
    const r = await tick();
    const st = await tickState();
    ok("W1a paused: the tick answers inactive and stamps its heartbeat row", r.state === "inactive" && st?.state === "inactive" && !!st?.checked_at, { r, st });
    ok("W1b nothing queued, posted, sent or kicked",
      await count(db, "select count(*) n from challenge_task_posts") === 0 && await count(db, "select count(*) n from challenge_task_outbox") === 0 &&
      await count(db, "select count(*) n from ops_net_calls") === 0 &&
      await count(db, "select count(*) n from admin_actions where action like 'challenge_task_tick%'") === 0);
    const d = await due();
    ok("W1c the kick's decision: inactive, total 0", d.state === "inactive" && d.total === 0, d);
    const i = since();
    const w = await work();
    ok("W1d a manual worker call while paused claims nothing and sends nothing", w.body.status === "inactive" && sentFrom(i).length === 0 &&
      await count(db, "select count(*) n from challenge_task_posts") === 0, w.body);
  }
  await cfgSet(db, "enabled", true);

  // ───────────── W2. before 09:00 ─────────────
  console.log("W2. active, 08:59: nothing due yet");
  setClock(utc("2026-10-05T08:59:30"));
  {
    const r = await tick();
    ok("W2a nothing queued before post_time; no kick", r.state === "active" && Object.keys(r.out ?? {}).length === 0 && r.kicked === false &&
      (await net("challenge-tasks-worker")).length === 0, r);
  }

  // ───────────── W3. 09:00: posts + morning DMs → one kick → the worker ─────────────
  console.log("W3. 09:00: six task posts + morning DMs, one kick, the worker posts and DMs");
  setClock(utc("2026-10-05T09:00:30"));
  let monPostG1 = 0;
  {
    const r = await tick();
    ok("W3a six task posts queued (G1-G4, 5- and 6-GURUH), three morning DMs (ST1/ST2/ST4 — never the teacher)",
      r.out?.posts_queued === 6 && r.out?.morning_queued === 3 &&
      await count(db, "select count(*) n from challenge_task_outbox where kind = 'morning' and user_id = $1", [T1]) === 0, r);
    const kicks = await net("challenge-tasks-worker");
    const h = kicks[0]?.headers ?? {};
    ok("W3b ONE kick through ops_net_post: the worker URL, Content-Type, the service bearer and x-internal-secret, the due counts",
      kicks.length === 1 && /\/functions\/v1\/challenge-tasks-worker$/.test(kicks[0].url) && h["Content-Type"] === "application/json" &&
      h["Authorization"] === "Bearer test-service-key" && h["apikey"] === "test-service-key" && h["x-internal-secret"] === "test-internal-secret" &&
      kicks[0].body?.due?.posts === 6 && kicks[0].body?.due?.dms === 3 && kicks[0].timeout_ms === 60000, kicks[0]);
    const i = since();
    const w = await work();
    const posts = sentFrom(i, "sendMessage").filter((s) => s.opts.purpose === "challenge_task_post_task");
    const body = String((await one(db, "select challenge_task_render_post(t) b from challenge_tasks t where id = $1", [TMON])).b);
    ok("W3c six posts: the SQL-rendered text, HTML, into each group's daily topic (chat AND thread)", posts.length === 6 &&
      posts.every((p) => p.payload.text === body && p.payload.parse_mode === "HTML") &&
      [G1, G2, G9, G10].every((g) => posts.some((p) => p.payload.chat_id === TOPICS[g].chat && p.payload.message_thread_id === TOPICS[g].thread)) &&
      posts.every((p) => p.opts.topicMissingAction === "challenge_task_topic_missing"), posts.map((p) => [p.payload.chat_id, p.payload.message_thread_id]));
    ok("W3d the post button: t.me/<bot>?start=dt_<task>, the shared POST_BUTTON_TEXT", posts.every((p) =>
      JSON.stringify(p.payload.reply_markup) === JSON.stringify({ inline_keyboard: [[{ text: POST_BUTTON_TEXT,
        url: `https://t.me/aicreatorsdarsliklari_bot?start=dt_${TMON}` }]] })), posts[0]?.payload.reply_markup);
    ok("W3e every post recorded 'sent' with Telegram's message id",
      await count(db, "select count(*) n from challenge_task_posts where task_id = $1 and kind = 'task' and state = 'sent' and message_id >= 70000", [TMON]) === 6);
    monPostG1 = Number((await one(db, "select message_id m from challenge_task_posts where task_id = $1 and group_id = $2", [TMON, G1])).m);
    const dms = sentFrom(i, "sendMessage").filter((s) => s.opts.purpose === "challenge_task_dm_morning");
    ok("W3f three morning DMs to the students' own chats, with the title, the topic and the task-card buttons",
      dms.length === 3 && [2001, 2002, 2004].every((c) => dms.some((d) => d.payload.chat_id === c)) &&
      dms.every((d) => /^☀️ Student, xayrli tong! 1-kun vazifasi e’lon qilindi:/.test(d.payload.text) && d.payload.text.includes(`<b>Vazifa 2026-10-05</b>`) &&
        d.payload.reply_markup?.inline_keyboard?.[0]?.[0]?.url === "https://t.me/c/4440955972/144" &&
        d.payload.reply_markup?.inline_keyboard?.[0]?.[1]?.url === `https://t.me/aicreatorsdarsliklari_bot?start=dt_${TMON}`),
      dms.map((d) => d.payload.text));
    ok("W3g the outbox rows are 'sent'; the heartbeat says posts 6 / DMs 3",
      await count(db, "select count(*) n from challenge_task_outbox where state = 'sent'") === 3 &&
      w.body.status === "ok" && (w.body.posts as Row)?.sent === 6 && (w.body.dms as Row)?.sent === 3 && (await lastRun())?.status === "ok", w.body);
    setClock(utc("2026-10-05T09:01:30"));
    const r2 = await tick();
    ok("W3h the next minute: nothing re-queued, no morning DM twice, nothing due, no second kick",
      Object.keys(r2.out ?? {}).length === 0 && r2.kicked === false && r2.due?.total === 0 && (await net("challenge-tasks-worker")).length === 1, r2);
  }

  // ───────────── W4. receipts ─────────────
  console.log("W4. receipts: reply, edit, re-post after delete, 429 deferral, missing topic");
  setClock(utc("2026-10-05T10:00:30"));
  let subR = 0, ridR = 0;
  {
    // ST1's Monday work through the bot path (a topic capture; the bot would have sent its own receipt)
    const m1 = tgm({ from: TG(1), at: "2026-10-05T10:00:00", photo: "w4a", caption: T25 });
    await cap(db, m1);
    await db.query("update challenge_task_submissions set receipt_state = 'sent', receipt_sent_version = receipt_version where user_id = $1", [ST(1)]);
    // ST3's Monday work arrives through the RECONCILER (the bot missed it): its receipt is the worker's job
    const m3 = tgm({ from: TG(3), at: "2026-10-05T10:00:10", photo: "w4b", caption: T25 });
    await inbox(db, m3);
    await reconcile(db);
    const s = await liveOf(db, ST(3), TMON);
    subR = Number(s?.id);
    ok("W4a the reconciler captured ST3 (+5) and left the receipt pending", s?.status === "accepted" && s?.receipt_state === "pending", s);
    const r = await tick();
    ok("W4b the tick kicks for ONE receipt", r.kicked === true && r.due?.receipts === 1, r.due);
    const i = since();
    const w = await work();
    const out = sentFrom(i);
    ok("W4c one reply receipt: in G1's topic, under ST3's message, the owner's copy, the dt:x button",
      out.length === 1 && out[0].method === "sendMessage" && out[0].payload.chat_id === CH1 && out[0].payload.message_thread_id === D1 &&
      out[0].payload.reply_parameters?.message_id === m3.message_id && out[0].payload.text === "✅ Bugungi vazifa qabul qilindi: +5 ball." &&
      JSON.stringify(out[0].payload.reply_markup) === JSON.stringify({ inline_keyboard: [[{ text: "❌ Bu topshiriq emas", callback_data: `dt:x:${subR}` }]] }),
      out.map((o) => o.payload));
    ridR = nextMid - 1;
    const rs = await one(db, "select receipt_state, receipt_message_id, receipt_sent_version, receipt_version from challenge_task_submissions where id = $1", [subR]);
    ok("W4d recorded: sent, the message id, sent version = version", rs.receipt_state === "sent" && Number(rs.receipt_message_id) === ridR &&
      rs.receipt_sent_version === rs.receipt_version && (w.body.receipts as Row)?.sent === 1, rs);

    const bump = async () => await db.query(`update challenge_task_submissions set receipt_version = receipt_version + 1, receipt_state = 'pending',
      updated_at = now() where id = $1`, [subR]);
    await bump();
    let j = since();
    await work();
    let o = sentFrom(j);
    ok("W4e a newer version (an AI result / a correction) → ONE edit of the same receipt", o.length === 1 && o[0].method === "editMessageText" &&
      o[0].payload.message_id === ridR && o[0].payload.chat_id === CH1 &&
      (await one(db, "select receipt_state s from challenge_task_submissions where id = $1", [subR])).s === "sent", o.map((x) => x.method));

    await bump();
    script = (method) => method === "editMessageText" ? { outcome: okOut("message_gone"), result: null } : null;
    j = since();
    const wg = await work();
    script = null;
    o = sentFrom(j);
    const rs2 = await one(db, "select receipt_state, receipt_message_id from challenge_task_submissions where id = $1", [subR]);
    ok("W4f the receipt was deleted → edit says message_gone → a FRESH receipt under the work, recorded", o.length === 2 &&
      o[0].method === "editMessageText" && o[1].method === "sendMessage" && o[1].payload.reply_parameters?.message_id === m3.message_id &&
      rs2.receipt_state === "sent" && Number(rs2.receipt_message_id) === nextMid - 1 && (wg.body.receipts as Row)?.reposted === 1, { o: o.map((x) => x.method), rs2 });
    ridR = nextMid - 1;

    await bump();
    script = (method) => method === "editMessageText" ? { outcome: okOut("rate_limited", { retryAfterSec: 7 }), result: null } : null;
    j = since();
    const wr = await work();
    script = null;
    const rs3 = await one(db, "select receipt_state from challenge_task_submissions where id = $1", [subR]);
    ok("W4g 429 → deferred: the receipt stays leased ('sending'), NO failure row, nothing else sent into that chat",
      rs3.receipt_state === "sending" && sentFrom(j).length === 1 && (wr.body.receipts as Row)?.deferred === 1 &&
      await count(db, "select count(*) n from admin_actions where action = 'challenge_task_receipt_failed'") === 0, { rs3, body: wr.body });
    ok("W4h the lease is not due again inside 5 minutes (no kick loop)", (await due()).receipts === 0);
    setClock(utc("2026-10-05T10:06:30"));
    ok("W4i after 5 minutes the claim re-offers it (the tick would kick)", (await due()).receipts === 1);
    j = since();
    await work();
    ok("W4j … and the next run edits it", sentFrom(j).length === 1 && sentFrom(j)[0].method === "editMessageText" &&
      (await one(db, "select receipt_state s from challenge_task_submissions where id = $1", [subR])).s === "sent");

    // a missing topic is terminal: recorded failed (the engine writes challenge_task_receipt_failed)
    const m5 = tgm({ from: TG(5), at: "2026-10-05T10:07:00", photo: "w4c", caption: T25 });
    setClock(utc("2026-10-05T10:07:30"));
    await inbox(db, m5);
    await reconcile(db);
    script = (method) => method === "sendMessage" ? { outcome: okOut("topic_missing"), result: null } : null;
    await work();
    script = null;
    const s5 = await liveOf(db, ST(5), TMON);
    ok("W4k topic_missing → the receipt is recorded failed (DB-visible), never retried in a loop",
      s5?.receipt_state === "failed" && /topic_missing/.test(String(s5?.receipt_error)) &&
      await count(db, "select count(*) n from admin_actions where action = 'challenge_task_receipt_failed'") === 1 && (await due()).receipts === 0, s5);
  }

  // ───────────── W5. the SQL fallback poster ─────────────
  console.log("W5. Tuesday: the worker is down → the SQL fallback posts at 09:15, pg_net's answers settle it");
  setClock(utc("2026-10-06T09:00:30"));
  const fbRows: Row[] = [];
  {
    const r = await tick();
    ok("W5a 09:00: six Tuesday posts queued, the kick fires (the worker never answers in this scenario)", r.out?.posts_queued === 6 && r.kicked === true, r.out);
    setClock(utc("2026-10-06T09:10:30"));
    const r1 = await tick();
    ok("W5b 09:10: not yet (fallback after post_time + 15 min)", !r1.out?.fallback_requested, r1.out);
    setClock(utc("2026-10-06T09:16:00"));
    const r2 = await tick();
    const calls = await net("challenge-tasks-fallback-post");
    const body = String((await one(db, "select challenge_task_render_post(t) b from challenge_tasks t where id = $1", [TTUE])).b);
    ok("W5c 09:16: SIX fallback posts through ops_net_post: sendMessage, Content-Type, the SQL text, the worker's SAME button",
      r2.out?.fallback_requested === 6 && calls.length === 6 &&
      calls.every((c) => c.url === `https://${TG_HOST}/bot123:TESTTOKEN/sendMessage` && c.headers?.["Content-Type"] === "application/json" &&
        c.body?.text === body && c.body?.parse_mode === "HTML" && c.body?.reply_markup?.inline_keyboard?.length === 1 &&
        c.body?.reply_markup?.inline_keyboard?.[0]?.length === 1 && c.body?.reply_markup?.inline_keyboard?.[0]?.[0]?.text === POST_BUTTON_TEXT &&
        c.body?.reply_markup?.inline_keyboard?.[0]?.[0]?.url === `https://t.me/aicreatorsdarsliklari_bot?start=dt_${TTUE}`) &&
      [G1, G2, G9, G10].every((g) => calls.some((c) => c.body?.chat_id === TOPICS[g].chat && c.body?.message_thread_id === TOPICS[g].thread)),
      calls.map((c) => c.body?.chat_id));
    fbRows.push(...await q(db, "select * from challenge_task_posts where task_id = $1 and kind = 'task' order by group_id", [TTUE]));
    ok("W5d each row: 'sending', the pg_net request id, the fallback's own lease token in error; never due for the worker meanwhile",
      fbRows.every((p) => p.state === "sending" && p.net_request_id !== null && p.error === `sql_fallback:${p.claim_token}`) && (await due()).posts === 0, fbRows);
    // pg_net answers: four OK, one Telegram refusal, one never answers
    for (let k = 0; k < 4; k++) {
      await db.query("insert into net._http_response (id, status_code, content) values ($1, 200, $2)",
        [fbRows[k].net_request_id, JSON.stringify({ ok: true, result: { message_id: 9000 + k } })]);
    }
    await db.query("insert into net._http_response (id, status_code, content) values ($1, 400, $2)",
      [fbRows[4].net_request_id, JSON.stringify({ ok: false, description: "Bad Request: message thread not found" })]);
    setClock(utc("2026-10-06T09:17:00"));
    const r3 = await tick();
    const after = await q(db, "select * from challenge_task_posts where task_id = $1 and kind = 'task' order by group_id", [TTUE]);
    ok("W5e four 'sent_via_sql' with Telegram's message ids", r3.out?.fallback_sent === 4 &&
      after.slice(0, 4).every((p, k) => p.state === "sent_via_sql" && Number(p.message_id) === 9000 + k && p.claim_token === null && p.error === null), after);
    ok("W5f the refusal → 'failed' + challenge_task_post_failed (via sql_fallback); the worker may retry it (attempts < 5)",
      after[4].state === "failed" && /sql_fallback_failed: http_400 Bad Request: message thread not found/.test(after[4].error) &&
      await count(db, "select count(*) n from admin_actions where action = 'challenge_task_post_failed' and details->>'via' = 'sql_fallback'") === 1 &&
      (await due()).posts === 1, after[4]);
    setClock(utc("2026-10-06T09:18:00"));
    const r4 = await tick();
    ok("W5g ONE SQL attempt per post: the refused one is never re-sent by SQL", !r4.out?.fallback_requested && (await net("challenge-tasks-fallback-post")).length === 6, r4.out);
    setClock(utc("2026-10-06T09:21:30"));
    await tick();
    const last = await one(db, "select * from challenge_task_posts where task_id = $1 and group_id = $2 and kind = 'task'", [TTUE, fbRows[5].group_id]);
    ok("W5h no pg_net answer in 5 minutes → 'failed' (the request most likely never left; the worker retries)",
      last.state === "failed" && /no pg_net response/.test(last.error) && last.claim_token === null, last);
    // a reply to a fallback post targets its task (R3): the engine reads sent_via_sql like sent. 5-GURUH's row is one
    // of the four answered ones (uuid order: 3-, 4-, 5-, 6-GURUH, then 2-, 1-GURUH).
    const g9Post = after.find((p) => p.group_id === G9);
    setClock(utc("2026-10-06T09:30:00"));
    const rp = await cap(db, tgm({ chat: CH9, thread: 10, from: 1061, at: "2026-10-06T09:29:00", photo: "w5r",
      replyTo: { id: Number(g9Post?.message_id), from: 1, isBot: true } }));
    await botSent(Y1);
    const sub = await liveOf(db, Y1, TTUE);
    ok("W5i a reply to a fallback-posted task targets THAT task (R3: sent_via_sql counts)",
      g9Post?.state === "sent_via_sql" && rp.outcome === "created" && sub?.attributed_via === "reply_to_post", { rp, sub, g9Post });
    // the worker comes back: it retries the two failed posts (2- and 1-GURUH) and sends the morning DMs still in time
    const i = since();
    const w = await work();
    const re = sentFrom(i, "sendMessage").filter((s) => s.opts.purpose === "challenge_task_post_task");
    ok("W5j the worker, back, posts the two failed rows (and nothing already sent); the 09:00 DMs go out (still before 12:00)",
      re.length === 2 && re.some((s) => s.payload.chat_id === CH1) && re.some((s) => s.payload.chat_id === CH2) &&
      await count(db, "select count(*) n from challenge_task_posts where task_id = $1 and kind = 'task' and state in ('sent','sent_via_sql')", [TTUE]) === 6 &&
      (w.body.dms as Row)?.sent === 3, w.body);
  }

  // Tuesday work: ST1 (did Monday too) and ST4 (Tuesday only); ST2 does nothing. (The bot sent their receipts.)
  setClock(utc("2026-10-06T10:00:30"));
  await cap(db, tgm({ from: TG(1), at: "2026-10-06T10:00:00", photo: "tue1" }));
  await cap(db, tgm({ from: TG(4), at: "2026-10-06T10:00:10", photo: "tue4" }));
  await botSent(ST(1));
  await botSent(ST(4));

  // ───────────── W6. the missing-task alert (18:00) ─────────────
  console.log("W6. 18:00: tomorrow is a task day with no approved task → the alert, once; a rest day never");
  {
    await addTask("2026-10-07", [SHOT], ["text", "photo", "document"], "draft");
    setClock(utc("2026-10-06T17:59:30"));
    const r0 = await tick();
    ok("W6a 17:59: no alert yet", !r0.out?.no_task_tomorrow, r0.out);
    setClock(utc("2026-10-06T18:00:30"));
    const r = await tick();
    const dm = await net("challenge-tasks-tomorrow-check");
    const row = await one(db, "select details d from admin_actions where action = 'challenge_task_no_task_tomorrow'");
    ok("W6b 18:00: 'challenge_task_no_task_tomorrow' {course, date, drafts 1} + ONE admin DM (the admin's chat) through ops_net_post",
      r.out?.no_task_tomorrow === true && row?.d?.date === "2026-10-07" && row?.d?.course_id === C6 && row?.d?.drafts === 1 && row?.d?.dm_sent === 1 &&
      dm.length === 1 && dm[0].body?.chat_id === 1011 && dm[0].headers?.["Content-Type"] === "application/json" &&
      /ertangi \(7-oktabr, chorshanba\) vazifa hali TASDIQLANMAGAN/.test(dm[0].body?.text) && /Qoralama bor/.test(dm[0].body?.text), { row, dm });
    setClock(utc("2026-10-06T18:01:30"));
    await tick();
    ok("W6c the next minute: no second row, no second DM", await count(db, "select count(*) n from admin_actions where action = 'challenge_task_no_task_tomorrow'") === 1 &&
      (await net("challenge-tasks-tomorrow-check")).length === 1);
  }

  // ───────────── W7. evening DMs, stale mornings, the 20:00 summary ─────────────
  console.log("W7. 19:00 evening DMs only to students with an open task; 20:00 summary");
  {
    setClock(utc("2026-10-06T19:00:30"));
    const r = await tick();
    const ev = await q(db, "select user_id, payload from challenge_task_outbox where kind = 'evening' order by user_id");
    const p2 = ev.find((e) => e.user_id === ST(2))?.payload;
    const p4 = ev.find((e) => e.user_id === ST(4))?.payload;
    ok("W7a evening rows: ST2 (today + Monday) and ST4 (Monday only); ST1 did both → NOT nagged; the teacher never",
      r.out?.evening_queued === 2 && ev.length === 2 && !ev.some((e) => e.user_id === ST(1) || e.user_id === T1) &&
      p2?.pending?.length === 2 && p2.pending[0].late_days === 0 && p2.pending[0].points === 5 && p2.pending[1].late_days === 1 && p2.pending[1].points === 3 &&
      p4?.pending?.length === 1 && p4.pending[0].date === "2026-10-05", ev);
    const i = since();
    const w = await work();
    const dms = sentFrom(i, "sendMessage").filter((s) => s.opts.purpose === "challenge_task_dm_evening");
    const d2 = dms.find((d) => d.payload.chat_id === 2002)?.payload.text ?? "";
    const d4 = dms.find((d) => d.payload.chat_id === 2004)?.payload.text ?? "";
    ok("W7b the evening DMs: '📅 vazifa seriyasi' wording, today's line + the missed line for ST2, the missed line only for ST4",
      dms.length === 2 && /^📅 Vazifa seriyasi/.test(d2) && /ugungi vazifa hali topshirilmagan: <b>Vazifa 2026-10-06<\/b> — 23:59 gacha \+5 ball/.test(d2) &&
      /5-oktabr vazifasi ham ochiq \(kechikkan — \+3 ball\)/.test(d2) &&
      !/ugungi vazifa hali/.test(d4) && /5-oktabr vazifasi ham ochiq/.test(d4) && (w.body.dms as Row)?.sent === 2, { d2, d4 });
    setClock(utc("2026-10-06T19:02:00"));
    const r2 = await tick();
    ok("W7c the next minute: no second evening DM", !r2.out?.evening_queued && await count(db, "select count(*) n from challenge_task_outbox where kind = 'evening'") === 2, r2.out);
    setClock(utc("2026-10-06T20:00:30"));
    const rs = await tick();
    ok("W7d 20:00: one anonymous summary per group whose task post went out", rs.out?.summaries_queued === 6, rs.out);
    const j = since();
    await work();
    const sums = sentFrom(j, "sendMessage").filter((s) => s.opts.purpose === "challenge_task_post_summary");
    const g1 = sums.find((s) => s.payload.chat_id === CH1)?.payload.text ?? "";
    ok("W7e the summary: counts only (no names), in the topic, with the task-card button",
      sums.length === 6 && /^📊 <b>Bugungi vazifa natijasi<\/b> \(6-oktabr\)/.test(g1) && /✅ Topshirdi: 2 \(o‘z vaqtida: 2\)/.test(g1) &&
      !/Student/.test(g1) && sums.every((s) => s.payload.message_thread_id > 1), g1);
  }

  // ───────────── W8. the identity sweep ─────────────
  console.log("W8. identity sweep: register an unknown poster, link an intake username, back off a chat admin, window mode while paused");
  {
    setClock(utc("2026-10-06T21:00:30"));
    const mu = tgm({ chat: CH2, thread: D2, from: 5555, username: "newkid", at: "2026-10-06T21:00:00", photo: "w8a" });
    mu.from.first_name = "Yangi";
    await inbox(db, mu);
    await reconcile(db);
    ok("W8a the reconciler recorded a shaped unknown sender (no ledger row)", await count(db, "select count(*) n from challenge_task_retry where tg_user_id = 5555 and shaped") === 1);
    const d = await due();
    ok("W8b the tick would kick for identity work", d.identity === 1, d);
    const i = since();
    const w = await work();
    const p = await one(db, "select id, group_id, account_type, name from profiles where telegram_id = 5555");
    const sw = await one(db, "select details d from admin_actions where action = 'challenge_task_identity_sweep' order by created_at desc limit 1");
    ok("W8c registered through the gated resolver + the registrar: G2, provisional, the engine called with x-internal-secret",
      p?.group_id === G2 && p?.account_type === "provisional" && p?.name === "Yangi" && fetchCalls.length === 1 &&
      fetchCalls[0].url === "https://example.test/functions/v1/admin-create-students" && fetchCalls[0].headers["x-internal-secret"] === "test-internal-secret" &&
      fetchCalls[0].body.target_group_id === G2 && fetchCalls[0].body.students?.[0]?.account_type === undefined &&
      (w.body.identity as Row)?.registered === 1 && sw?.d?.registered === 1 && JSON.stringify(sw?.d?.attempted) === "[5555]" &&
      await count(db, "select count(*) n from admin_actions where action = 'auto_registered_provisional' and target_user_id = $1", [p?.id]) === 1, { p, sw, body: w.body });
    ok("W8d the chat-admin probe ran first (getChatMember, record:false) — the only Telegram call",
      sentFrom(i).length === 1 && sentFrom(i)[0].method === "getChatMember" && sentFrom(i)[0].opts.record === false, sentFrom(i));
    await reconcile(db);
    const s = await liveOf(db, String(p?.id), TTUE);
    ok("W8e the next reconcile credits the new student; the receipt is the worker's", s?.status === "accepted" && s?.receipt_state === "pending", s);
    const j = since();
    await work();
    ok("W8f … and the worker replies under the work in 2-GURUH's topic", sentFrom(j, "sendMessage").some((x) => x.payload.chat_id === CH2 &&
      x.payload.message_thread_id === D2 && x.payload.reply_parameters?.message_id === mu.message_id));

    // the intake kid: no telegram_id, found by a UNIQUE same-group username (C19) → linked by the sweep
    setClock(utc("2026-10-06T21:05:30"));
    const mi = tgm({ from: 6666, username: "intake_kid", at: "2026-10-06T21:05:00", photo: "w8b" });
    const ri = await cap(db, mi);
    await botSent(IU);
    ok("W8g the engine credited the intake kid by username", ri.outcome === "created" && ri.resolved_via === "username_match", ri);
    const k = since();
    const wl = await work();
    const iu = await one(db, "select telegram_id from profiles where id = $1", [IU]);
    ok("W8h the sweep LINKED the telegram_id through the gated username link (no registration, no probe)",
      Number(iu.telegram_id) === 6666 && (wl.body.identity as Row)?.linked === 1 && fetchCalls.length === 1 &&
      !sentFrom(k).some((x) => x.method === "getChatMember") &&
      await count(db, "select count(*) n from admin_actions where action = 'group_poster_linked_by_username' and target_user_id = $1", [IU]) === 1, { iu, body: wl.body });

    // a chat admin posting in the topic: declined, and backed off for 60 minutes (no kick loop)
    setClock(utc("2026-10-06T21:10:30"));
    const ma = tgm({ from: 8888, username: "boss", at: "2026-10-06T21:10:00", photo: "w8c" });
    await inbox(db, ma);
    await reconcile(db);
    script = (method, payload) => method === "getChatMember" && payload.user_id === 8888 ? { outcome: okOut(), result: { status: "administrator" } } : null;
    const wa = await work();
    script = null;
    ok("W8i a chat admin is never registered: unresolved (declined), 'challenge_task_autoreg_skipped'",
      (wa.body.identity as Row)?.unresolved === 1 && fetchCalls.length === 1 &&
      await count(db, "select count(*) n from profiles where telegram_id = 8888") === 0 &&
      await count(db, "select count(*) n from admin_actions where action = 'challenge_task_autoreg_skipped'") === 1, wa.body);
    ok("W8j backoff: the same sender is not due again for 60 minutes (the tick does not kick every minute)", (await due()).identity === 0);
    setClock(utc("2026-10-06T22:12:00"));
    ok("W8k … and is retried after 60 minutes (the retry row lives 26 hours)", (await due()).identity === 1);

    // PR-8's pre-step: the WINDOW sweep while PAUSED (nothing is captured before go-live)
    await cfgSet(db, "enabled", false);
    setClock(utc("2026-10-06T22:20:00"));
    await inbox(db, tgm({ chat: CH2, thread: D2, from: 7777, username: "kamola", at: "2026-10-06T22:15:00", text: "Bugungi vazifani bajardim, mana natija" }));
    await inbox(db, tgm({ chat: CH2, thread: D2, from: 7778, at: "2026-10-06T22:16:00", text: "salom" }));
    await inbox(db, tgm({ chat: CH2, thread: D2, from: 7779, at: "2026-10-06T22:17:00", text: "Bugungi vazifani bajardim, mana natija", fwdFrom: 1 }));
    const req = (await one(db, "select challenge_task_identity_sweep_request($1::timestamptz) r", [utc("2026-10-06T22:00:00")])).r as Row;
    const call = (await net("challenge-tasks-worker")).at(-1);
    ok("W8l the admin action: ONE call to the worker (mode identity_sweep + the window), works while paused",
      req.ok === true && call?.body?.mode === "identity_sweep" && Date.parse(call?.body?.since) === Date.parse(utc("2026-10-06T22:00:00")) &&
      await count(db, "select count(*) n from admin_actions where action = 'challenge_task_identity_sweep_requested'") === 1, { req, call });
    const cands = (await one(db, "select challenge_task_identity_candidates($1::timestamptz) c", [utc("2026-10-06T22:00:00")])).c as Row;
    ok("W8m window candidates: work-shaped senders with no profile only (not 'salom', not a forward)",
      cands.mode === "window" && JSON.stringify((cands.candidates as Row[]).map((c) => c.tg_user_id)) === "[7777]", cands);
    const m = since();
    const ww = await work({ mode: "identity_sweep", since: utc("2026-10-06T22:00:00") });
    const sw2 = await one(db, "select details d from admin_actions where action = 'challenge_task_identity_sweep' order by created_at desc limit 1");
    ok("W8n the window sweep registers 7777 while paused and sends NOTHING but the admin probe",
      await count(db, "select count(*) n from profiles where telegram_id = 7777 and group_id = $1", [G2]) === 1 &&
      sw2?.d?.mode === "window" && sw2?.d?.registered === 1 && sentFrom(m).every((x) => x.method === "getChatMember") &&
      await count(db, "select count(*) n from challenge_task_messages where tg_user_id = 7777") === 0, { body: ww.body, sw: sw2?.d });
    const bad = await work({ mode: "identity_sweep", since: "not-a-date" });
    ok("W8o a malformed window is refused (400), recorded", bad.httpStatus === 400 && (await lastRun())?.status === "bad_request");
    await cfgSet(db, "enabled", true);
  }

  // ───────────── W10. rollover + no task today ─────────────
  console.log("W10. Wednesday: yesterday's stranded post is skipped; a task day without a task writes one row");
  {
    await db.query("insert into challenge_task_posts (task_id, group_id, kind, state, chat_id, thread_id) values ($1, $2, 'summary', 'queued', $3, 10)", [TMON, G9, CH9]);
    setClock(utc("2026-10-07T09:00:30"));
    const r = await tick();
    ok("W10a a post of a PAST date still queued → 'skipped' + 'challenge_task_post_skipped' (never posted a day late)",
      r.out?.posts_skipped === 1 && (await one(db, "select state s from challenge_task_posts where task_id = $1 and group_id = $2 and kind = 'summary'", [TMON, G9])).s === "skipped" &&
      await count(db, "select count(*) n from admin_actions where action = 'challenge_task_post_skipped'") === 1, r.out);
    ok("W10b Wednesday has no approved task: 'challenge_task_no_task_today' once, nothing posted, no morning DM",
      r.out?.no_task_today === true && !r.out?.posts_queued && !r.out?.morning_queued &&
      await count(db, "select count(*) n from admin_actions where action = 'challenge_task_no_task_today'") === 1, r.out);
    setClock(utc("2026-10-07T09:01:30"));
    await tick();
    ok("W10c … once a day", await count(db, "select count(*) n from admin_actions where action = 'challenge_task_no_task_today'") === 1);
    // the admin approves Wednesday's draft at 09:40: the post AND the morning DMs still go out (per task set)
    await db.query("update challenge_tasks set status = 'approved' where task_date = '2026-10-07'");
    setClock(utc("2026-10-07T09:40:30"));
    const r2 = await tick();
    ok("W10e a task approved late (09:40) is posted and its morning DMs are queued the same minute",
      r2.out?.posts_queued === 6 && r2.out?.morning_queued === 3 && r2.kicked === true, r2.out);
    setClock(utc("2026-10-07T09:41:30"));
    const r3 = await tick();
    ok("W10f … once (the next minute queues nothing)", !r3.out?.posts_queued && !r3.out?.morning_queued, r3.out);
  }

  // ───────────── W9. DM edges ─────────────
  console.log("W9. DMs: a result DM from the CURRENT state; a blocked student is skipped; an expired DM is dropped");
  setClock(utc("2026-10-07T10:00:30"));
  {
    await db.query(`insert into challenge_task_outbox (user_id, kind, task_id, submission_id, dedupe_key, payload)
                    values ($1, 'result', $2, $3, 'result:test', '{"decision":"accepted"}'),
                           ($4, 'morning', $2, null, 'morning:test', '{"task_id": ${TMON}, "title": "X", "points": 5}'),
                           ($5, 'morning', $2, null, 'morning:exp', $6::jsonb)`,
      [ST(3), TMON, subR, ST(5), ST(6), JSON.stringify({ task_id: TMON, title: "X", points: 5, expires_at: utc("2026-10-07T09:59:00") })]);
    script = (method, payload) => method === "sendMessage" && payload.chat_id === 2005 ? { outcome: okOut("recipient"), result: null } : null;
    const i = since();
    const w = await work();
    script = null;
    const res = sentFrom(i, "sendMessage").find((s) => s.opts.purpose === "challenge_task_dm_result");
    ok("W9a the result DM: the student's own chat, the CURRENT state (accepted, +5), the title and date",
      res?.payload.chat_id === 2003 && res?.payload.text === "✅ «Vazifa 2026-10-05» (5-oktabr) qabul qilindi: +5 ball.", res?.payload);
    ok("W9b a blocked / never-started student → the row is 'skipped' (terminal), never retried",
      (await one(db, "select state from challenge_task_outbox where dedupe_key = 'morning:test'")).state === "skipped" &&
      (w.body.dms as Row)?.skipped === 1, w.body.dms);
    ok("W9c a DM past its window (a 'good morning' at night) is dropped, DB-visible, never sent",
      (await one(db, "select state, error from challenge_task_outbox where dedupe_key = 'morning:exp'")).error === "expired" &&
      !sentFrom(i, "sendMessage").some((s) => s.payload.chat_id === 2006) && (w.body.dms as Row)?.expired === 1, w.body.dms);
    ok("W9d the same run posts Wednesday's late-approved task and sends its three morning DMs (before 12:00)",
      sentFrom(i, "sendMessage").filter((s) => s.opts.purpose === "challenge_task_post_task").length === 6 &&
      sentFrom(i, "sendMessage").filter((s) => s.opts.purpose === "challenge_task_dm_morning" && [2001, 2002, 2004].includes(s.payload.chat_id)).length === 3,
      w.body);
  }
  {
    setClock(utc("2026-10-09T18:00:30"));
    await tick();
    ok("W10d Friday 18:00: tomorrow is a REST day → no missing-task alert", await count(db,
      "select count(*) n from admin_actions where action = 'challenge_task_no_task_tomorrow' and details->>'date' = '2026-10-10'") === 0);
  }

  // ───────────── W11. the watchdog watches the tick and the worker ─────────────
  console.log("W11. the watchdog: tick_silent / worker_receipts / worker_dms / worker_errors");
  {
    setClock(utc("2026-10-10T10:30:00"));
    await tick();
    const alarms = async () => ((await one(db, "select challenge_tasks_watchdog() w")).w as Row).alarms as string[];
    let a = await alarms();
    ok("W11a a fresh tick, an empty backlog: none of the four", !a.some((x) => ["tick_silent", "worker_receipts", "worker_dms", "worker_errors", "worker_watch_crashed"].includes(x)), a);
    await db.query("update app_settings set value = jsonb_set(value, '{checked_at}', to_jsonb(now() - interval '15 minutes')) where key = 'challenge_tasks_tick_state'");
    await db.query(`update challenge_task_submissions set receipt_version = receipt_version + 1, receipt_state = 'pending', updated_at = now() - interval '40 minutes'
                    where id = $1`, [subR]);
    await db.query(`insert into challenge_task_outbox (user_id, kind, dedupe_key, payload, not_before) values ($1, 'backfill_summary', 'bf:test', '{}', now() - interval '2 hours')`, [ST(2)]);
    await db.query(`insert into admin_actions (action, details) values ('challenge_task_worker_run', '{"status":"crashed"}')`);
    a = await alarms();
    ok("W11b the tick silent 15 min, a receipt pending 40 min, a DM pending 2 h, a crashed run → all four alarms",
      ["tick_silent", "worker_receipts", "worker_dms", "worker_errors"].every((x) => a.includes(x)) && !a.includes("worker_watch_crashed"), a);
    await cfgSet(db, "receipts", false);
    await cfgSet(db, "dm", false);
    a = await alarms();
    ok("W11d receipts / DMs switched OFF by config: their backlog is expected, not an alarm", !a.includes("worker_receipts") && !a.includes("worker_dms"), a);
    await cfgSet(db, "receipts", true);
    await cfgSet(db, "dm", true);
    setClock(utc("2026-10-10T23:30:00"));
    await tick();
    a = await alarms();
    ok("W11c inside the quiet hours a waiting DM is not an alarm (it may not be sent yet); a fresh tick is not silent",
      !a.includes("worker_dms") && !a.includes("tick_silent"), a);
  }

  // ───────────── W12. the ledger stays whole ─────────────
  console.log("W12. invariants");
  {
    const inv = (await one(db, "select challenge_tasks_health()->'invariants' i")).i as Row;
    ok("W12a every health invariant is zero; user_xp equals the ledger", await userXpOk(db) && Object.values(inv).every((v) => Number(v) === 0), inv);
    ok("W12b the tick never failed a section", await count(db, "select count(*) n from admin_actions where action = 'challenge_task_tick_failed'") === 0,
      await q(db, "select details from admin_actions where action = 'challenge_task_tick_failed'"));
    ok("W12c every worker run was ok / inactive / a deliberate bad request (no partial; the one crash is W11's insert)",
      await count(db, "select count(*) n from admin_actions where action = 'challenge_task_worker_run' and details->>'status' not in ('ok', 'inactive', 'bad_request', 'crashed')") === 0,
      await q(db, "select details from admin_actions where action = 'challenge_task_worker_run' and details->>'status' not in ('ok', 'inactive', 'bad_request')"));
  }
  await db.close();

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) throw new Error(`daily_tasks_worker: ${fail} check(s) failed`);
}
