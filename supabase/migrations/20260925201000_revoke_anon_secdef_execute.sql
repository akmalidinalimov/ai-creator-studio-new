-- SECURITY: anon could call 77 SECURITY DEFINER functions over the public REST API.
-- This closes the ones that are dangerous and unused. Found by the Supabase security advisor.
--
-- ═══ THE ONE THAT MATTERS ═══
--   public.cron_service_key() is SECURITY DEFINER, returns text, and its entire body is
--       select decrypted_secret from vault.decrypted_secrets where name = 'CRON_SERVICE_KEY'
--   `anon` had EXECUTE on it. PostgREST exposes every executable function in the `public` schema at
--   /rest/v1/rpc/<name>, and the anon key is public by design — it ships in the browser bundle. So
--   anyone at all could read a live Vault credential with one HTTP request. The secret exists
--   (verified present in vault.decrypted_secrets). Zero references to this function exist anywhere in
--   src/ or supabase/functions/ — nothing calls it, so nothing breaks by closing it.
--   **This migration does not rotate that secret. The owner should, because it has been reachable.**
--
-- ═══ THE TRAP THAT MADE THIS INVISIBLE ═══
--   Most of these ACLs read `=X/postgres` — that is the grant to **PUBLIC**, which `anon` and
--   `authenticated` inherit. `REVOKE EXECUTE ... FROM anon` alone would be a NO-OP and would have
--   looked like a fix. Same shape as the video-source-column leak, where a column-level REVOKE was a
--   no-op against a table-level GRANT. Every revoke below therefore names PUBLIC first.
--
-- ═══ ALSO CLOSED (each verified to have no browser caller) ═══
--   ops_net_post(url, body, headers, ...)  — arbitrary HTTP POST from the database with attacker-
--                                            supplied URL and headers. Server-side request forgery,
--                                            callable by anyone. 0 refs outside SQL.
--   purge_old_chat_messages()              — deletes ai_chat_messages older than 60 days (354 rows
--                                            today). Destructive, 0 refs.
--   zero_broken_streaks()                  — zeroes students' streaks and burns their freezes (36
--                                            active streaks today). Called only by the streak-rollover
--                                            edge function via service_role.
--   get_settings(text[])                   — bulk read of app_settings (40 keys: watchdog state,
--                                            quiet hours, bot test recipient). 0 refs.
--   leaderboard_top(int)                   — student names/scores to anonymous callers. 0 refs.
--   group_health_score(uuid)               — per-group internals. 0 refs.
--   nudge_candidates_inactive(int),
--   nudge_candidates_stuck(),
--   pick_weekly_group_stars()              — student targeting lists and a write; called only by the
--                                            detect-and-nudge / student-of-week edge functions via
--                                            service_role.
--
-- ═══ NARROWED, NOT CLOSED (the browser genuinely calls these — anon removed, authenticated kept) ═══
--   get_setting(text)        — src/lib/settings.ts
--   nudge_cron_status()      — src/pages/admin/AdminNudges.tsx
--   weekly_digest_status()   — src/components/admin/WeeklyDigestTile.tsx
--   These still let any SIGNED-IN user read operational config and watchdog state, which is not
--   right either — but tightening further means adding an admin check inside each, which changes
--   behaviour rather than just permissions. Left for a follow-up with the owner rather than done
--   blind at night.
--
-- ═══ DELIBERATELY UNTOUCHED ═══
--   get_public_setting(text) — genuinely public by design and already sanitised: for the 'telegram'
--   key it returns only bot_username and the bot_id parsed from before the ':' in the token, never
--   the token. Called from src/pages/LessonPage.tsx on a page anonymous visitors can reach.
--
-- ═══ WHY service_role IS RE-GRANTED EVERYWHERE ═══
--   Edge functions authenticate as service_role. Revoking from PUBLIC removes their inherited
--   privilege too, so every function below is explicitly granted back to service_role. pg_cron runs
--   as postgres and bypasses grants entirely, and a SECURITY DEFINER function calling another runs as
--   its owner — so the DB-internal callers (post_group_weekly_boards, the watchdogs) are unaffected.
--
-- ═══ THE LIVE DATABASE HAS DRIFTED FROM THE REPO, IN THE PERMISSIVE DIRECTION ═══
--   Review checked the migration history and reported that ops_net_post, nudge_candidates_inactive,
--   nudge_candidates_stuck and nudge_cron_status were already revoked from anon at creation, making
--   those lines here a no-op. The LIVE ACLs say otherwise — each carries an explicit `anon=X/postgres`
--   grant right now:
--       ops_net_post               postgres=X | anon=X | authenticated=X | service_role=X
--       nudge_candidates_inactive  postgres=X | anon=X | authenticated=X | service_role=X
--       nudge_candidates_stuck     postgres=X | anon=X | authenticated=X | service_role=X
--       nudge_cron_status          postgres=X | anon=X | authenticated=X | service_role=X
--   Their migrations DID revoke anon. So something re-granted it outside version control. Combined
--   with cron_service_key() existing in the live database but in NO tracked migration (it is
--   referenced by 9 cron-scheduling migrations and defined by none — a database rebuilt from this
--   repo would not have it, and every one of those cron jobs would fail), the picture is live
--   SQL-editor changes that were never reconciled back. This repo has precedent for exactly that; see
--   the header of 20260609100000_internal_fn_secret_vault_hardening.sql.
--   TWO FOLLOW-UPS FOR THE OWNER, neither done here: reconcile cron_service_key()'s CREATE FUNCTION
--   into a tracked migration, and work out what else has drifted. The `anon_secdef_remaining` count
--   this migration writes to admin_actions is the authoritative starting point — a repo grep is not,
--   because it cannot see objects that only exist live.
--
-- Idempotent + replay-safe: REVOKE/GRANT are declarative and converge. Touches no data, no XP, no
-- table. This is the remaining 64 anon-executable SECURITY DEFINER functions' problem too — they are
-- NOT addressed here because each needs its own caller audit; see the report for the owner.

-- ───────────────────────── 1. Fully closed (no browser caller) ─────────────────────────
revoke execute on function public.cron_service_key() from public, anon, authenticated;
grant  execute on function public.cron_service_key() to service_role;

revoke execute on function public.ops_net_post(text, jsonb, jsonb, text, integer) from public, anon, authenticated;
grant  execute on function public.ops_net_post(text, jsonb, jsonb, text, integer) to service_role;

revoke execute on function public.purge_old_chat_messages() from public, anon, authenticated;
grant  execute on function public.purge_old_chat_messages() to service_role;

revoke execute on function public.zero_broken_streaks() from public, anon, authenticated;
grant  execute on function public.zero_broken_streaks() to service_role;

revoke execute on function public.get_settings(text[]) from public, anon, authenticated;
grant  execute on function public.get_settings(text[]) to service_role;

revoke execute on function public.leaderboard_top(integer) from public, anon, authenticated;
grant  execute on function public.leaderboard_top(integer) to service_role;

revoke execute on function public.group_health_score(uuid) from public, anon, authenticated;
grant  execute on function public.group_health_score(uuid) to service_role;

revoke execute on function public.nudge_candidates_inactive(integer) from public, anon, authenticated;
grant  execute on function public.nudge_candidates_inactive(integer) to service_role;

revoke execute on function public.nudge_candidates_stuck() from public, anon, authenticated;
grant  execute on function public.nudge_candidates_stuck() to service_role;

revoke execute on function public.pick_weekly_group_stars() from public, anon, authenticated;
grant  execute on function public.pick_weekly_group_stars() to service_role;

-- ───────────────────────── 2. Narrowed (browser calls these; anon removed) ─────────────────────────
revoke execute on function public.get_setting(text) from public, anon;
grant  execute on function public.get_setting(text) to authenticated, service_role;

revoke execute on function public.nudge_cron_status() from public, anon;
grant  execute on function public.nudge_cron_status() to authenticated, service_role;

revoke execute on function public.weekly_digest_status() from public, anon;
grant  execute on function public.weekly_digest_status() to authenticated, service_role;

-- ───────────────────────── 3. Deploy self-test (FAILS LOUD, on purpose) ─────────────────────────
-- Read-only assertions, in both directions: the credential is closed to anon, AND every caller this
-- platform actually has still works — service_role keeps what edge functions need, `authenticated`
-- keeps the three browser RPCs, and anon keeps the deliberately-public get_public_setting.
--
-- THIS ONE IS ALLOWED TO ABORT THE MIGRATION, unlike the house pattern of catching and logging.
-- That house pattern exists so a broken self-test cannot roll back a migration whose real work
-- already landed and must not be undone. Here the entire migration is GRANT/REVOKE: declarative,
-- side-effect-free, and safe to roll back in full. So the trade runs the other way — a revoke that
-- silently broke the app would be a worse outcome than the leak it fixed, and letting it commit with
-- only a passive admin_actions row that nobody is watching would be exactly the "graceful is not
-- silent" failure this project's doctrine warns about. Fail loud; the deploy step will go red.
do $selftest$
declare _bad text := '';
begin
  if has_function_privilege('anon', 'public.cron_service_key()', 'EXECUTE') then
    _bad := _bad || 'anon STILL has cron_service_key; ';
  end if;
  if has_function_privilege('authenticated', 'public.cron_service_key()', 'EXECUTE') then
    _bad := _bad || 'authenticated STILL has cron_service_key; ';
  end if;
  if not has_function_privilege('service_role', 'public.cron_service_key()', 'EXECUTE') then
    _bad := _bad || 'service_role LOST cron_service_key; ';
  end if;
  if has_function_privilege('anon', 'public.ops_net_post(text, jsonb, jsonb, text, integer)', 'EXECUTE') then
    _bad := _bad || 'anon STILL has ops_net_post; ';
  end if;
  if not has_function_privilege('service_role', 'public.ops_net_post(text, jsonb, jsonb, text, integer)', 'EXECUTE') then
    _bad := _bad || 'service_role LOST ops_net_post; ';
  end if;
  if has_function_privilege('anon', 'public.get_setting(text)', 'EXECUTE') then
    _bad := _bad || 'anon STILL has get_setting; ';
  end if;
  -- The browser must keep working.
  if not has_function_privilege('authenticated', 'public.get_setting(text)', 'EXECUTE') then
    _bad := _bad || 'authenticated LOST get_setting (breaks src/lib/settings.ts); ';
  end if;
  if not has_function_privilege('authenticated', 'public.nudge_cron_status()', 'EXECUTE') then
    _bad := _bad || 'authenticated LOST nudge_cron_status (breaks AdminNudges); ';
  end if;
  if not has_function_privilege('authenticated', 'public.weekly_digest_status()', 'EXECUTE') then
    _bad := _bad || 'authenticated LOST weekly_digest_status (breaks WeeklyDigestTile); ';
  end if;
  -- And the deliberately-public one must stay public.
  if not has_function_privilege('anon', 'public.get_public_setting(text)', 'EXECUTE') then
    _bad := _bad || 'anon LOST get_public_setting (breaks LessonPage for logged-out visitors); ';
  end if;

  -- Best-effort record BEFORE the raise, so the reason survives the rollback in the logs.
  begin
    insert into public.admin_actions (actor_user_id, action, details)
    values (null, case when _bad = '' then 'anon_secdef_revoke_selftest'
                       else 'anon_secdef_revoke_selftest_failed' end,
            jsonb_build_object(
              'failures', nullif(_bad, ''),
              'anon_secdef_remaining',
                (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.prosecdef and p.prokind = 'f'
                    and has_function_privilege('anon', p.oid, 'EXECUTE')),
              'note', 'cron_service_key was readable by anon; owner should rotate CRON_SERVICE_KEY',
              'at', now()));
  exception when others then null; end;

  if _bad <> '' then
    raise exception 'secdef revoke self-test failed, rolling back: %', _bad;
  end if;
end $selftest$;
