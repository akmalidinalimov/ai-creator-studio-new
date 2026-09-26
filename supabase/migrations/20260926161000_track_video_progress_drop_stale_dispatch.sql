-- SECURITY + CORRECTNESS: stop track_video_progress() posting to the OLD Supabase project.
--
-- WHAT WAS WRONG. On the transition to complete (is_complete AND NOT was_already_complete),
-- track_video_progress() did
--     PERFORM net.http_post(url := 'https://<OLD ref>.supabase.co/functions/v1/notify-completion',
--                           headers := {apikey/Authorization: <OLD project's anon JWT>,
--                                       x-internal-secret: public.internal_fn_secret()}, ...)
-- where <OLD ref> is the project's ORIGINAL Supabase ref — the Lovable-hosted environment — not
-- production (cdyidatkegxwhtuoqxly). The production schema was built on 2026-07-05 by replaying the old
-- project's migrations, and the replay carried forward this function's last definition
-- (20260615020000_tier_enforcement.sql) with the old URL baked in. It was broken from the first day in
-- production; no later migration copied it forward.
--
-- WHAT IT DID, measured read-only on 2026-09-26. Both counts are reproducible and measure different
-- things, so both are quoted with their query:
--   * 5,242 first-time lesson completions since the cutover got no completion message — counted as
--       select count(*) from xp_events
--        where ref_key like 'lesson:%' and created_at > '2026-07-05 14:36 UTC';
--     (one lesson: XP event per student+lesson, ref-key idempotent, so this is first completions),
--     across 184 students. Counting lesson_progress.completed_at over the same window gives 5,151.
--   * Production's notify-completion has not run once for a lesson since the cutover: notifications_log
--     has zero lesson_complete / module_complete / course_complete rows after 2026-07-05 14:36 UTC.
--   * The old project is ALIVE. Its own notify-completion returned 403 {"error":"forbidden"} — its secret
--     does not match ours — until 2026-09-25 17:19 UTC, then 5-second timeouts. So it most likely
--     messaged no one.
--   * But every one of those calls carried PRODUCTION's internal_fn_secret() in the x-internal-secret
--     header, plus the student's user_id and lesson_id — roughly 754 calls in the last 30 days and an
--     estimated ~4,000 since the cutover. That secret has therefore been sent, on every completion, to
--     infrastructure this project does not control. It should be ROTATED; that is an owner action and
--     is not done here.
--   * Something DID notice. ops_http_failure_watchdog fired 159 times between 2026-08-10 and 2026-09-25
--     ("403 × N unattributed"), DMing admins each time. But this function used a raw net.http_post,
--     which records no URL, so no alert could say where the requests were going. That is why the new
--     lint rule E8 warns on raw net.http_post in migrations (scripts/check-migration-grants.mjs).
--
-- WHY THIS REMOVES THE DISPATCH INSTEAD OF RE-POINTING IT AT PRODUCTION. Pointing the URL at the right
-- project would wake a student-facing path that has been silent for twelve weeks, and it would
-- DUPLICATE celebrations that other paths took over while it was dead:
--   * Module completion is celebrated by trg_enqueue_module_complete → nudge_module_celebrations →
--     detect-and-nudge (133 sends in the last 30 days) for EVERY module. A student's FIRST module also
--     earns the module_complete badge (user_badges is unique per user+badge, so later modules do not),
--     which notify-badge-award announces. Re-enabling notify-completion would add its own message and a
--     photo on top: 3–4 messages for a student's first module, 2–3 for each later one.
--   * Course completion is announced by the course_complete badge (first course only, same reason).
--   * notify-completion also has defects of its own: it declares "module complete" on the last lesson
--     BY POSITION even when earlier lessons are unfinished, it ignores quiet hours, the nudge opt-out and
--     archived status (detect-and-nudge respects all three), and it has no idempotency beyond an
--     unlocked read in this function.
--
-- WHAT IS LOST, stated completely. An earlier draft of this header said the only thing notify-completion
-- did that nothing else does was a per-lesson message. Review showed that was wrong. It was ALSO the
-- only caller of generate-module-share-image, which is the only writer of public.module_celebrations,
-- which is what the in-app ModuleCelebrationModal reads. So three features depended on this call:
--   1. the per-LESSON "completed, next: X" Telegram message;
--   2. the module share image, sent as a photo;
--   3. the in-app module celebration modal (via module_celebrations — 9 rows total, the newest from
--      2026-07-05 06:39 UTC, all already seen).
-- All three have been dead since the cutover, so removing the call changes nothing any student has
-- experienced in twelve weeks. But they are features, not nothing. Reviving them is a product decision
-- that deserves a proper rebuild — a trigger on the FIRST completion so web completions count too, a
-- unique-per-(user,lesson) queue, a sendTelegram drainer that respects quiet hours and opt-out, the
-- share image generated from the nudge_module_celebrations path rather than here, off by default behind
-- a platform_settings flag — and it is deliberately not made here. If they are NOT wanted back,
-- ModuleCelebrationModal and generate-module-share-image are dead code worth deleting.
--
-- WHAT CHANGED IN THE FUNCTION, and nothing else (verified by a mechanical diff against the live body):
--   * removed the `edge_url` and `anon_key` DECLARE constants (the old project's URL and the old
--     project's anon JWT — neither belongs in production);
--   * removed the entire `IF is_complete AND NOT was_already_complete THEN ... net.http_post ... END IF`
--     block, so internal_fn_secret() is no longer read or sent from here;
--   * removed `was_already_complete` and the SELECT that set it: its ONLY use was the dispatch
--     condition, so it had become a dead read of lesson_progress on every call of a function called
--     ~1,031,693 times. That SELECT had no FOR UPDATE, called no function and was not STRICT, so removing
--     it cannot change any result.
-- Everything else is copied from the LIVE definition (pg_get_functiondef, md5 of prosrc
-- 28d69550b57b164bb9f8df615a68a61a) rather than from any migration file: the auth.uid() check, the
-- is_module_tier_locked tier gate (whose non-enrolled pass-through is deliberate here and documented in
-- its own comment), the 10-second delta clamp, the duration logic, the 85% / last-20-seconds completion
-- rule, the Asia/Tashkent daily_watch_summary date, and the RETURN shape the client reads. The function
-- header is unchanged, including argument names — src/pages/LessonPage.tsx passes them by name.
--
-- NOTHING TO BACKFILL, deliberately. Re-sending 5,242 "you completed a lesson" messages up to twelve
-- weeks late would be worse than the gap, and module and course celebrations were delivered by the
-- other paths throughout.
--
-- ACL: CREATE OR REPLACE with the identical signature preserves the existing grants
-- (postgres, authenticated, service_role; NOT anon). They are restated below so the file is
-- self-describing and so the author-time lint sees the revoke.
--
-- REPLAY: CREATE OR REPLACE and GRANT/REVOKE are declarative. The self-test's assertions only READ, and
-- never call this function (it WRITES lesson_progress and daily_watch_summary). Its one audit INSERT is
-- guarded by NOT EXISTS, so a pipeline retry — the ledger is written after the SQL runs — does not add a
-- second row.

create or replace function public.track_video_progress(
  p_lesson_id uuid, p_current_time numeric, p_duration numeric, p_delta_seconds numeric)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
DECLARE
  uid uuid := auth.uid();
  delta numeric := LEAST(GREATEST(COALESCE(p_delta_seconds, 0), 0), 10);
  cur numeric := GREATEST(COALESCE(p_current_time, 0), 0);
  dur numeric := GREATEST(COALESCE(p_duration, 0), 0);
  new_max numeric;
  new_dur numeric;
  is_complete boolean := false;
  now_ts timestamptz := now();
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;

  -- Tier gate (Phase 2): block recording only on a module beyond a TIERED student's cap.
  -- NULL-tier / non-enrolled / staff → is_module_tier_locked = false → unchanged for the 489.
  IF public.is_module_tier_locked(uid, (SELECT module_id FROM public.lessons WHERE id = p_lesson_id)) THEN
    RAISE EXCEPTION 'module_locked';
  END IF;

  INSERT INTO public.lesson_progress (
    user_id, lesson_id, last_position_seconds, max_position_seconds,
    watch_seconds_total, duration_seconds_v2, updated_at
  ) VALUES (
    uid, p_lesson_id, cur, cur, delta, NULLIF(dur, 0), now_ts
  )
  ON CONFLICT (user_id, lesson_id) DO UPDATE SET
    last_position_seconds = cur,
    max_position_seconds = GREATEST(public.lesson_progress.max_position_seconds, cur),
    watch_seconds_total = public.lesson_progress.watch_seconds_total + delta,
    duration_seconds_v2 = CASE
      WHEN NULLIF(dur, 0) IS NULL THEN public.lesson_progress.duration_seconds_v2
      WHEN public.lesson_progress.duration_seconds_v2 IS NULL THEN NULLIF(dur, 0)
      WHEN dur < public.lesson_progress.duration_seconds_v2 * 0.95 THEN dur
      ELSE public.lesson_progress.duration_seconds_v2 END,
    updated_at = now_ts
  RETURNING max_position_seconds, COALESCE(duration_seconds_v2, NULLIF(dur, 0))
  INTO new_max, new_dur;

  IF new_dur IS NOT NULL AND new_dur > 0 AND ((new_max / new_dur) >= 0.85 OR new_max >= new_dur - 20) THEN
    UPDATE public.lesson_progress SET completed_at = COALESCE(completed_at, now_ts)
    WHERE user_id = uid AND lesson_id = p_lesson_id;
    is_complete := true;
  END IF;

  IF delta > 0 THEN
    INSERT INTO public.daily_watch_summary (user_id, watch_date, total_seconds, updated_at)
    VALUES (uid, (now_ts AT TIME ZONE 'Asia/Tashkent')::date, delta, now_ts)
    ON CONFLICT (user_id, watch_date) DO UPDATE SET
      total_seconds = public.daily_watch_summary.total_seconds + EXCLUDED.total_seconds,
      updated_at = now_ts;
  END IF;

  -- Completion notifications are no longer dispatched from here. See the header of migration
  -- 20260926161000 for why this was removed rather than re-pointed.

  RETURN jsonb_build_object(
    'completed', is_complete,
    'last_position_seconds', cur,
    'max_position_seconds', new_max,
    'duration_seconds', new_dur
  );
END;
$function$;

revoke execute on function public.track_video_progress(uuid, numeric, numeric, numeric) from public, anon;
grant  execute on function public.track_video_progress(uuid, numeric, numeric, numeric) to authenticated, service_role;

do $$
declare
  _src text;
  _bad text := '';
begin
  select p.prosrc into _src
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.oid = 'public.track_video_progress(uuid, numeric, numeric, numeric)'::regprocedure;

  -- 1. The dispatch, the foreign URL, the foreign JWT and the secret read are all gone. The body above
  --    deliberately contains no comment mentioning any of these strings, so these NEGATIVE matches test
  --    code, not prose.
  if _src ~ 'supabase\.co'          then _bad := _bad || 'a supabase.co URL is still in the body; '; end if;
  if _src ~ 'net\.http_post'        then _bad := _bad || 'net.http_post is still called; '; end if;
  if _src ~ 'eyJ[A-Za-z0-9_-]{10,}' then _bad := _bad || 'a JWT is still embedded; '; end if;
  if _src ~ 'internal_fn_secret'    then _bad := _bad || 'internal_fn_secret() is still read; '; end if;

  -- 2. Nothing else was lost. Each POSITIVE check is anchored on the CODE that must survive, not on a
  --    bare name. An earlier draft checked `is_module_tier_locked` and `auth.uid()` as bare words — and
  --    both were satisfied by prose alone (a comment and a DECLARE line), so deleting the real tier gate
  --    or the real null check would still have passed. Same trap as a negative match fooled by a
  --    comment, pointing the other way; review caught it.
  if _src !~ 'IF uid IS NULL THEN RAISE EXCEPTION'                then _bad := _bad || 'lost the null-caller check; '; end if;
  if _src !~ 'IF public\.is_module_tier_locked\(uid'             then _bad := _bad || 'lost the tier gate; '; end if;
  if _src !~ 'LEAST\(GREATEST\(COALESCE\(p_delta_seconds'        then _bad := _bad || 'lost the 10s delta clamp; '; end if;
  if _src !~ 'ON CONFLICT \(user_id, lesson_id\) DO UPDATE'      then _bad := _bad || 'lost the lesson_progress upsert; '; end if;
  if _src !~ '\(new_max / new_dur\) >= 0\.85'                    then _bad := _bad || 'lost the 85% completion rule; '; end if;
  if _src !~ 'new_max >= new_dur - 20'                           then _bad := _bad || 'lost the last-20-seconds rule; '; end if;
  if _src !~ 'SET completed_at = COALESCE\(completed_at, now_ts\)' then _bad := _bad || 'lost the first-completion timestamp; '; end if;
  if _src !~ 'AT TIME ZONE ''Asia/Tashkent'''                    then _bad := _bad || 'lost the Tashkent watch date; '; end if;
  if _src !~ 'INSERT INTO public\.daily_watch_summary'           then _bad := _bad || 'lost daily_watch_summary; '; end if;
  if _src !~ '''duration_seconds'', new_dur'                     then _bad := _bad || 'changed the RETURN shape; '; end if;

  -- 3. Grants preserved: signed-in students must keep EXECUTE or every lesson video stops recording.
  if not has_function_privilege('authenticated', 'public.track_video_progress(uuid, numeric, numeric, numeric)', 'EXECUTE') then
    _bad := _bad || 'authenticated LOST execute — every lesson video would stop recording progress; ';
  end if;
  if has_function_privilege('anon', 'public.track_video_progress(uuid, numeric, numeric, numeric)', 'EXECUTE') then
    _bad := _bad || 'anon can execute it; ';
  end if;

  if _bad <> '' then
    raise exception 'track_video_progress rewrite self-test failed, rolling back: %', _bad;
  end if;

  -- Guarded so a pipeline retry does not append a duplicate row.
  insert into public.admin_actions (actor_user_id, action, details)
  select null, 'track_video_progress_stale_dispatch_removed',
         jsonb_build_object(
           'removed', 'net.http_post to the OLD project''s notify-completion, carrying internal_fn_secret()',
           'broken_since', '2026-07-05 (cutover; the migration replay carried the old URL forward)',
           'features_dead_since_cutover', 'per-lesson message, module share image, in-app module celebration modal',
           'owner_action', 'ROTATE internal_fn_secret — it was sent to the old project on every completion',
           'not_backfilled', 'deliberate — module/course celebrations were delivered by other paths',
           'at', now())
  where not exists (
    select 1 from public.admin_actions where action = 'track_video_progress_stale_dispatch_removed');
end $$;
