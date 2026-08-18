-- Item 4 review fix (2026-08-18), classes D + E: give miniapp-sourced homework submissions the
-- SAME self-heal + observability legs telegram_topic submissions already have.
--
-- D) reconcile_teacher_dm_queue() (last redefined in 20260803210000_homework_attribution_watchdog.sql)
--    only re-derives missing/failed teacher-DM queue rows for `hs.source = 'telegram_topic' AND
--    hs.telegram_message_url IS NOT NULL` — both false for every submit-homework row. If that
--    edge function's enqueue step ever fails (network blip, a future bug), a miniapp submission
--    had NO independent recovery leg at all, unlike telegram_topic submissions which this
--    reconciler has covered since 20260711130000. Widening the source filter alone is not enough:
--    the reconciler's INSERT hard-codes `hs.telegram_message_url` into the NOT NULL `message_url`
--    column, which is always NULL for miniapp rows — that INSERT would itself fail. Fixed by
--    computing message_url per-source: telegram_topic keeps its real message link unchanged;
--    miniapp gets the SAME valid, per-(submission,attempt) bot-deep-link shape submit-homework
--    itself writes (supabase/functions/submit-homework/index.ts) — 'https://t.me/<bot_username>
--    ?start=hw_<submission_id>_<attempt_number>' — sourced from platform_settings.telegram.
--    bot_username (the same place the bot token lives; Deno.env is not reachable from SQL).
--    Reproduced from the last authoritative version verbatim aside from that; every other guard
--    (48h/10min cycle window, the "already notified this cycle" not-exists checks, SAP-aware
--    task_number, quiet-hours scheduling) is unchanged and now shared via a `cycles` CTE per
--    statement so the per-source URL is computed in exactly one place per pass instead of being
--    repeated 2-3x inline, avoiding a drift bug between the reopen-match / insert / insert-dedupe
--    copies.
--
-- E) hw_dm_health_stats() (last redefined in 20260711190000_stress_scenarios_u_batch.sql) only
--    reads homework_teacher_dm_queue. Its existing unsent_overdue/errors_24h/fallback_24h/
--    drainer_age_sec fields are already source-agnostic (they count queue rows regardless of
--    source), so a miniapp row that MADE IT into the queue but failed to send was always visible.
--    The gap is upstream: a submit-homework call whose enqueue step throws (class A) never
--    creates a queue row at all — nothing there for the queue-based metrics to count. That failure
--    is only visible in admin_actions (action='miniapp_homework_submit_failed'). Two new fields
--    fold it in so the daily GitHub verifier (hw-dm-health.yml) trips BEFORE the next complaint,
--    per CLAUDE.md's incident doctrine step 5.

-- ── D: widened reconciler ──────────────────────────────────────────────────────────────────────
create or replace function public.reconcile_teacher_dm_queue()
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  _n1 int := 0; _n2 int := 0;
  _tash timestamptz := now() + interval '5 hours';
  _hour int := extract(hour from _tash)::int;
  _sched timestamptz;
  _bot_username text;
begin
  if _hour >= 22 then _sched := date_trunc('day', _tash) + interval '1 day' + interval '8 hours' - interval '5 hours';
  elsif _hour < 8 then _sched := date_trunc('day', _tash) + interval '8 hours' - interval '5 hours';
  else _sched := now(); end if;

  select value->>'bot_username' into _bot_username from platform_settings where key = 'telegram';
  _bot_username := coalesce(_bot_username, ''); -- degraded-but-still-valid https URL, mirrors submit-homework's own fallback

  -- Pass 1: RE-OPEN the existing row when the same (submission, teacher, url) row exists but
  -- predates the cycle (unique index forbids a duplicate insert). The drainer redelivers it.
  with cycles as (
    select hs.id, hs.user_id, hs.attempt_number, hs.submitted_at,
           case when hs.source = 'miniapp'
                then 'https://t.me/' || _bot_username || '?start=hw_' || hs.id::text || '_' || coalesce(hs.attempt_number, 1)::text
                else hs.telegram_message_url end as expected_url
    from homework_submissions hs
    where hs.source in ('telegram_topic', 'miniapp')
      and (hs.score is null or hs.score_is_stale)
      and hs.submitted_at > now() - interval '48 hours'
      and hs.submitted_at < now() - interval '10 minutes'
  )
  update homework_teacher_dm_queue q set
    sent_at = null, error = null, retry_count = 0,
    scheduled_for = _sched, queued_for_quiet_hours = (_hour >= 22 or _hour < 8),
    created_at = now(),
    assignment_title = case when q.assignment_title like '%(tiklandi)%' then q.assignment_title
                            else q.assignment_title || ' (tiklandi)' end
  from cycles hs
  join profiles p on p.id = hs.user_id
  join groups g on g.id = p.group_id and g.teacher_id is not null
  where q.submission_id = hs.id and q.teacher_id = g.teacher_id
    and q.message_url = hs.expected_url
    and not exists (select 1 from homework_teacher_dm_queue q2
                     where q2.submission_id = hs.id and q2.created_at >= hs.submitted_at - interval '2 minutes');
  get diagnostics _n1 = row_count;

  -- Pass 2: INSERT for cycles whose URL is new (no matching row exists).
  with cycles as (
    select hs.id, hs.user_id, hs.attempt_number, hs.submitted_at, hs.assignment_id,
           case when hs.source = 'miniapp'
                then 'https://t.me/' || _bot_username || '?start=hw_' || hs.id::text || '_' || coalesce(hs.attempt_number, 1)::text
                else hs.telegram_message_url end as expected_url
    from homework_submissions hs
    where hs.source in ('telegram_topic', 'miniapp')
      and (hs.score is null or hs.score_is_stale)
      and hs.submitted_at > now() - interval '48 hours'
      and hs.submitted_at < now() - interval '10 minutes'
  )
  insert into homework_teacher_dm_queue
    (submission_id, teacher_id, student_id, group_id, module_id, assignment_id,
     module_number, task_number, assignment_title, student_name, message_url,
     scheduled_for, queued_for_quiet_hours)
  select hs.id, g.teacher_id, hs.user_id, g.id, a.module_id, a.id,
         m.position + 1, case when a.parent_id is not null then coalesce(a.sap_number, a.task_number, 1) else coalesce(a.task_number, 1) end,
         a.title || ' (tiklandi)',
         (coalesce(nullif(trim(coalesce(p.name,'') || ' ' || coalesce(p.last_name,'')), ''), '—')
           || case when coalesce(p.telegram_username,'') <> '' then ' (@' || replace(p.telegram_username,'@','') || ')' else '' end),
         hs.expected_url,
         _sched, (_hour >= 22 or _hour < 8)
  from cycles hs
  join profiles p on p.id = hs.user_id
  join groups g on g.id = p.group_id and g.teacher_id is not null
  join homework_assignments a on a.id = hs.assignment_id
  join modules m on m.id = a.module_id
  where hs.expected_url is not null
    and not exists (select 1 from homework_teacher_dm_queue q2
                     where q2.submission_id = hs.id and q2.created_at >= hs.submitted_at - interval '2 minutes')
    and not exists (select 1 from homework_teacher_dm_queue q3
                     where q3.submission_id = hs.id and q3.teacher_id = g.teacher_id and q3.message_url = hs.expected_url)
  on conflict do nothing;
  get diagnostics _n2 = row_count;

  if (_n1 + _n2) > 0 then raise log 'reconcile_teacher_dm_queue: reopened %, inserted %', _n1, _n2; end if;
  return _n1 + _n2;
end;
$function$;
revoke execute on function public.reconcile_teacher_dm_queue() from public, anon, authenticated;

-- ── E: fold the miniapp enqueue-failure signal into the health snapshot ──────────────────────────
create or replace function public.hw_dm_health_stats()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  _unsent_overdue int;
  _drainer_age_sec int;
  _errors_24h int;
  _resurrected_24h int;
  _fallback_24h int;
  _uncaptured_24h int;
  _stalest_capture_days int;
  _misconfigured_groups int;
  _miniapp_enqueue_failed_24h int;
  _miniapp_submit_failed_24h int;
begin
  select count(*) into _unsent_overdue from homework_teacher_dm_queue
   where sent_at is null and scheduled_for < now() - interval '15 minutes';

  select coalesce(extract(epoch from now() - max(r.start_time))::int, 999999) into _drainer_age_sec
  from cron.job_run_details r join cron.job j on j.jobid = r.jobid
  where j.jobname = 'notify-homework-submission-every-minute' and r.status = 'succeeded';

  select count(*) into _errors_24h from homework_teacher_dm_queue
   where error is not null
     and error not like 'teacher_no_longer%'
     and error not like 'notifications_disabled%'
     and error not like '%_e2e_test%'
     and coalesce(sent_at, created_at) > now() - interval '24 hours';

  select count(*) into _resurrected_24h from homework_teacher_dm_queue
   where assignment_title like '%(tiklandi)%' and created_at > now() - interval '24 hours';

  select count(*) into _fallback_24h from homework_teacher_dm_queue
   where error = 'sql_fallback_delivery' and sent_at > now() - interval '24 hours';

  select count(*) into _uncaptured_24h
  from webhook_inbox w
  join profiles p on p.telegram_id = w.from_user_id
  join groups g on p.group_id = g.id
               and g.homework_topic_id = w.message_thread_id
               and g.homework_topic_url ilike '%/c/' || regexp_replace(w.chat_id::text, '^-100', '') || '/%'
  where w.update_type = 'message'
    and w.received_at between now() - interval '24 hours' and now() - interval '20 minutes'
    and (w.raw_update->'message' ? 'photo' or w.raw_update->'message' ? 'video' or w.raw_update->'message' ? 'document')
    and not exists (select 1 from user_roles r where r.user_id = p.id and r.role in ('teacher','admin','superadmin'))
    and not exists (select 1 from hw_pending_posts hp
                     where hp.telegram_chat_id = w.chat_id
                       and (hp.first_message_id = w.message_id or hp.media::text like '%/' || w.message_id || '"%'))
    and not exists (select 1 from homework_submissions hs
                     where hs.user_id = p.id
                       and (hs.telegram_message_id = w.message_id or hs.media::text like '%/' || w.message_id || '"%'))
    and not exists (select 1 from hw_pending_posts hp2
                     where hp2.user_id = p.id
                       and hp2.created_at between w.received_at - interval '15 minutes' and w.received_at + interval '4 hours')
    and not exists (select 1 from homework_submissions hs2
                     where hs2.user_id = p.id
                       and hs2.submitted_at between w.received_at - interval '15 minutes' and w.received_at + interval '4 hours');

  select coalesce(max(days), 0)::int into _stalest_capture_days from (
    select extract(day from now() - max(hs.submitted_at))::int as days
    from groups g
    join courses c on c.id = g.course_id and c.published
    join profiles p on p.group_id = g.id
    join homework_submissions hs on hs.user_id = p.id and hs.source = 'telegram_topic'
    group by g.id
  ) t;

  -- U13: active-course groups with real students but broken homework-topic wiring.
  select count(*) into _misconfigured_groups
  from groups g
  join courses c on c.id = g.course_id and c.published
  where (g.homework_topic_url is null or g.homework_topic_id is null)
    and (select count(*) from profiles p where p.group_id = g.id and p.archived_at is null and p.status = 'active') >= 3;

  -- Item 4 (2026-08-18 review fix, class E): a miniapp submit-homework call whose teacher-DM
  -- enqueue step threw (class A bug, now fixed) never creates a homework_teacher_dm_queue row —
  -- nothing for the queue-based metrics above to count. The only trace is the admin_actions health
  -- signal submit-homework writes on every failure. reconcile_teacher_dm_queue() (widened above,
  -- class D) self-heals these from homework_submissions on its next 15-min run regardless, but this
  -- count makes a SUSTAINED failure rate visible to the daily verifier before it's needed to.
  select count(*) into _miniapp_enqueue_failed_24h from admin_actions
   where action = 'miniapp_homework_submit_failed'
     and details->>'reason' = 'notify_enqueue_failed'
     and created_at > now() - interval '24 hours';

  -- Broader signal: any miniapp submission attempt that failed for any reason (auth, validation,
  -- write failure, ...) — general miniapp-path health, not specific to the notification leg.
  select count(*) into _miniapp_submit_failed_24h from admin_actions
   where action = 'miniapp_homework_submit_failed'
     and created_at > now() - interval '24 hours';

  return jsonb_build_object(
    'unsent_overdue', _unsent_overdue,
    'drainer_age_sec', _drainer_age_sec,
    'errors_24h', _errors_24h,
    'resurrected_24h', _resurrected_24h,
    'fallback_24h', _fallback_24h,
    'uncaptured_24h', _uncaptured_24h,
    'stalest_capture_days', _stalest_capture_days,
    'misconfigured_groups', _misconfigured_groups,
    'miniapp_enqueue_failed_24h', _miniapp_enqueue_failed_24h,
    'miniapp_submit_failed_24h', _miniapp_submit_failed_24h,
    'checked_at', now()
  );
end;
$$;
revoke execute on function public.hw_dm_health_stats() from public, anon, authenticated;
