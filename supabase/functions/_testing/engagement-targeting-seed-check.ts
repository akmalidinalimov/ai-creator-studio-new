// PGlite harness for 20260930180010_engagement_targeting_switches.sql (seeds platform_settings.engagement_targeting).
//
//   F  fresh database: the row is created with the three switches ON, one audit row, and the edge reader
//      (_shared/engagement-targeting.ts parseEngagementTargeting) reads exactly those three switches as on.
//   R  replay: nothing changes, still ONE audit row (audit once).
//   O  an owner value that already exists (the admin card can write it before the migration applies) is kept
//      byte for byte, and no audit row is written.
//   M  a malformed existing row (not a JSON object) makes the read-only self-test fail the migration, and the
//      transaction leaves nothing behind.
//   S  the file creates nothing else: no function, grant, cron job or outbound HTTP.
//
// Run: deno test -A --node-modules-dir=none supabase/functions/_testing/engagement-targeting-seed-check.ts
// MIG_PATH=<file> tests a draft before it is written into its (edit-guarded) slot.
// CI NOTE: CI runs `deno test supabase/functions/` with NO permission flags, and this file's name does not match
// deno's test pattern, so CI never runs it; when run without -A it registers as IGNORED (never a false red).
// TEST INFRASTRUCTURE ONLY: this directory has no index.ts, so it is never deployed.
import { parseEngagementTargeting } from "../_shared/engagement-targeting.ts";

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;
interface PG {
  query(sql: string, params?: unknown[]): Promise<{ rows: Row[] }>;
  exec(sql: string): Promise<unknown>;
  close(): Promise<void>;
}

const granted = (name: "read" | "env" | "net") => {
  try {
    return Deno.permissions.querySync({ name }).state === "granted";
  } catch {
    return false;
  }
};
const CAN_RUN = granted("read") && granted("env") && granted("net");
const here = (p: string) => new URL(p, import.meta.url);
const lf = (s: string) => s.replace(/\r\n/g, "\n");
// jsonb stores object keys in its own order (shorter keys first), so compare objects with sorted keys.
const canon = (v: unknown): string =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : x);

// The two tables the migration touches, as production has them (columns it writes or reads).
const SCHEMA = `
create table public.platform_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid
);
create table public.admin_actions (
  id bigserial primary key,
  actor_user_id uuid,
  action text not null,
  target_user_id uuid,
  target_resource_type text,
  target_resource_id text,
  details jsonb,
  created_at timestamptz not null default now()
);
insert into public.platform_settings (key, value) values ('student_miniapp', '{"enabled": true}'::jsonb);
`;

Deno.test({
  name: CAN_RUN
    ? "engagement_targeting_seed_check: 20260930180010 on PGlite (fresh / replay / owner value kept / malformed refused)"
    : "engagement_targeting_seed_check: SKIPPED -- needs `deno test -A --node-modules-dir=none`",
  ignore: !CAN_RUN,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: run,
});

async function run() {
  const spec = "npm:@electric-sql/pglite@0.5.8"; // non-literal: never resolved or type-checked unless this runs
  // deno-lint-ignore no-explicit-any
  const { PGlite } = (await import(spec)) as any;
  const MIG = lf(await Deno.readTextFile(
    Deno.env.get("MIG_PATH") ?? here("../../migrations/20260930180010_engagement_targeting_switches.sql"),
  ));

  let pass = 0, fail = 0;
  const ok = (name: string, cond: boolean, detail?: unknown) => {
    if (cond) {
      pass++;
      console.log(`  PASS  ${name}`);
    } else {
      fail++;
      console.log(`  FAIL  ${name}${detail !== undefined ? "  — " + JSON.stringify(detail) : ""}`);
    }
  };
  const q = async (db: PG, sql: string): Promise<Row[]> => (await db.query(sql)).rows;
  // The pipeline applies a migration as one transaction.
  const apply = async (db: PG): Promise<string | null> => {
    try {
      await db.exec("begin;\n" + MIG + "\ncommit;");
      return null;
    } catch (e) {
      try {
        await db.exec("rollback;");
      } catch { /* none open */ }
      return String((e as Error).message);
    }
  };
  const fresh = async (): Promise<PG> => {
    const db: PG = new PGlite();
    await db.exec(SCHEMA);
    return db;
  };
  const row = async (db: PG) => (await q(db, "select value from public.platform_settings where key = 'engagement_targeting'"))[0];
  const audits = async (db: PG) =>
    await q(db, "select details from public.admin_actions where action = 'engagement_targeting_seeded' order by id");

  // ── F: fresh ──
  {
    const db = await fresh();
    const e = await apply(db);
    ok("F applies cleanly", e === null, e);
    const r = await row(db);
    ok("F row seeded with the three switches ON (and nothing else)", canon(r?.value) === canon({
      retire_smart_inactive_nudges: true, skip_closed_courses: true, trial_to_course_page: true,
    }), r?.value);
    ok("F the edge reader sees every switch on", JSON.stringify(parseEngagementTargeting(r?.value)) === JSON.stringify({
      skip_closed_courses: true, trial_to_course_page: true, retire_smart_inactive_nudges: true,
    }), parseEngagementTargeting(r?.value));
    const a = await audits(db);
    ok("F one audit row naming this migration and the value", a.length === 1 && a[0].details.migration === "20260930180010" &&
      a[0].details.value?.skip_closed_courses === true, a);
    // ── R: replay ──
    const e2 = await apply(db);
    ok("R replay applies cleanly", e2 === null, e2);
    ok("R replay changes nothing and does not audit again", (await audits(db)).length === 1);
    ok("R other settings untouched", (await q(db, "select value from public.platform_settings where key = 'student_miniapp'"))[0]
      ?.value?.enabled === true);
    await db.close();
  }

  // ── O: the owner already set a value ──
  {
    const db = await fresh();
    await db.exec(`insert into public.platform_settings (key, value) values
      ('engagement_targeting', '{"skip_closed_courses": false, "note": "owner"}'::jsonb)`);
    const e = await apply(db);
    ok("O applies cleanly over an owner value", e === null, e);
    ok("O owner value kept exactly", canon((await row(db))?.value) === canon({ note: "owner", skip_closed_courses: false }),
      (await row(db))?.value);
    ok("O no audit row (nothing was seeded)", (await audits(db)).length === 0);
    await db.close();
  }

  // ── M: a malformed existing row ──
  {
    const db = await fresh();
    await db.exec(`insert into public.platform_settings (key, value) values ('engagement_targeting', '[true]'::jsonb)`);
    const e = await apply(db);
    ok("M the self-test refuses a non-object row", e !== null && /not a JSON object/.test(e), e);
    ok("M the failed migration leaves no audit row", (await audits(db)).length === 0);
    await db.close();
  }

  // ── S: nothing else in the file ──
  {
    const code = MIG.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n").toLowerCase();
    const forbidden = ["create function", "create or replace function", "grant ", "revoke ", "cron.schedule", "net.http_post",
      "ops_net_post", "alter ", "drop ", "update ", "delete "];
    const hits = forbidden.filter((f) => code.includes(f));
    ok("S no function / grant / cron / HTTP / DDL / update / delete outside comments", hits.length === 0, hits);
  }

  console.log(`\nengagement_targeting_seed_check: ${pass} passed, ${fail} failed`);
  if (fail > 0) throw new Error(`${fail} check(s) failed`);
}
