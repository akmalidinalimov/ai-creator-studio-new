// Rotation-safe internal-secret verifier, shared by internal (cron/trigger-invoked) edge functions.
//
// Root cause it fixes: internal functions cached internal_fn_secret() once per isolate and never
// re-fetched. After a Vault rotation, a warm isolate kept serving the OLD value and 403'd every
// internal call until it recycled — the intermittent, "unattributed" {"error":"forbidden"} faults
// the ops_http_failure_watchdog alerts on. PR #57 fixed this for the two per-minute drainers by
// re-fetching once on mismatch; this is that same fix, extracted into one shared engine so every
// internal receiver heals identically instead of each carrying its own (un-healed) copy.
//
// Semantics:
//  - Fail-closed: no header, or any RPC error with no known-good value, -> false (reject).
//  - Heal-on-mismatch: if the provided header doesn't match the cached secret, re-fetch ONCE
//    (debounced to <=1 RPC / DEBOUNCE_MS) and re-compare, so a rotation self-corrects. Note a
//    just-rotated-OUT value still matches a warm isolate's cache until the first NEW-secret call
//    forces a refresh — inherent to any cache+heal design, and strictly tighter than the old
//    fetch-once-forever cache it replaces (which accepted the old value for the isolate's whole life).
//  - The debounce bounds RPC load if a burst of genuinely-wrong callers arrives (DoS amplification
//    guard) — at most one re-fetch per window regardless of how many bad calls land.
// State is module-level, i.e. PER edge-function isolate (each function bundles its own copy) — never
// shared across functions.

// A service-role Supabase client. Typed `any` to accept the real createClient() return (whose
// .rpc() is a Postgrest builder, not a bare Promise) — matches how the rest of the codebase types it.
// deno-lint-ignore no-explicit-any
type RpcClient = any;

let _sec: string | null = null;
let _lastFetch = 0;
let _debounceMs = 15_000;

async function fetchSecret(admin: RpcClient, force: boolean): Promise<string | null> {
  const now = Date.now();
  // Serve cache unless we're forcing a refresh AND the debounce window has elapsed.
  if (_sec && (!force || now - _lastFetch < _debounceMs)) return _sec;
  _lastFetch = now;
  const { data, error } = await admin.rpc("internal_fn_secret");
  if (error) return _sec; // transient RPC error: keep last-known (still fail-closed vs a wrong header)
  _sec = (data as string) ?? _sec;
  return _sec;
}

/**
 * Verify the caller's x-internal-secret header against internal_fn_secret(), healing a stale cache
 * on mismatch. Returns true only on an exact match. `admin` must be a service-role client.
 */
export async function verifyInternalSecret(req: Request, admin: RpcClient): Promise<boolean> {
  const provided = req.headers.get("x-internal-secret");
  if (!provided) return false;
  let sec = await fetchSecret(admin, false);
  if (!sec || provided !== sec) sec = await fetchSecret(admin, true); // rotation heal: re-fetch once
  return !!sec && provided === sec;
}

// --- test-only hooks (no effect in production; never called there) ---
export function _resetInternalSecretCacheForTest(): void {
  _sec = null;
  _lastFetch = 0;
  _debounceMs = 15_000;
}
export function _setInternalSecretDebounceForTest(ms: number): void {
  _debounceMs = ms;
}
