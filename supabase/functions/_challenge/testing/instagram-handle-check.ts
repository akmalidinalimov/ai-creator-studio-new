// PGlite harness for 20260930154000_instagram_handle_parse.sql (the Instagram handle parse rule).
//
//   deno test -A --node-modules-dir=none --no-lock supabase/functions/_challenge/testing/instagram-handle-check.ts
//
// Builds production's shape of everything the migration touches on a real PostgreSQL (PGlite, PG 17, citext):
// Supabase's roles and default privileges, auth.uid()/auth.role(), profiles with its live instagram columns,
// unique index, RLS "update own" policy, and the LIVE trigger bodies (normalize_instagram_username at the md5
// the migration pins, profiles_instagram_audit, update_updated_at_column). Then it checks: the pin refuses a
// drifted body; the file applies and replays (one audit row); grants (anon nothing; authenticated and
// service_role can run both helpers); the student path (a valid handle is stored normalized, a reel link /
// a handle-less link / bad characters keep the old handle and leave ONE admin_actions row each, deduped per
// minute, a blank clears, another student's handle is a 23505); the staff-intake path (service_role); an
// INSERT never stores a refused value; a direct RPC call of the note writes nothing; and the SQL parse rule
// agrees with src/lib/instagramHandle.ts on every parity case plus a fuzz set.
// MIG_PATH=<file> tests a draft before it is written into its (edit-guarded) slot.
//
// CI NOTE: named *-check.ts, not *_test.ts, so CI's `deno test supabase/functions/` never collects it (the
// sibling harnesses' convention: PGlite needs -A). The pure rule it cross-checks is ALSO covered by vitest
// (src/test/instagramHandle.test.ts reads the migration's reserved list and parity cases), which gates merges;
// the SQL side also self-tests at apply time. TEST INFRASTRUCTURE ONLY: no index.ts, never deployed.

import { parseInstagramHandle } from "../../../../src/lib/instagramHandle.ts";

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

const granted = (name: "read" | "env" | "net") => {
  try { return Deno.permissions.querySync({ name }).state === "granted"; } catch { return false; }
};
const CAN_RUN = granted("read") && granted("env") && granted("net");

const here = (p: string) => new URL(p, import.meta.url);
const lf = (s: string) => s.replace(/\r\n/g, "\n"); // a Windows checkout is CRLF; production text is LF

const S1 = "aaaaaaaa-0000-0000-0000-000000000001"; // student, no handle
const S2 = "aaaaaaaa-0000-0000-0000-000000000002"; // student, handle 'taken.one'
const S3 = "aaaaaaaa-0000-0000-0000-000000000003"; // auth user with no profile yet (the INSERT path)
const AD = "aaaaaaaa-0000-0000-0000-00000000000a"; // admin

// normalize_instagram_username exactly as production has it (pg_get_functiondef, 2026-09-30; prosrc md5
// c872c1b43db3b0dc23e00633d17fdea2 — the migration's pin, so a wrong copy here fails the apply).
const NORMALIZE_LIVE = `CREATE OR REPLACE FUNCTION public.normalize_instagram_username()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
declare _v text;
begin
  if new.instagram_username is null then
    return new;
  end if;
  begin
    _v := lower(btrim(new.instagram_username::text));
    if _v like '%instagram.com/%' then
      _v := split_part(split_part(_v, 'instagram.com/', 2), '?', 1);   -- strip query string
      _v := split_part(_v, '/', 1);                                    -- first path segment
    end if;
    _v := regexp_replace(_v, '^@+', '');
    _v := nullif(btrim(_v), '');
    if _v is not null and _v !~ '^[a-z0-9._]{1,30}$' then
      -- Unusable input must never silently WIPE a handle that already earned points: keep the old
      -- value on an update, and store nothing on an insert.
      if tg_op = 'UPDATE' then
        new.instagram_username := old.instagram_username;
        return new;
      end if;
      _v := null;
    end if;
    new.instagram_username := _v::citext;
  exception when others then
    return new;
  end;
  return new;
end;
$function$
`;

const SCHEMA = `
set timezone = 'UTC';
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant anon, authenticated, service_role to postgres;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges revoke execute on functions from public;
alter default privileges in schema public grant execute on functions to authenticated, service_role;

create extension if not exists citext;
create schema auth;
grant usage on schema auth to anon, authenticated, service_role;
create table auth.users (id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create function auth.role() returns text language sql stable as $$
  select nullif(current_setting('request.jwt.claim.role', true), '') $$;
grant execute on function auth.uid(), auth.role() to anon, authenticated, service_role;

create type public.app_role as enum ('admin', 'student', 'teacher', 'superadmin');
create type public.user_status as enum ('active', 'inactive', 'archived');
create table public.user_roles (id uuid primary key default gen_random_uuid(), user_id uuid not null,
  role public.app_role not null, unique (user_id, role));
create function public.has_role(_user_id uuid, _role public.app_role) returns boolean
  language sql stable security definer set search_path to 'public' as $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role); $$;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text, email text not null unique, status public.user_status not null default 'active',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  archived_at timestamptz, instagram_username citext);
create unique index uq_profiles_instagram_username on public.profiles (instagram_username) where instagram_username is not null;
alter table public.profiles enable row level security;
create policy "profiles select own or admin" on public.profiles for select
  using ((auth.uid() = id) or has_role(auth.uid(), 'admin'::app_role));
create policy "profiles update own or admin" on public.profiles for update
  using ((auth.uid() = id) or has_role(auth.uid(), 'admin'::app_role));
create policy "profiles insert self" on public.profiles for insert
  with check ((auth.uid() = id) or has_role(auth.uid(), 'admin'::app_role));

create table public.admin_actions (id uuid primary key default gen_random_uuid(), actor_user_id uuid,
  action text not null, target_user_id uuid, target_resource_type text, target_resource_id uuid,
  details jsonb not null default '{}'::jsonb, created_at timestamptz not null default now());
alter table public.admin_actions enable row level security;
create policy "admin_actions admin read" on public.admin_actions for select using (has_role(auth.uid(), 'admin'::app_role));

-- Live trigger bodies (2026-09-30).
create function public.update_updated_at_column() returns trigger language plpgsql as $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;
${NORMALIZE_LIVE};
grant execute on function public.normalize_instagram_username() to public, anon;
CREATE OR REPLACE FUNCTION public.profiles_instagram_audit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  begin
    insert into public.admin_actions (actor_user_id, action, target_user_id, details)
    values (auth.uid(), 'instagram_handle_changed', new.id,
            jsonb_build_object('old', old.instagram_username::text, 'new', new.instagram_username::text,
                               'actor', auth.uid(), 'jwt_role', auth.role(),
                               'request_role', current_setting('role', true)));
  exception when others then
    null;  -- the audit must never block the student's own save
  end;
  return null;
end;
$function$;
revoke execute on function public.profiles_instagram_audit() from public, authenticated;
create trigger trg_profiles_normalize_instagram before insert or update of instagram_username on public.profiles
  for each row execute function normalize_instagram_username();
create trigger trg_profiles_updated before update on public.profiles for each row execute function update_updated_at_column();
create trigger trg_profiles_zz_instagram_audit after update of instagram_username on public.profiles
  for each row when (old.instagram_username is distinct from new.instagram_username) execute function profiles_instagram_audit();

insert into auth.users (id) values ('${S1}'), ('${S2}'), ('${S3}'), ('${AD}');
insert into public.user_roles (user_id, role) values ('${S1}', 'student'), ('${S2}', 'student'), ('${S3}', 'student'), ('${AD}', 'admin');
insert into public.profiles (id, name, email, created_at) values
  ('${AD}', 'Admin', 'ad@x.uz', now() - interval '90 days'),
  ('${S1}', 'Ali', 's1@x.uz', now() - interval '30 days'),
  ('${S2}', 'Vali', 's2@x.uz', now() - interval '20 days');
update public.profiles set instagram_username = 'taken.one' where id = '${S2}';
delete from public.admin_actions;
`;

Deno.test({
  name: CAN_RUN
    ? "instagram_handle_parse: 20260930154000 on PGlite (pin, grants, student/staff/insert paths, TS parity)"
    : "instagram_handle_parse: SKIPPED -- needs `deno test -A --node-modules-dir=none` (PGlite reads its own files)",
  ignore: !CAN_RUN,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: run,
});

async function run() {
  const spec = "npm:@electric-sql/pglite@" + "0.5.8"; // non-literal: never resolved or type-checked unless this runs
  // deno-lint-ignore no-explicit-any
  const { PGlite } = (await import(spec)) as any;
  // deno-lint-ignore no-explicit-any
  const { citext } = (await import(spec + "/contrib/citext")) as any;

  const MIG_PATH = Deno.env.get("MIG_PATH");
  const MIG = lf(await Deno.readTextFile(MIG_PATH ?? here("../../../migrations/20260930154000_instagram_handle_parse.sql")));

  let pass = 0, fail = 0;
  const ok = (name: string, cond: boolean, detail?: unknown) => {
    if (cond) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}${detail !== undefined ? "  — " + JSON.stringify(detail) : ""}`); }
  };
  // deno-lint-ignore no-explicit-any
  const freshDb = async (): Promise<any> => {
    const db = await PGlite.create({ extensions: { citext } });
    await db.exec(SCHEMA);
    return db;
  };
  // deno-lint-ignore no-explicit-any
  const q = async (db: any, sql: string, params: unknown[] = []): Promise<Row[]> => (await db.query(sql, params)).rows;
  // deno-lint-ignore no-explicit-any
  const one = async (db: any, sql: string, params: unknown[] = []): Promise<Row> => (await q(db, sql, params))[0];
  // deno-lint-ignore no-explicit-any
  const tx = async (db: any, sql: string): Promise<string | null> => {
    try { await db.exec("begin;\n" + sql + "\ncommit;"); return null; }
    catch (e) { try { await db.exec("rollback;"); } catch { /* none open */ } return String((e as Error).message); }
  };
  /** Runs `sql` in its own transaction as `role` with auth.uid() = uid (the PostgREST shape). */
  // deno-lint-ignore no-explicit-any
  const as = async (db: any, role: string, uid: string | null, sql: string, params: unknown[] = []):
    Promise<{ rows: Row[] | null; err: string | null; code?: string }> => {
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
      // deno-lint-ignore no-explicit-any
      return { rows: null, err: String((e as Error).message), code: (e as any)?.code };
    }
  };
  // deno-lint-ignore no-explicit-any
  const handleOf = async (db: any, id: string) => (await one(db, "select instagram_username::text h from public.profiles where id = $1", [id]))?.h ?? null;
  // deno-lint-ignore no-explicit-any
  const rejections = async (db: any, id: string) =>
    await q(db, "select actor_user_id, details from public.admin_actions where action = 'instagram_handle_rejected' and target_user_id = $1 order by created_at, id", [id]);

  // ───────────── P. the pin ─────────────
  console.log("P. refuses a drifted trigger body");
  {
    const d = await freshDb();
    await d.exec(NORMALIZE_LIVE.replace("-- strip query string", "-- strip the query string"));
    const e = await tx(d, MIG);
    ok("P1 a changed normalize_instagram_username aborts with 'regenerate'", !!e && e.includes("ABORT: normalize_instagram_username changed"), e);
    ok("P2 ...and nothing was created", (await one(d, "select to_regprocedure('public.instagram_handle_parse(text)') is null n")).n === true);
    await d.close();
  }

  // ───────────── B. the bug, reproduced on the live body ─────────────
  console.log("B. the live body (before this migration)");
  {
    const d = await freshDb();
    const set = (v: string) => as(d, "authenticated", S1, "update public.profiles set instagram_username = $2 where id = $1 returning instagram_username::text h", [S1, v]);
    const b1 = await set("https://www.instagram.com/reel/C8xYz12/?igsh=abc");
    ok("B1 live: a reel link is stored as 'reel'", b1.rows?.[0]?.h === "reel", b1);
    const b2 = await set("my handle");
    ok("B2 live: 'my handle' is dropped (old value kept) with no record", b2.rows?.[0]?.h === "reel" &&
      Number((await one(d, "select count(*) n from public.admin_actions where details::text like '%my handle%'")).n) === 0, b2);
    const b3 = await set("https://instagram.com/");
    ok("B3 live: 'https://instagram.com/' CLEARS the handle", b3.rows?.[0]?.h === null, b3);
    await d.close();
  }

  const db = await freshDb();

  // ───────────── A. apply + replay ─────────────
  console.log("A. applies and replays");
  {
    const e1 = await tx(db, MIG);
    ok("A1 the migration applies (its own self-test passes)", e1 === null, e1);
    const md1 = (await one(db, "select md5(prosrc) m from pg_proc where oid = 'public.normalize_instagram_username()'::regprocedure")).m;
    const e2 = await tx(db, MIG);
    ok("A2 a replay applies cleanly", e2 === null, e2);
    const md2 = (await one(db, "select md5(prosrc) m from pg_proc where oid = 'public.normalize_instagram_username()'::regprocedure")).m;
    ok("A3 the replay left the trigger body as it was", md1 === md2);
    const audit = await q(db, "select details from public.admin_actions where action = 'instagram_handle_parse_applied'");
    ok("A4 exactly one audit row, and its end-to-end self-test RAN", audit.length === 1 && audit[0].details.self_test === "ran", audit);
    ok("A5 the self-test left nothing behind", Number((await one(db,
      "select count(*) n from public.admin_actions where action in ('instagram_handle_rejected', 'instagram_handle_changed')")).n) === 0
      && (await handleOf(db, S1)) === null);
    const prof = await one(db, "select proacl::text acl, prosecdef from pg_proc where oid = 'public.normalize_instagram_username()'::regprocedure");
    ok("A6 normalize_instagram_username keeps its ACL and stays SECURITY INVOKER",
      prof.prosecdef === false && String(prof.acl).includes("=X/"), prof);
  }

  // ───────────── G. grants ─────────────
  console.log("G. grants");
  {
    const r = await one(db, `select
        has_function_privilege('anon', 'public.instagram_handle_parse(text)', 'EXECUTE') anon_parse,
        has_function_privilege('anon', 'public.instagram_handle_note_rejection(uuid,text,text,text)', 'EXECUTE') anon_note,
        has_function_privilege('authenticated', 'public.instagram_handle_parse(text)', 'EXECUTE') auth_parse,
        has_function_privilege('authenticated', 'public.instagram_handle_note_rejection(uuid,text,text,text)', 'EXECUTE') auth_note,
        has_function_privilege('service_role', 'public.instagram_handle_note_rejection(uuid,text,text,text)', 'EXECUTE') srv_note`);
    ok("G1 anon can execute neither helper", r.anon_parse === false && r.anon_note === false, r);
    ok("G2 authenticated and service_role can (the INVOKER trigger calls them as the writer)",
      r.auth_parse && r.auth_note && r.srv_note, r);
    const direct = await as(db, "authenticated", S1, "select public.instagram_handle_note_rejection($1, 'forged', 'bad_chars', 'UPDATE')", [S2]);
    ok("G3 a direct RPC call of the note as a student writes nothing (trigger depth 0)",
      direct.err === null && Number((await one(db, "select count(*) n from public.admin_actions where details->>'input' = 'forged'")).n) === 0, direct);
    const anonCall = await as(db, "anon", null, "select * from public.instagram_handle_parse('x')");
    ok("G4 anon calling the parse is refused", anonCall.err !== null && /permission denied/i.test(anonCall.err), anonCall);
  }

  // ───────────── S. the student path (Settings.tsx) ─────────────
  console.log("S. a student's own saves");
  {
    const u1 = await as(db, "authenticated", S1, "update public.profiles set instagram_username = $2 where id = $1 returning instagram_username::text h", [S1, "@My.Handle"]);
    ok("S1 '@My.Handle' is stored as 'my.handle'", u1.rows?.[0]?.h === "my.handle", u1);
    const reel = "https://www.instagram.com/reel/C8xYz12/?igsh=abc";
    const u2 = await as(db, "authenticated", S1, "update public.profiles set instagram_username = $2 where id = $1 returning instagram_username::text h", [S1, reel]);
    ok("S2 a reel link keeps 'my.handle' (was stored as 'reel')", u2.rows?.[0]?.h === "my.handle", u2);
    await as(db, "authenticated", S1, "update public.profiles set instagram_username = $2 where id = $1", [S1, reel]);
    let rj = await rejections(db, S1);
    ok("S3 ...and leaves ONE 'instagram_handle_rejected' row (a second tap within a minute is deduped)",
      rj.length === 1 && rj[0].details.reason === "not_profile_link" && rj[0].details.input === reel && rj[0].actor_user_id === S1
        && rj[0].details.jwt_role === "authenticated" && rj[0].details.op === "UPDATE", rj);
    const u3 = await as(db, "authenticated", S1, "update public.profiles set instagram_username = $2 where id = $1 returning instagram_username::text h", [S1, "https://instagram.com/"]);
    ok("S4 'https://instagram.com/' keeps the handle (used to CLEAR it)", u3.rows?.[0]?.h === "my.handle", u3);
    const u4 = await as(db, "authenticated", S1, "update public.profiles set instagram_username = $2 where id = $1 returning instagram_username::text h", [S1, "my handle"]);
    ok("S5 'my handle' keeps the handle", u4.rows?.[0]?.h === "my.handle", u4);
    rj = await rejections(db, S1);
    ok("S6 three distinct refusals, three rows, with their reasons",
      JSON.stringify(rj.map((r) => r.details.reason)) === JSON.stringify(["not_profile_link", "no_handle_in_link", "bad_chars"]), rj.map((r) => r.details));
    const taken = await as(db, "authenticated", S1, "update public.profiles set instagram_username = $2 where id = $1", [S1, "@Taken.One"]);
    ok("S7 another student's handle is a unique violation on uq_profiles_instagram_username (the app maps it to 'band')",
      taken.err !== null && taken.err.includes("uq_profiles_instagram_username"), taken);
    ok("S8 ...and the student's handle is untouched", (await handleOf(db, S1)) === "my.handle");
    const u5 = await as(db, "authenticated", S1, "update public.profiles set instagram_username = $2 where id = $1 returning instagram_username::text h", [S1, ""]);
    ok("S9 a blank field clears the handle", u5.rows?.[0]?.h === null, u5);
    const other = await as(db, "authenticated", S1, "update public.profiles set instagram_username = 'x.y' where id = $1 returning id", [S2]);
    ok("S10 RLS still limits a student to their own row", other.err === null && (other.rows ?? []).length === 0, other);
    const changed = await q(db, "select details from public.admin_actions where action = 'instagram_handle_changed' and target_user_id = $1", [S1]);
    ok("S11 the existing audit still records real changes (set + clear), and nothing for the refused ones",
      changed.length === 2, changed.map((r) => r.details));
  }

  // ───────────── T. staff intake (service_role) and INSERT ─────────────
  console.log("T. staff intake and the INSERT path");
  {
    const t1 = await as(db, "service_role", null, "update public.profiles set instagram_username = $2 where id = $1 returning instagram_username::text h", [S2, "https://www.instagram.com/p/XYZ/"]);
    ok("T1 staff intake pasting a post link keeps the student's handle", t1.rows?.[0]?.h === "taken.one", t1);
    const rj = await rejections(db, S2);
    ok("T2 ...and records it with the service_role", rj.length === 1 && rj[0].details.jwt_role === "service_role" && rj[0].details.reason === "not_profile_link", rj);
    const t3 = await as(db, "service_role", null, "insert into public.profiles (id, email, instagram_username) values ($1, 's3@x.uz', $2) returning instagram_username::text h", [S3, "https://www.instagram.com/reel/abc/"]);
    ok("T3 an INSERT with a reel link stores NULL, never 'reel'", t3.rows?.[0]?.h === null, t3);
    const rj3 = await rejections(db, S3);
    ok("T4 ...and records op INSERT", rj3.length === 1 && rj3[0].details.op === "INSERT", rj3);
    const t5 = await as(db, "service_role", null, "update public.profiles set instagram_username = $2 where id = $1 returning instagram_username::text h", [S3, " https://www.instagram.com/Good.Name/?igsh=1 "]);
    ok("T5 a profile link from staff is stored normalized", t5.rows?.[0]?.h === "good.name", t5);
  }

  // ───────────── X. SQL <-> TS parity ─────────────
  console.log("X. the SQL rule agrees with src/lib/instagramHandle.ts");
  {
    const block = MIG.split("-- parity-cases:begin")[1]?.split("-- parity-cases:end")[0] ?? "";
    const caseInputs = [...block.matchAll(/^\s*\('((?:[^']|'')*)',/gm)].map((m) => m[1].replace(/''/g, "'"));
    ok("X1 the migration carries its parity cases", caseInputs.length >= 20, caseInputs.length);
    const fuzz = [
      "@a", "a", "A_B.C", "@@@x", " x ", "instagram.com/x/y/z", "INSTAGRAM.COM/USER", "https://m.instagram.com/user?x=1",
      "instagram.com/reels/", "instagram.com/tv/abc", "instagram.com/accounts/login/", "instagram.com/direct/inbox",
      "instagram.com/s/abc", "instagram.com/about/", "instagram.com/web/", "instagram.com/developer",
      "instagram.com/legal/", "instagram.com/#", "http://instagram.com/?", "x".repeat(30), "x".repeat(31),
      "user.name_", "_user", "user..name", "ali@gmail.com", "@ali@", "ali!", "1234567890", "instagram.co",
      "facebook.com/someone", "@instagram.com", "instagram.com/@", "instagram.com/@@x",
    ];
    const mismatches: unknown[] = [];
    for (const input of [...caseInputs, ...fuzz]) {
      const sql = await one(db, "select handle, reason from public.instagram_handle_parse($1)", [input]);
      const ts = parseInstagramHandle(input);
      const tsHandle = ts.ok ? ts.handle : null;
      const tsReason = ts.ok ? null : ts.reason;
      if ((sql.handle ?? null) !== tsHandle || (sql.reason ?? null) !== tsReason) mismatches.push({ input, sql, ts });
    }
    ok("X2 every parity case and fuzz input parses the same in SQL and TS", mismatches.length === 0, mismatches);
  }

  await db.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) throw new Error(`${fail} check(s) failed`);
}
