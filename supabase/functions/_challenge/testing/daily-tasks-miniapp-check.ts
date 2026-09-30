// PGlite harness for the MINI APP side of the daily tasks (Daily Tasks PR-7): submit-daily-task's core (handlePrepare /
// handleSubmit — the gate, the request claim, the repost plan, the capture view, the record + capture) driven against
// the REAL PR-3 SQL engine on a real PostgreSQL, with a RECORDING poster in place of the Bot API (no network).
//
//   deno test -A --node-modules-dir=none --no-lock supabase/functions/_challenge/testing/daily-tasks-miniapp-check.ts
//
// The world is a VERBATIM copy of daily-tasks-bot-check.ts's (itself PR-3's engine harness: #218 + PR-1 + PR-2 + the
// LIVE fixtures, pinned clock), then 20260930150020 applies. The adapter is the bot harness's PostgREST-shaped one
// (rpc = the SECURITY DEFINER functions called AS service_role, so the engine's grants are exercised), extended to
// pass a jsonb ARRAY and a Date the way PostgREST's JSON does. It proves the CONTRACT between the Mini App function
// and the engine:
//   INERT (enabled=false → 'disabled'; enabled but miniapp=false → 'miniapp_off': nothing claimed, posted or captured);
//   a photo + text → ONE post into the student's OWN topic (chat AND thread), the caption names the student, the
//   submission is accepted at the CLAIM time; our header never counts as the student's text (a photo alone stays
//   needs_more 'text'); a replay of the same request posts nothing and answers 'duplicate'; a capture that fails after
//   the post is healed by the reconciler from the recorded items (I4); a Telegram failure closes the claim as failed
//   and a retry takes it back keeping the FIRST claim time; thread 10 of 5- and 6-GURUH routed by chat; a held
//   sender / a closed task / a kind the task does not accept post nothing; late work pays half; a classmate's text
//   reply to a Mini App repost is a silent 'comment' (the ledger rows make it a classmate_bot_msg); 10 files + a text
//   too long for the caption (11 messages: capture_miniapp takes at most 10) is refused before any claim or post, 9
//   files + that text is captured; a recorded claim the engine refuses as 'bad_messages' is closed as failed (422),
//   never reposted and never left 'posted' for the heal to loop on; every invariant 0.
//
// CI NOTE: named *-check.ts (never *_test.ts) so CI's `deno test supabase/functions/` never collects it. Run it by path.
// TEST INFRASTRUCTURE ONLY: this directory has no index.ts, so it is never deployed.
import { type Deps, handlePrepare, handleSubmit, type InFile, fileKindOf } from "../../submit-daily-task/core.ts";
import type { MediaGroupItem, MultipartFile, SendResultOutcome } from "../../_shared/telegram-send.ts";

// ═══ BEGIN VERBATIM: daily-tasks-bot-check.ts (= daily-tasks-engine-check.ts), the fixture world (keep identical) ═══
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

// What the Mini App function reads beyond PR-3's world: the profile columns its caption header names.
const MINIAPP_EXTRA = `
alter table public.profiles add column if not exists last_name text;
`;

Deno.test({
  name: CAN_RUN
    ? "daily_tasks_miniapp: submit-daily-task against the REAL engine on PGlite (gate, claim, repost, capture view, heal, retry)"
    : "daily_tasks_miniapp: SKIPPED -- needs `deno test -A --node-modules-dir=none` (PGlite reads its own files)",
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
  // ═══════════════════════════════ the MINI APP function against the engine ═══════════════════════════════
  // ── a PostgREST-shaped adapter over PGlite. rpc(): the function called AS service_role (so the engine's grants are
  //    exercised exactly as the function's service-role client meets them); from(): its claim reads / compare-and-set and
  //    the bot's admin_actions writes (as the owner — production's service_role bypasses RLS the same way). One lane: the
  //    role switch can never interleave between two concurrent calls. ──
  function pgAdmin(db: PG) {
    let lane: Promise<unknown> = Promise.resolve();
    const serial = <T>(fn: () => Promise<T>): Promise<T> => {
      const p = lane.then(fn, fn);
      lane = p.catch(() => undefined);
      return p;
    };
    const SETOF = new Set(["challenge_task_topics"]);
    // + (Mini App) a Date goes as its ISO text and a jsonb ARRAY of objects as JSON, the way PostgREST's JSON body
    //   carries them (_claimed_at read back from a claim row; _messages, the posted Message views).
    const val = (v: unknown) => (v instanceof Date ? v.toISOString()
      : Array.isArray(v) && v.some((x) => x !== null && typeof x === "object") ? JSON.stringify(v)
      : v !== null && typeof v === "object" && !Array.isArray(v) ? JSON.stringify(v) : v);
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
  await db.exec(MINIAPP_EXTRA);
  {
    const e = await tx(db, MIG);
    if (e !== null) throw new Error(`daily_tasks_miniapp: the engine migration did not apply -- ${e}`);
  }
  const admin = pgAdmin(db);

  // the calendar: Mon photo + text (photos and text ONLY — the guard requires accepts ⊇ requires, so a requires with
  // image_doc would force 'document' into accepts), Tue screenshot (files too)
  const PHOTO = { any: ["photo"], min: 1, label: "screenshot" };
  const SHOT = { any: ["photo", "image_doc"], min: 1, label: "screenshot" };
  const TEXT = { any: ["text"], min: 1, label: "text" };
  const addTask = async (date: string, requires: unknown, accepts: string[]) =>
    Number((await one(db, `insert into challenge_tasks (course_id, task_date, type, title, body, accepts, requires, status, source)
                           values ($1, $2, 'general', $3, 'Vazifa matni', $4::text[], $5::jsonb, 'approved', 'manual') returning id`,
      [C6, date, `Vazifa ${date}`, `{${accepts.join(",")}}`, JSON.stringify(requires)])).id);
  const TMON = await addTask("2026-10-05", [PHOTO, TEXT], ["text", "photo"]);
  await addTask("2026-10-06", [SHOT], ["text", "photo", "document"]);

  // ── the recording poster: what submit-daily-task hands the Bot API, answered with plausible sent Messages ──
  let nextMsg = 70_000, fu = 0;
  type Post = { kind: "text" | "single" | "album"; method?: string; fields: Row; file?: MultipartFile; items?: MediaGroupItem[] };
  const posts: Post[] = [];
  let script: ((p: Post) => { outcome: SendResultOutcome; result: any } | null) | null = null;
  const sentMsg = (f: Row): Row => ({
    message_id: nextMsg++, date: Math.floor(Date.now() / 1000), chat: { id: Number(f.chat_id), type: "supergroup", is_forum: true },
    message_thread_id: Number(f.message_thread_id), is_topic_message: true, from: { id: 999, is_bot: true, first_name: "Bot" },
    reply_to_message: { message_id: Number(f.message_thread_id), forum_topic_created: { name: "KUNLIK VAZIFALAR" } },
  });
  const mediaOf = (type: string, name: string): Row => type === "photo"
    ? { photo: [{ file_id: "s", file_unique_id: `mini_${++fu}_s` }, { file_id: "L", file_unique_id: `mini_${fu}` }] }
    : type === "video" ? { video: { file_id: "v", file_unique_id: `mini_${++fu}`, duration: 12, thumbnail: {} } }
    : { document: { file_id: "d", file_unique_id: `mini_${++fu}`, mime_type: name.endsWith(".png") ? "image/png" : "application/pdf", file_name: name } };
  const answer = (p: Post, make: () => any) => {
    posts.push(p);
    return Promise.resolve(script?.(p) ?? { outcome: okOut(), result: make() });
  };
  const poster = {
    text: (fields: Row) => answer({ kind: "text", fields }, () => ({ ...sentMsg(fields), text: String(fields.text) })),
    single: (method: string, fields: Row, file: MultipartFile) => answer({ kind: "single", method, fields, file }, () => ({
      ...sentMsg(fields), ...mediaOf(method === "sendPhoto" ? "photo" : method === "sendVideo" ? "video" : "document", file.filename),
      ...(fields.caption ? { caption: String(fields.caption) } : {}) })),
    album: (fields: Row, items: MediaGroupItem[]) => answer({ kind: "album", fields, items }, () => {
      const g = `mg${nextMsg}`;
      return items.map((it) => ({ ...sentMsg(fields), media_group_id: g, ...mediaOf(it.type, it.filename), ...(it.caption ? { caption: it.caption } : {}) }));
    }),
  };
  const signals: string[] = [];
  const note = async (action: string, details: Row, uid: string) => {
    signals.push(action);
    await db.query("insert into admin_actions (action, target_user_id, details) values ($1, $2, $3::jsonb)", [action, uid, JSON.stringify(details)]);
  };
  const deps = (over: Partial<Deps> = {}): Deps => ({
    admin, poster: poster as any, health: note, healthOnce: (a, _k, d, u) => note(a, d, u),
    sleep: () => Promise.resolve(), now: () => Date.now(), ...over,
  });
  const file = (mime: string, name: string): InFile => ({ kind: fileKindOf(mime, 1000), blob: new Blob(["x"]), name, size: 1000, mime });
  const photo = () => file("image/jpeg", "shot.jpg");
  const input = (taskId: number, requestId: string, text: string, files: InFile[]) => ({ taskId, requestId, text, files });
  const P = (name: string) => ({ name, last_name: null, telegram_username: null });
  const claimOf = async (user: string, req: string) =>
    await one(db, "select * from challenge_task_submit_claims where user_id = $1 and request_id = $2", [user, req]);
  const msgRows = async (user: string) =>
    await q(db, "select * from challenge_task_messages where user_id = $1 order by message_id", [user]);

  // ───────────── MI. inert ─────────────
  console.log("MI. inert: challenge_tasks.enabled=false, then miniapp=false");
  setClock("2026-10-05T05:00:00Z"); // Monday 10:00 Tashkent
  {
    const r0 = await handlePrepare(deps(), ST(1), TMON);
    ok("MI1 prepare: 'disabled' (PR-1's seed), no task text", r0.status === 200 && r0.body.ok === false && r0.body.reason === "disabled" && r0.body.text === null, r0.body);
    const s0 = await handleSubmit(deps(), ST(1), input(TMON, "req_mi_000001", T25, [photo()]), P("Ali"));
    ok("MI2 submit: 409 not_allowed — nothing posted, nothing claimed, nothing captured",
      s0.status === 409 && s0.body.reason === "disabled" && posts.length === 0 &&
      await count(db, "select count(*) n from challenge_task_submit_claims") === 0 &&
      await count(db, "select count(*) n from challenge_task_messages") === 0, s0);
    await cfgSet(db, "enabled", true);
    const r1 = await handlePrepare(deps(), ST(1), TMON);
    ok("MI3 enabled but miniapp=false: 'miniapp_off' (the Mini App stays hidden)", r1.body.reason === "miniapp_off", r1.body);
    await cfgSet(db, "miniapp", true);
    const r2 = await handlePrepare(deps(), ST(1), TMON);
    ok("MI4 on: ok, the task's accepts/requires, the student's OWN topic url and the post text",
      r2.body.ok === true && (r2.body.task as Row)?.id === TMON && r2.body.topic_url === "https://t.me/c/4440955972/144" &&
      String(r2.body.text).includes("<b>Vazifa 2026-10-05</b>"), r2.body);
  }

  // ───────────── MA. a submission ─────────────
  console.log("MA. photo + text → one post into the student's own topic → accepted at the claim time");
  {
    const i = posts.length;
    const ra = await handleSubmit(deps(), ST(1), input(TMON, "req_ma_000001", T25, [photo()]), { name: "Ali", last_name: "Valiyev", telegram_username: "ali_v" });
    const out = posts.slice(i);
    const sa = await liveOf(db, ST(1), TMON);
    const cl = await claimOf(ST(1), "req_ma_000001");
    ok("MA1 one sendPhoto into 1-GURUH's daily topic (chat AND thread), a plain caption naming the student, then the text",
      out.length === 1 && out[0].method === "sendPhoto" && out[0].fields.chat_id === CH1 && out[0].fields.message_thread_id === D1 &&
      !("parse_mode" in out[0].fields) &&
      out[0].fields.caption === `📱 Ali Valiyev (@ali_v) — ilova orqali\n📅 5-oktabr · Vazifa 2026-10-05\n\n${T25}`, out[0]?.fields);
    ok("MA2 200 'created' → accepted +5 (ai=false: the screenshot is met by media), source/attributed_via miniapp",
      ra.status === 200 && (ra.body.result as Row)?.outcome === "created" && sa?.status === "accepted" && sa?.source === "miniapp" &&
      sa?.attributed_via === "miniapp" && (await xpOf(db, ST(1), `ch_task:${TMON}`))?.amount === 5, { body: ra.body, sa });
    ok("MA3 submitted_at IS the claim time; the claim is 'captured' with the recorded item",
      +new Date(sa?.submitted_at) === +new Date(cl?.claimed_at) && cl?.state === "captured" && Array.isArray(cl?.items) && cl.items.length === 1, cl);
    const rows = await msgRows(ST(1));
    ok("MA4 the ledger row: source + resolved_via miniapp; what the engine judged is the STUDENT's text (our header removed)",
      rows.length === 1 && rows[0].source === "miniapp" && rows[0].resolved_via === "miniapp" && rows[0].item?.text === T25 &&
      Number(rows[0].chat_id) === CH1 && Number(rows[0].thread_id) === D1, rows[0]?.item);
  }

  // ───────────── MB. our header is never the student's text ─────────────
  console.log("MB. a photo alone stays needs_more 'text'; the text sent next completes the same submission");
  {
    const rb = await handleSubmit(deps(), ST(2), input(TMON, "req_mb_000001", "", [photo()]), P("Bek"));
    const sb = await liveOf(db, ST(2), TMON);
    ok("MB1 needs_more, missing ['text'] — the ~45-character caption header did not count",
      rb.status === 200 && sb?.status === "needs_more" && JSON.stringify(sb?.missing) === JSON.stringify(["text"]) &&
      JSON.stringify(((rb.body.result as Row)?.submission as Row)?.missing) === JSON.stringify(["text"]), { sb, body: rb.body });
    const i = posts.length;
    const rb2 = await handleSubmit(deps(), ST(2), input(TMON, "req_mb_000002", T25, []), P("Bek"));
    const sb2 = await liveOf(db, ST(2), TMON);
    ok("MB2 a text-only request → one sendMessage in the topic, 'appended' to THE SAME submission → accepted +5",
      posts.length === i + 1 && posts[i].kind === "text" && posts[i].fields.message_thread_id === D1 &&
      (rb2.body.result as Row)?.outcome === "appended" && sb2?.id === sb?.id && sb2?.status === "accepted" &&
      (await xpOf(db, ST(2), `ch_task:${TMON}`))?.amount === 5, { body: rb2.body, sb2 });
  }

  // ───────────── MC. idempotent replay ─────────────
  console.log("MC. the same request again (a lost response) → nothing reposted, 'duplicate'");
  {
    const n = posts.length;
    const rc = await handleSubmit(deps(), ST(1), input(TMON, "req_ma_000001", T25, [photo()]), P("Ali"));
    ok("MC1 no post, 200 replayed 'duplicate', still one award", posts.length === n && rc.status === 200 && rc.body.replayed === true &&
      (rc.body.result as Row)?.outcome === "duplicate" &&
      await count(db, "select count(*) n from xp_events where user_id = $1 and reason = 'challenge_task'", [ST(1)]) === 1, rc.body);
  }

  // ───────────── MD. the capture fails after the post → the reconciler heals it ─────────────
  console.log("MD. capture RPC fails after the post → 202 pending, claim 'posted' → the reconciler's Mini App heal");
  {
    const failing = {
      rpc: (name: string, args?: Record<string, unknown>) => name === "challenge_task_capture_miniapp"
        ? Promise.resolve({ data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } })
        : admin.rpc(name, args),
      from: admin.from,
    };
    const rd = await handleSubmit(deps({ admin: failing }), ST(3), input(TMON, "req_md_000001", T25, [photo()]), P("Doston"));
    const cl = await claimOf(ST(3), "req_md_000001");
    ok("MD1 202 pending; the claim is 'posted' with its item; the failure is an admin_actions row; nothing captured yet",
      rd.status === 202 && cl?.state === "posted" && cl?.items?.length === 1 && !(await liveOf(db, ST(3), TMON)) &&
      await count(db, "select count(*) n from admin_actions where action = 'challenge_task_miniapp_capture_failed'") === 1, { rd, cl });
    setClock("2026-10-05T05:04:00Z"); // the heal takes claims idle for more than 2 minutes
    const rec = await reconcile(db);
    const sd = await liveOf(db, ST(3), TMON);
    ok("MD2 healed from the recorded items: accepted at the CLAIM time, the claim 'captured'",
      sd?.status === "accepted" && +new Date(sd?.submitted_at) === +new Date(cl?.claimed_at) &&
      (await claimOf(ST(3), "req_md_000001"))?.state === "captured" && Number(rec?.miniapp_healed ?? 1) >= 1, { sd, rec });
  }

  // ───────────── ME. Telegram refuses → failed claim → the retry keeps the first claim time ─────────────
  console.log("ME. every post rate-limited → 502 + failed claim; the retry of the SAME request takes it back");
  {
    script = () => ({ outcome: okOut("rate_limited", { retryAfterSec: 120 }), result: null });
    const re = await handleSubmit(deps(), ST(4), input(TMON, "req_me_000001", T25, [photo()]), P("Eldor"));
    script = null;
    const ce = await claimOf(ST(4), "req_me_000001");
    ok("ME1 502 with retry_after; the claim 'failed' with Telegram's reason; SQL wrote 'challenge_task_miniapp_post_failed'",
      re.status === 502 && re.body.retry_after === 120 && ce?.state === "failed" && ce?.error === "rate_limited" &&
      await count(db, "select count(*) n from admin_actions where action = 'challenge_task_miniapp_post_failed'") === 1 &&
      !(await liveOf(db, ST(4), TMON)), { re, ce });
    // The adapter hands timestamps back as JS Dates (milliseconds); PostgREST hands back the full-precision text.
    // Trim the stored value to milliseconds so the compare-and-set sees the same instant a production read would.
    await db.query("update challenge_task_submit_claims set updated_at = date_trunc('milliseconds', updated_at) where request_id = 'req_me_000001'");
    setClock("2026-10-05T05:10:00Z");
    const re2 = await handleSubmit(deps(), ST(4), input(TMON, "req_me_000001", T25, [photo()]), P("Eldor"));
    const se = await liveOf(db, ST(4), TMON);
    ok("ME2 posted + captured on the retry; submitted_at is the FIRST claim time, not the retry's",
      re2.status === 200 && se?.status === "accepted" && +new Date(se?.submitted_at) === +new Date(ce?.claimed_at) &&
      (await claimOf(ST(4), "req_me_000001"))?.state === "captured", { re2: re2.body, se });
  }

  // ───────────── MF. thread 10 twice: routed by chat ─────────────
  console.log("MF. a 6-GURUH student → 6-GURUH's chat (5-GURUH's topic is thread 10 too)");
  {
    const i = posts.length;
    const rf = await handleSubmit(deps(), Y2, input(TMON, "req_mf_000001", T25, [photo()]), P("Six"));
    const out = posts.slice(i);
    const sf = await liveOf(db, Y2, TMON);
    ok("MF1 posted into CH10 / thread 10 and captured for 6-GURUH", rf.status === 200 && out.length === 1 &&
      out[0].fields.chat_id === CH10 && out[0].fields.message_thread_id === 10 && sf?.group_id === G10 && sf?.status === "accepted", { out, sf });
  }

  // ───────────── MX. capture_miniapp takes at most 10 messages per request ─────────────
  console.log("MX. 10 files + a text too long for a caption = 11 messages: refused before anything is claimed or posted");
  {
    const LONG = "Bugungi vazifa bo'yicha batafsil hisobot. ".repeat(24).trim(); // ~1000 chars: never fits a caption with the header
    const pr = await handlePrepare(deps(), ST(10), TMON, P("Olim"));
    const lim = pr.body.limits as Row;
    ok("MX0 prepare says the exact caption room under THIS student's header (the Mini App caps files by it); the text is past it",
      lim?.caption_text_max === 1024 - "📱 Olim — ilova orqali\n📅 5-oktabr · Vazifa 2026-10-05".length - 2 && lim?.max_messages === 10 &&
      LONG.length > Number(lim?.caption_text_max), lim);
    const n = posts.length;
    const rx = await handleSubmit(deps(), ST(10), input(TMON, "req_mx_000001", LONG, Array.from({ length: 10 }, photo)), P("Olim"));
    ok("MX1 10 photos + a 1000-character text: 400 too_many_files_with_text {max: 9}; nothing posted, claimed or captured",
      rx.status === 400 && rx.body.error === "too_many_files_with_text" && rx.body.max === 9 && posts.length === n &&
      await count(db, "select count(*) n from challenge_task_submit_claims where user_id = $1", [ST(10)]) === 0 &&
      (await msgRows(ST(10))).length === 0, { rx, posted: posts.length - n });
    const n2 = posts.length;
    const rx2 = await handleSubmit(deps(), ST(10), input(TMON, "req_mx_000002", LONG, Array.from({ length: 9 }, photo)), P("Olim"));
    const out = posts.slice(n2);
    const sx = await liveOf(db, ST(10), TMON);
    const cx = await claimOf(ST(10), "req_mx_000002");
    ok("MX2 9 photos + the same text: its own text message, then an album of 9 = 10 messages, captured → accepted +5",
      rx2.status === 200 && out.map((p) => p.kind).join(",") === "text,album" && out[1]?.items?.length === 9 &&
      cx?.state === "captured" && cx?.items?.length === 10 && (await msgRows(ST(10))).length === 10 && sx?.status === "accepted" &&
      (await xpOf(db, ST(10), `ch_task:${TMON}`))?.amount === 5, { body: rx2.body, kinds: out.map((p) => p.kind), cx: cx?.state, sx });
    const n3 = posts.length;
    const rx3 = await handleSubmit(deps(), ST(11), input(TMON, "req_mx_000003", T25, Array.from({ length: 10 }, photo)), P("Qisqa"));
    ok("MX3 10 photos + a text that fits the caption: one album of 10, captured → accepted",
      rx3.status === 200 && posts.length === n3 + 1 && posts[n3].kind === "album" && posts[n3].items?.length === 10 &&
      (await claimOf(ST(11), "req_mx_000003"))?.items?.length === 10 && (await liveOf(db, ST(11), TMON))?.status === "accepted", rx3.body);
  }

  // ───────────── MY. a claim the engine refuses as 'bad_messages' is closed, never healed forever ─────────────
  console.log("MY. a recorded claim of 11 items (the engine refuses it deterministically) → closed as failed, never reposted");
  {
    const views = Array.from({ length: 11 }, (_, k) => ({
      message_id: 90_000 + k, date: Math.floor(Date.now() / 1000), chat: { id: CH1, type: "supergroup" }, message_thread_id: D1,
      is_topic_message: true, photo: [{ file_id: "s", file_unique_id: `my_${k}_s` }, { file_id: "L", file_unique_id: `my_${k}` }] }));
    await db.query("insert into challenge_task_submit_claims (user_id, request_id, task_id, state, items) values ($1, $2, $3, 'posted', $4::jsonb)",
      [ST(12), "req_my_000001", TMON, JSON.stringify(views)]);
    const n = posts.length;
    const ry = await handleSubmit(deps(), ST(12), input(TMON, "req_my_000001", T25, [photo()]), P("Yangi"));
    const cy = await claimOf(ST(12), "req_my_000001");
    ok("MY1 422 capture_rejected (not 202 pending); the claim 'failed' with 'bad_messages'; nothing reposted; DB-visible",
      ry.status === 422 && ry.body.error === "capture_rejected" && ry.body.reason === "bad_messages" && posts.length === n &&
      cy?.state === "failed" && cy?.error === "bad_messages" && Array.isArray(cy?.items) && cy.items.length === 11 &&
      await count(db, "select count(*) n from admin_actions where action = 'challenge_task_miniapp_capture_rejected'") === 1, { ry, cy });
    const ry2 = await handleSubmit(deps(), ST(12), input(TMON, "req_my_000001", T25, [photo()]), P("Yangi"));
    ok("MY2 a retry of the same request: 422 again, never taken back and reposted", ry2.status === 422 &&
      ry2.body.error === "capture_rejected" && posts.length === n && (await claimOf(ST(12), "req_my_000001"))?.state === "failed", ry2);
    setClock("2026-10-05T05:20:00Z");
    await reconcile(db);
    ok("MY3 the reconciler's Mini App heal no longer sees it (only 'posted' claims are healed)",
      (await claimOf(ST(12), "req_my_000001"))?.state === "failed" && !(await liveOf(db, ST(12), TMON)));
  }

  // ───────────── MG. gates: held sender, staff, kinds ─────────────
  console.log("MG. held sender / staff / a kind the task does not take → nothing posted");
  {
    const n = posts.length;
    const rg = await handleSubmit(deps(), S7, input(TMON, "req_mg_000001", T25, [photo()]), P("NoGroup"));
    ok("MG1 no group: 409 held_sender/no_group, nothing posted or claimed", rg.status === 409 && rg.body.reason === "held_sender" &&
      rg.body.detail === "no_group" && posts.length === n &&
      await count(db, "select count(*) n from challenge_task_submit_claims where user_id = $1", [S7]) === 0, rg.body);
    const rs = await handlePrepare(deps(), T1, TMON);
    ok("MG2 staff: 'staff'", rs.body.ok === false && rs.body.reason === "staff", rs.body);
    const rv = await handleSubmit(deps(), ST(5), input(TMON, "req_mg_000002", T25, [file("video/mp4", "clip.mp4")]), P("Vid"));
    const rp = await handleSubmit(deps(), ST(5), input(TMON, "req_mg_000003", T25, [file("application/pdf", "a.pdf")]), P("Vid"));
    ok("MG3 a video / a PDF on a photos-and-text task: 400 kind_not_accepted, nothing posted or claimed",
      rv.status === 400 && rv.body.error === "kind_not_accepted" && rp.body.error === "kind_not_accepted" && posts.length === n &&
      await count(db, "select count(*) n from challenge_task_submit_claims where user_id = $1", [ST(5)]) === 0, { rv, rp });
  }

  // ───────────── MM. a classmate replies to a Mini App repost ─────────────
  console.log("MM. a classmate's text reply to a Mini App repost is a silent comment");
  setClock("2026-10-05T05:30:00Z");
  {
    const repost = Number((await one(db, "select message_id from challenge_task_messages where user_id = $1 and source = 'miniapp' order by message_id limit 1", [ST(1)])).message_id);
    const m = tgm({ from: TG(8), at: "2026-10-05T10:25:00", text: "Zo'r chiqibdi, menga ham juda yoqdi!", replyTo: { id: repost, from: 999, isBot: true } });
    const r = await cap(db, m);
    const row = await rowOf(db, CH1, m.message_id);
    ok("MM1 outcome comment / reply_classmate — the ledger makes the repost a classmate_bot_msg; no submission",
      r.outcome === "comment" && row?.reason === "reply_classmate" && !(await liveOf(db, ST(8), TMON)), { r, row });
  }

  // ───────────── MK. late ─────────────
  console.log("MK. the next day: yesterday's task still open → late, half points");
  setClock("2026-10-06T06:00:00Z"); // Tuesday 11:00 Tashkent
  {
    const rk = await handleSubmit(deps(), ST(6), input(TMON, "req_mk_000001", T25, [photo()]), P("Kech"));
    const sk = await liveOf(db, ST(6), TMON);
    ok("MK1 accepted with late_days 1 → +3 (ceil(5 × 0.5))", rk.status === 200 && sk?.status === "accepted" && sk?.late_days === 1 &&
      (await xpOf(db, ST(6), `ch_task:${TMON}`))?.amount === 3, { body: rk.body, sk });
  }

  // ───────────── MJ. closed ─────────────
  console.log("MJ. after the late window: closed, nothing posted");
  setClock("2026-10-08T01:00:00Z"); // Thursday 06:00 Tashkent: TMON closed at 00:00
  {
    const n = posts.length;
    const rj = await handleSubmit(deps(), ST(7), input(TMON, "req_mj_000001", T25, [photo()]), P("Yopiq"));
    const pj = await handlePrepare(deps(), ST(1), TMON);
    ok("MJ1 409 closed, nothing posted; prepare still shows the accepted student the task text ('done' / 'closed')",
      rj.status === 409 && rj.body.reason === "closed" && posts.length === n && String(pj.body.text ?? "").includes("Vazifa 2026-10-05"), { rj: rj.body, pj: pj.body });
  }

  // ───────────── MZ. the ledger stays whole ─────────────
  console.log("MZ. invariants");
  {
    const inv = (await one(db, "select challenge_tasks_health()->'invariants' i")).i as Row;
    ok("MZ1 every health invariant is zero; user_xp equals the ledger", await userXpOk(db) && Object.values(inv).every((v) => Number(v) === 0), inv);
    const mini = (await one(db, "select challenge_tasks_health()->'miniapp' m")).m as Row;
    ok("MZ2 health.miniapp: nothing stuck in 'posted' (MD's was healed, ME's was retried, MY's was closed)",
      Number(mini?.posted_stuck) === 0 && await count(db, "select count(*) n from challenge_task_submit_claims where state = 'posted'") === 0, mini);
    ok("MZ3 every Mini App ledger row carries a submission (no orphan reposts)",
      await count(db, "select count(*) n from challenge_task_messages where source = 'miniapp' and submission_id is null") === 0);
    ok("MZ4 the signals written are exactly the expected ones", JSON.stringify([...new Set(signals)].sort()) ===
      JSON.stringify(["challenge_task_miniapp_capture_failed", "challenge_task_miniapp_capture_rejected", "challenge_task_miniapp_submit_refused"]), signals);
  }
  await db.close();

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) throw new Error(`daily_tasks_miniapp: ${fail} check(s) failed`);
}
