-- Reliability-hardening P0-2: watchdog LIVENESS + a non-Telegram alarm ("who watches the watchmen"
-- + the circular-alert problem). Two blind spots in the detection layer:
--   (a) All 9 in-Supabase watchdogs share pg_cron/pg_net. If that dies, they die SILENTLY together
--       and cannot report their own death. Nothing today asserts the watchdog fleet is even alive.
--   (b) Every watchdog DMs admins over Telegram. If the failure IS Telegram (token revoked, API
--       down), the alarm can't get out — the alert travels over the exact channel that's broken.
-- Fix: fold both signals into hw_dm_health_stats() — read by the OUT-OF-BAND GitHub verifier
-- (hw-dm-health.yml, 03:25 UTC daily), the one leg that survives a total pg_cron OR Telegram outage
-- and alerts via GitHub email. No behavior of any watchdog changes; this only adds observability.
--
-- Reproduced verbatim from the authoritative version (20260818170000_miniapp_dm_reconciler_and_health.sql)
-- aside from the two new counters + three new return keys. The hw-dm-health edge fn spreads the whole
-- RPC result, so the new fields surface with no edge change.

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
  _stale_watchdogs int;
  _stale_watchdog_names text;
  _telegram_send_broken_24h int;
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

  -- Reliability-hardening P0-2 (a): watchdog LIVENESS. Every watchdog on the '<name>_watchdog_state'
  -- naming convention (9 today) ends its run by upserting that row with checked_at = now(). The
  -- slowest of the 9 runs DAILY, so a checked_at older than 25h means that watchdog's cron stopped
  -- firing, or the function errored before its final state upsert. If pg_cron/pg_net itself died, ALL
  -- of them go stale together — and none can report it, because they're the thing that's dead.
  -- Surfaced here so the out-of-band GitHub verifier (which runs on GitHub's servers, not pg_cron)
  -- fails and emails the owner. (25h = daily cadence + ~2h margin: at the 03:25 UTC verify time a
  -- healthy daily watchdog's last run was ~21-23h ago; a missed cycle shows ~45h. Counts EXISTING
  -- stale rows — a row that never existed is a never-deployed watchdog, caught at migration self-test,
  -- not a liveness lapse. Watchdogs NOT on this key convention are not covered; a follow-up could
  -- standardize them onto '<name>_watchdog_state' so liveness coverage becomes total.)
  -- The checked_at cast is on untrusted jsonb text: guard it so one malformed row degrades THIS
  -- signal (and still fails loud: >0 trips the verifier) instead of 500-ing the whole health endpoint
  -- and losing the other 12 fields. Today every one of the 9 rows is written with now() (always valid).
  begin
    select count(*), coalesce(string_agg(replace(key, '_watchdog_state', ''), ', ' order by key), '')
      into _stale_watchdogs, _stale_watchdog_names
    from app_settings
    where key like '%\_watchdog\_state'
      and coalesce((value->>'checked_at')::timestamptz, 'epoch'::timestamptz) < now() - interval '25 hours';
  exception when others then
    _stale_watchdogs := 1;                              -- fail loud (>0), don't crash the endpoint
    _stale_watchdog_names := 'checked_at_cast_error';   -- the name disambiguates from a real staleness
  end;

  -- Reliability-hardening P0-2 (b): "Telegram itself is failing" proxy. Non-recipient (transient/
  -- content) telegram_send_failed only — recipient-class misses (~70% never pressed Start) are
  -- EXPECTED reach and excluded. Baseline is ~0 (0 over the trailing 7d in prod). The in-DB
  -- grade_delivery_watchdog also counts this, but it DMs admins over Telegram — useless when Telegram
  -- is the thing that's broken. Routing the same signal through this endpoint puts it on GitHub email,
  -- the one alarm channel that survives a Telegram outage.
  select count(*) into _telegram_send_broken_24h from admin_actions
   where action = 'telegram_send_failed'
     and coalesce((details->>'recipient_error')::boolean, false) = false
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
    'stale_watchdogs', _stale_watchdogs,
    'stale_watchdog_names', _stale_watchdog_names,
    'telegram_send_broken_24h', _telegram_send_broken_24h,
    'checked_at', now()
  );
end;
$$;
revoke execute on function public.hw_dm_health_stats() from public, anon, authenticated;

-- Deploy-time self-test: surface a typo'd column / bad reference at apply, not at the first verifier
-- call. Read-only; the result is discarded.
do $$
begin
  perform public.hw_dm_health_stats();
exception when others then
  insert into public.admin_actions (actor_user_id, action, details)
  values (null, 'hw_dm_health_stats_selftest_failed', jsonb_build_object('error', sqlerrm));
end $$;
