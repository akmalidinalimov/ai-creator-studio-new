// Unit tests for the security-critical approve-flow logic (autonomous-ops Phase 2).
// checksAllGreen() is the actual merge gate (no server-side branch protection on Free plan),
// so its rules are tested exhaustively. Pure logic — no network.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  checksAllGreen,
  parseOpsCallback,
  REQUIRED_CHECKS,
  verifyOpsPr,
  type CheckRun,
  type PrInfo,
} from "./ops-approve.ts";

// ---- parseOpsCallback ----

Deno.test("parseOpsCallback: valid forms", () => {
  assertEquals(parseOpsCallback("ops:a:13"), { kind: "ask", pr: 13 });
  assertEquals(parseOpsCallback("ops:c:7"), { kind: "confirm", pr: 7 });
  assertEquals(parseOpsCallback("ops:x:123456"), { kind: "cancel", pr: 123456 });
  assertEquals(parseOpsCallback("ops:reject:42"), { kind: "reject", pr: 42 });
});

Deno.test("parseOpsCallback: rejects malformed/forged data", () => {
  assertEquals(parseOpsCallback("ops:merge:13"), null);
  assertEquals(parseOpsCallback("ops:a:"), null);
  assertEquals(parseOpsCallback("ops:a:13x"), null);
  assertEquals(parseOpsCallback("ops:a:1234567"), null); // > 6 digits
  assertEquals(parseOpsCallback("ops:a:-1"), null);
  assertEquals(parseOpsCallback("opsx:a:13"), null);
  assertEquals(parseOpsCallback(""), null);
});

// ---- verifyOpsPr ----

const goodPr: PrInfo = {
  number: 13,
  state: "open",
  title: "test",
  headRef: "ops/test-approve",
  headSha: "abc123",
  headRepoFullName: "akmalidinalimov/ai-creator-studio-new",
  baseRepoFullName: "akmalidinalimov/ai-creator-studio-new",
  labels: ["ops-agent"],
  changedMigration: false,
  changedWorkflows: false,
};

Deno.test("verifyOpsPr: accepts a well-formed ops PR", () => {
  assertEquals(verifyOpsPr(goodPr), { ok: true });
});

Deno.test("verifyOpsPr: rejects closed PR", () => {
  assertEquals(verifyOpsPr({ ...goodPr, state: "closed" }).reason, "pr_not_open");
});

Deno.test("verifyOpsPr: rejects missing ops-agent label", () => {
  assertEquals(verifyOpsPr({ ...goodPr, labels: ["bug"] }).reason, "missing_ops_label");
});

Deno.test("verifyOpsPr: rejects fork heads", () => {
  assertEquals(verifyOpsPr({ ...goodPr, headRepoFullName: "attacker/fork" }).reason, "fork_head");
});

Deno.test("verifyOpsPr: rejects non-ops branches", () => {
  assertEquals(verifyOpsPr({ ...goodPr, headRef: "feat/anything" }).reason, "branch_not_ops");
});

Deno.test("verifyOpsPr: rejects PRs touching .github (agent must never modify its own pipeline)", () => {
  assertEquals(verifyOpsPr({ ...goodPr, changedWorkflows: true }).reason, "touches_workflows");
});

// ---- checksAllGreen ----

const green = (name: string): CheckRun => ({ name, status: "completed", conclusion: "success" });

Deno.test("checksAllGreen: all required green", () => {
  assertEquals(checksAllGreen(REQUIRED_CHECKS.map(green)), { ok: true });
});

Deno.test("checksAllGreen: a required check missing", () => {
  const runs = [green(REQUIRED_CHECKS[0])];
  assertEquals(checksAllGreen(runs).ok, false);
});

Deno.test("checksAllGreen: pending check is not green", () => {
  const runs: CheckRun[] = [
    green(REQUIRED_CHECKS[0]),
    { name: REQUIRED_CHECKS[1], status: "in_progress", conclusion: null },
  ];
  assertEquals(checksAllGreen(runs).ok, false);
});

Deno.test("checksAllGreen: failed check is not green", () => {
  const runs: CheckRun[] = [
    green(REQUIRED_CHECKS[0]),
    { name: REQUIRED_CHECKS[1], status: "completed", conclusion: "failure" },
  ];
  assertEquals(checksAllGreen(runs).ok, false);
});

Deno.test("checksAllGreen: re-run success after earlier failure counts", () => {
  const runs: CheckRun[] = [
    { name: REQUIRED_CHECKS[0], status: "completed", conclusion: "failure" },
    green(REQUIRED_CHECKS[0]),
    green(REQUIRED_CHECKS[1]),
  ];
  assertEquals(checksAllGreen(runs), { ok: true });
});

Deno.test("checksAllGreen: unrelated extra checks are ignored", () => {
  const runs: CheckRun[] = [...REQUIRED_CHECKS.map(green), { name: "Vercel", status: "completed", conclusion: "neutral" }];
  assertEquals(checksAllGreen(runs), { ok: true });
});
