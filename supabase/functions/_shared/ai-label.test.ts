// Tests for _shared/ai-label.ts. Run: deno test supabase/functions/_shared/ai-label.test.ts
// No network: the Anthropic client, fetch and the clock are fakes.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  anthropicContent, type AnthropicErrorClasses, type AnthropicLike, BREAKER_THRESHOLD, clip, costUsd, DEFAULT_AI_CONFIG,
  type LabelDeps, type LabelRequest, labelWithFallback, mapAnthropicError, newBreaker, OPENAI_URL, openaiContent,
  sanitizeAiConfig,
} from "./ai-label.ts";

class APIError extends Error {
  status: number | undefined;
  constructor(status?: number, msg = "api error") {
    super(msg);
    this.status = status;
  }
}
class AuthenticationError extends APIError { constructor() { super(401, "invalid x-api-key"); } }
class PermissionDeniedError extends APIError { constructor() { super(403); } }
class RateLimitError extends APIError { constructor() { super(429); } }
class APIConnectionError extends APIError { constructor(msg = "connection error") { super(undefined, msg); } }
class APIConnectionTimeoutError extends APIConnectionError { constructor() { super("timed out"); } }
const ERRS: AnthropicErrorClasses = {
  APIError, AuthenticationError, PermissionDeniedError, RateLimitError, APIConnectionError, APIConnectionTimeoutError,
};

type Label = { reason: string; ok: boolean };
const validate = (x: unknown): Label | null => {
  const o = x as Record<string, unknown>;
  return o && typeof o === "object" && typeof o.reason === "string" && typeof o.ok === "boolean" && Object.keys(o).length === 2
    ? { reason: o.reason, ok: o.ok }
    : null;
};
const REQ: LabelRequest<Label> = {
  system: "label it",
  parts: [{ type: "text", text: "<task>{}</task>" }, { type: "image", mediaType: "image/jpeg", base64: "QUJD" }],
  schema: { type: "object", additionalProperties: false, required: ["reason", "ok"], properties: {} },
  schemaName: "test_label",
  validate,
};

type Step = { throw: Error } | { res: Record<string, unknown> };
function fakeAnthropic(steps: Step[]) {
  const calls: Record<string, unknown>[] = [];
  const client: AnthropicLike = {
    messages: {
      create(params: Record<string, unknown>) {
        calls.push(params);
        const s = steps.length > 1 ? steps.shift()! : steps[0];
        return "throw" in s ? Promise.reject(s.throw) : Promise.resolve(s.res);
      },
    },
  };
  return { client, calls };
}
const aOk = (v: unknown = { reason: "fine", ok: true }) => ({
  res: { model: "claude-haiku-4-5-20251001", stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(v) }],
    usage: { input_tokens: 1000, output_tokens: 100 } },
});

type FStep = { status: number; body: unknown } | { throw: Error };
function fakeFetch(steps: FStep[]) {
  const bodies: Record<string, unknown>[] = [];
  const fn = ((url: string, init: RequestInit) => {
    assertEquals(url, OPENAI_URL);
    bodies.push(JSON.parse(String(init.body)));
    const s = steps.length > 1 ? steps.shift()! : steps[0];
    if ("throw" in s) return Promise.reject(s.throw);
    return Promise.resolve(new Response(JSON.stringify(s.body), { status: s.status }));
  }) as unknown as typeof fetch;
  return { fn, bodies };
}
const oOk = (v: unknown = { reason: "fine", ok: true }) => ({
  status: 200,
  body: { model: "gpt-5-mini-2025-08-07", choices: [{ finish_reason: "stop", message: { content: JSON.stringify(v) } }],
    usage: { prompt_tokens: 2000, completion_tokens: 300 } },
});

function deps(a?: AnthropicLike, f?: typeof fetch, openaiKey = "sk-test"): LabelDeps {
  return { anthropic: a, anthropicErrors: ERRS, openaiKey, fetchFn: f ?? fakeFetch([oOk()]).fn, now: () => 0 };
}
const CFG = sanitizeAiConfig({}, ["anthropic", "openai"]);

Deno.test("sanitizeAiConfig: order from config, unknown providers dropped, bad models / prices fall back, only available keys", () => {
  const c = sanitizeAiConfig({
    ai_provider_order: ["openai", "gemini", "anthropic", "openai"],
    ai_models: { anthropic: "bad model name with spaces", openai: "gpt-5-mini" },
    ai_prices: { anthropic: [1, -5], openai: [0.5, 4] },
  }, ["anthropic", "openai"]);
  assertEquals(c.providers, ["openai", "anthropic"]);
  assertEquals(c.models.anthropic, DEFAULT_AI_CONFIG.models.anthropic);
  assertEquals(c.prices.anthropic, [1, 5]);
  assertEquals(c.prices.openai, [0.5, 4]);
  assertEquals(sanitizeAiConfig({ ai_provider_order: "nope" }, ["openai"]).providers, ["openai"]);
  assertEquals(sanitizeAiConfig(null, []).providers, []);
});

Deno.test("costUsd and clip", () => {
  assertEquals(costUsd(1_000_000, 1_000_000, [1, 5]), 6);
  assertEquals(costUsd(1200, 120, [0.25, 2]), 0.00054);
  assertEquals(costUsd(10, 10, undefined), 0);
  assertEquals(clip("a😀b", 2), "a😀");
});

Deno.test("images reach the providers as base64 only (Anthropic source / OpenAI data URL), never a remote URL", () => {
  const a = anthropicContent(REQ.parts);
  assertEquals(a[1], { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "QUJD" } });
  const o = openaiContent(REQ.parts);
  assertEquals(o[1], { type: "image_url", image_url: { url: "data:image/jpeg;base64,QUJD", detail: "auto" } });
});

Deno.test("mapAnthropicError: most specific class first", () => {
  assertEquals(mapAnthropicError(new APIConnectionTimeoutError(), ERRS, false).kind, "timeout");
  assertEquals(mapAnthropicError(new APIConnectionError(), ERRS, false).kind, "network");
  assertEquals(mapAnthropicError(new AuthenticationError(), ERRS, false).kind, "auth");
  assertEquals(mapAnthropicError(new RateLimitError(), ERRS, false).kind, "http_429");
  assertEquals(mapAnthropicError(new APIError(529), ERRS, false).kind, "http_5xx");
  assertEquals(mapAnthropicError(new APIError(400), ERRS, false).kind, "other");
  assertEquals(mapAnthropicError(new Error("x"), ERRS, true).kind, "timeout");
});

Deno.test("Anthropic answers: strict json_schema output, temperature 0, one costed call", async () => {
  const { client, calls } = fakeAnthropic([aOk()]);
  const out = await labelWithFallback(REQ, CFG, deps(client), newBreaker(), 60_000);
  assert(out.ok);
  assertEquals(out.value, { reason: "fine", ok: true });
  assertEquals(out.provider, "anthropic");
  assertEquals(out.calls.length, 1);
  assertEquals(out.calls[0].cost_usd, 0.0015);
  const p = calls[0] as Record<string, unknown>;
  assertEquals(p.output_config, { format: { type: "json_schema", schema: REQ.schema } });
  assertEquals(p.temperature, 0);
  assertEquals(p.system, "label it");
});

Deno.test("Anthropic 529 -> OpenAI fallback (strict json_schema, reasoning_effort minimal); both calls costed", async () => {
  const { client } = fakeAnthropic([{ throw: new APIError(529, "overloaded") }]);
  const f = fakeFetch([oOk()]);
  const out = await labelWithFallback(REQ, CFG, deps(client, f.fn), newBreaker(), 60_000);
  assert(out.ok);
  assertEquals(out.provider, "openai");
  assert(out.fellBack);
  assertEquals(out.calls.map((c) => [c.provider, c.ok, c.error_kind]), [["anthropic", false, "http_5xx"], ["openai", true, null]]);
  const b = f.bodies[0] as Record<string, unknown>;
  assertEquals((b.response_format as Record<string, unknown>).type, "json_schema");
  assertEquals(((b.response_format as Record<string, unknown>).json_schema as Record<string, unknown>).strict, true);
  assertEquals(b.reasoning_effort, "minimal");
  assertEquals(out.calls[1].cost_usd, 0.0011); // 2000 x $0.25 + 300 x $2 per MTok
});

Deno.test("every provider down (5xx / network / timeout): SYSTEMIC — the caller retries without charging the row", async () => {
  const { client } = fakeAnthropic([{ throw: new APIError(503) }]);
  const f = fakeFetch([{ throw: new TypeError("fetch failed") }]);
  const out = await labelWithFallback(REQ, CFG, deps(client, f.fn), newBreaker(), 60_000);
  assert(!out.ok);
  assert(out.systemic);
  assertEquals(out.calls.length, 2);
});

Deno.test("a refusal or a schema-breaking answer is caused by THIS input: not systemic (charged)", async () => {
  const { client } = fakeAnthropic([{ res: { model: "m", stop_reason: "refusal", content: [], usage: { input_tokens: 50, output_tokens: 1 } } }]);
  const f = fakeFetch([oOk({ reason: "x", ok: "yes" })]);
  const out = await labelWithFallback(REQ, CFG, deps(client, f.fn), newBreaker(), 60_000);
  assert(!out.ok);
  assertEquals(out.systemic, false);
  assertEquals(out.calls.map((c) => c.error_kind), ["refusal", "schema"]);
  assert(out.calls[0].cost_usd > 0, "a failed call that used tokens is still costed");
});

Deno.test("an auth failure disables the provider for the run and is reported; the other provider carries on", async () => {
  const { client, calls } = fakeAnthropic([{ throw: new AuthenticationError() }]);
  const b = newBreaker();
  const d = deps(client, fakeFetch([oOk()]).fn);
  const one = await labelWithFallback(REQ, CFG, d, b, 60_000);
  const two = await labelWithFallback(REQ, CFG, d, b, 60_000);
  assert(one.ok && two.ok);
  assertEquals(calls.length, 1, "anthropic is not called again after 401");
  assert(b.authFailed.has("anthropic"));
});

Deno.test("the breaker opens after 3 transient failures: later rows skip that provider", async () => {
  const { client, calls } = fakeAnthropic([{ throw: new APIError(500) }]);
  const b = newBreaker();
  const d = deps(client, fakeFetch([oOk()]).fn);
  for (let i = 0; i < BREAKER_THRESHOLD + 2; i++) assert((await labelWithFallback(REQ, CFG, d, b, 60_000)).ok);
  assertEquals(calls.length, BREAKER_THRESHOLD);
});

Deno.test("no provider available / out of time: systemic, nothing called", async () => {
  const none = await labelWithFallback(REQ, { ...CFG, providers: [] }, deps(), newBreaker(), 60_000);
  assert(!none.ok && none.systemic && none.error === "no_provider");
  const late = await labelWithFallback(REQ, CFG, { ...deps(fakeAnthropic([aOk()]).client), now: () => 59_000 }, newBreaker(), 60_000);
  assert(!late.ok && late.systemic && late.error === "out_of_time" && late.calls.length === 0);
});

Deno.test("OpenAI rejects reasoning_effort=minimal once -> retried at low and kept for the run", async () => {
  const f = fakeFetch([
    { status: 400, body: { error: { message: "Unsupported value: 'minimal' for reasoning_effort" } } },
    oOk(),
  ]);
  const b = newBreaker();
  const out = await labelWithFallback(REQ, { ...CFG, providers: ["openai"] }, deps(undefined, f.fn), b, 60_000);
  assert(out.ok);
  assertEquals(b.openaiEffort, "low");
  assertEquals((f.bodies[1] as Record<string, unknown>).reasoning_effort, "low");
});

Deno.test("an OpenAI error body never leaks a key into the call record", async () => {
  const f = fakeFetch([{ status: 401, body: { error: { message: "Incorrect API key provided: sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCDEF" } } }]);
  const out = await labelWithFallback(REQ, { ...CFG, providers: ["openai"] }, deps(undefined, f.fn), newBreaker(), 60_000);
  assert(!out.ok && out.systemic);
  assertEquals(out.calls[0].error_kind, "auth");
});
