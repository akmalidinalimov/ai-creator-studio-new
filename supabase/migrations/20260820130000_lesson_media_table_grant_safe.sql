-- CORRECTS 20260820120000_lesson_media_revoke_enforce.sql: the column-level REVOKE it
-- applied was a NO-OP, so the video-source paywall hole it claimed to close is still open.
--
-- WHY THE PRIOR FIX DID NOTHING: Postgres privilege resolution is additive across grant
-- levels — a TABLE-level GRANT to a role covers every column of that table regardless of
-- any COLUMN-level REVOKE issued against the same role afterwards (or before). Confirmed
-- live on public.lessons: `select relacl from pg_class where relname='lessons'` shows
-- `anon=arwdDxtm/postgres, authenticated=arwdDxtm/postgres` — full table-level SELECT (the
-- 'r' in arwdDxtm) — inherited from a blanket `GRANT ALL ON ALL TABLES IN SCHEMA public`
-- (the standard Supabase default-privileges grant, re-applied by routine schema
-- migrations). The 20260820120000 migration ran
-- `REVOKE SELECT (video_url, provider_video_id, video_storage_path) ON public.lessons
-- FROM anon, authenticated` — a column-level revoke — which cannot subtract from a
-- table-level grant that is still in force. Verified still-broken immediately before this
-- migration: `has_column_privilege('authenticated','public.lessons','provider_video_id',
-- 'SELECT')` = true, `has_table_privilege('authenticated','public.lessons','SELECT')` =
-- true. RLS already exposes every published lesson row to anon/authenticated
-- ("lessons read" USING(true)), so the raw Bunny provider_video_id / video_url is still
-- directly SELECT-able by anyone, completely bypassing the enrollment / has_module_access
-- check the lesson-video-url edge function enforces.
--
-- THE CORRECTED MECHANISM: the only way to keep a role able to read *some* columns of a
-- table while permanently blocking a specific subset is to hold NO table-level SELECT at
-- all, and instead hold column-level SELECT on exactly the columns that should be
-- readable. So this migration:
--   1. REVOKEs the table-level SELECT on public.lessons from anon and authenticated
--      (removing the 'r' bit that was overriding every column-level revoke), then
--   2. GRANTs column-level SELECT on the 13 SAFE columns only — the 3 sensitive
--      video-source columns (video_url, video_storage_path, provider_video_id) are simply
--      never granted, so there is nothing for a future column-REVOKE to fight against.
-- Table-level SELECT and a column-level GRANT that lists every "safe" column are NOT
-- equivalent look-alikes: the column list is authoritative and additive-only, so any
-- future blanket `GRANT ALL ON ALL TABLES IN SCHEMA public` will re-add table-level
-- SELECT (re-opening the hole) but will NOT retroactively add columns beyond what a
-- column-level grant already lists — the drift this creates is still caught by the
-- unchanged lesson_media_exposed() detector below, same as before.
--
-- UNTOUCHED: service_role keeps its full table-level `arwdDxtm` (confirmed live,
-- unaffected by this migration) — edge functions using the service_role key (
-- lesson-video-url, admin lesson CRUD, migrate-storage-to-bunny, bunny-upload-init, etc.)
-- read every column exactly as before. INSERT/UPDATE/DELETE grants are untouched; RLS
-- already gates writes on public.lessons, and this migration scopes only to SELECT.
-- has_role/is_group_teacher/is_teacher_of are not touched.
--
-- NOTHING LEGITIMATE BREAKS: audited every `.from("lessons")` call site in src/ and
-- supabase/functions/ — none select("*"); every anon/authenticated-context read already
-- names explicit columns, and none of them name video_url, video_storage_path, or
-- provider_video_id:
--   - src/pages/LessonPage.tsx: "id, title, description, module_id, position, published,
--     video_provider, duration_seconds, modules(course_id)"
--   - src/pages/Dashboard.tsx: "id, position, title, duration_seconds, modules!inner(...)"
--   - src/pages/admin/AdminCourseEditor.tsx: "id, title, position, published,
--     video_provider, duration_seconds, has_video"
--   - src/components/lesson/HomeworkSection.tsx: "module_id, position" / "position"
-- Admin/teacher UI that needs the raw video pointers (src/components/admin/
-- LessonDrawer.tsx) already reads them via the SECURITY DEFINER staff_get_lesson() RPC,
-- never a direct table SELECT, so it is unaffected. video_provider and has_video — needed
-- by the frontend to know a video exists and which player to use, without exposing where
-- it lives — are included in the safe-column grant, matching the prior migration's intent.
--
-- Mirrors 20260820120000_lesson_media_revoke_enforce.sql's detector/enforcer/cron/alert
-- shape; only the repair action inside the enforcer changes (see step 2 below). Fully
-- idempotent (create or replace + guarded cron unschedule-if-exists), safe to re-apply.

-- 1. The real fix: remove the table-level SELECT that was overriding every column-level
--    revoke, then grant SELECT on only the 13 safe columns. video_url, video_storage_path,
--    and provider_video_id are never granted here — that's what makes the revoke stick.
REVOKE SELECT ON public.lessons FROM anon, authenticated;

GRANT SELECT (
  id, module_id, title, description, duration_seconds, position, transcript, resources,
  created_at, published, video_provider, thumbnail_path, has_video
) ON public.lessons TO anon, authenticated;

-- 2. Detector: unchanged byte-for-byte from 20260820120000. Still correct — it checks
--    has_column_privilege on the 3 sensitive columns directly, which is agnostic to
--    whether the exposure came from a table-level or column-level grant.
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
--
--    ONLY CHANGE FROM 20260820120000: the repair action inside this function. The old
--    version re-ran the ineffective column-REVOKE. This version re-runs the correct pair —
--    revoke table SELECT, then grant SELECT on the 13 safe columns — so a repeat blanket
--    `GRANT ALL ON ALL TABLES` drift is actually repaired, not just re-masked. Everything
--    else (detector call, admin_actions insert, Telegram alert, return value, exception
--    handling) is unchanged.
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
  -- Re-apply the corrected fix immediately, then raise the alarm.
  execute 'revoke select on public.lessons from anon, authenticated';
  execute 'grant select (id, module_id, title, description, duration_seconds, position, '
       || 'transcript, resources, created_at, published, video_provider, thumbnail_path, '
       || 'has_video) on public.lessons to anon, authenticated';

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

-- 4. Reschedule the enforcer to every 5 minutes (was every 10) to shrink the post-deploy
--    re-grant window. Guarded so a cron failure can never roll back the function
--    definitions above, and any failure is recorded in admin_actions (do-blocks otherwise
--    swallow errors — teacher-engagement-nudge lesson).
do $$
begin
  begin
    if exists (select 1 from cron.job where jobname = 'lesson-media-guard') then
      perform cron.unschedule('lesson-media-guard');
    end if;
    perform cron.schedule('lesson-media-guard', '*/5 * * * *', $cmd$ select public.lesson_media_guard_enforce() $cmd$);
  exception when others then
    begin
      insert into public.admin_actions (actor_user_id, action, details)
      values (null, 'lesson_media_guard_cron_failed', jsonb_build_object('error', sqlerrm, 'at', now()));
    exception when others then null; end;
  end;

  -- Prime once. The REVOKE/GRANT in step 1 has already run by this point, so this should
  -- observe lesson_media_exposed() = false and no-op (return 0) — it only alerts if
  -- something re-granted access in the brief window between step 1 and here.
  begin
    perform public.lesson_media_guard_enforce();
  exception when others then
    begin
      insert into public.admin_actions (actor_user_id, action, details)
      values (null, 'lesson_media_guard_prime_failed', jsonb_build_object('error', sqlerrm, 'at', now()));
    exception when others then null; end;
  end;
end $$;
