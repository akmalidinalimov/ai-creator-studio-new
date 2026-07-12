// Pure logic for the Telegram → GitHub PR approve flow (autonomous-ops Phase 2).
// No imports, no I/O — fully unit-testable (ops-approve.test.ts). The webhook wires it to the
// real GitHub API with the Vault PAT. Server-side branch protection needs GitHub Pro (repo is
// private/Free), so checksAllGreen() IS the merge gate — treat its rules as security-critical.

export const OPS_REPO = "akmalidinalimov/ai-creator-studio-new";

// The two CI check names that must be green before any ops merge (from ci.yml job names).
export const REQUIRED_CHECKS = [
  "Web (typecheck · test · config · build)",
  "Edge functions (Deno tests)",
];

export type OpsCallback = { kind: "ask" | "confirm" | "cancel" | "reject"; pr: number };

// ops:a:<n> = show confirm | ops:c:<n> = confirmed merge | ops:x:<n> = cancel | ops:reject:<n> = close PR
export function parseOpsCallback(data: string): OpsCallback | null {
  const m = /^ops:(a|c|x|reject):(\d{1,6})$/.exec(data);
  if (!m) return null;
  const kind = m[1] === "a" ? "ask" : m[1] === "c" ? "confirm" : m[1] === "x" ? "cancel" : "reject";
  return { kind, pr: Number(m[2]) };
}

export type PrInfo = {
  number: number;
  state: string;                 // "open" | "closed"
  title: string;
  headRef: string;               // branch name
  headSha: string;
  headRepoFullName: string;
  baseRepoFullName: string;
  labels: string[];
  changedMigration: boolean;     // any file under supabase/migrations/
  changedWorkflows: boolean;     // any file under .github/
};

// Verification rules — ALL must pass before a merge is even offered.
export function verifyOpsPr(pr: PrInfo): { ok: boolean; reason?: string } {
  if (pr.state !== "open") return { ok: false, reason: "pr_not_open" };
  if (!pr.labels.includes("ops-agent")) return { ok: false, reason: "missing_ops_label" };
  if (pr.headRepoFullName !== pr.baseRepoFullName) return { ok: false, reason: "fork_head" };
  if (!pr.headRef.startsWith("ops/")) return { ok: false, reason: "branch_not_ops" };
  if (pr.changedWorkflows) return { ok: false, reason: "touches_workflows" };
  return { ok: true };
}

export type CheckRun = { name: string; status: string; conclusion: string | null };

// Merge gate: every required check must exist, be completed, and have succeeded.
// (Check-runs can appear multiple times after re-runs — the LAST occurrence in the API response
// is the newest attempt; we accept if ANY completed+success run exists for the name, matching
// GitHub's own "latest check run per name" semantics from the check-runs endpoint.)
export function checksAllGreen(runs: CheckRun[], required: string[] = REQUIRED_CHECKS): { ok: boolean; reason?: string } {
  for (const name of required) {
    const matches = runs.filter((r) => r.name === name);
    if (!matches.length) return { ok: false, reason: `check_missing:${name}` };
    const green = matches.some((r) => r.status === "completed" && r.conclusion === "success");
    if (!green) return { ok: false, reason: `check_not_green:${name}` };
  }
  return { ok: true };
}

// ---- GitHub API helpers (fetch injected for testability; caller passes the Vault PAT) ----

type FetchFn = typeof fetch;

function ghHeaders(token: string): Record<string, string> {
  return {
    "Authorization": `Bearer ${token}`,
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "ai-creators-ops-bot", // GitHub 403s requests without a User-Agent
    "Content-Type": "application/json",
  };
}

export async function ghFetchPr(fetchFn: FetchFn, token: string, prNumber: number, repo = OPS_REPO): Promise<PrInfo | null> {
  const prResp = await fetchFn(`https://api.github.com/repos/${repo}/pulls/${prNumber}`, { headers: ghHeaders(token) });
  if (!prResp.ok) return null;
  const pr: any = await prResp.json();
  const filesResp = await fetchFn(`https://api.github.com/repos/${repo}/pulls/${prNumber}/files?per_page=100`, { headers: ghHeaders(token) });
  const files: any[] = filesResp.ok ? await filesResp.json() : [];
  const paths = files.map((f: any) => String(f.filename || ""));
  return {
    number: pr.number,
    state: pr.state,
    title: pr.title || "",
    headRef: pr.head?.ref || "",
    headSha: pr.head?.sha || "",
    headRepoFullName: pr.head?.repo?.full_name || "",
    baseRepoFullName: pr.base?.repo?.full_name || "",
    labels: (pr.labels || []).map((l: any) => String(l.name)),
    changedMigration: paths.some((p) => p.startsWith("supabase/migrations/")),
    changedWorkflows: paths.some((p) => p.startsWith(".github/")),
  };
}

// CI state comes from the Actions API (workflow runs + per-run jobs), NOT the check-runs API:
// fine-grained PATs need the "Checks" permission for check-runs, and GitHub's PAT UI no longer
// offers it (verified live 2026-07-12 — the Add-permissions list has no Checks entry). Job names
// equal check-run names, so checksAllGreen() semantics are unchanged. PAT needs "Actions: read".
export async function ghFetchChecks(fetchFn: FetchFn, token: string, sha: string, repo = OPS_REPO): Promise<CheckRun[]> {
  const runsResp = await fetchFn(`https://api.github.com/repos/${repo}/actions/runs?head_sha=${sha}&per_page=50`, { headers: ghHeaders(token) });
  if (!runsResp.ok) return [];
  const runsBody: any = await runsResp.json();
  const out: CheckRun[] = [];
  for (const run of runsBody.workflow_runs || []) {
    const jobsResp = await fetchFn(`https://api.github.com/repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`, { headers: ghHeaders(token) });
    if (!jobsResp.ok) continue;
    const jobsBody: any = await jobsResp.json();
    for (const j of jobsBody.jobs || []) {
      out.push({ name: String(j.name), status: String(j.status), conclusion: j.conclusion ?? null });
    }
  }
  return out;
}

export async function ghAddLabel(fetchFn: FetchFn, token: string, prNumber: number, label: string, repo = OPS_REPO): Promise<boolean> {
  const resp = await fetchFn(`https://api.github.com/repos/${repo}/issues/${prNumber}/labels`, {
    method: "POST", headers: ghHeaders(token), body: JSON.stringify({ labels: [label] }),
  });
  return resp.ok;
}

export async function ghMergePr(fetchFn: FetchFn, token: string, prNumber: number, repo = OPS_REPO): Promise<{ ok: boolean; message?: string }> {
  const resp = await fetchFn(`https://api.github.com/repos/${repo}/pulls/${prNumber}/merge`, {
    method: "PUT", headers: ghHeaders(token), body: JSON.stringify({ merge_method: "squash" }),
  });
  const body: any = await resp.json().catch(() => ({}));
  return { ok: resp.ok, message: body?.message };
}

export async function ghClosePr(fetchFn: FetchFn, token: string, prNumber: number, headRef: string, repo = OPS_REPO): Promise<boolean> {
  const resp = await fetchFn(`https://api.github.com/repos/${repo}/pulls/${prNumber}`, {
    method: "PATCH", headers: ghHeaders(token), body: JSON.stringify({ state: "closed" }),
  });
  if (resp.ok && headRef.startsWith("ops/")) {
    // best-effort branch cleanup; never fail the close over it
    await fetchFn(`https://api.github.com/repos/${repo}/git/refs/heads/${headRef}`, {
      method: "DELETE", headers: ghHeaders(token),
    }).catch(() => null);
  }
  return resp.ok;
}
