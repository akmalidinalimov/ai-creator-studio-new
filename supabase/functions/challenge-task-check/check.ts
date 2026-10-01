// challenge-task-check — one run: claim -> media -> fingerprint -> label -> record / release -> heartbeat.
//
// Daily Tasks PR-6 (build spec v2 §9). pg_cron's challenge_task_check_kick() (every minute) calls this function
// ONLY when challenge_tasks is active, ai = true and a 'checking' submission is due; while paused it never runs.
//
//   claim    challenge_task_check_claim(5)            PR-3: leases up to 5 submissions for 10 minutes (budget and
//                                                     per-student caps applied in SQL)
//   media    challenge_task_check_media(sub, token)   this PR: the raw Telegram messages behind the items (webhook_inbox
//                                                     or the Mini App claim), readable only by the lease holder
//   files    getFile + bytes INSIDE this function; the provider gets base64 only, never a Telegram URL
//   dHash    64-bit, instagram tasks only (C13), from a small variant; HEIC / undecodable -> the thumbnail; none ->
//            fingerprint 'unavailable'
//   label    _shared/ai-label.ts: Anthropic first, OpenAI fallback, per-run circuit breaker, every call costed
//   record   challenge_task_check_record(...)         PR-3: SQL DECIDES from the labels (I3)
//   release  challenge_task_check_release(...)        this PR: a failure gives the lease back — FREE (the attempt is
//                                                     refunded) when it was systemic (provider / Telegram down, out of
//                                                     time), CHARGED (and signalled) when this input caused it
//   heartbeat  admin_actions 'challenge_task_check_run' {counts, cost, providers, ...} every run
//
// The Instagram existence probe is OFF (spec §9.3 / G10: "verify at build time; if Instagram answers login walls
// uniformly, ship with the probe OFF and only the counter"). Verified 2026-09-30: https://www.instagram.com/p/<code>/
// answers HTTP 200 with the same ~637 KB login-wall page for a real post AND an invented shortcode, so a clean 404
// never happens and the probe cannot tell them apart. Every instagram check therefore reports link_status
// 'unverified' (health: ig_link_unverified_7d). The probe code stays, tested, behind IG_PROBE_VERIFIED.

import {
  type AiConfig, type AnthropicErrorClasses, type AnthropicLike, type Breaker, type CallRecord, clip, type LabelDeps,
  type LabelPart, labelWithFallback, newBreaker, type Provider, sanitizeAiConfig,
} from "../_shared/ai-label.ts";
import { logHealth, logHealthOnce } from "../_shared/edge.ts";
import { redactSecrets } from "../_shared/redact.ts";
import {
  type ClaimTask, PROMPT_VERSION, renderSubmission, renderTask, SCHEMAS, type SubmissionEntry, SYSTEM_PROMPTS, type TaskType,
  validateVerdict, type Verdict,
} from "./verdict.ts";
import {
  dhashFromRgba, type Download, downloadTelegramFile, extractMedia, type ImageCodec, sniffImage, toBase64, type VisualRef,
} from "./media.ts";

export const CLAIM_LIMIT = 5;
export const CONCURRENCY = 2;
export const DISPATCH_BUDGET_MS = 38_000;  // no new row starts after this
export const HARD_DEADLINE_MS = 52_000;    // no provider call runs past this: the kick's ops_net_post waits 60 s
export const MAX_AI_IMAGES = 4;
export const MAX_AI_IMAGE_BYTES = 3_500_000; // base64 stays under the 5 MB per-image provider limit
export const MAX_ROW_IMAGE_BYTES = 9_000_000;
export const MAX_HASH_BYTES = 1_500_000;
export const MAX_HASHES = 10;
export const MAX_TEXT_CHARS = 6_000;
export const DOWNLOAD_TIMEOUT_MS = 10_000;
export const IG_PROBE_TIMEOUT_MS = 5_000;
/** Flip ONLY after proving from the EDGE that instagram.com answers an invented shortcode with a clean 404. */
export const IG_PROBE_VERIFIED = false;

export interface ClaimItem {
  chat_id: number;
  message_id: number;
  kinds: string[] | null;
  file_ids: string[] | null;
  text: string | null;
  shortcode: string | null;
  has_thumb: boolean | null;
  mime: string | null;
}

export interface ClaimRow {
  submission_id: number;
  token: string;
  version: number;
  type: TaskType;
  task: ClaimTask;
  handle: string | null;
  items: ClaimItem[];
}

export interface MediaItem {
  chat_id: number;
  message_id: number;
  message: unknown;
}

export interface RunEnv {
  anthropicKey: string;
  openaiKey: string;
  botToken: string;
}

export interface RunIO {
  // deno-lint-ignore no-explicit-any
  admin: any;
  makeAnthropic?: (apiKey: string) => AnthropicLike;
  anthropicErrors?: AnthropicErrorClasses;
  fetchFn: typeof fetch;
  now: () => number;
  codec: ImageCodec;
}

export interface RunResponse {
  httpStatus: number;
  body: Record<string, unknown>;
}

/** The ledger shape challenge_task_check_record / _release insert into challenge_task_ai_calls. */
export function toSqlCalls(calls: CallRecord[]): Record<string, unknown>[] {
  return calls.map((c) => ({
    provider: c.provider, model: c.model, prompt_version: PROMPT_VERSION, status: c.ok ? "ok" : (c.error_kind ?? "other"),
    input_tokens: c.tokens_in, output_tokens: c.tokens_out, cost_usd: c.cost_usd, latency_ms: c.latency_ms, error: c.error,
  }));
}

function isObj(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === "object" && !Array.isArray(x);
}

/** Only a clean 404 means "no such post" (spec §9.3); every other answer — incl. the login wall — is 'unverified'. */
export async function probeInstagram(fetchFn: typeof fetch, shortcode: string, timeoutMs: number): Promise<"not_found" | "unverified"> {
  if (!/^[A-Za-z0-9_-]{5,40}$/.test(shortcode)) return "unverified";
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetchFn(`https://www.instagram.com/p/${shortcode}/`, { method: "GET", redirect: "manual", signal: ctl.signal });
    await r.body?.cancel();
    return r.status === 404 ? "not_found" : "unverified";
  } catch {
    return "unverified";
  } finally {
    clearTimeout(timer);
  }
}

export async function linkStatusFor(
  type: TaskType, shortcode: string | null, probeEnabled: boolean, fetchFn: typeof fetch,
): Promise<"not_found" | "unverified" | null> {
  if (type !== "instagram" || !shortcode) return null;
  if (!(probeEnabled && IG_PROBE_VERIFIED)) return "unverified";
  return await probeInstagram(fetchFn, shortcode, IG_PROBE_TIMEOUT_MS);
}

// ─────────────────────────── one submission ───────────────────────────

export interface RowStats {
  images: number;
  thumbFallbacks: number;
  hashes: number;
  hashThumbFallbacks: number;
  fingerprintUnavailable: boolean;
  downloadFailed: number;
  downloadFailedSystemic: number;
  rawMissing: number;
}

export type RowPlan =
  | { kind: "label"; parts: LabelPart[]; dhash: string[] | null; fingerprint: "ok" | "unavailable" | null; stats: RowStats }
  | { kind: "release"; systemic: boolean; reason: string; stats: RowStats };

interface Fetched {
  ok: boolean;
  systemic: boolean;
  bytes?: Uint8Array;
}

/**
 * Turn a leased submission + its raw messages into the model's input (or a reason to give the lease back).
 * Deterministic given its I/O; the only network is Telegram file retrieval through `download`.
 */
export async function planRow(
  row: ClaimRow, media: MediaItem[], submittedOn: string | null, codec: ImageCodec,
  download: (fileId: string, maxBytes: number) => Promise<Download>,
): Promise<RowPlan> {
  const stats: RowStats = {
    images: 0, thumbFallbacks: 0, hashes: 0, hashThumbFallbacks: 0, fingerprintUnavailable: false, downloadFailed: 0,
    downloadFailedSystemic: 0, rawMissing: 0,
  };
  const raw = new Map<string, unknown>();
  for (const m of media) raw.set(`${m.chat_id}:${m.message_id}`, m.message);

  // 1. the entries the model reads, in message order; the visual items are collected for step 2
  const entries: SubmissionEntry[] = [];
  const visuals: { v: VisualRef; entry: SubmissionEntry }[] = [];
  let textLeft = MAX_TEXT_CHARS;
  for (const it of row.items) {
    const msg = raw.get(`${it.chat_id}:${it.message_id}`);
    const kinds = Array.isArray(it.kinds) ? it.kinds : [];
    const hasMedia = kinds.some((k) => k !== "text" && k !== "link" && k !== "ig_link");
    if (hasMedia && !isObj(msg)) {
      stats.rawMissing++;
      entries.push({ kind: kinds.filter((k) => k !== "text" && k !== "link" && k !== "ig_link").join("+"), note: "not available" });
    } else if (isObj(msg)) {
      const mm = extractMedia(msg, MAX_AI_IMAGE_BYTES);
      for (const v of mm.visuals) {
        const entry: SubmissionEntry = { kind: v.kind === "image_doc" ? "image_file" : v.kind };
        if (v.durationSec !== null) entry.note = `${Math.round(v.durationSec)} s`;
        entries.push(entry);
        visuals.push({ v, entry });
      }
      for (const a of mm.audio) {
        entries.push({ kind: a.kind, note: `${a.durationSec !== null ? Math.round(a.durationSec) + " s, " : ""}audio is not shown to you` });
      }
    }
    const text = typeof it.text === "string" ? it.text.trim() : "";
    if (text && textLeft > 0) {
      const t = clip(text, textLeft);
      textLeft -= Array.from(t).length;
      entries.push({ kind: hasMedia ? "caption" : "text", text: t });
    }
  }

  // 2. what the model sees: up to MAX_AI_IMAGES visuals (instagram: the screenshots first)
  const order = row.type === "instagram"
    ? [...visuals.filter((x) => x.v.isImage), ...visuals.filter((x) => !x.v.isImage)]
    : visuals;
  const cache = new Map<string, Fetched>();
  const fetchOnce = async (fileId: string, maxBytes: number): Promise<Fetched> => {
    const hit = cache.get(fileId);
    if (hit) return hit;
    const d = await download(fileId, maxBytes);
    const f: Fetched = d.ok ? { ok: true, systemic: false, bytes: d.bytes } : { ok: false, systemic: d.systemic };
    if (!d.ok) {
      stats.downloadFailed++;
      if (d.systemic) stats.downloadFailedSystemic++;
    }
    cache.set(fileId, f);
    return f;
  };

  const parts: LabelPart[] = [];
  const imageParts: LabelPart[] = [];
  let bytesUsed = 0;
  let screenshotShown = false;
  let shown = 0;
  let hidden = 0;
  for (const { v, entry } of order) {
    if (shown >= MAX_AI_IMAGES) {
      hidden++;
      entry.note = [entry.note, "not shown"].filter(Boolean).join(", ");
      continue;
    }
    // the original (or the chosen photo size) when it is small enough and a type the providers take; else the thumbnail
    let got: { bytes: Uint8Array; type: ReturnType<typeof sniffImage> } | null = null;
    let viaThumb = false;
    if (v.aiFileId && (v.aiFileSize === null || v.aiFileSize <= MAX_AI_IMAGE_BYTES)) {
      const f = await fetchOnce(v.aiFileId, MAX_AI_IMAGE_BYTES);
      if (f.ok && f.bytes) {
        const t = sniffImage(f.bytes);
        if (t) got = { bytes: f.bytes, type: t };
      }
    }
    if (!got && v.thumbFileId) {
      const f = await fetchOnce(v.thumbFileId, MAX_AI_IMAGE_BYTES);
      if (f.ok && f.bytes) {
        const t = sniffImage(f.bytes);
        if (t) {
          got = { bytes: f.bytes, type: t };
          viaThumb = true;
        }
      }
    }
    if (!got || !got.type || bytesUsed + got.bytes.length > MAX_ROW_IMAGE_BYTES) {
      entry.note = [entry.note, "could not be loaded"].filter(Boolean).join(", ");
      continue;
    }
    bytesUsed += got.bytes.length;
    shown++;
    stats.images++;
    if (viaThumb) stats.thumbFallbacks++;
    if (v.isImage) screenshotShown = true;
    entry.image = shown;
    if (viaThumb || !v.isImage) entry.note = [entry.note, v.isImage ? "small preview" : "preview frame"].filter(Boolean).join(", ");
    imageParts.push({ type: "text", text: `image ${shown}:` });
    imageParts.push({ type: "image", mediaType: got.type, base64: toBase64(got.bytes), detail: row.type === "instagram" ? "high" : "auto" });
  }

  // 3. the fingerprint: instagram only (C13), every image item (not only the shown ones)
  let dhash: string[] | null = null;
  let fingerprint: "ok" | "unavailable" | null = null;
  if (row.type === "instagram") {
    const imgs = visuals.filter((x) => x.v.isImage).slice(0, MAX_HASHES);
    if (imgs.length > 0) {
      const hashes: string[] = [];
      for (const { v } of imgs) {
        let h: string | null = null;
        const first = v.hashFileId ?? v.thumbFileId ?? (v.aiFileSize !== null && v.aiFileSize <= MAX_HASH_BYTES ? v.aiFileId : null);
        if (first) {
          const f = await fetchOnce(first, MAX_HASH_BYTES);
          if (f.ok && f.bytes) {
            const img = await codec.decode(f.bytes);
            h = img ? dhashFromRgba(img) : null;
          }
        }
        if (!h && v.thumbFileId && first !== v.thumbFileId) {
          // HEIC / WebP / undecodable: Telegram's JPEG thumbnail (spec G29)
          const f = await fetchOnce(v.thumbFileId, MAX_HASH_BYTES);
          if (f.ok && f.bytes) {
            const img = await codec.decode(f.bytes);
            h = img ? dhashFromRgba(img) : null;
            if (h) stats.hashThumbFallbacks++;
          }
        }
        if (h) {
          stats.hashes++;
          if (!hashes.includes(h)) hashes.push(h);
        } else {
          stats.fingerprintUnavailable = true;
        }
      }
      dhash = hashes.length > 0 ? hashes : null;
      fingerprint = stats.fingerprintUnavailable ? "unavailable" : "ok";
    }
  }

  // 4. can it be judged at all?
  const anyText = entries.some((e) => typeof e.text === "string" && e.text.length > 0);
  const systemicMiss = stats.downloadFailedSystemic > 0;
  if (row.type === "instagram" && !screenshotShown) {
    return { kind: "release", systemic: systemicMiss, reason: systemicMiss ? "screenshot_unavailable_systemic" : "screenshot_unavailable", stats };
  }
  if (row.type === "general" && stats.images === 0 && !anyText) {
    return { kind: "release", systemic: systemicMiss, reason: systemicMiss ? "nothing_visible_systemic" : "nothing_visible", stats };
  }

  parts.push({ type: "text", text: renderTask(row.type, row.task) });
  parts.push({ type: "text", text: renderSubmission(submittedOn, entries, hidden) });
  parts.push(...imageParts);
  return { kind: "label", parts, dhash, fingerprint, stats };
}

// ─────────────────────────── the run ───────────────────────────

export interface RunSummary {
  status: string;
  claimed: number;
  checked: number;
  accepted: number;
  rejected: number;
  reasons: Record<string, number>;
  released_free: number;
  released_charged: number;
  release_reasons: Record<string, number>;
  stale: number;
  record_failed: number;
  calls: number;
  fell_back: number;
  providers_used: string[];
  models: string[];
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  images: number;
  thumb_fallbacks: number;
  hashes: number;
  hash_thumb_fallbacks: number;
  fingerprint_unavailable: number;
  download_failed: number;
  raw_missing: number;
  ig_probe: string;
  prompt_version: string;
}

function bump(m: Record<string, number>, k: string) {
  m[k] = (m[k] ?? 0) + 1;
}

function newSummary(): RunSummary {
  return {
    status: "ok", claimed: 0, checked: 0, accepted: 0, rejected: 0, reasons: {}, released_free: 0, released_charged: 0,
    release_reasons: {}, stale: 0, record_failed: 0, calls: 0, fell_back: 0, providers_used: [], models: [], tokens_in: 0,
    tokens_out: 0, cost_usd: 0, images: 0, thumb_fallbacks: 0, hashes: 0, hash_thumb_fallbacks: 0, fingerprint_unavailable: 0,
    download_failed: 0, raw_missing: 0, ig_probe: IG_PROBE_VERIFIED ? "on" : "off_login_wall", prompt_version: PROMPT_VERSION,
  };
}

function hourStartIso(now: number): string {
  return new Date(Math.floor(now / 3_600_000) * 3_600_000).toISOString();
}

/** Parse the claim RPC's rows defensively (it is SQL output, but a bad row must never crash the run). */
export function parseClaimRows(items: unknown): ClaimRow[] {
  if (!Array.isArray(items)) return [];
  const out: ClaimRow[] = [];
  for (const r of items) {
    if (!isObj(r)) continue;
    const id = Number(r.submission_id);
    const version = Number(r.version);
    if (!Number.isSafeInteger(id) || typeof r.token !== "string" || !Number.isSafeInteger(version)) continue;
    if (r.type !== "general" && r.type !== "instagram") continue;
    const t = isObj(r.task) ? r.task : {};
    out.push({
      submission_id: id, token: r.token, version, type: r.type,
      task: {
        id: Number(t.id), title: typeof t.title === "string" ? t.title : null, body: typeof t.body === "string" ? t.body : null,
        rubric: typeof t.rubric === "string" ? t.rubric : null, requires_tag: typeof t.requires_tag === "boolean" ? t.requires_tag : null,
        tag_handle: typeof t.tag_handle === "string" ? t.tag_handle : null,
      },
      handle: typeof r.handle === "string" ? r.handle : null,
      items: (Array.isArray(r.items) ? r.items : []).filter(isObj).map((i) => ({
        chat_id: Number(i.chat_id), message_id: Number(i.message_id),
        kinds: Array.isArray(i.kinds) ? i.kinds.filter((k): k is string => typeof k === "string") : [],
        file_ids: Array.isArray(i.file_ids) ? i.file_ids.filter((k): k is string => typeof k === "string") : [],
        text: typeof i.text === "string" ? i.text : null, shortcode: typeof i.shortcode === "string" ? i.shortcode : null,
        has_thumb: typeof i.has_thumb === "boolean" ? i.has_thumb : null, mime: typeof i.mime === "string" ? i.mime : null,
      })),
    });
  }
  return out;
}

/** Claim -> check every row (concurrency 2) -> heartbeat. Every outcome, including every failure, is a DB row. */
export async function runOnce(env: RunEnv, io: RunIO): Promise<RunResponse> {
  const started = io.now();
  const { admin } = io;
  const available: Provider[] = [];
  if (env.anthropicKey && io.makeAnthropic && io.anthropicErrors) available.push("anthropic");
  if (env.openaiKey) available.push("openai");
  const summary = newSummary();

  // config (provider order, models, prices, the probe flag) — a read of the ONE parser the SQL engine uses
  let cfg: Record<string, unknown> = {};
  try {
    const { data, error } = await admin.rpc("challenge_tasks_config");
    if (!error && isObj(data)) cfg = data;
  } catch { /* defaults below */ }
  const aiCfg: AiConfig = sanitizeAiConfig(cfg, available);

  if (aiCfg.providers.length === 0) {
    // Graceful is not silent: the work waits in 'checking' (the engine watchdog alarms on checks_stuck), and a
    // daily signal plus an hourly heartbeat say why. Nothing is claimed, so no lease or attempt is spent.
    await logHealthOnce(admin, "challenge_task_check_no_provider", "day", { available, order: cfg.ai_provider_order ?? null });
    await logHealthOnce(admin, "challenge_task_check_run", `no_key:${hourStartIso(io.now())}`,
      { status: "no_key", prompt_version: PROMPT_VERSION }, { sinceIso: hourStartIso(io.now()) });
    return { httpStatus: 200, body: { status: "no_key" } };
  }
  if (!env.botToken) await logHealthOnce(admin, "challenge_task_check_no_bot_token", "day", {});

  const { data: claim, error: claimErr } = await admin.rpc("challenge_task_check_claim", { _limit: CLAIM_LIMIT });
  if (claimErr) {
    await logHealth(admin, "challenge_task_check_run", {
      status: "claim_error", error: clip(redactSecrets(claimErr.message ?? claimErr), 300), prompt_version: PROMPT_VERSION,
    });
    return { httpStatus: 500, body: { status: "claim_error" } };
  }
  if (!isObj(claim) || claim.ok !== true) {
    const reason = isObj(claim) && typeof claim.reason === "string" ? claim.reason : "unknown";
    await logHealth(admin, "challenge_task_check_run", { status: reason, spent_usd: isObj(claim) ? claim.spent_usd ?? null : null,
      prompt_version: PROMPT_VERSION });
    return { httpStatus: 200, body: { status: reason } };
  }
  const rows = parseClaimRows(claim.items);
  summary.claimed = rows.length;
  if (rows.length === 0) {
    await logHealth(admin, "challenge_task_check_run", { ...summary, status: "idle", ms: io.now() - started });
    return { httpStatus: 200, body: { status: "idle" } };
  }

  const deps: LabelDeps = {
    anthropic: available.includes("anthropic") ? io.makeAnthropic!(env.anthropicKey) : undefined,
    anthropicErrors: io.anthropicErrors,
    openaiKey: env.openaiKey || undefined,
    fetchFn: io.fetchFn,
    now: io.now,
  };
  const breaker: Breaker = newBreaker();
  const used = new Set<string>();
  const mods = new Set<string>();
  const probeEnabled = isObj(cfg.ig) ? cfg.ig.existence_probe !== false : true;
  const hardDeadline = started + HARD_DEADLINE_MS;

  const release = async (row: ClaimRow, reason: string, refund: boolean, calls: CallRecord[]) => {
    try {
      const { data, error } = await admin.rpc("challenge_task_check_release", {
        _sub: row.submission_id, _token: row.token, _reason: clip(reason, 200), _calls: toSqlCalls(calls), _refund: refund,
      });
      if (error || !isObj(data)) {
        summary.record_failed++;
      } else if (data.ok !== true) {
        summary.stale++;
      } else {
        if (refund) summary.released_free++;
        else summary.released_charged++;
        bump(summary.release_reasons, reason.split(":")[0]);
      }
    } catch {
      summary.record_failed++;
    }
  };

  const tallyCalls = (calls: CallRecord[], fellBack: boolean) => {
    for (const c of calls) {
      summary.calls++;
      summary.tokens_in += c.tokens_in ?? 0;
      summary.tokens_out += c.tokens_out ?? 0;
      summary.cost_usd += c.cost_usd;
      if (c.ok) {
        used.add(c.provider);
        if (c.model) mods.add(c.model);
      }
    }
    if (fellBack) summary.fell_back++;
  };

  const checkRow = async (row: ClaimRow) => {
    if (io.now() - started >= DISPATCH_BUDGET_MS) {
      await release(row, "out_of_time", true, []);
      return;
    }
    // the raw messages, readable only while this run holds the lease
    let media: MediaItem[] = [];
    let submittedOn: string | null = null;
    try {
      const { data, error } = await admin.rpc("challenge_task_check_media", { _sub: row.submission_id, _token: row.token });
      if (error) {
        await release(row, "media_rpc_error", true, []);
        return;
      }
      if (!isObj(data) || data.ok !== true) {
        summary.stale++;
        return;
      }
      submittedOn = typeof data.submitted_on === "string" ? data.submitted_on : null;
      media = (Array.isArray(data.items) ? data.items : []).filter(isObj).map((m) => ({
        chat_id: Number(m.chat_id), message_id: Number(m.message_id), message: m.message ?? null,
      }));
    } catch {
      await release(row, "media_rpc_error", true, []);
      return;
    }

    const plan = await planRow(row, media, submittedOn, io.codec,
      (fileId, maxBytes) => downloadTelegramFile(io.fetchFn, env.botToken, fileId, maxBytes, DOWNLOAD_TIMEOUT_MS));
    summary.images += plan.stats.images;
    summary.thumb_fallbacks += plan.stats.thumbFallbacks;
    summary.hashes += plan.stats.hashes;
    summary.hash_thumb_fallbacks += plan.stats.hashThumbFallbacks;
    if (plan.stats.fingerprintUnavailable) summary.fingerprint_unavailable++;
    summary.download_failed += plan.stats.downloadFailed;
    summary.raw_missing += plan.stats.rawMissing;
    if (plan.kind === "release") {
      await release(row, plan.reason, plan.systemic, []);
      return;
    }

    const shortcode = row.items.map((i) => i.shortcode).find((s): s is string => typeof s === "string" && s.length > 0) ?? null;
    const linkStatus = await linkStatusFor(row.type, shortcode, probeEnabled, io.fetchFn);
    const out = await labelWithFallback<Verdict>({
      system: SYSTEM_PROMPTS[row.type],
      parts: plan.parts,
      schema: SCHEMAS[row.type],
      schemaName: row.type === "instagram" ? "instagram_task_verdict" : "general_task_verdict",
      validate: (x) => validateVerdict(row.type, x),
    }, aiCfg, deps, breaker, hardDeadline);
    tallyCalls(out.calls, out.ok && out.fellBack);

    if (!out.ok) {
      await release(row, `ai_${out.error}`, out.systemic, out.calls);
      return;
    }
    try {
      const { data, error } = await admin.rpc("challenge_task_check_record", {
        _sub: row.submission_id, _token: row.token, _version: row.version,
        _result: { verdict: out.value, link_status: linkStatus, dhash: plan.dhash, fingerprint: plan.fingerprint },
        _calls: toSqlCalls(out.calls),
      });
      if (error || !isObj(data)) {
        summary.record_failed++;
        return;
      }
      if (data.ok === false) {
        if (data.reason === "stale") summary.stale++;
        else summary.record_failed++;
        return;
      }
      summary.checked++;
      if (data.decision === "accepted") summary.accepted++;
      else if (data.decision === "rejected") {
        summary.rejected++;
        const sub = isObj(data.submission) ? data.submission : {};
        bump(summary.reasons, typeof sub.reason === "string" ? sub.reason : "unknown");
      }
    } catch {
      summary.record_failed++;
    }
  };

  let next = 0;
  const worker = async () => {
    while (next < rows.length) {
      const row = rows[next++];
      try {
        await checkRow(row);
      } catch (e) {
        // never strand a lease on an unexpected throw: give it back (free) and keep going
        await release(row, `crash: ${clip(redactSecrets(e), 120)}`, true, []);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, worker));

  for (const p of breaker.authFailed) {
    await logHealthOnce(admin, "challenge_task_check_provider_auth_failed", p, { provider: p });
  }
  summary.providers_used = [...used];
  summary.models = [...mods];
  summary.cost_usd = Math.round(summary.cost_usd * 1e6) / 1e6;
  const details = { ...summary, ms: io.now() - started, auth_failed: [...breaker.authFailed] };
  await logHealth(admin, "challenge_task_check_run", details);
  return { httpStatus: 200, body: details };
}
