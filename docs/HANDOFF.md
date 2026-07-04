# HANDOFF — continue on another machine

Last updated: 2026-07-04. Read this first, then `docs/MIGRATION-TO-OWN-SUPABASE.md`.

## Where things stand

This repo (`ai-creator-studio-new`) is the **staging copy** of the live course
platform. All the audit fixes, engagement/UX work, landing redesign, and the
Supabase-migration prep are committed here on `main`. Everything is pushed.

### Supabase projects (all in YOUR org `isaibhmawezprnghvasq`)
- **AI CREATORS ACADEMY** — ref `cdyidatkegxwhtuoqxly` (region eu-west-1).
  Your intended **production target**. Schema (122 migrations, 61 tables, RLS),
  263 db functions, 37 edge functions, crons, and 60-day message retention are
  applied. **Currently 0 users — empty.** Students are NOT here yet.
- **TEST** — ref `ljrahsuhvkeavrzhqsin` (region eu-central-1). Same schema +
  functions. Core flow VERIFIED here: signup creates auth.users + profiles,
  password login returns a session, authenticated RLS read works. Repo `.env`
  currently points here.

### The live 500 students
Still live in **Lovable's managed Supabase** (a separate org our access token
CANNOT see). They have never been exported. Migrating them is the open task.

## THE ONE OPEN BLOCKER
To move the 500 students out of Lovable we need EITHER:
- **Option B (preferred):** the LIVE platform's Supabase **Project URL** +
  **service_role (secret) key**. Then export every table via the REST API and
  load into ACADEMY. No Postgres string needed. Lovable stays untouched
  (read-only pull). Steps to fetch these are in the last chat + below.
- **Option A:** the LIVE platform's Postgres **connection string + DB password**
  (Settings -> Database), then `supabase db dump` / restore.

### How to fetch Option B values (from the LIVE `ai-creators-lesson`)
1. Project URL: open the live site, F12 -> Network -> filter `supabase` -> any
   request's URL starts `https://XXXX.supabase.co` — that's the URL.
2. service_role key: in Lovable open `ai-creators-lesson` -> Cloud/Backend panel
   -> "Open Supabase" -> Project Settings -> API -> `service_role` (Reveal), OR
   find `SUPABASE_SERVICE_ROLE_KEY` in Lovable's Secrets list. Looks like
   `sb_secret_…` or an `eyJ…` JWT containing `"role":"service_role"`.

## Migration sequence once B (or A) is in hand
1. Read-only export of live data from Lovable (zero student impact).
2. Load into ACADEMY (`cdyidatkegxwhtuoqxly`); verify counts (~500 users +
   profiles + progress + submissions match).
3. Set the 10 external secrets (Bunny x4, OpenAI, Telegram x4, etc.) on ACADEMY.
4. Repoint the live frontend to ACADEMY (Vercel route, or Lovable backend
   switch) and flip. Keep Lovable read-only as rollback for a few days.

## SECRETS — do NOT commit these; they live only in chat / your notes
Needed to resume the CLI work (paste to the new session, never into a file):
- Supabase access token (`sbp_…`) for org `isaibhmawezprnghvasq`.
- DB passwords: ACADEMY = production pass; TEST = its own pass.
- TEST publishable key is already in `.env` (safe/public).
- The 10 external secret VALUES for step 3.
> Reminder: rotate the access token + DB passwords after migration.

## To resume on the new machine
```bash
git clone https://github.com/akmalidinalimov/ai-creator-studio-new.git
cd ai-creator-studio-new
npm install
# paste the secrets above to the Claude Code session, then continue at "THE ONE OPEN BLOCKER"
```
