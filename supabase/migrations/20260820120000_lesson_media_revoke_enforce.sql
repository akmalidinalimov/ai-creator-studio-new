-- Re-close the lesson video-source paywall hole + make the fix self-healing.
--
-- THE HOLE (confirmed live before this migration): public.lessons.video_url,
-- provider_video_id, and video_storage_path are SELECT-able by anon AND authenticated
-- (has_column_privilege('anon','public.lessons','provider_video_id','SELECT') = true).
-- RLS already exposes every published lesson row to anon ("lessons read" USING(true)), so
-- with column-level SELECT open too, anyone can read the raw Bunny provider_video_id (or
-- video_url) for ANY lesson and play it directly — completely bypassing the enrollment/
-- has_module_access check that the lesson-video-url edge function enforces. This is exactly
-- the hole Phase 0 (20260622030000_phase0_lesson_media_protection.sql, line 26-27) closed
-- with `REVOKE SELECT (video_url, provider_video_id, video_storage_path) ON public.lessons
-- FROM anon, authenticated;` — it has since reopened.
--
-- ROOT CAUSE: a later migration ran a blanket table-level GRANT (e.g.
-- `GRANT ALL/SELECT ON ALL TABLES IN SCHEMA public TO anon, authenticated`, or an explicit
-- `GRANT SELECT ON public.lessons TO authenticated`). Postgres table-level GRANTs apply to
-- ALL columns regardless of any earlier column-level REVOKE, so it silently re-opened these
-- three columns without touching a single line that mentions "lessons" or "video".
--
-- WHY RE-REVOKE ALONE IS FRAGILE: simply re-running the Phase-0 REVOKE here fixes today's
-- drift, but nothing stops the next blanket GRANT (a routine schema migration, a Supabase
-- dashboard action, a future seed script) from silently wiping it again — with zero signal
-- until someone notices videos playing without enrollment. Per the incident doctrine, we fix
-- the class, not the instance: a detector + a self-healing enforcer + a cron schedule + an
-- admin alert, so drift is caught and repaired within ~10 minutes and is always DB-visible.
--
-- NOTHING LEGITIMATE BREAKS: every real reader of these columns already avoids a direct
-- table SELECT as anon/authenticated. Edge functions (lesson-video-url, admin lesson CRUD)
-- use the service_role key, which keeps full column access. Admin/teacher UI reads the raw
-- pointers via the Phase-0 SECURITY DEFINER helpers (staff_get_lesson,
-- staff_list_pending_bunny, staff_count_lessons_by_storage_path), not a direct table SELECT.
-- The frontend's own column needs (video_provider, has_video) are intentionally NOT touched
-- by the REVOKE below — they're non-secret and are how the UI knows a video exists/its
-- provider without knowing where it lives.
--
-- Mirrors 20260819120000_grade_orphan_watchdog.sql's detector/health/watchdog/cron shape and
-- reuses its exact admin-alert mechanism: platform_settings['telegram'].bot_token +
-- net.http_post to the Telegram sendMessage API, fanned out to admins/superadmins resolved
-- via profiles.telegram_id join user_roles, plus a DB-visible record in public.admin_actions.
-- Fully idempotent (create or replace + guarded cron unschedule-if-exists), safe to re-apply.

-- 1. The immediate fix: re-apply the Phase-0 REVOKE verbatim.
REVOKE SELECT (video_url, provider_video_id, video_storage_path)
  ON public.lessons FROM anon, authenticated;

-- 2. Pure detector: is anon or authenticated currently able to read any of the three
--    sensitive columns? True means the paywall hole is open right now.
create or replace function public.lesson_media_exposed()
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select
       has_column_privilege('anon','public.lessons','video_url','SELECT')
    or has_column_privilege('anon','public.lessons','provider_video_id','SELECT')
    or has_column_privilege('anon','public.lessons','video_storage_path','SELECT')
    or has_column_privilege('authenticated','public.lessons','video_url','SELECT')
    or has_column_privilege('authenticated','public.lessons','provider_video_id','SELECT')
    or has_column_privilege('authenticated','public.lessons','video_storage_path','SELECT');
$fn$;
revoke execute on function public.lesson_media_exposed() from public, anon;
grant execute on function public.lesson_media_exposed() to authenticated, service_role;

-- 3. Self-healing enforcer. SECURITY DEFINER + owned by the migration runner (postgres,
--    which also owns public.lessons — confirmed live: `select tableowner from pg_tables
--    where tablename='lessons'` = postgres, and existing SECURITY DEFINER fns created the
--    same way, e.g. grade_orphan_watchdog/staff_get_lesson, are likewise owned by postgres),
--    so the dynamic REVOKE below runs with an owner's privileges and always succeeds even
--    when invoked by service_role via cron.
create or replace function public.lesson_media_guard_enforce()
returns int
language plpgsql
security definer
set search_path = public
as $fn$
declare
  _tok text; _admin record; _sent int := 0; _msg text;
begin
  if not public.lesson_media_exposed() then
    return 0; -- no drift, nothing to do
  end if;

  -- Drift detected: something (a blanket table GRANT) re-exposed the raw video pointers.
  -- Re-apply the Phase-0 REVOKE immediately, then raise the alarm.
  execute 'revoke select (video_url, provider_video_id, video_storage_path) on public.lessons from anon, authenticated';

  begin
    insert into public.admin_actions (actor_user_id, action, details)
    values (null, 'lesson_media_grant_drift',
            jsonb_build_object(
              're_revoked', true,
              'columns', array['video_url','provider_video_id','video_storage_path'],
              'at', now()));
  exception when others then null; end;

  select value->>'bot_token' into _tok from platform_settings where key = 'telegram';
  if _tok is not null and _tok <> '' then
    _msg := '⚠️ lessons video-source columns were re-exposed to anon/authenticated — auto-revoked. Investigate the blanket GRANT.';
    for _admin in
      select distinct p.telegram_id from profiles p
      join user_roles r on r.user_id = p.id and r.role in ('admin','superadmin')
      where p.telegram_id is not null limit 3
    loop
      begin
        perform net.http_post(
          url := 'https://api.telegram.org/bot' || _tok || '/sendMessage',
          headers := jsonb_build_object('Content-Type','application/json'),
          body := jsonb_build_object('chat_id', _admin.telegram_id, 'text', _msg));
        _sent := _sent + 1;
      exception when others then null;
      end;
    end loop;
  end if;

  return 1;
end;
$fn$;
revoke execute on function public.lesson_media_guard_enforce() from public, anon, authenticated;
grant execute on function public.lesson_media_guard_enforce() to service_role;

-- 4. Schedule the enforcer every ~10 minutes. Guarded so a cron failure can never roll back
--    the function definitions above, and any failure is recorded in admin_actions (do-blocks
--    otherwise swallow errors — teacher-engagement-nudge lesson).
do $$
begin
  begin
    if exists (select 1 from cron.job where jobname = 'lesson-media-guard') then
      perform cron.unschedule('lesson-media-guard');
    end if;
    perform cron.schedule('lesson-media-guard', '*/10 * * * *', $cmd$ select public.lesson_media_guard_enforce() $cmd$);
  exception when others then
    begin
      insert into public.admin_actions (actor_user_id, action, details)
      values (null, 'lesson_media_guard_cron_failed', jsonb_build_object('error', sqlerrm, 'at', now()));
    exception when others then null; end;
  end;

  -- Prime once. The REVOKE in step 1 has already run by this point, so this should observe
  -- lesson_media_exposed() = false and no-op (return 0) — it only alerts if something
  -- re-granted access in the brief window between step 1 and here.
  begin
    perform public.lesson_media_guard_enforce();
  exception when others then
    begin
      insert into public.admin_actions (actor_user_id, action, details)
      values (null, 'lesson_media_guard_prime_failed', jsonb_build_object('error', sqlerrm, 'at', now()));
    exception when others then null; end;
  end;
end $$;
