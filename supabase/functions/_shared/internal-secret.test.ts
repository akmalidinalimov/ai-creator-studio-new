// Tests for the shared rotation-safe internal-secret verifier.
// Run: deno test supabase/functions/_shared/internal-secret.test.ts
import {
  verifyInternalSecret,
  _resetInternalSecretCacheForTest,
  _setInternalSecretDebounceForTest,
} from "./internal-secret.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error("assertion failed: " + msg);
}
const reqWith = (secret?: string) =>
  new Request("http://fn", { headers: secret != null ? { "x-internal-secret": secret } : {} });
// deno-lint-ignore no-explicit-any
const mockAdmin = (getSecret: () => string | null, opts?: { error?: boolean }): any => ({
  calls: 0,
  rpc(_fn: string) {
    this.calls++;
    return Promise.resolve(opts?.error ? { data: null, error: new Error("rpc down") } : { data: getSecret(), error: null });
  },
});

Deno.test("missing header -> false (no RPC)", async () => {
  _resetInternalSecretCacheForTest();
  const admin = mockAdmin(() => "SECRET");
  assert((await verifyInternalSecret(reqWith(undefined), admin)) === false, "no header must reject");
  assert(admin.calls === 0, "must not call the RPC when the header is absent");
});

Deno.test("correct secret -> true", async () => {
  _resetInternalSecretCacheForTest();
  const admin = mockAdmin(() => "SECRET");
  assert((await verifyInternalSecret(reqWith("SECRET"), admin)) === true, "matching secret must pass");
});

Deno.test("wrong secret -> false", async () => {
  _resetInternalSecretCacheForTest();
  _setInternalSecretDebounceForTest(0);
  const admin = mockAdmin(() => "SECRET");
  assert((await verifyInternalSecret(reqWith("WRONG"), admin)) === false, "wrong secret must reject");
});

Deno.test("rotation heal: cache OLD, vault rotated to NEW, header NEW -> true after re-fetch", async () => {
  _resetInternalSecretCacheForTest();
  _setInternalSecretDebounceForTest(0);
  let current = "OLD";
  const admin = mockAdmin(() => current);
  assert((await verifyInternalSecret(reqWith("OLD"), admin)) === true, "OLD matches while cache=OLD");
  current = "NEW"; // Vault rotated under a warm isolate
  assert((await verifyInternalSecret(reqWith("NEW"), admin)) === true, "must heal to NEW via mismatch re-fetch");
});

Deno.test("debounce: forced re-fetch suppressed within the window (no heal this call)", async () => {
  _resetInternalSecretCacheForTest();
  _setInternalSecretDebounceForTest(60_000);
  let current = "OLD";
  const admin = mockAdmin(() => current);
  assert((await verifyInternalSecret(reqWith("OLD"), admin)) === true, "prime cache = OLD");
  current = "NEW";
  assert((await verifyInternalSecret(reqWith("NEW"), admin)) === false, "debounced: cache stays OLD, NEW rejected this call");
});

Deno.test("transient RPC error with no cached value -> fail closed", async () => {
  _resetInternalSecretCacheForTest();
  const admin = mockAdmin(() => null, { error: true });
  assert((await verifyInternalSecret(reqWith("SECRET"), admin)) === false, "RPC error + empty cache must reject");
});
