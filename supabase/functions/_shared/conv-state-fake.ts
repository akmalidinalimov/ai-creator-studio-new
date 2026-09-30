// TEST SUPPORT ONLY (imported by voice-requests.test.ts and telegram-bot-webhook/voice-bridge.test.ts; no
// function imports it). An in-memory stand-in for the two tables the voice bridge touches — bot_conversation_state
// (PK telegram_id) and admin_actions — implementing exactly the supabase-js calls voice-requests.ts makes:
//   select(...).eq(...).maybeSingle() · insert(row) (23505 on a duplicate key) ·
//   update(obj).eq(...)….select(...) · delete().eq(...)….select(...)
// with eq() on plain columns and on `context->>key`. `raceOnce` runs a callback right before the next
// bot_conversation_state WRITE executes, to play a concurrent writer between a read and its compare-and-swap.

export type FakeRow = { telegram_id: number; state: string; context: Record<string, unknown>; updated_at: string; expires_at: string };

export class FakeConvDb {
  rows = new Map<number, FakeRow>();
  actions: Record<string, unknown>[] = [];
  writes = 0;
  private race: (() => void) | null = null;

  raceOnce(fn: () => void) {
    this.race = fn;
  }

  /** Put a row as-is (a state some other flow wrote). */
  seed(row: FakeRow) {
    this.rows.set(row.telegram_id, structuredClone(row));
  }

  row(tg: number): FakeRow | null {
    const r = this.rows.get(tg);
    return r ? structuredClone(r) : null;
  }

  actionNames(): string[] {
    return this.actions.map((a) => String(a.action));
  }

  from(table: string) {
    return new FakeQuery(this, table);
  }

  /** @internal */ fireRace() {
    const f = this.race;
    this.race = null;
    if (f) f();
  }
}

type Op = "select" | "insert" | "update" | "delete";

class FakeQuery implements PromiseLike<{ data: unknown; error: unknown }> {
  private op: Op = "select";
  private filters: [string, unknown][] = [];
  private payload: Record<string, unknown> | null = null;
  private returning = false;

  constructor(private db: FakeConvDb, private table: string) {}

  select(_cols?: string) {
    if (this.op !== "select") this.returning = true;
    return this;
  }
  insert(row: Record<string, unknown>) {
    this.op = "insert";
    this.payload = row;
    return this;
  }
  update(obj: Record<string, unknown>) {
    this.op = "update";
    this.payload = obj;
    return this;
  }
  delete() {
    this.op = "delete";
    return this;
  }
  eq(col: string, v: unknown) {
    this.filters.push([col, v]);
    return this;
  }
  maybeSingle() {
    return Promise.resolve(this.execute()).then((r) => ({
      data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data,
      error: r.error,
    }));
  }
  then<A, B>(ok?: ((v: { data: unknown; error: unknown }) => A | PromiseLike<A>) | null, bad?: ((e: unknown) => B | PromiseLike<B>) | null) {
    return Promise.resolve(this.execute()).then(ok, bad);
  }

  private get(row: FakeRow, col: string): unknown {
    const m = /^(\w+)->>(\w+)$/.exec(col);
    if (m) {
      const v = (row as unknown as Record<string, Record<string, unknown>>)[m[1]]?.[m[2]];
      return v == null ? null : String(v);
    }
    return (row as unknown as Record<string, unknown>)[col];
  }

  private matches(row: FakeRow): boolean {
    return this.filters.every(([c, v]) => {
      const got = this.get(row, c);
      return c === "telegram_id" ? Number(got) === Number(v) : got === v;
    });
  }

  private execute(): { data: unknown; error: unknown } {
    if (this.table === "admin_actions") {
      if (this.op === "insert" && this.payload) this.db.actions.push(structuredClone(this.payload));
      return { data: null, error: null };
    }
    if (this.table !== "bot_conversation_state") return { data: null, error: { message: `unexpected table ${this.table}` } };
    if (this.op !== "select") {
      this.db.fireRace();
      this.db.writes++;
    }
    const all = [...this.db.rows.values()];
    if (this.op === "select") return { data: all.filter((r) => this.matches(r)).map((r) => structuredClone(r)), error: null };
    if (this.op === "insert") {
      const row = structuredClone(this.payload) as unknown as FakeRow;
      if (this.db.rows.has(Number(row.telegram_id))) {
        return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
      }
      this.db.rows.set(Number(row.telegram_id), row);
      return { data: null, error: null };
    }
    const hit = all.filter((r) => this.matches(r));
    for (const r of hit) {
      if (this.op === "delete") this.db.rows.delete(r.telegram_id);
      else this.db.rows.set(r.telegram_id, { ...r, ...(structuredClone(this.payload) as Partial<FakeRow>) });
    }
    return { data: this.returning ? hit.map((r) => ({ telegram_id: r.telegram_id })) : null, error: null };
  }
}
