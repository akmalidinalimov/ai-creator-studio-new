// GitHub REST reads for the frontend deploy watchdog (fetch injected, so github.test.ts runs with no network).
//
// Two endpoints, two fine-grained-PAT permissions — named in every failure so the DM says which one is missing:
//   'commits' GET /repos/{repo}/commits?sha=main   → "Contents: Read"   (the ops merge flow already needs Contents)
//   'status'  GET /repos/{repo}/commits/{sha}/status → "Commit statuses: Read" (NOT needed by anything before this)
// 401 / 403 / 404 are 'forbidden' (GitHub answers 404 for a private repo the token cannot see); a 403 or 429 that is
// GitHub's rate limit, a 5xx, a timeout, a network error or a malformed body are 'api_error'. The token travels only
// in the Authorization header: never in a URL, a return value or a recorded message.

import { redactSecrets } from "../_shared/redact.ts";
import { type MainCommit, pickVercelStatus, REPO, type VercelStatus } from "./watch.ts";

export type FetchFn = typeof fetch;
export type Endpoint = "commits" | "status";
export type GhFail = { ok: false; reason: "forbidden" | "api_error"; status: number; endpoint: Endpoint; message: string };
export type GhOk<T> = { ok: true; data: T };

export const CALL_TIMEOUT_MS = 8_000;

function headers(token: string): Record<string, string> {
  return {
    "Authorization": `Bearer ${token}`,
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "ai-creators-frontend-deploy-watchdog", // GitHub 403s requests without a User-Agent
  };
}

/** "status HTTP 403: Resource not accessible by personal access token" — the human-readable blind detail. */
export function failDetail(f: GhFail): string {
  return `${f.endpoint} HTTP ${f.status || "-"}: ${f.message || "(no message)"}`;
}

async function ghGet(fetchFn: FetchFn, token: string, url: string, endpoint: Endpoint): Promise<GhOk<unknown> | GhFail> {
  const fail = (reason: GhFail["reason"], status: number, message: string): GhFail => ({
    ok: false,
    reason,
    status,
    endpoint,
    message: redactSecrets(message).replace(/\s+/g, " ").slice(0, 160),
  });
  let resp: Response;
  try {
    resp = await fetchFn(url, { headers: headers(token), signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
  } catch (e) {
    return fail("api_error", 0, e instanceof Error ? `${e.name}: ${e.message}` : String(e));
  }
  if (resp.ok) {
    try {
      return { ok: true, data: await resp.json() };
    } catch {
      return fail("api_error", resp.status, "malformed JSON body");
    }
  }
  let message = "";
  try {
    // deno-lint-ignore no-explicit-any
    const j: any = await resp.json();
    message = typeof j?.message === "string" ? j.message : "";
  } catch { /* no body */ }
  const rateLimited = resp.status === 429 ||
    (resp.status === 403 && (resp.headers.get("x-ratelimit-remaining") === "0" || /rate limit/i.test(message)));
  if (rateLimited) return fail("api_error", resp.status, message || "rate limited");
  if (resp.status === 401 || resp.status === 403 || resp.status === 404) return fail("forbidden", resp.status, message);
  return fail("api_error", resp.status, message);
}

const SHA_RE = /^[0-9a-f]{40}$/;

/** The newest `n` commits on main, newest first. An empty or malformed list is an api_error (never "all fine"). */
export async function fetchMainCommits(fetchFn: FetchFn, token: string, n: number): Promise<GhOk<MainCommit[]> | GhFail> {
  const r = await ghGet(fetchFn, token, `https://api.github.com/repos/${REPO}/commits?sha=main&per_page=${n}`, "commits");
  if (!r.ok) return r;
  const list = Array.isArray(r.data) ? r.data : [];
  const out: MainCommit[] = [];
  // deno-lint-ignore no-explicit-any
  for (const c of list as any[]) {
    const sha = typeof c?.sha === "string" ? c.sha.toLowerCase() : "";
    if (!SHA_RE.test(sha)) continue;
    const message = typeof c?.commit?.message === "string" ? c.commit.message : "";
    const committedAt = c?.commit?.committer?.date ?? c?.commit?.author?.date ?? "";
    out.push({ sha, subject: message.split("\n")[0] ?? "", committedAt: typeof committedAt === "string" ? committedAt : "" });
  }
  if (!out.length) {
    return { ok: false, reason: "api_error", status: 200, endpoint: "commits", message: "no commits in the response" };
  }
  return { ok: true, data: out };
}

/** The Vercel status of one commit, from the combined status (latest status per context). */
export async function fetchVercelStatus(fetchFn: FetchFn, token: string, sha: string): Promise<GhOk<VercelStatus> | GhFail> {
  const r = await ghGet(fetchFn, token, `https://api.github.com/repos/${REPO}/commits/${sha}/status?per_page=100`, "status");
  if (!r.ok) return r;
  // deno-lint-ignore no-explicit-any
  return { ok: true, data: pickVercelStatus((r.data as any)?.statuses) };
}
