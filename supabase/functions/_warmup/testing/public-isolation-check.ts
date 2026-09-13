// "Will the warm-up bot affect the course platform or its student data?"
//
//   deno run -A --node-modules-dir=none supabase/functions/_warmup/testing/public-isolation-check.ts
//
// This answers that question with evidence instead of assurance. It stands up a mock LMS `public`
// schema — students, enrolments, XP, homework, settings, the webhook inbox — takes a complete
// fingerprint of it, applies the warmup migration, and fingerprints it again. Anything that differs
// is a failure.
//
// The fingerprint covers more than row counts, because "no rows changed" is not the same as "no
// harm done": it pins every object, column, default, constraint, index, trigger, RLS flag, grant,
// and the full contents of every table.
//
// Run this after ANY edit to the migration. It is the check that makes the isolation claim
// falsifiable rather than a promise.

import { bootWarmupDb } from "./pglite-client.ts";
import type { PGlite } from "npm:@electric-sql/pglite@0.5.8";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, d = "") => {
  if (c) { pass++; console.log(`  PASS  ${n}${d ? "  — " + d : ""}`); }
  else { fail++; console.log(`  FAIL  ${n}${d ? "  — " + d : ""}`); }
};

/** A mock of the LMS tables the warm-up bot reads, with data in them. */
async function seedLms(db: PGlite): Promise<void> {
  await db.exec(`
    CREATE TABLE public.profiles (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      telegram_id bigint UNIQUE,
      full_name text NOT NULL,
      status text NOT NULL DEFAULT 'active',
      preferred_locale text DEFAULT 'uz',
      archived_at timestamptz
    );
    CREATE TABLE public.courses (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title text NOT NULL);
    CREATE TABLE public.enrollments (
      id bigserial PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES public.profiles(id),
      course_id uuid NOT NULL REFERENCES public.courses(id)
    );
    CREATE TABLE public.xp_events (
      id bigserial PRIMARY KEY, user_id uuid NOT NULL, points int NOT NULL,
      ref_key text UNIQUE, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE public.homework_submissions (
      id bigserial PRIMARY KEY, user_id uuid NOT NULL, media jsonb NOT NULL DEFAULT '[]'::jsonb,
      submitted_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE public.platform_settings (
      key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE public.webhook_inbox (
      id bigserial PRIMARY KEY, update_type text, raw_update jsonb NOT NULL,
      received_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE public.admin_actions (
      id bigserial PRIMARY KEY, action text NOT NULL, details jsonb, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX profiles_status_idx ON public.profiles (status);
    ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.enrollments ENABLE ROW LEVEL SECURITY;
    CREATE POLICY "profiles self read" ON public.profiles FOR SELECT USING (true);
    GRANT SELECT ON public.platform_settings TO anon, authenticated;
    GRANT ALL ON public.profiles TO service_role;
  `);

  // Real-ish student data. If the migration touches ANY of this, the diff will show it.
  await db.exec(`
    INSERT INTO public.courses (id, title) VALUES
      ('11111111-1111-1111-1111-111111111111','AI Creators Course');
    INSERT INTO public.profiles (id, telegram_id, full_name, preferred_locale) VALUES
      ('22222222-2222-2222-2222-222222222222', 501, 'Muhlisa A.', 'uz'),
      ('33333333-3333-3333-3333-333333333333', 502, 'Bekzod T.', 'ru'),
      ('44444444-4444-4444-4444-444444444444', 503, 'Nilufar S.', 'uz');
    INSERT INTO public.enrollments (user_id, course_id) VALUES
      ('22222222-2222-2222-2222-222222222222','11111111-1111-1111-1111-111111111111'),
      ('33333333-3333-3333-3333-333333333333','11111111-1111-1111-1111-111111111111');
    INSERT INTO public.xp_events (user_id, points, ref_key) VALUES
      ('22222222-2222-2222-2222-222222222222', 50, 'hw:1'),
      ('33333333-3333-3333-3333-333333333333', 30, 'hw:2');
    INSERT INTO public.homework_submissions (user_id, media) VALUES
      ('22222222-2222-2222-2222-222222222222', '[{"kind":"photo"}]'::jsonb);
    INSERT INTO public.platform_settings (key, value) VALUES
      ('broadcast','{"enabled": true}'::jsonb), ('telegram','{"bot":"lms"}'::jsonb);
    INSERT INTO public.webhook_inbox (update_type, raw_update) VALUES ('message','{"x":1}'::jsonb);
    INSERT INTO public.admin_actions (action, details) VALUES ('seed','{}'::jsonb);
  `);
}

/** Everything about `public` that could possibly change, as one comparable structure. */
async function fingerprint(db: PGlite): Promise<Record<string, unknown>> {
  const q = async (sql: string) => (await db.query(sql)).rows as any[];

  const objects = await q(`select relname, relkind, relrowsecurity from pg_class c
    join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' order by relname, relkind`);
  const columns = await q(`select table_name, column_name, data_type, is_nullable, column_default
    from information_schema.columns where table_schema='public' order by table_name, column_name`);
  const constraints = await q(`select conrelid::regclass::text tbl, conname, pg_get_constraintdef(oid) def
    from pg_constraint where connamespace='public'::regnamespace order by tbl, conname`);
  const indexes = await q(`select tablename, indexname, indexdef from pg_indexes
    where schemaname='public' order by tablename, indexname`);
  const triggers = await q(`select event_object_table tbl, trigger_name, action_statement
    from information_schema.triggers where trigger_schema='public' order by tbl, trigger_name`);
  const policies = await q(`select tablename, policyname, qual::text from pg_policies
    where schemaname='public' order by tablename, policyname`);
  const grants = await q(`select grantee, table_name, privilege_type from information_schema.role_table_grants
    where table_schema='public' order by grantee, table_name, privilege_type`);
  const functions = await q(`select proname, pg_get_function_identity_arguments(oid) args
    from pg_proc where pronamespace='public'::regnamespace order by proname, args`);

  // Full contents of every table, not just counts — an UPDATE would not move a count.
  const tables = objects.filter((o) => o.relkind === "r").map((o) => o.relname);
  const contents: Record<string, unknown[]> = {};
  for (const t of tables) {
    contents[t] = await q(`select * from public.${t} order by 1`);
  }

  return { objects, columns, constraints, indexes, triggers, policies, grants, functions, contents };
}

console.log("Standing up a mock LMS public schema, then applying the warmup migration to it.\n");

// Boot with the LMS seeded FIRST, so the migration runs against a populated public schema.
let beforeSnapshot: Record<string, unknown> | null = null;
const { db } = await bootWarmupDb({
  seed: async (d) => {
    await seedLms(d);
    beforeSnapshot = await fingerprint(d);
  },
});
const before = beforeSnapshot!;
const after = await fingerprint(db);

console.log("=== the public schema is byte-identical before and after ===");
for (const facet of ["objects", "columns", "constraints", "indexes", "triggers", "policies", "grants", "functions"]) {
  const b = JSON.stringify((before as any)[facet]);
  const a = JSON.stringify((after as any)[facet]);
  const n = ((before as any)[facet] as unknown[]).length;
  ok(`public ${facet} unchanged (${n} recorded)`, b === a,
     b === a ? "" : `DIFF\n    before: ${b.slice(0, 300)}\n    after:  ${a.slice(0, 300)}`);
}

console.log("\n=== student data is untouched, row for row ===");
const bc = before.contents as Record<string, unknown[]>;
const ac = after.contents as Record<string, unknown[]>;
ok("same set of public tables", JSON.stringify(Object.keys(bc)) === JSON.stringify(Object.keys(ac)));
for (const t of Object.keys(bc)) {
  ok(`public.${t} identical (${bc[t].length} rows)`, JSON.stringify(bc[t]) === JSON.stringify(ac[t]));
}

console.log("\n=== the migration adds only the warmup schema ===");
const schemas = (await db.query(
  `select nspname from pg_namespace where nspname not like 'pg_%' and nspname <> 'information_schema' order by 1`,
)).rows as any[];
ok("schemas are exactly public + warmup", schemas.map((r) => r.nspname).join(",") === "public,warmup",
   schemas.map((r) => r.nspname).join(","));
const warmupTables = (await db.query(
  `select count(*)::int n from information_schema.tables where table_schema='warmup' and table_type='BASE TABLE'`,
)).rows[0] as any;
ok("12 warmup tables created", warmupTables.n === 12, `${warmupTables.n}`);

console.log("\n=== static check: the migration text names no public object ===");
const { warmupMigrationSql } = await import("./pglite-client.ts");
const sql = await warmupMigrationSql();
const code = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
const publicRefs = code.match(/\bpublic\.\w+/g) ?? [];
ok("no `public.<object>` reference in any executable line", publicRefs.length === 0, publicRefs.join(" "));
for (const verb of ["DROP", "TRUNCATE", "DELETE", "UPDATE"]) {
  const hits = code.match(new RegExp(`^\\s*${verb}\\b`, "gmi")) ?? [];
  ok(`no top-level ${verb} statement anywhere in the migration`, hits.length === 0, `${hits.length} found`);
}
// ALTER is expected, but only ever against warmup objects.
const alters = (code.match(/^\s*ALTER\s+TABLE\s+(\S+)/gmi) ?? []).map((s) => s.trim().split(/\s+/)[2]);
ok("every ALTER TABLE targets a warmup table",
   alters.length > 0 && alters.every((t) => t.startsWith("warmup.")),
   `${alters.length} ALTERs, all warmup.*`);

console.log(`\n${"=".repeat(60)}\n  ${pass} passed, ${fail} failed\n${"=".repeat(60)}`);
if (fail) Deno.exit(1);
