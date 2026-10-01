// Applies 20261001050010_menu_sweep_liveness.sql to a real PostgreSQL (PGlite) on top of the LIVE watch-button
// watchdog functions and drives the new ☰-sweep liveness leg end to end with a stub ops_net_post.
//
//   deno run -A --node-modules-dir=none supabase/functions/_watchdogs/testing/menu-sweep-detector-check.ts
//
// Run it after ANY change to that migration, and before asking for the migration-approved label.
// TEST INFRASTRUCTURE ONLY: this directory has no index.ts, so it is never deployed, and the file is not named
// *.test.ts, so CI's `deno test supabase/functions/` does not try to fetch PGlite.
//
// Fidelity: the live watch_button_health() / watch_button_watchdog() are created from the text 20260930160000
// installed — section A asserts md5(prosrc) equals production's, read-only 2026-10-01 (the migration's pins), so
// its md5 pins and exactly-once replace() checks run against the real text. Tables are stubs carrying the live
// columns those functions read and write. ops_net_post is a stub that records each call.

import { PGlite } from "npm:@electric-sql/pglite@0.5.8";
import { isRecipientError } from "../../_shared/telegram-classify.ts";

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

const here = (p: string) => new URL(p, import.meta.url);
const lf = (s: string) => s.replace(/\r\n/g, "\n"); // a Windows checkout is CRLF; production text is LF
const MIG = lf(await Deno.readTextFile(here(Deno.env.get("MIG_PATH") ?? "../../../migrations/20261001050010_menu_sweep_liveness.sql")));
const WB = lf(await Deno.readTextFile(here("../../../migrations/20260930160000_watch_button_watchdog.sql")));

/** The two CREATE statements 20260930160000 installed — verified byte-identical to production in section A. */
function liveFunctions(): string {
  const out: string[] = [];
  for (const name of ["watch_button_health", "watch_button_watchdog"]) {
    const m = new RegExp(`create or replace function public\\.${name}\\(\\)[\\s\\S]*?\\$function\\$;`).exec(WB);
    if (!m) throw new Error(`no ${name} in 20260930160000`);
    out.push(m[0]);
  }
  return out.join("\n\n");
}

// production, read-only 2026-10-01: md5(replace(prosrc, E'\r', ''))
const PROD_BODY: Record<string, string> = {
  watch_button_health: "aa4691666c7b903bf94472035a1d49c7",
  watch_button_watchdog: "4ceae804ac3f403b96e4e2986cbde199",
};
// platform_settings.ops_http_watchdog, read-only 2026-10-01 04:2x UTC (alert_state trimmed to one key).
const LIVE_RX = "bot was blocked|can't initiate|chat not found|user is deactivated|bot was kicked|not enough rights|group chat was upgraded|bot was blocked by the user";
const OPS_HTTP = {
  enabled: true, window_min: 45, cooldown_hours: 3, timeout_threshold: 20,
  alert_state: { "real:unattributed:403": "2026-09-25 17:30:00.549691+00" },
  last_sweep_at: "2026-10-01 04:18:00.353591+00", tg_expected_regex: LIVE_RX,
};

// admin_actions 'miniapp_button_rejected', LIVE, 2026-10-01 04:02:04 UTC — the incident row, verbatim. The only fault
// row in 3 days; the 04:25 watch_button_watchdog_ALARM (fallback_fault, student button-fault DM) rests on it alone.
const INCIDENT_ROW = {
  fn: "menu_button_sweep", role: "student", error: "Bad Request: user not found", method: "setChatMenuButton",
  source: "telegram-bot-webhook", status: 400, dedupe_key: "rejected:menu_button_sweep:setChatMenuButton",
};
// Descriptions the SQL exclusion must classify exactly as the edge isRecipientError does (the pinned strings of
// telegram-classify.test.ts, both directions).
const PARITY_PROBES = [
  "Bad Request: user not found", "Bad Request: USER_ID_INVALID", "Bad Request: invalid user_id specified",
  "Bad Request: PARTICIPANT_ID_INVALID", "Bad Request: member not found", "Bad Request: PEER_ID_INVALID",
  "Bad Request: chat not found", "Forbidden: bot was blocked by the user", "Forbidden: user is deactivated",
  "Forbidden: bot can't initiate conversation with a user", "Forbidden: bots can't send messages to bots",
  "Bad Request: chat_id is empty", "Bad Request: have no rights to send a message",
  "Bad Request: not enough rights to send text messages to the chat",
  "Bad Request: group chat was upgraded to a supergroup chat",
  "Bad Request: BUTTON_TYPE_INVALID", "Bad Request: BUTTON_URL_INVALID", "Bad Request: BUTTON_DATA_INVALID",
  "Bad Request: WEBAPP_URL_INVALID",
  "Bad Request: inline keyboard button Web App URL 'http://x' is invalid: Only HTTPS links are allowed",
  "Bad Request: text must be encoded in UTF-8", "Bad Request: can't parse entities: Unsupported start tag",
  "Bad Request: message is too long", "Bad Request: some description nobody has listed yet",
  "Unauthorized", "Not Found", "http_400", "transport_error",
];

const AD1 = "a0000000-0000-0000-0000-000000000001";
const AD2 = "a0000000-0000-0000-0000-000000000002";

const SCHEMA = `
set timezone = 'UTC';
create role anon; create role authenticated; create role service_role;
create type public.app_role as enum ('admin', 'student', 'teacher', 'superadmin');
create table public.courses (id uuid primary key default gen_random_uuid(), title text not null,
  published boolean not null default false);
create table public.groups (id uuid primary key default gen_random_uuid(), name text not null, course_id uuid);
create table public.profiles (id uuid primary key, group_id uuid, status text not null default 'active',
  telegram_id bigint, notifications_enabled boolean default true, created_at timestamptz not null default now());
create table public.user_roles (id uuid primary key default gen_random_uuid(), user_id uuid not null,
  role public.app_role not null);
create table public.notifications_log (id bigserial primary key, user_id uuid, notification_type text,
  sent_at timestamptz not null default now());
create table public.lesson_progress (id bigserial primary key, user_id uuid, updated_at timestamptz default now());
create table public.homework_submissions (id uuid primary key default gen_random_uuid(), user_id uuid not null,
  submitted_at timestamptz not null default now());
create table public.group_message_events (id bigserial primary key, profile_id uuid, sent_at timestamptz default now(),
  telegram_thread_id bigint);
create table public.admin_actions (id uuid primary key default gen_random_uuid(), actor_user_id uuid,
  action text not null, details jsonb not null default '{}'::jsonb, created_at timestamptz not null default clock_timestamp());
create table public.app_settings (key text primary key, value jsonb not null, description text,
  updated_at timestamptz not null default now());
create table public.platform_settings (key text primary key, value jsonb not null,
  updated_at timestamptz not null default now());

-- ops_net_post stub (production's name and parameter names): records the call.
create table public.test_sent (id bigserial primary key, url text, body jsonb, headers jsonb, purpose text);
create function public.ops_net_post(p_url text, p_body jsonb, p_headers jsonb default '{}'::jsonb,
  p_purpose text default null, p_timeout_ms integer default 30000) returns bigint language plpgsql as $f$
declare _id bigint;
begin
  insert into public.test_sent (url, body, headers, purpose) values (p_url, p_body, p_headers, p_purpose)
  returning id into _id;
  return _id;
end $f$;

insert into public.profiles (id, telegram_id) values ('${AD1}', 9001), ('${AD2}', 9002);
insert into public.user_roles (user_id, role) values ('${AD1}', 'admin'), ('${AD2}', 'superadmin');
insert into public.platform_settings (key, value) values
  ('student_miniapp', '{"enabled": true}'), ('teacher_miniapp', '{"enabled": true}'),
  ('telegram', '{"bot_token": "TEST:TOKEN"}');
`;

const LIVE_GRANTS = `
revoke execute on function public.watch_button_health() from public, anon, authenticated;
grant  execute on function public.watch_button_health() to service_role;
revoke execute on function public.watch_button_watchdog() from public, anon, authenticated;
grant  execute on function public.watch_button_watchdog() to service_role;
`;

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail !== undefined ? "  -- " + JSON.stringify(detail) : ""}`); }
}
async function q(db: PGlite, sql: string, params: unknown[] = []): Promise<Row[]> {
  return (await db.query(sql, params)).rows as Row[];
}

/** The live frozen row (2026-10-01 04:22 UTC) with its times moved relative to now(): `ageMin` since the pass start. */
function liveRow(ageMin: number, patch: Row = {}): Row {
  const t = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString();
  return {
    rev: 6, done: false, ticks: 3, cursor: "83d961a5-34a3-4f2d-9bb6-c7734ded29f3",
    totals: {
      ok: 92, staff: 9, failed: 0, targets: 166, rejected: 1, students: 157, processed: 95, commands_ok: 4,
      unreachable: 3, commands_failed: 0, global_commands_ok: 3, global_commands_failed: 0,
    },
    version: 1, pass_key: "v1|c1|s1|t1|https://aicreator.academy|", last_stop: "rejected", finished_at: null,
    lease_until: null, retry_after: t(ageMin - 32), last_tick_at: t(ageMin - 2), pass_started_at: t(ageMin),
    global_commands_sent: true, ...patch,
  };
}

async function freshDb(opts: { progress?: Row | null; opsHttp?: Row | null; tamper?: boolean } = {}): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SCHEMA);
  let live = liveFunctions();
  if (opts.tamper) live = live.replace("-- Fallback reasons that are NOT the kill-switch", "-- Fallback reasons (edited by hand)");
  await db.exec(live);
  await db.exec(LIVE_GRANTS);
  await db.query("insert into public.app_settings (key, value) values ('watch_button_watchdog_state', $1::jsonb)", [
    JSON.stringify({ alerting: false, last_alert_ms: 0, first_checked_at: new Date().toISOString(), seeded_by: "20260930160000" }),
  ]);
  if (opts.progress !== null) {
    await db.query("insert into public.app_settings (key, value) values ('menu_button_sweep', $1::jsonb)",
      [JSON.stringify(opts.progress ?? liveRow(130))]);
  }
  if (opts.opsHttp !== null) {
    await db.query("insert into public.platform_settings (key, value) values ('ops_http_watchdog', $1::jsonb)",
      [JSON.stringify(opts.opsHttp ?? OPS_HTTP)]);
  }
  return db;
}

/** The deploy pipeline sends the file as one query: one implicit transaction. */
async function applyMigration(db: PGlite): Promise<string | null> {
  try {
    await db.exec("begin;\n" + MIG + "\ncommit;");
    return null;
  } catch (e) {
    try { await db.exec("rollback;"); } catch { /* not in a transaction */ }
    return String((e as Error).message);
  }
}

const bodyMd5 = async (db: PGlite, fn: string) =>
  (await q(db, `select md5(replace(prosrc, E'\\r', '')) m from pg_proc where oid = '${fn}'::regprocedure`))[0].m as string;
const health = async (db: PGlite) => (await q(db, "select public.watch_button_health() r"))[0].r as Row;
const setProgress = (db: PGlite, v: Row | null) => v === null
  ? db.exec("delete from public.app_settings where key = 'menu_button_sweep'")
  : db.query(`insert into public.app_settings (key, value) values ('menu_button_sweep', $1::jsonb)
              on conflict (key) do update set value = excluded.value`, [JSON.stringify(v)]);
const setSwitch = (db: PGlite, v: Row | null) => v === null
  ? db.exec("delete from public.platform_settings where key = 'menu_button_sweep'")
  : db.query(`insert into public.platform_settings (key, value) values ('menu_button_sweep', $1::jsonb)
              on conflict (key) do update set value = excluded.value`, [JSON.stringify(v)]);

// ───────────── A. fidelity ─────────────
console.log("A. the live functions are production's text");
{
  const db = await freshDb();
  for (const [fn, md5] of Object.entries(PROD_BODY)) {
    ok(`A ${fn} body md5 = production`, (await bodyMd5(db, `public.${fn}()`)) === md5, await bodyMd5(db, `public.${fn}()`));
  }
  const before = await health(db);
  ok("A the live health has no sweep leg (the incident: nothing could see the frozen sweep)",
    !("menu_sweep_stuck" in before) && before.alarm === false, before);
  await db.close();
}

// ───────────── M. the migration ─────────────
console.log("M. migration: applies (with a frozen sweep at deploy time), ACLs, replay, pin");
{
  const db = await freshDb(); // the live frozen row, 2 h 10 min old: stuck AT deploy — must not fail the deploy
  const err = await applyMigration(db);
  ok("M applies", err === null, err);
  for (const fn of ["watch_button_health", "watch_button_watchdog"]) {
    const src = (await q(db, `select prosrc from pg_proc where oid = 'public.${fn}()'::regprocedure`))[0].prosrc as string;
    ok(`M ${fn} carries the marker`, src.includes("(20261001050010)"));
    const acl = (await q(db, `select coalesce(array_to_string(proacl, ','), '') a, prosecdef s from pg_proc where oid = 'public.${fn}()'::regprocedure`))[0];
    ok(`M ${fn} ACL is still service_role only`, !/(^|,)=X|anon=|authenticated=/.test(acl.a) && acl.a.includes("service_role=X"), acl);
  }
  ok("M watchdog stays SECURITY DEFINER, health stays INVOKER",
    (await q(db, "select prosecdef s from pg_proc where oid = 'public.watch_button_watchdog()'::regprocedure"))[0].s === true &&
      (await q(db, "select prosecdef s from pg_proc where oid = 'public.watch_button_health()'::regprocedure"))[0].s === false);
  const vacl = (await q(db, `select has_function_privilege('anon', 'public.menu_sweep_stuck_verdict(jsonb,boolean,timestamptz)', 'EXECUTE') a,
                                    has_function_privilege('authenticated', 'public.menu_sweep_stuck_verdict(jsonb,boolean,timestamptz)', 'EXECUTE') u,
                                    has_function_privilege('service_role', 'public.menu_sweep_stuck_verdict(jsonb,boolean,timestamptz)', 'EXECUTE') s`))[0];
  ok("M verdict: anon / authenticated cannot execute, service_role can", !vacl.a && !vacl.u && vacl.s, vacl);
  const inst = await q(db, "select details from public.admin_actions where action = 'menu_sweep_liveness_installed'");
  ok("M one install row, carrying the verdict at deploy (stuck)", inst.length === 1 && inst[0].details.verdict_at_deploy?.stuck === true, inst);
  ok("M the deploy self-test never sent anything", (await q(db, "select count(*)::int n from public.test_sent"))[0].n === 0);

  const h1 = await bodyMd5(db, "public.watch_button_health()");
  const w1 = await bodyMd5(db, "public.watch_button_watchdog()");
  const err2 = await applyMigration(db);
  ok("M replay applies", err2 === null, err2);
  ok("M replay changes no body", (await bodyMd5(db, "public.watch_button_health()")) === h1 && (await bodyMd5(db, "public.watch_button_watchdog()")) === w1);
  ok("M replay writes no second install row", (await q(db, "select count(*)::int n from public.admin_actions where action = 'menu_sweep_liveness_installed'"))[0].n === 1);
  console.log(`     new body md5: watch_button_health ${h1}, watch_button_watchdog ${w1}`);
  await db.close();

  const tampered = await freshDb({ tamper: true });
  const terr = await applyMigration(tampered);
  ok("M a live body that drifted from the pin aborts the whole migration", (terr ?? "").includes("changed since it was verified"), terr);
  ok("M ...and nothing of it stays (one transaction)",
    (await q(tampered, "select count(*)::int n from pg_proc where proname = 'menu_sweep_stuck_verdict'"))[0].n === 0);
  await tampered.close();
}

// ───────────── V. the verdict through watch_button_health() ─────────────
console.log("V. watch_button_health(): the sweep leg");
{
  const db = await freshDb({ progress: liveRow(30) });
  if (await applyMigration(db)) throw new Error("migration failed");

  let h = await health(db);
  ok("V the live row 30 min into its pass: not stuck, no alarm", h.menu_sweep_stuck === false && h.alarm === false && h.menu_sweep.reason === "progressing", h.menu_sweep);

  await setProgress(db, liveRow(130));
  h = await health(db);
  ok("V the live row frozen 2 h 10 min: stuck (no_progress_2h) and alarm", h.menu_sweep_stuck === true && h.alarm === true &&
    h.menu_sweep.reason === "no_progress_2h" && h.menu_sweep.processed === 95 && h.menu_sweep.targets === 166, h.menu_sweep);
  ok("V the digest line says so", String(h.digest_line).includes("☰ menyu sweep toʻxtab qoldi"), h.digest_line);
  ok("V the other legs are untouched (no fallback fault, no coverage gap)", h.fallback_fault === false && h.coverage_gap === false, h);

  await setProgress(db, liveRow(130, { last_progress_at: new Date(Date.now() - 10 * 60_000).toISOString() }));
  ok("V progress 10 min ago clears it", (await health(db)).menu_sweep_stuck === false);

  await setProgress(db, liveRow(20, { stop_repeats: 2, stop_cursor: "83d961a5-34a3-4f2d-9bb6-c7734ded29f3" }));
  h = await health(db);
  ok("V the same cursor stopped twice: stuck within the 2 h window", h.menu_sweep_stuck === true && h.menu_sweep.repeated_stop === true, h.menu_sweep);

  await setProgress(db, liveRow(600, { done: true, finished_at: new Date(Date.now() - 5 * 3_600_000).toISOString() }));
  ok("V a finished pass, re-pass not due: fine", (await health(db)).menu_sweep_stuck === false);
  await setProgress(db, liveRow(600, { done: true, finished_at: new Date(Date.now() - 9 * 3_600_000).toISOString() }));
  h = await health(db);
  ok("V a finished pass 9 h ago (re-pass 3 h overdue): dead → stuck", h.menu_sweep_stuck === true && h.menu_sweep.reason === "repass_overdue", h.menu_sweep);

  await setProgress(db, liveRow(130));
  await setSwitch(db, { enabled: false });
  h = await health(db);
  ok("V switched off ({enabled:false}): not stuck", h.menu_sweep_stuck === false && h.menu_sweep.reason === "disabled", h.menu_sweep);
  await setSwitch(db, { enabled: "false" });
  ok("V a string \"false\" is NOT off (mirrors parseSweepSettings: only a literal false)", (await health(db)).menu_sweep_stuck === true);
  await setSwitch(db, { rerun: "x" });
  ok("V a rerun-only row is on", (await health(db)).menu_sweep_stuck === true);
  await setSwitch(db, null);

  await setProgress(db, null);
  h = await health(db);
  ok("V no progress row: not stuck, present=false", h.menu_sweep_stuck === false && h.menu_sweep.present === false, h.menu_sweep);
  await db.query("insert into public.app_settings (key, value) values ('menu_button_sweep', '\"garbage\"'::jsonb)");
  h = await health(db);
  ok("V an unreadable row is an alarm", h.menu_sweep_stuck === true && h.alarm === true && h.menu_sweep.reason === "unreadable", h.menu_sweep);
  await setProgress(db, liveRow(30, { pass_started_at: "2026-13-45T99:99:99Z" }));
  h = await health(db);
  ok("V a time that matches the shape but cannot be cast → verdict_error, still an alarm", h.menu_sweep_stuck === true && h.menu_sweep.reason === "verdict_error", h.menu_sweep);

  // #239: staff refusals stay out of the student leg; the sweep leg reads no refusal row at all.
  await setProgress(db, liveRow(30));
  await db.exec(`insert into public.admin_actions (action, details) values ('teacher_miniapp_button_rejected', '{"fn": "menu_button_sweep"}')`);
  h = await health(db);
  ok("V a STAFF refusal raises neither the student fault leg nor the sweep leg", h.fallback_fault === false && h.menu_sweep_stuck === false && h.alarm === false, h);
  await db.exec(`insert into public.admin_actions (action, details) values ('menu_button_sweep_member_skipped', '{"profile_id": "x"}')`);
  ok("V a member-skipped row is not a student button fault either", (await health(db)).fallback_fault === false);
  // The incident row, verbatim: one member the bot cannot resolve — not a refusal of our button.
  await db.query("insert into public.admin_actions (action, details, created_at) values ('miniapp_button_rejected', $1::jsonb, now() - interval '70 minutes')",
    [JSON.stringify(INCIDENT_ROW)]);
  h = await health(db);
  ok("V the 04:02 incident row ('user not found') no longer raises the student fault leg", h.fallback_fault === false && h.alarm === false &&
    h.fault_rows_recipient_24h === 1 && !("miniapp_button_rejected" in (h.fault_rows_24h ?? {})), h);
  ok("V ...and the digest line carries no '⚠️ nosozlik'", !String(h.digest_line).includes("nosozlik"), h.digest_line);
  await db.exec(`insert into public.admin_actions (action, details) values ('miniapp_button_rejected', '{"fn": "cron_engagement", "status": 400, "error": "Bad Request: BUTTON_URL_INVALID"}')`);
  h = await health(db);
  ok("V a refusal of OUR button next to it still raises the student leg (counted once)", h.fallback_fault === true && h.alarm === true &&
    h.fault_rows_24h?.miniapp_button_rejected === 1 && h.fault_rows_recipient_24h === 1, h);
  await db.exec("delete from public.admin_actions where action = 'miniapp_button_rejected'");
  await db.exec(`insert into public.admin_actions (action, details) values ('miniapp_button_rejected', '{"fn": "menu_button_sweep"}')`);
  ok("V a STUDENT refusal with no description still raises the student leg, as before", (await health(db)).fallback_fault === true);
  await db.exec("delete from public.admin_actions where action = 'miniapp_button_rejected'");
  await db.query("insert into public.admin_actions (action, details, created_at) values ('miniapp_button_rejected', $1::jsonb, now() - interval '25 hours')",
    [JSON.stringify({ fn: "cron_engagement", status: 400, error: "Bad Request: BUTTON_URL_INVALID" })]);
  ok("V the 24 h window is unchanged (a 25 h old refusal no longer counts)", (await health(db)).fallback_fault === false);

  // Parity: the SQL exclusion classifies every pinned description exactly as the edge isRecipientError does.
  for (const desc of PARITY_PROBES) {
    await db.exec("delete from public.admin_actions where action = 'miniapp_button_rejected'");
    await db.query("insert into public.admin_actions (action, details) values ('miniapp_button_rejected', $1::jsonb)",
      [JSON.stringify({ fn: "parity", status: 400, error: desc })]);
    const p = await health(db);
    const recipient = isRecipientError(desc);
    ok(`V parity (${recipient ? "per-recipient, dropped" : "kept"}): ${desc}`,
      p.fallback_fault === !recipient && p.fault_rows_recipient_24h === (recipient ? 1 : 0), p.fault_rows_24h);
  }
  await db.close();
}

// ───────────── W. the watchdog, end to end ─────────────
console.log("W. watch_button_watchdog(): DM, ALARM row, recovery");
{
  const db = await freshDb({ progress: liveRow(30) });
  if (await applyMigration(db)) throw new Error("migration failed");
  let r = (await q(db, "select public.watch_button_watchdog() r"))[0].r as Row;
  ok("W healthy: no DM", r.alarm === false && (await q(db, "select count(*)::int n from public.test_sent"))[0].n === 0, r);

  await setProgress(db, liveRow(130));
  r = (await q(db, "select public.watch_button_watchdog() r"))[0].r as Row;
  const sent = await q(db, "select url, body, headers, purpose from public.test_sent order by id");
  ok("W frozen sweep → one DM per admin (2)", sent.length === 2, sent.length);
  const text = String(sent[0]?.body?.text ?? "");
  ok("W the DM names the sweep, progress and reason", text.includes("☰ Mini App menyu tugmasi (sweep) toʻxtab qoldi: 95/166") &&
    text.includes("sabab: no_progress_2h") && text.includes("(oxirgi toʻxtash: rejected)"), text);
  ok("W the DM carries the kill-switch and the rerun lever", text.includes('menu_button_sweep {"enabled": false}') && text.includes('{"rerun"'), text);
  ok("W the DM is not the student button-fault paragraph", !text.includes("miniapp_button_rejected"), text);
  ok("W through ops_net_post with Content-Type", sent[0]?.headers?.["Content-Type"] === "application/json" && sent[0]?.purpose === "watch_button_watchdog", sent[0]);
  const alarm = await q(db, "select details from public.admin_actions where action = 'watch_button_watchdog_ALARM'");
  ok("W one ALARM row carrying the sweep verdict", alarm.length === 1 && alarm[0].details.menu_sweep_stuck === true &&
    alarm[0].details.menu_sweep?.reason === "no_progress_2h", alarm);

  r = (await q(db, "select public.watch_button_watchdog() r"))[0].r as Row;
  ok("W still stuck an hour later: no re-DM inside the 6 h cooldown", (await q(db, "select count(*)::int n from public.test_sent"))[0].n === 2);

  // heal: the deployed sweep steps past the member and finishes the pass
  await setProgress(db, liveRow(140, { done: true, finished_at: new Date().toISOString(), cursor: "ffffffff-0000-4000-8000-000000000000",
    last_progress_at: new Date().toISOString(), last_stop: null, totals: { ...liveRow(0).totals, processed: 166, unreachable: 4, ok: 162 } }));
  r = (await q(db, "select public.watch_button_watchdog() r"))[0].r as Row;
  const rec = await q(db, "select body from public.test_sent order by id offset 2");
  ok("W healed → recovered DM to each admin", r.alarm === false && rec.length === 2 && String(rec[0].body.text).includes("normallashdi"), rec);
  ok("W one recovered row", (await q(db, "select count(*)::int n from public.admin_actions where action = 'watch_button_watchdog_recovered'"))[0].n === 1);
  await db.close();
}

// ───────────── H. heal of the live false alarm (replay of 2026-10-01 ~05:10 UTC) ─────────────
// Live: the 04:02 incident row is the only fault row; watch_button_watchdog_state = {alerting: true, last_alert_ms =
// 04:25, dm_attempted_last_run: 2} from the 04:25 ALARM (fallback_fault only). Before this migration the alarm is
// pinned true until that row ages out of the 24 h window (04:02 on 10-02), re-DMing at the 6 h cooldown.
console.log("H. watch_button_watchdog(): the live false student alarm recovers on apply");
{
  // The sweep as it is right after the edge fix deploys: stepping again (progress a minute ago).
  const db = await freshDb({ progress: liveRow(70, { last_progress_at: new Date(Date.now() - 60_000).toISOString() }) });
  await db.query("insert into public.admin_actions (action, details, created_at) values ('miniapp_button_rejected', $1::jsonb, now() - interval '70 minutes')",
    [JSON.stringify(INCIDENT_ROW)]);
  await db.query("update public.app_settings set value = value || $1::jsonb where key = 'watch_button_watchdog_state'",
    [JSON.stringify({ alerting: true, last_alert_ms: Date.now() - 47 * 60_000, dm_attempted_last_run: 2 })]);

  // Before: the live functions keep the false alarm (no DM inside the cooldown, no recovery).
  let r = (await q(db, "select public.watch_button_watchdog() r"))[0].r as Row;
  ok("H before: the live functions hold the false student alarm on the incident row alone",
    r.alarm === true && r.fallback_fault === true && r.fault_rows_24h?.miniapp_button_rejected === 1 &&
      (await q(db, "select count(*)::int n from public.test_sent"))[0].n === 0, r);
  await db.query("update public.app_settings set value = value || '{\"last_alert_ms\": 0}'::jsonb where key = 'watch_button_watchdog_state'");
  r = (await q(db, "select public.watch_button_watchdog() r"))[0].r as Row;
  const falseDm = await q(db, "select body from public.test_sent order by id");
  ok("H before: once the 6 h cooldown passes, the false student button-fault DM goes out again (10:25 / 16:25 / 22:25)",
    r.alarm === true && falseDm.length === 2 && String(falseDm[0].body.text).includes("miniapp_button_rejected"), falseDm);

  // Apply, then the next :25 run: recovered.
  if (await applyMigration(db)) throw new Error("migration failed");
  const inst = (await q(db, "select details from public.admin_actions where action = 'menu_sweep_liveness_installed'"))[0]?.details;
  ok("H the install row records the incident row as per-recipient, and no fault at deploy",
    inst?.fault_rows_recipient_at_deploy === 1 && inst?.fallback_fault_at_deploy === false, inst);
  r = (await q(db, "select public.watch_button_watchdog() r"))[0].r as Row;
  const rec = await q(db, "select body from public.test_sent order by id offset 2");
  ok("H after apply: alarm false, the recovered DM goes to each admin", r.alarm === false && r.fallback_fault === false &&
    r.fault_rows_recipient_24h === 1 && rec.length === 2 && String(rec[0].body.text).includes("normallashdi"), rec);
  ok("H one watch_button_watchdog_recovered row",
    (await q(db, "select count(*)::int n from public.admin_actions where action = 'watch_button_watchdog_recovered'"))[0].n === 1);
  const st = (await q(db, "select value from public.app_settings where key = 'watch_button_watchdog_state'"))[0].value as Row;
  ok("H the watchdog state is no longer alerting (a REAL alarm from any leg DMs at once, no cooldown in the way)", st.alerting === false, st);
  r = (await q(db, "select public.watch_button_watchdog() r"))[0].r as Row;
  ok("H the next run is quiet (no further DM)", r.alarm === false && (await q(db, "select count(*)::int n from public.test_sent"))[0].n === 4);
  await db.close();
}

// ───────────── R. tg_expected_regex ─────────────
console.log("R. platform_settings.ops_http_watchdog.tg_expected_regex");
{
  const db = await freshDb();
  if (await applyMigration(db)) throw new Error("migration failed");
  const v = (await q(db, "select value from public.platform_settings where key = 'ops_http_watchdog'"))[0].value as Row;
  ok("R aligned: the per-recipient tokens are appended to the verified value", v.tg_expected_regex.startsWith(LIVE_RX + "|user not found|"), v.tg_expected_regex);
  ok("R the rest of the row is untouched (alert_state, watermark)", JSON.stringify(v.alert_state) === JSON.stringify(OPS_HTTP.alert_state) && v.last_sweep_at === OPS_HTTP.last_sweep_at, v);
  const m = async (desc: string) => (await q(db, "select $1 ~* (value->>'tg_expected_regex') m from public.platform_settings where key = 'ops_http_watchdog'",
    [JSON.stringify({ ok: false, error_code: 400, description: desc })]))[0].m;
  ok("R 'user not found' is now expected (as on the edge)", await m("Bad Request: user not found") === true);
  ok("R a refused web app URL is still real", await m("Bad Request: BUTTON_URL_INVALID") === false);
  const before = JSON.stringify(v);
  await applyMigration(db);
  ok("R replay: no change", JSON.stringify((await q(db, "select value from public.platform_settings where key = 'ops_http_watchdog'"))[0].value) === before);
  await db.close();

  const other = await freshDb({ opsHttp: { ...OPS_HTTP, tg_expected_regex: "bot was blocked|something an owner tuned" } });
  ok("R an owner-tuned value: the migration still applies", (await applyMigration(other)) === null);
  ok("R ...leaves it alone", (await q(other, "select value->>'tg_expected_regex' r from public.platform_settings where key = 'ops_http_watchdog'"))[0].r === "bot was blocked|something an owner tuned");
  ok("R ...and says so once", (await q(other, "select count(*)::int n from public.admin_actions where action = 'ops_http_tg_regex_alignment_skipped'"))[0].n === 1);
  await other.close();

  const none = await freshDb({ opsHttp: null });
  ok("R no ops_http_watchdog row: applies, nothing created", (await applyMigration(none)) === null &&
    (await q(none, "select count(*)::int n from public.platform_settings where key = 'ops_http_watchdog'"))[0].n === 0);
  await none.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) Deno.exit(1);
