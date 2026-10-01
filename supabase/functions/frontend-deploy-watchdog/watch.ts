// Pure decision logic for the production FRONTEND deploy watchdog (frontend-deploy-watchdog, migration
// 20261001030000). No I/O, no Deno APIs, no clock: run.ts gathers what GitHub says about main and feeds it in;
// this decides the state and which alarms / recoveries / blind signals to emit. Unit-tested in watch.test.ts,
// including a replay of the 2026-09-30 incident.
//
// THE INCIDENT IT EXISTS FOR (2026-09-30 → 10-01). Vercel's Hobby plan allows 100 deployments a day. Preview
// builds of agent PR branches used the quota up (133 deployments that day: 110 Preview, 23 Production), so the
// production builds of main for #241, #242, #243 and #244 failed with "Deployment rate limited — retry in 24
// hours." The live website and the Telegram Mini App stayed on afe750e (#232) while Supabase (functions and
// migrations, deployed by GitHub Actions) moved on to b575fce. The only trace was a red "Vercel" commit status:
// nothing in the database, no alert. This watchdog reads that status for the newest main commit.
//
// WHAT COUNTS AS BROKEN. The newest main commit's "Vercel" commit status is
//   failure / error                 → 'failed'  (class 'quota' when Vercel says rate-limited, else 'build_error')
//   pending / absent > STALL_MS     → 'stalled' (Vercel never finished, or never started: integration off,
//                                                 git.deploymentEnabled turned off for main, a stuck queue)
//   pending / absent ≤ STALL_MS     → 'building' (normal; neither an alarm nor a recovery)
//   success                         → 'ok'
// ONE alarm per incident: the first bad observation alarms, later bad commits do not repeat it (the 4 failures
// above make one DM), unless the failure CLASS changes on a new commit (quota → build error needs a different
// fix, so it is worth one more message). The incident ends only when the newest main commit is 'success'; the
// recovery DM is sent only when an alarm was sent.
//
// BLIND. When the watchdog cannot see (no PAT, GitHub 401/403/404, GitHub errors, a crash) it says so: one
// admin_actions row a day per reason, a DM at once for 'forbidden' (the PAT lacks a permission — only a human
// can fix that) and after BLIND_DM_AFTER_MS of continuous blindness for 'api_error' / 'crashed', then at most
// once per BLIND_DM_EVERY_MS. 'no_pat' never DMs: an unset OPS_GITHUB_PAT is the documented dormant mode of the
// whole ops flow. A blind run never raises or clears an alarm.
//
// UNDELIVERED. A DM that reaches no admin (no recipient, no bot token, Telegram refused every send) does not count
// as said. The first draft latched `alerting` on the DECISION, and its recipient query always failed (PGRST200), so
// every alarm was "raised" to nobody and never retried. Now an alarm / recovery / blind DM that reaches 0 admins is
// kept in state.pending_dm and re-sent (marked as late) every DM_RETRY_EVERY_MS until one admin gets it; run.ts
// writes '<row>_dm_undelivered' once a Tashkent day while it cannot, and '<row>_dm_delivered_late' when it finally
// does. A newer alarm or recovery supersedes a pending one (only the newest news is worth a late DM); a pending
// blind DM never displaces a pending alarm, and is dropped once the watchdog can see again.

import { redactSecrets } from "../_shared/redact.ts";

export const REPO = "akmalidinalimov/ai-creator-studio-new";
export const STATE_KEY = "frontend_deploy_watchdog_state"; // '%_watchdog_state' → hw_dm_health_stats() liveness
export const VERCEL_CONTEXT = "Vercel";
export const STALL_MS = 30 * 60_000;
export const BLIND_DM_AFTER_MS = 2 * 3_600_000;
export const BLIND_DM_EVERY_MS = 24 * 3_600_000;
export const DM_RETRY_EVERY_MS = 30 * 60_000; // an undelivered DM is re-sent at most every 30 min (every 2nd run)
const PENDING_TEXT_MAX = 3500;                 // Telegram's cap is 4096; the late-delivery prefix needs room

export type VercelState = "success" | "failure" | "error" | "pending" | "absent";
/** rateLimited is read from the RAW description + target_url (the cleaned URL drops the ?upgradeToPro=… query). */
export type VercelStatus = { state: VercelState; description: string | null; targetUrl: string | null; rateLimited: boolean };

/** One main commit, newest first. `vercel` is undefined for a commit whose status was not fetched. */
export type MainCommit = { sha: string; subject: string; committedAt: string; vercel?: VercelStatus };

export type Observation = {
  head: MainCommit & { vercel: VercelStatus };
  liveSha: string | null;     // newest scanned main commit whose Vercel status is success
  lagCommits: number;         // main commits newer than liveSha (all scanned ones when none succeeded)
  lagExact: boolean;          // false when no scanned commit succeeded (the true lag is at least lagCommits)
  lagSinceAt: string | null;  // commit time of the oldest commit that is not live (null when nothing lags)
};

export type FailClass = "quota" | "build_error" | "stalled";
export type BlindReason = "no_pat" | "forbidden" | "api_error" | "crashed";
export type Verdict = "ok" | "building" | "failed" | "stalled";
export type StateName = "seeded" | Verdict | BlindReason;

export type WatchState = {
  checked_at: string;          // every run — the liveness stamp hw_dm_health_stats() reads
  state: StateName;
  sha: string | null;          // newest main commit at the last run that could see
  lag: { commits: number; exact: boolean; minutes: number } | null;
  live_sha: string | null;
  alerting: boolean;           // an alarm was emitted and the newest main commit has not succeeded since
  alarm_sha: string | null;
  alarm_class: FailClass | null;
  alarm_at: string | null;
  blind_since: string | null;  // first run of the current blind streak
  blind_dm_at: string | null;  // last blind DM (dedupe across days and reasons)
  detail: string | null;       // why the last run was blind (endpoint, HTTP status, GitHub's message)
  pending_dm: PendingDm | null; // a DM that reached no admin yet (see UNDELIVERED above)
};

export type DmRow = AlarmRow | "frontend_deploy_recovered" | `frontend_deploy_watch_${BlindReason}`;
export type PendingDm = {
  row: DmRow;                  // the admin_actions row the DM belongs to
  kind: "alarm" | "blind";     // alarm = an alarm or a recovery; blind = a "watchdog cannot see" DM
  ref: string;                 // the sha (alarm / recovery) or the blind reason
  text: string;                // the original DM text, re-sent with a "delivered late" prefix
  raised_at: string;
  attempts: number;
  next_try_at: string;
};
export type DmOutcome = { attempted: number; sent: number };

export type WatchInput =
  | { kind: "seen"; obs: Observation }
  | { kind: "blind"; reason: BlindReason; detail: string };

export type AlarmRow = "frontend_deploy_failed" | "frontend_deploy_stalled";
export type WatchAction =
  | { type: "alarm"; row: AlarmRow; cls: FailClass; sha: string; text: string; details: Record<string, unknown> }
  | { type: "recovered"; row: "frontend_deploy_recovered"; sha: string; text: string; details: Record<string, unknown> }
  | {
    type: "blind";
    row: `frontend_deploy_watch_${BlindReason}`;
    reason: BlindReason;
    dedupeKey: string;
    details: Record<string, unknown>;
    dm: string | null; // null = record only
  }
  | { type: "retry"; row: DmRow; ref: string; text: string; details: Record<string, unknown> };

// ─────────────────────────── sanitizing (everything shown or stored came from GitHub) ───────────────────────────

/** One line of plain text: control / bidi / zero-width characters out, whitespace collapsed, secrets redacted, capped. */
export function cleanText(input: unknown, max: number): string {
  if (typeof input !== "string") return "";
  // deno-lint-ignore no-control-regex
  const flat = input.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, " ")
    .replace(/\s+/g, " ").trim();
  const red = redactSecrets(flat);
  return red.length > max ? red.slice(0, max - 1) + "…" : red;
}

/** A Vercel link, or null: https only, a Vercel host only, query and fragment dropped. */
export function cleanVercelUrl(input: unknown): string | null {
  if (typeof input !== "string" || !input) return null;
  try {
    const u = new URL(input);
    const host = u.hostname.toLowerCase();
    const vercel = host === "vercel.com" || host.endsWith(".vercel.com") || host.endsWith(".vercel.app");
    if (u.protocol !== "https:" || !vercel) return null;
    return (u.origin + u.pathname).slice(0, 200);
  } catch {
    return null;
  }
}

const short = (sha: string | null | undefined) => (sha ?? "").slice(0, 7);

// ─────────────────────────── reading GitHub's answer ───────────────────────────

/**
 * The Vercel entry of a combined-status `statuses` array (GitHub returns the latest status per context). Exact
 * context "Vercel" first, else the first context starting with "Vercel" (a project-suffixed one). No entry =
 * 'absent'. An unknown state string counts as 'pending' (not finished), never as success.
 */
export function pickVercelStatus(statuses: unknown): VercelStatus {
  const list = Array.isArray(statuses) ? statuses.filter((s) => s && typeof s === "object") : [];
  // deno-lint-ignore no-explicit-any
  const ctx = (s: any) => (typeof s.context === "string" ? s.context : "");
  // deno-lint-ignore no-explicit-any
  const hit: any = list.find((s) => ctx(s) === VERCEL_CONTEXT) ?? list.find((s) => /^vercel\b/i.test(ctx(s)));
  if (!hit) return { state: "absent", description: null, targetUrl: null, rateLimited: false };
  const raw = typeof hit.state === "string" ? hit.state.toLowerCase() : "";
  const state: VercelState = raw === "success" || raw === "failure" || raw === "error" ? raw : "pending";
  const rawText = [hit.description, hit.target_url].filter((x) => typeof x === "string").join(" ");
  return {
    state,
    description: cleanText(hit.description, 160) || null,
    targetUrl: cleanVercelUrl(hit.target_url),
    rateLimited: isQuotaText(rawText),
  };
}

/**
 * Summarise main from its commits, newest first, with statuses fetched from the newest down to (and including) the
 * first success. Null when there is nothing to judge (no commits, or the newest has no status fetched).
 */
export function observe(commits: MainCommit[]): Observation | null {
  if (!commits.length || !commits[0].vercel) return null;
  const head = commits[0] as MainCommit & { vercel: VercelStatus };
  const idx = commits.findIndex((c) => c.vercel?.state === "success");
  if (idx === -1) {
    const fetched = commits.filter((c) => c.vercel);
    return {
      head,
      liveSha: null,
      lagCommits: fetched.length,
      lagExact: false,
      lagSinceAt: fetched[fetched.length - 1].committedAt,
    };
  }
  return {
    head,
    liveSha: commits[idx].sha,
    lagCommits: idx,
    lagExact: true,
    lagSinceAt: idx > 0 ? commits[idx - 1].committedAt : null,
  };
}

/** The newest commit's verdict. An unparsable commit time counts as old (loud), never as "still building". */
export function headVerdict(head: { committedAt: string; vercel: VercelStatus }, nowMs: number): Verdict {
  const st = head.vercel.state;
  if (st === "success") return "ok";
  if (st === "failure" || st === "error") return "failed";
  const t = Date.parse(head.committedAt);
  return !Number.isFinite(t) || nowMs - t > STALL_MS ? "stalled" : "building";
}

/** Vercel's rate-limit answer ("Deployment rate limited — retry in 24 hours.", …?upgradeToPro=build-rate-limit). */
export function isQuotaText(text: string): boolean {
  return /rate[\s-]?limit|quota|upgradeToPro|too many deployments|limit (?:reached|exceeded)/i.test(text);
}

export function failClass(verdict: Verdict, v: VercelStatus): FailClass {
  if (verdict === "stalled") return "stalled";
  return v.rateLimited || isQuotaText(v.description ?? "") ? "quota" : "build_error";
}

// ─────────────────────────── state ───────────────────────────

const STATES: StateName[] = ["seeded", "ok", "building", "failed", "stalled", "no_pat", "forbidden", "api_error", "crashed"];
const CLASSES: FailClass[] = ["quota", "build_error", "stalled"];
const BLIND: StateName[] = ["no_pat", "forbidden", "api_error", "crashed"];

const iso = (v: unknown): string | null => (typeof v === "string" && Number.isFinite(Date.parse(v)) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** The stored jsonb, read defensively (the migration's seed row carries only a few fields). Null = no usable row. */
export function parseState(v: unknown): WatchState | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  // deno-lint-ignore no-explicit-any
  const o = v as any;
  const lag = o.lag && typeof o.lag === "object" && Number.isFinite(o.lag.commits)
    ? { commits: Number(o.lag.commits), exact: o.lag.exact !== false, minutes: Number.isFinite(o.lag.minutes) ? Number(o.lag.minutes) : 0 }
    : null;
  return {
    checked_at: iso(o.checked_at) ?? new Date(0).toISOString(),
    state: STATES.includes(o.state) ? o.state : "seeded",
    sha: str(o.sha),
    lag,
    live_sha: str(o.live_sha),
    alerting: o.alerting === true,
    alarm_sha: str(o.alarm_sha),
    alarm_class: CLASSES.includes(o.alarm_class) ? o.alarm_class : null,
    alarm_at: iso(o.alarm_at),
    blind_since: iso(o.blind_since),
    blind_dm_at: iso(o.blind_dm_at),
    detail: str(o.detail),
    pending_dm: parsePending(o.pending_dm),
  };
}

const DM_ROWS: string[] = [
  "frontend_deploy_failed", "frontend_deploy_stalled", "frontend_deploy_recovered",
  ...BLIND.map((r) => `frontend_deploy_watch_${r}`),
];

function parsePending(v: unknown): PendingDm | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  // deno-lint-ignore no-explicit-any
  const p = v as any;
  const text = typeof p.text === "string" ? p.text.slice(0, PENDING_TEXT_MAX) : "";
  const raised = iso(p.raised_at);
  if (!DM_ROWS.includes(p.row) || (p.kind !== "alarm" && p.kind !== "blind") || !str(p.ref) || !text.trim() || !raised) {
    return null;
  }
  return {
    row: p.row,
    kind: p.kind,
    ref: p.ref,
    text,
    raised_at: raised,
    attempts: Number.isFinite(p.attempts) && p.attempts > 0 ? Math.floor(p.attempts) : 1,
    next_try_at: iso(p.next_try_at) ?? raised,
  };
}

function emptyState(nowIso: string): WatchState {
  return {
    checked_at: nowIso, state: "seeded", sha: null, lag: null, live_sha: null, alerting: false, alarm_sha: null,
    alarm_class: null, alarm_at: null, blind_since: null, blind_dm_at: null, detail: null, pending_dm: null,
  };
}

const minutesSince = (at: string | null, nowMs: number): number => {
  const t = at ? Date.parse(at) : NaN;
  return Number.isFinite(t) ? Math.max(0, Math.floor((nowMs - t) / 60_000)) : 0;
};

// ─────────────────────────── messages (plain text, no parse_mode) ───────────────────────────

const SITE = "www.aicreator.academy";
const commitUrl = (sha: string) => `https://github.com/${REPO}/commit/${sha}`;

/** A commit subject for a DM: capped, but a trailing "(#241)" PR reference always survives the cut. */
export function shortSubject(subject: string, max = 90): string {
  const s = cleanText(subject, 1000);
  const m = /\s*(\(#\d{1,6}\))$/.exec(s);
  if (!m) return cleanText(s, max) || "(no subject)";
  const head = s.slice(0, m.index);
  return `${cleanText(head, Math.max(10, max - m[1].length - 1))} ${m[1]}`;
}

function lagLine(obs: Observation, nowMs: number): string {
  const n = obs.lagCommits;
  const mins = minutesSince(obs.lagSinceAt, nowMs);
  const commits = `${obs.lagExact ? "" : "at least "}${n} main commit${n === 1 ? "" : "s"}`;
  const live = obs.liveSha ? `live build = ${short(obs.liveSha)}` : "no successful build among the newest scanned commits";
  return `The live site lags main by ${commits} (${mins} min); ${live}.`;
}

const HINTS: Record<FailClass, string> = {
  quota:
    "Fix: Vercel's Hobby build quota is used up (100 deployments/day, rolling 24 h). No code change: wait for it to " +
    "free, then redeploy — merge or push anything to main, or Vercel → Deployments → Redeploy the newest main " +
    "commit. Preview builds must stay off (vercel.json git.deploymentEnabled) or agent branches burn the quota again.",
  build_error:
    "Fix: the production build itself failed — open the Vercel build log (link above), fix it on a branch and " +
    "merge; the next main push redeploys.",
  stalled:
    "Fix: Vercel has not finished this commit 30+ min after it landed. Open Vercel → Deployments: stuck or queued " +
    "→ cancel and Redeploy. No deployment at all → check the Vercel Git integration and that vercel.json " +
    "git.deploymentEnabled still has \"main\": true.",
};

export function alarmText(obs: Observation, cls: FailClass, nowMs: number): string {
  const h = obs.head;
  const title = cls === "stalled"
    ? `🚨 Frontend deploy STALLED — ${SITE} (and the Telegram Mini App) is not on the newest main.`
    : `🚨 Frontend deploy FAILED — ${SITE} (and the Telegram Mini App) is not on the newest main.`;
  const status = h.vercel.state === "absent"
    ? `Vercel: no status at all, ${minutesSince(h.committedAt, nowMs)} min after the commit.`
    : `Vercel: ${h.vercel.state}${h.vercel.description ? ` — "${h.vercel.description}"` : ""}` +
      (cls === "stalled" ? ` (${minutesSince(h.committedAt, nowMs)} min after the commit)` : "");
  return [
    title,
    "",
    `Commit: ${short(h.sha)} — ${shortSubject(h.subject)}`,
    commitUrl(h.sha),
    status,
    ...(h.vercel.targetUrl ? [`Vercel link: ${h.vercel.targetUrl}`] : []),
    lagLine(obs, nowMs),
    "Supabase (edge functions + migrations) deploys separately, through GitHub Actions, and is not held back by " +
    "this, so the backend can be ahead of the website until it clears.",
    "",
    HINTS[cls],
  ].join("\n");
}

export function recoveredText(obs: Observation, prev: WatchState, nowMs: number): string {
  const open = minutesSince(prev.alarm_at, nowMs);
  return [
    `✅ Frontend deploy recovered — main ${short(obs.head.sha)} is live on Vercel (${SITE}, Mini App).`,
    shortSubject(obs.head.subject),
    `The alarm for ${short(prev.alarm_sha)} (${prev.alarm_class ?? "?"}) was open ${open} min.`,
  ].join("\n");
}

export function blindText(reason: BlindReason, detail: string, blindMinutes: number): string {
  if (reason === "forbidden") {
    const needs = /\bstatus\b/.test(detail) ? "'Commit statuses: Read-only'" : "'Contents: Read-only' (and 'Commit statuses: Read-only')";
    return [
      "⚠️ Frontend deploy watchdog is BLIND — GitHub refused the OPS_GITHUB_PAT.",
      `GitHub: ${detail}`,
      `The token needs ${needs} on ${REPO}. Edit the fine-grained token on GitHub (Settings → Developer settings → ` +
      "Fine-grained tokens); editing permissions keeps the same token value, so Vault needs no change.",
      "Until then a failed or stalled production deploy of the website is NOT detected.",
    ].join("\n");
  }
  return [
    `⚠️ Frontend deploy watchdog cannot read GitHub for ${blindMinutes} min (${reason}).`,
    `Last error: ${detail}`,
    "Until this clears a failed or stalled production deploy of the website is NOT detected.",
  ].join("\n");
}

/** A DM re-sent because no admin got it the first time: marked late, with when it was first raised. */
export function lateText(p: PendingDm): string {
  const at = p.raised_at.slice(0, 16).replace("T", " ");
  return `(Delivered late: first raised ${at} UTC, when it reached no admin. Attempt ${p.attempts + 1}.)\n\n${p.text}`;
}

// ─────────────────────────── the decision ───────────────────────────

type Decision = { next: WatchState; actions: WatchAction[] };

/** One run: the next state to store and the actions to execute (run.ts executes them; nothing here sends). */
export function decide(prevIn: WatchState | null, input: WatchInput, nowMs: number): Decision {
  const prev = prevIn ?? emptyState(new Date(nowMs).toISOString());
  return withPendingDm(prev, decideVerdict(prev, input, nowMs), nowMs);
}

/**
 * The undelivered-DM slot (see UNDELIVERED above). A fresh alarm / recovery supersedes any pending DM; a fresh blind
 * DM supersedes a pending blind DM; a pending blind DM is moot once the watchdog can see. Whatever is still pending
 * is re-sent when its next_try_at has come — blind or not, because Telegram does not depend on GitHub.
 */
function withPendingDm(prev: WatchState, d: Decision, nowMs: number): Decision {
  let pending = prev.pending_dm;
  const freshAlarm = d.actions.some((a) => a.type === "alarm" || a.type === "recovered");
  const freshBlindDm = d.actions.some((a) => a.type === "blind" && a.dm);
  const seeing = !BLIND.includes(d.next.state);
  if (pending && (freshAlarm || (pending.kind === "blind" && (freshBlindDm || seeing)))) pending = null;
  const actions = [...d.actions];
  if (pending && nowMs >= Date.parse(pending.next_try_at)) {
    actions.push({
      type: "retry",
      row: pending.row,
      ref: pending.ref,
      text: lateText(pending),
      details: { ref: pending.ref, raised_at: pending.raised_at, attempt: pending.attempts + 1 },
    });
  }
  return { next: { ...d.next, pending_dm: pending }, actions };
}

/**
 * The state after one executed DM-carrying action, by what Telegram did with it (pure; run.ts calls it once per
 * action). `dm` null = nothing was sent (a record-only blind row, or an alarm deduped in the database).
 *   delivered (sent > 0)  → a retry clears the slot; anything else leaves the state as decided.
 *   undelivered           → an alarm / recovery takes the slot; a blind DM takes it unless an alarm holds it
 *                           (a frontend failure outranks "the watchdog is blind"); a retry counts one more attempt.
 */
export function settleDelivery(next: WatchState, a: WatchAction, dm: DmOutcome | null, nowMs: number): WatchState {
  if (!dm) return next;
  const nowIso = new Date(nowMs).toISOString();
  const retryAt = new Date(nowMs + DM_RETRY_EVERY_MS).toISOString();
  if (dm.sent > 0) return a.type === "retry" ? { ...next, pending_dm: null } : next;
  if (a.type === "retry") {
    const p = next.pending_dm;
    return p ? { ...next, pending_dm: { ...p, attempts: p.attempts + 1, next_try_at: retryAt } } : next;
  }
  const fresh = (kind: PendingDm["kind"], row: DmRow, ref: string, text: string): WatchState => ({
    ...next,
    pending_dm: { row, kind, ref, text: text.slice(0, PENDING_TEXT_MAX), raised_at: nowIso, attempts: 1, next_try_at: retryAt },
  });
  if (a.type === "alarm" || a.type === "recovered") return fresh("alarm", a.row, a.sha, a.text);
  if (a.type === "blind" && a.dm && next.pending_dm?.kind !== "alarm") return fresh("blind", a.row, a.reason, a.dm);
  return next;
}

function decideVerdict(prev: WatchState, input: WatchInput, nowMs: number): Decision {
  const nowIso = new Date(nowMs).toISOString();
  const actions: WatchAction[] = [];

  if (input.kind === "blind") {
    const detail = cleanText(input.detail, 200);
    const blindSince = BLIND.includes(prev.state) && prev.blind_since ? prev.blind_since : nowIso;
    const blindMs = nowMs - Date.parse(blindSince);
    const lastDm = prev.blind_dm_at ? Date.parse(prev.blind_dm_at) : NaN;
    const dmDue = !Number.isFinite(lastDm) || nowMs - lastDm >= BLIND_DM_EVERY_MS;
    const wantsDm = input.reason === "forbidden" ||
      ((input.reason === "api_error" || input.reason === "crashed") && blindMs >= BLIND_DM_AFTER_MS);
    const dm = wantsDm && dmDue ? blindText(input.reason, detail, Math.floor(blindMs / 60_000)) : null;
    actions.push({
      type: "blind",
      row: `frontend_deploy_watch_${input.reason}`,
      reason: input.reason,
      dedupeKey: input.reason,
      details: { detail, blind_minutes: Math.floor(blindMs / 60_000), alerting: prev.alerting, alarm_sha: prev.alarm_sha },
      dm,
    });
    return {
      next: { ...prev, checked_at: nowIso, state: input.reason, blind_since: blindSince, blind_dm_at: dm ? nowIso : prev.blind_dm_at, detail },
      actions,
    };
  }

  const obs = input.obs;
  const verdict = headVerdict(obs.head, nowMs);
  const lag = { commits: obs.lagCommits, exact: obs.lagExact, minutes: minutesSince(obs.lagSinceAt, nowMs) };
  const next: WatchState = {
    ...prev,
    checked_at: nowIso,
    state: verdict,
    sha: obs.head.sha,
    lag,
    live_sha: obs.liveSha,
    blind_since: null,
    detail: null,
  };

  if (verdict === "ok") {
    if (prev.alerting) {
      actions.push({
        type: "recovered",
        row: "frontend_deploy_recovered",
        sha: obs.head.sha,
        text: recoveredText(obs, prev, nowMs),
        details: {
          sha: obs.head.sha,
          alarm_sha: prev.alarm_sha,
          alarm_class: prev.alarm_class,
          open_minutes: minutesSince(prev.alarm_at, nowMs),
        },
      });
    }
    return { next: { ...next, alerting: false, alarm_sha: null, alarm_class: null, alarm_at: null }, actions };
  }

  if (verdict === "building") return { next, actions }; // neither broken nor recovered yet

  const cls = failClass(verdict, obs.head.vercel);
  const isNewIncident = !prev.alerting;
  const classChanged = prev.alerting && prev.alarm_class !== cls && prev.alarm_sha !== obs.head.sha;
  if (isNewIncident || classChanged) {
    actions.push({
      type: "alarm",
      row: verdict === "stalled" ? "frontend_deploy_stalled" : "frontend_deploy_failed",
      cls,
      sha: obs.head.sha,
      text: alarmText(obs, cls, nowMs),
      details: {
        sha: obs.head.sha,
        subject: cleanText(obs.head.subject, 120),
        committed_at: obs.head.committedAt,
        vercel_state: obs.head.vercel.state,
        description: obs.head.vercel.description,
        target_url: obs.head.vercel.targetUrl,
        class: cls,
        class_changed_from: classChanged ? prev.alarm_class : null,
        lag_commits: lag.commits,
        lag_exact: lag.exact,
        lag_minutes: lag.minutes,
        live_sha: obs.liveSha,
      },
    });
    return { next: { ...next, alerting: true, alarm_sha: obs.head.sha, alarm_class: cls, alarm_at: nowIso }, actions };
  }
  return { next, actions }; // the same incident, already alarmed: no repeat
}
