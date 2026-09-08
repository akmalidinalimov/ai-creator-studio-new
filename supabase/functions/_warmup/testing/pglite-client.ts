// A PostgREST-shaped Supabase client over PGlite (PostgreSQL compiled to WASM), so the real warmup
// modules can run unmodified against a real database — no Docker, no project, no network round trip.
//
// TEST INFRASTRUCTURE ONLY. Nothing here is imported by a deployed function, so it is never bundled.
//
// It is NOT a general Supabase emulator: it covers exactly the client surface the warmup code uses,
// and anything outside that throws loudly rather than quietly returning nothing. That is deliberate —
// a permissive fake that silently answers "no rows" would let a broken query pass a green test.

import { PGlite } from "npm:@electric-sql/pglite@0.5.8";

type Row = Record<string, any>;
interface Res { data: any; error: { message: string; code?: string } | null; count?: number | null }

const quoteIdent = (s: string) => `"${s.replace(/"/g, '""')}"`;

/** Bind a value, casting the shapes Postgres cannot infer from a bare parameter. */
function bind(value: unknown, params: unknown[]): string {
  if (value === null || value === undefined) return "NULL";
  if (Array.isArray(value)) {
    if (value.every((v) => typeof v === "string")) { params.push(value); return `$${params.length}::text[]`; }
    params.push(JSON.stringify(value)); return `$${params.length}::jsonb`;
  }
  if (typeof value === "object") { params.push(JSON.stringify(value)); return `$${params.length}::jsonb`; }
  params.push(value); return `$${params.length}`;
}

/** PostgREST's .or("a.is.null,a.lt.X") → "(a IS NULL OR a < X)". */
function parseOr(expr: string, params: unknown[]): string {
  const parts = expr.split(",").map((clause) => {
    const [col, op, ...rest] = clause.split(".");
    const raw = rest.join(".");
    switch (op) {
      case "is": return `${quoteIdent(col)} IS ${raw.toUpperCase() === "NULL" ? "NULL" : "NOT NULL"}`;
      case "lt": return `${quoteIdent(col)} < ${bind(raw, params)}`;
      case "lte": return `${quoteIdent(col)} <= ${bind(raw, params)}`;
      case "gt": return `${quoteIdent(col)} > ${bind(raw, params)}`;
      case "gte": return `${quoteIdent(col)} >= ${bind(raw, params)}`;
      case "eq": return `${quoteIdent(col)} = ${bind(raw, params)}`;
      default: throw new Error(`pglite-client: unsupported .or() operator '${op}'`);
    }
  });
  return `(${parts.join(" OR ")})`;
}

class Builder implements PromiseLike<Res> {
  #mode: "select" | "insert" | "update" | "upsert" = "select";
  #cols = "*";
  #returning: string | null = null;
  #payload: Row[] = [];
  #set: Row = {};
  #onConflict: string | null = null;
  #ignoreDuplicates = false;
  #filters: { sql: string; params: unknown[] }[] = [];
  #order: string | null = null;
  #limit: number | null = null;
  #countMode: string | null = null;
  #head = false;
  #single: "maybe" | null = null;

  constructor(private db: PGlite, private schema: string, private table: string) {}
  get #qualified() { return `${quoteIdent(this.schema)}.${quoteIdent(this.table)}`; }

  select(cols = "*", opts?: { count?: string; head?: boolean }) {
    if (this.#mode === "select") this.#cols = cols; else this.#returning = cols;
    if (opts?.count) this.#countMode = opts.count;
    if (opts?.head) this.#head = true;
    return this;
  }
  insert(rows: Row | Row[]) { this.#mode = "insert"; this.#payload = Array.isArray(rows) ? rows : [rows]; return this; }
  upsert(rows: Row | Row[], opts?: { onConflict?: string; ignoreDuplicates?: boolean }) {
    this.#mode = "upsert"; this.#payload = Array.isArray(rows) ? rows : [rows];
    this.#onConflict = opts?.onConflict ?? null; this.#ignoreDuplicates = !!opts?.ignoreDuplicates;
    return this;
  }
  update(obj: Row) { this.#mode = "update"; this.#set = obj; return this; }

  #filter(sql: string, params: unknown[]) { this.#filters.push({ sql, params }); return this; }
  eq(c: string, v: unknown) { const p: unknown[] = []; return this.#filter(`${quoteIdent(c)} = ${bind(v, p)}`, p); }
  neq(c: string, v: unknown) { const p: unknown[] = []; return this.#filter(`${quoteIdent(c)} <> ${bind(v, p)}`, p); }
  lt(c: string, v: unknown) { const p: unknown[] = []; return this.#filter(`${quoteIdent(c)} < ${bind(v, p)}`, p); }
  lte(c: string, v: unknown) { const p: unknown[] = []; return this.#filter(`${quoteIdent(c)} <= ${bind(v, p)}`, p); }
  gte(c: string, v: unknown) { const p: unknown[] = []; return this.#filter(`${quoteIdent(c)} >= ${bind(v, p)}`, p); }
  is(c: string, v: null) { return this.#filter(`${quoteIdent(c)} IS ${v === null ? "NULL" : "NOT NULL"}`, []); }
  in(c: string, arr: unknown[]) {
    if (!arr.length) return this.#filter("FALSE", []);
    const p: unknown[] = [];
    return this.#filter(`${quoteIdent(c)} IN (${arr.map((v) => bind(v, p)).join(",")})`, p);
  }
  or(expr: string) { const p: unknown[] = []; return this.#filter(parseOr(expr, p), p); }
  order(c: string, opts?: { ascending?: boolean }) {
    this.#order = `${quoteIdent(c)} ${opts?.ascending === false ? "DESC" : "ASC"}`; return this;
  }
  limit(n: number) { this.#limit = n; return this; }
  maybeSingle() { this.#single = "maybe"; return this; }

  #where(params: unknown[]): string {
    if (!this.#filters.length) return "";
    const parts = this.#filters.map((f) => {
      let sql = f.sql;
      const offset = params.length;
      f.params.forEach((v, i) => {
        sql = sql.replace(new RegExp(`\\$${i + 1}(?![0-9])`), `$${offset + i + 1}`);
        params.push(v);
      });
      return sql;
    });
    return " WHERE " + parts.join(" AND ");
  }

  #build(): { sql: string; params: unknown[] } {
    const params: unknown[] = [];
    if (this.#mode === "select") {
      if (this.#head && this.#countMode) {
        return { sql: `SELECT count(*)::int AS c FROM ${this.#qualified}${this.#where(params)}`, params };
      }
      let sql = `SELECT ${this.#cols} FROM ${this.#qualified}${this.#where(params)}`;
      if (this.#order) sql += ` ORDER BY ${this.#order}`;
      if (this.#limit !== null) sql += ` LIMIT ${this.#limit}`;
      return { sql, params };
    }
    if (this.#mode === "update") {
      const sets = Object.entries(this.#set).map(([k, v]) => `${quoteIdent(k)} = ${bind(v, params)}`);
      let sql = `UPDATE ${this.#qualified} SET ${sets.join(", ")}${this.#where(params)}`;
      if (this.#returning) sql += ` RETURNING ${this.#returning}`;
      return { sql, params };
    }
    const cols = [...new Set(this.#payload.flatMap((r) => Object.keys(r)))];
    const values = this.#payload
      .map((r) => `(${cols.map((c) => bind(r[c] === undefined ? null : r[c], params)).join(",")})`).join(", ");
    let sql = `INSERT INTO ${this.#qualified} (${cols.map(quoteIdent).join(",")}) VALUES ${values}`;
    if (this.#mode === "upsert") {
      const target = this.#onConflict
        ? `(${this.#onConflict.split(",").map((c) => quoteIdent(c.trim())).join(",")})` : "";
      if (this.#ignoreDuplicates || !this.#onConflict) sql += ` ON CONFLICT ${target} DO NOTHING`;
      else {
        const keys = this.#onConflict.split(",").map((c) => c.trim());
        const updates = cols.filter((c) => !keys.includes(c))
          .map((c) => `${quoteIdent(c)} = EXCLUDED.${quoteIdent(c)}`);
        sql += ` ON CONFLICT ${target} DO UPDATE SET ${updates.join(", ")}`;
      }
    }
    if (this.#returning) sql += ` RETURNING ${this.#returning}`;
    return { sql, params };
  }

  async #run(): Promise<Res> {
    const { sql, params } = this.#build();
    try {
      const r = await this.db.query(sql, params);
      const rows = (r.rows || []) as Row[];
      if (this.#head && this.#countMode) return { data: null, error: null, count: rows[0]?.c ?? 0 };
      if (this.#single === "maybe") return { data: rows[0] ?? null, error: null };
      if (this.#mode !== "select" && !this.#returning) return { data: null, error: null };
      return { data: rows, error: null, count: rows.length };
    } catch (e) {
      const err = e as { message?: string; code?: string };
      return { data: null, error: { message: String(err?.message ?? e), code: err?.code }, count: null };
    }
  }

  then<A = Res, B = never>(
    onfulfilled?: ((v: Res) => A | PromiseLike<A>) | null,
    onrejected?: ((r: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return this.#run().then(onfulfilled, onrejected);
  }
}

class Client {
  constructor(private db: PGlite, private currentSchema = "public") {}
  schema(name: string) { return new Client(this.db, name); }
  from(table: string) { return new Builder(this.db, this.currentSchema, table); }
  rpc(name: string): Promise<Res> {
    if (name === "internal_fn_secret") return Promise.resolve({ data: "test-secret", error: null });
    return Promise.resolve({ data: null, error: { message: `pglite-client: unmocked rpc '${name}'` } });
  }
}

export function fakeSupabase(db: PGlite): any {
  return new Client(db) as unknown as any;
}

/**
 * The warmup migration as it will actually be applied.
 *
 * pgvector is not bundled with PGlite, so CREATE EXTENSION and the VECTOR(1536) column are stubbed —
 * the only two lines not executed verbatim. Both are already proven in this project by migrations
 * 20260426191329 and 20260427203208.
 */
export async function warmupMigrationSql(): Promise<string> {
  const migPath = new URL("../../../migrations/20260908120000_warmup_schema.sql", import.meta.url);
  const sql = await Deno.readTextFile(migPath);
  return sql.replace(/CREATE EXTENSION IF NOT EXISTS vector;/, "").replace(/VECTOR\(1536\)/, "TEXT");
}

/**
 * Boot a PostgreSQL and apply the warmup migration to it.
 *
 * `seed` runs BEFORE the migration, so a caller can stand up a mock LMS `public` schema and then
 * prove the migration left it untouched.
 */
export async function bootWarmupDb(
  opts?: { seed?: (db: PGlite) => Promise<void> },
): Promise<{ db: PGlite; admin: any }> {
  const db = new PGlite();
  await db.waitReady;

  // Roles PGlite does not ship with; service_role holds BYPASSRLS in Supabase.
  for (const r of ["service_role", "anon", "authenticated"]) await db.exec(`CREATE ROLE ${r} NOLOGIN;`);
  await db.exec(`ALTER ROLE service_role BYPASSRLS;`);

  if (opts?.seed) await opts.seed(db);

  await db.exec(await warmupMigrationSql());

  // The kill switch lives in public, which warmup only ever READS. A seeded run supplies its own.
  if (!opts?.seed) {
    await db.exec(`CREATE TABLE public.platform_settings (key text primary key, value jsonb not null);`);
  }

  return { db, admin: fakeSupabase(db) };
}
