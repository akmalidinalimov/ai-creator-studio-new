// PGlite harness for 20260930155020_challenge_retro_credit_on_join.sql (S3: credit earlier messages on join).
//
//   deno test -A --node-modules-dir=none --no-lock supabase/functions/_challenge/testing/retro-credit-check.ts
//
// Builds production's engine state on a real PostgreSQL -- the LIVE reconcile_community_xp and
// reconcile_challenge_xp (fixtures), #218 (20260930100010) and Daily Tasks PR-1 (20260930121000) -- and section A
// asserts that every engine body this migration CALLS or REWRITES is byte-identical to production (md5 of prosrc,
// read-only 2026-09-30), plus admin_void_challenge_points. Then it applies THIS migration (M also pins the three
// rewritten bodies, their ACLs and defaults) and proves:
//   C  late link == linked from the start: the same xp_events (user, reason, ref_key, amount, historic created_at)
//      and the same answer candidates, for the late student, a username-stamped student, a group mover and a late
//      staff member; caps per HISTORIC Tashkent day; isolation (another person, another chat, another group,
//      anonymous admin, pre-window rows are never attached or credited).
//      The pass is SCOPED to the batch's students and writes the engines' own '_scoped' heartbeats.
//   D  idempotency: repeated sweeps, explicit engine re-runs and live ticks change nothing; user_xp drift 0; a
//      scoped engine run without an explicit start is refused.
//   E  no double pay with interleaved LIVE ticks (link -> live ticks pay the recent posts -> sweep pays the rest):
//      per-day caps hold and per-day totals equal the linked-from-the-start run.
//   V  an admin void holds against every engine path: the cron tick's 40-minute overlap, an unrelated late link,
//      a global heal, an explicit back-fill; a post made after the void pays.
//   KS / CF / QO  an unrelated late link leaves another student's xp_events byte-identical across a period while
//      the challenge was stopped, a cap change, and a qa.mode 'off' period (no candidate, no judge call).
//   K  kill-switches: retro_credit off, challenge disabled (deferred, then paid), expired after the W2 tail, tail,
//      a profile-bound (scoped) heal and a global heal.
//   B  a scoped pass that paid outside its batch alarms R5.
//   J  a failing attach never fails the profile write (signal row), and the sweep heals it.
//   R  an engine section error keeps the ledger pending, retries, stops at max_attempts, alarms (R2) with ONE DM,
//      recovers after the fix, and sends the recovery DM.
//   U  an unattached row of an already-linked sender is detected (R3) and healed by the sweep.
//   O  the history heal row on apply (window already open) credits pre-trigger links; replay-safe.
//   Z  today's production state (window not open): linking attaches nothing, the sweep is idle, the watchdog inactive.
//   M  migration: applies with its self-test, config seed (existing values win), ACLs, trigger, cron, index, replay.
// Not covered (one PGlite session; advisory locks are re-entrant within a session): the 'locked' branch, where a
// live tick in ANOTHER session holds an engine lock. It is the engines' own try-lock shape, read in review.
//
// Run it after ANY change to the migration, and before asking for the migration-approved label.
// MIG_PATH=<file> tests a draft before it is written into its (edit-guarded) slot.
//
// CI NOTE: CI runs `deno test supabase/functions/` with NO permission flags. Without --allow-read PGlite cannot
// load its own data files, so this suite registers as IGNORED there (visible in the log, never a false red).
// TEST INFRASTRUCTURE ONLY: this directory has no index.ts, so it is never deployed.

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;
interface PG {
  query(sql: string, params?: unknown[]): Promise<{ rows: Row[] }>;
  exec(sql: string): Promise<unknown>;
  close(): Promise<void>;
}

const granted = (name: "read" | "env" | "net") => {
  try { return Deno.permissions.querySync({ name }).state === "granted"; } catch { return false; }
};
const CAN_RUN = granted("read") && granted("env") && granted("net");

const here = (p: string) => new URL(p, import.meta.url);
const lf = (s: string) => s.replace(/\r\n/g, "\n"); // a Windows checkout is CRLF; production text is LF

// ── production facts (read-only, 2026-09-30 15:30 UTC): md5(replace(prosrc, E'\r', '')) ──
const PROD_BODY_MD5: Record<string, string> = {
  "reconcile_challenge_xp(timestamp with time zone)": "6074d56ec11578ed727c5d6a390272f6",
  "reconcile_challenge_social_xp(timestamp with time zone)": "6fd3053f80f2937b7e1b82115fdbc487",
  "challenge_social_source(timestamp with time zone,timestamp with time zone,uuid[],timestamp with time zone,timestamp with time zone,integer)":
    "224711a4266dd249e36be8d1b0132f21",
  "challenge_qa_enqueue_range(timestamp with time zone,timestamp with time zone,uuid[],timestamp with time zone,timestamp with time zone,integer,integer,integer,boolean,integer)":
    "ba37ec893a1aa652d491ef7f26ee6c89",
  "challenge_qa_apply()": "d7fe9e64b84a67b8cfed4a0255b6df2b",
  "challenge_qa_claim(integer,text[])": "ee6bf143cb5c48276e8265a3d9c91ab9",
  "challenge_qa_record(bigint,uuid,jsonb,jsonb)": "b3d44822b971c65304440651c568b5ed",
  "challenge_qa_context(bigint,bigint,bigint)": "a86cd17088248f898ad0ad92e5f6663b",
  "challenge_social_config()": "90d0f8d0ef756c9d594f5d311646d344",
  "challenge_social_staff_ids()": "5cfe05cb4d95e316935e1c7241723cfe",
  "challenge_social_owns_community(uuid,timestamp with time zone)": "00cee005d09bf38947e1dd7bd2bee505",
  "challenge_config()": "35fa6b21e8c2e75b96cb3e3b172d648c",
  "challenge_active(timestamp with time zone)": "b6aff8fc9d2b75063be5ccdd1568b2c1",
  "challenge_scope_group_ids()": "905460a470a4e03c6a6939f1eec5b4db",
  "challenge_cfg_int(jsonb)": "3dcfb2bab5ad4b70b844f03142de2e9f",
  "group_telegram_chat_id(uuid)": "5a7d02fbb86f2efe9839257740e8278a",
  "reconcile_community_xp(timestamp with time zone)": "bf77d191befedad7e4049de31b15b899",
  "admin_void_challenge_points(uuid,text)": "119b924ae309a6bc3784c8ab72d9e468",
};
// ── this migration's pinned rewrites (section 5): the bodies it must leave behind (its own _new_pin constants) ──
const NEW_BODY_MD5: Record<string, string> = {
  "challenge_qa_enqueue_range(timestamp with time zone,timestamp with time zone,uuid[],timestamp with time zone,timestamp with time zone,integer,integer,integer,boolean,integer,uuid[])":
    "a9ce39d32eb8d98419607235772ee533",
  "reconcile_challenge_social_xp(timestamp with time zone,uuid[])": "a77827855bff5662d7a9f3d1fd91d3db",
  "reconcile_challenge_xp(timestamp with time zone,uuid[])": "635dff0d11e4f218739407576275ac67",
};

const C6 = "f502f631-2104-4834-b6c2-702cd3080e27";
const C5 = "78011384-4024-49b0-b72d-b0b2e3a04ee8";
// The four production 6.0 groups (PR-1 seeds their daily topics by id) and one 5.0 group.
const G1 = "f675a2fd-b1ce-4d28-94a4-7fc0e1a91515", G2 = "c092a0db-b55f-4fa7-8548-befad285037b";
const G3 = "3a7ebea8-80eb-4b64-a282-471a0fa12ef4", G4 = "93e8e7b0-275c-47a9-a97d-ff28e26c8f5b";
const G5 = "55555555-5555-5555-5555-555555555555";
const CH1 = -1004440955972, CH2 = -1004390902020, CH3 = -1003714608284, CH4 = -1004463424516, CH5 = -100555;
const CHAT_OF: Record<string, number> = { [G1]: CH1, [G2]: CH2, [G3]: CH3, [G4]: CH4, [G5]: CH5 };
const HW1 = 3, DAILY1 = 144, GENERAL = 10; // G1 topics: homework, KUNLIK VAZIFALAR (seeded by PR-1), a chat topic

const U = (n: number) => `aaaaaaaa-0000-0000-0000-${String(n).padStart(12, "0")}`;
const L = U(1);   // late linker, G1 -- posts before pressing Start
const P = U(2);   // linked classmate, G1
const K = U(3);   // linked classmate, G1 -- answers L's question
const R = U(4);   // pre-created profile matched by USERNAME: rows stamped, telegram_id NULL until linked
const M = U(5);   // linked 5.0 student (G5) who posts in the G1 chat, then is moved into G1
const Z = U(6);   // linked student of G2
const T = U(7);   // teacher (staff) in G1, links late: attached, never paid
const AD = U(8);  // admin: the watchdog's DM recipient
const N = U(9), O = U(10), Q = U(11), V = U(12), W = U(13), E = U(14); // single-purpose late linkers (K/J/R)
const TG: Record<string, number> = {
  [L]: 2001, [P]: 2002, [K]: 2003, [R]: 2004, [M]: 2005, [Z]: 2006, [T]: 2007, [AD]: 1011,
  [N]: 2009, [O]: 2010, [Q]: 2011, [V]: 2012, [W]: 2013, [E]: 2014,
};
const STRANGER = 9001;      // a group member with no profile at all
const FWD_SOURCE = 9002;    // someone else's post that L forwards
const ALL_USERS = [L, P, K, R, M, Z, T, AD, N, O, Q, V, W, E];
// Profiles the bot resolves at insert time (telegram_id set, or an unclaimed telegram_username for R).
const LATE = new Set([L, T, N, O, Q, V, W, E]);

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
  archived_at timestamptz, updated_at timestamptz not null default now());
create table public.webhook_inbox (id bigserial primary key, received_at timestamptz not null default now(), update_type text,
  chat_id bigint, message_id bigint, raw_update jsonb not null);
create table public.group_message_events (id uuid primary key default gen_random_uuid(), group_id uuid not null, profile_id uuid,
  telegram_user_id bigint not null, telegram_chat_id bigint not null, telegram_message_id bigint not null,
  telegram_thread_id bigint, sent_at timestamptz not null default now(), created_at timestamptz not null default now(),
  reply_to_message_id bigint, reply_to_user_id bigint, mentions_teacher boolean not null default false,
  has_ustoz boolean not null default false, is_anon_admin boolean not null default false,
  unique (telegram_chat_id, telegram_message_id));
create index idx_gme_profile_sent on public.group_message_events (profile_id, sent_at desc);
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

CREATE OR REPLACE FUNCTION public.group_telegram_chat_id(_group_id uuid)
 RETURNS bigint
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select coalesce(
    (select ('-100' || m[1])::bigint
       from public.groups g,
            regexp_match(g.homework_topic_url, '^https?://t\\.me/c/(\\d+)(/|$)') m
      where g.id = _group_id),
    (select e.telegram_chat_id
       from public.group_message_events e
      where e.group_id = _group_id
      order by e.sent_at desc
      limit 1));
$function$;

revoke execute on function public.challenge_config() from public;
grant execute on function public.challenge_config() to service_role;
revoke execute on function public.challenge_active(timestamptz) from public;
grant execute on function public.challenge_active(timestamptz) to service_role;
revoke execute on function public.challenge_scope_group_ids() from public;
grant execute on function public.challenge_scope_group_ids() to service_role;
revoke execute on function public.group_telegram_chat_id(uuid) from public;
grant execute on function public.group_telegram_chat_id(uuid) to service_role;

-- LIVE admin_void_challenge_points (md5-pinned in section A): deletes the student's ch_* / challenge_* xp_events and
-- writes the 'challenge_points_voided' tombstone that every challenge engine must respect.
CREATE OR REPLACE FUNCTION public.admin_void_challenge_points(_student uuid, _reason text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare _n int := 0;
begin
  if not (public.has_role(auth.uid(), 'admin'::app_role)
          or public.has_role(auth.uid(), 'superadmin'::app_role)) then
    raise exception 'forbidden';
  end if;

  delete from xp_events
  where user_id = _student
    and (starts_with(ref_key, 'ch_') or reason like 'challenge\\_%');
  get diagnostics _n = row_count;

  insert into user_xp (user_id, total_xp, level, updated_at)
  select _student, coalesce(sum(amount), 0)::int,
         public.xp_level_for(coalesce(sum(amount), 0)::int), now()
  from xp_events where user_id = _student
  on conflict (user_id) do update
    set total_xp = excluded.total_xp, level = excluded.level, updated_at = now();

  begin
    insert into public.admin_actions (actor_user_id, action, target_user_id, details)
    values (auth.uid(), 'challenge_points_voided', _student,
            jsonb_build_object('removed', _n, 'reason', _reason, 'at', now()));
  exception when others then null; end;

  return _n;
end;
$function$;
create index idx_admin_actions_challenge_void on public.admin_actions (target_user_id, created_at desc)
  where action = 'challenge_points_voided';

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
create trigger trg_profiles_updated before update on public.profiles for each row execute function update_updated_at_column();

insert into auth.users select unnest(array['${ALL_USERS.join("','")}'])::uuid;
insert into public.groups (id, name, course_id, homework_topic_url) values
  ('${G1}', 'AC CHALLENGE | 1-GURUH', '${C6}', 'https://t.me/c/4440955972/3'),
  ('${G2}', 'AC CHALLENGE | 2-GURUH', '${C6}', 'https://t.me/c/4390902020/6'),
  ('${G3}', 'AC CHALLENGE | 3-GURUH', '${C6}', 'https://t.me/c/3714608284/5'),
  ('${G4}', 'AC CHALLENGE | 4-GURUH', '${C6}', 'https://t.me/c/4463424516/7'),
  ('${G5}', '5.0 | A', '${C5}', 'https://t.me/c/555/9');
insert into public.user_roles (user_id, role) values ('${T}', 'teacher'), ('${AD}', 'admin');
insert into public.platform_settings (key, value) values
  ('challenge', '{"caps": {"ig_post_per_day": 2, "group_media_per_day": 3}, "points": {"ig_post": 30, "question": 2, "group_media": 5}, "window": {"end": null, "start": "2099-01-01T00:00:00+05:00"}, "enabled": true, "group_ids": [], "course_ids": ["${C6}"]}'),
  ('community_xp', '{"help": 3, "question": 2, "daily_cap": 10}'),
  ('telegram', '{"bot_token": "123:TESTTOKEN", "bot_username": "x"}');
`;

/** A Tashkent wall-clock moment `daysAgo` days before today, as a SQL timestamptz expression. */
const at = (daysAgo: number, hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return `((date_trunc('day', now() at time zone 'Asia/Tashkent') - interval '${daysAgo} days' + interval '${h} hours ${m} minutes') at time zone 'Asia/Tashkent')`;
};
const ago = (minutes: number) => `(now() - interval '${minutes} minutes')`;

interface Msg {
  id: number; tg: number; group: string; chat?: number; thread?: number | null; text?: string; photo?: boolean;
  voice?: number; album?: string; replyTo?: number; fwdFrom?: number; anon?: boolean; sent: string;
}

Deno.test({
  name: CAN_RUN
    ? "retro_credit_check: 20260930155020 on PGlite (live engine bodies; late link == linked from the start)"
    : "retro_credit_check: SKIPPED -- needs `deno test -A --node-modules-dir=none` (PGlite reads its own files)",
  ignore: !CAN_RUN,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: run,
});

async function run() {
  const spec = "npm:@electric-sql/pglite@0.5.8"; // non-literal: never resolved or type-checked unless this runs
  // deno-lint-ignore no-explicit-any
  const { PGlite } = (await import(spec)) as any;

  const MIG = lf(await Deno.readTextFile(Deno.env.get("MIG_PATH") ?? here("../../../migrations/20260930155020_challenge_retro_credit_on_join.sql")));
  const MIG218 = lf(await Deno.readTextFile(here("../../../migrations/20260930100010_challenge_social_points.sql")));
  const MIG_PR1 = lf(await Deno.readTextFile(here("../../../migrations/20260930121000_challenge_daily_task_topic.sql")));
  const RCX_LIVE = lf(await Deno.readTextFile(here("./reconcile_challenge_xp.live-2026-09-30.sql")));
  const COMMUNITY_LIVE = lf(await Deno.readTextFile(here("./reconcile_community_xp.live-2026-09-30.sql")));

  let pass = 0, fail = 0;
  const ok = (name: string, cond: boolean, detail?: unknown) => {
    if (cond) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}${detail !== undefined ? "  — " + JSON.stringify(detail) : ""}`); }
  };
  const q = async (db: PG, sql: string, params: unknown[] = []): Promise<Row[]> => (await db.query(sql, params)).rows;
  const one = async (db: PG, sql: string, params: unknown[] = []): Promise<Row> => (await q(db, sql, params))[0];
  const num = async (db: PG, sql: string, params: unknown[] = []): Promise<number> => Number((await one(db, sql, params)).n);
  const tx = async (db: PG, sql: string): Promise<string | null> => {
    try { await db.exec("begin;\n" + sql + "\ncommit;"); return null; }
    catch (e) { try { await db.exec("rollback;"); } catch { /* none open */ } return String((e as Error).message); }
  };
  const errOf = async (db: PG, sql: string, params: unknown[] = []): Promise<string | null> => {
    try { await db.query(sql, params); return null; } catch (e) { return String((e as Error).message); }
  };

  /** Production's engine state: SCHEMA + live community/media reconcilers + #218 + PR-1 (+ this migration).
   *  The window is opened AFTER this migration applies (as in production, where it lands before 2026-10-01), so no
   *  heal row exists -- unless windowBeforeMine asks for exactly that (section O). */
  async function freshDb(opts: {
    mine?: boolean; windowStartDaysAgo?: number | null; windowBeforeMine?: boolean; beforeMine?: (db: PG) => Promise<void>;
  } = {}): Promise<PG> {
    const db: PG = new PGlite();
    await db.exec(SCHEMA);
    await db.exec(COMMUNITY_LIVE + ";\nrevoke execute on function public.reconcile_community_xp(timestamptz) from public;\n" +
      "grant execute on function public.reconcile_community_xp(timestamptz) to service_role;");
    await db.exec(RCX_LIVE + ";\nrevoke execute on function public.reconcile_challenge_xp(timestamptz) from public;\n" +
      "grant execute on function public.reconcile_challenge_xp(timestamptz) to service_role;");
    let e = await tx(db, MIG218);
    if (e) throw new Error("#218 did not apply: " + e);
    e = await tx(db, MIG_PR1);
    if (e) throw new Error("PR-1 did not apply: " + e);
    if (opts.windowBeforeMine && opts.windowStartDaysAgo != null) await setWindow(db, opts.windowStartDaysAgo, null);
    if (opts.beforeMine) await opts.beforeMine(db);
    if (opts.mine !== false) {
      const m = await tx(db, MIG);
      if (m) throw new Error("this migration did not apply: " + m);
    }
    if (!opts.windowBeforeMine && opts.windowStartDaysAgo != null) await setWindow(db, opts.windowStartDaysAgo, null);
    return db;
  }

  async function cfg(db: PG, patch: Row) {
    const cur = (await one(db, "select value from platform_settings where key = 'challenge'")).value as Row;
    const merge = (a: Row, b: Row): Row => {
      const out: Row = { ...a };
      for (const [k, v] of Object.entries(b)) {
        if (v && typeof v === "object" && !Array.isArray(v) && a[k] && typeof a[k] === "object" && !Array.isArray(a[k])) out[k] = merge(a[k], v);
        else out[k] = v;
      }
      return out;
    };
    await db.query("update platform_settings set value = $1::jsonb where key = 'challenge'", [JSON.stringify(merge(cur, patch))]);
  }
  /** window.start = Tashkent midnight `daysAgo` days ago; window.end = `endExpr` (SQL) or null. */
  async function setWindow(db: PG, daysAgo: number, endExpr: string | null) {
    const s = (await one(db, `select to_json(${at(daysAgo, "00:00")})#>>'{}' v`)).v;
    const e = endExpr ? (await one(db, `select to_json(${endExpr})#>>'{}' v`)).v : null;
    await cfg(db, { window: { start: s, end: e } });
  }
  async function wStart(db: PG): Promise<string> {
    return (await one(db, "select value->'window'->>'start' v from platform_settings where key = 'challenge'")).v;
  }

  /** Profiles as the bot leaves them. linkedFromStart=true: everyone already linked and in their final group. */
  async function seedProfiles(db: PG, linkedFromStart: boolean) {
    const rows: [string, string | null, number | null][] = [
      [L, G1, linkedFromStart ? TG[L] : null], [P, G1, TG[P]], [K, G1, TG[K]], [R, G1, linkedFromStart ? TG[R] : null],
      [M, linkedFromStart ? G1 : G5, TG[M]], [Z, G2, TG[Z]], [T, G1, linkedFromStart ? TG[T] : null], [AD, null, TG[AD]],
      [N, G1, null], [O, G1, null], [Q, G1, null], [V, G1, null], [W, G1, null], [E, G1, null],
    ];
    for (const [id, g, tg] of rows) {
      await db.query("insert into profiles (id, group_id, telegram_id) values ($1, $2, $3)", [id, g, tg]);
    }
  }
  /** Who the bot stamps on a row at insert time: telegram_id first, then an unclaimed telegram_username (R). */
  const stampOf = (tg: number, linkedFromStart: boolean): string | null => {
    const id = Object.keys(TG).find((k) => TG[k] === tg);
    if (!id) return null;
    if (!linkedFromStart && LATE.has(id)) return null;
    return id;
  };

  async function post(db: PG, m: Msg, stamp: string | null) {
    const chat = m.chat ?? CHAT_OF[m.group];
    const thread = m.thread === undefined ? GENERAL : m.thread;
    const raw: Row = { message_id: m.id, from: { id: m.tg, is_bot: false, first_name: "Real Name" }, chat: { id: chat } };
    if (thread !== null) { raw.message_thread_id = thread; raw.is_topic_message = true; }
    if (m.text !== undefined) raw.text = m.text;
    if (m.photo) raw.photo = [{ file_id: "p" + m.id, file_unique_id: "u" + m.id }];
    if (m.voice !== undefined) raw.voice = { duration: m.voice, file_id: "v" + m.id };
    if (m.album) raw.media_group_id = m.album;
    if (m.fwdFrom) { raw.forward_origin = { type: "user", date: 1, sender_user: { id: m.fwdFrom } }; raw.forward_date = 1; }
    if (m.anon) { raw.sender_chat = { id: chat, type: "supergroup" }; }
    let replyMsg: number | null = null, replyUser: number | null = null;
    if (m.replyTo !== undefined) {
      const r = await q(db, "select w.raw_update->'message' m from webhook_inbox w where w.chat_id = $1 and w.message_id = $2", [chat, m.replyTo]);
      raw.reply_to_message = r[0]?.m ?? { message_id: m.replyTo };
      replyMsg = m.replyTo;
      replyUser = r[0]?.m?.from?.id ?? null;
    }
    await db.query(
      `insert into webhook_inbox (received_at, update_type, chat_id, message_id, raw_update)
       values (${m.sent} + interval '1 second', 'message', $1, $2,
               jsonb_set($3::jsonb, '{message,date}', to_jsonb(extract(epoch from ${m.sent})::bigint)))`,
      [chat, m.id, JSON.stringify({ message: raw })]);
    await db.query(
      `insert into group_message_events (group_id, profile_id, telegram_user_id, telegram_chat_id, telegram_message_id,
         telegram_thread_id, sent_at, reply_to_message_id, reply_to_user_id, is_anon_admin)
       values ($1, $2, $3, $4, $5, $6, ${m.sent}, $7, $8, $9)`,
      [m.group, stamp, m.tg, chat, m.id, thread, replyMsg, replyUser, !!m.anon]);
  }

  // ── The traffic of sections C/D: two historic days inside the window, one before it ──
  const DAY_A = 4, DAY_B = 3, PRE = 6;
  const text = (i: number) => `Bugun darsda juda ko'p narsa o'rgandim, rahmat ${i}`;
  const TRAFFIC: Msg[] = [
    // L, day A: 8 qualifying texts (chat cap 5), a same-day repeat, a too-short text, 5 photos (media cap 3),
    // a homework-topic photo, a daily-topic photo, a forward of someone else's photo
    ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({ id: 101 + i, tg: TG[L], group: G1, text: text(i), sent: at(DAY_A, `10:0${i}`) })),
    { id: 109, tg: TG[L], group: G1, text: text(0), sent: at(DAY_A, "10:08") },
    { id: 110, tg: TG[L], group: G1, text: "ok", sent: at(DAY_A, "10:09") },
    ...[0, 1, 2, 3, 4].map((i) => ({ id: 111 + i, tg: TG[L], group: G1, photo: true, sent: at(DAY_A, `11:0${i}`) })),
    { id: 118, tg: TG[L], group: G1, thread: HW1, photo: true, sent: at(DAY_A, "11:10") },
    { id: 119, tg: TG[L], group: G1, thread: DAILY1, photo: true, sent: at(DAY_A, "11:11") },
    { id: 120, tg: TG[L], group: G1, photo: true, fwdFrom: FWD_SOURCE, sent: at(DAY_A, "11:12") },
    // Q&A in both directions: L answers P's question; K answers L's question
    { id: 131, tg: TG[P], group: G1, text: "Salom hammaga, bugungi dars juda zo'r bo'ldi", sent: at(DAY_A, "09:00") },
    { id: 132, tg: TG[P], group: G1, text: "Men ham vazifani boshladim, qiziq ekan", sent: at(DAY_A, "09:01") },
    { id: 133, tg: TG[P], group: G1, text: "Kling da video qanday uzaytiriladi?", sent: at(DAY_A, "12:00") },
    { id: 134, tg: TG[L], group: G1, replyTo: 133, text: "extend tugmasini bosing, keyin davomiylikni tanlang", sent: at(DAY_A, "12:05") },
    { id: 135, tg: TG[L], group: G1, text: "Midjourney da rasmni qanday kattalashtirsa bo'ladi?", sent: at(DAY_A, "13:00") },
    { id: 136, tg: TG[K], group: G1, replyTo: 135, text: "upscale tugmasini bosing va kerakli variantni tanlang", sent: at(DAY_A, "13:10") },
    // isolation: a stranger, L in another group's chat, L in a 5.0 chat, an anonymous-admin row with L's id,
    // and a row in G1's chat that the bot resolved to another group
    { id: 141, tg: STRANGER, group: G1, text: "Men ham shu guruhdaman, salom hammaga", sent: at(DAY_A, "14:00") },
    { id: 142, tg: STRANGER, group: G1, photo: true, sent: at(DAY_A, "14:01") },
    { id: 151, tg: TG[L], group: G2, text: "Bu boshqa guruh chatidagi xabarim edi", sent: at(DAY_A, "15:00") },
    { id: 152, tg: TG[L], group: G2, photo: true, sent: at(DAY_A, "15:01") },
    { id: 153, tg: TG[L], group: G5, text: "Bu esa besh nol guruhidagi xabarim", sent: at(DAY_A, "15:02") },
    { id: 154, tg: TG[L], group: G1, anon: true, text: "Anonim admin nomidan yozilgan xabar", sent: at(DAY_A, "15:03") },
    { id: 155, tg: TG[L], group: G5, chat: CH1, text: "Chat bir xil, lekin guruh boshqa", sent: at(DAY_A, "15:04") },
    // R (username-stamped), M (5.0 student posting in G1's chat), T (staff)
    { id: 181, tg: TG[R], group: G1, text: "Men ham vazifani bajardim, ko'rib chiqing", sent: at(DAY_A, "16:00") },
    { id: 182, tg: TG[R], group: G1, photo: true, sent: at(DAY_A, "16:01") },
    { id: 191, tg: TG[M], group: G1, text: "Salom, men ham shu yerda ishlayapman", sent: at(DAY_A, "16:10") },
    { id: 192, tg: TG[M], group: G1, photo: true, sent: at(DAY_A, "16:11") },
    { id: 195, tg: TG[T], group: G1, text: "Bugungi vazifa bo'yicha savollar bormi?", sent: at(DAY_A, "16:20") },
    // day B: under the caps
    { id: 161, tg: TG[L], group: G1, text: "Ikkinchi kun ham faol qatnashyapman", sent: at(DAY_B, "10:00") },
    { id: 162, tg: TG[L], group: G1, text: "Yangi video tayyorladim, fikr bildiring", sent: at(DAY_B, "10:01") },
    { id: 163, tg: TG[L], group: G1, voice: 7, sent: at(DAY_B, "10:02") },
    { id: 164, tg: TG[L], group: G1, photo: true, album: "LA1", sent: at(DAY_B, "11:00") },
    { id: 165, tg: TG[L], group: G1, photo: true, album: "LA1", sent: at(DAY_B, "11:00") },
    { id: 166, tg: TG[L], group: G1, photo: true, sent: at(DAY_B, "11:05") },
    { id: 183, tg: TG[R], group: G1, text: "Ikkinchi kun vazifasini ham yubordim", sent: at(DAY_B, "12:00") },
    // before the window
    { id: 171, tg: TG[L], group: G1, text: "Challenge boshlanishidan oldingi xabar", sent: at(PRE, "10:00") },
    { id: 172, tg: TG[L], group: G1, photo: true, sent: at(PRE, "10:01") },
  ];
  const NEVER_ATTACHED = [141, 142, 151, 152, 153, 154, 155, 171, 172];

  const GOODV = {
    reason: "Genuine how-to question answered directly.", question_is_genuine_request: true, question_kind: "learning",
    answer_type: "direct", answer_addresses_question: true, answer_repeats_earlier_reply: false, manipulation_attempt: false, confidence: 0.9,
  };
  async function judgeAll(db: PG) {
    const claim = (await one(db, "select challenge_qa_claim(50, array['openai']) c")).c as Row;
    for (const r of (claim.rows ?? []) as Row[]) {
      await q(db, "select challenge_qa_record($1, $2::uuid, $3::jsonb, $4::jsonb)", [r.id, r.token,
        JSON.stringify({ ok: true, verdict: GOODV, provider: "openai", model: "gpt-5-mini", prompt_version: "qa-v1" }),
        JSON.stringify([{ provider: "openai", model: "gpt-5-mini", ok: true, error_kind: null, http_status: 200, latency_ms: 900, tokens_in: 1000, tokens_out: 100, cost_usd: 0.00045 }])]);
    }
  }
  /** Everything the live stack would have done by now: both engines over the whole window, the judge, apply. */
  async function engines(db: PG) {
    const from = `(${JSON.stringify(await wStart(db)).replace(/"/g, "'")}::timestamptz - interval '5 minutes')`;
    await q(db, `select * from reconcile_challenge_xp(${from})`);
    await q(db, `select * from reconcile_challenge_social_xp(${from})`);
    await judgeAll(db);
    await q(db, "select challenge_qa_apply()");
  }
  const xpSnap = async (db: PG) => (await q(db, `select user_id::text u, reason, ref_key, amount,
       to_char(created_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') c
     from xp_events order by 1, 3`)).map((r) => `${r.u}|${r.reason}|${r.ref_key}|${r.amount}|${r.c}`);
  const candSnap = async (db: PG) => (await q(db, `select chat_id, answer_msg_id, question_msg_id, answerer_id::text a, asker_id::text k,
       day::text d, status, award_status, skip_reason from challenge_qa_candidates where not shadow_only order by answer_msg_id`))
    .map((r) => JSON.stringify(r));
  const drift = (db: PG) => num(db, `select count(*)::int n from user_xp x
      where x.total_xp <> coalesce((select sum(amount) from xp_events e where e.user_id = x.user_id), 0)`);
  const sweep = async (db: PG) => (await one(db, "select challenge_retro_credit_run() r")).r as Row;
  const ledger = async (db: PG) => await q(db, "select * from challenge_retro_credits order by id");
  const stampOfRow = async (db: PG, msg: number) =>
    (await one(db, "select profile_id::text p from group_message_events where telegram_message_id = $1", [msg])).p as string | null;
  const dayOf = (daysAgo: number) => `((date_trunc('day', now() at time zone 'Asia/Tashkent') - interval '${daysAgo} days')::date)`;
  const perDay = (db: PG, user: string, reason: string, agg: "sum" | "count") => num(db,
    `select coalesce(${agg === "sum" ? "sum(amount)" : "count(*)"}, 0)::int n from xp_events where user_id = $1 and reason = $2`, [user, reason]);
  const dayTotal = (db: PG, user: string, reason: string, daysAgo: number) => num(db,
    `select coalesce(sum(amount), 0)::int n from xp_events where user_id = $1 and reason = $2
      and (created_at at time zone 'Asia/Tashkent')::date = ${dayOf(daysAgo)}`, [user, reason]);
  const byReason = async (db: PG, user: string) => Object.fromEntries((await q(db,
    `select reason, sum(amount)::int s from xp_events where user_id = $1 group by 1 order by 1`, [user])).map((r) => [r.reason, r.s]));
  /** One student's xp_events, byte for byte (the "must stay identical" oracle of V/KS/CF/QO). */
  const xpOf = async (db: PG, user: string) => (await xpSnap(db)).filter((s) => s.startsWith(user));
  /** admin_void_challenge_points as the admin AD (it checks has_role(auth.uid())). */
  async function voidAs(db: PG, user: string): Promise<number> {
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [AD]);
    const n = Number((await one(db, "select admin_void_challenge_points($1, 'farm') n", [user])).n);
    await db.query("select set_config('request.jwt.claim.sub', '', false)");
    return n;
  }
  const candCount = (db: PG) => num(db, "select count(*)::int n from challenge_qa_candidates where not shadow_only");

  // ───────────── A. fidelity: every engine body this migration calls = production ─────────────
  console.log("A. the engines under test are production's (md5 of every body the migration calls)");
  {
    const db = await freshDb({ mine: false });
    const rows = await q(db, `select p.oid::regprocedure::text sig, md5(replace(p.prosrc, E'\\r', '')) b
                                from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'`);
    const got = Object.fromEntries(rows.map((r) => [r.sig, r.b]));
    for (const [sig, want] of Object.entries(PROD_BODY_MD5)) ok(`${sig.split("(")[0]} body md5 = production`, got[sig] === want, got[sig]);
    await db.close();
  }

  // ───────────── M. the migration itself ─────────────
  console.log("M. migration: applies (self-test), config seed, ACLs, trigger, index, cron, audit, replay");
  {
    const db = await freshDb({ mine: false });
    const err = await tx(db, MIG);
    ok("applies, including its self-test", err === null, err);
    const c = (await one(db, "select value->'retro_credit' v from platform_settings where key = 'challenge'")).v;
    ok("config seeded: retro_credit {enabled: true, max_attempts: 6}", c?.enabled === true && c?.max_attempts === 6, c);
    const rc = (await one(db, "select challenge_retro_config() c")).c;
    ok("challenge_retro_config parses clean", rc.enabled === true && rc.invalid.length === 0 && rc.win_bad === false, rc);
    const acl = await q(db, `select p.proname, p.prosecdef s, coalesce(array_to_string(p.proacl, ','), '') a from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'challenge\\_retro\\_%' order by 1`);
    ok("6 new functions, all SECURITY DEFINER", acl.length === 6 && acl.every((r) => r.s), acl.map((r) => r.proname));
    ok("none reachable by PUBLIC, anon or authenticated", acl.every((r) => r.a && !/(^|,)=/.test(r.a) && !/anon=|authenticated=/.test(r.a)),
      Object.fromEntries(acl.map((r) => [r.proname, r.a])));
    ok("callable by service_role (except the trigger function)",
      acl.every((r) => /service_role=X/.test(r.a) === (r.proname !== "challenge_retro_on_profile_link")), acl.map((r) => [r.proname, r.a]));
    const t = await one(db, `select coalesce(array_to_string(relacl, ','), '') a, relrowsecurity rls from pg_class where oid = 'public.challenge_retro_credits'::regclass`);
    ok("ledger: RLS on, no PUBLIC/anon/authenticated grant", t.rls && !/(^|,)=|anon=|authenticated=/.test(t.a), t);
    const trg = await one(db, `select pg_get_triggerdef(oid) d, tgenabled e from pg_trigger where tgname = 'trg_profiles_challenge_retro_credit'`);
    ok("trigger: AFTER INSERT OR UPDATE OF telegram_id, group_id, WHEN both not null, enabled",
      /AFTER INSERT OR UPDATE OF telegram_id, group_id ON public\.profiles/.test(trg?.d ?? "") && /telegram_id IS NOT NULL/.test(trg.d)
      && /group_id IS NOT NULL/.test(trg.d) && trg.e === "O", trg);
    const eng = await q(db, `select p.oid::regprocedure::text sig, md5(replace(p.prosrc, E'\\r', '')) b, p.prosecdef s,
         coalesce(array_to_string(p.proacl, ','), '') a, p.pronargdefaults d, p.proowner::regrole::text o,
         array_to_string(p.proconfig, ',') c
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname in ('reconcile_challenge_xp', 'reconcile_challenge_social_xp', 'challenge_qa_enqueue_range')`);
    ok("engines: exactly the three new signatures (the old ones dropped), bodies = the pinned rewrites",
      eng.length === 3 && eng.every((e) => NEW_BODY_MD5[e.sig] === e.b), eng.map((e) => [e.sig, e.b]));
    ok("engines: SECURITY DEFINER, owner and search_path as live, service_role only (no PUBLIC / anon / authenticated)",
      eng.every((e) => e.s && e.o === "postgres" && e.c === "search_path=public" && /service_role=X/.test(e.a)
        && !/(^|,)=/.test(e.a) && !/anon=|authenticated=/.test(e.a)), eng.map((e) => [e.sig, e.a, e.o, e.c]));
    ok("engines: every new parameter is defaulted (cron's zero-argument calls resolve unchanged)",
      eng.every((e) => e.d === (e.sig.startsWith("challenge_qa_enqueue_range") ? 1 : 2)), eng.map((e) => [e.sig, e.d]));
    const calls = [
      await errOf(db, "select * from reconcile_challenge_xp()"),
      await errOf(db, "select * from reconcile_challenge_social_xp()"),
      await errOf(db, `select challenge_qa_enqueue_sample('${C5}', now() - interval '1 day', 5)`),   // its 10-argument call
    ];
    ok("the cron commands and challenge_qa_enqueue_sample's positional 10-argument call still resolve", calls.every((c) => c === null), calls);
    ok("partial index on unlinked rows", /WHERE \(profile_id IS NULL\)/.test((await one(db,
      "select indexdef d from pg_indexes where indexname = 'idx_gme_unlinked_sender'"))?.d ?? ""));
    const jobs = await q(db, "select jobname, schedule, command from cron.job where jobname like 'challenge-retro%' order by 1");
    ok("cron: sweep at 8-59/10, watchdog at :57", JSON.stringify(jobs.map((j) => [j.jobname, j.schedule])) ===
      JSON.stringify([["challenge-retro-credit", "8-59/10 * * * *"], ["challenge-retro-credit-watchdog", "57 * * * *"]]), jobs);
    const audit = await q(db, "select details from admin_actions where action = 'challenge_retro_credit_applied'");
    ok("audit once; window not open at apply -> no heal row", audit.length === 1 && audit[0].details.heal_enqueued === false
      && (await num(db, "select count(*)::int n from challenge_retro_credits")) === 0, audit);
    ok("the audit maps every scope group to its chat", Object.keys(audit[0]?.details?.scope_group_chats ?? {}).length === 4
      && audit[0].details.scope_group_chats[G1] === CH1, audit[0]?.details?.scope_group_chats);
    // replay with an admin's hand-set values in place: nothing is overwritten, nothing duplicated
    await cfg(db, { retro_credit: { enabled: false, max_attempts: 9 } });
    const err2 = await tx(db, MIG);
    ok("replay applies (with the feature switched off by an admin)", err2 === null, err2);
    const c2 = (await one(db, "select value->'retro_credit' v from platform_settings where key = 'challenge'")).v;
    ok("replay: existing config values win", c2?.enabled === false && c2?.max_attempts === 9, c2);
    ok("replay: one audit row, two cron jobs, one trigger",
      (await num(db, "select count(*)::int n from admin_actions where action = 'challenge_retro_credit_applied'")) === 1
      && (await num(db, "select count(*)::int n from cron.job where jobname like 'challenge-retro%'")) === 2
      && (await num(db, "select count(*)::int n from pg_trigger where tgname = 'trg_profiles_challenge_retro_credit'")) === 1);
    // a malformed key fails CLOSED and is listed
    await cfg(db, { retro_credit: { enabled: "yes" } });
    const bad = (await one(db, "select challenge_retro_config() c")).c;
    ok("malformed retro_credit.enabled -> OFF and listed as invalid", bad.enabled === false && bad.invalid.includes("retro_credit.enabled"), bad);
    await db.close();
  }

  // ───────────── C. late link == linked from the start ─────────────
  console.log("C. ground truth: the same traffic, everyone linked from the start vs. linked late");
  const gt = await freshDb({ windowStartDaysAgo: 5 });
  await cfg(gt, { qa: { mode: "live" } });
  await seedProfiles(gt, true);
  for (const m of TRAFFIC) await post(gt, m, stampOf(m.tg, true));
  await engines(gt);
  const GT_XP = await xpSnap(gt);
  const GT_CAND = await candSnap(gt);
  ok("ground truth pays something for every actor who should earn",
    [L, P, K, R, M].every((u) => GT_XP.some((s) => s.startsWith(u))) && !GT_XP.some((s) => s.startsWith(T)), GT_XP.length);

  const db = await freshDb({ windowStartDaysAgo: 5 });
  await cfg(db, { qa: { mode: "live" } });
  await seedProfiles(db, false);
  for (const m of TRAFFIC) await post(db, m, stampOf(m.tg, false));
  await engines(db); // the live stack's whole history while L / T were unlinked, R unverified and M in 5.0
  {
    const before = await xpSnap(db);
    ok("before linking: L, T get nothing; R's chat and M's points are missing",
      !before.some((s) => s.startsWith(L)) && !before.some((s) => s.startsWith(R) && s.includes("challenge_chat"))
      && !before.some((s) => s.startsWith(M)) && before.length < GT_XP.length, before.length);
    ok("before linking: no answer candidate involves L (neither direction)", (await candSnap(db)).length === 0);
    const lastXp = await one(db, "select id from admin_actions where action = 'challenge_xp_reconciled' order by created_at desc limit 1");
    const lastSo = await one(db, "select id from admin_actions where action = 'challenge_social_reconciled' order by created_at desc limit 1");

    // the four link events, exactly as the bot / intake / admin would write them
    await db.query("update profiles set telegram_id = $1 where id = $2", [TG[L], L]);
    await db.query("update profiles set telegram_id = $1 where id = $2", [TG[R], R]);
    await db.query("update profiles set group_id = $1 where id = $2", [G1, M]);
    await db.query("update profiles set telegram_id = $1 where id = $2", [TG[T], T]);
    const led = await ledger(db);
    const lRow = led.find((r) => r.profile_id === L), rRow = led.find((r) => r.profile_id === R);
    const mRow = led.find((r) => r.profile_id === M), tRow = led.find((r) => r.profile_id === T);
    const lInWindow = TRAFFIC.filter((m) => m.tg === TG[L] && !NEVER_ATTACHED.includes(m.id)).length;
    ok(`link trigger: L attached = ${lInWindow} (every in-window G1-chat row, nothing else), pending`,
      lRow?.source === "link_trigger" && lRow.attached === lInWindow && lRow.relinked === 0 && lRow.status === "pending", lRow);
    ok("link trigger: R's username-stamped rows recorded as relinked (3), nothing attached",
      rRow?.attached === 0 && rRow?.relinked === 3 && rRow.status === "pending", rRow);
    ok("group move: M's rows in the new group's chat recorded as relinked (2)", mRow?.attached === 0 && mRow?.relinked === 2, mRow);
    ok("staff T: its row is attached (identity), pending", tRow?.attached === 1, tRow);
    ok("scan_from = the earliest ARRIVAL of the affected rows", String(lRow?.scan_from) === String((await one(db,
      "select min(w.received_at) t from webhook_inbox w join group_message_events g on g.telegram_chat_id = w.chat_id and g.telegram_message_id = w.message_id where g.profile_id = $1 and g.sent_at >= $2::timestamptz",
      [L, await wStart(db)])).t), [lRow?.scan_from]);
    for (const id of NEVER_ATTACHED) {
      ok(`isolation: message ${id} stays unattached`, (await stampOfRow(db, id)) === null);
    }
    ok("a no-op UPDATE OF telegram_id (same value) records nothing",
      await (async () => { await db.query("update profiles set telegram_id = telegram_id where id = $1", [L]); return (await ledger(db)).length === led.length; })());

    const r = await sweep(db);
    ok("sweep: credited, one pass over the four pending rows", r.status === "credited" && r.batch === 4 && r.error === null, r);
    ok("sweep: SCOPED to the batch's 4 students; nothing paid outside the batch",
      r.scope === "profiles" && r.scoped_profiles === 4 && r.paid_outside_batch === 0, r);
    await judgeAll(db);
    await q(db, "select challenge_qa_apply()");
    const after = await xpSnap(db);
    ok("late link == linked from the start: identical xp_events (user, reason, ref_key, amount, created_at)",
      JSON.stringify(after) === JSON.stringify(GT_XP), { missing: GT_XP.filter((s) => !after.includes(s)), extra: after.filter((s) => !GT_XP.includes(s)) });
    const cands = await candSnap(db);
    ok("identical answer candidates, both directions (L answering P, K answering L), both paid",
      JSON.stringify(cands) === JSON.stringify(GT_CAND) && cands.length === 2 && cands.every((c) => JSON.parse(c).award_status === "awarded"), { cands, GT_CAND });
    ok("caps per HISTORIC day: L chat day A = 5 (of 8 + a repeat), day B = 3",
      (await dayTotal(db, L, "challenge_chat", DAY_A)) === 5 && (await dayTotal(db, L, "challenge_chat", DAY_B)) === 3);
    ok("caps per HISTORIC day: L media day A = 3 shares (of 5), day B = album once + photo",
      (await dayTotal(db, L, "challenge_group_media", DAY_A)) === 15 && (await dayTotal(db, L, "challenge_group_media", DAY_B)) === 10);
    ok("awards carry the message's own time (created_at = sent_at)", (await num(db,
      `select count(*)::int n from xp_events x join group_message_events g on x.ref_key = 'ch_chat:' || g.telegram_chat_id || ':' || g.telegram_message_id
        where x.user_id = $1 and x.created_at <> g.sent_at`, [L])) === 0);
    ok("the homework-topic, daily-topic and forwarded photos pay nothing",
      (await num(db, `select count(*)::int n from xp_events where ref_key in ('ch_img:${CH1}:118', 'ch_img:${CH1}:119', 'ch_img:${CH1}:120')`)) === 0);
    ok("isolation: no award for any unattached message, nothing for the stranger", (await num(db,
      `select count(*)::int n from xp_events where ${NEVER_ATTACHED.map((i) => `ref_key like '%:${i}'`).join(" or ")}`)) === 0);
    ok("staff T is attached but never paid", (await stampOfRow(db, 195)) === T
      && (await num(db, "select count(*)::int n from xp_events where user_id = $1", [T])) === 0);
    ok("ledger: all four credited, with the engine results", (await ledger(db)).every((x) => x.status === "credited" && x.attempts === 1
      && x.result?.media_awarded >= 0), await ledger(db));
    const scopedHb = await q(db, `select action, details from admin_actions
       where action in ('challenge_xp_reconciled_scoped', 'challenge_social_reconciled_scoped') order by action`);
    ok("a scoped pass writes the engines' OWN '_scoped' heartbeats (4 students), relabels nothing, and the live ticks' "
      + "last heartbeats (the media lookback base and the social cursor) are unchanged",
      (await one(db, "select id from admin_actions where action = 'challenge_xp_reconciled' order by created_at desc limit 1")).id === lastXp.id
      && (await one(db, "select id from admin_actions where action = 'challenge_social_reconciled' order by created_at desc limit 1")).id === lastSo.id
      && scopedHb.length === 2 && scopedHb.every((h) => h.details.scoped_profiles === 4)
      && (await num(db, "select count(*)::int n from admin_actions where action = 'challenge_retro_engine_heartbeat'")) === 0, scopedHb);
    ok("user_xp drift 0", (await drift(db)) === 0);
    await q(db, `select * from reconcile_community_xp(now() - interval '10 days')`);
    ok("community engine: nothing in scope groups inside the window (owned by the challenge)", (await num(db,
      "select count(*)::int n from xp_events where reason like 'community%'")) === 0);
  }

  // ───────────── D. idempotency ─────────────
  console.log("D. idempotency: sweeps, explicit engines and live ticks again change nothing");
  {
    const snap = await xpSnap(db);
    const r1 = await sweep(db), r2 = await sweep(db), r3 = await sweep(db);
    ok("repeated sweeps are idle", [r1, r2, r3].every((r) => r.status === "idle"), [r1.status, r2.status, r3.status]);
    await engines(db);
    await q(db, "select * from reconcile_challenge_xp()");
    await q(db, "select * from reconcile_challenge_social_xp()");
    ok("no new award from any engine path", JSON.stringify(await xpSnap(db)) === JSON.stringify(snap));
    const e1 = await errOf(db, `select * from reconcile_challenge_xp(null, array['${L}']::uuid[])`);
    const e2 = await errOf(db, `select * from reconcile_challenge_social_xp(null, array['${L}']::uuid[])`);
    ok("a scoped engine run with no explicit start is refused (it would otherwise compute the cron lookback / cursor)",
      /needs an explicit _since/.test(e1 ?? "") && /needs an explicit _from/.test(e2 ?? ""), [e1, e2]);
    ok("no new ledger row", (await ledger(db)).length === 4);
    ok("drift 0", (await drift(db)) === 0);
    const h = (await one(db, "select challenge_retro_credit_health() h")).h;
    ok("health: 0 pending, 0 unattached, 4 credited, trigger + cron present", h.queue.pending === 0 && h.unattached.rows === 0
      && h.queue.credited_7d === 4 && h.trigger_enabled === true && h.cron_active === true, h);
    const w = (await one(db, "select challenge_retro_credit_watchdog() w")).w;
    ok("watchdog: ok, no DM", w.state === "ok" && w.dm_sent === 0, w.alarms);
  }
  await db.close();
  await gt.close();

  // ───────────── E. interleaved live ticks: no double pay, caps hold ─────────────
  console.log("E. link -> live ticks pay the recent posts -> the sweep pays the rest");
  {
    const LIVE_TRAFFIC: Msg[] = [
      ...[0, 1, 2].map((i) => ({ id: 201 + i, tg: TG[L], group: G1, photo: true, sent: ago(180 - i) })),
      { id: 204, tg: TG[L], group: G1, photo: true, sent: ago(10) },
      ...[0, 1, 2, 3].map((i) => ({ id: 211 + i, tg: TG[L], group: G1, text: text(20 + i), sent: ago(175 - i) })),
      ...[0, 1, 2].map((i) => ({ id: 215 + i, tg: TG[L], group: G1, text: text(30 + i), sent: ago(10 - i) })),
    ];
    const ref = await freshDb({ windowStartDaysAgo: 5 });
    await seedProfiles(ref, true);
    for (const m of LIVE_TRAFFIC) await post(ref, m, stampOf(m.tg, true));
    await engines(ref);

    const e = await freshDb({ windowStartDaysAgo: 5 });
    await seedProfiles(e, false);
    // bring the social cursor to "now", as the 10-minute cron has
    for (let i = 0; i < 8; i++) await q(e, "select * from reconcile_challenge_social_xp()");
    await q(e, "select * from reconcile_challenge_xp()");
    for (const m of LIVE_TRAFFIC) await post(e, m, stampOf(m.tg, false));
    await q(e, "select * from reconcile_challenge_xp()");
    await q(e, "select * from reconcile_challenge_social_xp()");
    ok("unlinked: the live ticks pay L nothing", (await num(e, "select count(*)::int n from xp_events where user_id = $1", [L])) === 0);
    await e.query("update profiles set telegram_id = $1 where id = $2", [TG[L], L]);
    await q(e, "select * from reconcile_challenge_xp()");
    await q(e, "select * from reconcile_challenge_social_xp()");
    const live = await num(e, "select count(*)::int n from xp_events where user_id = $1", [L]);
    ok("after linking, the LIVE ticks (lookback / cursor) pay the recent posts first", live > 0, live);
    const s = await sweep(e);
    ok("then the sweep credits the rest", s.status === "credited", s);
    for (let i = 0; i < 2; i++) {
      await sweep(e);
      await q(e, "select * from reconcile_challenge_xp()");
      await q(e, "select * from reconcile_challenge_social_xp()");
    }
    const days = await q(e, `select (created_at at time zone 'Asia/Tashkent')::date d, reason, sum(amount)::int s, count(*)::int n
                               from xp_events where user_id = $1 group by 1, 2 order by 1, 2`, [L]);
    const refDays = await q(ref, `select (created_at at time zone 'Asia/Tashkent')::date d, reason, sum(amount)::int s, count(*)::int n
                               from xp_events where user_id = $1 group by 1, 2 order by 1, 2`, [L]);
    ok("per day: media <= 3 shares and chat <= 5 points, whatever the order", days.every((d) =>
      (d.reason === "challenge_group_media" && d.n <= 3) || (d.reason === "challenge_chat" && d.s <= 5)), days);
    ok("per-day totals equal the linked-from-the-start run", JSON.stringify(days.map((d) => [d.d, d.reason, d.s])) ===
      JSON.stringify(refDays.map((d) => [d.d, d.reason, d.s])), { days, refDays });
    ok("drift 0", (await drift(e)) === 0);
    await e.close();
    await ref.close();
  }

  // ───────────── V. an admin void is durable against EVERY engine path ─────────────
  console.log("V. a voided student stays voided: cron ticks (the 40-min overlap), an unrelated late link, heal, back-fill");
  {
    const db = await freshDb({ windowStartDaysAgo: 5 });
    await seedProfiles(db, false);
    for (let i = 0; i < 8; i++) await q(db, "select * from reconcile_challenge_social_xp()"); // cursor at now, as cron
    await post(db, { id: 401, tg: TG[L], group: G1, text: text(1), sent: at(DAY_A, "08:00") }, null);   // L unlinked
    for (const i of [0, 1, 2]) await post(db, { id: 411 + i, tg: TG[P], group: G1, photo: true, sent: at(DAY_A, `09:1${i}`) }, P);
    for (const i of [0, 1]) await post(db, { id: 421 + i, tg: TG[P], group: G1, text: text(10 + i), sent: at(DAY_A, `09:2${i}`) }, P);
    await post(db, { id: 431, tg: TG[P], group: G1, photo: true, sent: ago(20) }, P);   // inside the cron media overlap
    await engines(db);
    await q(db, "select * from reconcile_challenge_xp()");   // a cron tick: its heartbeat is the next lookback's base
    const paid = await byReason(db, P);
    ok("V0 the live stack paid P: media 20 (3 shares on day A + 1 today), chat 2",
      paid.challenge_group_media === 20 && paid.challenge_chat === 2, paid);
    const n = await voidAs(db, P);
    ok("V1 admin_void_challenge_points removed P's 6 challenge rows", n === 6, n);
    await q(db, "select * from reconcile_challenge_xp()");
    await q(db, "select * from reconcile_challenge_social_xp()");
    ok("V2 the next cron ticks do not re-pay the photo posted inside the 40-minute media overlap",
      (await xpOf(db, P)).length === 0, await byReason(db, P));
    await db.query("update profiles set telegram_id = $1 where id = $2", [TG[L], L]);   // an unrelated late student joins the bot
    const s = await sweep(db);
    ok("V3 an unrelated late link: L credited (+1), P stays voided (media AND chat)", s.status === "credited"
      && (await perDay(db, L, "challenge_chat", "sum")) === 1 && (await xpOf(db, P)).length === 0, { s, P: await byReason(db, P) });
    await db.query(`insert into challenge_retro_credits (source, scan_from) values ('heal', $1::timestamptz - interval '5 minutes')`, [await wStart(db)]);
    const h = await sweep(db);
    ok("V4 a GLOBAL heal pass from window.start: P stays voided", h.status === "credited" && h.scope === "global"
      && (await xpOf(db, P)).length === 0, { h, P: await byReason(db, P) });
    await q(db, `select * from reconcile_challenge_xp((select value->'window'->>'start' from platform_settings where key = 'challenge')::timestamptz)`);
    ok("V5 an admin's explicit media back-fill from window.start: P stays voided", (await xpOf(db, P)).length === 0, await byReason(db, P));
    await post(db, { id: 441, tg: TG[P], group: G1, photo: true, sent: "now()" }, P);
    await q(db, "select * from reconcile_challenge_xp()");
    ok("V6 the tombstone is not a ban: P's photo posted AFTER the void pays (+5)", (await byReason(db, P)).challenge_group_media === 5,
      await byReason(db, P));
    ok("V7 drift 0", (await drift(db)) === 0);
    await db.close();
  }

  // ───────────── KS / CF / QO. a late link credits ONLY the late linker ─────────────
  console.log("KS. challenge stopped for a period; later an unrelated student links late");
  {
    const db = await freshDb({ windowStartDaysAgo: 5 });
    await seedProfiles(db, false);
    await post(db, { id: 501, tg: TG[L], group: G1, text: text(1), sent: at(DAY_A, "08:00") }, null);   // L unlinked
    await cfg(db, { enabled: false });
    for (const i of [0, 1, 2]) await post(db, { id: 511 + i, tg: TG[P], group: G1, photo: true, sent: at(DAY_B, `09:1${i}`) }, P);
    for (const i of [0, 1]) await post(db, { id: 521 + i, tg: TG[P], group: G1, text: text(10 + i), sent: at(DAY_B, `09:2${i}`) }, P);
    for (let i = 0; i < 8; i++) await q(db, "select * from reconcile_challenge_social_xp()");
    await q(db, "select * from reconcile_challenge_xp()");
    await cfg(db, { enabled: true });
    await q(db, "select * from reconcile_challenge_social_xp()");
    await q(db, "select * from reconcile_challenge_xp()");
    const before = await xpOf(db, P);
    ok("KS1 the live engines never pay P's posts made while the challenge was stopped", before.length === 0, before);
    await db.query("update profiles set telegram_id = $1 where id = $2", [TG[L], L]);
    const s = await sweep(db);
    ok("KS2 L's retro credit is scoped to L: credited, scope 'profiles', nothing paid outside the batch",
      s.status === "credited" && s.scope === "profiles" && s.scoped_profiles === 1 && s.paid_outside_batch === 0, s);
    ok("KS3 P's xp_events are unchanged (the stopped period stays unpaid)", JSON.stringify(await xpOf(db, P)) === JSON.stringify(before),
      await byReason(db, P));
    ok("KS4 L is credited (+1)", (await perDay(db, L, "challenge_chat", "sum")) === 1);
    await db.close();
  }

  console.log("CF. caps raised mid-challenge (group_media_per_day 3 -> 5); later an unrelated student links late");
  {
    const db = await freshDb({ windowStartDaysAgo: 5 });
    await seedProfiles(db, false);
    await post(db, { id: 601, tg: TG[L], group: G1, text: text(1), sent: at(DAY_A, "08:00") }, null);
    for (const i of [0, 1, 2, 3, 4]) await post(db, { id: 611 + i, tg: TG[P], group: G1, photo: true, sent: at(DAY_A, `09:1${i}`) }, P);
    await engines(db);
    ok("CF0 P's day A at the time: 3 shares (15)", (await dayTotal(db, P, "challenge_group_media", DAY_A)) === 15);
    await cfg(db, { caps: { group_media_per_day: 5 } });
    await q(db, "select * from reconcile_challenge_xp()");
    const before = await xpOf(db, P);
    await db.query("update profiles set telegram_id = $1 where id = $2", [TG[L], L]);
    const s = await sweep(db);
    ok("CF1 P's historic day is not re-scored under the new cap: xp_events byte-identical",
      s.status === "credited" && JSON.stringify(await xpOf(db, P)) === JSON.stringify(before),
      { s: s.status, day: await dayTotal(db, P, "challenge_group_media", DAY_A) });
    await db.close();
  }

  console.log("QO. qa.mode 'off' for a period; later an unrelated student links late");
  {
    const db = await freshDb({ windowStartDaysAgo: 5 });
    await cfg(db, { qa: { mode: "off" } });
    await seedProfiles(db, false);
    await post(db, { id: 701, tg: TG[L], group: G1, text: text(1), sent: at(DAY_A, "08:00") }, null);
    await post(db, { id: 711, tg: TG[K], group: G1, text: "Kling da video qanday uzaytiriladi?", sent: at(DAY_B, "12:00") }, K);
    await post(db, { id: 712, tg: TG[P], group: G1, replyTo: 711, text: "extend tugmasini bosing, keyin davomiylikni tanlang",
      sent: at(DAY_B, "12:05") }, P);
    for (let i = 0; i < 8; i++) await q(db, "select * from reconcile_challenge_social_xp()");
    await q(db, "select * from reconcile_challenge_xp()");
    await cfg(db, { qa: { mode: "live" } });
    await q(db, "select * from reconcile_challenge_social_xp()");
    ok("QO1 the live ticks never enqueue a reply made while qa.mode was 'off'", (await candCount(db)) === 0);
    const beforeP = await xpOf(db, P), beforeK = await xpOf(db, K);
    await db.query("update profiles set telegram_id = $1 where id = $2", [TG[L], L]);
    const s = await sweep(db);
    await judgeAll(db);
    await q(db, "select challenge_qa_apply()");
    ok("QO2 L's retro credit enqueues nothing between OTHER students (no judge call, no answer points)",
      s.status === "credited" && (await candCount(db)) === 0, { s: s.status, qa_enqueued: s.qa_enqueued });
    ok("QO3 P's and K's xp_events are unchanged", JSON.stringify(await xpOf(db, P)) === JSON.stringify(beforeP)
      && JSON.stringify(await xpOf(db, K)) === JSON.stringify(beforeK));
    await db.close();
  }

  // ───────────── K / J / R / U. switches, errors, detectors (one database) ─────────────
  console.log("K. kill-switches, deferral, expiry, tail");
  const k = await freshDb({ windowStartDaysAgo: 5 });
  await seedProfiles(k, false);
  {
    // K1 retro_credit off: the trigger and the sweep do nothing
    await cfg(k, { retro_credit: { enabled: false } });
    for (const i of [0, 1, 2]) await post(k, { id: 301 + i, tg: TG[N], group: G1, text: text(40 + i), sent: at(DAY_A, `10:1${i}`) }, null);
    await k.query("update profiles set telegram_id = $1 where id = $2", [TG[N], N]);
    const off = await sweep(k);
    ok("K1 retro_credit.enabled=false: no ledger row, rows unattached, sweep 'off'", off.status === "off"
      && (await ledger(k)).length === 0 && (await stampOfRow(k, 301)) === null, off);
    // K2 switched back on: the SWEEP (re-derivation) attaches what the trigger skipped, and credits it
    await cfg(k, { retro_credit: { enabled: true } });
    const on = await sweep(k);
    ok("K2 back on: the sweep attaches (source 'sweep') and credits: +3", on.status === "credited" && on.attached_rows === 3
      && (await ledger(k))[0]?.source === "sweep" && (await perDay(k, N, "challenge_chat", "sum")) === 3, on);

    // K3 challenge disabled: attach continues, credit waits without using an attempt, pays on re-enable
    await cfg(k, { enabled: false });
    for (const i of [0, 1]) await post(k, { id: 311 + i, tg: TG[O], group: G1, text: text(50 + i), sent: at(DAY_B, `10:1${i}`) }, null);
    await k.query("update profiles set telegram_id = $1 where id = $2", [TG[O], O]);
    const d1 = await sweep(k);
    const oRow = (await ledger(k)).find((r) => r.profile_id === O);
    ok("K3 challenge.enabled=false: attached, 'deferred_inactive', attempts 0", d1.status === "deferred_inactive"
      && oRow?.status === "pending" && oRow.attempts === 0 && (await stampOfRow(k, 311)) === O, d1);
    await cfg(k, { enabled: true });
    const d2 = await sweep(k);
    ok("K3 re-enabled: credited +2", d2.status === "credited" && (await perDay(k, O, "challenge_chat", "sum")) === 2, d2);

    // K4 the window ended more than 24 h ago: past the engines' tail, pending rows expire visibly
    await setWindow(k, 5, "now() - interval '30 hours'");
    await post(k, { id: 321, tg: TG[Q], group: G1, text: text(60), sent: "(now() - interval '31 hours')" }, null);
    await k.query("update profiles set telegram_id = $1 where id = $2", [TG[Q], Q]);
    const x = await sweep(k);
    ok("K4 ended > 24 h ago: 'expired', nothing paid", x.status === "expired" && x.expired === 1
      && (await ledger(k)).find((r) => r.profile_id === Q)?.status === "expired" && (await perDay(k, Q, "challenge_chat", "sum")) === 0, x);

    // K5 the W2 tail: ended 2 h ago -> still credited, bounded to posts sent at or before the end
    await setWindow(k, 5, "now() - interval '2 hours'");
    await post(k, { id: 331, tg: TG[V], group: G1, text: text(70), sent: "(now() - interval '3 hours')" }, null);
    await post(k, { id: 332, tg: TG[V], group: G1, text: text(71), sent: "(now() - interval '90 minutes')" }, null);
    await k.query("update profiles set telegram_id = $1 where id = $2", [TG[V], V]);
    const tl = await sweep(k);
    ok("K5 tail: credited +1; the post after the end is neither attached nor paid", tl.status === "credited" && tl.tail === true
      && (await perDay(k, V, "challenge_chat", "sum")) === 1 && (await stampOfRow(k, 332)) === null, tl);
    // K6 an admin re-opens the window (end removed): V's later post is now inside it -> attached by the sweep and
    // paid. 'expired' is terminal: Q's row is not revived by a pass that starts later than it.
    await setWindow(k, 5, null);
    const ro = await sweep(k);
    ok("K6 window re-opened: the sweep attaches V's later post and pays it; Q's expired row stays unpaid",
      ro.status === "credited" && ro.attached_rows === 1 && (await stampOfRow(k, 332)) === V
      && (await perDay(k, V, "challenge_chat", "sum")) === 2 && (await perDay(k, Q, "challenge_chat", "sum")) === 0, ro);
    // K7 the documented manual heals (header). A heal row WITH a profile is scoped to that student: Q's expired
    // row is paid by it, and the pass is 'profiles' with nothing outside it.
    await k.query(`insert into challenge_retro_credits (source, profile_id, scan_from) values ('heal', $1, $2::timestamptz - interval '5 minutes')`,
      [Q, await wStart(k)]);
    const sh = await sweep(k);
    ok("K7 a profile-bound heal row is SCOPED to that student: Q +1, paid_outside_batch 0", sh.status === "credited"
      && sh.scope === "profiles" && sh.scoped_profiles === 1 && sh.paid_outside_batch === 0
      && (await perDay(k, Q, "challenge_chat", "sum")) === 1, sh);
    // K8 a heal row WITHOUT a profile is the deliberate GLOBAL pass from window.start: everything is already paid
    await k.query(`insert into challenge_retro_credits (source, scan_from) values ('heal', $1::timestamptz - interval '5 minutes')`, [await wStart(k)]);
    const mh = await sweep(k);
    ok("K8 a global heal row: credited, scope 'global'; nobody paid twice", mh.status === "credited" && mh.scope === "global"
      && mh.scoped_profiles === null && mh.paid_outside_batch === 0 && (await perDay(k, Q, "challenge_chat", "sum")) === 1
      && (await perDay(k, V, "challenge_chat", "sum")) === 2 && (await perDay(k, N, "challenge_chat", "sum")) === 3
      && (await perDay(k, O, "challenge_chat", "sum")) === 2, mh);
    ok("K9 health counts the global pass (global_passes_7d = 1)",
      (await one(k, "select challenge_retro_credit_health() h")).h.queue.global_passes_7d === 1);
  }

  console.log("R. an engine error: pending, retried, stuck at max_attempts, alarmed once, recovered");
  {
    await cfg(k, { retro_credit: { max_attempts: 2 } });
    const sig = "public.challenge_social_source(timestamp with time zone,timestamp with time zone,uuid[],timestamp with time zone,timestamp with time zone,integer)";
    const saved = (await one(k, `select pg_get_functiondef('${sig}'::regprocedure) d`)).d;
    // break the chat section: the live source replaced by a raising body of the same signature (a SQL-function
    // cannot be swapped for plpgsql in place, so drop + create; `saved` restores the byte-identical original)
    await k.exec(`drop function ${sig};
      create function ${sig}
      returns table(chat_id bigint, msg_id bigint, group_id uuid, profile_id uuid, telegram_user_id bigint, thread_id bigint,
                    homework_topic_id bigint, reply_to_message_id bigint, sent_at timestamptz, day date, m jsonb)
      language plpgsql stable security definer set search_path = public as $f$ begin raise exception 'source broken'; end $f$;`);
    for (const i of [0, 1]) await post(k, { id: 351 + i, tg: TG[E], group: G1, text: text(90 + i), sent: at(DAY_B, `15:0${i}`) }, null);
    await k.query("update profiles set telegram_id = $1 where id = $2", [TG[E], E]);
    const a1 = await sweep(k);
    const eRow = () => ledger(k).then((l) => l.find((r) => r.profile_id === E));
    ok("R1 section error -> 'error', ledger pending, attempts 1, last_error names the social section",
      a1.status === "error" && (await eRow())?.status === "pending" && (await eRow())?.attempts === 1 && /social/.test((await eRow())?.last_error ?? ""), a1);
    ok("R2 ... and nothing was paid for E", (await perDay(k, E, "challenge_chat", "sum")) === 0);
    const a2 = await sweep(k);
    const a3 = await sweep(k);
    ok("R3 attempts stop at max_attempts (2): the next sweep is idle", a2.status === "error" && a3.status === "idle" && (await eRow())?.attempts === 2, [a2.status, a3.status]);
    const h = (await one(k, "select challenge_retro_credit_health() h")).h;
    ok("R4 health: stuck = 1, with the error", h.queue.stuck === 1 && /social/.test(h.queue.last_error), h.queue);
    const w1 = (await one(k, "select challenge_retro_credit_watchdog() w")).w;
    const calls = await q(k, "select * from ops_net_calls order by id");
    ok("R5 watchdog: alarm R2, ONE DM to the admin through ops_net_post with Content-Type",
      w1.state === "alarm" && w1.alarms.includes("R2") && calls.length === 1 && calls[0].body.chat_id == TG[AD]
      && calls[0].headers["Content-Type"] === "application/json" && calls[0].purpose === "challenge-retro-credit-watchdog", { w1, calls });
    const w2 = (await one(k, "select challenge_retro_credit_watchdog() w")).w;
    ok("R6 latched: the same alarm again sends nothing", w2.state === "alarm" && w2.dm_sent === 0
      && (await num(k, "select count(*)::int n from ops_net_calls")) === 1, w2);
    await k.exec(`drop function ${sig};\n` + saved);
    ok("R6b the live source is back, byte-identical", (await one(k,
      `select md5(replace(prosrc, E'\\r', '')) b from pg_proc where oid = '${sig}'::regprocedure`)).b === PROD_BODY_MD5[sig.replace("public.", "")]);
    await k.exec("update challenge_retro_credits set attempts = 0, last_error = null where status = 'pending'"); // the documented recovery
    const a4 = await sweep(k);
    ok("R7 after the fix + recovery SQL: credited +2", a4.status === "credited" && (await perDay(k, E, "challenge_chat", "sum")) === 2, a4);
    await one(k, "select challenge_retro_credit_watchdog() w");
    const w4 = (await one(k, "select challenge_retro_credit_watchdog() w")).w;
    const last = await one(k, "select body from ops_net_calls order by id desc limit 1");
    ok("R8 two clean runs -> the recovery DM", w4.recovered === true && /✅/.test(last.body.text), w4);
  }

  console.log("U. an unattached row of an already-linked sender is detected (R3) and healed");
  {
    await k.exec("alter table profiles disable trigger trg_profiles_updated; update profiles set updated_at = now() - interval '2 hours' where id = '" + P + "'; alter table profiles enable trigger trg_profiles_updated;");
    await post(k, { id: 361, tg: TG[P], group: G1, text: text(99), sent: at(DAY_B, "16:00") }, null); // a bot mis-stamp
    const h = (await one(k, "select challenge_retro_credit_health() h")).h;
    ok("U1 health: 1 unattached row, 1 sender", h.unattached.rows === 1 && h.unattached.senders === 1, h.unattached);
    const w = (await one(k, "select challenge_retro_credit_watchdog() w")).w;
    ok("U2 watchdog alarms R3", w.alarms.includes("R3"), w.alarms);
    const s = await sweep(k);
    ok("U3 the sweep attaches it and credits it", s.attached_rows === 1 && s.status === "credited" && (await stampOfRow(k, 361)) === P, s);
    ok("U4 health: 0 unattached", (await one(k, "select challenge_retro_credit_health() h")).h.unattached.rows === 0);
  }

  console.log("J. a failing attach never fails the profile write; the signal alarms; the sweep heals it");
  {
    const saved = (await one(k, "select pg_get_functiondef('public.challenge_retro_attach(uuid,text)'::regprocedure) d")).d;
    await k.exec(`create or replace function public.challenge_retro_attach(_profile uuid, _source text) returns jsonb
                  language plpgsql security definer set search_path = public as $f$ begin raise exception 'boom'; end $f$;`);
    await post(k, { id: 341, tg: TG[W], group: G1, text: text(80), sent: at(DAY_B, "14:00") }, null);
    const e = await errOf(k, "update profiles set telegram_id = $1 where id = $2", [TG[W], W]);
    ok("J1 the profile write succeeds", e === null && (await one(k, "select telegram_id t from profiles where id = $1", [W])).t == TG[W], e);
    const sig = await q(k, "select details from admin_actions where action = 'challenge_retro_link_error'");
    ok("J2 ... and leaves a DB-visible signal row", sig.length === 1 && /boom/.test(sig[0].details.error), sig);
    const h = (await one(k, "select challenge_retro_credit_health() h")).h;
    ok("J3 health counts it (link_errors_2h = 1, link_errors_24h = 1)", h.link_errors_2h === 1 && h.link_errors_24h === 1, h);
    const w = (await one(k, "select challenge_retro_credit_watchdog() w")).w;
    ok("J4 the watchdog alarms R3 on it", w.alarms.includes("R3"), w.alarms);
    await k.exec(saved);
    const s = await sweep(k);
    ok("J5 the sweep attaches W's row and credits it", s.attached_rows === 1 && s.status === "credited"
      && (await perDay(k, W, "challenge_chat", "sum")) === 1, s);
    ok("J6 drift 0 across K/R/U/J", (await drift(k)) === 0);
  }

  console.log("B. a SCOPED pass that paid someone outside its batch (an engine edit broke the scope) alarms R5");
  {
    ok("B0 no breach so far (every scoped pass above paid inside its batch)",
      (await one(k, "select challenge_retro_credit_health() h")).h.queue.scope_breaches_24h === 0);
    // The engines make this unrepresentable, so the ledger row a broken engine would leave is written directly.
    await k.query(`insert into challenge_retro_credits (source, profile_id, telegram_user_id, attached, scan_from, status, credited_at, result)
                   values ('sweep', $1, $2, 1, now(), 'credited', now(), '{"scope": "profiles", "paid_outside_batch": 3}')`, [P, TG[P]]);
    const h = (await one(k, "select challenge_retro_credit_health() h")).h;
    const w = (await one(k, "select challenge_retro_credit_watchdog() w")).w;
    ok("B1 health scope_breaches_24h = 1 and the watchdog alarms R5", h.queue.scope_breaches_24h === 1 && w.alarms.includes("R5"),
      { q: h.queue, alarms: w.alarms });
    await k.query("delete from challenge_retro_credits where result->>'paid_outside_batch' = '3'");
  }

  console.log("W. a window with no start (the engines treat it as unbounded) fails CLOSED here, loudly");
  {
    await cfg(k, { window: { start: null, end: null } });
    const h = await errOf(k, "select challenge_retro_credit_health()");
    ok("W1 health still runs", h === null, h);
    const s = await sweep(k);
    ok("W2 the sweep attaches nothing (window_invalid)", s.window_invalid === true && s.attached_rows === 0, s);
    const w = (await one(k, "select challenge_retro_credit_watchdog() w")).w;
    ok("W3 the watchdog alarms R4 (not R0)", w.alarms.includes("R4") && !w.alarms.includes("R0"), w.alarms);
    const a = (await one(k, "select challenge_retro_attach($1, 'sweep') a", [P])).a;
    ok("W4 attach refuses: window_invalid", a.status === "window_invalid", a);
    await setWindow(k, 5, null);
  }
  await k.close();

  // ───────────── O. history heal on apply ─────────────
  console.log("O. applied with the window already open: one heal row credits the pre-trigger link");
  {
    const o = await freshDb({
      windowStartDaysAgo: 5,
      windowBeforeMine: true,
      beforeMine: async (d) => {
        await seedProfiles(d, false);
        for (const m of TRAFFIC.filter((x) => x.tg === TG[R])) await post(d, m, stampOf(m.tg, false));
        await engines(d); // live history: R's media paid (no telegram check), R's chat not (unverified)
        await d.query("update profiles set telegram_id = $1 where id = $2", [TG[R], R]); // linked BEFORE the trigger exists
      },
    });
    const led = await ledger(o);
    ok("O1 exactly one heal row, pending, scan_from = window.start - 5 min", led.length === 1 && led[0].source === "heal"
      && led[0].status === "pending" && led[0].profile_id === null, led);
    ok("O2 audit: heal_enqueued", (await one(o, "select details d from admin_actions where action = 'challenge_retro_credit_applied'")).d.heal_enqueued === true);
    ok("O3 before the sweep: R's chat unpaid", (await perDay(o, R, "challenge_chat", "sum")) === 0);
    const s = await sweep(o);
    ok("O4 the sweep credits R's chat (+2) and does not pay the media twice", s.status === "credited"
      && (await perDay(o, R, "challenge_chat", "sum")) === 2 && (await perDay(o, R, "challenge_group_media", "count")) === 1, s);
    ok("O4b the heal pass is GLOBAL and says so: scope 'global', paid_outside_batch = 2 (R has no ledger row of its own)",
      s.scope === "global" && s.paid_outside_batch === 2, s);
    ok("O4c its two cron-action heartbeats were relabelled (a global pass must not stand in for a dead cron)",
      (await num(o, "select count(*)::int n from admin_actions where action = 'challenge_retro_engine_heartbeat'")) === 2
      && (await num(o, "select count(*)::int n from admin_actions where action like '%\\_scoped'")) === 0);
    const e2 = await tx(o, MIG);
    ok("O5 replay: still one heal row", e2 === null && (await ledger(o)).length === 1, e2);
    await o.close();
  }

  // ───────────── Z. production today: the window is not open ─────────────
  console.log("Z. production today (window opens 2026-10-01 00:00 +05): nothing to attach, nothing to credit");
  {
    const z = await freshDb();
    await cfg(z, { window: { start: (await one(z, "select to_json(now() + interval '4 hours')#>>'{}' v")).v } });
    await seedProfiles(z, false);
    for (const m of TRAFFIC.filter((x) => x.tg === TG[L]).slice(0, 5)) await post(z, { ...m, sent: ago(60) }, null);
    await z.query("update profiles set telegram_id = $1 where id = $2", [TG[L], L]);
    ok("Z1 linking before the window: no ledger row, rows stay unattached", (await ledger(z)).length === 0 && (await stampOfRow(z, 101)) === null);
    const s = await sweep(z);
    ok("Z2 the sweep is idle", s.status === "idle" && s.attached_rows === 0, s);
    const w = (await one(z, "select challenge_retro_credit_watchdog() w")).w;
    ok("Z3 the watchdog reports inactive and stamps checked_at", w.state === "inactive" && (await one(z,
      "select value->>'checked_at' c from app_settings where key = 'challenge_retro_credit_watchdog_state'")).c !== null, w);
    await z.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) throw new Error(`${fail} check(s) failed`);
}
