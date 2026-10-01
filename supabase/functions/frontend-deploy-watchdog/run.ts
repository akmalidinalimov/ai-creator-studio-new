// One watchdog run: gather what GitHub says about main → decide (watch.ts, pure) → execute the actions → stamp the
// state. Every dependency is injected (index.ts wires the real ones), so run.test.ts drives it with fakes.
//
// Order matters, and was chosen for "loud over silent":
//   1. Actions run BEFORE the state is written. A run that dies between the DM and the state write re-alarms on the
//      next run instead of never alarming.
//   2. An alarm / recovery is also deduped in the DATABASE per (row, sha) over 7 days (alreadyLogged), so a state
//      row that cannot be written cannot turn one alarm into a DM every 15 minutes.
//   3. The state row ('frontend_deploy_watchdog_state', checked_at) is stamped on EVERY run, blind or not — it is the
//      liveness signal hw_dm_health_stats() reads (and through it the out-of-band GitHub verifier).
//   4. Nothing here throws: a failure inside gather() is a 'crashed' blind run; a failure inside an action is
//      recorded and the remaining actions still run.

import { redactSecrets } from "../_shared/redact.ts";
import { failDetail, type FetchFn, fetchMainCommits, fetchVercelStatus } from "./github.ts";
import { decide, type MainCommit, observe, parseState, type WatchAction, type WatchInput, type WatchState } from "./watch.ts";

export const SCAN_COMMITS = 15;      // how far back to look for the live (last successful) build
export const GATHER_BUDGET_MS = 25_000;

export type RunDeps = {
  now(): number;
  /** ops_github_pat() via the service role. `error` = the RPC failed (≠ no PAT). Never logged. */
  getPat(): Promise<{ pat: string | null; error: string | null }>;
  fetchFn: FetchFn;
  readState(): Promise<unknown>;
  writeState(s: WatchState): Promise<boolean>;
  /** True when admin_actions already has `action` for this sha in the last 7 days (false on a failed check). */
  alreadyLogged(action: string, sha: string): Promise<boolean>;
  log(action: string, details: Record<string, unknown>): Promise<boolean>;
  /** One row per (action, key) per Tashkent day (logHealthOnce). */
  logOnce(action: string, key: string, details: Record<string, unknown>): Promise<boolean>;
  adminChatIds(): Promise<number[]>;
  /** One plain-text DM through sendTelegram (which records any non-delivery itself). True = Telegram accepted. */
  send(chatId: number, text: string): Promise<boolean>;
};

export type RunResult = {
  state: WatchState["state"];
  sha: string | null;
  lag: WatchState["lag"];
  actions: string[];
  state_written: boolean;
};

/** What GitHub says about main right now, or why the watchdog cannot see. */
export async function gather(deps: RunDeps): Promise<WatchInput> {
  const { pat, error } = await deps.getPat();
  if (error) return { kind: "blind", reason: "api_error", detail: `ops_github_pat() failed: ${error}` };
  if (!pat) return { kind: "blind", reason: "no_pat", detail: "OPS_GITHUB_PAT is not in Vault (ops flow dormant)" };

  const started = deps.now();
  const list = await fetchMainCommits(deps.fetchFn, pat, SCAN_COMMITS);
  if (!list.ok) return { kind: "blind", reason: list.reason, detail: failDetail(list) };

  const commits: MainCommit[] = list.data;
  for (let i = 0; i < commits.length; i++) {
    // Past the budget, stop walking back: the lag becomes "at least N" (observe() marks it inexact). The newest
    // commit's status is always fetched — without it there is nothing to judge.
    if (i > 0 && deps.now() - started > GATHER_BUDGET_MS) break;
    const st = await fetchVercelStatus(deps.fetchFn, pat, commits[i].sha);
    if (!st.ok) {
      if (i === 0) return { kind: "blind", reason: st.reason, detail: failDetail(st) };
      break; // an older commit failed to load: judge the head, report the lag as inexact
    }
    commits[i] = { ...commits[i], vercel: st.data };
    if (st.data.state === "success") break;
  }
  const obs = observe(commits.filter((c, i) => i === 0 || c.vercel));
  if (!obs) return { kind: "blind", reason: "api_error", detail: "status of the newest main commit could not be read" };
  return { kind: "seen", obs };
}

async function dmAdmins(deps: RunDeps, text: string): Promise<{ attempted: number; sent: number }> {
  const ids = await deps.adminChatIds();
  let sent = 0;
  for (const id of ids) if (await deps.send(id, text)) sent++;
  return { attempted: ids.length, sent };
}

async function execute(deps: RunDeps, a: WatchAction): Promise<string> {
  if (a.type === "blind") {
    await deps.logOnce(a.row, a.dedupeKey, a.details);
    if (!a.dm) return a.row;
    const dm = await dmAdmins(deps, a.dm);
    if (dm.sent === 0) {
      // A blind DM that reached nobody must still be visible (no bot token, no admin with a telegram_id).
      await deps.logOnce(`${a.row}_dm_undelivered`, a.dedupeKey, { attempted: dm.attempted });
    }
    return `${a.row}+dm(${dm.sent}/${dm.attempted})`;
  }
  if (await deps.alreadyLogged(a.row, a.sha)) return `${a.row}:deduped`;
  const dm = await dmAdmins(deps, a.text);
  await deps.log(a.row, { ...a.details, dm_attempted: dm.attempted, dm_sent: dm.sent });
  return `${a.row}+dm(${dm.sent}/${dm.attempted})`;
}

export async function runWatch(deps: RunDeps): Promise<RunResult> {
  let prev: WatchState | null = null;
  try {
    prev = parseState(await deps.readState());
  } catch {
    prev = null; // decide() then treats this as a first run; alreadyLogged() still stops a duplicate alarm
  }

  let input: WatchInput;
  try {
    input = await gather(deps);
  } catch (e) {
    input = { kind: "blind", reason: "crashed", detail: redactSecrets(e).slice(0, 200) };
  }

  const { next, actions } = decide(prev, input, deps.now());

  const done: string[] = [];
  for (const a of actions) {
    try {
      done.push(await execute(deps, a));
    } catch (e) {
      done.push(`${a.row}:error`);
      await deps.logOnce("frontend_deploy_watch_crashed", "action", { row: a.row, error: redactSecrets(e).slice(0, 200) })
        .catch(() => false);
    }
  }

  let written = false;
  try {
    written = await deps.writeState(next);
  } catch {
    written = false;
  }
  if (!written) {
    await deps.logOnce("frontend_deploy_watch_state_write_failed", "state", { state: next.state }).catch(() => false);
  }
  return { state: next.state, sha: next.sha, lag: next.lag, actions: done, state_written: written };
}
