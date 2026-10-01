import { supabase } from "@/integrations/supabase/client";

/**
 * A table query WITHOUT the generated row types, for columns newer than src/integrations/supabase/types.ts (e.g.
 * profiles.instagram_username / telegram_write_access_at): typing them in the generated select collapses the whole
 * result type. Only the builder calls these callers use are declared. Writes still go through mutate().
 */
export interface LooseQuery {
  select(columns: string): LooseQuery;
  eq(column: string, value: unknown): LooseQuery;
  update(values: Record<string, unknown>): LooseQuery;
  maybeSingle(): PromiseLike<{ data: Record<string, unknown> | null; error: { code?: string; message?: string } | null }>;
}

export function looseFrom(table: string): LooseQuery {
  return (supabase as unknown as { from: (t: string) => LooseQuery }).from(table);
}
