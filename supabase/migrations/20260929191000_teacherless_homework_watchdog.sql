-- DETECTOR: homework that no teacher will be told about (prevention hierarchy layer 5).
--
-- WHY (read-only evidence from production, 2026-09-29).
--   Both teacher-DM enqueue paths take a submission's teachers to be groups.teacher_id UNION
--   group_teachers of the student's group. When that set is empty they write ONE admin_actions row
--   and return without queueing anything:
--     * telegram-bot-webhook notifyTeachersOfSubmission (index.ts:6531-6543) and
--       submit-homework enqueueTeacherDm (index.ts:138-149): action 'homework_submission_dm_sent',
--       details.reason 'no_teacher', queued false. (Same shape with reason 'no_group' when the
--       student has no group: webhook index.ts:6515, submit-homework index.ts:118.)
--   Nothing reads those rows: no watchdog, no field of hw_dm_health_stats(). The only later catch is
--   cron-ungraded-homework-reminder (hourly, 08:00-22:00 Tashkent). After a submission has been
--   ungraded for 24 h, and only if the group's PRIMARY teacher is missing or unreachable, it DMs every
--   admin about that one submission, up to 3 times, 24 h apart.
--   A teacher assigned later does not fix the old ones: reconcile_teacher_dm_queue() (every 15 min)
--   backfills teacher DMs only for submissions with submitted_at inside the last 48 hours. After that,
--   the teacher never gets a "new homework" DM for them.
--   A sibling with the same outcome: a group whose teachers are all unreachable. The bot's immediate
--   send (index.ts:6656-6657) and the drainer (notify-homework-submission index.ts:105-106) skip a
--   teacher with no telegram_id or with notifications_enabled = false. The bot's skip goes only to the
--   function log. The drainer closes the row as 'notifications_disabled_or_no_telegram', and
--   hw_dm_health_stats() leaves that error out of errors_24h on purpose.
--   Today: the 4 AI CREATORS CHALLENGE 6.0 groups (course f502f631-2104-4834-b6c2-702cd3080e27,
--   published) have teacher_id NULL, no group_teachers row and 0 members. The owner plans to add students before
--   assigning teachers. The 3 AI CREATORS 5.0 groups each have a teacher with a telegram_id and
--   notifications on. 0 'no_teacher' / 'no_group' rows have ever been written (2774
--   homework_submission_dm_sent rows, all with no reason).
--
-- WHAT ALARMS (hourly at :13). DM to up to 3 admins via public.ops_net_post:
--   (a) groups of a PUBLISHED course with >= 1 active, non-archived, non-staff student (no teacher,
--       admin or superadmin role) and NO teacher who can get a DM. Kind 'no_teacher' = no teacher
--       assigned at all (groups.teacher_id NULL and no group_teachers row). Kind 'unreachable_teacher'
--       = teachers are assigned, but none has a telegram_id with notifications on. These are the exact
--       rules both senders and the drainer use.
--   (b) ungraded submissions (score NULL or score_is_stale, the reconciler's own definition) from the
--       last 7 days, by an active student whose current group has no reachable teacher, or who has
--       no group. It reports the count, the age of the oldest, how many are older than 24 h and how
--       many are older than 48 h (the backfill horizon). The 7-day window keeps an old, abandoned
--       submission from alarming forever. (a) keeps alarming for as long as the group stays
--       teacherless.
--   (c) 'no_teacher' / 'no_group' homework_submission_dm_sent rows in the last 24 h. This is the
--       senders' own evidence. It does not depend on this SQL's view of the groups, and it covers
--       unpublished courses too.
--   Cadence: one alert when the episode starts. Another when something NEW appears: a new group in
--   (a), or homework arriving from a group not yet reported in (b). Another when the oldest pending
--   submission crosses 24 h or 48 h. Good news (a group gets a teacher, homework gets graded) is
--   silent until everything clears. Otherwise at most one reminder every 24 h while it persists, and
--   one "recovered" message when it clears.
--
-- WHY NOT A FIELD IN hw_dm_health_stats(). The only thing that ASSERTS on that endpoint is
-- .github/workflows/hw-dm-health.yml, and agent PRs may not touch .github/**. So a new field would be
-- logged by the verifier but never checked. It would cost a pinned rewrite of a 9.4k-character
-- function that other open branches may also be editing. What the out-of-band verifier is for is
-- still covered: this watchdog's state row is named 'teacherless_homework_watchdog_state', so
-- hw_dm_health_stats().stale_watchdogs, which the verifier DOES assert (fail = email), reports it if
-- this cron stops for 25 h. The condition itself is an owner configuration gap, not a
-- Telegram-delivery failure, so a Telegram DM is the right channel. A Telegram outage is caught
-- separately by telegram_send_broken_24h.
--
-- DESIGNED-OUT:
--   * NULL as a verdict: counts come from count(*); an unreadable report (NULL, or health() raised)
--     is itself an alarm, keyed 'unreadable'. Casts of state jsonb text are regex-guarded.
--   * A future last_alert_ms (clock skew, hand edit) is clamped to now and written back clamped, so
--     it heals within one cycle instead of suppressing re-alerts.
--   * The cooldown starts only when a DM was actually attempted. With no bot token or no admin
--     telegram_id, the next hourly run retries.
--   * Telegram's 4096-character limit: the text is capped at 15 group lines and cut at 3900.
--   * The DM goes through ops_net_post with an explicit Content-Type, so a failed send lands in
--     ops_http_failures (ops_http_failure_watchdog) and the bot token is scrubbed from the stored URL.
--   * Member forgiveness: only STUDENTS in a group count toward (a). Staff do not, and nothing here
--     touches a student's own flow.
--
-- STRUCTURE. teacherless_homework_health() is read-only (LANGUAGE sql, STABLE). The alert decision and
-- the DM text are pure IMMUTABLE functions, so the deploy self-test can unit-test them with fixed
-- vectors. teacherless_homework_watchdog() is the only function that writes or sends anything.
--
-- DEPLOY SELF-TEST: calls ONLY the read-only health() and the two pure functions. It never calls the
-- watchdog, so it cannot DM or mutate what it checks; it needs no JWT and takes no lock. It asserts
-- that the verdict is well-formed, not that it is false: if the owner adds students to a teacherless
-- group before this lands, the migration must still apply and the first cron run must alarm. The
-- state seed is ON CONFLICT DO NOTHING and records no notification, so it cannot hide that first
-- alarm.
--
-- KILL-SWITCH: select cron.unschedule('teacherless-homework-watchdog');
-- Idempotent + replay-safe: new function names (none existed on 2026-09-29), CREATE OR REPLACE,
-- unschedule before schedule, a state seed that never overwrites, and an audit row guarded by
-- NOT EXISTS.

create or replace function public.teacherless_homework_health()
returns jsonb
language sql
stable
set search_path to 'public'
as $function$
  with teachers as (
    -- Every teacher of every group: primary UNION co-teachers, the set both enqueue paths fan out to.
    select g.id as group_id, g.teacher_id from public.groups g where g.teacher_id is not null
    union
    select gt.group_id, gt.teacher_id from public.group_teachers gt
  ),
  grp as (
    select g.id,
           exists (select 1 from teachers t where t.group_id = g.id) as has_teacher,
           -- Reachable = the drainer's and the bot's own send condition: a telegram_id, notifications on.
           exists (select 1 from teachers t
                   join public.profiles tp on tp.id = t.teacher_id
                   where t.group_id = g.id
                     and tp.telegram_id is not null
                     and tp.notifications_enabled is not false) as has_reachable_teacher
    from public.groups g
  ),
  flagged as (
    select g.id as group_id, g.name, c.title as course,
           case when gr.has_teacher then 'unreachable_teacher' else 'no_teacher' end as kind,
           s.students
    from public.groups g
    join public.courses c on c.id = g.course_id and c.published
    join grp gr on gr.id = g.id
    cross join lateral (
      select count(*)::int as students
      from public.profiles p
      where p.group_id = g.id and p.archived_at is null and p.status = 'active'
        and not exists (select 1 from public.user_roles r
                        where r.user_id = p.id and r.role in ('teacher', 'admin', 'superadmin'))
    ) s
    where not gr.has_reachable_teacher and s.students > 0
  ),
  pending as (
    select hs.id, p.group_id,
           extract(epoch from (now() - hs.submitted_at)) / 3600.0 as age_h
    from public.homework_submissions hs
    join public.profiles p on p.id = hs.user_id and p.archived_at is null and p.status = 'active'
    left join grp gr on gr.id = p.group_id
    where (hs.score is null or hs.score_is_stale)
      and hs.submitted_at > now() - interval '7 days'
      and coalesce(gr.has_reachable_teacher, false) = false
  ),
  ev as (
    select count(*) filter (where a.details->>'reason' = 'no_teacher')::int as no_teacher,
           count(*) filter (where a.details->>'reason' = 'no_group')::int as no_group
    from public.admin_actions a
    where a.action = 'homework_submission_dm_sent'
      and a.created_at > now() - interval '24 hours'
      and a.details->>'reason' in ('no_teacher', 'no_group')
  ),
  agg as (
    select
      (select count(*)::int from flagged) as groups_n,
      (select count(*)::int from flagged where kind = 'no_teacher') as no_teacher_n,
      (select count(*)::int from flagged where kind = 'unreachable_teacher') as unreachable_n,
      (select coalesce(jsonb_agg(jsonb_build_object('group_id', f.group_id, 'name', f.name,
                                                    'course', f.course, 'students', f.students,
                                                    'kind', f.kind)
                                 order by f.course, f.name, f.group_id), '[]'::jsonb)
         from flagged f) as groups,
      (select count(*)::int from pending) as pend_n,
      (select floor(max(age_h))::int from pending) as oldest_h,
      (select count(*)::int from pending where age_h >= 24) as over24,
      (select count(*)::int from pending where age_h >= 48) as over48,
      (select count(*)::int from pending where group_id is null) as no_group_n,
      -- What the alert is ABOUT: one key per affected group and leg. A key that was not in the last
      -- delivered alert means news (a new group, homework arriving in a group); a key disappearing is
      -- good news and stays silent until everything clears.
      (select coalesce(jsonb_agg(k order by k), '[]'::jsonb) from (
         select 'a:' || f.group_id::text || ':' || f.kind as k from flagged f
         union
         select 'b:' || coalesce(pd.group_id::text, 'none') from pending pd
       ) ks) as keys
  )
  select jsonb_build_object(
    'alarm', agg.groups_n > 0 or agg.pend_n > 0 or ev.no_teacher > 0 or ev.no_group > 0,
    'teacherless_groups', agg.groups_n,
    'no_teacher_groups', agg.no_teacher_n,
    'unreachable_teacher_groups', agg.unreachable_n,
    'groups', agg.groups,
    'pending', agg.pend_n,
    'pending_oldest_hours', agg.oldest_h,
    'pending_over_24h', agg.over24,
    'pending_over_48h', agg.over48,
    'pending_no_group', agg.no_group_n,
    -- 0 none, 1 fresh (< 24 h), 2 approaching the 48 h backfill horizon, 3 past it.
    'pending_stage', case when agg.pend_n = 0 then 0
                          when agg.oldest_h >= 48 then 3
                          when agg.oldest_h >= 24 then 2
                          else 1 end,
    'no_teacher_events_24h', ev.no_teacher,
    'no_group_events_24h', ev.no_group,
    'keys', agg.keys,
    'window', '7 days',
    'checked_at', now())
  from agg, ev
$function$;

-- 'alert' | 'recovered' | 'none'. Pure: the caller passes the state row and the clock.
-- state.notified_keys is the key set of the last DELIVERED alert of the current episode; it is not an
-- array when nothing has been delivered yet (new episode, or every send so far failed).
create or replace function public.teacherless_homework_alert_decision(
  p_alarm boolean, p_keys jsonb, p_stage integer, p_state jsonb, p_now_ms bigint)
returns text
language sql
immutable
set search_path to 'public'
as $function$
  select case
    -- An unreadable verdict is an alarm, never a quiet "false".
    when coalesce(p_alarm, true) then
      case
        when jsonb_typeof(p_state->'notified_keys') is distinct from 'array'
          then 'alert'
        when exists (select 1
                     from jsonb_array_elements_text(case when jsonb_typeof(p_keys) = 'array' then p_keys
                                                         else '["unreadable"]'::jsonb end) k(key)
                     where not ((p_state->'notified_keys') ? k.key))
          then 'alert'
        when coalesce(p_stage, 0) > (case when coalesce(p_state->>'notified_stage', '') ~ '^[0-9]{1,2}$'
                                          then (p_state->>'notified_stage')::int else 0 end)
          then 'alert'
        when p_now_ms - least(case when coalesce(p_state->>'last_alert_ms', '') ~ '^[0-9]{1,15}$'
                                   then (p_state->>'last_alert_ms')::bigint else 0 end,
                              p_now_ms) >= 86400000
          then 'alert'
        else 'none'
      end
    when coalesce(p_state->>'alerting', '') = 'true' then 'recovered'
    else 'none'
  end
$function$;

-- The DM text. Pure, so the self-test can check it. Plain text (no parse_mode): group names are not
-- escaped anywhere, so HTML/Markdown would break on a name with '<' or '_'.
create or replace function public.teacherless_homework_alert_text(p_report jsonb, p_kind text)
returns text
language plpgsql
immutable
set search_path to 'public'
as $function$
declare
  _msg text := '';
  _g jsonb;
  _shown int := 0;
  _groups int;
  _pending int;
  _oldest int;
  _over24 int;
  _over48 int;
  _no_group int;
  _events int;
begin
  if p_kind = 'recovered' then
    return '✅ Oʻqituvchisiz guruh signali tugadi: talabasi bor har bir faol kurs guruhida DM oladigan '
        || 'oʻqituvchi bor va soʻnggi 7 kunda oʻqituvchisiz qolgan baholanmagan vazifa yoʻq.';
  end if;

  if p_report is null or jsonb_typeof(p_report -> 'alarm') is distinct from 'boolean' then
    return '⚠️ Oʻqituvchisiz-guruh watchdog holatni oʻqiy olmadi, shuning uchun oʻqituvchisiz guruhlar '
        || 'hozir tekshirilmayapti: ' || left(coalesce(p_report::text, 'NULL'), 500);
  end if;

  _groups   := case when jsonb_typeof(p_report -> 'groups') = 'array'
                    then jsonb_array_length(p_report -> 'groups') else 0 end;
  _pending  := case when coalesce(p_report->>'pending', '') ~ '^[0-9]{1,9}$'
                    then (p_report->>'pending')::int else 0 end;
  _oldest   := case when coalesce(p_report->>'pending_oldest_hours', '') ~ '^[0-9]{1,9}$'
                    then (p_report->>'pending_oldest_hours')::int end;
  _over24   := case when coalesce(p_report->>'pending_over_24h', '') ~ '^[0-9]{1,9}$'
                    then (p_report->>'pending_over_24h')::int else 0 end;
  _over48   := case when coalesce(p_report->>'pending_over_48h', '') ~ '^[0-9]{1,9}$'
                    then (p_report->>'pending_over_48h')::int else 0 end;
  _no_group := case when coalesce(p_report->>'pending_no_group', '') ~ '^[0-9]{1,9}$'
                    then (p_report->>'pending_no_group')::int else 0 end;
  _events   := (case when coalesce(p_report->>'no_teacher_events_24h', '') ~ '^[0-9]{1,9}$'
                     then (p_report->>'no_teacher_events_24h')::int else 0 end)
             + (case when coalesce(p_report->>'no_group_events_24h', '') ~ '^[0-9]{1,9}$'
                     then (p_report->>'no_group_events_24h')::int else 0 end);

  if _groups > 0 then
    _msg := '🚨 Oʻqituvchisiz guruh: bu guruhlarda talaba vazifa topshirsa, hech bir oʻqituvchiga '
         || 'xabar bormaydi.';
    for _g in select value from jsonb_array_elements(p_report -> 'groups') loop
      exit when _shown >= 15;
      _msg := _msg || E'\n• ' || coalesce(_g->>'name', '?') || ' (' || coalesce(_g->>'course', '?') || '): '
           || coalesce(_g->>'students', '?') || ' talaba — '
           || case when _g->>'kind' = 'unreachable_teacher'
                   then 'oʻqituvchi bor, lekin bot unga DM yubora olmaydi (Telegram ulanmagan yoki '
                        || 'bildirishnomalar oʻchirilgan)'
                   else 'oʻqituvchi biriktirilmagan' end;
      _shown := _shown + 1;
    end loop;
    if _groups > _shown then
      _msg := _msg || E'\n…va yana ' || (_groups - _shown) || ' ta guruh.';
    end if;
  end if;

  if _pending > 0 then
    _msg := _msg || case when _msg = '' then '' else E'\n\n' end
         || '⏳ Oʻqituvchisi yoʻq baholanmagan vazifalar (soʻnggi 7 kun): ' || _pending || ' ta'
         || coalesce(', eng eskisi ' || _oldest || ' soat oldin topshirilgan', '') || '.'
         || case when _no_group > 0
                 then ' Ulardan ' || _no_group || ' tasi guruhsiz talabalarniki.' else '' end;
    -- reconcile_teacher_dm_queue() queues a DM for a NEWLY assigned teacher only for submissions of
    -- the last 48 h. (A row already closed for an unreachable teacher is not reopened, so the text
    -- says "new teacher".)
    if _over48 > 0 then
      _msg := _msg || E'\n🚨 ' || _over48 || ' tasi 48 soatdan oshgan: endi yangi oʻqituvchi biriktirilsa '
           || 'ham, ular haqida "yangi vazifa" DM avtomatik yuborilmaydi (tiklash faqat oxirgi 48 '
           || 'soatni qamraydi). Ularni aicreator.academy/admin/homework da koʻrib chiqing.';
    elsif _over24 > 0 then
      _msg := _msg || E'\n⚠️ ' || _over24 || ' tasi 24 soatdan oshgan: 48 soat toʻlguncha guruhga DM '
           || 'oladigan yangi oʻqituvchi biriktirilsa, ular haqida unga DM avtomatik yuboriladi, keyin '
           || 'esa yuborilmaydi.';
    end if;
  end if;

  if _events > 0 then
    _msg := _msg || case when _msg = '' then '' else E'\n\n' end
         || '📥 Soʻnggi 24 soatda ' || _events || ' ta topshiriq "oʻqituvchi yoʻq" yoki "guruh yoʻq" '
         || 'sababli hech bir oʻqituvchiga yuborilmadi.';
  end if;

  if _msg = '' then
    -- alarm without any readable detail: say so rather than send an empty message.
    return '⚠️ Oʻqituvchisiz-guruh watchdog signal berdi, lekin tafsilotlarni oʻqiy olmadi: '
        || left(p_report::text, 500);
  end if;

  return _msg || E'\n\nGuruhga oʻqituvchi biriktiring: aicreator.academy/admin/groups';
end;
$function$;

create or replace function public.teacherless_homework_watchdog()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  _r jsonb;
  _err text;
  _alarm boolean;
  _keys jsonb;
  _stage int;
  _state jsonb;
  _action text;
  _now_ms bigint := (extract(epoch from now()) * 1000)::bigint;
  _last_ms bigint;
  _notified_keys jsonb;
  _notified_stage int;
  _tok text;
  _admin record;
  _msg text;
  _dm int := 0;
begin
  select value into _state from public.app_settings where key = 'teacherless_homework_watchdog_state';

  begin
    _r := public.teacherless_homework_health();
  exception when others then
    _err := sqlerrm;
    _r := null;
  end;

  _alarm := coalesce((_r->>'alarm') = 'true', true);
  _keys := case when jsonb_typeof(_r->'keys') = 'array' then _r->'keys' else '["unreadable"]'::jsonb end;
  _stage := case when coalesce(_r->>'pending_stage', '') ~ '^[0-3]$' then (_r->>'pending_stage')::int else 0 end;

  _action := public.teacherless_homework_alert_decision(_alarm, _keys, _stage, _state, _now_ms);

  if _action in ('alert', 'recovered') then
    select value->>'bot_token' into _tok from public.platform_settings where key = 'telegram';
    if coalesce(_tok, '') <> '' then
      _msg := public.teacherless_homework_alert_text(
                coalesce(_r, jsonb_build_object('error', coalesce(_err, 'health() returned NULL'))), _action);
      for _admin in
        select distinct p.telegram_id from public.profiles p
        join public.user_roles ro on ro.user_id = p.id and ro.role in ('admin', 'superadmin')
        where p.telegram_id is not null limit 3
      loop
        begin
          perform public.ops_net_post(
            p_url        := 'https://api.telegram.org/bot' || _tok || '/sendMessage',
            p_body       := jsonb_build_object('chat_id', _admin.telegram_id, 'text', left(_msg, 3900)),
            p_headers    := jsonb_build_object('Content-Type', 'application/json'),
            p_purpose    := 'teacherless_homework_watchdog',
            p_timeout_ms := 5000);
          _dm := _dm + 1;
        exception when others then null; end;
      end loop;
    end if;

    begin
      insert into public.admin_actions (actor_user_id, action, details)
      values (null,
              case when _action = 'alert' then 'teacherless_homework_watchdog_ALARM'
                   else 'teacherless_homework_watchdog_recovered' end,
              coalesce(_r, jsonb_build_object('error', _err)) || jsonb_build_object('dm_attempted', _dm));
    exception when others then null; end;
  end if;

  -- State. last_alert_ms is clamped to now and written back clamped (heals a future value).
  _last_ms := least(case when coalesce(_state->>'last_alert_ms', '') ~ '^[0-9]{1,15}$'
                         then (_state->>'last_alert_ms')::bigint else 0 end, _now_ms);
  _notified_keys := case when jsonb_typeof(_state->'notified_keys') = 'array' then _state->'notified_keys' end;
  _notified_stage := case when coalesce(_state->>'notified_stage', '') ~ '^[0-9]{1,2}$'
                          then (_state->>'notified_stage')::int else 0 end;
  if not _alarm then
    _notified_keys := null;                                -- episode over: the next one alerts afresh
    _notified_stage := 0;
  elsif _action = 'alert' and _dm > 0 then
    _notified_keys := _keys;                               -- only a send that was attempted counts
    _notified_stage := _stage;
    _last_ms := _now_ms;
  elsif _action = 'none' then
    _notified_keys := _keys;                               -- 'none' means no new key: a shrink, silent
    _notified_stage := least(_notified_stage, _stage);     -- de-escalation is silent; re-escalation alerts
  end if;
  -- (alert with no DM attempted: keep the old values, so the next hourly run retries)

  insert into public.app_settings (key, value)
  values ('teacherless_homework_watchdog_state', jsonb_build_object(
    'alerting', _alarm,
    'notified_keys', _notified_keys,
    'notified_stage', _notified_stage,
    'last_alert_ms', _last_ms,
    'last_action', _action,
    'dm_attempted_last_run', _dm,
    'teacherless_groups', coalesce(_r->'teacherless_groups', 'null'::jsonb),
    'pending', coalesce(_r->'pending', 'null'::jsonb),
    'last_report', coalesce(_r, jsonb_build_object('error', _err)),
    'checked_at', now()))
  on conflict (key) do update set value = excluded.value;

  return coalesce(_r, jsonb_build_object('error', _err, 'alarm', true));
end;
$function$;

-- House pattern: PUBLIC first, then the roles; only service_role (and the owner) may run them.
revoke execute on function public.teacherless_homework_health() from public, anon, authenticated;
grant  execute on function public.teacherless_homework_health() to service_role;
revoke execute on function public.teacherless_homework_alert_decision(boolean, jsonb, integer, jsonb, bigint) from public, anon, authenticated;
grant  execute on function public.teacherless_homework_alert_decision(boolean, jsonb, integer, jsonb, bigint) to service_role;
revoke execute on function public.teacherless_homework_alert_text(jsonb, text) from public, anon, authenticated;
grant  execute on function public.teacherless_homework_alert_text(jsonb, text) to service_role;
revoke execute on function public.teacherless_homework_watchdog() from public, anon, authenticated;
grant  execute on function public.teacherless_homework_watchdog() to service_role;

-- Hourly at :13. No other job runs hourly at minute 13 (the every-minute drainers and the */4, */5
-- jobs aside), and it is off the :00/:30 pile-up.
do $$
begin
  perform cron.unschedule('teacherless-homework-watchdog');
exception when others then null;
end $$;

do $$
begin
  perform cron.schedule('teacherless-homework-watchdog', '13 * * * *',
                        $cmd$ select public.teacherless_homework_watchdog() $cmd$);
exception when others then
  insert into public.admin_actions (actor_user_id, action, details)
  values (null, 'cron_schedule_failed',
          jsonb_build_object('job', 'teacherless-homework-watchdog', 'error', sqlerrm));
end $$;

-- Deploy self-test (read-only health + pure-function unit vectors) + state seed. See the header.
do $$
declare
  _r jsonb;
  _now bigint := 1790000000000;
  _ab jsonb := '["a:g1:no_teacher", "b:g1"]';
  _a  jsonb := '["a:g1:no_teacher"]';
  _st jsonb;
  _t text;
  _big jsonb;
  _case record;
begin
  -- 1. health(): read-only, must return a well-formed verdict (true OR false).
  _r := public.teacherless_homework_health();
  if _r is null or jsonb_typeof(_r -> 'alarm') is distinct from 'boolean' then
    raise exception 'ABORT: teacherless_homework_health() returned no verdict: %', coalesce(_r::text, 'NULL');
  end if;
  if jsonb_typeof(_r -> 'keys') is distinct from 'array'
     or jsonb_typeof(_r -> 'groups') is distinct from 'array'
     or coalesce(_r->>'pending_stage', '') !~ '^[0-3]$'
     or jsonb_typeof(_r -> 'pending') is distinct from 'number'
     or jsonb_typeof(_r -> 'no_teacher_events_24h') is distinct from 'number' then
    raise exception 'ABORT: teacherless_homework_health() report is malformed: %', _r;
  end if;

  -- 2. alert decision: fixed vectors (pure, IMMUTABLE).
  _st := jsonb_build_object('alerting', true, 'notified_keys', _ab, 'notified_stage', 1,
                            'last_alert_ms', _now - 3600000);
  for _case in
    select * from (values
      ('healthy, no state',              false, _ab, 0, null::jsonb,                                 'none'),
      ('healthy after an alarm',         false, _ab, 0, _st,                                         'recovered'),
      ('healthy, never alerted',         false, _ab, 0, jsonb_build_object('alerting', false),       'none'),
      ('first alarm, no state',          true,  _ab, 1, null::jsonb,                                 'alert'),
      ('same keys, same stage, 1h later',true,  _ab, 1, _st,                                         'none'),
      ('a key disappears (good news)',   true,  _a,  1, _st,                                         'none'),
      ('a new key appears',              true,  _ab || '["a:g2:no_teacher"]'::jsonb, 1, _st,         'alert'),
      ('stage escalates 1 -> 2',         true,  _ab, 2, _st,                                         'alert'),
      ('stage de-escalates 1 -> 0',      true,  _ab, 0, _st,                                         'none'),
      ('24h since the last alert',       true,  _ab, 1, _st || jsonb_build_object('last_alert_ms', _now - 86400000), 'alert'),
      ('23h since the last alert',       true,  _ab, 1, _st || jsonb_build_object('last_alert_ms', _now - 82800000), 'none'),
      ('future last_alert_ms clamped',   true,  _ab, 1, _st || jsonb_build_object('last_alert_ms', _now + 999999999), 'none'),
      ('malformed last_alert_ms',        true,  _ab, 1, _st || jsonb_build_object('last_alert_ms', 'x'), 'alert'),
      ('nothing delivered this episode', true,  _ab, 1, _st || jsonb_build_object('notified_keys', null), 'alert'),
      ('malformed notified_keys',        true,  _ab, 1, _st || jsonb_build_object('notified_keys', 'x'), 'alert'),
      ('events only, already notified',  true,  '[]'::jsonb, 0, _st,                                 'none'),
      ('events only, new episode',       true,  '[]'::jsonb, 0, _st - 'notified_keys',               'alert'),
      ('unreadable verdict (NULL)',      null,  null::jsonb, 0, _st,                                 'alert')
    ) v(label, alarm, keys, stage, state, expected)
  loop
    if public.teacherless_homework_alert_decision(_case.alarm, _case.keys, _case.stage, _case.state, _now)
       is distinct from _case.expected then
      raise exception 'ABORT: alert_decision(%) = %, expected %', _case.label,
        public.teacherless_homework_alert_decision(_case.alarm, _case.keys, _case.stage, _case.state, _now),
        _case.expected;
    end if;
  end loop;

  -- 3. DM text: fixed vectors (pure, IMMUTABLE).
  _t := public.teacherless_homework_alert_text(jsonb_build_object(
          'alarm', true,
          'groups', jsonb_build_array(jsonb_build_object('name', 'SELFTEST GURUH', 'course', 'SELFTEST KURS',
                                                         'students', 5, 'kind', 'no_teacher')),
          'pending', 3, 'pending_oldest_hours', 30, 'pending_over_24h', 1, 'pending_over_48h', 0,
          'pending_no_group', 0, 'no_teacher_events_24h', 2, 'no_group_events_24h', 0), 'alert');
  if position('SELFTEST GURUH (SELFTEST KURS): 5 talaba' in _t) = 0
     or position('oʻqituvchi biriktirilmagan' in _t) = 0
     or position('3 ta, eng eskisi 30 soat' in _t) = 0
     or position('1 tasi 24 soatdan oshgan' in _t) = 0
     or position('48 soatdan oshgan' in _t) > 0
     or position('2 ta topshiriq' in _t) = 0
     or position('admin/groups' in _t) = 0 then
    raise exception 'ABORT: alert_text (one group) is wrong: %', _t;
  end if;

  select jsonb_build_object('alarm', true, 'pending', 0, 'no_teacher_events_24h', 0,
           'groups', jsonb_agg(jsonb_build_object('name', 'G' || i, 'course', 'K', 'students', 1,
                                                  'kind', 'unreachable_teacher') order by i))
    into _big from generate_series(1, 20) i;
  _t := public.teacherless_homework_alert_text(_big, 'alert');
  if position('va yana 5 ta guruh' in _t) = 0 or position('DM yubora olmaydi' in _t) = 0
     or position('G16' in _t) > 0 or length(_t) > 3900 then
    raise exception 'ABORT: alert_text (20 groups) is wrong: %', _t;
  end if;

  _t := public.teacherless_homework_alert_text(jsonb_build_object(
          'alarm', true, 'groups', '[]'::jsonb, 'pending', 2, 'pending_oldest_hours', 50,
          'pending_over_24h', 2, 'pending_over_48h', 1, 'pending_no_group', 1), 'alert');
  if position('2 ta, eng eskisi 50 soat' in _t) = 0 or position('1 tasi guruhsiz' in _t) = 0
     or position('1 tasi 48 soatdan oshgan' in _t) = 0 or position('24 soatdan oshgan' in _t) > 0
     or position('Oʻqituvchisiz guruh:' in _t) > 0 then
    raise exception 'ABORT: alert_text (pending only) is wrong: %', _t;
  end if;

  if left(public.teacherless_homework_alert_text(null, 'recovered'), 1) <> '✅'
     or position('oʻqiy olmadi' in public.teacherless_homework_alert_text(null, 'alert')) = 0
     or position('oʻqiy olmadi' in public.teacherless_homework_alert_text(
                   jsonb_build_object('error', 'boom'), 'alert')) = 0 then
    raise exception 'ABORT: alert_text (recovered / unreadable) is wrong';
  end if;

  -- 4. State seed: never overwrites, records NO notification, so a live alarm at deploy time still
  --    produces the first cron run's DM.
  insert into public.app_settings (key, value)
  values ('teacherless_homework_watchdog_state', jsonb_build_object(
    'alerting', false,
    'notified_keys', null,
    'notified_stage', 0,
    'last_alert_ms', 0,
    'seeded_by', '20260929191000',
    'last_report', _r,
    'checked_at', now()))
  on conflict (key) do nothing;

  insert into public.admin_actions (actor_user_id, action, details)
  select null, 'teacherless_homework_watchdog_installed',
         jsonb_build_object('migration', '20260929191000',
                            'cron', 'teacherless-homework-watchdog 13 * * * *',
                            'alarm_at_deploy', _r->'alarm',
                            'teacherless_groups_at_deploy', _r->'teacherless_groups',
                            'pending_at_deploy', _r->'pending',
                            'at', now())
  where not exists (select 1 from public.admin_actions
                    where action = 'teacherless_homework_watchdog_installed');
end $$;
