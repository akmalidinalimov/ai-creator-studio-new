// ai-label — ask a model for a strict-schema LABEL (text + base64 images), Anthropic first, OpenAI fallback.
//
// Adapted from challenge-qa-judge/judge.ts (which is NOT modified: it keeps its own copy), generalised so any checker
// can send its own prompt, schema and images. The contract every caller inherits:
//   * THE MODEL NEVER DECIDES. It returns labels; the caller validates them (`validate`) and SQL decides.
//   * Images go to the provider as BASE64 bytes only — never a URL (a Telegram file URL carries the bot token).
//   * Every provider call becomes a CallRecord (provider, model, tokens, USD cost, latency, error kind), so the
//     caller can put the whole cost ledger in the database — including the calls that failed.
//   * A per-run CIRCUIT BREAKER: an auth failure disables that provider for the run; 3 consecutive transient
//     failures (timeout / 5xx / 429 / network / other-4xx) skip it for the rest of the run, so an outage costs a
//     handful of doomed calls per run, not one per row.
//   * The outcome says whether a failure was SYSTEMIC (every attempt failed for a provider-side reason, or no
//     provider could be tried) or caused by THIS input (a refusal, a truncated or schema-breaking answer). A caller
//     retries the first without charging the row an attempt, and charges the second.
//
// Pure except for the injected I/O (the Anthropic client, fetch, the clock), so it is unit-tested with fakes and
// type-checked by CI's `deno check supabase/functions/_shared/*.ts` without downloading any SDK.

import { redactSecrets } from "./redact.ts";

export type Provider = "anthropic" | "openai";
export const PROVIDERS: readonly Provider[] = ["anthropic", "openai"];

export type ErrorKind =
  | "timeout" | "http_429" | "http_5xx" | "auth" | "refusal" | "max_tokens" | "parse" | "schema" | "network" | "other";

/** Failures that say nothing about the input: the same row may well succeed on the next run. */
export const SYSTEMIC_KINDS: readonly ErrorKind[] = ["timeout", "http_5xx", "http_429", "network", "auth"];
/** Failures that open the per-run breaker after 3 in a row ('other' = a non-auth 4xx: it repeats on every row). */
export const BREAKER_KINDS: readonly ErrorKind[] = ["timeout", "http_5xx", "http_429", "network", "other"];
export const BREAKER_THRESHOLD = 3;

export type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";
export const IMAGE_MEDIA_TYPES: readonly ImageMediaType[] = ["image/jpeg", "image/png", "image/gif", "image/webp"];

export type LabelPart =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: ImageMediaType; base64: string; detail?: "low" | "high" | "auto" };

export interface LabelRequest<T> {
  system: string;
  parts: LabelPart[];
  /** A strict JSON schema: every object additionalProperties:false, every key required. */
  schema: Record<string, unknown>;
  /** OpenAI's json_schema.name ([A-Za-z0-9_-]{1,64}). */
  schemaName: string;
  /** Exact-shape validation of the parsed output; null = the model broke the contract. */
  validate: (x: unknown) => T | null;
  anthropicMaxTokens?: number;
  openaiMaxTokens?: number;
}

export interface AiConfig {
  providers: Provider[];
  models: Record<Provider, string>;
  /** USD per million tokens, [input, output]. */
  prices: Record<Provider, [number, number]>;
}

export const DEFAULT_AI_CONFIG: AiConfig = {
  providers: ["anthropic", "openai"],
  models: { anthropic: "claude-haiku-4-5", openai: "gpt-5-mini" },
  prices: { anthropic: [1, 5], openai: [0.25, 2] },
};

const MODEL_RE = /^[A-Za-z0-9._:-]{1,80}$/;

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === "object" && !Array.isArray(x);
}

/**
 * platform_settings passes ai_provider_order / ai_models / ai_prices through without validating them, so they are
 * validated HERE, key by key: an unknown provider is dropped, a malformed model or price falls back to its default.
 * `available` = the providers that have a key in this runtime (the order is the config's).
 */
export function sanitizeAiConfig(cfg: unknown, available: readonly Provider[]): AiConfig {
  const c = isPlainObject(cfg) ? cfg : {};
  const order: Provider[] = [];
  const rawOrder = Array.isArray(c.ai_provider_order) ? c.ai_provider_order : DEFAULT_AI_CONFIG.providers;
  for (const p of rawOrder) {
    if ((p === "anthropic" || p === "openai") && !order.includes(p)) order.push(p);
  }
  if (order.length === 0) order.push(...DEFAULT_AI_CONFIG.providers);
  const models = { ...DEFAULT_AI_CONFIG.models };
  const prices: Record<Provider, [number, number]> = {
    anthropic: [...DEFAULT_AI_CONFIG.prices.anthropic],
    openai: [...DEFAULT_AI_CONFIG.prices.openai],
  };
  const m = isPlainObject(c.ai_models) ? c.ai_models : {};
  const pr = isPlainObject(c.ai_prices) ? c.ai_prices : {};
  for (const p of PROVIDERS) {
    const mv = m[p];
    if (typeof mv === "string" && MODEL_RE.test(mv)) models[p] = mv;
    const pv = pr[p];
    if (Array.isArray(pv) && pv.length === 2) {
      const [a, b] = pv.map(Number);
      if (Number.isFinite(a) && Number.isFinite(b) && a >= 0 && b >= 0) prices[p] = [a, b];
    }
  }
  return { providers: order.filter((p) => available.includes(p)), models, prices };
}

/** USD for one call; price = [input, output] per million tokens. Rounded to 1e-6. */
export function costUsd(tokensIn: number | null, tokensOut: number | null, price: readonly number[] | undefined): number {
  if (!price || price.length !== 2) return 0;
  const [pin, pout] = price;
  if (!Number.isFinite(pin) || !Number.isFinite(pout)) return 0;
  const usd = ((tokensIn ?? 0) * pin + (tokensOut ?? 0) * pout) / 1e6;
  return Math.round(usd * 1e6) / 1e6;
}

/** Cut a string by code point (never splitting a surrogate pair: Postgres jsonb rejects a lone surrogate). */
export function clip(s: string, max: number): string {
  const cps = Array.from(s);
  return cps.length <= max ? s : cps.slice(0, max).join("");
}

// ─────────────────────────── errors ───────────────────────────

export class ProviderError extends Error {
  kind: ErrorKind;
  status: number | null;
  model: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  effortRejected: boolean;
  constructor(kind: ErrorKind, message: string, meta: Partial<{
    status: number | null; model: string | null; tokensIn: number | null; tokensOut: number | null; effortRejected: boolean;
  }> = {}) {
    super(message);
    this.kind = kind;
    this.status = meta.status ?? null;
    this.model = meta.model ?? null;
    this.tokensIn = meta.tokensIn ?? null;
    this.tokensOut = meta.tokensOut ?? null;
    this.effortRejected = meta.effortRejected ?? false;
  }
}

function intOrNull(x: unknown): number | null {
  return typeof x === "number" && Number.isFinite(x) && x >= 0 ? Math.round(x) : null;
}

// deno-lint-ignore no-explicit-any
type Ctor = abstract new (...args: any[]) => unknown;

/** The Anthropic SDK's typed error classes (index.ts passes the real ones; tests pass fakes). */
export interface AnthropicErrorClasses {
  APIError: Ctor;
  AuthenticationError: Ctor;
  PermissionDeniedError: Ctor;
  RateLimitError: Ctor;
  APIConnectionError: Ctor;
  APIConnectionTimeoutError: Ctor;
  APIUserAbortError?: Ctor;
}

/** The slice of the Anthropic client this module uses. */
export interface AnthropicLike {
  messages: {
    // deno-lint-ignore no-explicit-any
    create(params: any, options?: { signal?: AbortSignal; timeout?: number }): Promise<any>;
  };
}

/** Most specific first: the SDK's APIConnectionError is a subclass of APIError. */
export function mapAnthropicError(e: unknown, A: AnthropicErrorClasses, aborted: boolean): { kind: ErrorKind; status: number | null } {
  if (aborted) return { kind: "timeout", status: null };
  if (e instanceof A.APIConnectionTimeoutError) return { kind: "timeout", status: null };
  if (A.APIUserAbortError && e instanceof A.APIUserAbortError) return { kind: "timeout", status: null };
  if (e instanceof A.APIConnectionError) return { kind: "network", status: null };
  const status = intOrNull((e as { status?: unknown })?.status);
  if (e instanceof A.AuthenticationError || e instanceof A.PermissionDeniedError) return { kind: "auth", status };
  if (e instanceof A.RateLimitError) return { kind: "http_429", status: status ?? 429 };
  if (e instanceof A.APIError) {
    if (status === 401 || status === 403) return { kind: "auth", status };
    if (status === 429) return { kind: "http_429", status };
    if (status !== null && status >= 500) return { kind: "http_5xx", status };
    return { kind: "other", status };
  }
  return { kind: "other", status: null };
}

function parseLabel<T>(text: string, validate: (x: unknown) => T | null, meta: {
  model: string; tokensIn: number | null; tokensOut: number | null;
}): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ProviderError("parse", "model output is not JSON", meta);
  }
  const v = validate(parsed);
  if (v === null) throw new ProviderError("schema", "model output does not match the schema", meta);
  return v;
}

interface ProviderSuccess<T> {
  value: T;
  model: string;
  tokensIn: number | null;
  tokensOut: number | null;
}

/** Anthropic content blocks: images as base64 sources, in the caller's order. */
export function anthropicContent(parts: LabelPart[]): Record<string, unknown>[] {
  return parts.map((p) =>
    p.type === "text"
      ? { type: "text", text: p.text }
      : { type: "image", source: { type: "base64", media_type: p.mediaType, data: p.base64 } }
  );
}

/** OpenAI chat content parts: images as data: URLs (base64 bytes, never a remote URL). */
export function openaiContent(parts: LabelPart[]): Record<string, unknown>[] {
  return parts.map((p) =>
    p.type === "text"
      ? { type: "text", text: p.text }
      : { type: "image_url", image_url: { url: `data:${p.mediaType};base64,${p.base64}`, detail: p.detail ?? "auto" } }
  );
}

export async function callAnthropic<T>(
  client: AnthropicLike, errors: AnthropicErrorClasses, model: string, req: LabelRequest<T>, timeoutMs: number,
): Promise<ProviderSuccess<T>> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    // deno-lint-ignore no-explicit-any
    let res: any;
    try {
      res = await client.messages.create({
        model,
        max_tokens: req.anthropicMaxTokens ?? 600,
        temperature: 0,
        system: req.system,
        messages: [{ role: "user", content: anthropicContent(req.parts) }],
        output_config: { format: { type: "json_schema", schema: req.schema } },
      }, { signal: ctl.signal, timeout: timeoutMs });
    } catch (e) {
      const m = mapAnthropicError(e, errors, ctl.signal.aborted);
      throw new ProviderError(m.kind, redactSecrets(e), { status: m.status, model });
    }
    const meta = {
      model: typeof res?.model === "string" ? res.model : model,
      tokensIn: intOrNull(res?.usage?.input_tokens),
      tokensOut: intOrNull(res?.usage?.output_tokens),
    };
    // stop_reason BEFORE content: a refusal or a truncated answer may not match the schema.
    if (res?.stop_reason === "refusal") throw new ProviderError("refusal", "model refused", meta);
    if (res?.stop_reason === "max_tokens") throw new ProviderError("max_tokens", "output hit max_tokens", meta);
    const text = Array.isArray(res?.content)
      ? res.content.filter((b: { type?: string }) => b?.type === "text").map((b: { text?: string }) => b.text ?? "").join("")
      : "";
    return { value: parseLabel(text, req.validate, meta), ...meta };
  } finally {
    clearTimeout(timer);
  }
}

export const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
export type OpenAIEffort = "minimal" | "low";

export async function callOpenAI<T>(
  fetchFn: typeof fetch, apiKey: string, model: string, req: LabelRequest<T>, timeoutMs: number, effort: OpenAIEffort,
): Promise<ProviderSuccess<T>> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    let r: Response;
    let raw = "";
    try {
      r = await fetchFn(OPENAI_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: req.system },
            { role: "user", content: openaiContent(req.parts) },
          ],
          response_format: { type: "json_schema", json_schema: { name: req.schemaName, strict: true, schema: req.schema } },
          // The gpt-5 family rejects `temperature`; reasoning is kept minimal (a label, not an essay).
          reasoning_effort: effort,
          max_completion_tokens: req.openaiMaxTokens ?? 1200,
        }),
        signal: ctl.signal,
      });
      raw = await r.text();
    } catch (e) {
      throw new ProviderError(ctl.signal.aborted ? "timeout" : "network", redactSecrets(e), { model });
    }
    // deno-lint-ignore no-explicit-any
    let data: any = null;
    try {
      data = JSON.parse(raw);
    } catch { /* handled below */ }
    const status = r.status;
    if (!r.ok) {
      const kind: ErrorKind = status === 401 || status === 403 ? "auth"
        : status === 429 ? "http_429"
        : status >= 500 ? "http_5xx"
        : "other";
      const msg = typeof data?.error?.message === "string" ? data.error.message : raw.slice(0, 200);
      throw new ProviderError(kind, `HTTP ${status}: ${redactSecrets(msg)}`, {
        status, model, effortRejected: status === 400 && /reasoning_effort/i.test(raw),
      });
    }
    const meta = {
      model: typeof data?.model === "string" ? data.model : model,
      tokensIn: intOrNull(data?.usage?.prompt_tokens),
      tokensOut: intOrNull(data?.usage?.completion_tokens),
    };
    const choice = data?.choices?.[0];
    if (!choice) throw new ProviderError("parse", "no choices in the response", { ...meta, status });
    if (choice?.message?.refusal) throw new ProviderError("refusal", "model refused", { ...meta, status });
    if (choice?.finish_reason === "length") throw new ProviderError("max_tokens", "output hit the token limit", { ...meta, status });
    const content = typeof choice?.message?.content === "string" ? choice.message.content : "";
    return { value: parseLabel(content, req.validate, meta), ...meta };
  } finally {
    clearTimeout(timer);
  }
}

// ─────────────────────────── one label, with fallback ───────────────────────────

export interface CallRecord {
  provider: Provider;
  model: string | null;
  ok: boolean;
  error_kind: ErrorKind | null;
  http_status: number | null;
  latency_ms: number;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: number;
  error: string | null;
}

export interface LabelDeps {
  anthropic?: AnthropicLike;
  anthropicErrors?: AnthropicErrorClasses;
  openaiKey?: string;
  fetchFn: typeof fetch;
  now: () => number;
}

/** Per-run provider health: shared by every row of one run, never persisted. */
export interface Breaker {
  state: Record<Provider, { disabled: boolean; transient: number }>;
  openaiEffort: OpenAIEffort;
  authFailed: Set<Provider>;
}

export function newBreaker(): Breaker {
  return {
    state: { anthropic: { disabled: false, transient: 0 }, openai: { disabled: false, transient: 0 } },
    openaiEffort: "minimal",
    authFailed: new Set(),
  };
}

export function providerOpen(b: Breaker, p: Provider): boolean {
  const s = b.state[p];
  return !!s && !s.disabled && s.transient < BREAKER_THRESHOLD;
}

export type LabelOutcome<T> =
  | { ok: true; value: T; provider: Provider; model: string; calls: CallRecord[]; fellBack: boolean }
  | { ok: false; systemic: boolean; error: string; calls: CallRecord[] };

export const CALL_TIMEOUT_MS = 25_000; // per provider call (the SDK's own retry included)
export const MIN_CALL_MS = 4_000;      // a call with less time than this left is not started

/**
 * Try the providers in order until one returns a valid label. The model output is only ever data.
 * Not attempted at all (every provider unavailable / breaker open / out of time) = systemic.
 */
export async function labelWithFallback<T>(
  req: LabelRequest<T>, cfg: AiConfig, deps: LabelDeps, breaker: Breaker, deadlineMs: number,
): Promise<LabelOutcome<T>> {
  const calls: CallRecord[] = [];
  const kinds: ErrorKind[] = [];
  let last: ProviderError | null = null;
  let outOfTime = false;

  const attempt = async (p: Provider): Promise<ProviderSuccess<T> | null> => {
    const remaining = deadlineMs - deps.now();
    if (remaining < MIN_CALL_MS) return null;
    const timeout = Math.min(CALL_TIMEOUT_MS, remaining);
    const model = cfg.models[p];
    const t0 = deps.now();
    try {
      const s = p === "anthropic"
        ? await callAnthropic(deps.anthropic!, deps.anthropicErrors!, model, req, timeout)
        : await callOpenAI(deps.fetchFn, deps.openaiKey ?? "", model, req, timeout, breaker.openaiEffort);
      calls.push({
        provider: p, model: s.model, ok: true, error_kind: null, http_status: 200, latency_ms: deps.now() - t0,
        tokens_in: s.tokensIn, tokens_out: s.tokensOut, cost_usd: costUsd(s.tokensIn, s.tokensOut, cfg.prices[p]), error: null,
      });
      return s;
    } catch (e) {
      const pe = e instanceof ProviderError ? e : new ProviderError("other", redactSecrets(e));
      calls.push({
        provider: p, model: pe.model ?? model ?? null, ok: false, error_kind: pe.kind, http_status: pe.status,
        latency_ms: deps.now() - t0, tokens_in: pe.tokensIn, tokens_out: pe.tokensOut,
        cost_usd: costUsd(pe.tokensIn, pe.tokensOut, cfg.prices[p]), error: clip(redactSecrets(pe.message), 300),
      });
      throw pe;
    }
  };

  for (const p of cfg.providers) {
    if (!providerOpen(breaker, p)) continue;
    if (p === "anthropic" && (!deps.anthropic || !deps.anthropicErrors)) continue;
    if (p === "openai" && !deps.openaiKey) continue;
    const st = breaker.state[p];
    try {
      let s: ProviderSuccess<T> | null;
      try {
        s = await attempt(p);
      } catch (e) {
        const pe = e as ProviderError;
        // If the API ever rejects 'minimal' effort, retry once at 'low' and keep 'low' for the rest of the run.
        if (p === "openai" && pe.effortRejected && breaker.openaiEffort === "minimal") {
          breaker.openaiEffort = "low";
          s = await attempt(p);
        } else {
          throw pe;
        }
      }
      if (s === null) {
        outOfTime = true;
        break;
      }
      st.transient = 0;
      return { ok: true, value: s.value, provider: p, model: s.model, calls, fellBack: calls.length > 1 };
    } catch (e) {
      const pe = e as ProviderError;
      last = pe;
      kinds.push(pe.kind);
      if (pe.kind === "auth") {
        st.disabled = true;
        breaker.authFailed.add(p);
      } else if (BREAKER_KINDS.includes(pe.kind)) {
        st.transient++;
      }
    }
  }
  if (kinds.length === 0) {
    return { ok: false, systemic: true, error: outOfTime ? "out_of_time" : "no_provider", calls };
  }
  // Charged to the row only when some attempt failed because of THIS input (refusal / truncation / bad output /
  // an input-specific 4xx); a mix of outages and "out of time" is retried free.
  const systemic = kinds.every((k) => SYSTEMIC_KINDS.includes(k));
  const err = last ? `${last.kind}: ${last.message}` : "no provider answered";
  return { ok: false, systemic, error: clip(redactSecrets(err), 300), calls };
}
