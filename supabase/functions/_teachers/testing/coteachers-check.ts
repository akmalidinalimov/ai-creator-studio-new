// Applies 20260930183000_coteachers_counted_everywhere.sql to a real PostgreSQL (PGlite) on top of the LIVE
// definitions of the 17 functions it rewrites, reproduces each co-teacher defect on the live code, then drives
// the rewritten functions end to end.
//
//   deno run -A --node-modules-dir=none supabase/functions/_teachers/testing/coteachers-check.ts
//   MIG_PATH=<file> ...   tests a draft before it is written into its (edit-guarded) migration slot.
//
// Run it after ANY change to that migration, and before asking for the migration-approved label.
// TEST INFRASTRUCTURE ONLY: this directory has no index.ts, so it is never deployed, and the file is not named
// *.test.ts, so CI's `deno test supabase/functions/` does not try to fetch PGlite.
//
// Fidelity: coteacher_scope.live-2026-09-30.sql (next to this file) is GENERATED from the repo migrations that last
// defined each function. Section A asserts every body's md5 (CRs stripped) equals production's
// md5(replace(prosrc, CR, '')) read on 2026-09-30, and the language / volatility / SECURITY DEFINER / arguments
// equal production's, so the migration's md5 pins and exactly-once replace() checks run against the real text.
// The tables are stubs carrying the live columns these functions read and write; the ACLs are production's.

import { PGlite } from "npm:@electric-sql/pglite@0.5.8";

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

const here = (p: string) => new URL(p, import.meta.url);
const lf = (s: string) => s.replace(/\r\n/g, "\n");
const LIVE = lf(await Deno.readTextFile(here("./coteacher_scope.live-2026-09-30.sql")));
const MIG_PATH = Deno.env.get("MIG_PATH");
const MIG = lf(await Deno.readTextFile(MIG_PATH ??
  new URL("../../../migrations/20260930183000_coteachers_counted_everywhere.sql", import.meta.url)));

// Production, 2026-09-30: md5(replace(prosrc, E'\r', '')), prosecdef, provolatile, language, arguments, ACL.
const PROD: Record<string, { pin: string; v: string; lang: string; args: string; acl: string }> = {
  "admin_group_module_submissions(uuid,uuid)": { pin: "408b67434cde2493c262f878a3597a41", v: "s", lang: "plpgsql",
    args: "p_caller_profile_id uuid DEFAULT NULL::uuid, p_group_id uuid DEFAULT NULL::uuid", acl: "auth+svc" },
  "teacher_group_top(uuid,uuid,integer)": { pin: "366b6472d9cbd0fc846ac5392736849e", v: "s", lang: "sql",
    args: "uid uuid, _group_id uuid, _limit integer DEFAULT 5", acl: "auth+svc" },
  "admin_export_group_csv(uuid,boolean)": { pin: "0bb5a39080b3f470f5405e41d49d085a", v: "s", lang: "plpgsql",
    args: "_group_id uuid, _include_archived boolean DEFAULT false", acl: "public" },
  "admin_dashboard_students(uuid,timestamp with time zone)": { pin: "b5588f00d420a8fcbe759c74a63ba33f", v: "s",
    lang: "plpgsql", args: "_course_id uuid, _since30 timestamp with time zone", acl: "public" },
  "staff_recent_auth_events(timestamp with time zone)": { pin: "9259b47f6108b106a2bd73965f63f96b", v: "s",
    lang: "plpgsql", args: "_since timestamp with time zone", acl: "anon+auth+svc" },
  "staff_recent_lesson_progress(timestamp with time zone)": { pin: "1f77cf8273ba4e35b7d31348d3dd8b80", v: "s",
    lang: "plpgsql", args: "_since timestamp with time zone", acl: "anon+auth+svc" },
  "staff_top_students(integer)": { pin: "86cade8d4d73a31fa5403ef510ff664e", v: "s", lang: "plpgsql",
    args: "_lim integer DEFAULT 10", acl: "svc" },
  "admin_teacher_groups(uuid,integer,integer)": { pin: "b274f70dbab1fc600562ae87ac36e451", v: "s", lang: "plpgsql",
    args: "p_teacher_id uuid, p_days integer DEFAULT 30, p_sla_min integer DEFAULT 120", acl: "svc" },
  "admin_teacher_unanswered(uuid,integer,integer)": { pin: "2f6119c2faea16cb0815275379f81173", v: "s",
    lang: "plpgsql", args: "p_teacher_id uuid, p_days integer DEFAULT 30, p_sla_min integer DEFAULT 120", acl: "svc" },
  "analytics_teacher_quality(integer)": { pin: "896a8f390ba4222ff9ea28f5ada6b087", v: "s", lang: "sql",
    args: "_min_students integer DEFAULT 5", acl: "auth+svc" },
  "admin_teacher_stats(integer,integer)": { pin: "a22a27311707a2d0362609f9e91ce5eb", v: "s", lang: "plpgsql",
    args: "p_days integer DEFAULT 30, p_sla_min integer DEFAULT 120", acl: "svc" },
  "admin_teacher_weekly(integer,uuid)": { pin: "ea30477a239b98d00ce12107b88ada59", v: "s", lang: "plpgsql",
    args: "p_days integer DEFAULT 7, p_course_id uuid DEFAULT NULL::uuid", acl: "public" },
  "teacher_daily_report()": { pin: "ef0733215c7de6faeb33f384d68ed39a", v: "s", lang: "plpgsql", args: "",
    acl: "auth+svc" },
  "teacher_nudge_signals(integer,integer)": { pin: "7f94d545b538b3a8f26dcf5373ed75d6", v: "s", lang: "sql",
    args: "p_q_hours integer DEFAULT 8, p_window_days integer DEFAULT 3", acl: "svc" },
  "teacher_weekly_self(uuid,integer)": { pin: "a91406c7efbf6f8fcbb2afd7d6ee75dc", v: "s", lang: "plpgsql",
    args: "uid uuid, p_days integer DEFAULT 7", acl: "auth+svc" },
  "award_teacher_engagement_xp(integer)": { pin: "934a501ed3009c21345a333f7048d7a5", v: "v", lang: "plpgsql",
    args: "p_lookback_hours integer DEFAULT 26", acl: "svc" },
  "xp_on_student_module_impact()": { pin: "0b8a63e7a60eb204e1c95f97863e9839", v: "v", lang: "plpgsql", args: "",
    acl: "svc" },
  // called, not rewritten
  "award_xp(uuid,integer,text,text)": { pin: "99d10b573c078147c4c2cf0b62b8fa18", v: "v", lang: "plpgsql",
    args: "_user uuid, _amount integer, _reason text, _ref text", acl: "svc" },
  "has_role(uuid,app_role)": { pin: "4e852b30ef52ba5263c4e11d1aec8cf0", v: "s", lang: "sql",
    args: "_user_id uuid, _role app_role", acl: "anon+auth+svc" },
  "is_group_teacher(uuid,uuid)": { pin: "94f43876ad4f105b1a58a5120ace57ca", v: "s", lang: "sql",
    args: "_group_id uuid, _uid uuid", acl: "auth+svc" },
  "teacher_group_ids(uuid)": { pin: "1d12b3f354c6d021fa342edd6f127cbc", v: "s", lang: "sql", args: "_uid uuid",
    acl: "auth+svc" },
};
const REWRITTEN = Object.keys(PROD).slice(0, 17);

// ids
const C5 = "c5000000-0000-0000-0000-000000000005", C6 = "c6000000-0000-0000-0000-000000000006";
const M5 = "d5000000-0000-0000-0000-000000000005", M6 = "d6000000-0000-0000-0000-000000000006";
const L5 = "e5000000-0000-0000-0000-000000000005";
const A5 = "a5000000-0000-0000-0000-000000000005", A6 = "a6000000-0000-0000-0000-000000000006";
const GP = "90000000-0000-0000-0000-00000000000a";  // 1-GURUH PRE 5.0: primary TF + co-teacher TR
const GV = "90000000-0000-0000-0000-00000000000b";  // 2-GURUH VIP 5.0: primary TR
const GC = "90000000-0000-0000-0000-00000000000c";  // AC CHALLENGE | 1-GURUH: NO primary, co-teacher TC only
const GX = "90000000-0000-0000-0000-00000000000d";  // 1-GURUH VIP 5.0: primary TG, no co-teacher
const TF = "70000000-0000-0000-0000-0000000000f1", TR = "70000000-0000-0000-0000-0000000000f2";
const TC = "70000000-0000-0000-0000-0000000000f3", TG = "70000000-0000-0000-0000-0000000000f4";
const AD = "a0000000-0000-0000-0000-000000000001";
const SP1 = "51000000-0000-0000-0000-000000000001", SP2 = "51000000-0000-0000-0000-000000000002";
const SP3 = "51000000-0000-0000-0000-000000000003", SV1 = "52000000-0000-0000-0000-000000000001";
const SC1 = "53000000-0000-0000-0000-000000000001", SX1 = "54000000-0000-0000-0000-000000000001";
const SNG = "59000000-0000-0000-0000-000000000009";   // no group
const CHAT = { GP: -1001, GV: -1002, GC: -1003, GX: -1004 } as const;
const ANON_BOT = 1087968824;
/** The start of the current Tashkent day, as SQL. */
const DAY0 = "(((now() at time zone 'Asia/Tashkent')::date)::timestamp at time zone 'Asia/Tashkent')";

const SCHEMA = `
set timezone = 'UTC';
create role anon; create role authenticated; create role service_role;
create type public.app_role as enum ('admin', 'student', 'teacher', 'superadmin');
create type public.user_status as enum ('active', 'inactive', 'archived');
create domain public.citext as text;
create schema auth;
create function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create function auth.role() returns text language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.role', true), '')::text $$;
create table auth.users (id uuid primary key, last_sign_in_at timestamptz);
create function public.xp_level_for(integer) returns integer language sql immutable as $$ select 1 + $1 / 1000 $$;

create table public.courses (id uuid primary key, title text not null, published boolean not null default true);
create table public.modules (id uuid primary key, course_id uuid not null, title text not null, position int not null default 0);
create table public.lessons (id uuid primary key, module_id uuid not null, title text not null default 'L',
  position int not null default 0, published boolean not null default true);
create table public.homework_assignments (id uuid primary key, module_id uuid not null, title text not null,
  max_score smallint not null default 10, task_number int not null default 1, is_active boolean not null default true);
create table public.groups (id uuid primary key, name text not null, course_id uuid, teacher_id uuid,
  homework_topic_id bigint);
create table public.group_teachers (group_id uuid not null, teacher_id uuid not null, is_primary boolean not null default false,
  created_at timestamptz not null default now(), created_by uuid, primary key (group_id, teacher_id));
create table public.profiles (id uuid primary key, name text, last_name text, email text, group_id uuid,
  status public.user_status not null default 'active', archived_at timestamptz, telegram_id bigint,
  telegram_username public.citext, preferred_locale text default 'uz', notifications_enabled boolean default true,
  created_at timestamptz not null default now());
create table public.user_roles (id uuid primary key default gen_random_uuid(), user_id uuid not null,
  role public.app_role not null);
create table public.homework_submissions (id uuid primary key default gen_random_uuid(), assignment_id uuid not null,
  user_id uuid not null, submitted_at timestamptz not null default now(), score smallint, score_feedback text,
  scored_by uuid, scored_at timestamptz, attempt_number int not null default 1,
  previous_attempts jsonb not null default '[]'::jsonb, score_is_stale boolean not null default false);
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
create table public.quiz_attempts (id uuid primary key default gen_random_uuid(), user_id uuid not null, score int);
create table public.streaks (user_id uuid primary key, current_streak int not null default 0);
create table public.nudge_module_celebrations (profile_id uuid not null, module_id uuid not null,
  queued_at timestamptz not null default now(), sent_at timestamptz, primary key (profile_id, module_id));
create table public.admin_actions (id uuid primary key default gen_random_uuid(), actor_user_id uuid, action text not null,
  target_user_id uuid, target_resource_type text, target_resource_id text, details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now());
`;

// production's ACLs: svc = postgres + service_role; auth+svc adds authenticated; anon+auth+svc adds anon;
// public = PUBLIC + anon + authenticated + service_role.
function aclSql(): string {
  let s = "";
  for (const [sig, p] of Object.entries(PROD)) {
    const f = `public.${sig}`;
    s += `revoke execute on function ${f} from public, anon, authenticated;\n`;
    s += `grant execute on function ${f} to service_role;\n`;
    if (p.acl !== "svc") s += `grant execute on function ${f} to authenticated;\n`;
    if (p.acl === "anon+auth+svc" || p.acl === "public") s += `grant execute on function ${f} to anon;\n`;
    if (p.acl === "public") s += `grant execute on function ${f} to public;\n`;
  }
  return s;
}

const SEED = `
insert into public.courses (id, title) values ('${C5}', 'AI CREATORS 5.0'), ('${C6}', 'AI CREATORS CHALLENGE 6.0');
insert into public.modules (id, course_id, title, position) values ('${M5}', '${C5}', '1-MODUL', 0), ('${M6}', '${C6}', '1-MODUL', 0);
insert into public.lessons (id, module_id) values ('${L5}', '${M5}');
insert into public.homework_assignments (id, module_id, title) values ('${A5}', '${M5}', 'T5'), ('${A6}', '${M6}', 'T6');
insert into public.profiles (id, name, telegram_id, telegram_username) values
  ('${TF}', 'Feruza', 101, 'feruza'), ('${TR}', 'Rano', 102, 'rano'), ('${TC}', 'Coteacher', 103, 'coteacher'),
  ('${TG}', 'Guli', 104, 'guli'), ('${AD}', 'Admin', 900, 'admin');
insert into public.user_roles (user_id, role) values
  ('${TF}', 'teacher'), ('${TR}', 'teacher'), ('${TC}', 'teacher'), ('${TG}', 'teacher'), ('${AD}', 'admin');
insert into public.groups (id, name, course_id, teacher_id, homework_topic_id) values
  ('${GP}', '1-GURUH PRE 5.0', '${C5}', '${TF}', 5),
  ('${GV}', '2-GURUH VIP 5.0', '${C5}', '${TR}', 5),
  ('${GC}', 'AC CHALLENGE | 1-GURUH', '${C6}', null, 5),
  ('${GX}', '1-GURUH VIP 5.0', '${C5}', '${TG}', 5);
insert into public.group_teachers (group_id, teacher_id, is_primary) values
  ('${GP}', '${TF}', true), ('${GV}', '${TR}', true), ('${GX}', '${TG}', true),
  ('${GP}', '${TR}', false), ('${GC}', '${TC}', false);
insert into public.profiles (id, name, group_id, telegram_id) values
  ('${SP1}', 'SP1', '${GP}', 201), ('${SP2}', 'SP2', '${GP}', 202), ('${SP3}', 'SP3', '${GP}', 203),
  ('${SV1}', 'SV1', '${GV}', 211), ('${SC1}', 'SC1', '${GC}', 221), ('${SX1}', 'SX1', '${GX}', 231),
  ('${SNG}', 'SNG', null, 299);
insert into auth.users (id, last_sign_in_at) select id, now() from public.profiles;
insert into public.auth_events (user_id, event, created_at) values
  ('${SP1}', 'sign_in', now() - interval '1 day'), ('${SV1}', 'sign_in', now() - interval '1 day');
insert into public.lesson_progress (user_id, lesson_id, updated_at, completed_at) values
  ('${SP1}', '${L5}', now() - interval '2 hours', now() - interval '2 hours'),
  ('${SV1}', '${L5}', now() - interval '3 hours', null);

-- homework: pending SP1 (GP, 30 h) and SV1 (GV, 5 h); graded TODAY: SP2 by the co-teacher TR, SP3 by TF,
-- SC1 by TC (co-teacher of a group with no primary), SX1 by TG. "Today" is the Tashkent day: stamped a few
-- seconds after its start (DAY0), so the fixture means the same thing whenever the harness runs.
insert into public.homework_submissions (assignment_id, user_id, submitted_at, score, scored_by, scored_at, score_feedback) values
  ('${A5}', '${SP1}', now() - interval '30 hours', null, null, null, null),
  ('${A5}', '${SV1}', now() - interval '5 hours', null, null, null, null),
  ('${A5}', '${SP2}', ${DAY0} + interval '4 seconds', 9, '${TR}', ${DAY0} + interval '5 seconds', 'Juda yaxshi ish, rahmat'),
  ('${A5}', '${SP3}', ${DAY0} + interval '4 seconds', 8, '${TF}', ${DAY0} + interval '5 seconds', null),
  ('${A6}', '${SC1}', ${DAY0} + interval '4 seconds', 10, '${TC}', ${DAY0} + interval '5 seconds', null),
  ('${A5}', '${SX1}', ${DAY0} + interval '4 seconds', 7, '${TG}', ${DAY0} + interval '5 seconds', null);
`;

// Messages. q1: GP topic 7, "ustoz", answered by the CO-TEACHER TR 1 h later. q2: GP topic 8, a genuine reply
// to TR, never answered (12 h old). q3: GV General chat (thread NULL), "ustoz", answered by TR in the General
// chat 1 h later. q4: GP topic 9, "ustoz", answered by an ANONYMOUS admin post (the bot stamps the primary TF).
// q5: GP topic 10, "ustoz", answered by TR -- and ALREADY PAID to TF under the old rule. q6: GC topic 7,
// "ustoz", unanswered (9 h). Plus, TODAY (DAY0 + seconds): TR's own post in GP, TG's in GX, and an anonymous
// admin post in GP (the bot stamps it with the primary TF).
function msgSql(): string {
  let id = 1000;
  const m = (g: string, chat: number, thread: number | null, prof: string | null, tgUser: number, ago: number | string,
    o: { ustoz?: boolean; replyTo?: number; replyMsg?: number; anon?: boolean } = {}) =>
    `('${g}', ${prof ? `'${prof}'` : "null"}, ${tgUser}, ${chat}, ${++id}, ${thread ?? "null"}, ` +
    `${typeof ago === "number" ? `now() - interval '${ago} minutes'` : ago}, ` +
    `${o.replyMsg ?? "null"}, ${o.replyTo ?? "null"}, false, ${!!o.ustoz}, ${!!o.anon})`;
  const rows = [
    m(GP, CHAT.GP, 7, SP1, 201, 600, { ustoz: true }),              // q1
    m(GP, CHAT.GP, 7, TR, 102, 540),                                  // q1's answer by the co-teacher
    m(GP, CHAT.GP, 8, SP2, 202, 720, { replyTo: 102, replyMsg: 4242 }), // q2 (reply to TR, unanswered)
    m(GV, CHAT.GV, null, SV1, 211, 1200, { ustoz: true }),           // q3 (General chat)
    m(GV, CHAT.GV, null, TR, 102, 1140),                              // q3's answer (General chat)
    m(GP, CHAT.GP, 9, SP1, 201, 900, { ustoz: true }),               // q4
    m(GP, CHAT.GP, 9, TF, ANON_BOT, 840, { anon: true }),             // q4's answer: anonymous admin -> primary TF
    m(GP, CHAT.GP, 10, SP2, 202, 480, { ustoz: true }),              // q5 (already paid to TF)
    m(GP, CHAT.GP, 10, TR, 102, 420),                                 // q5's answer
    m(GC, CHAT.GC, 7, SC1, 221, 540, { ustoz: true }),               // q6 (co-teacher-only group, unanswered)
    m(GP, CHAT.GP, 7, TR, 102, `${DAY0} + interval '1 second'`),      // TR's post in GP today
    m(GX, CHAT.GX, 7, TG, 104, `${DAY0} + interval '2 seconds'`),     // TG's post in GX today
    m(GP, CHAT.GP, 7, TF, ANON_BOT, `${DAY0} + interval '3 seconds'`, { anon: true }), // anonymous admin in GP today
  ];
  return `insert into public.group_message_events (group_id, profile_id, telegram_user_id, telegram_chat_id,
    telegram_message_id, telegram_thread_id, sent_at, reply_to_message_id, reply_to_user_id, mentions_teacher,
    has_ustoz, is_anon_admin) values\n` + rows.join(",\n") + ";\n" +
    // q5 was paid to the PRIMARY under the old rule
    `insert into public.xp_events (user_id, amount, reason, ref_key, created_at)
       select '${TF}', 8, 'teacher_answer',
              'tanswer:' || telegram_chat_id::text || ':' || ((extract(epoch from sent_at) * 1000000)::bigint)::text, now() - interval '6 hours'
       from public.group_message_events where telegram_chat_id = ${CHAT.GP} and telegram_thread_id = 10 and profile_id = '${SP2}';
     insert into public.user_xp (user_id, total_xp, level) values ('${TF}', 8, 1);\n`;
}

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail !== undefined ? "  -- " + JSON.stringify(detail) : ""}`); }
}
async function q(db: PGlite, sql: string, params: unknown[] = []): Promise<Row[]> {
  return (await db.query(sql, params)).rows as Row[];
}
async function as<T>(db: PGlite, uid: string | null, role: string | null, fn: () => Promise<T>): Promise<T> {
  await db.query("select set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claim.role', $2, false)",
    [uid ?? "", role ?? ""]);
  try { return await fn(); } finally {
    await db.query("select set_config('request.jwt.claim.sub', '', false), set_config('request.jwt.claim.role', '', false)");
  }
}
async function raises(p: Promise<unknown>): Promise<string | null> {
  try { await p; return null; } catch (e) { return String((e as Error).message); }
}

async function freshDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(LIVE);
  await db.exec(`create trigger trg_xp_student_module_impact after insert on public.nudge_module_celebrations
                 for each row execute function public.xp_on_student_module_impact();`);
  await db.exec(aclSql());
  await db.exec(SEED);
  await db.exec(msgSql());
  return db;
}
/** The deploy pipeline sends the whole file as one query: one implicit transaction. */
async function applyMigration(db: PGlite, text = MIG): Promise<string | null> {
  try { await db.exec("begin;\n" + text + "\ncommit;"); return null; } catch (e) {
    try { await db.exec("rollback;"); } catch { /* not in a transaction */ }
    return String((e as Error).message);
  }
}
const byTeacher = (rows: Row[], key = "teacher_id"): Record<string, Row> =>
  Object.fromEntries(rows.map((r) => [r[key], r]));
/** Posts made TODAY (Tashkent) -- how many of the fixture's posts fall on "today" depends on the hour it runs. */
async function todayCounts(db: PGlite) {
  const r = (await q(db, `select
      count(*) filter (where group_id = '${GP}' and is_anon_admin)::int anon_gp,
      count(*) filter (where group_id = '${GP}' and telegram_user_id = 102)::int tr_gp,
      count(*) filter (where group_id = '${GV}' and telegram_user_id = 102)::int tr_gv
    from public.group_message_events
    where (sent_at at time zone 'Asia/Tashkent')::date = (now() at time zone 'Asia/Tashkent')::date`))[0];
  return { anonGP: r.anon_gp as number, trGP: r.tr_gp as number, trGV: r.tr_gv as number };
}

// ─────────────────────────────── A. fidelity ───────────────────────────────
console.log("A. the fixture is production's text");
{
  const db = await freshDb();
  const rows = await q(db, `select p.oid::regprocedure::text sig, md5(replace(p.prosrc, E'\\r', '')) pin, p.provolatile v,
      l.lanname lang, pg_get_function_arguments(p.oid) args, p.prosecdef sd, array_to_string(p.proconfig, ',') cfg
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_language l on l.oid = p.prolang
    where n.nspname = 'public'`);
  const got = Object.fromEntries(rows.map((r) => [r.sig, r]));
  for (const [sig, p] of Object.entries(PROD)) {
    const g = got[sig];
    ok(`A ${sig}: body md5 = production`, !!g && g.pin === p.pin, g?.pin);
    ok(`A ${sig}: language/volatility/args/SECURITY DEFINER/search_path = production`,
      !!g && g.lang === p.lang && g.v === p.v && g.args === p.args && g.sd === true && /search_path=public/.test(g.cfg ?? ""),
      g && { lang: g.lang, v: g.v, args: g.args, sd: g.sd, cfg: g.cfg });
  }
  await db.close();
}

// ─────────────────────────────── B. the defects, on the live code ───────────────────────────────
console.log("B. the defects reproduce on the live code");
{
  const db = await freshDb();
  const rep = byTeacher(await q(db, "select * from public.teacher_daily_report()"));
  ok("B1 live: the co-teacher's grade (SP2) is counted in the PRIMARY's graded_today", rep[TF].graded_today === 2 && rep[TR].graded_today === 0,
    { TF: rep[TF].graded_today, TR: rep[TR].graded_today });
  ok("B2 live: a group with only co-teachers has no backlog/graded owner (TC graded 1, shows 0)", rep[TC].graded_today === 0);
  ok("B3 live: the co-teacher's backlog leaves out the co-taught group (TR sees GV only)", rep[TR].ungraded_backlog === 1);
  const tod = await todayCounts(db);
  ok("B3b live: the co-teacher's posts in the co-taught group are not her activity",
    rep[TR].messages === tod.trGV && tod.trGP >= 1, { TR: rep[TR].messages, tod });
  const thw = await as(db, null, "service_role", () =>
    q(db, "select distinct group_id from public.admin_group_module_submissions($1)", [TR]));
  ok("B4 live: /thomework for the co-teacher leaves out the co-taught group", !thw.some((r) => r.group_id === GP));
  const top = await as(db, TR, "authenticated", () => q(db, "select * from public.teacher_group_top($1, $2, 5)", [TR, GP]));
  ok("B5 live: Top-5 of a co-taught group is empty for the co-teacher", top.length === 0);
  const csv = await as(db, TR, "authenticated", () => raises(q(db, "select * from public.admin_export_group_csv($1)", [GP])));
  ok("B6 live: CSV export of a co-taught group is 'forbidden' for the co-teacher", /forbidden/.test(csv ?? ""), csv);
  const ws = (await as(db, TR, "authenticated", () => q(db, "select * from public.teacher_weekly_self($1, 7)", [TR])))[0];
  ok("B7 live: the co-teacher's weekly backlog leaves out the co-taught group", ws.ungraded_backlog === 1);
  ok("B8 live: a General-chat question answered in the General chat still reads unanswered (weekly self)",
    ws.questions >= 1 && ws.answered === 0, ws);
  await db.exec("select public.award_teacher_engagement_xp(26)");
  const paid = await q(db, "select user_id, ref_key from public.xp_events where reason = 'teacher_answer' order by created_at");
  ok("B9 live: the answer XP for the co-teacher's answer (q1) went to the PRIMARY",
    paid.some((r) => r.user_id === TF) && !paid.some((r) => r.user_id === TR));
  await db.exec(`insert into public.nudge_module_celebrations (profile_id, module_id) values ('${SP1}', '${M5}')`);
  const imp = await q(db, "select user_id from public.xp_events where reason = 'teacher_impact'");
  ok("B10 live: module-completion impact XP goes to the primary only", imp.length === 1 && imp[0].user_id === TF);
  await db.close();
}

// ─────────────────────────────── C. the migration ───────────────────────────────
console.log("C. the migration applies, audits once, and replays as a no-op");
const db = await freshDb();
{
  const err = await applyMigration(db);
  ok("C1 the migration applies (with its self-tests) on production's text", err === null, err);
  if (err) {
    console.log(`\n${pass} passed, ${fail} failed (stopped: the migration did not apply)`);
    Deno.exit(1);
  }
  const audit = await q(db, "select details from public.admin_actions where action = 'coteachers_counted_everywhere'");
  ok("C2 one audit row; 17 rewritten, 0 skipped", audit.length === 1 && audit[0].details.rewritten === 17 &&
    audit[0].details.skipped_already_done === 0, audit[0]?.details);
  ok("C3 audit: 5 pairs, 2 of them co-teacher pairs", audit[0]?.details.pairs === 5 && audit[0]?.details.co_teacher_pairs === 2,
    audit[0]?.details);
  const defsBefore = await q(db, `select p.oid::regprocedure::text sig, md5(pg_get_functiondef(p.oid)) d
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' order by 1`);
  const err2 = await applyMigration(db);
  ok("C4 replay: applies again without error", err2 === null, err2);
  const defsAfter = await q(db, `select p.oid::regprocedure::text sig, md5(pg_get_functiondef(p.oid)) d
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' order by 1`);
  ok("C5 replay: every function definition is byte-identical", JSON.stringify(defsBefore) === JSON.stringify(defsAfter));
  const audit2 = await q(db, "select count(*)::int n from public.admin_actions where action = 'coteachers_counted_everywhere'");
  ok("C6 replay: still one audit row", audit2[0].n === 1);
  for (const sig of REWRITTEN) {
    const r = (await q(db, `select position('(20260930183000)' in prosrc) > 0 m,
        coalesce(array_to_string(proacl, ','), '') acl from pg_proc where oid = to_regprocedure('public.${sig}')`))[0];
    ok(`C7 ${sig}: carries the marker`, r?.m === true);
  }
  const acl = await q(db, `select p, has_function_privilege('anon', p::regprocedure, 'EXECUTE') a,
      has_function_privilege('authenticated', p::regprocedure, 'EXECUTE') u,
      has_function_privilege('service_role', p::regprocedure, 'EXECUTE') s
    from unnest(array['public.teacher_group_pairs()', 'public.teacher_group_signals(integer,integer)',
                      'public.teacher_engagement_xp_candidates(integer)']) p`);
  ok("C8 the three new helpers: service_role only", acl.every((r) => !r.a && !r.u && r.s), acl);
  const exp = Object.entries(PROD).slice(0, 17);
  for (const [sig, p] of exp) {
    const r = (await q(db, `select has_function_privilege('anon', 'public.${sig}'::regprocedure, 'EXECUTE') a,
      has_function_privilege('authenticated', 'public.${sig}'::regprocedure, 'EXECUTE') u`))[0];
    const wantA = p.acl === "public" || p.acl === "anon+auth+svc", wantU = p.acl !== "svc";
    ok(`C9 ${sig}: ACL unchanged (anon ${wantA}, authenticated ${wantU})`, r.a === wantA && r.u === wantU, r);
  }
}

// ─────────────────────────────── D. behaviour after ───────────────────────────────
console.log("D. co-teachers are counted; credit goes to whoever did the work");
{
  const pairs = await q(db, "select group_id, teacher_id, is_primary from public.teacher_group_pairs() order by 1, 2");
  ok("D1 pairs: GP{TF primary, TR co}, GV{TR}, GC{TC co}, GX{TG}", pairs.length === 5 &&
    pairs.some((r) => r.group_id === GP && r.teacher_id === TR && !r.is_primary) &&
    pairs.some((r) => r.group_id === GC && r.teacher_id === TC && !r.is_primary) &&
    pairs.some((r) => r.group_id === GP && r.teacher_id === TF && r.is_primary), pairs);

  const sig = await q(db, "select * from public.teacher_group_signals(8, 3)");
  const s = (t: string, g: string) => sig.find((r) => r.teacher_id === t && r.group_id === g);
  ok("D2 signals: GP's pending (SP1) shows for BOTH its teachers", s(TF, GP)?.pending_homework === 1 && s(TR, GP)?.pending_homework === 1);
  ok("D3 signals: q2 (a reply to TR, unanswered) waits for TR only", s(TR, GP)?.waiting_questions === 1 && s(TF, GP)?.waiting_questions === 0,
    { TR: s(TR, GP), TF: s(TF, GP) });
  ok("D4 signals: q3 (General chat, answered there) is NOT waiting", s(TR, GV)?.waiting_questions === 0, s(TR, GV));
  ok("D5 signals: the co-teacher-only group GC has its teacher, its waiting question and its course",
    s(TC, GC)?.waiting_questions === 1 && s(TC, GC)?.course_title === "AI CREATORS CHALLENGE 6.0" && s(TC, GC)?.is_primary === false);

  const rep = byTeacher(await q(db, "select * from public.teacher_daily_report()"));
  ok("D6 report: graded_today is the GRADER's (TF 1, TR 1, TC 1, TG 1)",
    rep[TF].graded_today === 1 && rep[TR].graded_today === 1 && rep[TC].graded_today === 1 && rep[TG].graded_today === 1,
    Object.values(rep).map((r) => [r.name, r.graded_today]));
  ok("D7 report: TR's backlog covers the co-taught group (GP 1 + GV 1)", rep[TR].ungraded_backlog === 2 && rep[TF].ungraded_backlog === 1);
  ok("D8 report: oldest pending is the max over the groups (SP1, ~30 h)", Number(rep[TR].oldest_pending_hours) >= 29.9);
  const tod = await todayCounts(db);
  ok("D9 report: today's anonymous-admin posts in GP are the primary's activity only", rep[TF].messages === tod.anonGP,
    { TF: rep[TF].messages, tod });
  ok("D10 report: TR's own posts in BOTH her groups are her activity, the anonymous ones are not",
    rep[TR].messages === tod.trGP + tod.trGV && rep[TR].active_minutes >= 1, { TR: rep[TR].messages, tod });

  const nud = byTeacher(await q(db, "select * from public.teacher_nudge_signals(8, 3)"));
  ok("D11 nudge: TR waits on q2 in the co-taught group; the answered General-chat q3 is no longer 'waiting'",
    nud[TR].waiting_questions === 1 && nud[TR].pending_homework === 2, nud[TR]);
  ok("D12 nudge: TC (co-teacher only) gets GC's waiting question", nud[TC].waiting_questions === 1, nud[TC]);

  const ws = (await as(db, TR, "authenticated", () => q(db, "select * from public.teacher_weekly_self($1, 7)", [TR])))[0];
  ok("D13 weekly self: TR's backlog 2; the General-chat question counts as answered", ws.ungraded_backlog === 2 && ws.answered >= 1, ws);
  const wsf = (await as(db, TF, "authenticated", () => q(db, "select * from public.teacher_weekly_self($1, 7)", [TF])))[0];
  ok("D14 weekly self: graded stays by scored_by (TF 1)", wsf.graded === 1, wsf);

  const thw = await as(db, null, "service_role", () =>
    q(db, "select distinct group_id from public.admin_group_module_submissions($1)", [TR]));
  ok("D15 /thomework: the co-teacher sees GP and GV", thw.some((r) => r.group_id === GP) && thw.some((r) => r.group_id === GV));
  const thwG = await as(db, null, "service_role", () =>
    q(db, "select distinct group_id from public.admin_group_module_submissions($1)", [TG]));
  ok("D16 /thomework: a teacher still sees only their own group (TG: GX)", thwG.length === 1 && thwG[0].group_id === GX, thwG);
  const top = await as(db, TR, "authenticated", () => q(db, "select * from public.teacher_group_top($1, $2, 5)", [TR, GP]));
  ok("D17 Top-5: the co-teacher sees GP's students", top.length === 3, top.length);
  const topG = await as(db, TG, "authenticated", () => q(db, "select * from public.teacher_group_top($1, $2, 5)", [TG, GP]));
  ok("D18 Top-5: a teacher of another group still sees nothing", topG.length === 0);
  const csv = await as(db, TR, "authenticated", () => q(db, "select * from public.admin_export_group_csv($1)", [GP]));
  ok("D19 CSV: the co-teacher can export GP", csv.length === 3, csv.length);
  const csvG = await as(db, TG, "authenticated", () => raises(q(db, "select * from public.admin_export_group_csv($1)", [GP])));
  ok("D20 CSV: a teacher of another group is still refused", /forbidden/.test(csvG ?? ""), csvG);
  const dash = await as(db, TR, "authenticated", () => q(db, "select id from public.admin_dashboard_students($1, now() - interval '30 days')", [C5]));
  ok("D21 dashboard: the co-teacher sees GP's and GV's students (4)", dash.length === 4, dash.length);
  const ae = await as(db, TR, "authenticated", () => q(db, "select user_id from public.staff_recent_auth_events(now() - interval '30 days')"));
  ok("D22 logins: include the co-taught group's students", ae.some((r) => r.user_id === SP1) && ae.some((r) => r.user_id === SV1));
  const lp = await as(db, TR, "authenticated", () => q(db, "select user_id from public.staff_recent_lesson_progress(now() - interval '30 days')"));
  ok("D23 lesson progress: includes the co-taught group's students", lp.some((r) => r.user_id === SP1));
  const lpG = await as(db, TG, "authenticated", () => q(db, "select user_id from public.staff_recent_lesson_progress(now() - interval '30 days')"));
  ok("D24 lesson progress: another group's teacher sees none of it", lpG.length === 0);
  const tops = await as(db, TR, "authenticated", () => q(db, "select id from public.staff_top_students(50)"));
  ok("D25 top students: includes the co-taught group's students", tops.some((r) => r.id === SP1) && !tops.some((r) => r.id === SX1));
  const atg = await as(db, AD, "authenticated", () => q(db, "select * from public.admin_teacher_groups($1)", [TR]));
  ok("D26 admin teacher detail: TR has 2 groups; graded counted by TR only", atg.length === 2 &&
    atg.find((r) => r.group_id === GP)?.graded === 1, atg);
  const atu = await as(db, AD, "authenticated", () => q(db, "select * from public.admin_teacher_unanswered($1)", [TR]));
  ok("D27 admin unanswered: includes the co-taught group", atu.some((r) => r.group_name === "1-GURUH PRE 5.0"), atu);
  const atq = byTeacher(await as(db, AD, "authenticated", () => q(db, "select * from public.analytics_teacher_quality(0)")));
  ok("D28 teacher quality: TR's students = GP (3) + GV (1); TC counted", Number(atq[TR]?.students_count) === 4 &&
    Number(atq[TC]?.students_count) === 1, { TR: atq[TR]?.students_count, TC: atq[TC]?.students_count });
  const ats = byTeacher(await as(db, AD, "authenticated", () => q(db, "select * from public.admin_teacher_stats()")));
  ok("D29 admin teacher stats: TR teaches 2 groups; TC teaches 1", ats[TR].groups_taught === 2 && ats[TC].groups_taught === 1,
    { TR: ats[TR].groups_taught, TC: ats[TC].groups_taught });
  const atw = await as(db, AD, "authenticated", () => q(db, "select * from public.admin_teacher_weekly(7)"));
  const w = (t: string, g: string) => atw.find((r) => r.teacher_id === t && r.group_id === g);
  ok("D30 admin weekly: a unit per (teacher, group), co-teacher included", !!w(TR, GP) && !!w(TF, GP) && !!w(TR, GV), atw.length);
  ok("D31 admin weekly: graded by the grader (TR/GP 1, TF/GP 1)", w(TR, GP)?.graded === 1 && w(TF, GP)?.graded === 1,
    { TR: w(TR, GP)?.graded, TF: w(TF, GP)?.graded });
  ok("D32 admin weekly: backlog belongs to the group (both GP units show 1)", w(TR, GP)?.ungraded_backlog === 1 && w(TF, GP)?.ungraded_backlog === 1);
  ok("D33 admin weekly: the 2 anonymous-admin posts are the primary's activity only (TF 2; TR her own 3)",
    w(TF, GP)?.week_messages === 2 && w(TR, GP)?.week_messages === 3, { TF: w(TF, GP)?.week_messages, TR: w(TR, GP)?.week_messages });
  ok("D34 admin weekly: the General-chat question is answered", w(TR, GV)?.answered === 1, w(TR, GV));

  // XP
  const cand = await q(db, "select * from public.teacher_engagement_xp_candidates(26) order by reason, teacher_id");
  const ans = cand.filter((c) => c.reason === "teacher_answer");
  ok("D35 answer XP: q1 -> TR (she answered), q4 -> TF (anonymous admin = primary), q3 -> TR (General chat); q5 already paid -> nobody",
    ans.length === 3 && ans.filter((c) => c.teacher_id === TR).length === 2 && ans.filter((c) => c.teacher_id === TF).length === 1, ans);
  const clr = cand.filter((c) => c.reason === "teacher_queue_clear").map((c) => c.teacher_id).sort();
  ok("D36 queue-clear: TC (co-teacher only, graded, nothing waiting) and TG; not TF/TR (GP/GV still waiting)",
    JSON.stringify(clr) === JSON.stringify([TC, TG].sort()), clr);
  await db.exec("select public.award_teacher_engagement_xp(26)");
  const after1 = await q(db, "select user_id, reason, ref_key from public.xp_events where reason in ('teacher_answer','teacher_queue_clear') order by 1,2,3");
  await db.exec("select public.award_teacher_engagement_xp(26)");
  const after2 = await q(db, "select user_id, reason, ref_key from public.xp_events where reason in ('teacher_answer','teacher_queue_clear') order by 1,2,3");
  ok("D37 award: minted exactly the candidates (+ the pre-existing q5 row); a re-run mints nothing", after1.length === 1 + 3 + 2 &&
    JSON.stringify(after1) === JSON.stringify(after2), after1.length);
  const dupRef = await q(db, "select ref_key from public.xp_events where reason = 'teacher_answer' group by ref_key having count(*) > 1");
  ok("D38 no question paid twice (q5 stays with TF)", dupRef.length === 0, dupRef);
  const drift = await q(db, `select x.user_id from public.user_xp x
    where x.total_xp <> (select coalesce(sum(amount), 0) from public.xp_events e where e.user_id = x.user_id)`);
  ok("D39 user_xp totals settle (no drift)", drift.length === 0, drift);
  await db.exec(`insert into public.nudge_module_celebrations (profile_id, module_id) values
    ('${SP1}', '${M5}'), ('${SC1}', '${M6}'), ('${SNG}', '${M5}')`);
  const imp = await q(db, "select user_id, ref_key from public.xp_events where reason = 'teacher_impact' order by 1");
  ok("D40 impact XP: GP's student -> TF and TR; GC's -> TC; no group -> nobody",
    imp.length === 3 && imp.filter((r) => r.user_id === TF).length === 1 && imp.filter((r) => r.user_id === TR).length === 1 &&
    imp.filter((r) => r.user_id === TC).length === 1, imp);
}

// ─────────────────────────────── E. refusal paths ───────────────────────────────
console.log("E. the migration refuses what it did not verify");
{
  const d2 = await freshDb();
  await d2.exec(`create or replace function public.staff_top_students(_lim int default 10)
    returns table(id uuid, name text, telegram_username public.citext, completed_lessons int, avg_score int, last_activity_at timestamptz)
    language plpgsql stable security definer set search_path = public as $x$ begin return; end $x$;`);
  const err = await applyMigration(d2);
  ok("E1 a function changed since it was verified -> ABORT, nothing applied", /changed since it was verified/.test(err ?? ""), err);
  const none = await q(d2, "select count(*)::int n from pg_proc where proname = 'teacher_group_pairs'");
  ok("E2 ...and the whole file rolled back (no helper left behind)", none[0].n === 0);
  await d2.close();

  const d3 = await freshDb();
  const broken = MIG.replace("'    WHERE (v_is_admin OR g.teacher_id = v_caller)\\n'", "'    WHERE (v_is_admin OR g.teacher_id = v_callerX)\\n'");
  ok("E3 (setup) the edit text was found to break", broken !== MIG);
  const err3 = await applyMigration(d3, broken);
  ok("E4 an edit that no longer matches exactly once -> ABORT", /matched 0 times/.test(err3 ?? ""), err3);
  await d3.close();
}

await db.close();
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) Deno.exit(1);
