-- Homework attribution: complete the SAP step-display class-fix (#46) + add a watchdog (2026-08-03).
--
-- #46 fixed the edge-function display paths (tn = sap_number for SAP sub-steps). Review found TWO
-- more DB write-paths that still stamped homework_teacher_dm_queue.task_number with the PARENT
-- ordinal (a.task_number) for SAP leaves — so the teacher DM again read "Vazifa 3" for every step:
--   1. reconcile_teacher_dm_queue()  — the 15-min reconciler, re-inserting SAP rows.
--   2. admin_retag_submission()      — every teacher retag onto a SAP sub-task.
-- Both are patched below to the sap-aware step (mirrors displayStepNumber: SAP leaf → sap_number,
-- else task_number). Functions reproduced VERBATIM from their last migrations
-- (20260711170000, 20260711180000); the ONLY change is the one task_number expression in each.
-- (CREATE OR REPLACE preserves existing privileges; the revokes are re-issued idempotently.)
--
-- Then a watchdog that AUTO-HEALS not-yet-sent rows and ALERTS if a delivered SAP row is ever wrong
-- again (a regression), plus surfaces the auto-guess ("(taxminiy)") backlog for human review.

-- ── 1) Class-fix: reconciler ────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.reconcile_teacher_dm_queue()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  _n1 int := 0; _n2 int := 0;
  _tash timestamptz := now() + interval '5 hours';
  _hour int := extract(hour from _tash)::int;
  _sched timestamptz;
begin
  if _hour >= 22 then _sched := date_trunc('day', _tash) + interval '1 day' + interval '8 hours' - interval '5 hours';
  elsif _hour < 8 then _sched := date_trunc('day', _tash) + interval '8 hours' - interval '5 hours';
  else _sched := now(); end if;

  -- CYCLE RULE: a submission cycle counts as notified only if a queue row was created at/after
  -- this cycle's submitted_at. URL match is NOT sufficient (append/RPC resubmit cycles keep the
  -- old URL — that blindness hid 8 of one student's resubmissions).

  -- Pass 1: RE-OPEN the existing row when the same (submission, teacher, url) row exists but
  -- predates the cycle (unique index forbids a duplicate insert). The drainer redelivers it.
  update homework_teacher_dm_queue q set
    sent_at = null, error = null, retry_count = 0,
    scheduled_for = _sched, queued_for_quiet_hours = (_hour >= 22 or _hour < 8),
    created_at = now(),
    assignment_title = case when q.assignment_title like '%(tiklandi)%' then q.assignment_title
                            else q.assignment_title || ' (tiklandi)' end
  from homework_submissions hs
  join profiles p on p.id = hs.user_id
  join groups g on g.id = p.group_id and g.teacher_id is not null
  where q.submission_id = hs.id and q.teacher_id = g.teacher_id
    and q.message_url = hs.telegram_message_url
    and hs.source = 'telegram_topic'
    and (hs.score is null or hs.score_is_stale)
    and hs.submitted_at > now() - interval '48 hours'
    and hs.submitted_at < now() - interval '10 minutes'
    and not exists (select 1 from homework_teacher_dm_queue q2
                     where q2.submission_id = hs.id and q2.created_at >= hs.submitted_at - interval '2 minutes');
  get diagnostics _n1 = row_count;

  -- Pass 2: INSERT for cycles whose URL is new (no matching row exists).
  insert into homework_teacher_dm_queue
    (submission_id, teacher_id, student_id, group_id, module_id, assignment_id,
     module_number, task_number, assignment_title, student_name, message_url,
     scheduled_for, queued_for_quiet_hours)
  select hs.id, g.teacher_id, hs.user_id, g.id, a.module_id, a.id,
         m.position + 1, case when a.parent_id is not null then coalesce(a.sap_number, a.task_number, 1) else coalesce(a.task_number, 1) end,
         a.title || ' (tiklandi)',
         (coalesce(nullif(trim(coalesce(p.name,'') || ' ' || coalesce(p.last_name,'')), ''), '—')
           || case when coalesce(p.telegram_username,'') <> '' then ' (@' || replace(p.telegram_username,'@','') || ')' else '' end),
         hs.telegram_message_url,
         _sched, (_hour >= 22 or _hour < 8)
  from homework_submissions hs
  join profiles p on p.id = hs.user_id
  join groups g on g.id = p.group_id and g.teacher_id is not null
  join homework_assignments a on a.id = hs.assignment_id
  join modules m on m.id = a.module_id
  where hs.source = 'telegram_topic'
    and hs.telegram_message_url is not null
    and (hs.score is null or hs.score_is_stale)
    and hs.submitted_at > now() - interval '48 hours'
    and hs.submitted_at < now() - interval '10 minutes'
    and not exists (select 1 from homework_teacher_dm_queue q2
                     where q2.submission_id = hs.id and q2.created_at >= hs.submitted_at - interval '2 minutes')
    and not exists (select 1 from homework_teacher_dm_queue q3
                     where q3.submission_id = hs.id and q3.teacher_id = g.teacher_id and q3.message_url = hs.telegram_message_url)
  on conflict do nothing;
  get diagnostics _n2 = row_count;

  if (_n1 + _n2) > 0 then raise log 'reconcile_teacher_dm_queue: reopened %, inserted %', _n1, _n2; end if;
  return _n1 + _n2;
end;
$function$;
revoke execute on function public.reconcile_teacher_dm_queue() from public, anon, authenticated;

-- ── 2) Class-fix: retag ─────────────────────────────────────────────────────────────────────────
create or replace function public.admin_retag_submission(_submission uuid, _new_assignment uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  _sub record;
  _target record;
  _old uuid;
  _media jsonb;
  _survivor uuid;
  _status text;
begin
  select * into _sub from homework_submissions where id = _submission;
  if _sub.id is null then return jsonb_build_object('status', 'not_found'); end if;
  -- Stale = reopened for regrade → movable. Only firm grades are immutable.
  if _sub.score is not null and not coalesce(_sub.score_is_stale, false) then
    return jsonb_build_object('status', 'already_graded', 'submission_id', _sub.id);
  end if;
  _old := _sub.assignment_id;
  if _old = _new_assignment then return jsonb_build_object('status', 'same', 'submission_id', _sub.id); end if;
  if not exists (select 1 from homework_assignments where id = _new_assignment and is_active) then
    return jsonb_build_object('status', 'bad_assignment', 'submission_id', _sub.id);
  end if;

  select * into _target from homework_submissions
   where user_id = _sub.user_id and assignment_id = _new_assignment;

  if _target.id is not null then
    if _target.score is not null and not coalesce(_target.score_is_stale, false) then
      return jsonb_build_object('status', 'target_graded', 'submission_id', _sub.id);
    end if;
    _media := coalesce(_target.media, '[]'::jsonb);
    select _media || coalesce(jsonb_agg(el), '[]'::jsonb) into _media
      from jsonb_array_elements(coalesce(_sub.media, '[]'::jsonb)) el
     where jsonb_array_length(_media) < 10;
    _media := (select coalesce(jsonb_agg(el), '[]'::jsonb) from (
                 select el from jsonb_array_elements(_media) el limit 10) s);
    update homework_submissions set
      media = _media,
      submitted_text = case
        when coalesce(_target.submitted_text, '') = '' then _sub.submitted_text
        when coalesce(_sub.submitted_text, '') = '' or _target.submitted_text like '%' || _sub.submitted_text || '%'
          then _target.submitted_text
        else left(_target.submitted_text || E'\n' || _sub.submitted_text, 4000) end,
      submitted_at = greatest(coalesce(_target.submitted_at, _sub.submitted_at), coalesce(_sub.submitted_at, _target.submitted_at)),
      attempt_number = greatest(coalesce(_target.attempt_number, 1), coalesce(_sub.attempt_number, 1)),
      telegram_chat_id = coalesce(_sub.telegram_chat_id, _target.telegram_chat_id),
      telegram_thread_id = coalesce(_sub.telegram_thread_id, _target.telegram_thread_id),
      telegram_message_id = coalesce(_sub.telegram_message_id, _target.telegram_message_id),
      telegram_message_url = coalesce(_sub.telegram_message_url, _target.telegram_message_url),
      telegram_file_id = coalesce(_sub.telegram_file_id, _target.telegram_file_id),
      telegram_file_kind = coalesce(_sub.telegram_file_kind, _target.telegram_file_kind)
    where id = _target.id;
    update homework_teacher_dm_queue set submission_id = _target.id
     where submission_id = _sub.id and sent_at is null;
    delete from homework_submissions where id = _sub.id;
    delete from xp_events where user_id = _sub.user_id and ref_key = 'hw_submit:' || _old::text;
    _survivor := _target.id; _status := 'merged';
  else
    -- Moving a stale row: carry the old score into previous_score and clear it — the move is
    -- part of a regrade, and the guard trigger permits score-clearing with an attempt bump.
    update homework_submissions set
      assignment_id = _new_assignment,
      previous_score = case when score is not null then score else previous_score end,
      score = null, score_feedback = null, scored_by = null, scored_at = null,
      score_is_stale = false,
      attempt_number = coalesce(attempt_number, 1) + (case when score is not null then 1 else 0 end)
    where id = _sub.id;
    delete from xp_events where user_id = _sub.user_id and ref_key = 'hw_submit:' || _new_assignment::text;
    update xp_events set ref_key = 'hw_submit:' || _new_assignment::text
     where user_id = _sub.user_id and ref_key = 'hw_submit:' || _old::text;
    _survivor := _sub.id; _status := 'moved';
  end if;

  update homework_teacher_dm_queue q set
    assignment_id = _new_assignment,
    module_id = a.module_id,
    module_number = m.position + 1,
    task_number = case when a.parent_id is not null then coalesce(a.sap_number, a.task_number, 1) else coalesce(a.task_number, 1) end,
    assignment_title = a.title
  from homework_assignments a join modules m on m.id = a.module_id
  where a.id = _new_assignment and q.submission_id in (_submission, _survivor);

  insert into user_xp (user_id, total_xp, level, updated_at)
  select e.user_id, sum(e.amount)::int, public.xp_level_for(sum(e.amount)::int), now()
  from xp_events e where e.user_id = _sub.user_id
  group by e.user_id
  on conflict (user_id) do update
    set total_xp = excluded.total_xp, level = excluded.level, updated_at = now();

  begin
    insert into admin_actions (actor_user_id, action, target_user_id, target_resource_type, target_resource_id, details)
    values (auth.uid(), 'homework_retagged', _sub.user_id, 'homework_submission', _survivor,
            jsonb_build_object('from_assignment', _old, 'to_assignment', _new_assignment, 'result', _status));
  exception when others then null;
  end;

  return jsonb_build_object('status', _status, 'submission_id', _survivor);
end;
$$;
revoke execute on function public.admin_retag_submission(uuid, uuid) from public, anon, authenticated;

-- ── 3) Health snapshot (on-demand / future digest use) ───────────────────────────────────────────
create or replace function public.homework_attribution_health()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    -- SAP rows DELIVERED in the last 7 days whose displayed step != real sap step (ages out post-fix).
    'sap_display_wrong_sent_7d', (
      select count(distinct q.submission_id)
      from homework_teacher_dm_queue q
      join homework_assignments a on a.id = q.assignment_id
      where a.parent_id is not null and a.sap_number is not null
        and q.sent_at is not null and q.created_at >= now() - interval '7 days'
        and q.task_number is distinct from a.sap_number),
    -- SAP rows not yet sent whose step is wrong (auto-heal target).
    'sap_display_pending_wrong', (
      select count(distinct q.submission_id)
      from homework_teacher_dm_queue q
      join homework_assignments a on a.id = q.assignment_id
      where a.parent_id is not null and a.sap_number is not null
        and q.sent_at is null and q.task_number is distinct from a.sap_number),
    -- Auto-guessed submissions in the last 7 days that a teacher has not graded yet (pending review).
    'auto_guessed_ungraded_7d', (
      select count(distinct q.submission_id)
      from homework_teacher_dm_queue q
      join homework_submissions s on s.id = q.submission_id
      where q.created_at >= now() - interval '7 days'
        and coalesce(q.assignment_title,'') ~* 'taxminiy'
        and s.score is null)
  );
$$;
revoke execute on function public.homework_attribution_health() from public, anon, authenticated;
grant execute on function public.homework_attribution_health() to service_role;

-- ── 4) Watchdog: heal pending + spot regressions + surface the guess backlog ──────────────────────
create or replace function public.homework_attribution_watchdog()
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  _tok text; _admin record; _healed int := 0; _wrong int := 0; _guessed int := 0;
  _state jsonb; _first boolean; _alerting boolean; _last_ms bigint;
  _now_ms bigint := (extract(epoch from now())*1000)::bigint;
  _since timestamptz; _should_alert boolean := false; _recovered boolean := false; _msg text;
begin
  select value into _state from app_settings where key = 'hw_attribution_watchdog_state';
  _first    := (_state is null);
  _since    := coalesce((_state->>'since')::timestamptz, now()); -- install time, pinned across runs
  _alerting := coalesce((_state->>'alerting')::boolean, false);
  _last_ms  := coalesce((_state->>'last_alert_ms')::bigint, 0);

  -- 1) AUTO-HEAL: correct the step number on NOT-YET-SENT SAP queue rows so any pending teacher DM
  --    (e.g. quiet-hours queued across a deploy) shows the real "Vazifa 1/2/3". Idempotent.
  update public.homework_teacher_dm_queue q
     set task_number = a.sap_number
  from public.homework_assignments a
  where q.assignment_id = a.id
    and a.parent_id is not null and a.sap_number is not null
    and q.sent_at is null
    and q.task_number is distinct from a.sap_number;
  get diagnostics _healed = row_count;

  -- 2) DETECT a display REGRESSION: a SAP row DELIVERED since install with the wrong step number.
  --    Scoped to created_at > install so pre-fix history (already sent, un-fixable) never alerts.
  select count(distinct q.submission_id) into _wrong
  from public.homework_teacher_dm_queue q
  join public.homework_assignments a on a.id = q.assignment_id
  where a.parent_id is not null and a.sap_number is not null
    and q.sent_at is not null
    and q.created_at > _since
    and q.created_at >= now() - interval '7 days'
    and q.task_number is distinct from a.sap_number;

  -- 3) Auto-guess backlog: guessed submissions (last 7d) still awaiting a teacher's grade.
  select count(distinct q.submission_id) into _guessed
  from public.homework_teacher_dm_queue q
  join public.homework_submissions s on s.id = q.submission_id
  where q.created_at >= now() - interval '7 days'
    and coalesce(q.assignment_title,'') ~* 'taxminiy'
    and s.score is null;

  -- Alert policy: a delivered wrong step is a real regression → alert (daily re-alert). Recovery clears.
  if _wrong > 0 then
    if (not _alerting) or (_now_ms - _last_ms > 86400000) then _should_alert := true; end if;
  elsif _alerting then _recovered := true; end if;
  -- First run only: if there's a guess backlog to review, nudge admins once (not a bug — a review ask).
  if _first and _guessed > 0 then _should_alert := true; end if;

  if _should_alert or _recovered then
    select value->>'bot_token' into _tok from platform_settings where key = 'telegram';
    if _tok is not null and _tok <> '' then
      _msg := case
        when _recovered then '✅ Uyga vazifa qadam raqamlari yana to''g''ri ko''rsatilyapti.'
        when _wrong > 0 then '🚨 Vazifa qadam raqami xato ko''rsatildi: ' || _wrong ||
          ' ta topshiriqda (SAP sap_number bilan mos emas). Kodda regressiya bo''lishi mumkin — tekshiring.'
        else '📋 ' || _guessed || ' ta topshiriq avtomatik (taxminiy) belgilangan va hali baholanmagan. ' ||
          'Ustozlar postni ko''rib, noto''g''ri bo''lsa ✏️ bilan to''g''ri vazifaga o''tkazishi mumkin.'
      end;
      if _healed > 0 then
        _msg := _msg || E'\n🔧 ' || _healed || ' ta yuborilmagan bildirishnomadagi raqam tuzatildi.';
      end if;
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
        exception when others then null;
        end;
      end loop;
    end if;
  end if;

  insert into app_settings (key, value) values ('hw_attribution_watchdog_state', jsonb_build_object(
    'since', _since, 'alerting', (_wrong > 0),
    'last_alert_ms', case when _should_alert then _now_ms else _last_ms end,
    'wrong', _wrong, 'guessed_ungraded', _guessed, 'healed_last', _healed, 'checked_at', now()))
  on conflict (key) do update set value = excluded.value;

  return jsonb_build_object('healed', _healed, 'wrong', _wrong, 'guessed_ungraded', _guessed,
                            'alerted', _should_alert, 'recovered', _recovered);
end;
$fn$;
revoke execute on function public.homework_attribution_watchdog() from public, anon, authenticated;
grant execute on function public.homework_attribution_watchdog() to service_role;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'homework-attribution-watchdog') then
    perform cron.unschedule('homework-attribution-watchdog');
  end if;
  perform cron.schedule('homework-attribution-watchdog', '40 5 * * *',
    $cmd$ select public.homework_attribution_watchdog() $cmd$);
end $$;

-- Run once at apply time: pins `since` to the real deploy moment and heals the currently-pending
-- rows immediately. Best-effort — a transient failure must never fail the migration.
do $$ begin perform public.homework_attribution_watchdog(); exception when others then null; end $$;
