// Unit tests for one watchdog run (run.ts) and the GitHub reads (github.ts), over a fake GitHub (an injected fetch
// that routes by URL) and recording fakes for the database and Telegram. No network, no database.
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { GATHER_BUDGET_MS, type RunDeps, runWatch } from "./run.ts";
import { parseState, REPO, type WatchState } from "./watch.ts";

const TOKEN = "placeholder-token-for-tests"; // a marker string, asserted never to reach a log, a DM or a URL
const RATE_DESC = "Deployment rate limited — retry in 24 hours.";
const RATE_URL = "https://vercel.com/akmalidinalimovs-projects?upgradeToPro=build-rate-limit";

const SHAS = {
  b575fce: "b575fce55b7ea3c8e4d18b5a78705b39809c12f2",
  a92bfcd: "a92bfcda5f167a8ca7ecd6cb58214d027530aaed",
  "21b8cdc": "21b8cdcfda9dc9294c8b5b98538e97187b10a308",
  "148fe16": "148fe169ad3de8eca27baea13c9e2ec03ac54f77",
  afe750e: "afe750e3375a60a307ead15c2bf27e12e0f37332",
};
const COMMITS = [
  { sha: SHAS.b575fce, date: "2026-09-30T20:07:25Z", msg: "feat(challenge): Kunlik vazifalar in the Mini App (#244)\n\nbody" },
  { sha: SHAS.a92bfcd, date: "2026-09-30T19:59:18Z", msg: "feat(challenge): daily-tasks worker (#243)" },
  { sha: SHAS["21b8cdc"], date: "2026-09-30T19:55:34Z", msg: "feat(challenge): AI checks for daily tasks (#242)" },
  { sha: SHAS["148fe16"], date: "2026-09-30T19:54:50Z", msg: "feat(challenge): daily-tasks bot (#241)" },
  { sha: SHAS.afe750e, date: "2026-09-30T17:26:37Z", msg: "feat(challenge): daily-tasks SQL engine (#232)" },
  { sha: "03d22fd0a1b5650291663bc7c043124a95d4a4db", date: "2026-09-30T17:22:39Z", msg: "older (#228)" },
];
const failure = { context: "Vercel", state: "failure", description: RATE_DESC, target_url: RATE_URL };
const success = { context: "Vercel", state: "success", description: "Deployment has completed", target_url: "https://vercel.com/x/y/Z" };

type Route = { status: number; body: unknown; headers?: Record<string, string> } | "throw";
type Req = { url: string; auth: string | null; ua: string | null };

function fakeGithub(statusFor: (sha: string) => Route, commitsRoute?: Route) {
  const reqs: Req[] = [];
  const fetchFn = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const h = new Headers(init?.headers);
    reqs.push({ url, auth: h.get("authorization"), ua: h.get("user-agent") });
    let route: Route;
    const m = /\/commits\/([0-9a-f]{40})\/status/.exec(url);
    if (m) route = statusFor(m[1]);
    else if (url.includes(`/repos/${REPO}/commits?sha=main`)) {
      route = commitsRoute ?? {
        status: 200,
        body: COMMITS.map((c) => ({ sha: c.sha, commit: { message: c.msg, committer: { date: c.date }, author: { date: c.date } } })),
      };
    } else route = { status: 404, body: { message: "Not Found" } };
    if (route === "throw") return Promise.reject(new TypeError("error sending request: connection reset"));
    return Promise.resolve(new Response(JSON.stringify(route.body), { status: route.status, headers: route.headers }));
  }) as typeof fetch;
  return { fetchFn, reqs };
}

type Logged = { action: string; key?: string; details: Record<string, unknown> };

function fakeDeps(opts: {
  pat?: string | null;
  patError?: string | null;
  fetchFn: typeof fetch;
  state?: WatchState | null;
  now?: () => number;
  stateWriteFails?: boolean;
  /** Who adminChatIds() returns, read on every call (default [111, 222]). [] is what prod returned before the fix. */
  recipients?: () => number[];
  /** Whether Telegram accepts a send (default: always). */
  sendOk?: (chatId: number) => boolean;
  adminChatIdsThrows?: () => boolean;
}) {
  const logs: Logged[] = [];
  const dms: { chatId: number; text: string }[] = [];
  const store: { state: WatchState | null } = { state: opts.state ?? null };
  const loggedShas = new Set<string>();
  const once = new Set<string>();
  const deps: RunDeps = {
    now: opts.now ?? (() => Date.parse("2026-10-01T02:52:00Z")),
    getPat: () => Promise.resolve({ pat: opts.pat === undefined ? TOKEN : opts.pat, error: opts.patError ?? null }),
    fetchFn: opts.fetchFn,
    readState: () => Promise.resolve(store.state ? JSON.parse(JSON.stringify(store.state)) : null),
    writeState: (s) => {
      if (opts.stateWriteFails) return Promise.resolve(false);
      store.state = parseState(JSON.parse(JSON.stringify(s)));
      return Promise.resolve(true);
    },
    alreadyLogged: (action, sha) => Promise.resolve(loggedShas.has(`${action}|${sha}`)),
    log: (action, details) => {
      logs.push({ action, details });
      if (typeof details.sha === "string") loggedShas.add(`${action}|${details.sha}`);
      return Promise.resolve(true);
    },
    logOnce: (action, key, details) => {
      if (once.has(`${action}|${key}`)) return Promise.resolve(false);
      once.add(`${action}|${key}`);
      logs.push({ action, key, details });
      return Promise.resolve(true);
    },
    adminChatIds: () => {
      if (opts.adminChatIdsThrows?.()) return Promise.reject(new Error("recipient lookup exploded"));
      return Promise.resolve(opts.recipients ? opts.recipients() : [111, 222]);
    },
    send: (chatId, text) => {
      const ok = opts.sendOk ? opts.sendOk(chatId) : true;
      if (ok) dms.push({ chatId, text });
      return Promise.resolve(ok);
    },
  };
  return { deps, logs, dms, store };
}

const noSecretIn = (x: unknown) => assert(!JSON.stringify(x).includes(TOKEN), "the PAT leaked into a log, a DM or the state");

Deno.test("inert without a PAT: records no_pat, stamps the state, calls nothing else", async () => {
  const gh = fakeGithub(() => ({ status: 200, body: { statuses: [] } }));
  const f = fakeDeps({ pat: null, fetchFn: gh.fetchFn });
  const out = await runWatch(f.deps);
  assertEquals(gh.reqs, []);
  assertEquals(f.dms, []);
  assertEquals(f.logs.map((l) => [l.action, l.key]), [["frontend_deploy_watch_no_pat", "no_pat"]]);
  assertEquals(out.state, "no_pat");
  assertEquals(out.state_written, true);
  assertEquals(f.store.state?.checked_at, "2026-10-01T02:52:00.000Z");
});

Deno.test("a failing ops_github_pat() RPC is api_error, not 'no PAT'", async () => {
  const gh = fakeGithub(() => ({ status: 200, body: { statuses: [] } }));
  const f = fakeDeps({ pat: null, patError: "permission denied", fetchFn: gh.fetchFn });
  const out = await runWatch(f.deps);
  assertEquals(out.state, "api_error");
  assertEquals(f.logs[0].action, "frontend_deploy_watch_api_error");
});

Deno.test("the real incident through the runner: one alarm with DMs, no repeat on the next run, the PAT never leaks", async () => {
  const gh = fakeGithub((sha) => ({ status: 200, body: { statuses: [sha === SHAS.afe750e ? success : failure] } }));
  const f = fakeDeps({ fetchFn: gh.fetchFn });
  const out1 = await runWatch(f.deps);
  assertEquals(out1.state, "failed");
  assertEquals(out1.lag, { commits: 4, exact: true, minutes: 417 }); // 19:54:50 → 02:52
  assertEquals(out1.actions, ["frontend_deploy_failed+dm(2/2)"]);
  // 1 list + statuses for b575fce, a92bfcd, 21b8cdc, 148fe16, afe750e (stops at the first success)
  assertEquals(gh.reqs.length, 6);
  for (const r of gh.reqs) {
    assertEquals(r.auth, `Bearer ${TOKEN}`);
    assert(r.ua);
    assert(!r.url.includes(TOKEN));
  }
  assertEquals(f.dms.map((d) => d.chatId), [111, 222]);
  assertStringIncludes(f.dms[0].text, "Commit: b575fce — feat(challenge): Kunlik vazifalar in the Mini App (#244)");
  assertStringIncludes(f.dms[0].text, "lags main by 4 main commits (417 min); live build = afe750e");
  const row = f.logs.find((l) => l.action === "frontend_deploy_failed")!;
  assertEquals([row.details.sha, row.details.class, row.details.dm_sent, row.details.dm_attempted], [SHAS.b575fce, "quota", 2, 2]);
  noSecretIn(f.logs);
  noSecretIn(f.dms);
  noSecretIn(f.store.state);

  const out2 = await runWatch(f.deps);
  assertEquals(out2.actions, []);
  assertEquals(f.dms.length, 2);
});

Deno.test("a state row that cannot be written cannot turn one alarm into a DM every run (DB dedupe per sha)", async () => {
  const gh = fakeGithub((sha) => ({ status: 200, body: { statuses: [sha === SHAS.afe750e ? success : failure] } }));
  const f = fakeDeps({ fetchFn: gh.fetchFn, stateWriteFails: true });
  const out1 = await runWatch(f.deps);
  assertEquals(out1.state_written, false);
  assertEquals(out1.actions, ["frontend_deploy_failed+dm(2/2)"]);
  const out2 = await runWatch(f.deps);
  assertEquals(out2.actions, ["frontend_deploy_failed:deduped"]);
  assertEquals(f.dms.length, 2);
  assert(f.logs.some((l) => l.action === "frontend_deploy_watch_state_write_failed"));
});

Deno.test("recovery: the next run after a successful main build DMs once", async () => {
  let healed = false;
  const gh = fakeGithub((sha) => ({
    status: 200,
    body: { statuses: [sha === SHAS.afe750e || (healed && sha === SHAS.b575fce) ? success : failure] },
  }));
  const f = fakeDeps({ fetchFn: gh.fetchFn });
  await runWatch(f.deps);
  healed = true;
  const out = await runWatch(f.deps);
  assertEquals(out.state, "ok");
  assertEquals(out.actions, ["frontend_deploy_recovered+dm(2/2)"]);
  assertStringIncludes(f.dms[2].text, "recovered");
  assertEquals(f.store.state?.alerting, false);
  const again = await runWatch(f.deps);
  assertEquals(again.actions, []);
});

Deno.test("403 on the status endpoint: forbidden, the missing permission named, one DM, a once-a-day row", async () => {
  const gh = fakeGithub(() => ({ status: 403, body: { message: "Resource not accessible by personal access token" } }));
  const f = fakeDeps({ fetchFn: gh.fetchFn });
  const out = await runWatch(f.deps);
  assertEquals(out.state, "forbidden");
  assertEquals(out.actions, ["frontend_deploy_watch_forbidden+dm(2/2)"]);
  assertStringIncludes(f.dms[0].text, "status HTTP 403: Resource not accessible by personal access token");
  assertStringIncludes(f.dms[0].text, "'Commit statuses: Read-only'");
  const out2 = await runWatch(f.deps);
  assertEquals(out2.actions, ["frontend_deploy_watch_forbidden"]); // no second DM within 24 h
  assertEquals(f.logs.filter((l) => l.action === "frontend_deploy_watch_forbidden").length, 1);
  noSecretIn(f.dms);
});

Deno.test("404 on the commit list (the token cannot see the repo) is forbidden too", async () => {
  const gh = fakeGithub(() => ({ status: 200, body: {} }), { status: 404, body: { message: "Not Found" } });
  const f = fakeDeps({ fetchFn: gh.fetchFn });
  const out = await runWatch(f.deps);
  assertEquals(out.state, "forbidden");
  assertStringIncludes(f.dms[0].text, "commits HTTP 404: Not Found");
  assertStringIncludes(f.dms[0].text, "'Contents: Read-only'");
});

Deno.test("GitHub's rate limit (403 + x-ratelimit-remaining: 0), a 5xx or a network error is api_error, no immediate DM", async () => {
  const cases: Route[] = [
    { status: 403, body: { message: "API rate limit exceeded" }, headers: { "x-ratelimit-remaining": "0" } },
    { status: 502, body: { message: "Bad Gateway" } },
    "throw",
  ];
  for (const route of cases) {
    const gh = fakeGithub(() => route);
    const f = fakeDeps({ fetchFn: gh.fetchFn });
    const out = await runWatch(f.deps);
    assertEquals(out.state, "api_error");
    assertEquals(f.dms, []);
    assertEquals(f.logs[0].action, "frontend_deploy_watch_api_error");
  }
});

Deno.test("past the time budget the walk stops: the head is judged, the lag is 'at least N'", async () => {
  let t = Date.parse("2026-10-01T02:52:00Z");
  const gh = fakeGithub((sha) => {
    t += GATHER_BUDGET_MS + 1; // every status call "takes" more than the whole budget
    return { status: 200, body: { statuses: [sha === SHAS.afe750e ? success : failure] } };
  });
  const f = fakeDeps({ fetchFn: gh.fetchFn, now: () => t });
  const out = await runWatch(f.deps);
  assertEquals(out.state, "failed");
  assertEquals(out.lag?.exact, false);
  assertEquals(gh.reqs.length, 2); // list + head; the budget check stops the walk before the next commit
});

Deno.test("a malformed commit list is api_error, never 'all fine'", async () => {
  const gh = fakeGithub(() => ({ status: 200, body: {} }), { status: 200, body: { not: "a list" } });
  const f = fakeDeps({ fetchFn: gh.fetchFn });
  const out = await runWatch(f.deps);
  assertEquals(out.state, "api_error");
});

// ─────────────── undelivered DMs (review fix: prod's recipient query returned [] on every call) ───────────────

const rows = (logs: Logged[], action: string) => logs.filter((l) => l.action === action);

Deno.test("the real incident with ZERO recipients (what prod's embed query returned): loud row, DM kept, delivered late once admins resolve", async () => {
  let recipients: number[] = [];
  let now = Date.parse("2026-10-01T02:52:00Z");
  const gh = fakeGithub((sha) => ({ status: 200, body: { statuses: [sha === SHAS.afe750e ? success : failure] } }));
  const f = fakeDeps({ fetchFn: gh.fetchFn, recipients: () => recipients, now: () => now });

  const r1 = await runWatch(f.deps);
  assertEquals(r1.actions, ["frontend_deploy_failed+dm(0/0)"]);
  assertEquals(r1.dm_pending, "frontend_deploy_failed");
  assertEquals(f.dms, []);
  const alarm = rows(f.logs, "frontend_deploy_failed");
  assertEquals(alarm.length, 1);
  assertEquals([alarm[0].details.dm_attempted, alarm[0].details.dm_sent], [0, 0]);
  const loud = rows(f.logs, "frontend_deploy_failed_dm_undelivered");
  assertEquals(loud.length, 1);
  assertEquals([loud[0].key, loud[0].details.attempted], [SHAS.b575fce, 0]);
  assertEquals(f.store.state?.alerting, true); // the incident is open; only its DM is outstanding
  assertEquals(f.store.state?.pending_dm?.attempts, 1);

  now += 15 * 60_000; // 03:07 — not due yet (re-sent every 30 min)
  const r2 = await runWatch(f.deps);
  assertEquals(r2.actions, []);
  assertEquals(r2.dm_pending, "frontend_deploy_failed");

  recipients = [111, 222]; // the lookup works again (this PR's fix deployed)
  now += 15 * 60_000; // 03:22
  const r3 = await runWatch(f.deps);
  assertEquals(r3.actions, ["frontend_deploy_failed:retry+dm(2/2)"]);
  assertEquals(r3.dm_pending, null);
  assertEquals(f.dms.map((d) => d.chatId), [111, 222]);
  assertStringIncludes(f.dms[0].text, "(Delivered late: first raised 2026-10-01 02:52 UTC, when it reached no admin. Attempt 2.)");
  assertStringIncludes(f.dms[0].text, "Commit: b575fce — feat(challenge): Kunlik vazifalar in the Mini App (#244)");
  const late = rows(f.logs, "frontend_deploy_failed_dm_delivered_late");
  assertEquals(late.length, 1);
  assertEquals([late[0].details.ref, late[0].details.attempt, late[0].details.dm_sent], [SHAS.b575fce, 2, 2]);
  assertEquals(rows(f.logs, "frontend_deploy_failed").length, 1); // still one alarm row for the incident

  now += 15 * 60_000;
  const r4 = await runWatch(f.deps);
  assertEquals(r4.actions, []);
  assertEquals(f.dms.length, 2);
  noSecretIn(f.logs);
  noSecretIn(f.store.state);
});

Deno.test("recipients stay empty: re-sent every 30 min, ONE undelivered row a day, and the recovery supersedes the stale alarm", async () => {
  let recipients: number[] = [];
  let healed = false;
  let now = Date.parse("2026-10-01T02:52:00Z");
  const gh = fakeGithub((sha) => ({
    status: 200,
    body: { statuses: [sha === SHAS.afe750e || (healed && sha === SHAS.b575fce) ? success : failure] },
  }));
  const f = fakeDeps({ fetchFn: gh.fetchFn, recipients: () => recipients, now: () => now });

  await runWatch(f.deps); // 02:52 alarm → undelivered
  for (let i = 0; i < 4; i++) {
    now += 15 * 60_000;
    await runWatch(f.deps); // 03:07 nothing, 03:22 retry, 03:37 nothing, 03:52 retry
  }
  assertEquals(f.store.state?.pending_dm?.attempts, 3);
  assertEquals(rows(f.logs, "frontend_deploy_failed_dm_undelivered").length, 1); // once a Tashkent day, not per try
  assertEquals(f.dms, []);

  healed = true;
  recipients = [111];
  now += 15 * 60_000;
  const r = await runWatch(f.deps);
  assertEquals(r.state, "ok");
  assertEquals(r.actions, ["frontend_deploy_recovered+dm(1/1)"]); // no late "FAILED" DM after the site is back
  assertEquals(r.dm_pending, null);
  assertEquals(f.dms.length, 1);
  assertStringIncludes(f.dms[0].text, "recovered");
});

Deno.test("Telegram refuses every admin (send fails): undelivered too, re-sent until one gets it", async () => {
  let telegramUp = false;
  let now = Date.parse("2026-10-01T02:52:00Z");
  const gh = fakeGithub((sha) => ({ status: 200, body: { statuses: [sha === SHAS.afe750e ? success : failure] } }));
  const f = fakeDeps({ fetchFn: gh.fetchFn, sendOk: (id) => telegramUp && id === 222, now: () => now });
  const r1 = await runWatch(f.deps);
  assertEquals(r1.actions, ["frontend_deploy_failed+dm(0/2)"]);
  assertEquals(rows(f.logs, "frontend_deploy_failed_dm_undelivered")[0].details.attempted, 2);
  telegramUp = true;
  now += 30 * 60_000;
  const r2 = await runWatch(f.deps);
  assertEquals(r2.actions, ["frontend_deploy_failed:retry+dm(1/2)"]); // one admin is enough
  assertEquals(r2.dm_pending, null);
});

Deno.test("an alarm whose DM step throws is kept as undelivered and re-sent, never silently latched", async () => {
  let explode = true;
  let now = Date.parse("2026-10-01T02:52:00Z");
  const gh = fakeGithub((sha) => ({ status: 200, body: { statuses: [sha === SHAS.afe750e ? success : failure] } }));
  const f = fakeDeps({ fetchFn: gh.fetchFn, adminChatIdsThrows: () => explode, now: () => now });
  const r1 = await runWatch(f.deps);
  assertEquals(r1.actions, ["frontend_deploy_failed:error"]);
  assertEquals(r1.dm_pending, "frontend_deploy_failed");
  assertEquals(rows(f.logs, "frontend_deploy_watch_crashed").length, 1);
  explode = false;
  now += 30 * 60_000;
  const r2 = await runWatch(f.deps);
  assertEquals(r2.actions, ["frontend_deploy_failed:retry+dm(2/2)"]);
  assertEquals(f.dms.length, 2);
});

Deno.test("a forbidden (blind) DM that reaches nobody is re-sent until delivered", async () => {
  let recipients: number[] = [];
  let now = Date.parse("2026-10-01T02:52:00Z");
  const gh = fakeGithub(() => ({ status: 403, body: { message: "Resource not accessible by personal access token" } }));
  const f = fakeDeps({ fetchFn: gh.fetchFn, recipients: () => recipients, now: () => now });
  const r1 = await runWatch(f.deps);
  assertEquals(r1.actions, ["frontend_deploy_watch_forbidden+dm(0/0)"]);
  assertEquals(r1.dm_pending, "frontend_deploy_watch_forbidden");
  assertEquals(rows(f.logs, "frontend_deploy_watch_forbidden_dm_undelivered").length, 1);
  recipients = [111];
  now += 30 * 60_000;
  const r2 = await runWatch(f.deps);
  assertEquals(r2.actions, ["frontend_deploy_watch_forbidden", "frontend_deploy_watch_forbidden:retry+dm(1/1)"]);
  assertStringIncludes(f.dms[0].text, "Delivered late");
  assertStringIncludes(f.dms[0].text, "'Commit statuses: Read-only'");
  assertEquals(r2.dm_pending, null);
  now += 30 * 60_000;
  const r3 = await runWatch(f.deps);
  assertEquals(r3.actions, ["frontend_deploy_watch_forbidden"]); // record-only again; the next DM is 24 h after the first
  assertEquals(f.dms.length, 1);
});
