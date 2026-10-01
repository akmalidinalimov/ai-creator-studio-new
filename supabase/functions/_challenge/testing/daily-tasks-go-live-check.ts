// PGlite harness for the Daily Tasks GO-LIVE (PR-8): migration 20260930203000_challenge_daily_tasks_go_live.sql (the
// 25-task seed as drafts + enabled / ai / miniapp on) against the REAL engine (#218 + PR-1 + PR-2 + PR-3 + PR-6 + PR-5,
// applied in production's order) on a real PostgreSQL, with the REAL per-minute tick and watchdog on a pinned clock.
//
//   deno test -A --node-modules-dir=none --no-lock supabase/functions/_challenge/testing/daily-tasks-go-live-check.ts
//   (GO_LIVE_MIG_PATH=<file> points it at a draft of the migration)
//
// The world is a VERBATIM copy of daily-tasks-worker-check.ts's (itself PR-3's harness: #218 + PR-1 + PR-2 + the LIVE
// fixtures), plus production's platform_settings.challenge_tasks value as read on 2026-09-30.
//
//   L0 the embedded seed IS the admin importer's output (scripts/gen-daily-tasks-seed.mjs = parsePlan + buildImportRows
//      of src/lib/dailyTasksPlan.ts over the fixture plan), byte for byte, one item per weekday 2026-10-05 .. 11-06;
//   L1- the world's 16 engine functions the go-live touches are md5-identical to production's (live code, not a copy);
//   L1 applied on Thursday 2026-10-01: 25 drafts equal to their items column by column, the switch is a pure 3-key
//      merge, the parsed config is active / valid with no miniapp_link, every self-test asserted, two audit rows, and a
//      student's Mini App list is enabled + miniapp but shows NO draft;
//   L2 the same items through the REAL importer RPC (admin_challenge_tasks_import as an admin) give identical rows, and
//      the migration over that calendar skips all 25 (plan_ref_exists) and still goes live;
//   L3 replay: after a kill-switch and a cancelled plan day, a second run changes nothing;
//   L4 every refusal is atomic (no row, no switch, no audit): a foreign draft on a plan date, an approved plan day, a
//      post over 4000 characters, an inconsistent requires, other live point defaults, a stopped cron, a paused
//      challenge, a miniapp_link without onboarding -- then the same world goes live cleanly;
//   L5 with an approved retro day (10-01) the state assertions are skipped with that reason, not failed;
//   L6 THE SAFETY PROPERTY: the real tick from Thursday 09:00 to Monday 20:00 (incl. 18:00 alerts, 19:00 DMs, the 09:15
//      fallback window) and the watchdog at :47 do nothing while the plan is only drafts -- no post, no DM, no alert,
//      no alarm, no outbound call;
//   L7 then approve week 1 as an admin: Monday 09:00 queues one post per daily topic and kicks the worker once; Friday
//      18:00 (Saturday is a rest day) alerts nothing; Sunday 18:00 alerts ONCE that Monday's W2D1 is still a draft.
//
// CI NOTE: named *-check.ts (never *_test.ts) so CI's `deno test supabase/functions/` never collects it. Run it by path.
// TEST INFRASTRUCTURE ONLY: this directory has no index.ts, so it is never deployed.
import { BEGIN_MARK, END_MARK, seedBlock, seedItems } from "../../../../scripts/gen-daily-tasks-seed.mjs";

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
    ? "daily_tasks_go_live: 20260930203000 (seed 25 drafts + switch on) against the REAL engine, tick and watchdog on PGlite"
    : "daily_tasks_go_live: SKIPPED -- needs `deno test -A --node-modules-dir=none` (PGlite reads its own files)",
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
  // ═══════════════════════════════ PR-8: the go-live migration ═══════════════════════════════
  const MIG6 = lf(await Deno.readTextFile(here("../../../migrations/20260930151010_challenge_task_ai_check.sql")));
  const MIG5 = lf(await Deno.readTextFile(here("../../../migrations/20260930152010_challenge_daily_tasks_worker.sql")));
  const GL_PATH = Deno.env.get("GO_LIVE_MIG_PATH");
  const GL = lf(await Deno.readTextFile(GL_PATH ?? here("../../../migrations/20260930203000_challenge_daily_tasks_go_live.sql")));
  const PLAN = await Deno.readTextFile(here("../../../../src/lib/__fixtures__/challenge6-daily-tasks-plan.json"));

  const utc = (local: string) => new Date(Date.parse(local + "+05:00")).toISOString();
  const REFS = Array.from({ length: 25 }, (_, i) => `W${Math.floor(i / 5) + 1}D${(i % 5) + 1}`);
  const canon = (v: unknown): string => JSON.stringify(v, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x);

  // production's migration order: PR-3 (150020) -> PR-6 (151010) -> PR-5 (152010), then the live config row
  async function world(at = "2026-09-30T22:00:00"): Promise<PG> {
    setClock(utc(at));
    const db = await freshDb();
    await db.exec(BOT_EXTRA);
    await db.exec(WORKER_EXTRA);
    for (const [name, sql] of [["PR-3", MIG], ["PR-6", MIG6], ["PR-5", MIG5]] as const) {
      const e = await tx(db, sql);
      if (e) throw new Error(`${name} did not apply: ${e}`);
    }
    await db.exec(WORKER_DATA);
    await db.query("update platform_settings set value = $1::jsonb where key = 'challenge_tasks'", [JSON.stringify(LIVE_CHALLENGE_TASKS)]);
    return db;
  }
  const COLS = `task_date::text as task_date, type, title, body, learn_line, submit_hint, accepts, requires, min_text_chars,
                min_duration_sec, minutes, points, check_rubric, requires_tag, status, source, plan_ref, plan_format`;
  const calendar = async (db: PG) => await q(db, `select ${COLS} from challenge_tasks where course_id = $1 and status <> 'cancelled' order by task_date`, [C6]);
  const ctRow = async (db: PG) => (await one(db, "select value v from platform_settings where key = 'challenge_tasks'")).v as Row;
  const parsed = async (db: PG) => (await one(db, "select challenge_tasks_config() c")).c as Row;
  const audit = async (db: PG, action: string) => await q(db, "select details d from admin_actions where action = $1 order by created_at", [action]);
  const tick = async (db: PG) => (await one(db, "select challenge_tasks_tick() r")).r as Row;

  // ── the seed block, as embedded, and a way to embed another one (the refusal tests) ──
  const a0 = GL.indexOf(BEGIN_MARK), b0 = GL.indexOf(END_MARK);
  const embedded = a0 >= 0 && b0 > a0 ? /\$seed\$([\s\S]*?)\$seed\$/.exec(GL.slice(a0, b0))?.[1] ?? "" : "";
  const withItems = (its: unknown[]) => GL.slice(0, a0) + GL.slice(a0, b0).replace(embedded, () => seedBlock(its)) + GL.slice(b0);
  const ITEMS = seedItems(PLAN) as Row[];

  // ───────────── L0. the seed is the importer's output ─────────────
  console.log("L0. the embedded seed == scripts/gen-daily-tasks-seed.mjs (parsePlan + buildImportRows) over the fixture plan");
  {
    ok("L0a the generator yields 25 items W1D1..W5D5", ITEMS.length === 25 && ITEMS.every((it, i) => it.plan_ref === REFS[i]));
    ok("L0b the migration embeds exactly the generator's block (byte for byte)", embedded.trim() === seedBlock(ITEMS).trim(),
      { embeddedLength: embedded.length });
    const want: string[] = [];
    for (let w = 0; w < 5; w++) for (let d = 0; d < 5; d++) {
      want.push(new Date(Date.parse("2026-10-05T00:00:00Z") + (7 * w + d) * 86400_000).toISOString().slice(0, 10));
    }
    ok("L0c week N day D = the D-th weekday of week N, Mon 2026-10-05 .. Fri 2026-11-06",
      ITEMS.map((it) => it.task_date).join() === want.join() && want[24] === "2026-11-06", ITEMS.map((it) => it.task_date));
    ok("L0d every item is a draft-able import: points null (= the 5 / 8 defaults), instagram tagged, the voice task 20 s",
      ITEMS.every((it) => it.points === null) && ITEMS.filter((it) => it.type === "instagram").every((it) => it.requires_tag === true) &&
      ITEMS.find((it) => it.plan_ref === "W5D4")?.min_duration_sec === 20);
  }

  // ───────────── L1. go live on Thursday morning ─────────────
  console.log("L1. applied Thursday 2026-10-01 08:30 (Tashkent) on production's state");
  const db = await world();
  const before = await ctRow(db);
  {
    // every engine function the go-live reads or relies on is byte-identical to production's
    // (md5(replace(prosrc, E'\r', '')) read live 2026-09-30), so this world runs the LIVE code, not a repo copy
    const LIVE_MD5: Record<string, string> = {
      "challenge_tasks_config()": "d40ab1725851c424bcde075fef3c574e",
      "challenge_task_is_task_day(uuid,date,jsonb)": "baa7e4373d3143150dc06ad9de17c389",
      "challenge_task_requires_problem(text,jsonb,text[])": "9b2b8c71874289e9d02f1715bc9961aa",
      "challenge_task_render_post(challenge_tasks)": "16bb9f9548f82c265e86a20426787928",
      "challenge_task_render_post_text(text,text,text,text,text,integer,integer,integer,integer,date,text)": "3bf9889b5f6ca7b4af6ebe6d15e154b6",
      "challenge_task_post_context(challenge_tasks)": "9c48ea233273a70062cc85f446fb2a75",
      "challenge_task_post_length(text)": "da53a0f4da225be7f458a5f4ec54ab99",
      "challenge_tasks_guard()": "0b8992debc043c18f888ac777552cdfe",
      "challenge_tasks_lock()": "45a40d721e977eacbcd04dadb1247cee",
      "admin_challenge_tasks_import(uuid,jsonb)": "a77e52eff3d11f97e4cefe9692d3aa1d",
      "challenge_tasks_health(timestamp with time zone)": "f5ab18b25695675f0792b6447d63a454",
      "challenge_tasks_watchdog(timestamp with time zone)": "ab091a8a4dfba493296490c558d6d198",
      "challenge_tasks_worker_due(jsonb)": "469daa411cf47fb30957996d3fc90d94",
      "challenge_tasks_tick()": "7e39fa98f564daa287960c045fac7fdb",
      "challenge_task_check_due()": "8aab4aaebdd34d2697fad3e6256e6c64",
      "challenge_task_check_kick()": "a7b7500ad8db093a52d355b6d2849798",
    };
    const got = await q(db, `select p.oid::regprocedure::text sig, md5(replace(p.prosrc, E'\\r', '')) m from pg_proc p
                             join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'`);
    const bad = Object.entries(LIVE_MD5).filter(([sig, m]) => got.find((g) => g.sig === sig)?.m !== m)
      .map(([sig]) => ({ sig, world: got.find((g) => g.sig === sig)?.m ?? null }));
    ok(`L1- the world's ${Object.keys(LIVE_MD5).length} engine functions ARE production's (md5)`, bad.length === 0, bad);
  }
  setClock(utc("2026-10-01T08:30:00"));
  {
    const e = await tx(db, GL);
    ok("L1a 20260930203000 applies", e === null, e);
    const cal = await calendar(db);
    const same = cal.length === 25 && cal.every((r, i) => {
      const it = ITEMS[i];
      return r.task_date === it.task_date && r.type === it.type && r.title === it.title && r.body === it.body &&
        r.learn_line === it.learn_line && r.submit_hint === it.submit_hint && canon(r.accepts) === canon(it.accepts) &&
        canon(r.requires) === canon(it.requires) && r.min_text_chars === null && r.min_duration_sec === it.min_duration_sec &&
        r.minutes === it.minutes && r.points === it.points && r.check_rubric === it.check_rubric && r.requires_tag === it.requires_tag &&
        r.status === "draft" && r.source === "import" && r.plan_ref === it.plan_ref && r.plan_format === it.plan_format;
    });
    ok("L1b 25 DRAFTS (source import), each column equal to its seed item, one per plan date", same, cal.slice(0, 2));
    ok("L1c nobody approved anything: 0 approved, no approval stamp, created_by NULL",
      await count(db, "select count(*) n from challenge_tasks where status = 'approved' or approved_at is not null or created_by is not null") === 0);
    const after = await ctRow(db);
    const { enabled: _e, ai: _a, miniapp: _m, ...restAfter } = after;
    const { enabled: _e0, ai: _a0, miniapp: _m0, ...restBefore } = before;
    ok("L1d the switch: enabled / ai / miniapp true, every other key byte-identical (budget 3, miniapp_link null, onboarding false)",
      after.enabled === true && after.ai === true && after.miniapp === true && canon(restAfter) === canon(restBefore) &&
      after.ai_daily_budget_usd === 3 && after.miniapp_link === null && after.miniapp_onboarding === false, after);
    const c = await parsed(db);
    ok("L1e challenge_tasks_config(): active, ai, miniapp; miniapp_link NULL; invalid []",
      c.active === true && c.ai === true && c.miniapp === true && c.miniapp_link === null && Array.isArray(c.invalid) && c.invalid.length === 0, c);
    const gl = await audit(db, "challenge_tasks_went_live");
    const imp = await audit(db, "challenge_tasks_imported");
    const st = gl[0]?.d?.self_test ?? {};
    ok("L1f audit: ONE 'challenge_tasks_went_live' (every self-test asserted, 5 task-day dates) + ONE importer-shaped 'challenge_tasks_imported'",
      gl.length === 1 && imp.length === 1 && imp[0].d.created === 25 && imp[0].d.items === 25 && imp[0].d.created_ids.length === 25 &&
      st.config === "asserted" && st.today_work === "asserted" && st.worker_due === "asserted" && st.check_due === "asserted" &&
      st.health_calendar === "asserted" && st.is_task_day_false?.asserted_dates === 5 && gl[0].d.seed.created === 25,
      gl[0]?.d);
    console.log(`     longest post: ${gl[0]?.d?.seed?.max_post_length} (draft) / ${gl[0]?.d?.seed?.max_post_length_final_day_no} (final day number); latent: ${JSON.stringify(gl[0]?.d?.latent)}`);
    ok("L1g every post is far under 4000 (the draft render AND the final day number)",
      gl[0]?.d?.seed?.max_post_length > 0 && gl[0]?.d?.seed?.max_post_length <= 4000 && gl[0]?.d?.seed?.max_post_length_final_day_no <= 4000);
    const td = await q(db, `select d::date::text d, challenge_task_is_task_day($1, d::date, challenge_tasks_config()) t
                            from generate_series('2026-10-01'::date, '2026-10-09'::date, interval '1 day') d order by d`, [C6]);
    ok("L1h no date is a task day while the plan is only drafts (10-01 .. 10-09, the 10-05 draft included)", td.every((r) => r.t === false), td);
    const mine = await as<Row[]>(db, ST(1), "select my_challenge_tasks() r");
    const r = mine.rows?.[0]?.r as Row | undefined;
    ok("L1i a student's Mini App list (PR-7 reads it): enabled + miniapp, and NO draft in it", r?.ok === true && r?.enabled === true &&
      r?.miniapp === true && Array.isArray(r?.tasks) && r.tasks.length === 0, mine);
    ok("L1j the AI kick's decision: idle (ai on, nothing to check)", ((await one(db, "select challenge_task_check_due() d")).d as Row).state === "idle");
  }

  // ───────────── L2. the REAL importer gives the same rows; the migration skips what it finds ─────────────
  console.log("L2. admin_challenge_tasks_import (as an admin) with the same items == the migration's rows");
  {
    const db2 = await world();
    const r = await as<Row[]>(db2, AD, "select admin_challenge_tasks_import($1::uuid, $2::jsonb) r", [C6, JSON.stringify(ITEMS)]);
    ok("L2a the importer RPC creates 25 drafts", (r.rows?.[0]?.r as Row)?.created === 25, r);
    ok("L2b ... column for column identical to the migration's", canon(await calendar(db2)) === canon(await calendar(db)));
    setClock(utc("2026-10-01T08:30:00"));
    const e = await tx(db2, GL);
    const gl = await audit(db2, "challenge_tasks_went_live");
    ok("L2c the migration over that calendar: 25 skipped (plan_ref_exists), nothing created, still live; no second import row",
      e === null && gl.length === 1 && gl[0].d.seed.created === 0 && gl[0].d.seed.skipped.length === 25 &&
      gl[0].d.seed.skipped.every((s: Row) => s.reason === "plan_ref_exists") && (await parsed(db2)).active === true &&
      (await audit(db2, "challenge_tasks_imported")).length === 1 && await count(db2, "select count(*) n from challenge_tasks") === 25, e ?? gl[0]?.d?.seed);
    await db2.close();
  }

  // ───────────── L3. replay changes nothing ─────────────
  console.log("L3. replay after a kill-switch and a cancelled plan day");
  {
    const db3 = await world();
    setClock(utc("2026-10-01T08:30:00"));
    const e1 = await tx(db3, GL);
    await db3.query(`update platform_settings set value = jsonb_set(value, '{enabled}', 'false') where key = 'challenge_tasks'`);
    await db3.query("update challenge_tasks set status = 'cancelled' where plan_ref = 'W3D2'");
    setClock(utc("2026-10-02T10:00:00"));
    const e2 = await tx(db3, GL);
    ok("L3a both runs apply", e1 === null && e2 === null, { e1, e2 });
    ok("L3b the kill-switch stays off (no re-switch)", (await ctRow(db3)).enabled === false);
    ok("L3c no re-seed: W3D2 stays cancelled, no new draft on 2026-10-20, 24 live + 1 cancelled",
      await count(db3, "select count(*) n from challenge_tasks where task_date = '2026-10-20' and status <> 'cancelled'") === 0 &&
      await count(db3, "select count(*) n from challenge_tasks") === 25);
    ok("L3d one audit row each", (await audit(db3, "challenge_tasks_went_live")).length === 1 && (await audit(db3, "challenge_tasks_imported")).length === 1);
    await db3.close();
  }

  // ───────────── L4. every refusal is atomic ─────────────
  console.log("L4. refusals: nothing inserted, nothing switched, nothing audited");
  {
    const dbA = await world();
    setClock(utc("2026-10-01T08:30:00"));
    const untouched = async () => await count(dbA, "select count(*) n from challenge_tasks where source = 'import'") === 0 &&
      (await ctRow(dbA)).enabled === false && (await audit(dbA, "challenge_tasks_went_live")).length === 0;
    const refuse = async (label: string, re: RegExp, setup: () => Promise<unknown>, undo: () => Promise<unknown>, sql = GL) => {
      await setup();
      const e = await tx(dbA, sql);
      const clean = await untouched();
      await undo();
      ok(label, e !== null && re.test(e) && clean, e);
    };
    const T = "insert into challenge_tasks (course_id, task_date, type, title, body, accepts, requires, status, source, plan_ref) " +
              "values ($1, $2, 'general', 'Qo‘lda', 'Matn', '{text,photo,document}', '[{\"any\":[\"photo\",\"image_doc\"],\"min\":1,\"label\":\"screenshot\"}]', $3, 'manual', $4)";
    await refuse("L4a a different task already on a plan date (10-07 'X') -> ABORT, the calendar is not the plan", /should hold one draft W1D3/,
      () => dbA.query(T, [C6, "2026-10-07", "draft", "X"]), () => dbA.query("delete from challenge_tasks where plan_ref = 'X'"));
    await refuse("L4b an APPROVED W1D1 already on 10-05 -> ABORT (0 approved on the plan dates)", /should hold one draft W1D1 .* status approved/,
      () => dbA.query(T, [C6, "2026-10-05", "approved", "W1D1"]), () => dbA.query("delete from challenge_tasks where plan_ref = 'W1D1'"));
    const long = ITEMS.map((it) => ({ ...it }));
    long[0] = { ...long[0], body: "Uzun vazifa matni. ".repeat(157), learn_line: "L".repeat(495), submit_hint: "S".repeat(495) };
    await refuse("L4c a post over 4000 characters -> ABORT before any insert (the other 24 are not inserted either)", /seed W1D1 .* renders \d+ \/ \d+ characters/,
      () => Promise.resolve(), () => Promise.resolve(), withItems(long));
    const badIg = ITEMS.map((it) => ({ ...it }));
    badIg[4] = { ...badIg[4], requires: [{ any: ["photo", "image_doc"], min: 1, label: "screenshot" }] };
    await refuse("L4d an instagram task without its ig_link group -> ABORT (requires_problem)", /seed W1D5 .*Instagram vazifasi skrinshot/,
      () => Promise.resolve(), () => Promise.resolve(), withItems(badIg));
    await refuse("L4e live point defaults other than 5 / 8 -> ABORT (regenerate the seed)", /regenerate/,
      () => cfgSet(dbA, "points", { general: 6, instagram: 8 }), () => cfgSet(dbA, "points", { general: 5, instagram: 8 }));
    await refuse("L4f the tick's cron job inactive -> ABORT", /cron job/,
      () => dbA.query("update cron.job set active = false where jobname = 'challenge-tasks-tick'"),
      () => dbA.query("update cron.job set active = true where jobname = 'challenge-tasks-tick'"));
    await refuse("L4g the challenge itself paused -> ABORT (the switch would stay inert)", /not_active/,
      () => dbA.query(`update platform_settings set value = jsonb_set(value, '{enabled}', 'false') where key = 'challenge'`),
      () => dbA.query(`update platform_settings set value = jsonb_set(value, '{enabled}', 'true') where key = 'challenge'`));
    await refuse("L4h a startapp miniapp_link without onboarding -> ABORT (the watchdog would call it config_invalid)", /config_invalid.*miniapp_link/,
      () => cfgSet(dbA, "miniapp_link", "https://t.me/aicreatorsdarsliklari_bot/app?startapp=dt"), () => cfgSet(dbA, "miniapp_link", null));
    const e = await tx(dbA, GL);
    ok("L4i after all of that, the same world goes live cleanly", e === null && await count(dbA, "select count(*) n from challenge_tasks where status = 'draft'") === 25 &&
      (await parsed(dbA)).active === true, e);
    await dbA.close();
  }

  // ───────────── L5. an approved retro day: assertions skipped with a reason, not failed ─────────────
  console.log("L5. an approved retro day (2026-10-01) before go-live");
  {
    const dbR = await world();
    setClock(utc("2026-10-01T20:00:00"));
    await dbR.query(`insert into challenge_tasks (course_id, task_date, type, title, body, accepts, requires, status, source)
                     values ($1, '2026-10-01', 'general', 'Retro kun', 'Qo‘lda e’lon qilingan vazifa', '{text,photo,document}',
                             '[{"any":["photo","image_doc"],"min":1,"label":"screenshot"}]', 'approved', 'retro')`, [C6]);
    setClock(utc("2026-10-02T10:00:00"));
    const e = await tx(dbR, GL);
    const st = (await audit(dbR, "challenge_tasks_went_live"))[0]?.d?.self_test ?? {};
    ok("L5a applies; today's work / due / health-calendar recorded as skipped (an approved task exists), 0 task-day dates asserted",
      e === null && /skipped/.test(st.today_work) && /skipped/.test(st.worker_due) && /skipped/.test(st.health_calendar) &&
      st.is_task_day_false?.asserted_dates === 0, e ?? st);
    ok("L5b ...because Monday 10-05 IS a task day now (a weekday after the first approved date): the 18:00 nudge covers it",
      (await one(dbR, "select challenge_task_is_task_day($1, '2026-10-05', challenge_tasks_config()) t", [C6])).t === true);
    const obs = (await audit(dbR, "challenge_tasks_went_live"))[0]?.d?.observed?.tick_work_today ?? {};
    ok("L5c ...and so is Friday 10-02: a retro day approved for 10-01 ONLY makes 10-02 a task day with no task (the audit shows " +
       "no_task_today 1) -- enter EVERY hand-posted day, or none", obs.no_task_today === 1 && obs.posts_to_queue === 0, obs);
    await dbR.close();
  }

  // ───────────── L6. THE SAFETY PROPERTY: drafts only -> the live engine does nothing ─────────────
  console.log("L6. Thursday 09:00 .. Monday 20:00 with only drafts: no post, no DM, no alert, no alarm, no outbound call");
  await db.query("update profiles set telegram_write_access_at = now() where id = any($1::uuid[])", [`{${[ST(1), ST(2), ST(4)].join(",")}}`]);
  const calls0 = await count(db, "select count(*) n from ops_net_calls");
  {
    const moments = [
      "2026-10-01T09:00:30", "2026-10-01T09:16:30", "2026-10-01T18:00:30", "2026-10-01T19:00:30", "2026-10-01T20:00:30",
      "2026-10-02T09:00:30", "2026-10-02T18:00:30", "2026-10-02T19:00:30",
      "2026-10-04T18:00:30", "2026-10-04T19:00:30",
      "2026-10-05T09:00:30", "2026-10-05T09:16:30", "2026-10-05T18:00:30", "2026-10-05T19:00:30", "2026-10-05T20:00:30",
    ];
    const errs: unknown[] = [];
    const states: string[] = [];
    for (const m of moments) {
      setClock(utc(m));
      const r = await tick(db);
      states.push(String(r.state));
      if (r.errors && Object.keys(r.errors).length) errs.push({ m, errors: r.errors });
      // the tick always reports evening_queued (0 included): only a non-zero / true entry is work
      if (r.out && Object.values(r.out).some((v) => v !== 0 && v !== false)) errs.push({ m, out: r.out });
    }
    ok("L6a every tick ran ACTIVE with nothing to do (no non-zero output, no section error)", states.every((s) => s === "active") && errs.length === 0, { states, errs });
    ok("L6b no task / summary post queued, no DM in the outbox",
      await count(db, "select count(*) n from challenge_task_posts") === 0 && await count(db, "select count(*) n from challenge_task_outbox") === 0);
    ok("L6c no 'no_task_today' row, no 18:00 missing-TOMORROW row (drafts are not task days)",
      await count(db, "select count(*) n from admin_actions where action in ('challenge_task_no_task_today', 'challenge_task_no_task_tomorrow')") === 0);
    ok("L6d no outbound call at all: no admin DM, no fallback post, no worker kick", await count(db, "select count(*) n from ops_net_calls") === calls0,
      await q(db, "select purpose, url from ops_net_calls order by id"));
    setClock(utc("2026-10-05T09:44:00"));
    await reconcile(db);
    setClock(utc("2026-10-05T09:46:30"));
    await tick(db);
    await one(db, "select challenge_task_check_kick() r");
    setClock(utc("2026-10-05T09:47:00"));
    const wd = (await one(db, "select challenge_tasks_watchdog() w")).w as Row;
    ok("L6e the watchdog at Monday 09:47: active, NO alarm (no no_task_today / tomorrow / post_missing / config_invalid / checks_stuck), no DM",
      Array.isArray(wd.alarms) && wd.alarms.length === 0 &&
      await count(db, "select count(*) n from ops_net_calls where purpose = 'challenge-tasks-watchdog'") === 0, wd);
    ok("L6f the AI kick stayed idle (ai on, nothing to check): no call to challenge-task-check",
      await count(db, "select count(*) n from ops_net_calls where purpose ilike '%check%'") === 0);
  }

  // ───────────── L7. approve week 1 -> the engine takes over ─────────────
  console.log("L7. an admin approves week 1 on Sunday; Monday posts; the weekly Sunday-18:00 nudge for week 2");
  {
    setClock(utc("2026-10-04T17:00:00"));
    const ap = await as(db, AD, "update challenge_tasks set status = 'approved' where plan_ref = any($1::text[]) returning id",
      [`{${REFS.slice(0, 5).join(",")}}`]);
    ok("L7a an admin approves W1D1..W1D5 through RLS + the approve guard (render, requires, window, scope)",
      ap.err === null && (ap.rows as Row[]).length === 5, ap.err);
    ok("L7b Monday 10-05 is now a task day; Thursday 10-01 / Friday 10-02 are still not (before the first approved date)",
      (await one(db, "select challenge_task_is_task_day($1, '2026-10-05', challenge_tasks_config()) t", [C6])).t === true &&
      (await one(db, "select challenge_task_is_task_day($1, '2026-10-02', challenge_tasks_config()) t", [C6])).t === false);
    setClock(utc("2026-10-04T18:00:30"));
    const sun = await tick(db);
    ok("L7c Sunday 18:00: Monday is approved -> no missing-task alert", !sun.out?.no_task_tomorrow &&
      await count(db, "select count(*) n from admin_actions where action = 'challenge_task_no_task_tomorrow'") === 0, sun.out);
    const topics = await count(db, "select count(*) n from challenge_task_topics() where course_id = $1", [C6]);
    const k0 = await count(db, "select count(*) n from ops_net_calls where purpose = 'challenge-tasks-worker'");
    setClock(utc("2026-10-05T09:00:30"));
    const mon = await tick(db);
    ok(`L7d Monday 09:00: one task post per 6.0 daily topic (${topics}), morning DMs queued, the worker kicked once`,
      topics > 0 && mon.out?.posts_queued === topics && await count(db, "select count(*) n from challenge_task_posts where kind = 'task' and state = 'queued'") === topics &&
      mon.out?.morning_queued >= 1 && mon.kicked === true &&
      await count(db, "select count(*) n from ops_net_calls where purpose = 'challenge-tasks-worker'") === k0 + 1, mon);
    setClock(utc("2026-10-09T18:00:30"));
    const fri = await tick(db);
    ok("L7e Friday 18:00: Saturday is a rest day -> no alert", !fri.out?.no_task_tomorrow, fri.out);
    const dm0 = await count(db, "select count(*) n from ops_net_calls where purpose = 'challenge-tasks-tomorrow-check'");
    setClock(utc("2026-10-11T18:00:30"));
    const sun2 = await tick(db);
    const alert = await audit(db, "challenge_task_no_task_tomorrow");
    ok("L7f Sunday 10-11 18:00: Monday's W2D1 is still a draft -> ONE alert row {drafts: 1} + the admin DM",
      sun2.out?.no_task_tomorrow === true && alert.length === 1 && alert[0].d.date === "2026-10-12" && alert[0].d.drafts === 1 &&
      await count(db, "select count(*) n from ops_net_calls where purpose = 'challenge-tasks-tomorrow-check'") === dm0 + 1, { out: sun2.out, alert });
  }
  await db.close();

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) throw new Error(`daily_tasks_go_live: ${fail} check(s) failed`);
}
