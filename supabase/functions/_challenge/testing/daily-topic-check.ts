// PGlite harness for 20260930121000_challenge_daily_task_topic.sql (Daily Tasks PR-1).
//
//   deno test -A --node-modules-dir=none --no-lock supabase/functions/_challenge/testing/daily-topic-check.ts
//
// Applies the LIVE bodies (md5-verified against production) plus 20260930100010 (#218) to a real PostgreSQL,
// then THIS migration, and checks: media, chat and answer points are 0 for daily-topic messages with exact
// parity everywhere else; every trigger refusal (and the SQL/TypeScript parser + validator agree); the unique
// index and CHECKs; the seed and its abort paths; the history heal; the md5 pins; replay; grants.
// Run it after ANY change to the migration, and before asking for the migration-approved label.
// MIG_PATH=<file> tests a draft before it is written into its (edit-guarded) slot.
//
// CI NOTE: CI runs `deno test supabase/functions/` with NO permission flags. Without --allow-read PGlite cannot
// load its own data files, so this suite registers as IGNORED there (visible in the log, never a false red).
// To make it gate merges, the CI step needs `-A --node-modules-dir=none` (a .github change: owner-only).
// TEST INFRASTRUCTURE ONLY: this directory has no index.ts, so it is never deployed.

import { createHash } from "node:crypto";
import { dailyTopicError, DAILY_TOPIC_MSG, parseTopicUrl } from "../../../../src/lib/dailyTaskTopic.ts";

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
const md5 = (s: string) => createHash("md5").update(s).digest("hex");

// ── production facts (read-only, 2026-09-30) ──
const RCX_DEF_MD5 = "34e8852bb22b0a20ffced8d9d3102d38";  // md5(pg_get_functiondef(reconcile_challenge_xp))
const RCX_BODY_MD5 = "15362fff6d02865d677388ab8ce49b51"; // md5(prosrc) -- the migration's pin
const CSS_DEF_MD5 = "17aa387c70287f3bbfa15d9e69c153e3";  // challenge_social_source
const CSS_BODY_MD5 = "26fec5a1950a3ace908698d961fec715";
const HW_TRIG_BODY_MD5 = "13213cd2b2c254f94ddcc6bb929dd431";  // groups_extract_homework_topic_id (\r stripped)
const GMT_TRIG_BODY_MD5 = "ccfe306dc49edf7123e68a233314855c"; // gmt_parse_topic_id (\r stripped)

// The two edits, exactly as the migration makes them (the harness recomputes the new body md5s from these).
const RCX_EDITS: [string, string][] = [
  ["               grp.homework_topic_id,\n               (w.raw_update->'message') as m\n",
   "               grp.homework_topic_id,\n" +
   "               grp.daily_task_topic_id,   -- I2 (20260930121000): the group's KUNLIK VAZIFALAR topic\n" +
   "               (w.raw_update->'message') as m\n"],
  ["                 and b.thread_id is distinct from b.homework_topic_id\n",
   "                 and b.thread_id is distinct from b.homework_topic_id\n" +
   "                 -- I2 (20260930121000): the daily-task topic earns ONLY daily-task points. The WHOLE topic\n" +
   "                 -- is excluded, keyed to the group's saved URL, whatever the message is.\n" +
   "                 and (b.daily_task_topic_id is null or b.thread_id is distinct from b.daily_task_topic_id)\n"],
];
const CSS_EDITS: [string, string][] = [
  ["   where g.group_id = any(_groups)\n",
   "   where g.group_id = any(_groups)\n" +
   "     -- I2 (20260930121000): nothing posted in the group's KUNLIK VAZIFALAR topic is a chat or an answer\n" +
   "     -- source row; that topic earns only daily-task points. Keyed to the saved URL: the topic decides.\n" +
   "     and (grp.daily_task_topic_id is null or g.telegram_thread_id is distinct from grp.daily_task_topic_id)\n"],
];
const CSS_SIG = "public.challenge_social_source(timestamp with time zone, timestamp with time zone, uuid[], timestamp with time zone, timestamp with time zone, integer)";

const C6 = "f502f631-2104-4834-b6c2-702cd3080e27";
const C5 = "78011384-4024-49b0-b72d-b0b2e3a04ee8";
// The four production groups the migration seeds (ids, chats, homework topics and daily topics as verified).
const G1 = "f675a2fd-b1ce-4d28-94a4-7fc0e1a91515", G2 = "c092a0db-b55f-4fa7-8548-befad285037b";
const G3 = "3a7ebea8-80eb-4b64-a282-471a0fa12ef4", G4 = "93e8e7b0-275c-47a9-a97d-ff28e26c8f5b";
const CH1 = -1004440955972, CH2 = -1004390902020, CH3 = -1003714608284, CH4 = -1004463424516;
const D1 = 144, D2 = 99, D3 = 38, D4 = 12;
const G5 = "55555555-5555-5555-5555-555555555555"; // a 5.0 group (outside the challenge), chat -100555
const G6 = "66666666-6666-6666-6666-666666666666"; // another 5.0 group in the SAME chat (unique-index test)
const G7 = "77777777-7777-7777-7777-777777777777"; // 5.0 group used by the SQL/TS validator matrix
const CH5 = -100555;
const U = (n: number) => `aaaaaaaa-0000-0000-0000-${String(n).padStart(12, "0")}`;
const S1 = U(1), S2 = U(2), S3 = U(3), S4 = U(4), S5 = U(5), S6 = U(6), X1 = U(7), T1 = U(8), AD = U(11);
const TG: Record<string, number> = { [S1]: 1001, [S2]: 1002, [S3]: 1003, [S4]: 1004, [S5]: 1005, [S6]: 1006, [X1]: 1007, [T1]: 1008, [AD]: 1011 };
const CHAT_OF: Record<string, number> = { [G1]: CH1, [G2]: CH2, [G3]: CH3, [G4]: CH4, [G5]: CH5, [G6]: CH5, [G7]: -100777 };

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

// §4 of the build spec, verbatim: the seeded config must equal it exactly.
const SPEC_CONFIG = {
  enabled: false, post: true, dm: true, remind: true, summary: true, ai: false, receipts: true, auto_register: true, miniapp: false,
  miniapp_link: null, miniapp_onboarding: false, test_group_ids: [], task_weekdays: [1, 2, 3, 4, 5], post_time: "09:00",
  remind_time: "19:00", summary_time: "20:00", quiet_start: "22:00", quiet_end: "08:00", late_days: 2, late_factor: 0.5,
  points: { general: 5, instagram: 8 }, streak: { every: 5, bonus: 10 }, merge_window_min: 5, min_text_chars: 20, min_voice_sec: 3,
  max_items_per_day: 40, max_attempts_per_task: 3, max_moves_per_submission: 5, receipt_budget_per_chat_min: 12,
  backfill_receipt_max_age_min: 120, fail_open_after_min: 60, liveness_check_time: "14:00",
  ig: { tag_handle: "aicreators.students", min_confidence: 0.6, handle_edit_distance: 1, dhash_max_distance: 4, require_recent: true,
        recent_min_confidence: 0.8, existence_probe: true, lock_handle_after_accept: true },
  generic: { offtask_min_confidence: 0.85 }, ai_provider_order: ["anthropic", "openai"],
  ai_models: { anthropic: "claude-haiku-4-5", openai: "gpt-5-mini" }, ai_prices: { anthropic: [1, 5], openai: [0.25, 2] },
  ai_daily_budget_usd: 3, ai_max_checks_per_user_day: 6,
};

// Parser fixtures: [url, chat (without -100) | null, topic | null]. The SQL self-test carries the same list.
const PARSE_FIXTURES: [string, number | null, number | null][] = [
  ["https://t.me/c/4440955972/144", 4440955972, 144],
  ["  https://t.me/c/4440955972/144/  ", 4440955972, 144],
  ["https://t.me/c/4440955972/144/5321", 4440955972, 144],
  ["https://t.me/c/4440955972/5321?thread=144", 4440955972, 144],
  ["https://t.me/c/4440955972/144/5321?single&thread=99", 4440955972, 99],
  ["http://t.me/c/1/2", 1, 2],
  ["HTTPS://T.ME/c/4390902020/99", 4390902020, 99],
  ["https://t.me/c/4440955972/1", 4440955972, 1],
  ["https://t.me/c/4440955972/144?single", 4440955972, 144],
  ["https://t.me/somegroup/144", null, null],
  ["https://t.me/+AbCdEf123", null, null],
  ["https://t.me/c/4440955972", null, null],
  ["https://t.me/c/4440955972/144?thread=abc", null, null],
  ["https://t.me/c/0123/5", null, null],
  ["https://t.me/c/4440955972/144#x", null, null],
  ["t.me/c/4440955972/144", null, null],
  ["", null, null],
  // extra (harness-only)
  ["\thttps://t.me/c/4463424516/12\n", 4463424516, 12],
  ["https://t.me/c/4463424516/12?thread=", null, null],
  ["https://t.me/c/4463424516/12?comment=5", 4463424516, 12],
  ["https://t.me/c/4463424516/12/34/56", null, null],
  ["https://t.me/c/1234567890123456/12", null, null],
  ["https://telegram.me/c/4463424516/12", null, null],
];

Deno.test({
  name: CAN_RUN
    ? "daily_topic_check: 20260930121000 on PGlite (live bodies, #218, exclusion parity, triggers, seed, heal)"
    : "daily_topic_check: SKIPPED -- needs `deno test -A --node-modules-dir=none` (PGlite reads its own files)",
  ignore: !CAN_RUN,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: run,
});

async function run() {
  const spec = "npm:@electric-sql/pglite@0.5.8"; // non-literal: never resolved or type-checked unless this runs
  // deno-lint-ignore no-explicit-any
  const { PGlite } = (await import(spec)) as any;

  const MIG_PATH = Deno.env.get("MIG_PATH");
  const MIG = lf(await Deno.readTextFile(MIG_PATH ?? here("../../../migrations/20260930121000_challenge_daily_task_topic.sql")));
  const MIG218 = lf(await Deno.readTextFile(here("../../../migrations/20260930100010_challenge_social_points.sql")));
  const RCX_LIVE = lf(await Deno.readTextFile(here("./reconcile_challenge_xp.live-2026-09-30.sql")));
  const COMMUNITY_LIVE = lf(await Deno.readTextFile(here("./reconcile_community_xp.live-2026-09-30.sql")));

  let pass = 0, fail = 0;
  const ok = (name: string, cond: boolean, detail?: unknown) => {
    if (cond) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}${detail !== undefined ? "  — " + JSON.stringify(detail) : ""}`); }
  };
  const q = async (db: PG, sql: string, params: unknown[] = []): Promise<Row[]> => (await db.query(sql, params)).rows;
  const one = async (db: PG, sql: string, params: unknown[] = []): Promise<Row> => (await q(db, sql, params))[0];
  const errOf = async (db: PG, sql: string, params: unknown[] = []): Promise<string | null> => {
    try { await db.query(sql, params); return null; } catch (e) { return String((e as Error).message); }
  };
  const tx = async (db: PG, sql: string): Promise<string | null> => {
    try { await db.exec("begin;\n" + sql + "\ncommit;"); return null; }
    catch (e) { try { await db.exec("rollback;"); } catch { /* none open */ } return String((e as Error).message); }
  };
  const bodyOf = (def: string) => def.slice(def.indexOf("$function$") + 10, def.lastIndexOf("$function$"));
  const applyEdits = (s: string, edits: [string, string][]) => edits.reduce((acc, [o, n]) => acc.replace(o, n), s);

  /** SCHEMA + the live reconcilers + #218 (the state production is in today). */
  async function freshDb(opts: { rcx?: string; beforeMine?: string } = {}): Promise<PG> {
    const db: PG = new PGlite();
    await db.exec(SCHEMA);
    await db.exec(COMMUNITY_LIVE + ";\nrevoke execute on function public.reconcile_community_xp(timestamptz) from public;\n" +
      "grant execute on function public.reconcile_community_xp(timestamptz) to service_role;");
    await db.exec((opts.rcx ?? RCX_LIVE) + ";\nrevoke execute on function public.reconcile_challenge_xp(timestamptz) from public;\n" +
      "grant execute on function public.reconcile_challenge_xp(timestamptz) to service_role;");
    const e = await tx(db, MIG218);
    if (e) throw new Error("#218 did not apply: " + e);
    if (opts.beforeMine) await db.exec(opts.beforeMine);
    return db;
  }
  const applyMine = (db: PG, text = MIG) => tx(db, text);

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
  async function liveWindow(db: PG, mode = "shadow") {
    const start = (await one(db, "select to_json(now() - interval '7 days')::text v")).v.replace(/"/g, "");
    await cfg(db, { enabled: true, window: { start, end: null }, qa: { mode } });
  }

  interface PostOpts {
    user: string; group: string; thread?: number | null; text?: string; photo?: boolean; doc?: string; voice?: number;
    album?: string; replyTo?: number; sent?: string; id: number;
  }
  async function post(db: PG, o: PostOpts): Promise<number> {
    const chat = CHAT_OF[o.group];
    const thread = o.thread === undefined ? 10 : o.thread;
    const tuid = TG[o.user];
    const m: Row = { message_id: o.id, from: { id: tuid, is_bot: false, first_name: "Real Name" }, chat: { id: chat } };
    if (thread !== null) { m.message_thread_id = thread; m.is_topic_message = true; }
    if (o.text !== undefined) m.text = o.text;
    if (o.photo) m.photo = [{ file_id: "p" + o.id, file_unique_id: "u" + o.id }];
    if (o.doc) m.document = { file_name: "f.bin", mime_type: o.doc };
    if (o.voice !== undefined) m.voice = { duration: o.voice, file_id: "v" };
    if (o.album) m.media_group_id = o.album;
    let replyMsg: number | null = null, replyUser: number | null = null;
    if (o.replyTo !== undefined) {
      const r = await q(db, "select w.raw_update->'message' m from webhook_inbox w where w.chat_id = $1 and w.message_id = $2", [chat, o.replyTo]);
      m.reply_to_message = r[0]?.m ?? { message_id: o.replyTo };
      replyMsg = o.replyTo;
      replyUser = r[0]?.m?.from?.id ?? null;
    }
    const sent = o.sent ?? "now() - interval '30 minutes'";
    await db.query(`insert into webhook_inbox (received_at, update_type, chat_id, message_id, raw_update)
                    values (now() - interval '1 second', 'message', $1, $2, $3::jsonb)`, [chat, o.id, JSON.stringify({ message: m })]);
    await db.query(`insert into group_message_events (group_id, profile_id, telegram_user_id, telegram_chat_id, telegram_message_id,
                      telegram_thread_id, sent_at, reply_to_message_id, reply_to_user_id)
                    values ($1, $2, $3, $4, $5, $6, ${sent}, $7, $8)`,
      [o.group, o.user, tuid, chat, o.id, thread, replyMsg, replyUser]);
    return o.id;
  }

  // The same traffic for every run. Returns the keys that live in a DAILY topic (what must stop paying).
  async function seedTraffic(db: PG) {
    const daily = { media: [] as string[], chat: [] as string[], answers: [] as number[] };
    // G1 (daily 144, homework 3)
    await post(db, { id: 2001, user: S1, group: G1, thread: 10, photo: true, sent: "now() - interval '50 minutes'" });
    await post(db, { id: 2002, user: S1, group: G1, thread: D1, photo: true, sent: "now() - interval '49 minutes'" });
    daily.media.push(`ch_img:${CH1}:2002`);
    await post(db, { id: 2003, user: S1, group: G1, thread: D1, photo: true, album: "A1", sent: "now() - interval '48 minutes'" });
    await post(db, { id: 2004, user: S1, group: G1, thread: D1, photo: true, album: "A1", sent: "now() - interval '48 minutes'" });
    daily.media.push(`ch_alb:${CH1}:A1`);
    await post(db, { id: 2005, user: S2, group: G1, thread: 3, photo: true, sent: "now() - interval '47 minutes'" });   // homework: 0 always
    await post(db, { id: 2006, user: S2, group: G1, thread: D1, doc: "image/png", sent: "now() - interval '46 minutes'" });
    daily.media.push(`ch_img:${CH1}:2006`);
    await post(db, { id: 2007, user: S2, group: G1, thread: D1, text: "Bugungi kunlik vazifam tayyor, ko'rib chiqing", sent: "now() - interval '45 minutes'" });
    daily.chat.push(`ch_chat:${CH1}:2007`);
    await post(db, { id: 2008, user: S2, group: G1, thread: 10, text: "Salom hammaga, bugungi dars juda zo'r bo'ldi", sent: "now() - interval '44 minutes'" });
    await post(db, { id: 2009, user: S3, group: G1, thread: D1, voice: 7, sent: "now() - interval '43 minutes'" });
    daily.chat.push(`ch_chat:${CH1}:2009`);
    // Q&A outside the daily topic (pays in both) and inside it (must not be a candidate any more)
    await post(db, { id: 2010, user: S3, group: G1, thread: 10, text: "Kling da video qanday uzaytiriladi?", sent: "now() - interval '42 minutes'" });
    await post(db, { id: 2011, user: S4, group: G1, thread: 10, text: "extend tugmasini bosing, keyin davomiylikni tanlang", replyTo: 2010, sent: "now() - interval '41 minutes'" });
    await post(db, { id: 2012, user: S4, group: G1, thread: D1, text: "Vazifada skrinshot qayerdan olinadi?", sent: "now() - interval '40 minutes'" });
    await post(db, { id: 2013, user: S3, group: G1, thread: D1, text: "Telefonda yon tugmalarni birga bosing, tayyor", replyTo: 2012, sent: "now() - interval '39 minutes'" });
    daily.answers.push(2013);
    daily.chat.push(`ch_chat:${CH1}:2012`, `ch_chat:${CH1}:2013`); // a question and an answer are chat messages too
    // G2 (daily 99): its daily topic excluded; thread 144 in G2's chat is NOT G2's daily topic -> still pays
    await post(db, { id: 3001, user: X1, group: G2, thread: D2, photo: true, sent: "now() - interval '38 minutes'" });
    daily.media.push(`ch_img:${CH2}:3001`);
    await post(db, { id: 3002, user: X1, group: G2, thread: 10, photo: true, sent: "now() - interval '37 minutes'" });
    await post(db, { id: 3003, user: X1, group: G2, thread: 144, photo: true, sent: "now() - interval '36 minutes'" });
    // 5.0 group: out of scope, pays nothing either way
    await post(db, { id: 5001, user: S5, group: G5, thread: 10, photo: true, sent: "now() - interval '35 minutes'" });
    return daily;
  }
  async function runReconcilers(db: PG) {
    await q(db, "select * from reconcile_challenge_xp(now() - interval '2 hours')");
    await q(db, "select * from reconcile_challenge_social_xp(now() - interval '2 hours')");
  }
  const keysOf = async (db: PG, reasons: string[]) =>
    (await q(db, "select ref_key from xp_events where reason = any($1)", [reasons])).map((r) => r.ref_key as string).sort();
  const candIds = async (db: PG) =>
    (await q(db, "select answer_msg_id from challenge_qa_candidates where not shadow_only order by answer_msg_id")).map((r) => Number(r.answer_msg_id));
  const drift = async (db: PG) => Number((await one(db, `select count(*)::int n from user_xp x
      where x.total_xp <> coalesce((select sum(amount) from xp_events e where e.user_id = x.user_id), 0)`)).n);
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

  // ───────────── A. fidelity: the live bodies this migration rewrites ─────────────
  console.log("A. fixture fidelity (production md5s) and the new-body pins");
  const rcxNewBody = applyEdits(bodyOf(RCX_LIVE), RCX_EDITS);
  let cssNewBody = "";
  {
    ok("rcx fixture file is byte-identical to production's definition", md5(RCX_LIVE) === RCX_DEF_MD5, md5(RCX_LIVE));
    for (const [o] of RCX_EDITS) ok(`rcx anchor occurs exactly once: ${JSON.stringify(o.slice(0, 50))}`, bodyOf(RCX_LIVE).split(o).length === 2);
    const db = await freshDb();
    const r = await one(db, `select md5(pg_get_functiondef('public.reconcile_challenge_xp(timestamptz)'::regprocedure)) d, md5(prosrc) b
                               from pg_proc where oid = 'public.reconcile_challenge_xp(timestamptz)'::regprocedure`);
    ok("rcx loaded: definition + body md5 = production", r.d === RCX_DEF_MD5 && r.b === RCX_BODY_MD5, r);
    const s = await one(db, `select pg_get_functiondef(to_regprocedure('${CSS_SIG}')) def, md5(prosrc) b from pg_proc where oid = to_regprocedure('${CSS_SIG}')`);
    ok("#218's challenge_social_source: definition + body md5 = production", md5(s.def) === CSS_DEF_MD5 && s.b === CSS_BODY_MD5, [md5(s.def), s.b]);
    for (const [o] of CSS_EDITS) ok("css anchor occurs exactly once", bodyOf(s.def).split(o).length === 2);
    cssNewBody = applyEdits(bodyOf(s.def), CSS_EDITS);
    const t = await q(db, `select proname, md5(replace(prosrc, E'\\r', '')) b from pg_proc where proname in ('groups_extract_homework_topic_id','gmt_parse_topic_id') order by 1`);
    ok("live trigger bodies (homework URL, module topic) = production", t[0]?.b === GMT_TRIG_BODY_MD5 && t[1]?.b === HW_TRIG_BODY_MD5, t);
    await db.close();
  }
  console.log(`  rcx new body md5 = ${md5(rcxNewBody)}\n  css new body md5 = ${md5(cssNewBody)}`);
  ok("migration pins the live rcx body", MIG.includes(`_pin constant text := '${RCX_BODY_MD5}'`));
  ok("migration pins the live css body", MIG.includes(`_pin constant text := '${CSS_BODY_MD5}'`));
  ok("migration pins the harness-computed new rcx body", MIG.includes(`_new_pin constant text := '${md5(rcxNewBody)}'`));
  ok("migration pins the harness-computed new css body", MIG.includes(`_new_pin constant text := '${md5(cssNewBody)}'`));

  // ───────────── M. the migration: applies, exact, seeded, granted, replay-safe ─────────────
  console.log("M. migration: applies, exact rewrites, seed, grants, config, audit, replay");
  const db = await freshDb();
  {
    const before = await q(db, `select proname, coalesce(array_to_string(proacl, ','), '') a, proowner o, prosecdef s from pg_proc
                                 where proname in ('reconcile_challenge_xp', 'challenge_social_source') order by 1`);
    const err = await applyMine(db);
    ok("applies (including its self-test)", err === null, err);
    const after = await q(db, `select proname, coalesce(array_to_string(proacl, ','), '') a, proowner o, prosecdef s, prosrc from pg_proc
                                where proname in ('reconcile_challenge_xp', 'challenge_social_source') order by 1`);
    ok("rewritten fns: owner / ACL / SECURITY DEFINER unchanged",
      JSON.stringify(after.map((r) => [r.proname, r.a, r.o, r.s])) === JSON.stringify(before.map((r) => [r.proname, r.a, r.o, r.s])), after.map((r) => r.a));
    ok("css body = live body + exactly the one predicate", after[0].prosrc === cssNewBody);
    ok("rcx body = live body + exactly the two edits", after[1].prosrc === rcxNewBody);
    const seeded = await q(db, `select id, daily_task_topic_url u, daily_task_topic_id t, daily_task_chat_id c from groups
                                 where daily_task_topic_url is not null order by name`);
    ok("seed: exactly the four challenge groups, URL + derived (chat, topic)", JSON.stringify(seeded.map((r) => [r.id, r.u, Number(r.t), Number(r.c)])) ===
      JSON.stringify([[G1, "https://t.me/c/4440955972/144", D1, CH1], [G2, "https://t.me/c/4390902020/99", D2, CH2],
                      [G3, "https://t.me/c/3714608284/38", D3, CH3], [G4, "https://t.me/c/4463424516/12", D4, CH4]]), seeded);
    const conf = await one(db, "select value v from platform_settings where key = 'challenge_tasks'");
    ok("platform_settings.challenge_tasks = spec §4 verbatim (inert)", deepEq(conf.v, SPEC_CONFIG), conf.v);
    const audit = await q(db, "select details from admin_actions where action = 'challenge_daily_topic_applied'");
    ok("audit row once: 4 seeded, 0 kept, heal all zero, both new md5s", audit.length === 1 &&
      audit[0].details.seeded.length === 4 && audit[0].details.kept.length === 0 &&
      Object.values(audit[0].details.heal as Row).every((v) => v === 0) &&
      audit[0].details.reconcile_challenge_xp_md5 === md5(rcxNewBody) && audit[0].details.challenge_social_source_md5 === md5(cssNewBody) &&
      audit[0].details.topics.length === 4, audit[0]?.details);
    const acl = await q(db, `select p.proname, coalesce(array_to_string(p.proacl, ','), '') a from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname in ('challenge_task_parse_topic_url','groups_extract_daily_task_topic','gmt_daily_topic_guard',
         'challenge_task_topics','my_daily_task_topic_url','admin_topic_lookup') order by 1`);
    const aclOf = Object.fromEntries(acl.map((r) => [r.proname, r.a]));
    ok("6 new functions, none reachable by PUBLIC or anon", acl.length === 6 && acl.every((r) => !/(^|,)=/.test(r.a) && !/anon=/.test(r.a)), aclOf);
    ok("only my_daily_task_topic_url + admin_topic_lookup are granted to authenticated",
      acl.every((r) => /authenticated=/.test(r.a) === ["my_daily_task_topic_url", "admin_topic_lookup"].includes(r.proname)), aclOf);
    ok("challenge_task_topics + the parser are service_role-callable",
      /service_role=X/.test(aclOf.challenge_task_topics) && /service_role=X/.test(aclOf.challenge_task_parse_topic_url), aclOf);

    // replay: an admin cleared G4's URL after the first apply; the replay must not re-seed it
    await db.exec(`update groups set daily_task_topic_url = null where id = '${G4}'`);
    const err2 = await applyMine(db);
    ok("replay is a clean no-op", err2 === null, err2);
    ok("replay: one audit row", (await one(db, "select count(*)::int n from admin_actions where action = 'challenge_daily_topic_applied'")).n === 1);
    ok("replay: never re-seeds a URL an admin cleared", (await one(db, `select daily_task_topic_url u from groups where id = '${G4}'`)).u === null);
    const src2 = await q(db, "select md5(prosrc) b from pg_proc where proname in ('challenge_social_source','reconcile_challenge_xp') order by proname");
    ok("replay leaves both rewritten bodies unchanged", src2[0].b === md5(cssNewBody) && src2[1].b === md5(rcxNewBody), src2);
    await db.exec(`update groups set daily_task_topic_url = 'https://t.me/c/4463424516/12' where id = '${G4}'`);
  }
  {
    // an existing challenge_tasks row is never overwritten
    const d2 = await freshDb({ beforeMine: `insert into platform_settings (key, value) values ('challenge_tasks', '{"enabled": true, "x": 1}')` });
    ok("pre-existing challenge_tasks row: applies", (await applyMine(d2)) === null);
    ok("...and the row is kept as it was (ON CONFLICT DO NOTHING)", deepEq((await one(d2, "select value v from platform_settings where key = 'challenge_tasks'")).v, { enabled: true, x: 1 }));
    await d2.close();
  }
  {
    const drifted = RCX_LIVE.replace("-- One award row per share, so counting rows counts shares.", "-- One award row per share (drifted).");
    const d3 = await freshDb({ rcx: drifted });
    const err = await applyMine(d3);
    ok("a drifted live reconcile_challenge_xp is refused with the md5 message", !!err && err.includes("reconcile_challenge_xp changed since it was verified"), err);
    ok("...and NOTHING from the file is left behind (one transaction)",
      (await one(d3, "select count(*)::int n from information_schema.columns where table_name = 'groups' and column_name like 'daily_task%'")).n === 0);
    await d3.close();
  }
  {
    const d4 = await freshDb();
    const s = await one(d4, `select pg_get_functiondef(to_regprocedure('${CSS_SIG}')) def`);
    await d4.exec(s.def.replace("-- duplicate inbox rows collapse", "-- duplicate inbox rows collapse (drifted)"));
    const err = await applyMine(d4);
    ok("a drifted live challenge_social_source is refused with the md5 message", !!err && err.includes("challenge_social_source changed since it was verified"), err);
    await d4.close();
  }
  {
    const d5 = await freshDb({ beforeMine: `update groups set homework_topic_url = 'https://t.me/c/1111111111/5' where id = '${G3}'` });
    const err = await applyMine(d5);
    ok("seed ABORTS when a group's homework chat is not the verified chat", !!err && err.includes("is not in chat") && err.includes("3-GURUH"), err);
    await d5.close();
    const d6 = await freshDb({ beforeMine: `delete from groups where id = '${G4}'` });
    const err6 = await applyMine(d6);
    ok("seed ABORTS when a verified group is missing", !!err6 && err6.includes("4-GURUH") && err6.includes("not found"), err6);
    await d6.close();
  }

  // ───────────── P. the parser: fixtures, and SQL == TypeScript mirror ─────────────
  console.log("P. challenge_task_parse_topic_url == src/lib/dailyTaskTopic.ts parseTopicUrl");
  {
    const bad: unknown[] = [];
    for (const [url, chat, topic] of PARSE_FIXTURES) {
      const r = await one(db, "select p.chat, p.topic from challenge_task_parse_topic_url($1) p", [url]);
      const sqlChat = r.chat === null ? null : Number(r.chat), sqlTopic = r.topic === null ? null : Number(r.topic);
      const ts = parseTopicUrl(url);
      if (sqlChat !== chat || sqlTopic !== topic) bad.push(["sql", url, sqlChat, sqlTopic]);
      if ((ts ? Number(ts.chat) : null) !== chat || (ts ? ts.topic : null) !== topic) bad.push(["ts", url, ts]);
      if (ts && ts.chatId !== Number(`-100${chat}`)) bad.push(["ts chatId", url, ts]);
    }
    ok(`${PARSE_FIXTURES.length} fixtures: SQL and TS both give the expected (chat, topic)`, bad.length === 0, bad);
    ok("the migration's self-test carries the same first 17 fixtures", PARSE_FIXTURES.slice(0, 17).every(([u]) => MIG.includes(JSON.stringify(u))));
  }

  // ───────────── T. the triggers: every refusal, derivation, CHECKs, unique index ─────────────
  console.log("T. groups trigger + module-topic guard");
  const setDaily = (g: string, url: string | null) => errOf(db, "update groups set daily_task_topic_url = $1 where id = $2", [url, g]);
  const row = async (g: string) => await one(db, `select daily_task_topic_url u, daily_task_topic_id::int t, daily_task_chat_id::text c,
                                                       homework_topic_id::int h from groups where id = '${g}'`);
  {
    ok("T1 malformed URL", (await setDaily(G5, "salom"))?.includes(DAILY_TOPIC_MSG.badFormat) === true);
    ok("T2 public-group link", (await setDaily(G5, "https://t.me/somegroup/21"))?.includes(DAILY_TOPIC_MSG.badFormat) === true);
    ok("T3 General (topic 1)", (await setDaily(G5, "https://t.me/c/555/1"))?.includes(DAILY_TOPIC_MSG.general) === true);
    ok("T4 another chat", (await setDaily(G5, "https://t.me/c/999/21"))?.includes(DAILY_TOPIC_MSG.otherChat) === true);
    ok("T5 the homework topic itself", (await setDaily(G5, "https://t.me/c/555/9"))?.includes(DAILY_TOPIC_MSG.sameAsHomework) === true);
    ok("T6 a message link inside the homework topic", (await setDaily(G5, "https://t.me/c/555/9/4321"))?.includes(DAILY_TOPIC_MSG.sameAsHomework) === true);
    ok("T7 no homework URL", (await setDaily(G7, "https://t.me/c/777/21"))?.includes(DAILY_TOPIC_MSG.homeworkMissing) === true);
    await db.exec(`update groups set homework_topic_url = 'https://t.me/grouppublic/5' where id = '${G7}'`);
    ok("T8 a non-/c/ homework URL cannot prove the chat", (await setDaily(G7, "https://t.me/c/777/21"))?.includes(DAILY_TOPIC_MSG.homeworkNotC) === true);
    await db.exec(`update groups set homework_topic_url = null where id = '${G7}'`);

    ok("T9 a valid URL saves", (await setDaily(G5, "  https://t.me/c/555/21  ")) === null);
    let r = await row(G5);
    ok("T9 ...trimmed, topic + Bot-API chat derived", r.u === "https://t.me/c/555/21" && r.t === 21 && r.c === String(CH5), r);
    ok("T10 ?thread= wins", (await setDaily(G5, "https://t.me/c/555/5000?thread=22")) === null && (await row(G5)).t === 22);
    ok("T11 /c/x/topic/msg takes the middle number", (await setDaily(G5, "https://t.me/c/555/23/5000")) === null && (await row(G5)).t === 23);
    await db.exec(`update groups set daily_task_topic_id = 999, daily_task_chat_id = 1 where id = '${G5}'`);
    r = await row(G5);
    ok("T12 the derived columns cannot be written directly (re-derived from the URL)", r.t === 23 && r.c === String(CH5), r);
    ok("T13 homework moved to another chat while a daily topic is set -> refused",
      (await errOf(db, `update groups set homework_topic_url = 'https://t.me/c/999/9' where id = '${G5}'`))?.includes(DAILY_TOPIC_MSG.otherChat) === true);
    ok("T14 homework cleared while a daily topic is set -> refused",
      (await errOf(db, `update groups set homework_topic_url = null where id = '${G5}'`))?.includes(DAILY_TOPIC_MSG.homeworkMissing) === true);
    ok("T15 homework URL changed to the daily topic -> refused",
      (await errOf(db, `update groups set homework_topic_url = 'https://t.me/c/555/23' where id = '${G5}'`))?.includes(DAILY_TOPIC_MSG.sameAsHomework) === true);
    await db.exec(`update groups set homework_topic_url = 'https://t.me/c/555/9?thread=31' where id = '${G5}'`);
    ok("T16 homework read by BOTH parsers: its ?thread= topic ...", (await setDaily(G5, "https://t.me/c/555/31"))?.includes(DAILY_TOPIC_MSG.sameAsHomework) === true);
    ok("T16 ...and the legacy first-number reading the bot uses", (await setDaily(G5, "https://t.me/c/555/9"))?.includes(DAILY_TOPIC_MSG.sameAsHomework) === true);
    await db.exec(`update groups set homework_topic_url = 'https://t.me/c/555/9' where id = '${G5}'`);
    ok("T17 blank clears all three", (await setDaily(G5, "   ")) === null &&
      JSON.stringify(await row(G5)) === JSON.stringify({ u: null, t: null, c: null, h: 9 }), await row(G5));
    ok("T18 clearing homework AND daily in one update is allowed",
      (await errOf(db, `update groups set daily_task_topic_url = 'https://t.me/c/555/21' where id = '${G5}'`)) === null &&
      (await errOf(db, `update groups set homework_topic_url = null, daily_task_topic_url = null where id = '${G5}'`)) === null);
    await db.exec(`update groups set homework_topic_url = 'https://t.me/c/555/9', daily_task_topic_url = 'https://t.me/c/555/21' where id = '${G5}'`);

    const dup = await errOf(db, `update groups set daily_task_topic_url = 'https://t.me/c/555/21' where id = '${G6}'`);
    ok("T19 one topic = one group's daily topic (unique index)", !!dup && dup.includes("uq_groups_daily_task_topic"), dup);
    ok("T20 insert path runs the same trigger", (await errOf(db,
      `insert into groups (name, course_id, homework_topic_url, daily_task_topic_url) values ('new', '${C5}', 'https://t.me/c/888/4', 'https://t.me/c/888/4')`))
      ?.includes(DAILY_TOPIC_MSG.sameAsHomework) === true);

    await db.exec(`alter table groups disable trigger trg_groups_extract_daily_task_topic`);
    const chk1 = await errOf(db, `update groups set daily_task_topic_id = null where id = '${G5}'`);
    const chk2 = await errOf(db, `update groups set daily_task_topic_id = 1 where id = '${G5}'`);
    await db.exec(`alter table groups enable trigger trg_groups_extract_daily_task_topic`);
    ok("T21 CHECK: the three columns are all-or-none even if the trigger were bypassed", !!chk1 && chk1.includes("groups_daily_task_topic_all_or_none"), chk1);
    ok("T22 CHECK: the topic is never General even if the trigger were bypassed", !!chk2 && chk2.includes("groups_daily_task_topic_not_general"), chk2);

    // module topics, both directions
    await db.exec(`insert into modules values ('00000000-0000-0000-0000-00000000000a'), ('00000000-0000-0000-0000-00000000000b'),
                   ('00000000-0000-0000-0000-00000000000c'), ('00000000-0000-0000-0000-00000000000d')`);
    const gmt = (mod: string, url: string) => errOf(db,
      `insert into group_module_topics (group_id, module_id, telegram_topic_url) values ('${G5}', '00000000-0000-0000-0000-00000000000${mod}', $1)`, [url]);
    ok("T23 module topic = the daily topic -> refused", (await gmt("a", "https://t.me/c/555/21"))?.includes("Modul topigi «Kunlik vazifalar» topigi bilan bir xil bo‘lmasin") === true);
    ok("T24 module MESSAGE link whose trailing id (the stored id) = the daily topic -> refused",
      (await gmt("a", "https://t.me/c/555/60/21"))?.includes("Kunlik vazifalar") === true);
    ok("T25 module MESSAGE link inside the daily topic (parsed topic) -> refused",
      (await gmt("a", "https://t.me/c/555/21/7000"))?.includes("Kunlik vazifalar") === true);
    ok("T26 an unrelated module topic saves", (await gmt("a", "https://t.me/c/555/40")) === null);
    ok("T27 updating that module topic onto the daily topic -> refused",
      (await errOf(db, `update group_module_topics set telegram_topic_url = 'https://t.me/c/555/21' where group_id = '${G5}'`))?.includes("Kunlik vazifalar") === true);
    ok("T28 daily topic = a module topic (stored id) -> refused", (await setDaily(G5, "https://t.me/c/555/40"))?.includes(DAILY_TOPIC_MSG.sameAsModule) === true);
    ok("T29 module link /c/555/41/5000 stores 5000 -> daily 5000 refused", (await gmt("b", "https://t.me/c/555/41/5000")) === null &&
      (await setDaily(G5, "https://t.me/c/555/5000"))?.includes(DAILY_TOPIC_MSG.sameAsModule) === true);
    ok("T30 ...and daily 41 (its parsed topic) refused too", (await setDaily(G5, "https://t.me/c/555/41"))?.includes(DAILY_TOPIC_MSG.sameAsModule) === true);
    ok("T31 the module guard sorts after the parse trigger", deepEq((await q(db,
      "select tgname from pg_trigger where tgrelid = 'public.group_module_topics'::regclass and not tgisinternal order by tgname")).map((r) => r.tgname),
      ["trg_gmt_parse_topic_id", "trg_gmt_zz_daily_topic_guard"]));

    // the trigger path works for a non-owner caller who has NO execute on the trigger functions or the parser
    await db.exec(`grant select, insert, update on public.groups, public.group_module_topics to authenticated;
                   grant usage on schema public to authenticated;`);
    await db.exec("set role authenticated");
    const asAuth = await errOf(db, `update groups set daily_task_topic_url = 'https://t.me/c/555/24' where id = '${G5}'`);
    const asAuthBad = await errOf(db, `update groups set daily_task_topic_url = 'https://t.me/c/555/1' where id = '${G5}'`);
    const direct = await errOf(db, "select * from challenge_task_parse_topic_url('https://t.me/c/1/2')");
    await db.exec("reset role");
    ok("T32 a non-owner (authenticated) save runs the SECURITY DEFINER trigger", asAuth === null && (await row(G5)).t === 24, asAuth);
    ok("T32 ...and gets the trigger's message on a bad URL", asAuthBad?.includes(DAILY_TOPIC_MSG.general) === true, asAuthBad);
    ok("T33 the parser itself is not callable by authenticated", !!direct && /permission denied/.test(direct), direct);
    await db.exec(`update groups set daily_task_topic_url = 'https://t.me/c/555/21' where id = '${G5}'`);
  }

  // ───────────── V. SQL trigger == TypeScript validator (the admin page's instant message) ─────────────
  console.log("V. dailyTopicError() == what the trigger raises");
  {
    const HW = [null, "", "https://t.me/c/777/9", "https://t.me/c/777/9?thread=31", "https://t.me/c/888/9", "https://t.me/pub/9", "https://t.me/c/777/9/100"];
    const DAILY = [null, "  ", "x", "https://t.me/c/777/1", "https://t.me/c/777/9", "https://t.me/c/777/31", "https://t.me/c/777/100",
      "https://t.me/c/777/21", "https://t.me/c/888/21", "https://t.me/c/777/21/9", "https://t.me/c/777/9000?thread=22", "HTTPS://T.ME/c/777/23"];
    const bad: unknown[] = [];
    for (const hw of HW) for (const d of DAILY) {
      await db.exec(`update groups set homework_topic_url = null, daily_task_topic_url = null where id = '${G7}'`);
      const e = await errOf(db, "update groups set homework_topic_url = $1, daily_task_topic_url = $2 where id = $3", [hw, d, G7]);
      const expected = dailyTopicError(d, hw);
      const sqlMsg = e ? Object.values(DAILY_TOPIC_MSG).find((m) => e.includes(m)) ?? e : null;
      if (sqlMsg !== expected) bad.push({ hw, d, sql: sqlMsg, ts: expected });
    }
    ok(`${HW.length * DAILY.length} (homework, daily) pairs: the TS validator predicts the trigger exactly`, bad.length === 0, bad);
    await db.exec(`update groups set homework_topic_url = null, daily_task_topic_url = null where id = '${G7}'`);
  }

  // ───────────── R. read functions ─────────────
  console.log("R. challenge_task_topics / my_daily_task_topic_url / admin_topic_lookup");
  {
    let t = await q(db, "select group_id, chat_id::text c, thread_id::int th, is_test from challenge_task_topics() order by thread_id");
    ok("R1 topics(): the 4 scope groups (the 5.0 group with a URL is NOT in scope)", deepEq(t.map((r) => [r.group_id, r.th, r.is_test]),
      [[G4, D4, false], [G3, D3, false], [G2, D2, false], [G1, D1, false]]) &&
      t.every((r) => r.c === String(CHAT_OF[r.group_id])), t);
    await db.query("update platform_settings set value = jsonb_set(value, '{test_group_ids}', $1::jsonb) where key = 'challenge_tasks'",
      [JSON.stringify([G5, "not-a-uuid", 7, G1])]);
    t = await q(db, "select group_id, thread_id::int th, is_test from challenge_task_topics() order by thread_id");
    ok("R2 test_group_ids adds the test group (is_test), junk elements are ignored, a scope group stays is_test=false",
      t.length === 5 && t.find((r) => r.group_id === G5)?.is_test === true && t.find((r) => r.group_id === G1)?.is_test === false, t);
    await db.query("update platform_settings set value = jsonb_set(value, '{test_group_ids}', '\"oops\"'::jsonb) where key = 'challenge_tasks'");
    ok("R3 a non-array test_group_ids does not break it", (await q(db, "select * from challenge_task_topics()")).length === 4);
    await db.query("update platform_settings set value = jsonb_set(value, '{test_group_ids}', '[]'::jsonb) where key = 'challenge_tasks'");

    await db.exec("grant usage on schema auth to authenticated");
    const asUser = async (uid: string | null, sql: string, role = "authenticated") => {
      await db.exec(`select set_config('request.jwt.claim.sub', '${uid ?? ""}', false)`);
      await db.exec(`set role ${role}`);
      try { return { v: (await one(db, sql)), e: null as string | null }; }
      catch (e) { return { v: null, e: String((e as Error).message) }; }
      finally { await db.exec("reset role"); await db.exec("select set_config('request.jwt.claim.sub', '', false)"); }
    };
    ok("R4 my_daily_task_topic_url(): a 6.0 student gets their group's link",
      (await asUser(S1, "select my_daily_task_topic_url() u")).v?.u === "https://t.me/c/4440955972/144");
    ok("R5 ...a 5.0 student gets NULL (their group is not a daily-task group)", (await asUser(S5, "select my_daily_task_topic_url() u")).v?.u === null);
    ok("R6 ...no session gets NULL", (await asUser(null, "select my_daily_task_topic_url() u")).v?.u === null);
    const anon = await asUser(null, "select my_daily_task_topic_url() u", "anon");
    ok("R7 ...anon cannot call it", !!anon.e && /permission denied/.test(anon.e), anon);

    await db.query(`insert into webhook_inbox (update_type, chat_id, message_id, raw_update) values
      ('message', $1, 144, $2::jsonb), ('message', $1, 150, $3::jsonb), ('message', $1, 151, $4::jsonb)`,
      [CH1, JSON.stringify({ message: { message_id: 144, message_thread_id: 144, forum_topic_created: { name: "KUNLIK VAZIFALAR", icon_color: 1 } } }),
        JSON.stringify({ message: { message_id: 150, message_thread_id: 144, forum_topic_edited: { name: "KUNLIK VAZIFALAR ✅" } } }),
        JSON.stringify({ message: { message_id: 151, message_thread_id: 144, forum_topic_edited: { icon_custom_emoji_id: "1" } } })]);
    ok("R8 admin_topic_lookup: the newest rename wins (an icon-only edit is ignored)",
      (await asUser(AD, `select admin_topic_lookup(${CH1}, 144) n`)).v?.n === "KUNLIK VAZIFALAR ✅");
    await db.exec("delete from webhook_inbox where message_id = 150");
    ok("R9 ...else the created name", (await asUser(AD, `select admin_topic_lookup(${CH1}, 144) n`)).v?.n === "KUNLIK VAZIFALAR");
    ok("R10 ...an unseen topic is NULL", (await asUser(AD, `select admin_topic_lookup(${CH1}, 77) n`)).v?.n === null);
    const nonAdmin = await asUser(S1, `select admin_topic_lookup(${CH1}, 144) n`);
    ok("R11 ...a non-admin is refused", !!nonAdmin.e && nonAdmin.e.includes("admin only"), nonAdmin);
    await db.exec("delete from webhook_inbox");
  }
  await db.close();

  // ───────────── X. exclusion parity: old (#218 only) vs new, the same traffic ─────────────
  console.log("X. media / chat / answer: 0 in the daily topic, identical everywhere else");
  {
    const dOld = await freshDb();
    await liveWindow(dOld);
    const daily = await seedTraffic(dOld);
    await runReconcilers(dOld);
    const dNew = await freshDb();
    ok("new DB: migration applies", (await applyMine(dNew)) === null);
    await liveWindow(dNew);
    await seedTraffic(dNew);
    await runReconcilers(dNew);

    const oldMedia = await keysOf(dOld, ["challenge_group_media"]), newMedia = await keysOf(dNew, ["challenge_group_media"]);
    const oldChat = await keysOf(dOld, ["challenge_chat"]), newChat = await keysOf(dNew, ["challenge_chat"]);
    const oldCand = await candIds(dOld), newCand = await candIds(dNew);
    ok("X0 before: the daily topic DID pay media (the leak F5 describes)", daily.media.every((k) => oldMedia.includes(k)), oldMedia);
    ok("X0 before: ...and chat, and made an answer candidate", daily.chat.every((k) => oldChat.includes(k)) && oldCand.includes(2013), [oldChat, oldCand]);
    ok("X1 media: new = old minus exactly the daily-topic shares", deepEq(newMedia, oldMedia.filter((k) => !daily.media.includes(k))), [oldMedia, newMedia]);
    ok("X1 ...and something still pays outside it (G1 topic 10, G2 topic 10, G2's own thread 144)",
      deepEq(newMedia, [`ch_img:${CH1}:2001`, `ch_img:${CH2}:3002`, `ch_img:${CH2}:3003`].sort()), newMedia);
    ok("X2 chat: new = old minus exactly the daily-topic messages", deepEq(newChat, oldChat.filter((k) => !daily.chat.includes(k))) &&
      deepEq(newChat, [`ch_chat:${CH1}:2008`, `ch_chat:${CH1}:2010`, `ch_chat:${CH1}:2011`].sort()), [oldChat, newChat]);
    ok("X3 answers: new candidates = old minus exactly the daily-topic answer", deepEq(newCand, oldCand.filter((a) => !daily.answers.includes(a))) &&
      deepEq(newCand, [2011]), [oldCand, newCand]);
    ok("X4 homework-topic and 5.0 traffic pay nothing in either", !oldMedia.some((k) => k.endsWith(":2005") || k.endsWith(":5001")) &&
      !newMedia.some((k) => k.endsWith(":2005") || k.endsWith(":5001")));
    ok("X5 user_xp drift 0 in both", (await drift(dOld)) === 0 && (await drift(dNew)) === 0);
    // clearing the URL opts the group out: the next run pays its daily-topic media again (the kill-switch)
    await dNew.exec(`update groups set daily_task_topic_url = null where id = '${G2}'`);
    await runReconcilers(dNew);
    ok("X6 kill-switch: clearing G2's URL makes its topic pay like any other again",
      (await keysOf(dNew, ["challenge_group_media"])).includes(`ch_img:${CH2}:3001`));
    await dOld.close();
    await dNew.close();
  }

  // ───────────── H. history heal: points already paid in a daily topic before the file lands ─────────────
  console.log("H. heal: leaked media / chat removed, a paid answer voided, unsettled candidates retired");
  {
    const d = await freshDb();
    await liveWindow(d, "live");
    const daily = await seedTraffic(d);
    await runReconcilers(d);
    await judgeAll(d);
    await one(d, "select challenge_qa_apply() a");
    const paid = await q(d, "select answer_msg_id, award_status from challenge_qa_candidates order by answer_msg_id");
    // one more exchange in the daily topic, enqueued but not judged yet
    await post(d, { id: 2014, user: S1, group: G1, thread: D1, text: "Vazifa uchun qaysi rasm formati kerak?", sent: "now() - interval '20 minutes'" });
    await post(d, { id: 2015, user: S2, group: G1, thread: D1, text: "PNG yoki JPG bo'lsa bo'ladi, sifatini saqlang", replyTo: 2014, sent: "now() - interval '19 minutes'" });
    await q(d, "select * from reconcile_challenge_social_xp(now() - interval '2 hours')");
    const allBefore = await keysOf(d, ["challenge_group_media", "challenge_chat", "challenge_answer"]);
    const answersBefore = await keysOf(d, ["challenge_answer"]);
    ok("H0 setup: both answers were paid, the late one is pending", paid.length === 2 && paid.every((r) => r.award_status === "awarded") &&
      (await one(d, "select status from challenge_qa_candidates where answer_msg_id = 2015")).status === "pending" && answersBefore.length === 2, paid);

    const leakedKeys = [...daily.media, ...daily.chat, `ch_chat:${CH1}:2014`, `ch_chat:${CH1}:2015`];
    const leakedMedia = allBefore.filter((k) => daily.media.includes(k)).length;
    const leakedChat = allBefore.filter((k) => k.startsWith("ch_chat:") && leakedKeys.includes(k)).length;
    ok("H0 setup: every daily-topic media share and chat message had been paid", leakedMedia === 4 && leakedChat === 6, [leakedMedia, leakedChat]);
    ok("H1 migration applies over the damage", (await applyMine(d)) === null);
    const allAfter = await keysOf(d, ["challenge_group_media", "challenge_chat", "challenge_answer"]);
    ok("H2 exactly the daily-topic media + chat rows are gone", deepEq(allAfter.filter((k) => !k.startsWith("chelp:")),
      allBefore.filter((k) => !k.startsWith("chelp:") && !leakedKeys.includes(k))), [allBefore, allAfter]);
    const cands = Object.fromEntries((await q(d, "select answer_msg_id, status, skip_reason, award_status from challenge_qa_candidates"))
      .map((r) => [Number(r.answer_msg_id), r]));
    ok("H3 the paid daily-topic answer is voided through challenge_qa_void_award; the other answer keeps its +3",
      cands[2013]?.award_status === "voided" && cands[2011]?.award_status === "awarded" && (await keysOf(d, ["challenge_answer"])).length === 1, cands);
    ok("H4 the unsettled daily-topic candidate is retired (skipped / daily_task_topic)",
      cands[2015]?.status === "skipped" && cands[2015]?.skip_reason === "daily_task_topic", cands[2015]);
    ok("H5 user_xp rebuilt: drift 0", (await drift(d)) === 0);
    const heal = (await one(d, "select details from admin_actions where action = 'challenge_daily_topic_applied'")).details.heal;
    ok("H6 audit counts the heal", heal.media_removed === leakedMedia && heal.chat_removed === leakedChat && heal.answers_voided === 1 &&
      heal.candidates_retired === 1 && heal.students_rebuilt > 0, heal);
    ok("H7 the void left its own 'challenge_answer_voided' audit", (await one(d,
      "select count(*)::int n from admin_actions where action = 'challenge_answer_voided' and details->>'reason' = 'daily_task_topic'")).n === 1);
    const h = (await one(d, "select challenge_social_health() h")).h;
    ok("H8 challenge_social_health() still runs and reports the new skip reason", h?.queue?.skipped_by_reason_24h?.daily_task_topic === 1, h?.queue);
    ok("H9 a replay heals nothing more", (await applyMine(d)) === null && deepEq(await keysOf(d, ["challenge_group_media", "challenge_chat", "challenge_answer"]), allAfter));
    await d.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) throw new Error(`daily_topic_check: ${fail} check(s) failed`);
}

function deepEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as Row), kb = Object.keys(b as Row);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEq((a as Row)[k], (b as Row)[k]));
}
