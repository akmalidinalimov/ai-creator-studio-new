# Migration Runbook — Lovable Cloud → your own Supabase Pro

Move this platform's backend off Lovable Cloud's managed Supabase onto **your** Supabase Pro project (org `isaibhmawezprnghvasq`), so you own the data, keys, and backups — and every new user/message lands in **your** database.

> **Honest capability split.** Steps marked **[you]** happen in the Lovable/Supabase web dashboards, which are behind your login — I can't operate them. Steps marked **[me: CLI]** I can run from the terminal **if you give me a Supabase access token** (supabase.com/dashboard/account/tokens) + the new project ref + DB password. Steps marked **[me: code]** I do now in the repo.

---

## Phase 0 — Decide the fork (this changes everything)

**Q1. Is there real data to preserve on this copy, or is a fresh schema fine?**
This copy (`genius-loom-space`) has **no real students**. If the only things worth keeping are the landing copy (`platform_settings`) and any seeded courses, this is a **fresh-start migration** — dramatically simpler (no auth-user or storage move, no 500-user re-auth). *Recommended: fresh start for the copy.* (The real production platform with 500 students is a separate, bigger migration we plan later.)

**Q2. Confirm the two feature asks:**
- "Every new user in my Supabase" → **automatic** once the app points at your project (all writes go there). Verified in Phase 6.
- "Messages stored + deleted every 2 months" → the messages are `ai_chat_messages` (AI-tutor chat). I've drafted a 60-day retention cron (Phase 3b). Confirm: hard-delete after 60 days is intended (vs archive), and that `ai_chat_messages` is the table you mean.

---

## Phase 1 — Create the target project **[you]**
1. In your Pro org → **New project** (name e.g. `ai-creators-studio`), pick a region near your users, set a strong **DB password** (save it).
2. Grab from **Project Settings → API**: the **Project URL**, the **publishable key** (`sb_publishable_…`), the **secret key** (`sb_secret_…` = service role), and the **project ref** (the `xxxx` in the URL).
3. Create a **personal access token**: account → **Access Tokens** → generate. (Give me this + the ref + DB password to enable the [me: CLI] steps.)

## Phase 2 — Apply the schema (121 migrations) **[me: CLI]**
```bash
export SUPABASE_ACCESS_TOKEN=<your token>
npx supabase link --project-ref <new-ref>            # enter DB password when asked
npx supabase db push                                 # applies supabase/migrations/* to the new project
```
**Gate:** every migration applies cleanly; `supabase migration list` shows all 121 as applied on remote.

## Phase 3 — Deploy the 37 edge functions **[me: CLI]**
```bash
npx supabase functions deploy   # deploys everything under supabase/functions/
```
**Gate:** all 37 functions show "deployed" with no build errors.

### Phase 3a — Set the 17 function secrets **[you or me: CLI]**
These must exist on the new project (Project → Edge Functions → Secrets, or `supabase secrets set`). `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` are injected automatically; the rest you provide:
```
BUNNY_API_KEY  BUNNY_HLS_HOSTNAME  BUNNY_LIBRARY_ID  BUNNY_TOKEN_AUTH_KEY
OPENAI_API_KEY  LOVABLE_API_KEY  INTERNAL_FN_SECRET  SITE_URL
TELEGRAM_API_KEY  TELEGRAM_BOT_TOKEN  TELEGRAM_BOT_USERNAME  TELEGRAM_SUPPORT_HANDLE
BOT_WEBHOOK_SECRET  SHEET_SYNC_SECRET
```
> Note: `LOVABLE_API_KEY` is a Lovable dependency (study-assistant + share-image use Lovable's AI gateway). To be truly off Lovable, repoint those two functions to a direct OpenAI/provider key later (roadmap Phase 6.1). Not blocking.

### Phase 3b — Message retention **[me: code, ready]**
Migration `…_message_retention.sql` (drafted in this repo) enables `pg_cron` and schedules a weekly purge of `ai_chat_messages` older than 60 days. Applies automatically in Phase 2 once you confirm Q2.

## Phase 4 — Data migration (only if Q1 = "preserve data") **[me: CLI + you]**
```bash
# from the SOURCE (Lovable Cloud) — REQUIRES a direct DB connection string to it
supabase db dump --db-url "$LOVABLE_DB_URL" -f roles.sql --role-only
supabase db dump --db-url "$LOVABLE_DB_URL" -f data.sql  --use-copy --data-only
# restore into the new project
psql "$NEW_DB_URL" --single-transaction -v ON_ERROR_STOP=1 \
  -c 'set session_replication_role = replica' -f data.sql
```
- Auth users: carried in the dump, **but sessions invalidate** (new JWT secret) → users re-log in.
- Storage objects (videos/images): copy separately (rclone/S3 sync). Bunny-hosted video is unaffected (external CDN).
> ⚠️ **Biggest unknown:** does Lovable Cloud give you a **direct Postgres connection string** to the source DB? If not, this phase needs Lovable's cooperation (or Lovable's AI to export). Confirm before relying on it. *For a fresh-start copy, skip Phase 4 entirely.*

## Phase 5 — Repoint the app + connect Lovable **[you + me: code]**
- **[me: code]** Update `.env` / the Supabase client to the new `VITE_SUPABASE_URL` + `VITE_SUPABASE_PUBLISHABLE_KEY`, commit.
- **[you]** In Lovable: switch the project's backend from **Lovable Cloud** to **your own Supabase** (Lovable's Supabase integration). Verify Lovable supports this switch for a Cloud-built project — if not, the alternative is to move the frontend to **Vercel** pointed at your Supabase (roadmap Phase 6).
- Redeploy the frontend.

## Phase 6 — Verify end-to-end **[me: CLI + Playwright]**
- **New user lands in YOUR db:** sign up a test user on the live site → I query `auth.users` on your project via the service key and confirm the row is there. ✅ the core requirement.
- Login works; dashboard loads; RLS holds (anon can't read protected tables); a couple of edge functions return 200.
- `ai_chat_messages` retention cron is scheduled (`select * from cron.job`).

## Phase 7 — Cutover & rollback
- Keep the old Lovable Cloud backend **read-only / untouched** for a rollback window.
- Once verified, decommission it. Enable **Point-in-Time Recovery** on your Pro project if 24h RPO isn't enough.

---

## What I need from you to start automating
1. **Q1 + Q2 answers** (fresh-start vs data-migrate; confirm message retention).
2. A **Supabase access token** + the **new project ref** + **DB password** → unlocks the [me: CLI] steps (schema push, function deploy, verification).
3. The **17 secret values** (or you set them in the dashboard).
Everything I can do without those, I'll do now in the repo (retention migration, env-swap prep, verification scripts).
