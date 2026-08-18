-- Teacher Mini App — Phase 1, Task 1.
--
-- Produces the grading-queue data source `public.teacher_pending_submissions()` and the
-- `platform_settings.teacher_miniapp` kill-switch row.
--
-- SCOPE (junction-aware): the caller's teacher groups = groups.teacher_id ∪ group_teachers,
-- resolved via public.teacher_group_ids(auth.uid()) (helper shipped in 20260818190000_group_teachers_multi.sql:55).
-- So co-teachers see the same queue as primaries. An admin who is NOT assigned as a teacher of any
-- group gets an empty result by design — this RPC is the teacher-scope queue, not the admin-all queue
-- (the plan's Task 1 interface pins the scope to teacher_group_ids(auth.uid())).
--
-- PENDING (identical rule to the bot's loadGradingSubmissions, index.ts:3393): ungraded OR re-opened
-- (score is null OR score_is_stale) — so a resubmission awaiting regrade resurfaces here too.
--
-- SAP-AWARE task label: replicated byte-for-byte from the DM reconciler
-- (20260818190000_group_teachers_multi.sql:842-843): module_number = modules.position + 1, and
-- task_number = for a child (parent_id not null) the sap_number step, else the raw task_number
-- (see the homework-sap-step-display incident: SAP steps must show sap_number, not task_number).
--
-- Column provenance (verified against the real schema, do-not-invent):
--   homework_submissions: id/user_id/assignment_id/submitted_at/score/submitted_image_url (base
--     20260502233427:24-38), score_is_stale (20260513184202:2), previous_score (20260711110000:7),
--     attempt_number (20260509085603:3), media (20260707020000:7).
--   homework_assignments: id/title/max_score/module_id (base 20260502233427:3-16),
--     task_number (20260503182607:6), parent_id + sap_number (20260506125414:2-3).
--   modules.position (20260426085840:88). profiles.telegram_username CITEXT (20260426101239:27),
--     name/last_name/group_id. platform_settings PK=key, value jsonb (20260426101239:72-77).
--
-- Idempotent (create or replace; on conflict do nothing). SECURITY DEFINER + set search_path=public
-- (reads RLS-protected tables as owner, exactly like the sibling junction helpers). No anon leak.

create or replace function public.teacher_pending_submissions()
returns table (
  submission_id uuid,
  user_id uuid,
  student_name text,
  group_id uuid,
  group_name text,
  module_number int,
  task_number int,
  assignment_id uuid,
  assignment_title text,
  max_score int,
  submitted_at timestamptz,
  previous_score int,
  is_resubmission boolean,
  media jsonb,
  submitted_image_url text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    hs.id                                                                 as submission_id,
    hs.user_id                                                            as user_id,
    -- Same student_name formatting the DM reconciler uses (20260818190000:845-846): trimmed full
    -- name, '—' when blank, and the @username appended only when present (leading '@' stripped).
    (coalesce(nullif(trim(coalesce(p.name, '') || ' ' || coalesce(p.last_name, '')), ''), '—')
       || case when coalesce(p.telegram_username::text, '') <> ''
               then ' (@' || replace(p.telegram_username::text, '@', '') || ')'
               else '' end)                                               as student_name,
    p.group_id                                                            as group_id,
    g.name                                                                as group_name,
    (m.position + 1)                                                      as module_number,
    case when ha.parent_id is not null
         then coalesce(ha.sap_number, ha.task_number, 1)
         else coalesce(ha.task_number, 1) end                            as task_number,
    ha.id                                                                 as assignment_id,
    ha.title                                                              as assignment_title,
    coalesce(ha.max_score, 10)                                            as max_score,
    hs.submitted_at                                                       as submitted_at,
    hs.previous_score                                                     as previous_score,
    (coalesce(hs.attempt_number, 1) > 1)                                  as is_resubmission,
    hs.media                                                              as media,
    hs.submitted_image_url                                                as submitted_image_url
  from homework_submissions hs
  join profiles p              on p.id = hs.user_id
  join groups g                on g.id = p.group_id
  join homework_assignments ha on ha.id = hs.assignment_id      -- FK NOT NULL → never hides work
  join modules m               on m.id = ha.module_id           -- FK NOT NULL → never hides work
  where p.group_id in (select public.teacher_group_ids(auth.uid()))
    and (hs.score is null or hs.score_is_stale is true)
  order by hs.submitted_at asc;
$$;

revoke all on function public.teacher_pending_submissions() from public, anon;
grant execute on function public.teacher_pending_submissions() to authenticated, service_role;

-- Kill-switch row: disabling this flips the keyboard web_app button back to the bot command and
-- clears the per-teacher menu button (Task 7). Insert-only; never clobber an owner-set value.
insert into public.platform_settings (key, value)
values ('teacher_miniapp', '{"enabled": true}'::jsonb)
on conflict (key) do nothing;
