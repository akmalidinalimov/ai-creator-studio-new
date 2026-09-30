// A tiny in-memory stand-in for the supabase-js query builder, for the bot's unit tests (menu sweep, ☰ live
// sync, Bugun emas, welcome). TEST INFRASTRUCTURE ONLY: this directory has no index.ts, so it is never
// deployed. It implements exactly the calls those modules make — select / insert / update(…).select(),
// eq / in / is / not(col,"is",null) / gt / gte / order / limit / maybeSingle — plus "col->>key" json paths.
// A table listed in `failOn` answers every read AND write with an error, to drive the failure paths.

// deno-lint-ignore no-explicit-any
export type Row = Record<string, any>;

const get = (r: Row, col: string): unknown => {
  const m = /^(\w+)->>(\w+)$/.exec(col);
  if (m) {
    const v = r[m[1]]?.[m[2]];
    return v === undefined || v === null ? null : String(v);
  }
  return r[col];
};

export class FakeDb {
  tables: Record<string, Row[]> = {};
  failOn = new Set<string>();
  /** Every write, in order: [table, op, row-or-patch]. */
  writes: [string, string, Row][] = [];
  /** Unique keys per table (insert conflicts answer 23505). */
  unique: Record<string, string> = { app_settings: "key" };
  private seq = 0;

  constructor(tables: Record<string, Row[]> = {}) {
    for (const [k, v] of Object.entries(tables)) this.tables[k] = v.map((r) => ({ ...r }));
  }

  rows(table: string): Row[] {
    return (this.tables[table] ??= []);
  }

  /** admin_actions rows with this action. */
  actions(action: string): Row[] {
    return this.rows("admin_actions").filter((r) => r.action === action);
  }

  from(table: string) {
    return new Query(this, table);
  }

  nextId(): string {
    this.seq++;
    return `00000000-0000-4000-8000-${String(this.seq).padStart(12, "0")}`;
  }
}

class Query {
  private op: "select" | "update" = "select";
  private patch: Row = {};
  private filters: ((r: Row) => boolean)[] = [];
  private orderBy: { col: string; asc: boolean } | null = null;
  private lim: number | null = null;

  constructor(private db: FakeDb, private table: string) {}

  select(_cols?: string) {
    return this;
  }
  eq(col: string, v: unknown) {
    this.filters.push((r) => {
      const x = get(r, col);
      return x !== null && x !== undefined && String(x) === String(v);
    });
    return this;
  }
  in(col: string, vs: unknown[]) {
    const set = new Set(vs.map(String));
    this.filters.push((r) => set.has(String(get(r, col))));
    return this;
  }
  is(col: string, v: unknown) {
    this.filters.push((r) => (get(r, col) ?? null) === v);
    return this;
  }
  not(col: string, op: string, v: unknown) {
    if (op !== "is") throw new Error(`FakeDb: not(${op}) unsupported`);
    this.filters.push((r) => (get(r, col) ?? null) !== v);
    return this;
  }
  gt(col: string, v: unknown) {
    this.filters.push((r) => String(get(r, col)) > String(v));
    return this;
  }
  gte(col: string, v: unknown) {
    this.filters.push((r) => String(get(r, col)) >= String(v));
    return this;
  }
  order(col: string, o?: { ascending?: boolean }) {
    this.orderBy = { col, asc: o?.ascending !== false };
    return this;
  }
  limit(n: number) {
    this.lim = n;
    return this;
  }
  update(patch: Row) {
    this.op = "update";
    this.patch = patch;
    return this;
  }
  insert(row: Row | Row[]) {
    const db = this.db;
    const table = this.table;
    if (db.failOn.has(table)) return Promise.resolve({ data: null, error: { message: `${table} insert failed`, code: "XX000" } });
    const list = Array.isArray(row) ? row : [row];
    const uk = db.unique[table];
    for (const r of list) {
      if (uk && db.rows(table).some((x) => x[uk] === r[uk])) {
        return Promise.resolve({ data: null, error: { message: "duplicate key", code: "23505" } });
      }
    }
    for (const r of list) {
      const full = { id: r.id ?? db.nextId(), created_at: r.created_at ?? new Date().toISOString(), ...r };
      db.rows(table).push(full);
      db.writes.push([table, "insert", full]);
    }
    return Promise.resolve({ data: null, error: null });
  }
  maybeSingle() {
    return this.run().then(({ data, error }) => ({ data: error ? null : (data?.[0] ?? null), error }));
  }
  // deno-lint-ignore no-explicit-any
  then(res: (v: any) => unknown, rej?: (e: unknown) => unknown) {
    return this.run().then(res, rej);
  }

  private run(): Promise<{ data: Row[] | null; error: { message: string; code?: string } | null }> {
    const db = this.db;
    if (db.failOn.has(this.table)) return Promise.resolve({ data: null, error: { message: `${this.table} failed`, code: "XX000" } });
    let hits = db.rows(this.table).filter((r) => this.filters.every((f) => f(r)));
    if (this.op === "update") {
      for (const r of hits) Object.assign(r, structuredClone(this.patch));
      db.writes.push([this.table, "update", { ...this.patch, _rows: hits.length }]);
      return Promise.resolve({ data: hits.map((r) => ({ ...r })), error: null });
    }
    if (this.orderBy) {
      const { col, asc } = this.orderBy;
      hits = [...hits].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : String(a[col]) > String(b[col]) ? 1 : 0) * (asc ? 1 : -1));
    }
    if (this.lim !== null) hits = hits.slice(0, this.lim);
    return Promise.resolve({ data: hits.map((r) => structuredClone(r)), error: null });
  }
}

/** A recording Telegram call. `answer(method, payload)` decides each outcome (default: accepted). */
export function fakeTelegram(answer?: (method: string, payload: Row) => { ok: boolean; status?: number; error?: string | null }) {
  const calls: { method: string; payload: Row }[] = [];
  const call = (method: string, payload: Record<string, unknown>) => {
    calls.push({ method, payload: structuredClone(payload) as Row });
    const a = answer?.(method, payload as Row) ?? { ok: true };
    const error = a.ok ? null : (a.error ?? `http_${a.status ?? 400}`);
    const e = (error ?? "").toLowerCase();
    const recipient = /bot was blocked|chat not found|user is deactivated|forbidden/.test(e);
    return Promise.resolve({
      ok: a.ok,
      status: a.ok ? 200 : (a.status ?? 400),
      error,
      terminal: recipient,
      recipient,
      content: false,
    });
  };
  return { calls, call };
}
