// PreToolUse guard for Claude Code (wired in .claude/settings.json).
// Reads the tool-call JSON on stdin; exit 2 blocks the call and feeds stderr
// back to Claude as the reason. Three protections, all born from real incidents:
//
// 1. Migrations are append-only. The deploy pipeline applies each file exactly
//    once (ops_applied_migrations ledger, never `db push`) — editing an
//    already-committed migration silently diverges the repo from prod schema.
// 2. Live credentials must never land in the tree (an sbp_ token exposed in
//    chat forced a full rotation on 2026-07-12).
// 3. supabase/config.toml carries a stale Lovable-era project_id — deploys must
//    keep passing --project-ref explicitly; changing that line breaks nothing
//    loudly, which is exactly why it's guarded.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

const raw = await new Promise((res) => {
  let d = "";
  process.stdin.on("data", (c) => (d += c));
  process.stdin.on("end", () => res(d));
});

let input;
try { input = JSON.parse(raw); } catch { process.exit(0); }

const tool = input.tool_name || "";
if (!/^(Edit|Write|MultiEdit)$/.test(tool)) process.exit(0);

const ti = input.tool_input || {};
const filePath = String(ti.file_path || "").replace(/\\/g, "/");
const newText = [ti.content, ti.new_string, ...(ti.edits || []).map((e) => e?.new_string)]
  .filter(Boolean).join("\n");

const block = (msg) => { console.error(msg); process.exit(2); };

// --- 1. Append-only migrations ---
if (/supabase\/migrations\/[^/]+\.sql$/.test(filePath)) {
  if (tool !== "Write") {
    block(
      "BLOCKED: migration files are append-only. The deploy pipeline applies each file exactly once " +
      "(ops_applied_migrations ledger) — editing an existing migration diverges repo from prod. " +
      "Create a NEW timestamped migration instead.",
    );
  }
  // Write to an existing migration = overwrite; only allow if committed history doesn't know it.
  if (existsSync(filePath)) {
    let tracked = "";
    try {
      tracked = execFileSync("git", ["ls-files", "--", filePath], { encoding: "utf8" }).trim();
    } catch { /* outside git — treat as untracked */ }
    if (tracked) {
      block(
        "BLOCKED: this migration is already committed (and possibly applied to prod via the ledger). " +
        "Never rewrite committed migrations — add a new one.",
      );
    }
  }
}

// --- 2. Live credential patterns ---
// Patterns are written so this file's own source never matches them.
const SECRET_PATTERNS = [
  [/sbp_[a-f0-9]{40}/, "Supabase access token (sbp_…)"],
  [/github_pat_[A-Za-z0-9_]{30,}/, "GitHub fine-grained PAT"],
  [/gh[pousr]_[A-Za-z0-9]{36,}/, "GitHub classic token"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key material"],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/, "Slack token"],
];
for (const [re, label] of SECRET_PATTERNS) {
  if (re.test(newText)) {
    block(
      `BLOCKED: content contains what looks like a live ${label}. ` +
      "Secrets live in Supabase Vault or GitHub Actions secrets — never in the tree or chat. " +
      "If this is a false positive (docs/example), redact the value to a placeholder.",
    );
  }
}

// --- 3. config.toml project_id ---
if (/supabase\/config\.toml$/.test(filePath) && /project_id/.test(newText + String(ti.old_string || ""))) {
  block(
    "BLOCKED: don't touch project_id in supabase/config.toml. It is intentionally stale (Lovable era); " +
    "every deploy passes --project-ref cdyidatkegxwhtuoqxly explicitly. Changing it risks pointing " +
    "local tooling at the wrong project.",
  );
}

process.exit(0);
