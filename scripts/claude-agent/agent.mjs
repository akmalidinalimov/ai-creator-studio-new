#!/usr/bin/env node
// Claude Code laptop helper (PR2). Polls the claude-agent queue; when the owner queues a task from
// the Telegram "🤖 Claude Code" button, runs `claude -p` in the repo (unattended) and reports the
// result back — which DMs the owner. It NEVER merges/deploys: it opens PRs and stops; the owner
// merges from Telegram. Its liveness heartbeat is what makes the bot show "online" vs "queued".
//
// Requires CLAUDE_AGENT_SECRET (the same value set in the Supabase edge-function secrets, so the
// claude-agent function wakes up). Config via scripts/claude-agent/.env (see .env.example).
// Stop it: close the process, or set platform_settings.claude_agent -> {"enabled": false}.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { setTimeout as sleep } from "node:timers/promises";

// --- minimal .env loader (scripts/claude-agent/.env) — real env vars win over the file ---
const HERE = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = join(HERE, ".env");
if (existsSync(ENV_PATH)) {
  for (const line of readFileSync(ENV_PATH, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}

const SECRET = process.env.CLAUDE_AGENT_SECRET;
const FN_URL = process.env.CLAUDE_AGENT_URL || "https://cdyidatkegxwhtuoqxly.supabase.co/functions/v1/claude-agent";
const REPO = process.env.CLAUDE_AGENT_REPO || join(HERE, "..", ".."); // repo root (script is scripts/claude-agent/)
const HOST = process.env.CLAUDE_AGENT_HOST || os.hostname();
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
const MAX_TURNS = String(process.env.CLAUDE_MAX_TURNS || "40");
const POLL_MS = Number(process.env.CLAUDE_POLL_SEC || 15) * 1000;
const HEARTBEAT_MS = 30_000;
const TASK_TIMEOUT_MS = Number(process.env.CLAUDE_TASK_TIMEOUT_MIN || 25) * 60_000;
const IS_WIN = process.platform === "win32";

if (!SECRET) {
  console.error("[claude-agent] CLAUDE_AGENT_SECRET is not set. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

// Prepended to every task (via stdin, so it's never shell-escaped). Encodes the owner's chosen
// autonomy: full work + open PRs, but NEVER merge/deploy — the owner is the only gate.
const CONSTRAINTS = [
  "You are Claude Code running UNATTENDED on the owner's laptop, triggered from a Telegram button.",
  "Do the task fully: investigate, edit files, and run commands as needed. If you change code, commit on a NEW branch and open a PR with `gh pr create`.",
  "HARD RULES — never violate: do NOT merge to main, do NOT push to main, do NOT deploy, do NOT run destructive or irreversible commands (no force-push, no data deletion, no secret changes). The owner reviews and merges from Telegram. If anything needs the owner's decision/approval, STOP and state exactly what is pending.",
  "Follow the repository's CLAUDE.md doctrine.",
  "Finish with a SHORT summary (a few lines) of what you did and any PR link — it is sent to the owner's phone, so be concise.",
].join("\n");

async function call(action, body = {}) {
  const r = await fetch(FN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-claude-agent-secret": SECRET },
    body: JSON.stringify({ action, host: HOST, ...body }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${action} -> HTTP ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
  return j;
}

function runClaude(taskPrompt) {
  return new Promise((resolve) => {
    const prompt = `${CONSTRAINTS}\n\n----- TASK FROM TELEGRAM -----\n${taskPrompt}`;
    // Prompt goes via STDIN (no shell-escaping of the task text). Only fixed, simple flags as args.
    const args = ["-p", "--dangerously-skip-permissions", "--max-turns", MAX_TURNS];
    const child = spawn(CLAUDE_BIN, args, { cwd: REPO, shell: IS_WIN });
    let out = "", err = "";
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
      resolve({ status: "error", error: `timed out after ${Math.round(TASK_TIMEOUT_MS / 60000)} min` });
    }, TASK_TIMEOUT_MS);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => { clearTimeout(timer); resolve({ status: "error", error: `spawn failed: ${e.message} (is the 'claude' CLI installed + in PATH?)` }); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ status: "done", result: (out.trim() || "(no output)").slice(-8000) });
      else resolve({ status: "error", error: (err.trim() || out.trim() || `claude exited ${code}`).slice(-4000) });
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

console.log(`[claude-agent] up — host=${HOST} repo=${REPO} bin=${CLAUDE_BIN} poll=${POLL_MS / 1000}s`);
// Independent heartbeat so the bot reads "online" even while a long task is running.
setInterval(() => { call("heartbeat").catch((e) => console.error("[claude-agent] heartbeat:", e.message)); }, HEARTBEAT_MS);
call("heartbeat").catch(() => {});

for (;;) {
  try {
    const { task } = await call("claim");
    if (task?.id) {
      console.log(`[claude-agent] running ${task.id}: ${String(task.prompt).slice(0, 100)}`);
      const res = await runClaude(String(task.prompt));
      await call("report", { id: task.id, status: res.status, result: res.result, error: res.error });
      console.log(`[claude-agent] reported ${task.id}: ${res.status}`);
      continue; // a task just finished — check for the next one immediately
    }
  } catch (e) {
    console.error("[claude-agent] loop:", e.message);
  }
  await sleep(POLL_MS);
}
