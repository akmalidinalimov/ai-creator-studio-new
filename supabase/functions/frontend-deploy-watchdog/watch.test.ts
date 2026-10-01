// Unit tests for the frontend deploy watchdog's pure decisions (watch.ts). No network, no database — CI's plain
// `deno test supabase/functions/`. The centrepiece replays the REAL 2026-09-30 sequence, read from GitHub's commit
// statuses on 2026-10-01: afe750e succeeded, then the production builds of #241–#244 were rate-limited.
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  BLIND_DM_AFTER_MS,
  BLIND_DM_EVERY_MS,
  cleanText,
  cleanVercelUrl,
  decide,
  failClass,
  headVerdict,
  type MainCommit,
  observe,
  parseState,
  pickVercelStatus,
  STALL_MS,
  type VercelStatus,
  type WatchAction,
  type WatchInput,
  type WatchState,
} from "./watch.ts";

const T = (s: string) => Date.parse(s);
const RATE_DESC = "Deployment rate limited — retry in 24 hours.";
const RATE_URL = "https://vercel.com/akmalidinalimovs-projects?upgradeToPro=build-rate-limit";
const OK_URL = "https://vercel.com/akmalidinalimovs-projects/ai-creator-studio-new/E5QGANLaSbk7rxP1xMpDCscEntgz";

// ─────────────────────────── the real 2026-09-30 timeline ───────────────────────────
type StatusEvent = { at: string; state: string; description: string; target_url: string };
type TimelineCommit = { sha: string; subject: string; committedAt: string; events: StatusEvent[] };

const TIMELINE: TimelineCommit[] = [ // oldest first
  {
    sha: "03d22fd0a1b5650291663bc7c043124a95d4a4db",
    subject: 'feat(miniapp): every student "watch" button opens the Mini App — /continue, one helper, open signal, coverage watchdog (#228)',
    committedAt: "2026-09-30T17:22:39Z",
    events: [
      { at: "2026-09-30T17:22:43Z", state: "pending", description: "Vercel is deploying your app", target_url: OK_URL },
      { at: "2026-09-30T17:23:05Z", state: "success", description: "Deployment has completed", target_url: OK_URL },
    ],
  },
  {
    sha: "afe750e3375a60a307ead15c2bf27e12e0f37332",
    subject: "feat(challenge): daily-tasks SQL engine — capture, option-1 attribution, settle, streak, corrections, reconciler, health + watchdog (Daily Tasks PR-3, INERT) (#232)",
    committedAt: "2026-09-30T17:26:37Z",
    events: [
      { at: "2026-09-30T17:26:41Z", state: "pending", description: "Vercel is deploying your app", target_url: OK_URL },
      { at: "2026-09-30T17:27:15Z", state: "success", description: "Deployment has completed", target_url: OK_URL },
    ],
  },
  {
    sha: "148fe169ad3de8eca27baea13c9e2ec03ac54f77",
    subject: "feat(challenge): daily-tasks bot — daily-topic dispatcher, receipts + reactions, dt: corrections, edits, /start dt_|ig, bot-status signal (Daily Tasks PR-4, INERT, no migration) (#241)",
    committedAt: "2026-09-30T19:54:50Z",
    events: [{ at: "2026-09-30T19:54:54Z", state: "failure", description: RATE_DESC, target_url: RATE_URL }],
  },
  {
    sha: "21b8cdcfda9dc9294c8b5b98538e97187b10a308",
    subject: "feat(challenge): AI checks for daily tasks — challenge-task-check + ai-label + check kick, INERT (Daily Tasks PR-6, migration 20260930151010) (#242)",
    committedAt: "2026-09-30T19:55:34Z",
    events: [{ at: "2026-09-30T19:55:38Z", state: "failure", description: RATE_DESC, target_url: RATE_URL }],
  },
  {
    sha: "a92bfcda5f167a8ca7ecd6cb58214d027530aaed",
    subject: "feat(challenge): daily-tasks worker — per-minute tick (09:00 post, DMs, 20:00 summary, 18:00 missing-task alert), SQL fallback poster, challenge-tasks-worker edge fn, identity sweep (Daily Tasks PR-5, INERT) (#243)",
    committedAt: "2026-09-30T19:59:18Z",
    events: [{ at: "2026-09-30T19:59:21Z", state: "failure", description: RATE_DESC, target_url: RATE_URL }],
  },
  {
    sha: "b575fce55b7ea3c8e4d18b5a78705b39809c12f2",
    subject: "feat(challenge): Kunlik vazifalar in the Mini App — submit-daily-task, dt/dt_<id>/ig start params, admin results tab (Daily Tasks PR-7, code only, hidden until miniapp=true) (#244)",
    committedAt: "2026-09-30T20:07:25Z",
    events: [{ at: "2026-09-30T20:07:29Z", state: "failure", description: RATE_DESC, target_url: RATE_URL }],
  },
];

// The heal (synthetic): the next main commit after the quota frees builds fine.
const HEAL: TimelineCommit = {
  sha: "0123456789abcdef0123456789abcdef01234567",
  subject: "fix(vercel): deploy only main + frontend deploy watchdog",
  committedAt: "2026-10-01T07:05:00Z",
  events: [
    { at: "2026-10-01T07:05:04Z", state: "pending", description: "Vercel is deploying your app", target_url: OK_URL },
    { at: "2026-10-01T07:05:50Z", state: "success", description: "Deployment has completed", target_url: OK_URL },
  ],
};

/** What run.ts would have gathered at `nowMs`: main newest first, statuses walked down to the first success. */
function worldAt(timeline: TimelineCommit[], nowMs: number): WatchInput {
  const onMain = timeline.filter((c) => T(c.committedAt) <= nowMs).reverse();
  const commits: MainCommit[] = [];
  for (const c of onMain) {
    const seen = c.events.filter((e) => T(e.at) <= nowMs);
    const latest = seen[seen.length - 1];
    const vercel = pickVercelStatus(latest ? [{ context: "Vercel", ...latest }] : []);
    commits.push({ sha: c.sha, subject: c.subject, committedAt: c.committedAt, vercel });
    if (vercel.state === "success") break;
  }
  const obs = observe(commits);
  if (!obs) throw new Error("empty world");
  return { kind: "seen", obs };
}

type Step = { at: number; actions: WatchAction[]; state: WatchState };

function replay(timeline: TimelineCommit[], times: number[], start: WatchState | null = null): Step[] {
  let st = start;
  const out: Step[] = [];
  for (const at of times) {
    const { next, actions } = decide(st, worldAt(timeline, at), at);
    out.push({ at, actions, state: next });
    // round-trip through JSON + parseState, exactly as app_settings stores it
    st = parseState(JSON.parse(JSON.stringify(next)));
  }
  return out;
}

const every15 = (fromIso: string, toIso: string) => {
  const out: number[] = [];
  for (let t = T(fromIso); t <= T(toIso); t += 15 * 60_000) out.push(t);
  return out;
};

Deno.test("replay 2026-09-30, one run after every status event: one alarm at the FIRST failure, no repeats", () => {
  const times = [
    "2026-09-30T17:27:30Z", // afe750e success
    "2026-09-30T19:55:00Z", // 148fe16 failure  → the alarm
    "2026-09-30T19:56:00Z", // 21b8cdc failure
    "2026-09-30T20:00:00Z", // a92bfcd failure
    "2026-09-30T20:08:00Z", // b575fce failure
    "2026-10-01T02:50:00Z", // the moment the incident was diagnosed
  ].map(T);
  const steps = replay(TIMELINE, times);
  assertEquals(steps.map((s) => s.actions.length), [0, 1, 0, 0, 0, 0]);
  assertEquals(steps.map((s) => s.state.state), ["ok", "failed", "failed", "failed", "failed", "failed"]);

  const alarm = steps[1].actions[0];
  assert(alarm.type === "alarm");
  assertEquals(alarm.row, "frontend_deploy_failed");
  assertEquals(alarm.cls, "quota");
  assertEquals(alarm.sha, "148fe169ad3de8eca27baea13c9e2ec03ac54f77");
  assertStringIncludes(alarm.text, "148fe16");
  assertStringIncludes(alarm.text, "(#241)");
  assertStringIncludes(alarm.text, `\nVercel: failure — "${RATE_DESC}"\nVercel link: `);
  assertStringIncludes(alarm.text, "Commit: 148fe16 — feat(challenge): daily-tasks bot");
  assertStringIncludes(alarm.text, "lags main by 1 main commit (0 min); live build = afe750e");
  assertStringIncludes(alarm.text, "Hobby build quota");
  assertStringIncludes(alarm.text, "https://github.com/akmalidinalimov/ai-creator-studio-new/commit/148fe169ad3de8eca27baea13c9e2ec03ac54f77");
  assertEquals(alarm.details.lag_commits, 1);
  assertEquals(alarm.details.live_sha, "afe750e3375a60a307ead15c2bf27e12e0f37332");
  assertEquals(alarm.details.target_url, "https://vercel.com/akmalidinalimovs-projects"); // query dropped

  // the state keeps tracking the growing lag without alarming again
  const last = steps[5].state;
  assertEquals(last.sha, "b575fce55b7ea3c8e4d18b5a78705b39809c12f2");
  assertEquals(last.lag, { commits: 4, exact: true, minutes: 415 }); // 19:54:50 → 02:50
  assertEquals(last.live_sha, "afe750e3375a60a307ead15c2bf27e12e0f37332");
  assertEquals(last.alerting, true);
  assertEquals(last.alarm_sha, "148fe169ad3de8eca27baea13c9e2ec03ac54f77");
  assertEquals(last.alarm_class, "quota");
});

Deno.test("replay at the cron cadence (every 15 min, 17:37 → 08:07 next day): 1 alarm, 1 recovery, nothing else", () => {
  const timeline = [...TIMELINE, HEAL];
  const steps = replay(timeline, every15("2026-09-30T17:37:00Z", "2026-10-01T08:07:00Z"));
  const acted = steps.filter((s) => s.actions.length);
  assertEquals(acted.length, 2);

  const [alarmStep, recoverStep] = acted;
  assertEquals(new Date(alarmStep.at).toISOString(), "2026-09-30T20:07:00.000Z"); // first run after 19:54:54
  const alarm = alarmStep.actions[0];
  assert(alarm.type === "alarm");
  assertEquals(alarm.sha, "a92bfcda5f167a8ca7ecd6cb58214d027530aaed"); // the newest main commit at that run
  assertEquals(alarm.details.lag_commits, 3);
  assertEquals(alarm.details.lag_minutes, 12);

  assertEquals(new Date(recoverStep.at).toISOString(), "2026-10-01T07:07:00.000Z");
  const rec = recoverStep.actions[0];
  assert(rec.type === "recovered");
  assertEquals(rec.sha, HEAL.sha);
  assertEquals(rec.details.alarm_sha, "a92bfcda5f167a8ca7ecd6cb58214d027530aaed");
  assertEquals(rec.details.open_minutes, 660);
  assertStringIncludes(rec.text, "recovered");
  assertStringIncludes(rec.text, "0123456");

  // between the two: still alerting; while HEAL was building (07:05:04 → 07:05:50) no run happened, but a run
  // during 'building' must neither recover nor alarm (checked below)
  const after = steps[steps.length - 1].state;
  assertEquals(after.state, "ok");
  assertEquals(after.alerting, false);
  assertEquals(after.lag, { commits: 0, exact: true, minutes: 0 });
});

Deno.test("a pending build of a new commit during an incident neither recovers nor re-alarms", () => {
  const timeline = [...TIMELINE, HEAL];
  const steps = replay(timeline, ["2026-09-30T19:55:00Z", "2026-10-01T07:05:30Z", "2026-10-01T07:06:00Z"].map(T));
  assertEquals(steps.map((s) => s.state.state), ["failed", "building", "ok"]);
  assertEquals(steps.map((s) => s.actions.map((a) => a.type)), [["alarm"], [], ["recovered"]]);
  assertEquals(steps[1].state.alerting, true);
});

Deno.test("recovery DM only after an alarm was sent", () => {
  // first ever run sees success: nothing
  const steps = replay(TIMELINE, ["2026-09-30T17:30:00Z", "2026-09-30T17:45:00Z"].map(T));
  assertEquals(steps.flatMap((s) => s.actions), []);
  // a 'building' → 'ok' transition with no alarm: nothing
  const steps2 = replay([...TIMELINE.slice(0, 2)], ["2026-09-30T17:26:50Z", "2026-09-30T17:27:30Z"].map(T));
  assertEquals(steps2.map((s) => s.state.state), ["building", "ok"]);
  assertEquals(steps2.flatMap((s) => s.actions), []);
});

// ─────────────────────────── stalled / build error / class change ───────────────────────────

const v = (state: VercelStatus["state"], description: string | null = null, extra: Partial<VercelStatus> = {}): VercelStatus => ({
  state,
  description,
  targetUrl: null,
  rateLimited: false,
  ...extra,
});
const commit = (sha: string, committedAt: string, vercel?: VercelStatus): MainCommit => ({ sha: sha.padEnd(40, "0"), subject: `subject ${sha}`, committedAt, vercel });
const seen = (...commits: MainCommit[]): WatchInput => ({ kind: "seen", obs: observe(commits)! });

Deno.test("pending or absent: building up to 30 min after the commit, stalled after", () => {
  const at = "2026-10-01T10:00:00Z";
  const ok = commit("aaa", "2026-10-01T09:00:00Z", v("success"));
  for (const st of ["pending", "absent"] as const) {
    const fresh = decide(null, seen(commit("bbb", at, v(st)), ok), T(at) + STALL_MS);
    assertEquals(fresh.next.state, "building");
    assertEquals(fresh.actions, []);
    const late = decide(null, seen(commit("bbb", at, v(st)), ok), T(at) + STALL_MS + 60_000);
    assertEquals(late.next.state, "stalled");
    assertEquals(late.actions.length, 1);
    const a = late.actions[0];
    assert(a.type === "alarm");
    assertEquals(a.row, "frontend_deploy_stalled");
    assertEquals(a.cls, "stalled");
    assertStringIncludes(a.text, "STALLED");
    assertStringIncludes(a.text, st === "absent" ? "no status at all, 31 min" : "pending");
    assertStringIncludes(a.text, "git.deploymentEnabled");
  }
});

Deno.test("an unparsable commit time is treated as old (loud), never as still building", () => {
  assertEquals(headVerdict({ committedAt: "", vercel: v("absent") }, T("2026-10-01T10:00:00Z")), "stalled");
});

Deno.test("a build error is classed apart from the quota, with the log link and its own hint", () => {
  const failed = commit("ccc", "2026-10-01T10:00:00Z", v("error", "Deployment has failed", {
    targetUrl: "https://vercel.com/akmalidinalimovs-projects/ai-creator-studio-new/AbCdEf",
  }));
  const r = decide(null, seen(failed, commit("aaa", "2026-10-01T09:00:00Z", v("success"))), T("2026-10-01T10:01:00Z"));
  const a = r.actions[0];
  assert(a.type === "alarm");
  assertEquals(a.cls, "build_error");
  assertStringIncludes(a.text, "Vercel link: https://vercel.com/akmalidinalimovs-projects/ai-creator-studio-new/AbCdEf");
  assertStringIncludes(a.text, "open the Vercel build log");
  assertEquals(failClass("failed", v("failure", null, { rateLimited: true })), "quota");
});

Deno.test("during an incident: same class on new commits → silent; a different class on a new commit → one more alarm", () => {
  const ok = commit("aaa", "2026-10-01T09:00:00Z", v("success"));
  const q1 = commit("b01", "2026-10-01T10:00:00Z", v("failure", RATE_DESC, { rateLimited: true }));
  const q2 = commit("b02", "2026-10-01T10:10:00Z", v("failure", RATE_DESC, { rateLimited: true }));
  const be = commit("b03", "2026-10-01T10:20:00Z", v("failure", "Build failed"));
  const s1 = decide(null, seen(q1, ok), T("2026-10-01T10:01:00Z"));
  assertEquals(s1.actions.length, 1);
  const s2 = decide(s1.next, seen(q2, q1, ok), T("2026-10-01T10:11:00Z"));
  assertEquals(s2.actions, []);
  const s3 = decide(s2.next, seen(be, q2, q1, ok), T("2026-10-01T10:21:00Z"));
  assertEquals(s3.actions.length, 1);
  const a = s3.actions[0];
  assert(a.type === "alarm");
  assertEquals(a.cls, "build_error");
  assertEquals(a.details.class_changed_from, "quota");
  assertEquals(a.details.lag_commits, 3);
  // and the same build-error commit on the next run: silent
  const s4 = decide(s3.next, seen(be, q2, q1, ok), T("2026-10-01T10:36:00Z"));
  assertEquals(s4.actions, []);
});

Deno.test("no successful build among the scanned commits: lag is 'at least N', from the oldest scanned commit", () => {
  const c = [
    commit("c3", "2026-10-01T10:00:00Z", v("failure", RATE_DESC, { rateLimited: true })),
    commit("c2", "2026-10-01T09:00:00Z", v("failure", RATE_DESC, { rateLimited: true })),
    commit("c1", "2026-10-01T08:00:00Z", v("failure", RATE_DESC, { rateLimited: true })),
  ];
  const obs = observe(c)!;
  assertEquals([obs.liveSha, obs.lagCommits, obs.lagExact, obs.lagSinceAt], [null, 3, false, "2026-10-01T08:00:00Z"]);
  const r = decide(null, { kind: "seen", obs }, T("2026-10-01T10:30:00Z"));
  const a = r.actions[0];
  assert(a.type === "alarm");
  assertStringIncludes(a.text, "at least 3 main commits (150 min); no successful build among the newest scanned commits");
});

// ─────────────────────────── blind: graceful is not silent ───────────────────────────

const blind = (reason: "no_pat" | "forbidden" | "api_error" | "crashed", detail = "x"): WatchInput => ({ kind: "blind", reason, detail });

Deno.test("no PAT: one record-only signal per run (deduped per day by logOnce), never a DM, state stamped", () => {
  const t0 = T("2026-10-01T10:00:00Z");
  const r = decide(null, blind("no_pat", "OPS_GITHUB_PAT is not in Vault"), t0);
  assertEquals(r.next.state, "no_pat");
  assertEquals(r.next.checked_at, "2026-10-01T10:00:00.000Z");
  assertEquals(r.actions.length, 1);
  const a = r.actions[0];
  assert(a.type === "blind");
  assertEquals([a.row, a.dedupeKey, a.dm], ["frontend_deploy_watch_no_pat", "no_pat", null]);
  const later = decide(r.next, blind("no_pat"), t0 + 3 * 86_400_000);
  const b = later.actions[0];
  assert(b.type === "blind");
  assertEquals(b.dm, null);
});

Deno.test("forbidden: DM at once, then at most once per 24 h while it lasts", () => {
  const t0 = T("2026-10-01T10:00:00Z");
  const detail = "status HTTP 403: Resource not accessible by personal access token";
  const r1 = decide(null, blind("forbidden", detail), t0);
  const a1 = r1.actions[0];
  assert(a1.type === "blind");
  assert(a1.dm);
  assertStringIncludes(a1.dm, "'Commit statuses: Read-only'");
  assertStringIncludes(a1.dm, "Resource not accessible by personal access token");
  assertEquals(a1.row, "frontend_deploy_watch_forbidden");
  const r2 = decide(r1.next, blind("forbidden", detail), t0 + 15 * 60_000);
  const a2 = r2.actions[0];
  assert(a2.type === "blind");
  assertEquals(a2.dm, null);
  const r3 = decide(r2.next, blind("forbidden", detail), t0 + BLIND_DM_EVERY_MS);
  const a3 = r3.actions[0];
  assert(a3.type === "blind");
  assert(a3.dm);
  assertEquals(r3.next.blind_since, "2026-10-01T10:00:00.000Z");
  // a 'commits' 403 names Contents too
  const r4 = decide(null, blind("forbidden", "commits HTTP 404: Not Found"), t0);
  const a4 = r4.actions[0];
  assert(a4.type === "blind" && a4.dm);
  assertStringIncludes(a4.dm, "'Contents: Read-only'");
});

Deno.test("api_error: silent DM-wise for blips, one DM after 2 h of continuous blindness", () => {
  const t0 = T("2026-10-01T10:00:00Z");
  let st: WatchState | null = null;
  const dms: number[] = [];
  for (let t = t0; t <= t0 + 3 * 3_600_000; t += 15 * 60_000) {
    const r = decide(st, blind("api_error", "status HTTP 502: Bad Gateway"), t);
    const a = r.actions[0];
    assert(a.type === "blind");
    if (a.dm) dms.push(t);
    st = r.next;
  }
  assertEquals(dms, [t0 + BLIND_DM_AFTER_MS]);
  // one good run resets the streak
  const ok = decide(st, seen(commit("aaa", "2026-10-01T09:00:00Z", v("success"))), t0 + 4 * 3_600_000);
  assertEquals(ok.next.blind_since, null);
});

Deno.test("a blind run keeps an open alarm open; recovery comes once the watchdog can see again", () => {
  const ok = commit("aaa", "2026-10-01T09:00:00Z", v("success"));
  const bad = commit("bbb", "2026-10-01T10:00:00Z", v("failure", RATE_DESC, { rateLimited: true }));
  const s1 = decide(null, seen(bad, ok), T("2026-10-01T10:01:00Z"));
  const s2 = decide(s1.next, blind("api_error"), T("2026-10-01T10:16:00Z"));
  assertEquals([s2.next.alerting, s2.next.alarm_sha, s2.next.sha], [true, "bbb".padEnd(40, "0"), "bbb".padEnd(40, "0")]);
  assertEquals(s2.actions.map((a) => a.type), ["blind"]);
  const good = commit("ccc", "2026-10-01T10:20:00Z", v("success"));
  const s3 = decide(s2.next, seen(good, bad, ok), T("2026-10-01T10:31:00Z"));
  assertEquals(s3.actions.map((a) => a.type), ["recovered"]);
});

// ─────────────────────────── parsing and sanitizing ───────────────────────────

Deno.test("pickVercelStatus: exact context, then a Vercel-prefixed one, absent otherwise; unknown states are pending", () => {
  assertEquals(pickVercelStatus([{ context: "ci", state: "success" }, { context: "Vercel", state: "failure", description: RATE_DESC, target_url: RATE_URL }]), {
    state: "failure",
    description: RATE_DESC,
    targetUrl: "https://vercel.com/akmalidinalimovs-projects",
    rateLimited: true,
  });
  assertEquals(pickVercelStatus([{ context: "Vercel – ai-creator-studio-new", state: "success" }]).state, "success");
  assertEquals(pickVercelStatus([{ context: "ci/build", state: "success" }]).state, "absent");
  assertEquals(pickVercelStatus(null).state, "absent");
  assertEquals(pickVercelStatus([{ context: "Vercel", state: "queued" }]).state, "pending");
  // the rate limit is recognised from the raw URL even when the description says nothing about it
  assertEquals(pickVercelStatus([{ context: "Vercel", state: "failure", description: "Failed", target_url: RATE_URL }]).rateLimited, true);
});

Deno.test("cleanText strips control / bidi characters, collapses whitespace, redacts secrets and caps", () => {
  const nasty = "line1\nline2‮ evil\u0007 Bearer abcdefghijklmnopqrstuvwxyz0123";
  const out = cleanText(nasty, 200);
  assert(!/[\n‮\u0007]/.test(out));
  assert(!out.includes("abcdefghijklmnopqrstuvwxyz0123"));
  assertEquals(cleanText("x".repeat(50), 10), "xxxxxxxxx…");
  assertEquals(cleanText(42, 10), "");
});

Deno.test("cleanVercelUrl keeps only https Vercel links, without query or fragment", () => {
  assertEquals(cleanVercelUrl(RATE_URL), "https://vercel.com/akmalidinalimovs-projects");
  assertEquals(cleanVercelUrl("https://ai-creator.vercel.app/x?y=1#z"), "https://ai-creator.vercel.app/x");
  assertEquals(cleanVercelUrl("http://vercel.com/a"), null);
  assertEquals(cleanVercelUrl("https://evil.example/vercel.com"), null);
  assertEquals(cleanVercelUrl("https://vercel.com.evil.example/"), null);
  assertEquals(cleanVercelUrl("not a url"), null);
});

Deno.test("parseState reads the migration's seed row and rejects garbage", () => {
  const seed = parseState({ checked_at: "2026-10-01T03:00:00+00:00", state: "seeded", alerting: false, seeded_by: "20261001030000" });
  assert(seed);
  assertEquals([seed.state, seed.alerting, seed.alarm_sha, seed.lag], ["seeded", false, null, null]);
  assertEquals(parseState(null), null);
  assertEquals(parseState("x"), null);
  assertEquals(parseState([1]), null);
  const odd = parseState({ state: "weird", alerting: "yes", alarm_class: "nope", blind_since: "not a date" })!;
  assertEquals([odd.state, odd.alerting, odd.alarm_class, odd.blind_since], ["seeded", false, null, null]);
});
