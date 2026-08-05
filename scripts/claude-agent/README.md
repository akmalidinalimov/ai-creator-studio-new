# Claude Code laptop helper

Lets you command Claude Code from your phone. You tap **🤖 Claude Code** in the Telegram bot, type a
task, and this helper — running on your laptop — picks it up, runs `claude -p` in the repo, and DMs the
result back. It **opens PRs but never merges/deploys** (you merge from Telegram, per the repo doctrine).

```
You type a task in Telegram
   → the bot queues it (claude_code_tasks)
   → THIS helper claims it, runs `claude -p`, reports back → you get a DM
```

"Laptop on" = this helper is running (it heartbeats every 30s; the bot shows "⚙️ working" vs
"⚠️ queued — laptop off" from that heartbeat).

## Prerequisites
- **Node.js 18+** and the **`claude` CLI** installed and **logged in** on this machine (run `claude`
  once interactively to confirm it works — the helper uses that same auth).
- **`gh` CLI** logged in (so the agent can open PRs) and this repo checked out.

## One-time setup
1. **Generate a secret** (keep it private):
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
2. **Tell Supabase about it** so the `claude-agent` edge function wakes up (it 403s until this is set):
   - Dashboard → your project → **Edge Functions → Secrets** → add `CLAUDE_AGENT_SECRET` = the value; **or**
   - `npx supabase secrets set CLAUDE_AGENT_SECRET=<value> --project-ref cdyidatkegxwhtuoqxly`
3. **Give it to the helper**: copy `.env.example` → `.env` in this folder and paste the same value:
   ```
   CLAUDE_AGENT_SECRET=<the value>
   ```
   (`.env` is gitignored — it never gets committed.)
4. **Run it**:
   ```bash
   node scripts/claude-agent/agent.mjs
   ```
   You should see `[claude-agent] up — host=… repo=…`. Now tap 🤖 Claude Code in the bot, send a small
   test task ("what's the latest commit on main?"), and you should get a DM back.

## Auto-start on login (Windows)
Register a scheduled task that launches the helper each time you log in (output goes to `agent.log`):
```bat
schtasks /create /tn "ClaudeAgentHelper" /sc onlogon /rl highest /f ^
  /tr "\"%LOCALAPPDATA%\..\..\Documents\GitHub\ai-creator-studio-new\scripts\claude-agent\start.bat\""
```
(Or simpler: put a shortcut to `start.bat` in `shell:startup`.) Remove it with
`schtasks /delete /tn "ClaudeAgentHelper" /f`.

## Safety
- **Only you can queue tasks** — the bot gate is fail-closed to your Telegram ID
  (`platform_settings.claude_agent.owner_tg_ids`).
- The helper holds only `CLAUDE_AGENT_SECRET` (a scoped queue token), **never** the Supabase service key.
- It runs `claude -p --dangerously-skip-permissions` so it works unattended — meaning while a task runs
  it can edit files and run commands on this laptop. It's constrained to **open PRs, never merge/deploy**,
  but a badly-worded task can still make a local mess (recoverable via git). Queue tasks you'd be
  comfortable running yourself.
- **Kill switch:** close the helper, or set `platform_settings.claude_agent` → `{"enabled": false}`
  (the `claim` action then returns nothing).
- Bound cost with `CLAUDE_MAX_TURNS` (default 40) and `CLAUDE_TASK_TIMEOUT_MIN` (default 25) in `.env`.
