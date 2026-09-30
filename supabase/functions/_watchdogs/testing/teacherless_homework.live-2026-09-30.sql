CREATE OR REPLACE FUNCTION public.teacherless_homework_health()
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.teacherless_homework_alert_decision(p_alarm boolean, p_keys jsonb, p_stage integer, p_state jsonb, p_now_ms bigint)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.teacherless_homework_alert_text(p_report jsonb, p_kind text)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.teacherless_homework_watchdog()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;
