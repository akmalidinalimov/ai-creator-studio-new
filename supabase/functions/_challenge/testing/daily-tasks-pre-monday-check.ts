// PGlite harness for 20261001070000_daily_tasks_pre_monday.sql, the Daily Tasks fixes due before the first live post.
// The REAL engine runs on a real PostgreSQL with a pinned clock: #218 + PR-1 + PR-2 + PR-3 + PR-6 + PR-5 + PR-9 + the
// go-live, applied in production's order, with the REAL tick, watchdog, capture and Mini App read.
//
//   deno test -A --node-modules-dir=none --no-lock supabase/functions/_challenge/testing/daily-tasks-pre-monday-check.ts
//   (PRE_MONDAY_MIG_PATH=<file> runs it against a draft of the migration)
//
// The world is a VERBATIM copy of daily-tasks-go-live-check.ts's world, which is itself daily-tasks-engine-check.ts's
// fixture world. On top of it: production's platform_settings.challenge_tasks, the LIVE auth.uid() / auth.role(),
// 20260930200010 (PR-9) and 20260930203000 (go-live: 25 drafts, switched on). Then THIS migration.
//
//   P0 the migration. The world's six target functions are md5-identical to production's (live pins). It applies.
//      Each rewritten body equals its _new_pin. A replay changes nothing (markers, one audit row).
//   P1 (item 1) week 1 is never approved, with drafts only:
//      - Thursday and Friday are not task days, so there is no alert.
//      - Sunday 18:00: ONE "tomorrow is not approved" row plus the admin DM ("Qoralama bor").
//      - The watchdog alarms no_task_tomorrow.
//      - Monday 08:00: ONE morning row plus the DM (⏰, the week link). It does not repeat.
//      - Monday 09:00: NO post is queued (a draft never posts), and a 'no_task_today' row is written.
//      - Monday 09:47: the watchdog alarms no_task_today.
//      - Work posted on Monday scores nothing.
//      - An approval at 09:50 still posts the same day.
//   P2 (item 2) held_senders. A 5.0 student posts in a 6.0 daily topic: Thursday (no task day) gives no alarm;
//      Monday (a task day) does.
//   P3 (item 3) the displayed streak is the CURRENT run. Cases:
//      - on time Mon-Wed, missed Thu and Fri: 3, then 0;
//      - a pending on-time check keeps the run alive until it closes;
//      - late work and a missed first day;
//      - rest days and a draft Monday do not break the run.
//      recompute's awards are untouched.
//   P4 (item 4) hints: the reconciler or backfill never marks a hint as sent (no_slot, wrong_group, held). The bot's
//      real hint follows the same day, once. A reconciler re-derivation of yesterday's held message is not today's
//      activity.
//   P8 (item 8) my_challenge_tasks: a student gets ok; staff (teacher, admin) get 'staff'; archived and inactive
//      profiles get 'inactive'; a 5.0 student gets 'not_in_challenge'.
//
// CI NOTE: named *-check.ts (never *_test.ts) so CI's `deno test supabase/functions/` never collects it. Run it by path.
// TEST INFRASTRUCTURE ONLY: this directory has no index.ts, so it is never deployed.

// ═══ BEGIN VERBATIM: daily-tasks-go-live-check.ts lines 34-335 (itself daily-tasks-engine-check.ts's fixture world; keep identical) ═══
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

// production's platform_settings.challenge_tasks, read 2026-09-30 (no credential in it)
const LIVE_CHALLENGE_TASKS = {
  ai: false, dm: true, ig: { tag_handle: "aicreators.students", min_confidence: 0.6, require_recent: true, existence_probe: true,
    dhash_max_distance: 4, handle_edit_distance: 1, recent_min_confidence: 0.8, lock_handle_after_accept: true },
  post: true, points: { general: 5, instagram: 8 }, remind: true, streak: { bonus: 10, every: 5 }, enabled: false,
  generic: { offtask_min_confidence: 0.85 }, miniapp: false, summary: true, receipts: true,
  ai_models: { openai: "gpt-5-mini", anthropic: "claude-haiku-4-5" }, ai_prices: { openai: [0.25, 2], anthropic: [1, 5] },
  late_days: 2, post_time: "09:00", quiet_end: "08:00", late_factor: 0.5, quiet_start: "22:00", remind_time: "19:00",
  miniapp_link: null, summary_time: "20:00", auto_register: true, min_voice_sec: 3, task_weekdays: [1, 2, 3, 4, 5],
  min_text_chars: 20, test_group_ids: [], merge_window_min: 5, ai_provider_order: ["anthropic", "openai"], max_items_per_day: 40,
  miniapp_onboarding: false, ai_daily_budget_usd: 3, fail_open_after_min: 60, liveness_check_time: "14:00", max_attempts_per_task: 3,
  max_moves_per_submission: 5, ai_max_checks_per_user_day: 6, receipt_budget_per_chat_min: 12, backfill_receipt_max_age_min: 120,
};

Deno.test({
  name: CAN_RUN
    ? "daily_tasks_pre_monday: 20261001070000 (week-1 alarms, held gate, current streak, hint ownership, Mini App gate) on PGlite"
    : "daily_tasks_pre_monday: SKIPPED -- needs `deno test -A --node-modules-dir=none` (PGlite reads its own files)",
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
  // ═══════════════════════════════ 20261001070000: the pre-Monday fixes ═══════════════════════════════
  const MIG6 = lf(await Deno.readTextFile(here("../../../migrations/20260930151010_challenge_task_ai_check.sql")));
  const MIG5 = lf(await Deno.readTextFile(here("../../../migrations/20260930152010_challenge_daily_tasks_worker.sql")));
  const MIG9 = lf(await Deno.readTextFile(here("../../../migrations/20260930200010_challenge_tasks_week_approval.sql")));
  const GL = lf(await Deno.readTextFile(here("../../../migrations/20260930203000_challenge_daily_tasks_go_live.sql")));
  const PM_PATH = Deno.env.get("PRE_MONDAY_MIG_PATH");
  const PM = lf(await Deno.readTextFile(PM_PATH ?? here("../../../migrations/20261001070000_daily_tasks_pre_monday.sql")));

  const utc = (local: string) => new Date(Date.parse(local + "+05:00")).toISOString();
  const at = (local: string) => setClock(utc(local));
  const REFS = Array.from({ length: 25 }, (_, i) => `W${Math.floor(i / 5) + 1}D${(i % 5) + 1}`);
  const audit = async (db: PG, action: string) =>
    await q(db, "select details d, target_user_id u from admin_actions where action = $1 order by created_at", [action]);
  const tick = async (db: PG) => (await one(db, "select challenge_tasks_tick() r")).r as Row;
  const watchdog = async (db: PG) => (await one(db, "select challenge_tasks_watchdog() w")).w as Row;
  const taskDay = async (db: PG, d: string) =>
    (await one(db, "select challenge_task_is_task_day($1, $2::date, challenge_tasks_config()) t", [C6, d])).t === true;
  const md5Of = async (db: PG, sig: string) =>
    String((await one(db, "select md5(replace(prosrc, E'\\r', '')) m from pg_proc where oid = $1::text::regprocedure", [sig])).m);
  const metaOf = async (db: PG, sig: string) => await one(db, `select array(select x::text from unnest(proacl) x order by 1)::text acl,
      proowner::int owner, prosecdef, proconfig::text cfg, provolatile::text vol from pg_proc where oid = $1::text::regprocedure`, [sig]);
  const calls = async (db: PG, purpose: string) =>
    await q(db, "select body->>'text' t, body->>'chat_id' chat from ops_net_calls where purpose = $1 order by id", [purpose]);
  const heldRows = async (db: PG, user: string, sinceLocal?: string) =>
    await q(db, `select details d from admin_actions where action = 'challenge_task_sender_held' and target_user_id = $1
                  and created_at >= coalesce($2::timestamptz, '-infinity') order by created_at`, [user, sinceLocal ? utc(sinceLocal) : null]);
  const ledger = async (db: PG, chat: number, mid: number) =>
    await one(db, "select outcome, reason, hinted, source from challenge_task_messages where chat_id = $1 and message_id = $2", [chat, mid]);

  // ── the world: production's order (PR-3 -> PR-6 -> PR-5 -> PR-9 -> go-live), the live config and auth helpers ──
  at("2026-10-01T03:00:00");
  const db = await freshDb();
  await db.exec(BOT_EXTRA);
  await db.exec(WORKER_EXTRA);
  for (const [name, sql] of [["PR-3", MIG], ["PR-6", MIG6], ["PR-5", MIG5]] as const) {
    const e = await tx(db, sql);
    if (e) throw new Error(`${name} did not apply: ${e}`);
  }
  await db.exec(WORKER_DATA);
  await db.query("update platform_settings set value = $1::jsonb where key = 'challenge_tasks'", [JSON.stringify(LIVE_CHALLENGE_TASKS)]);
  // the LIVE auth.uid() / auth.role() (2026-09-30): claim.sub first, then the claims json (PR-9 reads both)
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
  at("2026-10-01T08:30:00");
  for (const [name, sql] of [["PR-9", MIG9], ["go-live", GL]] as const) {
    const e = await tx(db, sql);
    if (e) throw new Error(`${name} did not apply: ${e}`);
  }
  // the bug the old streak function had, kept as a fixture to show the difference (its body is the live pinned text)
  await db.exec(`create function public.old_streak_current_fixture(_user uuid, _course uuid) returns integer language sql stable
    set search_path = public as $f$
  with t as (
    select x.task_date,
           exists (select 1 from public.challenge_task_submissions s
                    where s.user_id = _user and s.task_id = x.id and s.status = 'accepted' and s.late_days = 0) as done
      from public.challenge_tasks x
     where x.course_id = _course and x.status = 'approved'
  ),
  last_done as (select max(task_date) as d from t where done),
  last_miss as (select max(t.task_date) as d from t, last_done where not t.done and t.task_date < last_done.d)
  select coalesce((select count(*)::int from t, last_done, last_miss
                    where t.done and t.task_date <= last_done.d and (last_miss.d is null or t.task_date > last_miss.d)), 0)
$f$;`);

  // ───────────── P0. the migration ─────────────
  console.log("P0. the pinned rewrites: live pins, apply, new pins, untouched neighbours, atomic refusal, replay");
  const PINS: Record<string, string> = {
    "challenge_task_is_task_day(uuid,date,jsonb)": "baa7e4373d3143150dc06ad9de17c389",
    "challenge_task_streak_current(uuid,uuid)": "be2d9b3c0f58c6c0662467aeadf3b5ab",
    "challenge_task_capture(jsonb,text,jsonb)": "226e33fb8a26cfd065bbd44fd3336366",
    "my_challenge_tasks()": "fc71285882845e02332b6759a3187387",
    "challenge_tasks_watchdog(timestamp with time zone)": "3bc7d4e73b1c3d0c2b959a7ae16e378c",
    "challenge_tasks_tick()": "7e39fa98f564daa287960c045fac7fdb",
  };
  // live md5s (2026-10-01) of the neighbours this file must NOT change: the streak AWARDS, the health, the generic
  // once-a-day helper, the Mini App gate it copies, the admin-DM path it reuses
  const UNTOUCHED: Record<string, string> = {
    "challenge_task_streak_recompute(uuid,uuid,jsonb)": "df4cc048394bc62a9ea300960d93fb13",
    "challenge_tasks_health(timestamp with time zone)": "f5ab18b25695675f0792b6447d63a454",
    "challenge_task_note_once(text,uuid,jsonb)": "08ea0fde64b2b62c1c3bac180e618db8",
    "challenge_task_prepare_miniapp(uuid,bigint)": "86fbda0f5da09b2c4fba455db2fb0573",
    "challenge_tasks_admin_dm(text,text)": "596f8872ff5c36402fb3358e5e884440",
  };
  const NAME_OF = (sig: string) => sig.slice(0, sig.indexOf("("));
  const NEW_PINS: Record<string, string> = {};
  for (const m of PM.matchAll(/\('([a-z_]+)',\s*'public\.[^']*',\s*'([0-9a-f]{32})',[^\n]*\n\s*'([0-9a-f]{32})'/g)) NEW_PINS[m[1]] = m[3];
  const META: Record<string, Row> = {};
  {
    const bad: unknown[] = [];
    for (const [sig, pin] of Object.entries({ ...PINS, ...UNTOUCHED })) {
      const m = await md5Of(db, sig);
      if (m !== pin) bad.push({ sig, world: m, live: pin });
    }
    ok("P0a the world's 6 target functions and 5 neighbours ARE production's (md5 read live 2026-10-01)", bad.length === 0, bad);
    ok("P0b the migration pins a new body for each of the 6 functions", Object.keys(NEW_PINS).length === 6 &&
      Object.keys(PINS).every((sig) => /^[0-9a-f]{32}$/.test(NEW_PINS[NAME_OF(sig)] ?? "")), NEW_PINS);
    for (const sig of Object.keys(PINS)) META[sig] = await metaOf(db, sig);

    // a function that drifted from its pin -> ABORT, atomically (the tick is the LAST one rewritten)
    const tickDef = String((await one(db, "select pg_get_functiondef('public.challenge_tasks_tick()'::regprocedure) d")).d);
    await db.exec(tickDef.replace("-- (g) kick the worker", "-- (g)  kick the worker"));
    at("2026-10-01T12:30:00");
    const eDrift = await tx(db, PM);
    ok("P0c a drifted live body (the tick) -> ABORT naming it; nothing else was rewritten (atomic)",
      eDrift !== null && eDrift.includes("challenge_tasks_tick changed since it was verified") &&
      await md5Of(db, "challenge_task_is_task_day(uuid,date,jsonb)") === PINS["challenge_task_is_task_day(uuid,date,jsonb)"] &&
      await count(db, "select count(*) n from admin_actions where action = 'challenge_tasks_pre_monday_applied'") === 0, eDrift);
    await db.exec(tickDef);
    ok("P0d (the tick restored to the live body)", await md5Of(db, "challenge_tasks_tick()") === PINS["challenge_tasks_tick()"]);

    const e = await tx(db, PM);
    ok("P0e 20261001070000 applies (prerequisites, 6 pinned rewrites, self-test, audit)", e === null, e);
    const now: Record<string, string> = {};
    for (const sig of Object.keys(PINS)) now[NAME_OF(sig)] = await md5Of(db, sig);
    console.log(`     rewritten md5s: ${JSON.stringify(now)}`);
    ok("P0f every rewritten body is the pinned one", Object.keys(PINS).every((sig) => now[NAME_OF(sig)] === NEW_PINS[NAME_OF(sig)]),
      { now, NEW_PINS });
    const metaSame: unknown[] = [];
    for (const sig of Object.keys(PINS)) {
      const m2 = await metaOf(db, sig);
      if (JSON.stringify(m2) !== JSON.stringify(META[sig])) metaSame.push({ sig, before: META[sig], after: m2 });
    }
    ok("P0g owner, ACL, SECURITY DEFINER, search_path and volatility unchanged on all 6", metaSame.length === 0, metaSame);
    const bad2: unknown[] = [];
    for (const [sig, pin] of Object.entries(UNTOUCHED)) if (await md5Of(db, sig) !== pin) bad2.push(sig);
    ok("P0h the streak AWARDS (recompute), the health, note_once, prepare_miniapp and admin_dm are untouched", bad2.length === 0, bad2);
    const ap = await audit(db, "challenge_tasks_pre_monday_applied");
    ok("P0i one audit row: the 6 md5s, the calendar start of 6.0 (2026-10-05, a task day), the is_task_day readers",
      ap.length === 1 && Object.keys(ap[0].d.functions ?? {}).length === 6 &&
      ap[0].d.calendar_start?.[C6]?.first === "2026-10-05" && ap[0].d.calendar_start?.[C6]?.is_task_day === true &&
      JSON.stringify(ap[0].d.is_task_day_readers) === JSON.stringify(["challenge_tasks_health", "challenge_tasks_tick"]), ap[0]?.d);
    const e2 = await tx(db, PM);
    const again: Record<string, string> = {};
    for (const sig of Object.keys(PINS)) again[NAME_OF(sig)] = await md5Of(db, sig);
    ok("P0j replay: applies again, every body unchanged (markers), still ONE audit row",
      e2 === null && JSON.stringify(again) === JSON.stringify(now) &&
      await count(db, "select count(*) n from admin_actions where action = 'challenge_tasks_pre_monday_applied'") === 1, e2);
  }

  // ───────────── P8. one "is a challenge student" rule for the Mini App read ─────────────
  console.log("P8. my_challenge_tasks applies prepare_miniapp's staff / inactive gate");
  {
    await db.query("update profiles set status = 'inactive' where id = $1", [ST(5)]);
    const mine = async (uid: string | null) => (await as<Row[]>(db, uid, "select my_challenge_tasks() r")).rows?.[0]?.r as Row | undefined;
    const st = await mine(ST(1));
    ok("P8a a 6.0 student: ok, enabled, miniapp (the card shows)", st?.ok === true && st?.enabled === true && st?.miniapp === true, st);
    ok("P8b a teacher whose group is a 6.0 group -> {ok:false, reason:'staff'} (no student card)",
      JSON.stringify(await mine(T1)) === JSON.stringify({ ok: false, reason: "staff" }), await mine(T1));
    ok("P8c an admin -> 'staff' (staff is checked first, as prepare_miniapp does)", (await mine(AD))?.reason === "staff");
    ok("P8d an ARCHIVED 6.0 profile -> {ok:false, reason:'inactive'}", JSON.stringify(await mine(S8)) === JSON.stringify({ ok: false, reason: "inactive" }));
    ok("P8e a status 'inactive' 6.0 profile -> 'inactive'", (await mine(ST(5)))?.reason === "inactive");
    ok("P8f a 5.0 student -> 'not_in_challenge' (unchanged); signed out -> 'not_signed_in' (unchanged)",
      (await mine(S5))?.reason === "not_in_challenge" && (await mine(null))?.reason === "not_signed_in");
    const prepT = (await one(db, "select challenge_task_prepare_miniapp($1, null) r", [T1])).r as Row;
    const prepA = (await one(db, "select challenge_task_prepare_miniapp($1, null) r", [S8])).r as Row;
    ok("P8g ...the same verdicts as prepare_miniapp (staff / held_sender:inactive) for the same profiles",
      prepT.reason === "staff" && prepA.reason === "held_sender" && prepA.detail === "inactive", { prepT, prepA });
    const anon = await as(db, null, "select my_challenge_tasks() r", [], "anon");
    ok("P8h anon still cannot call it", anon.err !== null && /permission denied/.test(anon.err), anon.err);
  }

  // ───────────── P2 + P4. Thursday: held senders before the calendar starts; hints belong to the bot ─────────────
  console.log("P2/P4. Thursday 10-01: a 5.0 student in a 6.0 daily topic (held), the reconciler first, then the bot");
  {
    at("2026-10-01T15:00:00");
    const m1 = tgm({ from: 1006, at: "2026-10-01T14:58:00", text: T25 });
    const r1 = await cap(db, m1, "reconciler");
    const h1 = await heldRows(db, S6);
    ok("P4a the reconciler sees a held sender's message first: outcome held, NO hint in its payload, a DB-visible row {source: reconciler, hinted: false}",
      r1.outcome === "sender_out_of_scope" && r1.hint == null && h1.length === 1 && h1[0].d.source === "reconciler" && h1[0].d.hinted === false, { r1, h1 });
    at("2026-10-01T15:01:00");
    const r2 = await cap(db, tgm({ from: 1006, at: "2026-10-01T15:00:30", text: T25 }));
    const h2 = await heldRows(db, S6);
    ok("P4b ...the bot's own capture that day STILL gets the once-a-day hint (held) and writes the topic row {hinted: true}",
      r2.hint?.kind === "held" && h2.length === 2 && h2[1].d.source === "topic" && h2[1].d.hinted === true, { r2, h2 });
    at("2026-10-01T15:02:00");
    const r3 = await cap(db, tgm({ from: 1006, at: "2026-10-01T15:01:30", text: T25 }));
    const r3b = await cap(db, tgm({ from: 1006, at: "2026-10-01T15:01:40", text: T25 }), "reconciler");
    ok("P4c once a day: a second bot capture gets no hint, and neither adds a row", r3.hint == null && r3b.hint == null &&
      (await heldRows(db, S6)).length === 2, r3);
    const r4 = await cap(db, tgm({ from: 1005, at: "2026-10-01T15:01:50", text: T25 }));
    ok("P4d another held sender (bot first): hint + one topic row", r4.hint?.kind === "held" && (await heldRows(db, S5)).length === 1, r4);

    at("2026-10-01T15:46:00");
    await reconcile(db);
    await tick(db);
    at("2026-10-01T15:47:00");
    const wd = await watchdog(db);
    const heldToday = Number(wd.health?.held_24h?.today ?? 0);
    ok("P2a Thursday (no task day yet): 2 held senders today, and the watchdog does NOT alarm held_senders (it used to: today >= 1)",
      heldToday === 2 && Array.isArray(wd.alarms) && !wd.alarms.includes("held_senders") &&
      !wd.alarms.includes("no_task_today") && !wd.alarms.includes("no_task_tomorrow"), { heldToday, alarms: wd.alarms });
    ok("P1a Thursday and Friday are not task days; Monday 10-05 (a draft) IS one now; Saturday is not",
      !(await taskDay(db, "2026-10-01")) && !(await taskDay(db, "2026-10-02")) && await taskDay(db, "2026-10-05") &&
      !(await taskDay(db, "2026-10-10")) && await taskDay(db, "2026-10-12"));

    // Friday 00:10: the reconciler re-derives Thursday 23:55's held message -- not Friday's activity
    at("2026-10-01T23:56:00");
    const late = tgm({ from: 1006, at: "2026-10-01T23:55:00", text: T25 });
    at("2026-10-02T00:10:00");
    const r5 = await cap(db, late, "reconciler");
    ok("P4e Friday 00:10: re-deriving YESTERDAY's held message writes no row dated today (held_24h.today stays clean)",
      r5.outcome === "sender_out_of_scope" && r5.hint == null && (await heldRows(db, S6, "2026-10-02T00:00:00")).length === 0, r5);
  }

  // ───────────── P1. week 1 never approved ─────────────
  console.log("P1. week 1 is never approved: the alerts fire, drafts never post or score");
  {
    const quiet: unknown[] = [];
    for (const m of ["2026-10-01T18:00:30", "2026-10-02T08:00:30", "2026-10-02T09:00:30", "2026-10-02T18:00:30", "2026-10-03T08:00:30",
                     "2026-10-03T18:00:30", "2026-10-04T08:00:30"]) {
      at(m);
      const r = await tick(db);
      if (r.out?.no_task_tomorrow || r.out?.no_task_morning || r.out?.no_task_today || (r.errors && Object.keys(r.errors).length)) quiet.push({ m, r });
    }
    ok("P1b Thursday .. Sunday morning: no alert (Friday is before the calendar, Saturday / Sunday are rest days), no tick error",
      quiet.length === 0 && await count(db, `select count(*) n from admin_actions where action in
        ('challenge_task_no_task_today', 'challenge_task_no_task_tomorrow', 'challenge_task_no_task_morning')`) === 0, quiet);

    at("2026-10-04T18:00:30");
    const sun = await tick(db);
    const tom = await audit(db, "challenge_task_no_task_tomorrow");
    const dmT = await calls(db, "challenge-tasks-tomorrow-check");
    ok("P1c Sunday 18:00: ONE 'challenge_task_no_task_tomorrow' {date 10-05, drafts 1} + the admin DM (it used to be silent)",
      sun.out?.no_task_tomorrow === true && tom.length === 1 && tom[0].d.date === "2026-10-05" && tom[0].d.drafts === 1 &&
      tom[0].d.dm_sent === 1 && dmT.length === 1 && dmT[0].chat === "1011", { out: sun.out, tom, dmT });
    console.log(`     DM: ${dmT[0]?.t}`);
    ok("P1d ...the DM names the day and says a draft is waiting",
      String(dmT[0]?.t).includes("ertangi (5-oktabr, dushanba) vazifa hali TASDIQLANMAGAN") && String(dmT[0]?.t).includes("Qoralama bor"));
    at("2026-10-04T18:01:30");
    await tick(db);
    ok("P1e ...once per date (the next minute adds nothing)", (await audit(db, "challenge_task_no_task_tomorrow")).length === 1 &&
      (await calls(db, "challenge-tasks-tomorrow-check")).length === 1);
    at("2026-10-04T18:46:00");
    await reconcile(db);
    at("2026-10-04T18:47:00");
    const wdS = await watchdog(db);
    ok("P1f the watchdog at Sunday 18:47 alarms no_task_tomorrow (independent of the tick)", wdS.alarms?.includes("no_task_tomorrow"), wdS.alarms);

    at("2026-10-05T07:59:30");
    const q0 = await tick(db);
    ok("P1g Monday 07:59 (quiet hours): no morning alert yet", !q0.out?.no_task_morning &&
      (await audit(db, "challenge_task_no_task_morning")).length === 0, q0.out);
    at("2026-10-05T08:00:30");
    const mo = await tick(db);
    const morn = await audit(db, "challenge_task_no_task_morning");
    const dmM = await calls(db, "challenge-tasks-morning-check");
    console.log(`     DM: ${dmM[0]?.t}`);
    ok("P1h Monday 08:00: ONE 'challenge_task_no_task_morning' {date 10-05, drafts 1} + the admin DM (⏰, before 09:00, the week link)",
      mo.out?.no_task_morning === true && morn.length === 1 && morn[0].d.date === "2026-10-05" && morn[0].d.drafts === 1 &&
      morn[0].d.dm_sent === 1 && dmM.length === 1 && String(dmM[0].t).startsWith("⏰ Kunlik vazifalar: bugungi (5-oktabr, dushanba)") &&
      String(dmM[0].t).includes("09:00 gacha tasdiqlang") &&
      String(dmM[0].t).includes("https://www.aicreator.academy/admin/challenge/tasks?week=2026-10-05"), { out: mo.out, morn, dmM });
    at("2026-10-05T08:30:30");
    const m2 = await tick(db);
    ok("P1i ...once per date", !m2.out?.no_task_morning && (await audit(db, "challenge_task_no_task_morning")).length === 1 &&
      (await calls(db, "challenge-tasks-morning-check")).length === 1 && !(m2.errors && Object.keys(m2.errors).length), m2);

    // P4: no_slot -- the reconciler first, then the bot (drafts only: there is no open task)
    at("2026-10-05T08:40:00");
    const w1 = tgm({ from: TG(2), at: "2026-10-05T08:38:00", photo: "pm-a", caption: T25 });
    const rr = await cap(db, w1, "reconciler");
    const l1 = await ledger(db, CH1, w1.message_id);
    ok("P4f a reconciler capture of work (no open task): no_slot, NO hint in its payload, ledger row hinted = false",
      rr.outcome === "no_slot" && rr.hint == null && l1?.hinted === false && l1?.source === "reconciler", { rr, l1 });
    at("2026-10-05T08:41:00");
    const w2 = tgm({ from: TG(2), at: "2026-10-05T08:40:30", photo: "pm-b", caption: T25 });
    const rt = await cap(db, w2);
    ok("P4g ...the student's next post through the bot gets the day's hint (no_slot_no_open_task), hinted = true",
      rt.hint?.kind === "no_slot_no_open_task" && (await ledger(db, CH1, w2.message_id))?.hinted === true, rt);
    const w3 = tgm({ from: TG(2), at: "2026-10-05T08:40:50", photo: "pm-c", caption: T25 });
    const rt2 = await cap(db, w3);
    ok("P4h ...once a day", rt2.hint == null && (await ledger(db, CH1, w3.message_id))?.hinted === false, rt2);
    ok("P1j drafts never score: that work created no submission and no points",
      await count(db, "select count(*) n from challenge_task_submissions where user_id = $1", [ST(2)]) === 0 &&
      await count(db, "select count(*) n from xp_events where user_id = $1", [ST(2)]) === 0);

    at("2026-10-05T09:00:30");
    const nine = await tick(db);
    ok("P1k Monday 09:00 with week 1 still drafts: NO post queued (a draft never posts) + a 'no_task_today' row",
      !nine.out?.posts_queued && await count(db, "select count(*) n from challenge_task_posts") === 0 &&
      (await audit(db, "challenge_task_no_task_today")).length === 1, nine.out);

    // P2 on a task day: the held signal is real
    at("2026-10-05T09:10:00");
    const rh = await cap(db, tgm({ from: 1005, at: "2026-10-05T09:09:00", text: T25 }));
    at("2026-10-05T09:46:00");
    await reconcile(db);
    await tick(db);
    at("2026-10-05T09:47:00");
    const wdM = await watchdog(db);
    ok("P2b Monday (a task day): the held 5.0 student gets the day's hint and the watchdog DOES alarm held_senders",
      rh.hint?.kind === "held" && wdM.alarms?.includes("held_senders"), { hint: rh.hint, alarms: wdM.alarms });
    ok("P1l ...and no_task_today (the watchdog's own calendar alarm now covers week 1)", wdM.alarms?.includes("no_task_today"), wdM.alarms);

    // recovery: a late approval still posts the same day
    at("2026-10-05T09:50:00");
    const apv = await as(db, AD, "update challenge_tasks set status = 'approved' where plan_ref = any($1::text[]) returning id",
      [`{${REFS.slice(0, 5).join(",")}}`]);
    at("2026-10-05T09:51:30");
    const t951 = await tick(db);
    const topics = await count(db, "select count(*) n from challenge_task_topics() where course_id = $1", [C6]);
    ok(`P1m an admin approves week 1 at 09:50 -> the 09:51 tick queues one post per 6.0 daily topic (${topics}) the same day`,
      apv.err === null && (apv.rows as Row[]).length === 5 && topics > 0 && t951.out?.posts_queued === topics, { err: apv.err, out: t951.out });
  }

  // ───────────── P4 (wrong_group). a student in another group's daily topic ─────────────
  console.log("P4. wrong_group: the reconciler never uses up the hint");
  {
    at("2026-10-05T10:00:00");
    const a = tgm({ chat: CH2, thread: D2, from: 1001, at: "2026-10-05T09:59:00", photo: "wg-a", caption: T25 });
    const ra = await cap(db, a, "reconciler");
    const la = await ledger(db, CH2, a.message_id);
    ok("P4i reconciler first: wrong_group, no hint, ledger hinted = false", ra.outcome === "wrong_group" && ra.hint == null &&
      la?.hinted === false, { ra, la });
    const b = tgm({ chat: CH2, thread: D2, from: 1001, at: "2026-10-05T09:59:30", photo: "wg-b", caption: T25 });
    const rb = await cap(db, b);
    ok("P4j ...the bot's capture still hints (own topic link) and marks it", rb.hint?.kind === "wrong_group" &&
      (await ledger(db, CH2, b.message_id))?.hinted === true, rb);
    const c = tgm({ chat: CH2, thread: D2, from: 1001, at: "2026-10-05T09:59:40", photo: "wg-c", caption: T25 });
    ok("P4k ...once a day", (await cap(db, c)).hint == null);
    ok("P4l no ledger row written by the reconciler or the backfill is marked hinted",
      await count(db, "select count(*) n from challenge_task_messages where hinted and source <> 'topic'") === 0);
  }

  // ───────────── P3. the displayed streak is the CURRENT run ─────────────
  console.log("P3. challenge_task_streak_current: the current run (display only)");
  {
    const ids = await q(db, "select plan_ref, id from challenge_tasks where course_id = $1 and plan_ref = any($2::text[])",
      [C6, `{${REFS.slice(0, 5).join(",")}}`]);
    const T: Record<string, number> = Object.fromEntries(ids.map((r) => [r.plan_ref, Number(r.id)]));
    const day = (i: number) => `2026-10-0${5 + i}`;   // W1D1 = Mon 10-05 .. W1D5 = Fri 10-09
    const sub = async (user: string, d: number, status: string, late = 0) =>
      await db.query(`insert into challenge_task_submissions (task_id, user_id, group_id, source, attributed_via, status, submitted_at, last_item_at, late_days)
                      values ($1, $2, $3, 'admin', 'admin', $4, $5::timestamptz, $5::timestamptz, $6)`,
        [T[`W1D${d}`], user, G1, status, utc(`${day(d - 1 + late)}T12:00:00`), late]);
    const A = ST(11), B = ST(12), Cc = ST(13), D = ST(14), E = ST(15), F = ST(16), G = ST(17), H = ST(18);
    for (const d of [1, 2, 3]) for (const u of [A, B, Cc, G]) await sub(u, d, "accepted");
    await sub(B, 4, "checking");                 // on time, still being checked
    await sub(Cc, 4, "accepted", 1);             // late work never counts
    await sub(G, 4, "needs_more");               // on time, still incomplete (may still be completed on time)
    for (const d of [2, 3, 4]) await sub(D, d, "accepted");   // missed Monday, then on time Tue-Thu
    for (const d of [1, 2, 3, 4, 5]) await sub(F, d, "accepted");
    for (const d of [1, 2, 3, 4]) await sub(H, d, "accepted");
    await sub(H, 5, "needs_more");               // Friday on time but incomplete, then the weekend
    const cur = async (u: string) => Number((await one(db, "select challenge_task_streak_current($1, $2) n", [u, C6])).n);
    const old = async (u: string) => Number((await one(db, "select old_streak_current_fixture($1, $2) n", [u, C6])).n);
    const snap = async (users: Record<string, string>) => {
      const o: Record<string, number> = {};
      for (const [k, u] of Object.entries(users)) o[k] = await cur(u);
      return o;
    };
    const ALL = { A, B, C: Cc, D, E, G };

    at("2026-10-08T12:00:00");                   // Thursday: W1D4 is today and still open
    const thu = await snap(ALL);
    ok("P3a Thursday noon (today's task still open): A 3, B 3, C 3, D 3, E 0, G 3 -- nothing is broken before the day ends",
      JSON.stringify(thu) === JSON.stringify({ A: 3, B: 3, C: 3, D: 3, E: 0, G: 3 }), thu);
    at("2026-10-09T00:30:00");                   // Friday 00:30: Thursday's on-time day is over
    const fri = await snap(ALL);
    ok("P3b Friday 00:30: A (missed Thursday) 0 -- the old function still said 3; C (Thursday LATE) 0; B (Thursday on time, " +
       "being checked) 3; G (Thursday on time, incomplete) 3; D (Thursday on time, Friday still open) 3",
      JSON.stringify(fri) === JSON.stringify({ A: 0, B: 3, C: 0, D: 3, E: 0, G: 3 }) && await old(A) === 3 && await old(Cc) === 3,
      { fri, oldA: await old(A), oldC: await old(Cc) });
    await db.query("update challenge_task_submissions set status = 'accepted' where user_id = $1 and task_id = $2", [B, T.W1D4]);
    ok("P3c B's Thursday check is accepted (on time) -> 4", await cur(B) === 4);
    at("2026-10-10T12:00:00");                   // Saturday: Friday is over
    const sat = await snap({ ...ALL, F, H });
    ok("P3d Saturday: A 0, B 0 / D 0 / G 0 (missed Friday), C 0, F 5, H 4 (Friday on time but incomplete: completable until it closes)",
      JSON.stringify(sat) === JSON.stringify({ A: 0, B: 0, C: 0, D: 0, E: 0, G: 0, F: 5, H: 4 }) && await old(A) === 3 && await old(D) === 3,
      { sat, oldA: await old(A), oldD: await old(D) });
    at("2026-10-11T12:00:00");                   // Sunday: rest day
    ok("P3e Sunday (a rest day is not a task date): F 5, H 4", await cur(F) === 5 && await cur(H) === 4);
    at("2026-10-12T12:00:00");                   // Monday 10-12: Friday's task CLOSED (task_date + late_days + 1); W2D1 is a DRAFT
    ok("P3f Monday 10-12: H 0 (Friday's task closed incomplete); F still 5 (W2D1 is a draft: a draft never breaks or makes a streak)",
      await cur(H) === 0 && await cur(F) === 5);
    const aw0 = await count(db, "select count(*) n from challenge_task_streak_awards where user_id = $1", [F]);
    const ret = Number((await one(db, "select challenge_task_streak_recompute($1, $2, challenge_tasks_config()) n", [F, C6])).n);
    const aw = await q(db, "select task_date::text d, streak_len, bonus from challenge_task_streak_awards where user_id = $1", [F]);
    ok("P3g the AWARDS are recompute's, unchanged: 5 on-time days -> one +10 award dated Friday 10-09 (and the display agrees: 5)",
      aw0 === 0 && ret === 5 && aw.length === 1 && aw[0].d === "2026-10-09" && aw[0].bonus === 10 &&
      (await xpOf(db, F, "ch_task_streak:2026-10-09"))?.amount === 10 && await cur(F) === 5, { ret, aw });
    ok("P3h user_xp still equals the ledger", await userXpOk(db));
  }

  await db.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) throw new Error(`daily_tasks_pre_monday: ${fail} check(s) failed`);
}
