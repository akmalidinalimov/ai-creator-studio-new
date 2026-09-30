// PGlite harness for 20260930151000_challenge_task_ai_check.sql + the challenge-task-check edge function (Daily Tasks
// PR-6: the AI checks).
//
//   deno test -A --node-modules-dir=none --no-lock supabase/functions/_challenge/testing/daily-tasks-ai-check-check.ts
//
// Builds production's state on a real PostgreSQL (PGlite, PG 17) exactly as the engine harness does (the live
// reconcilers, #218, PR-1, PR-2, the md5-verified live fixtures), applies PR-3 (20260930150020, the engine) and THIS
// migration, then proves, end to end:
//   P/M  prerequisites, apply (incl. the self-test), audit once, replay, the cron row, nothing posted at apply;
//   G    the four functions are service_role only;
//   K    the kick: paused / ai off / idle write the heartbeat ONLY (no outbound call); due -> ONE ops_net_post to the
//        checker with Content-Type + apikey + Bearer + x-internal-secret, 60 s; a leased row is not due; the budget
//        ceiling and the per-student cap stop it (the budget leaves one row a day);
//   D    challenge_task_check_media: the lease holder gets the raw Telegram messages (topic from webhook_inbox — an edit
//        wins; Mini App from the claim), anyone else 'stale';
//   R    challenge_task_check_release: refund (attempt back, calls booked with user_id NULL, no per-student cap hit),
//        charged (attempt spent, 'challenge_task_check_failed'), stale (ledger only);
//   E    the REAL edge-function run (check.ts runOnce) against this SQL through a PostgREST-shaped adapter, with a fake
//        Telegram (real JPEG / PNG / HEIC bytes), a fake provider and the REAL imagescript decoder: a general task
//        accepted; an instagram task accepted with its dHash, fingerprint 'ok', link_status 'unverified'; the same
//        screenshot re-encoded by another student rejected 'image_near_duplicate'; a HEIC screenshot judged and
//        fingerprinted through its thumbnail; an outage released free then checked on the next run; a broken answer
//        charged; a handle mismatch rejected; the run heartbeat, the cost ledger and health's AI counters;
//   X    imagescript on real bytes: a re-encoded / downsized copy stays within dhash_max_distance, HEIC decodes to null.
// The whole run sees a PINNED clock (PGlite's now() reads Date.now()).
// MIG_PATH=<file> tests a draft before it is written into its (edit-guarded) slot.
//
// CI NOTE: named *-check.ts, not *_test.ts / *.test.ts, so CI's `deno test supabase/functions/` never collects it (it
// needs -A: PGlite reads its own files, imagescript fetches its WASM codec). Run it by path as above.
// TEST INFRASTRUCTURE ONLY: this directory has no index.ts, so it is never deployed.

// ── the fixture world: a VERBATIM copy of daily-tasks-engine-check.ts (PR-3) lines 36-298 (itself PR-2's / PR-1's world) ──
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

// ── What PR-6 adds to the world: the two definer secrets the kick sends (stubs with production's ACL shape) ──
const AI_EXTRA = `
create function public.cron_service_key() returns text language sql security definer set search_path = public as $$ select 'svc-test-key' $$;
create function public.internal_fn_secret() returns text language sql security definer set search_path = public as $$ select 'int-test-secret' $$;
revoke execute on function public.cron_service_key() from public; grant execute on function public.cron_service_key() to service_role;
revoke execute on function public.internal_fn_secret() from public; grant execute on function public.internal_fn_secret() to service_role;
grant usage on schema public to service_role;
`;

import { runOnce } from "../../challenge-task-check/check.ts";
import { imagescriptCodec } from "../../challenge-task-check/image.ts";
import { dhashDistance, dhashFromRgba } from "../../challenge-task-check/media.ts";
import { Image } from "https://deno.land/x/imagescript@1.3.0/mod.ts";

Deno.test({
  name: CAN_RUN
    ? "daily_tasks_ai_check: 20260930151000 + challenge-task-check on PGlite (kick, media, release, the real run end to end)"
    : "daily_tasks_ai_check: SKIPPED -- needs `deno test -A --node-modules-dir=none` (PGlite reads its own files)",
  ignore: !CAN_RUN,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: run,
});

const realDateNow = Date.now.bind(Date);
let clockBase = Date.parse("2026-10-07T08:00:00Z"), clockT0 = realDateNow();   // Wed 13:00 Tashkent
const setClock = (iso: string) => { clockBase = Date.parse(iso); clockT0 = realDateNow(); };

async function run() {
  (Date as any).now = () => clockBase + (realDateNow() - clockT0);
  try { await runPinned(); } finally { (Date as any).now = realDateNow; }
}

/** A synthetic "screenshot" drawn in normalised coordinates, so a rescale is the same picture. */
function screenshot(w: number, h: number, variant: number): Image {
  const img = new Image(w, h);
  for (let y = 1; y <= h; y++) {
    for (let x = 1; x <= w; x++) {
      const u = x / w, t = y / h;
      const band = Math.floor(t * (6 + variant)) % 2 === 0 ? 230 : 40;
      const block = (Math.floor(u * (3 + variant)) + Math.floor(t * 5)) % 3 === 0 ? 80 : 0;
      const v = Math.max(0, Math.min(255, band - block + Math.round(40 * Math.sin(u * 7 + variant))));
      img.setPixelAt(x, y, Image.rgbaToColor(v, Math.max(0, v - 20), Math.min(255, v + 10), 255));
    }
  }
  return img;
}
const HEIC = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0, 0, 0, 0, 1, 2, 3, 4]);

async function runPinned() {
  const spec = "npm:@electric-sql/pglite@0.5.8"; // non-literal: never resolved or type-checked unless this runs
  const { PGlite } = (await import(spec)) as any;
  const { citext } = (await import(spec + "/contrib/citext")) as any;

  const MIG_PATH = Deno.env.get("MIG_PATH");
  const MIG = lf(await Deno.readTextFile(MIG_PATH ?? here("../../../migrations/20260930151000_challenge_task_ai_check.sql")));
  const ENGINE = lf(await Deno.readTextFile(here("../../../migrations/20260930150020_challenge_daily_tasks_engine.sql")));
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
  const count = async (db: PG, sql: string, params: unknown[] = []) => Number((await one(db, sql, params)).n);
  const tx = async (db: PG, sql: string): Promise<string | null> => {
    try { await db.exec("begin;\n" + sql + "\ncommit;"); return null; }
    catch (e) { try { await db.exec("rollback;"); } catch { /* none open */ } return String((e as Error).message); }
  };

  async function freshDb(opts: { withEngine?: boolean } = {}): Promise<PG> {
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
    for (const [name, sql] of [["#218", MIG218], ["PR-1", PR1], ["PR-2", PR2], ...(opts.withEngine === false ? [] : [["PR-3", ENGINE]])]) {
      const e = await tx(db, sql);
      if (e) throw new Error(`${name} did not apply: ${e}`);
      if (name === "PR-1") await db.exec(AFTER_PR1);
    }
    await db.exec(AI_EXTRA);
    return db;
  }

  async function as(db: PG, uid: string | null, sql: string, role = "authenticated"): Promise<string | null> {
    await db.exec(`select set_config('request.jwt.claim.sub', '${uid ?? ""}', false)`);
    await db.exec(`set role ${role}`);
    try { await db.query(sql); return null; }
    catch (e) { return String((e as Error).message); }
    finally { await db.exec("reset role"); await db.exec("select set_config('request.jwt.claim.sub', '', false)"); }
  }

  // ── Telegram messages with REAL file ids / sizes (the engine harness's tgm has unique ids only) ──
  const epoch = (local: string) => Math.floor(Date.parse(local + "+05:00") / 1000);
  let nextId = 30000;
  type M = Record<string, any>;
  const photoSizes = (id: string) => [
    { file_id: `${id}_s`, file_unique_id: `${id}_su`, width: 42, height: 90, file_size: 900 },
    { file_id: `${id}_m`, file_unique_id: `${id}_mu`, width: 320, height: 690, file_size: 22000 },
    { file_id: `${id}_y`, file_unique_id: `${id}_u`, width: 591, height: 1280, file_size: 102000 },
  ];
  const msg = (o: { from: number; at: string; caption?: string; text?: string; photo?: string; doc?: M; id?: number }): M => {
    const m: M = { message_id: o.id ?? nextId++, date: epoch(o.at), chat: { id: CH1, type: "supergroup", is_forum: true },
                   message_thread_id: D1, is_topic_message: true, from: { id: o.from, is_bot: false, first_name: "X" },
                   reply_to_message: { message_id: D1, message_thread_id: D1, forum_topic_created: { name: "KUNLIK VAZIFALAR" } } };
    if (o.text !== undefined) m.text = o.text;
    if (o.caption !== undefined) m.caption = o.caption;
    if (o.photo) m.photo = photoSizes(o.photo);
    if (o.doc) m.document = o.doc;
    return m;
  };
  let upd = 1;
  const post = async (db: PG, m: M, updateKey = "message"): Promise<Row> => {
    await db.query(`insert into webhook_inbox (received_at, update_type, chat_id, message_id, message_thread_id, from_user_id, chat_type, raw_update)
                    values (now(), $1, $2, $3, $4, $5, 'supergroup', $6::jsonb)`,
      [updateKey === "message" ? "message" : "unknown", m.chat.id, m.message_id, m.message_thread_id, m.from.id,
       JSON.stringify({ update_id: upd++, [updateKey]: m })]);
    if (updateKey !== "message") return {} as Row;
    return (await one(db, "select challenge_task_capture($1::jsonb, 'topic') r", [JSON.stringify(m)])).r as Row;
  };
  const cfgSet = async (db: PG, path: string, value: unknown) =>
    await db.query(`update platform_settings set value = jsonb_set(value, $1::text[], $2::jsonb) where key = 'challenge_tasks'`,
      [`{${path}}`, JSON.stringify(value)]);
  const sub = async (db: PG, id: number) => await one(db, "select * from challenge_task_submissions where id = $1", [id]);
  const kick = async (db: PG) => (await one(db, "select challenge_task_check_kick() r")).r as Row;
  const kickState = async (db: PG) => (await one(db, "select value v from app_settings where key = 'challenge_task_check_kick_state'"))?.v as Row;

  // ── the edge function's I/O against this database: a PostgREST-shaped admin client (RPCs run as service_role,
  //    one transaction each, serialized like separate HTTP requests), a fake Telegram, a fake provider ──
  const SIG: Record<string, Record<string, string>> = {
    challenge_tasks_config: {},
    challenge_task_check_claim: { _limit: "int" },
    challenge_task_check_media: { _sub: "bigint", _token: "uuid" },
    challenge_task_check_record: { _sub: "bigint", _token: "uuid", _version: "int", _result: "jsonb", _calls: "jsonb" },
    challenge_task_check_release: { _sub: "bigint", _token: "uuid", _reason: "text", _calls: "jsonb", _refund: "boolean" },
  };
  function pgAdmin(db: PG) {
    let chain: Promise<unknown> = Promise.resolve();
    const serial = <T>(fn: () => Promise<T>): Promise<T> => {
      const p = chain.then(fn, fn);
      chain = p.catch(() => undefined);
      return p;
    };
    const rpcLog: string[] = [];
    return {
      rpcLog,
      rpc(name: string, args: Record<string, unknown> = {}) {
        rpcLog.push(name);
        return serial(async () => {
          const sig = SIG[name];
          if (!sig) return { data: null, error: { message: `unknown rpc ${name}` } };
          const params: unknown[] = [];
          const parts: string[] = [];
          for (const [k, v] of Object.entries(args)) {
            if (!(k in sig)) return { data: null, error: { message: `unknown arg ${k}` } };
            params.push(sig[k] === "jsonb" ? JSON.stringify(v) : v);
            parts.push(`${k} => $${params.length}::${sig[k]}`);
          }
          await db.exec("begin; set local role service_role;");
          try {
            const r = await db.query(`select public.${name}(${parts.join(", ")}) as r`, params);
            await db.exec("commit");
            return { data: (r.rows[0] as Row).r, error: null };
          } catch (e) {
            await db.exec("rollback");
            return { data: null, error: { message: String((e as Error).message) } };
          }
        });
      },
      from(table: string) {
        if (table !== "admin_actions") throw new Error(`unexpected table ${table}`);
        const filters: [string, string, unknown][] = [];
        const b: any = {
          insert: (row: Row) => serial(async () => {
            await db.query(`insert into admin_actions (actor_user_id, action, target_user_id, details) values ($1, $2, $3, $4::jsonb)`,
              [row.actor_user_id ?? null, row.action, row.target_user_id ?? null, JSON.stringify(row.details ?? {})]);
            return { error: null };
          }),
          select: () => b,
          eq: (c: string, v: unknown) => (filters.push([c, "=", v]), b),
          gte: (c: string, v: unknown) => (filters.push([c, ">=", v]), b),
          limit: (n: number) => serial(async () => {
            const where = filters.map(([c, op], i) => `${c === "details->>dedupe_key" ? "details->>'dedupe_key'" : c} ${op} $${i + 1}`).join(" and ");
            const r = await db.query(`select id from admin_actions where ${where} limit ${n}`, filters.map((f) => f[2]));
            return { data: r.rows, error: null };
          }),
        };
        return b;
      },
    };
  }
  const files = new Map<string, Uint8Array>();
  const tgCalls: string[] = [];
  let telegramDown = false;
  const fakeTelegram = ((url: string, init?: RequestInit) => {
    tgCalls.push(url);
    if (telegramDown) return Promise.reject(new TypeError("network down"));
    const u = new URL(url);
    if (u.pathname.endsWith("/getFile")) {
      const id = JSON.parse(String(init?.body)).file_id as string;
      const f = files.get(id);
      if (!f) return Promise.resolve(new Response(JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: invalid file_id" }), { status: 400 }));
      return Promise.resolve(new Response(JSON.stringify({ ok: true, result: { file_id: id, file_path: `photos/${id}.jpg`, file_size: f.length } })));
    }
    const m = u.pathname.match(/\/photos\/(.+)\.jpg$/);
    const f = m ? files.get(m[1]) : undefined;
    return Promise.resolve(f ? new Response(f.slice()) : new Response("nf", { status: 404 }));
  }) as unknown as typeof fetch;
  class APIError extends Error { status?: number; constructor(s?: number) { super("api"); this.status = s; } }
  class Sub extends APIError {}
  const ERRS = { APIError, AuthenticationError: Sub, PermissionDeniedError: Sub, RateLimitError: Sub, APIConnectionError: Sub,
                 APIConnectionTimeoutError: Sub };
  const answers: (Row | Error)[] = [];
  const seen: Row[] = [];
  const provider = {
    messages: {
      create(params: Row) {
        seen.push(params);
        const a = answers.shift();
        if (!a) return Promise.reject(new APIError(500));
        if (a instanceof Error) return Promise.reject(a);
        return Promise.resolve({ model: "claude-haiku-4-5", stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(a) }],
                                 usage: { input_tokens: 1600, output_tokens: 80 } });
      },
    },
  };
  const checkRun = async (db: PG) => {
    const admin = pgAdmin(db);
    const out = await runOnce({ anthropicKey: "sk-ant-test", openaiKey: "", botToken: "123:TESTTOKEN" }, {
      admin, makeAnthropic: () => provider, anthropicErrors: ERRS as any, fetchFn: fakeTelegram, now: () => Date.now(), codec: imagescriptCodec,
    });
    return { ...out, rpcs: admin.rpcLog };
  };
  const GV = { reason: "Relevant work.", placeholder: false, inappropriate: false, secret: false, manipulation: false, on_task: "yes", confidence: 0.9 };
  const IV = (handle: string | null) => ({ reason: "An Instagram post.", is_instagram_screenshot: true, handle_seen: handle, tag_seen: true,
                                          post_age_text: "2 soat", posted_recently: "yes", inappropriate: false, manipulation: false, confidence: 0.9 });

  // ───────────── P. prerequisites ─────────────
  console.log("P. refuses to run before PR-3");
  {
    const d0 = await freshDb({ withEngine: false });
    const e = await tx(d0, MIG);
    ok("P1 without 20260930150020 the file aborts with a clear message", !!e && e.includes("ABORT: 20260930150020"), e);
    ok("P2 ...and leaves nothing behind", (await one(d0, "select to_regprocedure('public.challenge_task_check_kick()') r")).r === null &&
      await count(d0, "select count(*) n from cron.job where jobname = 'challenge-task-check-kick'") === 0);
    await d0.close();
  }

  // ───────────── M. apply, replay, audit ─────────────
  console.log("M. migration: applies (self-test included), audit once, replay");
  const db = await freshDb();
  {
    const e = await tx(db, MIG);
    ok("M1 applies (including its self-test)", e === null, e);
    if (e !== null) throw new Error(`daily_tasks_ai_check: the migration did not apply -- ${e}`);
    ok("M2 one audit row", await count(db, "select count(*) n from admin_actions where action = 'challenge_task_ai_check_applied'") === 1);
    const e2 = await tx(db, MIG);
    ok("M3 replay is a clean no-op", e2 === null, e2);
    ok("M4 replay: still one audit row, one cron row", await count(db, "select count(*) n from admin_actions where action = 'challenge_task_ai_check_applied'") === 1 &&
      await count(db, "select count(*) n from cron.job where jobname = 'challenge-task-check-kick'") === 1);
    const job = await one(db, "select schedule, command from cron.job where jobname = 'challenge-task-check-kick'");
    ok("M5 the kick runs every minute and only calls challenge_task_check_kick()", job.schedule === "* * * * *" &&
      job.command.trim() === "select public.challenge_task_check_kick()", job);
    ok("M6 nothing was posted and the config is untouched (enabled / ai false)", await count(db, "select count(*) n from ops_net_calls") === 0 &&
      (await one(db, "select challenge_tasks_config() c")).c.enabled === false && (await one(db, "select challenge_tasks_config() c")).c.ai === false);
    ok("M7 the self-test did not write the kick heartbeat (it never calls the kick)",
      await count(db, "select count(*) n from app_settings where key = 'challenge_task_check_kick_state'") === 0);
  }

  // ───────────── G. grants ─────────────
  console.log("G. the four functions are service_role only");
  {
    for (const f of ["challenge_task_check_kick()", "challenge_task_check_due()", "challenge_task_check_media(1, gen_random_uuid())",
                     "challenge_task_check_release(1, gen_random_uuid(), 'x', '[]', true)"]) {
      const st = await as(db, ST(1), `select ${f}`);
      const an = await as(db, null, `select ${f}`, "anon");
      ok(`G ${f.split("(")[0]}: a student and anon are refused`, !!st && /permission denied/.test(st) && !!an && /permission denied/.test(an), { st, an });
    }
    const acl = await q(db, `select p.proname, coalesce(array_to_string(p.proacl, ','), '') acl from pg_proc p
                              where p.proname in ('challenge_task_check_kick','challenge_task_check_due','challenge_task_check_media','challenge_task_check_release')`);
    ok("G5 ACLs: service_role, never PUBLIC", acl.length === 4 && acl.every((r) => /service_role=X/.test(r.acl) && !/(^|,)=X/.test(r.acl)), acl);
  }

  // ───────────── calendar + students ─────────────
  const SHOT = { any: ["photo", "image_doc"], min: 1, label: "screenshot" };
  const TEXT = { any: ["text"], min: 1, label: "text" };
  const IGL = { any: ["ig_link"], min: 1, label: "ig_link" };
  const addTask = async (date: string, type: string, requires: unknown, accepts: string[]) =>
    Number((await one(db, `insert into challenge_tasks (course_id, task_date, type, title, body, accepts, requires, status, source)
                           values ($1, $2, $3, $4, 'Vazifa matni', $5::text[], $6::jsonb, 'approved', 'manual') returning id`,
      [C6, date, type, `Vazifa ${date}`, `{${accepts.join(",")}}`, JSON.stringify(requires)])).id);
  const TTUE = await addTask("2026-10-06", "general", [SHOT, TEXT], ["text", "photo", "document"]);
  const TWED = await addTask("2026-10-07", "instagram", [SHOT, IGL], ["text", "photo", "document", "link"]);
  for (const [n, h] of [[31, "kid_one"], [32, "kid_two"], [33, "kid_three"], [34, "kid_four"], [35, "kid_five"], [36, "kid_six"]] as const) {
    await db.query("update profiles set instagram_username = $2 where id = $1", [ST(n), h]);
  }
  const CAPTION = "Mana bugungi vazifam: ChatGPT bilan uchta prompt yozdim";

  // ───────────── K. the kick ─────────────
  console.log("K. the kick: heartbeat only unless active + ai + due; one ops_net_post when due");
  {
    const k0 = await kick(db);
    const st0 = await kickState(db);
    ok("K1 paused: state 'inactive', no call, the heartbeat row stamped", k0.state === "inactive" && k0.kicked === false &&
      await count(db, "select count(*) n from ops_net_calls") === 0 && st0?.state === "inactive" && !!st0?.checked_at, { k0, st0 });
    await cfgSet(db, "enabled", true);
    ok("K2 active, ai=false: 'ai_off', no call", (await kick(db)).state === "ai_off" && await count(db, "select count(*) n from ops_net_calls") === 0);
    await cfgSet(db, "ai", true);
    ok("K3 ai=true, nothing checking: 'idle', no call", (await kick(db)).state === "idle" && await count(db, "select count(*) n from ops_net_calls") === 0);

    const r = await post(db, msg({ from: TG(31), at: "2026-10-06T12:00:00", photo: "g31", caption: CAPTION }));
    ok("K4 a general photo + caption is captured into 'checking' (ai=true)", r?.submission?.status === "checking", r);
    const k4 = await kick(db);
    const call = await one(db, "select * from ops_net_calls order by id desc limit 1");
    ok("K5 due: exactly ONE ops_net_post to challenge-task-check, 60 s, purpose challenge-task-check", k4.state === "due" && k4.due === 1 &&
      k4.kicked === true && await count(db, "select count(*) n from ops_net_calls") === 1 &&
      call.url === "https://cdyidatkegxwhtuoqxly.supabase.co/functions/v1/challenge-task-check" &&
      call.purpose === "challenge-task-check" && call.timeout_ms === 60000, { k4, call });
    ok("K6 ...with Content-Type, apikey, Bearer service key and x-internal-secret", call.headers["Content-Type"] === "application/json" &&
      call.headers.apikey === "svc-test-key" && call.headers.Authorization === "Bearer svc-test-key" &&
      call.headers["x-internal-secret"] === "int-test-secret", call.headers);
    const st = await kickState(db);
    ok("K7 the heartbeat records the kick", st.state === "due" && st.kicked === true && !!st.last_kick_at && st.kicks_today === 1, st);
    // leased by a run in flight -> not due
    await db.query("update challenge_task_submissions set check_token = gen_random_uuid(), check_claimed_at = now() where id = $1", [r.submission.id]);
    ok("K8 a submission leased by a run in flight is not due (no second call)", (await kick(db)).state === "idle" &&
      await count(db, "select count(*) n from ops_net_calls") === 1);
    // an expired lease (> 10 min) is due again
    await db.query("update challenge_task_submissions set check_claimed_at = now() - interval '11 minutes' where id = $1", [r.submission.id]);
    ok("K9 an expired lease is due again", (await kick(db)).state === "due" && await count(db, "select count(*) n from ops_net_calls") === 2);
    await db.query("update challenge_task_submissions set check_token = null, check_claimed_at = null where id = $1", [r.submission.id]);
    // the per-student cap
    await db.query(`insert into challenge_task_ai_calls (submission_id, user_id, provider, status, cost_usd)
                    select $1, $2, 'anthropic', 'ok', 0 from generate_series(1, 6)`, [r.submission.id, ST(31)]);
    ok("K10 a student at ai_max_checks_per_user_day (6) is not due", (await kick(db)).state === "idle" && await count(db, "select count(*) n from ops_net_calls") === 2);
    await db.query("delete from challenge_task_ai_calls");
    // the daily budget
    await db.query(`insert into challenge_task_ai_calls (provider, status, cost_usd) values ('anthropic', 'ok', 3.5)`);
    const kb = await kick(db);
    await kick(db);
    ok("K11 over ai_daily_budget_usd: 'budget', no call, ONE 'challenge_task_ai_budget_exhausted' row a day", kb.state === "budget" &&
      await count(db, "select count(*) n from ops_net_calls") === 2 &&
      await count(db, "select count(*) n from admin_actions where action = 'challenge_task_ai_budget_exhausted'") === 1, kb);
    ok("K12 the claim agrees (budget), so the kick never wakes the checker for nothing",
      (await one(db, "select challenge_task_check_claim() r")).r.reason === "budget");
    await db.query("delete from challenge_task_ai_calls");
    ok("K13 due again once the budget allows", (await kick(db)).state === "due");
  }

  // ───────────── D. media ─────────────
  console.log("D. challenge_task_check_media: the lease holder only; an edit wins; Mini App items from the claim");
  {
    const claim = (await one(db, "select challenge_task_check_claim(5) r")).r;
    const it = claim.items[0];
    const m = (await one(db, "select challenge_task_check_media($1, $2::uuid) r", [it.submission_id, it.token])).r;
    ok("D1 the lease holder gets the raw message with its file ids and submitted_on", m.ok === true && m.submitted_on === "2026-10-06" &&
      m.items.length === 1 && m.items[0].message.photo[1].file_id === "g31_m" && m.items[0].source === "topic", m);
    const stale = (await one(db, "select challenge_task_check_media($1, gen_random_uuid()) r", [it.submission_id])).r;
    ok("D2 any other token: 'stale', nothing returned", stale.ok === false && stale.reason === "stale" && !("items" in stale), stale);
    // an edit (logged as update_type 'unknown') wins over the original
    const orig = (await one(db, "select raw_update->'message' m from webhook_inbox where message_id = $1", [m.items[0].message_id])).m;
    await post(db, { ...orig, caption: CAPTION + " (tahrir)", edit_date: orig.date + 60 }, "edited_message");
    const m2 = (await one(db, "select challenge_task_check_media($1, $2::uuid) r", [it.submission_id, it.token])).r;
    ok("D3 an edited message (update_type 'unknown') wins over the original", m2.items[0].message.caption.endsWith("(tahrir)"), m2.items[0].message.caption);
    await db.query("update challenge_task_submissions set check_token = null, check_claimed_at = null, check_attempts = 0 where id = $1", [it.submission_id]);
    // a Mini App item: the message comes from the claim the edge function stored
    const mm = { message_id: 99001, chat: { id: CH1 }, date: epoch("2026-10-06T13:00:00"), message_thread_id: D1,
                 photo: photoSizes("mini"), caption: "Mini App orqali yuborildi — bugungi vazifa" };
    await db.query(`insert into challenge_task_submit_claims (user_id, request_id, task_id, state, items) values ($1, 'req-mini-0001', $2, 'posted', $3::jsonb)`,
      [ST(33), TTUE, JSON.stringify([mm])]);
    await db.query(`insert into challenge_task_submissions (task_id, user_id, group_id, source, attributed_via, status, submitted_at, last_item_at, request_id, check_token)
                    values ($1, $2, $3, 'miniapp', 'miniapp', 'checking', now() - interval '1 day', now() - interval '1 day', 'req-mini-0001', '22222222-2222-2222-2222-222222222222')`,
      [TTUE, ST(33), G1]);
    const ms = await one(db, "select id from challenge_task_submissions where request_id = 'req-mini-0001'");
    await db.query(`insert into challenge_task_messages (chat_id, message_id, thread_id, group_id, user_id, sent_at, outcome, resolved_via, submission_id, kinds, source)
                    values ($1, 99001, $2, $3, $4, now() - interval '1 day', 'created', 'miniapp', $5, '{photo,text}', 'miniapp')`,
      [CH1, D1, G1, ST(33), ms.id]);
    const m3 = (await one(db, "select challenge_task_check_media($1, '22222222-2222-2222-2222-222222222222'::uuid) r", [ms.id])).r;
    ok("D4 a Mini App item: the Message stored in the claim (not webhook_inbox)", m3.ok === true && m3.items[0].source === "miniapp" &&
      m3.items[0].message.photo[2].file_id === "mini_y", m3);
    await db.query("delete from challenge_task_messages where message_id = 99001");
    await db.query("delete from challenge_task_submissions where id = $1", [ms.id]);
  }

  // ───────────── R. release ─────────────
  console.log("R. challenge_task_check_release: free (refund) vs charged vs stale");
  {
    const it = (await one(db, "select challenge_task_check_claim(5) r")).r.items[0];
    const before = await sub(db, it.submission_id);
    const call = { provider: "anthropic", model: "claude-haiku-4-5", prompt_version: "task-v1", status: "http_5xx", cost_usd: 0 };
    const rf = (await one(db, "select challenge_task_check_release($1, $2::uuid, 'ai_no_provider', $3::jsonb, true) r",
      [it.submission_id, it.token, JSON.stringify([call])])).r;
    const after = await sub(db, it.submission_id);
    ok("R1 refund: lease cleared, the claim's attempt returned", rf.ok === true && rf.refunded === true && before.check_attempts === 1 &&
      after.check_attempts === 0 && after.check_token === null && after.status === "checking", { rf, before: before.check_attempts, after: after.check_attempts });
    ok("R2 ...the failed call is in the cost ledger with user_id NULL (never counts toward the student's cap), no failure row",
      await count(db, "select count(*) n from challenge_task_ai_calls where submission_id = $1 and user_id is null and status = 'http_5xx'", [it.submission_id]) === 1 &&
      await count(db, "select count(*) n from admin_actions where action = 'challenge_task_check_failed'") === 0);
    const it2 = (await one(db, "select challenge_task_check_claim(5) r")).r.items[0];
    const ch = (await one(db, "select challenge_task_check_release($1, $2::uuid, 'ai_schema: bad', $3::jsonb, false) r",
      [it2.submission_id, it2.token, JSON.stringify([{ ...call, status: "schema", input_tokens: 1500, output_tokens: 40, cost_usd: 0.0017 }])])).r;
    const a2 = await sub(db, it2.submission_id);
    ok("R3 charged: the attempt stays spent, 'challenge_task_check_failed' written, the call billed to the student", ch.ok === true &&
      ch.refunded === false && a2.check_attempts === 1 && a2.check_token === null &&
      await count(db, "select count(*) n from admin_actions where action = 'challenge_task_check_failed' and details->>'reason' = 'ai_schema: bad'") === 1 &&
      await count(db, "select count(*) n from challenge_task_ai_calls where submission_id = $1 and user_id = $2 and status = 'schema' and cost_usd = 0.0017",
        [it2.submission_id, ST(31)]) === 1, ch);
    const stale = (await one(db, "select challenge_task_check_release($1, gen_random_uuid(), 'x', $2::jsonb, true) r",
      [it2.submission_id, JSON.stringify([call])])).r;
    ok("R4 a stale token changes nothing but the ledger", stale.ok === false && stale.reason === "stale" && stale.calls_recorded === 1 &&
      (await sub(db, it2.submission_id)).check_attempts === 1);
    const nf = (await one(db, "select challenge_task_check_release(-5, gen_random_uuid(), 'x', '[]', true) r")).r;
    ok("R5 an unknown submission: not_found, nothing written", nf.ok === false && nf.reason === "not_found");
    await db.query("delete from challenge_task_ai_calls");
    await db.query("update challenge_task_submissions set check_attempts = 0");
  }

  // ───────────── X. imagescript on real bytes ─────────────
  console.log("X. imagescript + dHash on real JPEG / PNG / HEIC bytes");
  const A_m = await screenshot(320, 690, 0).encodeJPEG(85);
  const A_y = await screenshot(591, 1280, 0).encodeJPEG(85);
  const B_m = await screenshot(300, 647, 0).encodeJPEG(60);    // the SAME screenshot, re-encoded by another student
  const B_y = await screenshot(591, 1280, 0).encodeJPEG(60);
  const C_t = await screenshot(320, 690, 4).encodeJPEG(80);    // a different screenshot (HEIC original, JPEG thumbnail)
  const G_m = await screenshot(320, 690, 2).encodeJPEG(80);
  const G_y = await screenshot(591, 1280, 2).encodeJPEG(80);
  const E_m = await screenshot(320, 690, 8).encodeJPEG(80);
  const E_y = await screenshot(591, 1280, 8).encodeJPEG(80);
  const P_m = await screenshot(320, 690, 6).encode();          // a PNG
  {
    const h = async (b: Uint8Array) => { const d = await imagescriptCodec.decode(b); return d ? dhashFromRgba(d) : null; };
    const [ha, hb, hc, hp] = [await h(A_m), await h(B_m), await h(C_t), await h(P_m)];
    ok("X1 JPEG and PNG decode; a re-encoded, downsized copy is within dhash_max_distance (4)", !!ha && !!hb && !!hp &&
      dhashDistance(ha!, hb!)! <= 4, { ha, hb, d: ha && hb ? dhashDistance(ha, hb) : null });
    const hs = [await h(A_m), await h(G_m), await h(C_t), await h(E_m)];
    const far = hs.every((x, i) => hs.every((y, j) => i === j || (x && y && dhashDistance(x, y)! > 4)));
    ok("X2 the four different screenshots used below are pairwise far (> 4)", !!hc && far, hs);
    ok("X3 HEIC and garbage decode to null (-> the thumbnail fallback)", (await imagescriptCodec.decode(HEIC)) === null &&
      (await imagescriptCodec.decode(new Uint8Array([0xff, 0xd8, 0xff, 1, 2]))) === null);
  }
  for (const [k, v] of Object.entries({ g31_s: G_m, g31_m: G_m, g31_y: G_y, a32_s: A_m, a32_m: A_m, a32_y: A_y, b33_s: B_m, b33_m: B_m, b33_y: B_y,
                                        heic34: HEIC, heic34_t: C_t, h35_s: G_m, h35_m: G_m, h35_y: G_y,
                                        e36_s: E_m, e36_m: E_m, e36_y: E_y })) files.set(k, v);

  // ───────────── E. the edge function's run, end to end against this SQL ─────────────
  console.log("E. challenge-task-check runOnce end to end (real SQL, real decoder, fake Telegram / provider)");
  {
    // E1 the general submission (TG 31): accepted
    answers.push(GV);
    const r1 = await checkRun(db);
    const s31 = await one(db, "select * from challenge_task_submissions where user_id = $1 and task_id = $2", [ST(31), TTUE]);
    ok("E1 general: claim -> media -> label -> record: accepted, +5, one costed call in the ledger", r1.httpStatus === 200 &&
      s31.status === "accepted" && s31.points_awarded === 5 && s31.check_result.verdict.on_task === "yes" &&
      await count(db, "select count(*) n from challenge_task_ai_calls where submission_id = $1 and provider = 'anthropic' and prompt_version = 'task-v1' and cost_usd > 0",
        [s31.id]) === 1, { body: r1.body, s31: { status: s31.status, reason: s31.reason, pts: s31.points_awarded } });
    ok("E2 the RPCs, in order: config, claim, media, record", JSON.stringify(r1.rpcs) ===
      JSON.stringify(["challenge_tasks_config", "challenge_task_check_claim", "challenge_task_check_media", "challenge_task_check_record"]), r1.rpcs);
    const p1 = seen[seen.length - 1];
    const imgs = p1.messages[0].content.filter((c: Row) => c.type === "image");
    ok("E3 the provider got the 591-px photo as base64 (never a URL, never a file id) and the general prompt",
      imgs.length === 1 && imgs[0].source.type === "base64" && imgs[0].source.data.length > 1000 &&
      !JSON.stringify(p1).includes("api.telegram.org") && !JSON.stringify(p1).includes("g31_") && /on_task/.test(p1.system), imgs.map((i: Row) => i.source.type));
    ok("E4 general tasks are not fingerprinted (C13) and carry no link status", s31.check_result.dhash === null &&
      s31.check_result.fingerprint === null && s31.check_result.link_status === null, s31.check_result);
    const hb1 = (await one(db, "select details d from admin_actions where action = 'challenge_task_check_run' order by created_at desc limit 1")).d;
    ok("E5 the run heartbeat: claimed 1, checked 1, accepted 1, cost, provider, prompt version, probe off", hb1.claimed === 1 &&
      hb1.checked === 1 && hb1.accepted === 1 && hb1.cost_usd > 0 && hb1.providers_used[0] === "anthropic" && hb1.prompt_version === "task-v1" &&
      hb1.ig_probe === "off_login_wall", hb1);

    // E6 instagram A (TG 32, kid_two): accepted with its dHash
    const ra = await post(db, msg({ from: TG(32), at: "2026-10-07T11:00:00", photo: "a32", caption: "https://www.instagram.com/p/CodeA32xx/" }));
    ok("E6 instagram A captured into checking (no hold, ai=true)", ra?.submission?.status === "checking" && ra?.submission?.hold_reason === null, ra);
    answers.push(IV("kid_two"));
    await checkRun(db);
    const sa = await one(db, "select * from challenge_task_submissions where user_id = $1 and task_id = $2", [ST(32), TWED]);
    ok("E7 instagram A: accepted +8; check_result carries dhash (16 hex), fingerprint ok, link_status 'unverified'",
      sa.status === "accepted" && sa.points_awarded === 8 && Array.isArray(sa.check_result.dhash) && /^[0-9a-f]{16}$/.test(sa.check_result.dhash[0]) &&
      sa.check_result.fingerprint === "ok" && sa.check_result.link_status === "unverified", sa.check_result);
    const pA = seen[seen.length - 1];
    ok("E8 the instagram prompt + the task's tag handle reached the model; images at detail high are base64",
      /PUBLISHED the post/.test(pA.system) && JSON.stringify(pA.messages[0].content).includes("aicreators.students"), pA.system.slice(0, 80));
    ok("E9 the dHash is the SMALL variant's (320 px), not the 591-px original the model saw",
      sa.check_result.dhash[0] === dhashFromRgba((await imagescriptCodec.decode(A_m))!), sa.check_result.dhash);

    // E10 instagram B (TG 33): the same screenshot, re-encoded, different file ids -> image_near_duplicate
    const rb = await post(db, msg({ from: TG(33), at: "2026-10-07T11:30:00", photo: "b33", caption: "https://www.instagram.com/p/CodeB33yy/" }));
    ok("E10 B's file_unique_ids differ from A's, so the engine's exact-reuse rule does not fire", rb?.submission?.status === "checking", rb);
    answers.push(IV("kid_three"));
    await checkRun(db);
    const sb = await one(db, "select * from challenge_task_submissions where user_id = $1 and task_id = $2 order by id desc limit 1", [ST(33), TWED]);
    ok("E11 B: rejected 'image_near_duplicate' (dHash within 4 of A's), 0 points", sb.status === "rejected" && sb.reason === "image_near_duplicate" &&
      sb.points_awarded === 0 && dhashDistance(sb.check_result.dhash[0], sa.check_result.dhash[0])! <= 4, { reason: sb.reason, d: sb.check_result?.dhash });

    // E12 instagram C (TG 34): a HEIC screenshot document -> judged and fingerprinted through its JPEG thumbnail
    const rc = await post(db, msg({ from: TG(34), at: "2026-10-07T12:00:00", caption: "https://www.instagram.com/p/CodeC34zz/",
      doc: { file_id: "heic34", file_unique_id: "heic34_u", mime_type: "image/heic", file_size: 800000,
             thumbnail: { file_id: "heic34_t", file_unique_id: "heic34_tu", width: 320, height: 690 } } }));
    ok("E12 a HEIC image document counts as the screenshot (image_doc)", rc?.submission?.status === "checking", rc);
    answers.push(IV("kid_four"));
    const r3 = await checkRun(db);
    const sc = await one(db, "select * from challenge_task_submissions where user_id = $1 and task_id = $2", [ST(34), TWED]);
    ok("E13 C: accepted; the dHash is the thumbnail's; fingerprint 'ok'; the heartbeat counts one thumbnail fallback",
      sc.status === "accepted" && sc.check_result.fingerprint === "ok" &&
      sc.check_result.dhash[0] === dhashFromRgba((await imagescriptCodec.decode(C_t))!) && (r3.body as Row).thumb_fallbacks === 1, { cr: sc.check_result, body: r3.body });
    const pC = seen[seen.length - 1];
    ok("E14 the model saw the thumbnail as image/jpeg (HEIC is never sent)", pC.messages[0].content.some((c: Row) => c.type === "image" &&
      c.source.media_type === "image/jpeg"), null);

    // E15 outage: the provider is down -> released FREE; the next run checks it
    const rd = await post(db, msg({ from: TG(35), at: "2026-10-07T12:30:00", photo: "h35", caption: "https://www.instagram.com/p/CodeD35ww/" }));
    answers.push(new APIError(529));
    const r4 = await checkRun(db);
    const sd = await sub(db, rd.submission.id);
    ok("E15 provider down: released FREE — still checking, attempts back to 0, the failed call booked with user_id NULL",
      sd.status === "checking" && sd.check_attempts === 0 && sd.check_token === null && (r4.body as Row).released_free === 1 &&
      await count(db, "select count(*) n from challenge_task_ai_calls where submission_id = $1 and user_id is null and status = 'http_5xx'", [sd.id]) === 1,
      { sd: { st: sd.status, at: sd.check_attempts }, body: r4.body });
    ok("E16 ...and the kick sees it due again (no lease held)", (await kick(db)).state === "due");
    answers.push(IV("kid_five"));
    await checkRun(db);
    ok("E17 the provider is back: accepted on the next run", (await sub(db, rd.submission.id)).status === "accepted");

    // E18 Telegram down while fetching the screenshot -> released FREE too
    const re = await post(db, msg({ from: TG(36), at: "2026-10-07T12:40:00", photo: "e36", caption: "https://www.instagram.com/p/CodeE36vv/" }));
    ok("E18a a fifth, different screenshot is captured into checking", re?.submission?.status === "checking", re);
    telegramDown = true;
    const r5 = await checkRun(db);
    telegramDown = false;
    const se = await sub(db, re.submission.id);
    ok("E18 Telegram unreachable: the screenshot cannot be fetched -> released FREE, no provider call", se.status === "checking" &&
      se.check_attempts === 0 && (r5.body as Row).released_free === 1 && (r5.body as Row).calls === 0, r5.body);
    // E19 a broken answer: CHARGED
    answers.push({ ...IV("kid_six"), extra: 1 });
    const r6 = await checkRun(db);
    const se2 = await sub(db, re.submission.id);
    ok("E19 a schema-breaking answer is CHARGED: attempt spent, 'challenge_task_check_failed', never a verdict", se2.status === "checking" &&
      se2.check_attempts === 1 && se2.check_result === null && (r6.body as Row).released_charged === 1 &&
      await count(db, "select count(*) n from admin_actions where action = 'challenge_task_check_failed' and target_user_id = $1", [ST(36)]) === 1, r6.body);
    // E20 a handle that is not the student's: SQL rejects (the model only reports what it read)
    answers.push(IV("somebody_else"));
    await checkRun(db);
    const se3 = await sub(db, re.submission.id);
    ok("E20 the model read another account's handle -> SQL rejects 'ig_handle_mismatch' (the model never saw the expected handle)",
      se3.status === "rejected" && se3.reason === "ig_handle_mismatch", { st: se3.status, r: se3.reason });
    ok("E21 the expected handle was never sent to the model", !seen.some((p) => JSON.stringify(p.messages).includes("kid_six")));

    // E22 nothing due: the kick idles; the health counters see the checks
    ok("E22 queue empty: the kick is idle", (await kick(db)).state === "idle");
    const h = (await one(db, "select challenge_tasks_health() h")).h;
    ok("E23 health: ig_link_unverified_7d counts the instagram checks, ai_24h the calls and cost, no fingerprint_unavailable",
      h.ig_link_unverified_7d >= 4 && h.ai_24h.calls >= 6 && Number(h.ai_24h.cost_usd) > 0 && h.fingerprint_unavailable_7d === 0 &&
      h.checks.queue === 0, { u: h.ig_link_unverified_7d, ai: h.ai_24h, f: h.fingerprint_unavailable_7d, q: h.checks });
    ok("E24 invariants hold (ledger drift 0, live duplicates 0)", h.invariants.ledger_drift === 0 && h.invariants.live_duplicates === 0, h.invariants);
    ok("E25 every Telegram call was file retrieval (getFile / file bytes), never a send",
      tgCalls.every((u) => /\/bot123:TESTTOKEN\/getFile$/.test(u) || /\/file\/bot123:TESTTOKEN\/photos\//.test(u)), tgCalls.slice(0, 3));
  }

  // ───────────── Z. pause again: the kick stops at once ─────────────
  console.log("Z. pause: the kick stops calling at once");
  {
    const before = await count(db, "select count(*) n from ops_net_calls");
    await post(db, msg({ from: TG(40), at: "2026-10-07T13:00:00", photo: "z40", caption: CAPTION }));
    await cfgSet(db, "ai", false);
    const k = await kick(db);
    ok("Z1 ai=false: 'ai_off', no call, the heartbeat keeps ticking", k.state === "ai_off" &&
      await count(db, "select count(*) n from ops_net_calls") === before && (await kickState(db)).state === "ai_off", k);
    ok("Z2 ...and the claim refuses too (the checker could not lease anything)", (await one(db, "select challenge_task_check_claim() r")).r.reason === "disabled");
  }
  await db.close();

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) throw new Error(`daily_tasks_ai_check: ${fail} check(s) failed`);
}
