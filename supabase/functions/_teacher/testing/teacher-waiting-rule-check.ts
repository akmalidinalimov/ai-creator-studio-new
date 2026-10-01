// PGlite harness for 20261001080000_teacher_waiting_rule_and_detectors.sql (teacher follow-ups to #233-#240).
//
//   deno test -A --node-modules-dir=none --no-lock supabase/functions/_teacher/testing/teacher-waiting-rule-check.ts
//   MIG_PATH=<file> ...   tests a draft before it is written into its (edit-guarded) slot.
//
// Builds production's text on a real PostgreSQL (PGlite, PG 17) the way production got it: the committed live
// fixtures of the two harnesses before this one (coteacher_scope.live-2026-09-30.sql, grading_queue.live-2026-09-30.sql)
// with 20260930182000 and 20260930183000 applied on top, plus teacher_group_statistics.live-2026-10-01.sql. Section L
// asserts every function this migration reads or rewrites then has production's md5 (prosrc, and pg_get_functiondef
// for the six it rewrites) and production's ACL, as read on 2026-10-01 — so the pins and the exactly-once replace()
// checks run against the real text. Then:
//   B  the defects, on the live bodies: digest / nudge / daily report / weekly self / group stats count 1 where the
//      badge and the queue count 2; the +20 queue-clear is a candidate while a re-grade waits; the fallback DM has no
//      Mini App button;
//   P  the pins refuse a drifted body of each rewritten function, an edit that no longer matches, and a replay over a
//      tampered rewrite; a refused file changes nothing;
//   A  the file applies, its self-tests pass, one audit row, it replays as a no-op, grants, the cron job, the state row;
//   W  one waiting rule: per (teacher, group) signals = badge = the queue; report / nudge / weekly self / group stats =
//      the queue; the daily report's "📝 Baholash (N)" = the length of the queue it opens;
//   X  queue-clear XP: no +20 while a re-grade waits, paid once it is graded, a past award is never clawed back,
//      totals settle;
//   F  the fallback DM: with the flag on, its keyboard is the drainer's (TypeScript teacherAppButton +
//      submissionDmKeyboard), the url byte for byte; flag off / malformed / a non-private chat -> the pre-migration
//      keyboard, byte for byte; text, purpose, headers and stamping unchanged;
//   K  the migration's keyboard parity cases = TypeScript;
//   D  the detector: faults (and the per-recipient exclusion), opens_missing (window, threshold, flag), tally_missing,
//      the watchdog's DMs / cooldown / recovery / state / liveness, a broken health function.
//
// CI NOTE: named *-check.ts, so CI's `deno test supabase/functions/` never collects it (PGlite needs -A). The keyboard
// parity is ALSO gated in CI by src/test/hw-dm-fallback-keyboard-parity.test.ts and at apply time by the migration's
// own self-test. TEST INFRASTRUCTURE ONLY: no index.ts, never deployed.

import { isRealTopicLink, submissionDmKeyboard } from "../../notify-homework-submission/copy.ts";
import { withTrack } from "../../_shared/miniapp-links.ts";
import { DEFAULT_MINIAPP_BASE } from "../../_shared/miniapp-button.ts";
import { GRADE_APP_LABEL, GRADE_CHAT_LABEL, teacherAppButton, teacherGradePath } from "../../_shared/teacher-miniapp.ts";

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

const granted = (name: "read" | "env" | "net") => {
  try { return Deno.permissions.querySync({ name }).state === "granted"; } catch { return false; }
};
const CAN_RUN = granted("read") && granted("env") && granted("net");

const here = (p: string) => new URL(p, import.meta.url);
const lf = (s: string) => s.replace(/\r\n/g, "\n"); // a Windows checkout is CRLF; production text is LF

// Production, 2026-10-01: md5(replace(prosrc, CR, '')), md5(pg_get_functiondef) for the six this file rewrites, and
// the ACL (sorted). svc = postgres + service_role; auth = + authenticated; anon = + anon.
const PROD: Record<string, { body: string; def?: string; acl: "svc" | "auth" | "anon" }> = {
  "teacher_group_signals(integer,integer)": { body: "d39a752d293d78b717b08837759e2b03", def: "43a82e3ce6a772a2c554eabf3486f7f5", acl: "svc" },
  "teacher_engagement_xp_candidates(integer)": { body: "5722017aad9d568961f055bfeea346ea", def: "a502b32a9f72e29903d0a24034723956", acl: "svc" },
  "teacher_weekly_self(uuid,integer)": { body: "760558b6097397e1692db23dc2947fb0", def: "0cbc9a6fcd7669bee7cebd9bbcd84013", acl: "auth" },
  "teacher_group_statistics(uuid)": { body: "5dd42fce227c1070a9c4829e426b1e69", def: "bb1e424d391a4384334e7a43d57689c9", acl: "auth" },
  "teacher_group_statistics(uuid,uuid)": { body: "41792ee8bb9e733c7784d691d694685c", def: "36cddcf6c178ca559c05e35377ed8012", acl: "auth" },
  "hw_dm_fallback_deliver()": { body: "4025f0407f7bbc7d823c0f14c72ff58b", def: "63145b47abaf62a1e5e0e477d13c8682", acl: "svc" },
  "teacher_groups(uuid)": { body: "bd7f37fa9b449c2612dd8282845efe12", acl: "auth" },
  "teacher_pending_submissions(uuid,uuid)": { body: "f9576555057f74b4c44a0b98da05d4ea", acl: "auth" },
  "teacher_daily_report()": { body: "1acd6aa050687c7ea8b49dcdc28df74f", acl: "auth" },
  "teacher_nudge_signals(integer,integer)": { body: "199c39b086091ad487491b6bdb0c4b05", acl: "svc" },
  "award_teacher_engagement_xp(integer)": { body: "9374f7070b6d2aca18b2f85e7fde68d5", acl: "svc" },
  "teacher_group_pairs()": { body: "23af9c366814f137a2759cbc3dada0de", acl: "svc" },
  "teacher_group_ids(uuid)": { body: "1d12b3f354c6d021fa342edd6f127cbc", acl: "auth" },
  "is_group_teacher(uuid,uuid)": { body: "94f43876ad4f105b1a58a5120ace57ca", acl: "auth" },
  "has_role(uuid,app_role)": { body: "4e852b30ef52ba5263c4e11d1aec8cf0", acl: "anon" },
  "award_xp(uuid,integer,text,text)": { body: "99d10b573c078147c4c2cf0b62b8fa18", acl: "svc" },
  "hw_label(text,text,integer,integer,text)": { body: "2d682b50ee9d7155ddb5a749576d9f54", acl: "svc" },
  "hw_submission_dm_text_uz(text,text,text,integer,integer,text)": { body: "5c57e51fb4b192d9f703bb278db41b0f", acl: "svc" },
};
const REWRITTEN = Object.keys(PROD).slice(0, 6);
const ACL_OF = {
  svc: ["postgres=X/postgres", "service_role=X/postgres"],
  auth: ["authenticated=X/postgres", "postgres=X/postgres", "service_role=X/postgres"],
  anon: ["anon=X/postgres", "authenticated=X/postgres", "postgres=X/postgres", "service_role=X/postgres"],
};

// ids
const C5 = "c5000000-0000-0000-0000-000000000005", C6 = "c6000000-0000-0000-0000-000000000006";
const M5 = "d5000000-0000-0000-0000-000000000005", M6 = "d6000000-0000-0000-0000-000000000006";
const A5A = "a5000000-0000-0000-0000-00000000000a", A5B = "a5000000-0000-0000-0000-00000000000b";
const A6 = "a6000000-0000-0000-0000-000000000006";
const GV = "90000000-0000-0000-0000-00000000000b";  // 2-GURUH VIP 5.0: primary TR
const GP = "90000000-0000-0000-0000-00000000000a";  // 1-GURUH PRE 5.0: primary TF, co-teacher TR
const GC = "90000000-0000-0000-0000-00000000000c";  // AC CHALLENGE | 1-GURUH: co-teacher TC only
const TF = "70000000-0000-0000-0000-0000000000f1", TR = "70000000-0000-0000-0000-0000000000f2";
const TC = "70000000-0000-0000-0000-0000000000f3";
const AD = "a0000000-0000-0000-0000-000000000001", AD2 = "a0000000-0000-0000-0000-000000000002";
const SV1 = "52000000-0000-0000-0000-000000000001", SV2 = "52000000-0000-0000-0000-000000000002";
const SP1 = "51000000-0000-0000-0000-000000000001", SC1 = "53000000-0000-0000-0000-000000000001";
// submissions
const H_SV1 = "e0000000-0000-4000-8000-000000000001";  // GV, ungraded (5 h)
const H_SV2 = "e41e7e3b-8b35-4d9e-8cc4-fa359d7902bb";  // GV, a resubmission awaiting a re-grade (score kept, stale)
const H_SV2B = "e0000000-0000-4000-8000-000000000003"; // GV, graded TODAY by TR
const H_SP1A = "e0000000-0000-4000-8000-000000000004"; // GP, graded TODAY by TF
const H_SP1B = "e0000000-0000-4000-8000-000000000005"; // GP, a resubmission awaiting a re-grade
const H_SC1 = "e0000000-0000-4000-8000-000000000006";  // GC, graded TODAY by TC
/** The start of the current Tashkent day, as SQL. */
const DAY0 = "(((now() at time zone 'Asia/Tashkent')::date)::timestamp at time zone 'Asia/Tashkent')";
const TODAY = "((now() at time zone 'Asia/Tashkent')::date)";

const SCHEMA = `
set timezone = 'UTC';
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant anon, authenticated, service_role to postgres;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges revoke execute on functions from public;
alter default privileges in schema public grant execute on functions to authenticated, service_role;

create schema auth;
grant usage on schema auth to anon, authenticated, service_role;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create function auth.role() returns text language sql stable as $$
  select nullif(current_setting('request.jwt.claim.role', true), '') $$;
grant execute on function auth.uid(), auth.role() to anon, authenticated, service_role;
create table auth.users (id uuid primary key, last_sign_in_at timestamptz);

create schema cron;
create table cron.job (jobid bigserial primary key, jobname text unique, schedule text not null, command text not null,
  active boolean not null default true);
create function cron.schedule(job_name text, schedule text, command text) returns bigint language plpgsql as $$
declare _id bigint;
begin
  insert into cron.job (jobname, schedule, command) values (job_name, schedule, command)
  on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command
  returning jobid into _id;
  return _id;
end $$;
create function cron.unschedule(job_name text) returns boolean language plpgsql as $$
begin
  delete from cron.job where jobname = job_name;
  if not found then raise exception 'could not find valid entry for job ''%''', job_name; end if;
  return true;
end $$;

create type public.app_role as enum ('admin', 'student', 'teacher', 'superadmin');
create type public.user_status as enum ('active', 'inactive', 'archived');
create domain public.citext as text;
create function public.xp_level_for(integer) returns integer language sql immutable as $$ select 1 + $1 / 1000 $$;

create table public.user_roles (id uuid primary key default gen_random_uuid(), user_id uuid not null,
  role public.app_role not null, unique (user_id, role));
create table public.courses (id uuid primary key, title text not null, published boolean not null default true);
create table public.modules (id uuid primary key, course_id uuid not null references public.courses(id) on delete cascade,
  title text not null default 'M', position integer not null default 0);
create table public.lessons (id uuid primary key default gen_random_uuid(), module_id uuid not null references public.modules(id),
  title text not null default 'L', position int not null default 0, published boolean not null default true);
create table public.homework_assignments (id uuid primary key,
  module_id uuid not null references public.modules(id) on delete cascade, title text not null,
  max_score smallint not null default 10, task_number integer not null default 1, is_active boolean not null default true,
  parent_id uuid, sap_number integer);
create table public.groups (id uuid primary key, name text not null, course_id uuid, teacher_id uuid, homework_topic_id bigint);
create table public.group_teachers (group_id uuid not null, teacher_id uuid not null, is_primary boolean not null default false,
  created_at timestamptz not null default now(), created_by uuid, primary key (group_id, teacher_id));
create table public.profiles (id uuid primary key, name text, last_name text, email text, group_id uuid,
  status public.user_status not null default 'active', archived_at timestamptz, telegram_id bigint,
  telegram_username public.citext, preferred_locale text default 'uz', notifications_enabled boolean default true,
  created_at timestamptz not null default now());
create table public.homework_submissions (id uuid primary key default gen_random_uuid(), assignment_id uuid not null,
  user_id uuid not null, submitted_at timestamptz not null default now(), score smallint, score_feedback text,
  scored_by uuid, scored_at timestamptz, attempt_number int not null default 1,
  previous_attempts jsonb not null default '[]'::jsonb, score_is_stale boolean not null default false,
  previous_score integer, media jsonb, submitted_image_url text);
create table public.group_message_events (id uuid primary key default gen_random_uuid(), group_id uuid not null,
  module_id uuid, profile_id uuid, telegram_user_id bigint not null, telegram_chat_id bigint not null,
  telegram_message_id bigint not null, telegram_thread_id bigint, sent_at timestamptz not null,
  reply_to_message_id bigint, reply_to_user_id bigint, mentions_teacher boolean not null default false,
  has_ustoz boolean not null default false, is_anon_admin boolean not null default false);
create table public.xp_events (id uuid primary key default gen_random_uuid(), user_id uuid not null, amount int not null,
  reason text not null, ref_key text not null, created_at timestamptz not null default now(), unique (user_id, ref_key));
create table public.user_xp (user_id uuid primary key, total_xp int not null, level int not null,
  updated_at timestamptz not null default now());
create table public.auth_events (id uuid primary key default gen_random_uuid(), user_id uuid not null, event text not null,
  created_at timestamptz not null default now());
create table public.lesson_progress (user_id uuid not null, lesson_id uuid not null, updated_at timestamptz not null default now(),
  completed_at timestamptz, primary key (user_id, lesson_id));
create table public.daily_watch_summary (user_id uuid not null, watch_date date not null);
create table public.quiz_attempts (id uuid primary key default gen_random_uuid(), user_id uuid not null, score int);
create table public.streaks (user_id uuid primary key, current_streak int not null default 0);
create table public.nudge_module_celebrations (profile_id uuid not null, module_id uuid not null,
  queued_at timestamptz not null default now(), sent_at timestamptz, primary key (profile_id, module_id));
create table public.admin_actions (id uuid primary key default gen_random_uuid(), actor_user_id uuid, action text not null,
  target_user_id uuid, target_resource_type text, target_resource_id text, details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now());
create table public.homework_teacher_dm_queue (id uuid primary key default gen_random_uuid(), submission_id uuid not null,
  teacher_id uuid not null, student_id uuid not null, group_id uuid not null, module_id uuid not null,
  assignment_id uuid not null, module_number integer not null, task_number integer not null, assignment_title text,
  student_name text, message_url text not null, scheduled_for timestamptz not null default now(),
  queued_for_quiet_hours boolean not null default false, sent_at timestamptz, error text,
  created_at timestamptz not null default now(), retry_count integer not null default 0);
create table public.platform_settings (key text primary key, value jsonb not null, updated_at timestamptz not null default now(),
  updated_by uuid);
create table public.app_settings (key text primary key, value jsonb not null, description text, updated_by uuid,
  updated_at timestamptz not null default now());
create table public.notifications_log (id uuid primary key default gen_random_uuid(), user_id uuid not null,
  notification_type text not null, payload jsonb not null default '{}'::jsonb, sent_at timestamptz not null default now());

create table public.test_sent (id bigserial primary key, url text, body jsonb, headers jsonb, purpose text);
create function public.ops_net_post(p_url text, p_body jsonb default '{}'::jsonb, p_headers jsonb default '{}'::jsonb,
  p_purpose text default null, p_timeout_ms integer default 30000) returns bigint
  language plpgsql security definer set search_path to 'public' as $$
begin
  insert into public.test_sent (url, body, headers, purpose) values (p_url, p_body, p_headers, p_purpose);
  return 1;
end $$;
revoke execute on function public.ops_net_post(text, jsonb, jsonb, text, integer) from public, anon, authenticated;
`;

/** Production's ACL for every function of the fixtures that this harness reads (the rest: service_role only). */
function aclSql(): string {
  let s = `
  do $acl$ declare f regprocedure; begin
    for f in select p.oid::regprocedure from pg_proc p where p.pronamespace = 'public'::regnamespace loop
      execute format('revoke execute on function %s from public, anon, authenticated', f);
      execute format('grant execute on function %s to service_role', f);
    end loop;
  end $acl$;
  grant execute on function public.teacher_pending_submissions() to authenticated;\n`;
  for (const [sig, p] of Object.entries(PROD)) {
    if (sig.startsWith("teacher_pending_submissions(") || sig.startsWith("hw_") && sig !== "hw_dm_fallback_deliver()") continue;
    if (sig.startsWith("teacher_group_signals") || sig.startsWith("teacher_engagement_xp") || sig === "teacher_group_pairs()") continue;
    if (p.acl !== "svc") s += `grant execute on function public.${sig} to authenticated;\n`;
    if (p.acl === "anon") s += `grant execute on function public.${sig} to anon;\n`;
  }
  return s;
}

const SEED = `
insert into public.courses (id, title) values ('${C5}', 'AI CREATORS 5.0'), ('${C6}', 'AI CREATORS CHALLENGE 6.0');
insert into public.modules (id, course_id, title, position) values ('${M5}', '${C5}', '1-MODUL', 0), ('${M6}', '${C6}', '1-MODUL', 0);
insert into public.homework_assignments (id, module_id, title, task_number) values
  ('${A5A}', '${M5}', '1- MODUL: PROMPT ENGINEERING', 1), ('${A5B}', '${M5}', '1- MODUL: 2-VAZIFA', 2),
  ('${A6}', '${M6}', '1- MODUL: PROMPT ENGINEERING', 1);
insert into public.profiles (id, name, telegram_id) values
  ('${TF}', 'Feruza', 101), ('${TR}', 'Rano', 102), ('${TC}', 'Coteacher', 103), ('${AD}', 'Admin', 900), ('${AD2}', 'Owner', 901);
insert into public.user_roles (user_id, role) values
  ('${TF}', 'teacher'), ('${TR}', 'teacher'), ('${TC}', 'teacher'), ('${AD}', 'admin'), ('${AD2}', 'superadmin');
insert into public.groups (id, name, course_id, teacher_id, homework_topic_id) values
  ('${GV}', '2-GURUH VIP 5.0', '${C5}', '${TR}', 7),
  ('${GP}', '1-GURUH PRE 5.0', '${C5}', '${TF}', 7),
  ('${GC}', 'AC CHALLENGE | 1-GURUH', '${C6}', null, 7);
insert into public.group_teachers (group_id, teacher_id, is_primary) values
  ('${GV}', '${TR}', true), ('${GP}', '${TF}', true), ('${GP}', '${TR}', false), ('${GC}', '${TC}', false);
insert into public.profiles (id, name, group_id, telegram_id, telegram_username) values
  ('${SV1}', 'Aziza', '${GV}', 201, 'aziza'), ('${SV2}', 'Bobur', '${GV}', 202, 'bobur'),
  ('${SP1}', 'Dilnoza', '${GP}', 203, null), ('${SC1}', 'Eldor', '${GC}', 204, null);
insert into auth.users (id, last_sign_in_at) select id, now() from public.profiles;
insert into public.homework_submissions (id, assignment_id, user_id, submitted_at, score, score_is_stale, previous_score,
  attempt_number, scored_by, scored_at) values
  ('${H_SV1}', '${A5A}', '${SV1}', now() - interval '5 hours', null, false, null, 1, null, null),
  ('${H_SV2}', '${A5A}', '${SV2}', now() - interval '3 hours', 8, true, 8, 2, '${TR}', now() - interval '70 days'),
  ('${H_SV2B}', '${A5B}', '${SV2}', ${DAY0} + interval '4 seconds', 10, false, null, 1, '${TR}', ${DAY0} + interval '5 seconds'),
  ('${H_SP1A}', '${A5A}', '${SP1}', ${DAY0} + interval '4 seconds', 9, false, null, 1, '${TF}', ${DAY0} + interval '5 seconds'),
  ('${H_SP1B}', '${A5B}', '${SP1}', now() - interval '2 hours', 7, true, 7, 2, '${TF}', now() - interval '20 days'),
  ('${H_SC1}', '${A6}', '${SC1}', ${DAY0} + interval '4 seconds', 10, false, null, 1, '${TC}', ${DAY0} + interval '5 seconds');
-- TF's +20 from YESTERDAY: a past award that no rule change may claw back.
insert into public.xp_events (user_id, amount, reason, ref_key, created_at)
  values ('${TF}', 20, 'teacher_queue_clear', 'tqueueclear:${TF}:' || (${TODAY} - 1)::text, now() - interval '1 day');
insert into public.user_xp (user_id, total_xp, level) values ('${TF}', 20, 1);
insert into public.platform_settings (key, value) values ('telegram', '{"bot_token": "TESTTOKEN"}');
`;

// The overdue queue rows the SQL fallback delivers (TR teaches GV; telegram 102, a private chat).
const QUEUE = `
insert into public.homework_teacher_dm_queue (submission_id, teacher_id, student_id, group_id, module_id, assignment_id,
  module_number, task_number, assignment_title, student_name, message_url, scheduled_for) values
  ('${H_SV1}', '${TR}', '${SV1}', '${GV}', '${M5}', '${A5A}', 1, 1, '1- MODUL: PROMPT ENGINEERING', 'Aziza (@aziza)',
   'https://t.me/aicreatorsdarsliklari_bot?start=hw_x_1', now() - interval '20 minutes'),
  ('${H_SV2}', '${TR}', '${SV2}', '${GV}', '${M5}', '${A5A}', 1, 1, '1- MODUL: PROMPT ENGINEERING', 'Bobur <b> & co',
   'https://t.me/c/2405781239/7/1234', now() - interval '19 minutes');
`;

const HOUR_LINE = "  _tash_hour int := extract(hour from now() + interval '5 hours')::int;\n";

/** Canonical JSON (sorted keys), so a jsonb (keys reordered) compares with a JS object. */
function canon(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
  if (v && typeof v === "object") {
    return "{" + Object.keys(v as Row).sort().map((k) => JSON.stringify(k) + ":" + canon((v as Row)[k])).join(",") + "}";
  }
  return JSON.stringify(v);
}

/** TypeScript's keyboard for the fallback DM: the drainer's, with the fallback's own post label. */
async function tsKeyboard(sub: string, messageUrl: string, app: boolean, chatId = 102): Promise<Row> {
  const gradeApp = app
    ? await teacherAppButton({
      text: GRADE_APP_LABEL.uz, flag: { on: true, watch: true }, chatId, path: teacherGradePath(sub),
      src: "teacher_hw_dm", ref: sub, fn: "teacher-waiting-rule-check", base: DEFAULT_MINIAPP_BASE,
    })
    : null;
  const kb = submissionDmKeyboard("uz", {
    submissionId: sub, messageUrl, guessed: false, gradeApp, chatLabel: GRADE_CHAT_LABEL.uz,
  });
  return {
    inline_keyboard: kb.inline_keyboard.map((row) =>
      row.map((b) => (typeof b.url === "string" && isRealTopicLink(b.url) ? { ...b, text: "📂 Postni ko'rish" } : b))
    ),
  };
}

Deno.test({
  name: CAN_RUN
    ? "teacher_waiting_rule_and_detectors: 20261001080000 on PGlite (one waiting rule, queue-clear XP, fallback 🎯 button, teacher button detector)"
    : "teacher_waiting_rule_and_detectors: SKIPPED -- needs `deno test -A --node-modules-dir=none` (PGlite reads its own files)",
  ignore: !CAN_RUN,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: run,
});

async function run() {
  const spec = "npm:@electric-sql/pglite@" + "0.5.8"; // non-literal: never resolved or type-checked unless this runs
  // deno-lint-ignore no-explicit-any
  const { PGlite } = (await import(spec)) as any;

  const COTEACH = lf(await Deno.readTextFile(here("../../_teachers/testing/coteacher_scope.live-2026-09-30.sql")));
  const GRADING = lf(await Deno.readTextFile(here("./grading_queue.live-2026-09-30.sql")));
  const STATS = lf(await Deno.readTextFile(here("./teacher_group_statistics.live-2026-10-01.sql")));
  const MIG182 = lf(await Deno.readTextFile(here("../../../migrations/20260930182000_grading_queue_course_filter.sql")));
  const MIG183 = lf(await Deno.readTextFile(here("../../../migrations/20260930183000_coteachers_counted_everywhere.sql")));
  const MIG_PATH = Deno.env.get("MIG_PATH");
  const MIG = lf(await Deno.readTextFile(MIG_PATH ?? here("../../../migrations/20261001080000_teacher_waiting_rule_and_detectors.sql")));

  let pass = 0, fail = 0;
  const ok = (name: string, cond: boolean, detail?: unknown) => {
    if (cond) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}${detail !== undefined ? "  — " + JSON.stringify(detail) : ""}`); }
  };
  // deno-lint-ignore no-explicit-any
  type Db = any;
  const q = async (db: Db, sql: string, params: unknown[] = []): Promise<Row[]> => (await db.query(sql, params)).rows;
  const one = async (db: Db, sql: string, params: unknown[] = []): Promise<Row> => (await q(db, sql, params))[0];
  /** The deploy pipeline sends the whole file as one query: one implicit transaction. */
  const tx = async (db: Db, sql: string): Promise<string | null> => {
    try { await db.exec("begin;\n" + sql + "\ncommit;"); return null; }
    catch (e) { try { await db.exec("rollback;"); } catch { /* none open */ } return String((e as Error).message); }
  };
  /** Runs `sql` in its own transaction as `role` with auth.uid() = uid (the PostgREST shape). */
  const as = async (db: Db, role: string, uid: string | null, sql: string, params: unknown[] = []):
    Promise<{ rows: Row[] | null; err: string | null }> => {
    try {
      // deno-lint-ignore no-explicit-any
      const rows = await db.transaction(async (t: any) => {
        await t.query("select set_config('request.jwt.claim.sub', $1, true)", [uid ?? ""]);
        await t.query("select set_config('request.jwt.claim.role', $1, true)", [role]);
        await t.exec(`set local role ${role}`);
        return (await t.query(sql, params)).rows as Row[];
      });
      return { rows, err: null };
    } catch (e) {
      return { rows: null, err: String((e as Error).message) };
    }
  };
  /** Production before this migration: the fixtures, then 20260930182000 and 20260930183000, as deployed. */
  const liveDb = async (seed = true): Promise<Db> => {
    const db = await PGlite.create();
    await db.exec(SCHEMA);
    // The fixtures are in name order, not dependency order (as a dump would load them).
    await db.exec("set check_function_bodies = off;\n" + COTEACH + "\n" + GRADING + "\n" + STATS + "\nset check_function_bodies = on;");
    await db.exec(aclSql());
    for (const [name, m] of [["20260930182000", MIG182], ["20260930183000", MIG183]] as const) {
      const e = await tx(db, m);
      if (e) throw new Error(`the chain did not apply: ${name}: ${e}`);
    }
    if (seed) await db.exec(SEED);
    return db;
  };
  const sigOf = (s: string) => `public.${s}`;
  const md5s = async (db: Db, sig: string) =>
    await one(db, `select md5(pg_get_functiondef(oid)) def, md5(replace(prosrc, E'\\r', '')) body,
                          array(select x::text from unnest(proacl) x order by 1) acl, prosecdef, proconfig, provolatile
                     from pg_proc where oid = to_regprocedure($1)`, [sigOf(sig)]);
  const defs = async (db: Db) =>
    await q(db, `select p.oid::regprocedure::text sig, md5(pg_get_functiondef(p.oid)) d,
                        array(select x::text from unnest(p.proacl) x order by 1) acl
                   from pg_proc p where p.pronamespace = 'public'::regnamespace order by 1`);
  /** A copy of the STORED fallback with the Tashkent-hour gate pinned to noon, so it runs at any hour. */
  const noonCopy = async (db: Db) => {
    const def = (await one(db, "select pg_get_functiondef('public.hw_dm_fallback_deliver()'::regprocedure) d")).d as string;
    if (def.split(HOUR_LINE).length !== 2) throw new Error("hour line not found exactly once");
    await db.exec(def.replace(HOUR_LINE, "  _tash_hour int := 12;\n")
      .replace("FUNCTION public.hw_dm_fallback_deliver()", "FUNCTION public.hw_dm_fallback_deliver_at_noon()"));
  };
  /** Deliver the QUEUE rows through a noon copy; returns the teacher DMs sent (by submission id). */
  const deliver = async (db: Db, flag: string | null): Promise<Map<string, Row>> => {
    await db.exec("delete from public.homework_teacher_dm_queue; delete from public.test_sent; delete from public.notifications_log;");
    await db.exec("delete from public.platform_settings where key = 'teacher_miniapp'");
    if (flag !== null) await db.query("insert into public.platform_settings (key, value) values ('teacher_miniapp', $1::jsonb)", [flag]);
    await db.exec(QUEUE);
    await noonCopy(db);
    await db.exec("select public.hw_dm_fallback_deliver_at_noon()");
    const sent = await q(db, "select body, headers, purpose from public.test_sent where body ? 'reply_markup' order by id");
    const subs = await q(db, "select submission_id::text s, telegram_id from public.homework_teacher_dm_queue q join public.profiles p on p.id = q.teacher_id order by scheduled_for");
    // the two rows go out in scheduled_for order: H_SV1 first, then H_SV2
    return new Map(sent.map((r, i) => [subs[i]?.s as string, r]));
  };
  const counts = async (db: Db) => {
    const sig = await q(db, "select teacher_id, group_id, pending_homework from public.teacher_group_signals(8, 3)");
    const rep = await q(db, "select teacher_id, ungraded_backlog from public.teacher_daily_report()");
    const nud = await q(db, "select teacher_id, pending_homework from public.teacher_nudge_signals(8, 3)");
    return {
      sig: (t: string, g: string) => sig.find((r) => r.teacher_id === t && r.group_id === g)?.pending_homework,
      rep: (t: string) => rep.find((r) => r.teacher_id === t)?.ungraded_backlog,
      nud: (t: string) => nud.find((r) => r.teacher_id === t)?.pending_homework,
    };
  };
  const badge = async (db: Db, uid: string, g: string) => {
    const r = await as(db, "authenticated", uid, "select * from public.teacher_groups($1)", [uid]);
    return (r.rows ?? []).find((x) => x.group_id === g)?.pending_homework;
  };
  const queue = async (db: Db, uid: string) => {
    const r = await as(db, "authenticated", uid, "select submission_id, group_id from public.teacher_pending_submissions()");
    return r.rows ?? [];
  };
  const weekly = async (db: Db, uid: string) =>
    (await as(db, "authenticated", uid, "select * from public.teacher_weekly_self($1, 7)", [uid])).rows?.[0];
  const stats2 = async (db: Db, caller: string, g: string) =>
    (await as(db, "service_role", null, "select public.teacher_group_statistics($1, $2) s", [g, caller])).rows?.[0]?.s;
  /**
   * The one-argument overload, through a renamed copy of its STORED text: a one-argument call cannot reach it in
   * Postgres either (teacher_group_statistics(uuid, uuid DEFAULT NULL) makes it "not unique"), so it is effectively
   * unreachable in production; it gets the same rule anyway so it can never disagree if it is ever called by name.
   */
  const stats1 = async (db: Db, caller: string, g: string) => {
    const def = (await one(db, "select pg_get_functiondef('public.teacher_group_statistics(uuid)'::regprocedure) d")).d as string;
    await db.exec(def.replace("FUNCTION public.teacher_group_statistics(p_group_id uuid)", "FUNCTION public.tgs_one_copy(p_group_id uuid)") +
      ";\ngrant execute on function public.tgs_one_copy(uuid) to authenticated;");
    return (await as(db, "authenticated", caller, "select public.tgs_one_copy($1::uuid) s", [g])).rows?.[0]?.s;
  };
  const clearCandidates = async (db: Db) =>
    (await q(db, "select teacher_id from public.teacher_engagement_xp_candidates(26) where reason = 'teacher_queue_clear' order by 1"))
      .map((r) => r.teacher_id as string);

  // ───────────── L. the chain is production's text ─────────────
  console.log("L. the fixtures + 20260930182000 + 20260930183000 reproduce production, byte for byte");
  let preDm: Map<string, Row>;
  {
    const db = await liveDb();
    for (const [sig, want] of Object.entries(PROD)) {
      const m = await md5s(db, sig);
      ok(`L ${sig}: body md5 = production${want.def ? " (and pg_get_functiondef)" : ""}`,
        !!m && m.body === want.body && (!want.def || m.def === want.def), m && { body: m.body, def: m.def });
      ok(`L ${sig}: ACL = production (${want.acl})`, !!m && JSON.stringify(m.acl) === JSON.stringify(ACL_OF[want.acl]), m?.acl);
    }
    preDm = await deliver(db, null);
    await db.close();
  }

  // ───────────── B. the defects on the live bodies ─────────────
  console.log("B. the defects reproduce on the live bodies (before this migration)");
  {
    const db = await liveDb();
    const c = await counts(db);
    ok("B1 live: the badge counts GV = 2 (an ungraded + a re-grade), the signals 1",
      (await badge(db, TR, GV)) === 2 && c.sig(TR, GV) === 1, { badge: await badge(db, TR, GV), sig: c.sig(TR, GV) });
    ok("B2 live: GP's waiting re-grade is in the badge (1) but not in the signals of either teacher (0)",
      (await badge(db, TF, GP)) === 1 && c.sig(TF, GP) === 0 && c.sig(TR, GP) === 0);
    const qTR = await queue(db, TR);
    ok("B3 live: the daily report's backlog (the 📝 Baholash (N) count) says 1, the queue it opens has 3",
      c.rep(TR) === 1 && qTR.length === 3, { rep: c.rep(TR), queue: qTR.length });
    ok("B4 live: the nudge says 1", c.nud(TR) === 1);
    ok("B5 live: teacher_weekly_self's backlog says 1", (await weekly(db, TR))?.ungraded_backlog === 1);
    ok("B6 live: teacher_group_statistics(GV) pending says 1 (both overloads)",
      (await stats2(db, TR, GV))?.pending_homework_count === 1 && (await stats1(db, TR, GV))?.pending_homework_count === 1);
    ok("B7 live: the +20 queue-clear goes to TF although GP's re-grade waits (candidates TF, TC)",
      JSON.stringify(await clearCandidates(db)) === JSON.stringify([TF, TC].sort()), await clearCandidates(db));
    ok("B8 live: the fallback DM has no Mini App button",
      ![...preDm.values()].some((r) => JSON.stringify(r.body.reply_markup).includes("web_app")) && preDm.size === 2);
    await db.close();
  }

  // ───────────── P. the pins ─────────────
  console.log("P. refuses a drifted body, an edit that no longer matches, a tampered replay; a refused file changes nothing");
  for (const sig of REWRITTEN) {
    const db = await liveDb(false);
    const def = (await one(db, "select pg_get_functiondef(to_regprocedure($1)) d", [sigOf(sig)])).d as string;
    const i = def.lastIndexOf("$function$");
    await db.exec(def.slice(0, i) + "-- drift\n" + def.slice(i));
    const e = await tx(db, MIG);
    ok(`P ${sig}: a changed body aborts with 'regenerate'`, !!e && e.includes(`ABORT: public.${sig} changed since it was verified`), e);
    const still = await one(db, `select to_regprocedure('public.teacher_button_health()') is null no_helper,
      (select count(*) from cron.job where jobname = 'teacher-button-watchdog')::int jobs,
      (select count(*) from public.app_settings)::int states,
      (select count(*) from pg_proc where prosrc like '%(20261001080000)%')::int marked`);
    ok(`P ${sig}: ...and nothing was changed (no helper, no job, no state, no rewrite)`,
      still.no_helper && still.jobs === 0 && still.states === 0 && still.marked === 0, still);
    await db.close();
  }
  {
    const db = await liveDb(false);
    // String.replace swaps the FIRST occurrence: the (uuid) overload's old text.
    const broken = MIG.replace("$t$  WHERE p.group_id = p_group_id AND hs.score IS NULL;$t$",
      "$t$  WHERE p.group_id = p_group_id AND hs.score IS NULLX;$t$");
    ok("P (setup) the edit text was found to break", broken !== MIG);
    const e = await tx(db, broken);
    ok("P an edit that no longer matches exactly once -> ABORT",
      /public\.teacher_group_statistics\(uuid\) edit 1 matched 0 times/.test(e ?? ""), e);
    const marked = await one(db, "select count(*)::int n from pg_proc where prosrc like '%(20261001080000)%'");
    ok("P ...and the rewrites before it were rolled back too", marked.n === 0, marked);
    await db.close();
  }

  // ───────────── A. the migration ─────────────
  console.log("A. the file applies, audits once, replays as a no-op");
  const db = await liveDb();
  const before = new Map((await defs(db)).map((r) => [r.sig as string, r]));
  {
    const err = await tx(db, MIG);
    ok("A1 the migration applies (with its self-tests) on production's text", err === null, err);
    if (err) {
      console.log(`\n${pass} passed, ${fail} failed (stopped: the migration did not apply)`);
      throw new Error("the migration did not apply");
    }
    for (const sig of REWRITTEN) {
      const m = await md5s(db, sig);
      console.log(`      new body md5 ${sig} = ${m.body}`);
      const b = before.get(sig); // regprocedure::text: no schema (public is on the search_path), no spaces
      ok(`A2 ${sig}: ACL / SECURITY DEFINER / search_path unchanged (production's)`,
        JSON.stringify(m.acl) === JSON.stringify(ACL_OF[PROD[sig].acl]) && JSON.stringify(m.acl) === JSON.stringify(b?.acl) &&
          m.prosecdef === true && JSON.stringify(m.proconfig) === JSON.stringify(["search_path=public"]), { m, before: b?.acl });
    }
    const audit = await q(db, "select details from public.admin_actions where action = 'teacher_waiting_rule_applied'");
    const d = audit[0]?.details;
    ok("A3 one audit row: 6 rewritten, 4 new, 2 stale re-grades waiting", audit.length === 1 && d.rewritten.length === 6 &&
      d.new.length === 4 && d.stale_regrades_waiting_now === 2, d);
    ok("A4 audit: GV 1 -> 2 and GP 0 -> 1 change; queue-clear candidates now 1 (TC)",
      d?.groups_whose_count_changes?.["2-GURUH VIP 5.0"]?.score_is_null === 1 &&
        d?.groups_whose_count_changes?.["2-GURUH VIP 5.0"]?.queue_rule === 2 &&
        d?.groups_whose_count_changes?.["1-GURUH PRE 5.0"]?.queue_rule === 1 && d?.queue_clear_candidates_now === 1, d);
    const job = await q(db, "select schedule, command from cron.job where jobname = 'teacher-button-watchdog'");
    ok("A5 cron: teacher-button-watchdog hourly at :33", job.length === 1 && job[0].schedule === "33 * * * *" &&
      /select public\.teacher_button_watchdog\(\)/.test(job[0].command), job);
    const st = (await one(db, "select value from public.app_settings where key = 'teacher_button_watchdog_state'"))?.value;
    ok("A6 the state row is seeded (alerting false, first_checked_at, flag_on_since — the flag row is absent = on, checked_at)",
      st && st.alerting === false && !!st.first_checked_at && !!st.flag_on_since && !!st.checked_at && st.seeded_by === "20261001080000", st);
    const g = await q(db, `select p, has_function_privilege('anon', p::regprocedure, 'EXECUTE') a,
        has_function_privilege('authenticated', p::regprocedure, 'EXECUTE') u,
        has_function_privilege('service_role', p::regprocedure, 'EXECUTE') s,
        (select prosecdef from pg_proc where oid = p::regprocedure) sd
      from unnest(array['public.teacher_miniapp_enabled()', 'public.hw_dm_fallback_keyboard(uuid,text,boolean)',
                        'public.teacher_button_health()', 'public.teacher_button_watchdog()']) p`);
    ok("A7 the four new functions: service_role only; only the watchdog is SECURITY DEFINER",
      g.every((r) => !r.a && !r.u && r.s) && g.filter((r) => r.sd).map((r) => r.p).join() === "public.teacher_button_watchdog()", g);
    const defs1 = await defs(db);
    const err2 = await tx(db, MIG);
    ok("A8 replay: applies again without error", err2 === null, err2);
    const defs2 = await defs(db);
    ok("A9 replay: every function definition and ACL is byte-identical", JSON.stringify(defs1) === JSON.stringify(defs2));
    const n = await one(db, `select (select count(*) from public.admin_actions where action = 'teacher_waiting_rule_applied')::int a,
      (select count(*) from cron.job where jobname = 'teacher-button-watchdog')::int j`);
    ok("A10 replay: still one audit row and one cron job", n.a === 1 && n.j === 1, n);
    const st2 = (await one(db, "select value from public.app_settings where key = 'teacher_button_watchdog_state'"))?.value;
    ok("A11 replay: the state row is not reset", st2?.first_checked_at === st.first_checked_at);

    // A replay over a tampered rewrite (marker kept, body changed) is refused by the new pin.
    const d3 = await liveDb(false);
    ok("A12 (setup) applies on a second database", (await tx(d3, MIG)) === null);
    const def = (await one(d3, "select pg_get_functiondef('public.teacher_weekly_self(uuid,integer)'::regprocedure) d")).d as string;
    await d3.exec(def.replace("awaiting a re-grade", "awaiting a regrade"));
    const e3 = await tx(d3, MIG);
    ok("A13 replay over a tampered rewrite -> ABORT (the new pin)",
      /carries the 20261001080000 marker but not the harness-verified body/.test(e3 ?? ""), e3);
    await d3.close();
  }

  // ───────────── W. one waiting rule ─────────────
  console.log("W. digest, nudge, daily report, weekly self, group stats, badge and queue count the same set");
  {
    const c = await counts(db);
    const pairs = [[TR, GV], [TF, GP], [TR, GP], [TC, GC]] as const;
    for (const [t, g] of pairs) {
      const b = await badge(db, t, g);
      const qn = (await queue(db, t)).filter((r) => r.group_id === g).length;
      ok(`W1 ${t.slice(-2)}/${g.slice(-2)}: signals = badge = the queue (${b})`, c.sig(t, g) === b && b === qn,
        { sig: c.sig(t, g), badge: b, queue: qn });
    }
    for (const t of [TR, TF, TC]) {
      const qn = (await queue(db, t)).length;
      ok(`W2 ${t.slice(-2)}: the daily report's backlog = the "📝 Baholash (N)" count = the queue it opens (${qn})`,
        c.rep(t) === qn, { rep: c.rep(t), queue: qn });
      ok(`W3 ${t.slice(-2)}: the nudge's pending = the queue (${qn})`, c.nud(t) === qn, { nud: c.nud(t), queue: qn });
      ok(`W4 ${t.slice(-2)}: teacher_weekly_self's backlog = the queue (${qn})`, (await weekly(db, t))?.ungraded_backlog === qn);
    }
    ok("W5 TR: GV 2 + GP 1 = 3 everywhere", c.rep(TR) === 3);
    for (const [t, g] of pairs) {
      const b = await badge(db, t, g);
      ok(`W6 ${t.slice(-2)}/${g.slice(-2)}: teacher_group_statistics (both overloads) = the badge (${b})`,
        (await stats2(db, t, g))?.pending_homework_count === b && (await stats1(db, t, g))?.pending_homework_count === b);
    }
    const sig = await q(db, "select pending_homework, oldest_pending_hours from public.teacher_group_signals(8, 3) where group_id = $1", [GV]);
    ok("W7 the oldest waiting age still comes from submitted_at (SV1, ~5 h)", Number(sig[0]?.oldest_pending_hours) >= 4.9, sig);
  }

  // ───────────── X. queue-clear XP ─────────────
  console.log("X. queue-clear XP: never while a re-grade waits; a past award is never clawed back");
  {
    ok("X1 candidates: TC only (TF's GP still has a re-grade waiting)", JSON.stringify(await clearCandidates(db)) === JSON.stringify([TC]),
      await clearCandidates(db));
    await db.exec("select public.award_teacher_engagement_xp(26)");
    const x1 = await q(db, "select user_id, ref_key from public.xp_events where reason = 'teacher_queue_clear' order by 1, 2");
    const yesterday = (await one(db, `select (${TODAY} - 1)::text d`)).d as string;
    ok("X2 award: TC's +20 today; TF's award from yesterday is still there (nothing clawed back)", x1.length === 2 &&
      x1.some((r) => r.user_id === TC) && x1.some((r) => r.user_id === TF && r.ref_key === `tqueueclear:${TF}:${yesterday}`), x1);
    await db.query(`update public.homework_submissions set score = 9, score_is_stale = false, scored_by = $1, scored_at = now()
                    where id = $2`, [TF, H_SP1B]);
    ok("X3 the re-grade done: TF becomes a candidate", (await clearCandidates(db)).includes(TF));
    await db.exec("select public.award_teacher_engagement_xp(26)");
    await db.exec("select public.award_teacher_engagement_xp(26)");
    const x2 = await q(db, "select user_id, count(*)::int n from public.xp_events where reason = 'teacher_queue_clear' group by 1 order by 1");
    ok("X4 TF: yesterday's + today's (2), TC: 1; a re-run mints nothing", x2.find((r) => r.user_id === TF)?.n === 2 &&
      x2.find((r) => r.user_id === TC)?.n === 1, x2);
    const drift = await q(db, `select x.user_id from public.user_xp x
      where x.total_xp <> (select coalesce(sum(amount), 0) from public.xp_events e where e.user_id = x.user_id)`);
    ok("X5 user_xp totals settle (no drift)", drift.length === 0, drift);
    // put the stale re-grade back for the sections below
    await db.query(`update public.homework_submissions set score = 7, score_is_stale = true, scored_at = now() - interval '20 days'
                    where id = $1`, [H_SP1B]);
  }

  // ───────────── F. the fallback DM ─────────────
  console.log("F. the SQL fallback DM: the drainer's 🎯 Mini App row with the flag on; today's keyboard otherwise");
  {
    const on = await deliver(db, null);
    ok("F1 flag row absent (= on, as the edge reader): both DMs sent", on.size === 2);
    for (const [sub, r] of on) {
      const want = await tsKeyboard(sub, sub === H_SV2 ? "https://t.me/c/2405781239/7/1234" : "https://t.me/aicreatorsdarsliklari_bot?start=hw_x_1", true);
      ok(`F2 ${sub.slice(0, 8)}: the keyboard = TypeScript's (teacherAppButton + submissionDmKeyboard)`,
        canon(r.body.reply_markup) === canon(want), { got: r.body.reply_markup, want });
      const url = r.body.reply_markup.inline_keyboard[0][0].web_app?.url;
      ok(`F3 ${sub.slice(0, 8)}: the url = DEFAULT_MINIAPP_BASE + withTrack(teacherGradePath(id), {src, ref})`,
        url === DEFAULT_MINIAPP_BASE + withTrack(teacherGradePath(sub), { src: "teacher_hw_dm", ref: sub }), url);
      ok(`F4 ${sub.slice(0, 8)}: text, purpose, Content-Type and parse_mode as before`,
        r.body.text === preDm.get(sub)?.body.text && r.purpose === "hw_dm_fallback_deliver" &&
          r.headers["Content-Type"] === "application/json" && r.body.parse_mode === "HTML");
      const cb = r.body.reply_markup.inline_keyboard.flat().find((b: Row) => b.callback_data)?.callback_data as string;
      ok(`F5 ${sub.slice(0, 8)}: callback_data fits 64 bytes`, new TextEncoder().encode(cb).length <= 64, cb);
    }
    const st = await q(db, "select error from public.homework_teacher_dm_queue order by scheduled_for");
    ok("F6 the rows are stamped 'sql_fallback_delivery' as before", st.every((r) => r.error === "sql_fallback_delivery"), st);
    const onTrue = await deliver(db, '{"enabled": true}');
    ok("F7 {\"enabled\": true}: the web_app row", [...onTrue.values()].every((r) => !!r.body.reply_markup.inline_keyboard[0][0].web_app));
    for (const flag of ['{"enabled": false}', '{"enabled": "true"}', '{}', '"on"', '{"enabled": 1}']) {
      const off = await deliver(db, flag);
      ok(`F8 ${flag}: today's keyboard, byte for byte the pre-migration DM`, off.size === 2 &&
        [...off.entries()].every(([s, r]) => canon(r.body) === canon(preDm.get(s)?.body)),
        [...off.values()].map((r) => r.body.reply_markup));
    }
    // a non-private chat id (never a teacher's, but teacherAppButton refuses it): no web_app
    await db.query("update public.profiles set telegram_id = -1001 where id = $1", [TR]);
    const neg = await deliver(db, null);
    ok("F9 a non-positive chat id: today's keyboard (teacherAppButton returns null for it)",
      [...neg.values()].every((r) => !JSON.stringify(r.body.reply_markup).includes("web_app")), [...neg.values()].map((r) => r.body.reply_markup));
    ok("F10 ...and TypeScript agrees", (await teacherAppButton({ text: "x", flag: { on: true, watch: true }, chatId: -1001,
      path: teacherGradePath(H_SV1), src: "teacher_hw_dm", ref: H_SV1, fn: "x", base: DEFAULT_MINIAPP_BASE })) === null);
    await db.query("update public.profiles set telegram_id = 102 where id = $1", [TR]);
    await db.exec("delete from public.homework_teacher_dm_queue; delete from public.test_sent; delete from public.notifications_log;");
  }

  // ───────────── K. keyboard parity cases ─────────────
  console.log("K. the migration's keyboard parity cases = TypeScript");
  {
    const block = MIG.split("-- keyboard-parity-cases:begin")[1]?.split("-- keyboard-parity-cases:end")[0] ?? "";
    const cases = JSON.parse(block.split("$kb$")[1] ?? "[]") as Row[];
    ok("K1 the migration carries its keyboard parity cases (>= 7, both flags, a post link and a deep link)",
      cases.length >= 7 && cases.some((c) => c.app) && cases.some((c) => !c.app) &&
        cases.some((c) => isRealTopicLink(c.url)) && cases.some((c) => !isRealTopicLink(c.url)));
    for (const c of cases) {
      const ts = await tsKeyboard(c.sub, c.url, c.app);
      const sql = (await one(db, "select public.hw_dm_fallback_keyboard($1::uuid, $2, $3) k", [c.sub, c.url, c.app])).k;
      ok(`K2 ${c.sub.slice(0, 8)} app=${c.app} ${c.url.slice(0, 18)}: want = TypeScript = SQL`,
        canon(c.want) === canon(ts) && canon(sql) === canon(ts), { want: c.want, ts, sql });
    }
    // fuzz: random ids, every url shape
    let bad = 0;
    for (let i = 0; i < 60; i++) {
      const sub = crypto.randomUUID();
      const url = ["https://t.me/c/1/2/3", "https://t.me/bot?start=x", "", "https://t.me/c/", "t.me/c/1"][i % 5];
      for (const app of [true, false]) {
        const sql = (await one(db, "select public.hw_dm_fallback_keyboard($1::uuid, $2, $3) k", [sub, url, app])).k;
        if (canon(sql) !== canon(await tsKeyboard(sub, url, app))) bad++;
      }
    }
    ok("K3 fuzz: 120 random (id, url, flag) keyboards, SQL = TypeScript", bad === 0, bad);
  }

  // ───────────── D. the detector ─────────────
  console.log("D. teacher_button_health / teacher_button_watchdog");
  {
    const health = async () => (await one(db, "select public.teacher_button_health() h")).h as Row;
    const watchdog = async () => (await one(db, "select public.teacher_button_watchdog() r")).r as Row;
    const state = async () => (await one(db, "select value from public.app_settings where key = 'teacher_button_watchdog_state'")).value as Row;
    const sent = async () => await q(db, "select body, headers, purpose from public.test_sent where purpose = 'teacher_button_watchdog' order by id");
    const reset = async () => {
      await db.exec(`delete from public.test_sent; delete from public.homework_teacher_dm_queue;
        delete from public.admin_actions where action like 'teacher_%' and action <> 'teacher_waiting_rule_applied';
        delete from public.admin_actions where action in ('ungraded_homework_reminder_sent', 'homework_submission_dm_sent');
        delete from public.platform_settings where key = 'teacher_miniapp';`);
    };
    /** Pretend the detector (and the flag) started `h` hours ago. */
    const startedAgo = async (h: number) => {
      await db.query(`update public.app_settings set value = value || jsonb_build_object(
          'first_checked_at', now() - make_interval(hours => $1), 'flag_on_since', now() - make_interval(hours => $1),
          'alerting', false, 'last_alert_ms', 0)
        where key = 'teacher_button_watchdog_state'`, [h]);
    };
    const queueSent = async (n: number, ago: string) => {
      for (let i = 0; i < n; i++) {
        await db.query(`insert into public.homework_teacher_dm_queue (submission_id, teacher_id, student_id, group_id, module_id,
            assignment_id, module_number, task_number, message_url, sent_at, error)
          values ($1, $2, $3, $4, $5, $6, 1, 1, 'https://t.me/c/1/2/3', now() - $7::interval, null)`,
          [H_SV1, TR, SV1, GV, M5, A5A, ago]);
      }
    };
    const act = async (action: string, details: Row, ago = "1 minute") =>
      await db.query(`insert into public.admin_actions (actor_user_id, action, details, created_at)
                      values (null, $1, $2::jsonb, now() - $3::interval)`, [action, JSON.stringify(details), ago]);

    await reset();
    await startedAgo(10);
    let h = await health();
    ok("D1 quiet: no alarm; the flag (absent row) reads on", h.alarm === false && h.flag_on === true, h);

    await act("teacher_miniapp_button_rejected", { fn: "notify-homework-submission", status: 400, error: "Bad Request: BUTTON_TYPE_INVALID" });
    h = await health();
    ok("D2 a Telegram refusal of the button: button_fault", h.button_fault === true && h.alarm === true &&
      h.fault_rows_24h.teacher_miniapp_button_rejected === 1, h);
    await reset(); await startedAgo(10);
    await act("teacher_miniapp_button_rejected", { fn: "telegram-bot-webhook", status: 400, error: "Bad Request: user not found" });
    await act("teacher_miniapp_button_rejected", { fn: "menu_button_sweep", status: 403, error: "Forbidden: bot was blocked by the user" });
    h = await health();
    ok("D3 per-recipient refusals (user not found / blocked) are counted apart and never alarm",
      h.button_fault === false && h.alarm === false && h.fault_rows_recipient_24h === 2, h);
    await act("teacher_miniapp_button_fallback", { fn: "teacher-daily-digest", reason: "bad_base", what: "MINIAPP_BASE" });
    h = await health();
    ok("D4 a malformed MINIAPP_BASE: button_fault", h.button_fault === true && h.fault_rows_24h.teacher_miniapp_button_fallback === 1, h);
    await reset(); await startedAgo(10);
    await act("teacher_miniapp_button_fallback", { fn: "x" }, "25 hours");
    await act("teacher_miniapp_flag_read_failed", { fn: "x", error: "timeout" });
    h = await health();
    ok("D5 a fault older than 24 h is gone; a flag read failure is informational", h.alarm === false && h.flag_read_failed_24h === 1, h);

    await reset(); await startedAgo(10);
    await queueSent(9, "1 hour");
    await act("ungraded_homework_reminder_sent", { recipient_kind: "teacher", buttons: { web_app: 0, callback: 1, rejected: 0 } });
    h = await health();
    ok("D6 9 🎯 buttons, 0 opens: below the threshold (10), no alarm", h.opens_missing === false && h.buttons.grade_buttons === 9, h);
    await act("ungraded_homework_reminder_sent", { recipient_kind: "teacher", buttons: { web_app: 1, callback: 0, rejected: 0 } });
    h = await health();
    ok("D7 10 🎯 buttons (9 DMs + 1 reminder), 0 opens: opens_missing", h.opens_missing === true && h.alarm === true &&
      h.buttons.grade_buttons === 10, h);
    await act("teacher_miniapp_open", { src: "teacher_hw_dm", ref: H_SV1, path: "/tg/teacher/grade" });
    h = await health();
    ok("D8 one tap clears it", h.opens_missing === false && h.opens === 1 && h.opens_by_src.teacher_hw_dm === 1, h);
    await reset(); await startedAgo(10);
    await queueSent(12, "11 hours");
    await queueSent(3, "1 hour");
    h = await health();
    ok("D9 buttons sent before the detector / the switch-on are not counted (3 of 15)", h.buttons.grade_buttons === 3 && h.opens_missing === false, h);
    await reset(); await startedAgo(100);
    await queueSent(12, "80 hours");
    h = await health();
    ok("D10 the window is 72 h at most", h.buttons.grade_buttons === 0, h);
    await reset(); await startedAgo(10);
    await queueSent(12, "1 hour");
    await db.exec(`insert into public.platform_settings (key, value) values ('teacher_miniapp', '{"enabled": false}')`);
    h = await health();
    ok("D11 the flag off: no opens_missing (the buttons are today's)", h.flag_on === false && h.opens_missing === false &&
      h.buttons.grade_buttons === 0, h);

    await reset(); await startedAgo(10);
    await act("teacher_daily_report_run", { teachers: 3, sent: 3, failed: 0 });
    h = await health();
    ok("D12 a daily-report run without its buttons tally: tally_missing", h.tally_missing === true && h.alarm === true, h);
    await reset(); await startedAgo(10);
    await act("teacher_daily_report_run", { teachers: 3, sent: 3, buttons: { web_app: 3, magic_link: 0, rejected: 0 } });
    await act("ungraded_homework_reminder_sent", { recipient_kind: "admin", reminders_sent: 1 });
    h = await health();
    ok("D13 with the tally (and an admin-routed reminder, which has none): no tally_missing", h.tally_missing === false &&
      h.buttons.report_web_app === 3, h);
    await act("ungraded_homework_reminder_sent", { recipient_kind: "teacher", reminders_sent: 1 });
    h = await health();
    ok("D14 a teacher reminder without its tally: tally_missing", h.tally_missing === true, h);
    await reset();
    await db.exec("update public.app_settings set value = value || jsonb_build_object('first_checked_at', now() + interval '1 minute') where key = 'teacher_button_watchdog_state'");
    await act("teacher_daily_report_run", { teachers: 3 }, "2 hours");
    h = await health();
    ok("D15 runs from before the seed never count as missing tallies", h.tally_missing === false, h);

    // the watchdog
    await reset(); await startedAgo(10);
    await db.exec("update public.app_settings set value = value - 'last_alert_ms' - 'alerting' where key = 'teacher_button_watchdog_state'");
    let r = await watchdog();
    let s = await state();
    ok("D16 watchdog, quiet: no DM, state written (alerting false, checked_at now, flag_on_since kept)",
      r.alarm === false && (await sent()).length === 0 && s.alerting === false && !!s.flag_on_since &&
        Date.now() - Date.parse(s.checked_at) < 60_000, s);
    await act("teacher_miniapp_button_rejected", { fn: "notify-homework-submission", status: 400, error: "Bad Request: BUTTON_TYPE_INVALID" });
    r = await watchdog();
    let dms = await sent();
    s = await state();
    ok("D17 alarm: one DM per admin (2), through ops_net_post with Content-Type, purpose teacher_button_watchdog",
      dms.length === 2 && dms.every((d) => d.headers["Content-Type"] === "application/json" && /Ustoz Mini App tugmalari/.test(d.body.text)), dms);
    ok("D18 ...the DM names the fault and the kill-switch, in Uzbek", /teacher_miniapp_button_rejected/.test(dms[0]?.body.text) &&
      /platform_settings\.teacher_miniapp = \{"enabled": false\}/.test(dms[0]?.body.text) && /soʻnggi 24 soatda/.test(dms[0]?.body.text), dms[0]?.body.text);
    const alarmRows = await q(db, "select details from public.admin_actions where action = 'teacher_button_watchdog_ALARM'");
    ok("D19 ...an ALARM row; state alerting with last_alert_ms", alarmRows.length === 1 && s.alerting === true && s.last_alert_ms > 0, s);
    await watchdog();
    ok("D20 still alarming within 6 h: no new DM", (await sent()).length === 2);
    await db.exec(`update public.app_settings set value = value || jsonb_build_object('last_alert_ms',
      ((extract(epoch from now()) * 1000)::bigint - 7 * 3600 * 1000)) where key = 'teacher_button_watchdog_state'`);
    await watchdog();
    ok("D21 after 6 h: re-alerted", (await sent()).length === 4);
    await db.exec("delete from public.admin_actions where action = 'teacher_miniapp_button_rejected'");
    r = await watchdog();
    dms = await sent();
    s = await state();
    ok("D22 cleared: one 'normallashdi' DM per admin, a recovered row, alerting false", r.alarm === false && dms.length === 6 &&
      /normallashdi/.test(dms[5]?.body.text) && s.alerting === false &&
      (await q(db, "select 1 from public.admin_actions where action = 'teacher_button_watchdog_recovered'")).length === 1, dms.slice(4));
    await act("teacher_miniapp_button_rejected", { fn: "x", status: 400, error: "Bad Request: BUTTON_TYPE_INVALID" });
    await db.exec("update public.platform_settings set value = '{}'::jsonb where key = 'telegram'");
    await watchdog();
    s = await state();
    ok("D23 no bot token: no DM, and the cooldown does not start (the next run retries)", (await sent()).length === 6 &&
      s.alerting === true && s.dm_attempted_last_run === 0, s);
    await db.exec(`update public.platform_settings set value = '{"bot_token": "TESTTOKEN"}'::jsonb where key = 'telegram';
                   delete from public.admin_actions where action = 'teacher_miniapp_button_rejected';`);
    await watchdog();
    // the flag's switch-on time
    await db.exec(`insert into public.platform_settings (key, value) values ('teacher_miniapp', '{"enabled": false}')
                   on conflict (key) do update set value = excluded.value`);
    await watchdog();
    ok("D24 the flag off: flag_on_since cleared", (await state()).flag_on_since === null);
    await db.exec(`update public.platform_settings set value = '{"enabled": true}' where key = 'teacher_miniapp'`);
    await watchdog();
    s = await state();
    ok("D25 the flag back on: flag_on_since = now (the window restarts)", !!s.flag_on_since &&
      Date.now() - Date.parse(s.flag_on_since) < 60_000, s.flag_on_since);
    // liveness: hw_dm_health_stats()'s stale-watchdog scan, verbatim
    const scan = `select count(*)::int n, coalesce(string_agg(replace(key, '_watchdog_state', ''), ', ' order by key), '') names
      from public.app_settings where key like '%\\_watchdog\\_state'
        and coalesce((value->>'checked_at')::timestamptz, 'epoch'::timestamptz) < now() - interval '25 hours'`;
    ok("D26 liveness: the state row is under hw_dm_health_stats()'s *_watchdog_state scan, and fresh", (await one(db, scan)).n === 0 &&
      (await one(db, "select count(*)::int n from public.app_settings where key like '%\\_watchdog\\_state'")).n === 1);
    await db.exec(`update public.app_settings set value = value || jsonb_build_object('checked_at', now() - interval '26 hours')
                   where key = 'teacher_button_watchdog_state'`);
    const stale = await one(db, scan);
    ok("D27 ...and a watchdog that stopped is reported as 'teacher_button'", stale.n === 1 && stale.names === "teacher_button", stale);
    // a broken health function is an alarm, never a quiet false
    const hdef = (await one(db, "select pg_get_functiondef('public.teacher_button_health()'::regprocedure) d")).d as string;
    await db.exec(`create or replace function public.teacher_button_health() returns jsonb language plpgsql stable
                   set search_path to 'public' as $x$ begin raise exception 'boom'; end $x$;`);
    await db.exec("delete from public.test_sent");
    r = await watchdog();
    dms = await sent();
    ok("D28 teacher_button_health() raising: alarm + a DM that says so", r.alarm === true && /teacher_button_health\(\) ishlamadi: boom/.test(dms[0]?.body.text ?? ""), dms[0]?.body.text);
    await db.exec(hdef);
  }

  await db.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) throw new Error(`${fail} check(s) failed`);
}
