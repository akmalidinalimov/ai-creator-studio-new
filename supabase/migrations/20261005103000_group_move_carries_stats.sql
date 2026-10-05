-- A student moved to another group keeps everything they did there (owner request, 2026-10-05:
-- "when a user is moved to another group, their statistics moves").
--
-- WHAT ALREADY MOVES (verified on prod 2026-10-05, no change here):
--   * points, totals, tiers, badges, lessons, homework and grades are per USER (xp_events, user_xp,
--     homework_submissions), never per group;
--   * every group board, rating, teacher roster and admin group view reads profiles.group_id live;
--   * chat + media points earned in the NEW group's chat before the platform caught up are back-filled by the
--     existing trigger trg_profiles_challenge_retro_credit (challenge_retro_attach 'link_trigger' → scoped engine
--     pass). It ran for the 14 students moved to 4-GURUH on 10-03 (11 media + 46 chat awards) and for the two
--     moved to 1-GURUH today;
--   * ungraded homework of the last 48 h is re-sent to the NEW group's teachers by reconcile_teacher_dm_queue.
--
-- WHAT DID NOT MOVE (the gap this closes): two engines SETTLE a post that does not match the sender's profile
-- group, and a settled row is never looked at again:
--   1. DAILY TASKS. challenge_task_capture() records a post in another group's KUNLIK VAZIFALAR topic as
--      outcome 'wrong_group' (no submission) and hints the student to their profile group's topic. When the admin
--      then moves the student to the group they actually post in, that day's task stays lost. Evidence: Kamronbek
--      Qalandarov — profile 2-GURUH, 9 of his 10 chat messages since 10-01 are in 3-GURUH, and his daily-task photo
--      there this morning (04:49 UTC) is 'wrong_group'.
--   2. Q&A POINTS. challenge_qa_apply() settles a pair whose answerer / asker is not (yet) in the pair's group as
--      'answerer_moved' / 'asker_moved'. 0 such rows today (the Q&A went live this morning), but the next student
--      who answers in their real group before being moved loses those points the same way.
--
-- THE FIX (one primitive, one trigger, one heal, one detector):
--   * challenge_group_move_carry(profile, new_group): replays the student's 'wrong_group' daily-task posts that were
--     made in the NEW group's topic through challenge_task_capture(.., 'reconciler') — the same engine, checker,
--     lateness (judged on the post's own time) and caps as a live post; and re-opens the student's *_moved Q&A pairs
--     of the NEW group (award_status → NULL) so the next challenge_qa_apply() pass judges them again under every
--     normal rule. Each replay is its own sub-block: a failure, or an outcome that writes no ledger row, rolls the
--     message back to 'wrong_group' untouched. Writes admin_actions 'group_move_carried' (DB-visible).
--   * trg_profiles_zz_group_move_carry: AFTER UPDATE OF group_id, a real change only. Never fails the profile
--     write — an error becomes admin_actions 'group_move_carry_error'. AFTER trigger, so lint E11 / the column
--     guard's ordering (BEFORE triggers) is untouched; it sorts after sync_group_enrollment so the new enrollment
--     already exists when capture judges scope.
--   * HEAL: every profile that already sits in the group of one of its 'wrong_group' posts (today: one student,
--     3 text posts on Sunday 10-04, when no task was open — the engine will record them as such). Capped at 20; the
--     watchdog's hourly sweep carries any rest, and any carry that could not run (engine paused, an error).
--   * Q&A pairs of a week whose challenge_weekly_results are already frozen are NOT reopened (apply stamps the xp
--     at the answer's / question's own time, which would change a closed board) — counted as qa_frozen_kept.
--   * DETECTOR challenge_group_mismatch_watchdog() (hourly :41, DMs admins 08:00–22:00 Tashkent, one alert per
--     student per 20 h): a challenge student whose daily-task post was refused as 'wrong_group' in the last 26 h, or
--     who wrote ≥ 3 messages in other challenge groups in 48 h and none in their own. That is the upstream cause —
--     a profile that points at the wrong group — surfaced BEFORE the student complains. A student moved in the last
--     48 h (admin_actions 'group_moved', written by the trigger on every real move) is not flagged for chat history in
--     the old group. Only the students shown in the DM (≤ 15) are marked alerted. State in app_settings
--     'group_mismatch_watchdog_state'.

-- ───────────────────────────── 1. the primitive ─────────────────────────────
create or replace function public.challenge_group_move_carry(_profile uuid, _new_group uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  _m record;
  _msg jsonb;
  _r jsonb;
  _oc text;
  _replayed int := 0;
  _kept int := 0;
  _no_inbox int := 0;
  _outcomes jsonb := '{}'::jsonb;
  _err text;
  _qa int := 0;
  _qa_frozen int := 0;
  _paused boolean;
begin
  if _profile is null or _new_group is null then
    return jsonb_build_object('status', 'noop');
  end if;
  -- Only for the group the student is in NOW (a late or repeated call for an older move does nothing).
  if not exists (select 1 from public.profiles p where p.id = _profile and p.group_id = _new_group) then
    return jsonb_build_object('status', 'stale');
  end if;

  -- 1. DAILY TASKS. With the engine paused, capture answers 'disabled' and writes no row: replay nothing then
  --    (the rows stay 'wrong_group' and the next move / an explicit call can carry them).
  _paused := not coalesce((public.challenge_tasks_config()->>'active')::boolean, false);
  if not _paused then
    for _m in
      select m.chat_id, m.message_id
        from public.challenge_task_messages m
       where m.user_id = _profile and m.group_id = _new_group and m.outcome = 'wrong_group'
       order by m.sent_at, m.message_id
    loop
      select w.raw_update->'message' into _msg
        from public.webhook_inbox w
       where w.chat_id = _m.chat_id and w.message_id = _m.message_id and w.update_type = 'message'
         and jsonb_typeof(w.raw_update->'message') = 'object'
       order by w.received_at
       limit 1;
      if _msg is null then
        _no_inbox := _no_inbox + 1;
        continue;
      end if;
      begin
        delete from public.challenge_task_messages
         where chat_id = _m.chat_id and message_id = _m.message_id and outcome = 'wrong_group';
        _r := public.challenge_task_capture(_msg, 'reconciler', '{}'::jsonb);
        _oc := coalesce(_r->>'outcome', 'unknown');
        -- An outcome that writes no ledger row (or another 'wrong_group') would lose the trace: undo, keep the row.
        if _oc = 'wrong_group'
           or not exists (select 1 from public.challenge_task_messages x
                           where x.chat_id = _m.chat_id and x.message_id = _m.message_id) then
          raise exception 'carry_keep:%', _oc;
        end if;
        _replayed := _replayed + 1;
        _outcomes := _outcomes || jsonb_build_object(_oc, coalesce((_outcomes->>_oc)::int, 0) + 1);
      exception when others then
        _kept := _kept + 1;
        if sqlerrm not like 'carry_keep:%' then
          _err := left(sqlerrm, 300);
        else
          _outcomes := _outcomes || jsonb_build_object('kept_' || substr(sqlerrm, 12),
                                                       coalesce((_outcomes->>('kept_' || substr(sqlerrm, 12)))::int, 0) + 1);
        end if;
      end;
    end loop;
  end if;

  -- 2. Q&A. Only the pairs of the NEW group that were settled because THIS student was not in it yet. The next
  --    challenge_qa_apply() pass (every 10 min, inside reconcile_challenge_social_xp) re-judges them under every
  --    normal rule and cap; the xp ref key keeps a payout single.
  --    NOT into a frozen week: apply stamps the answer's xp at answer_sent_at and the asker's at question_sent_at,
  --    so a pair of a week whose challenge_weekly_results are frozen would change a closed board. Those stay settled
  --    (counted as qa_frozen_kept).
  select count(*) into _qa_frozen
    from public.challenge_qa_candidates c
   where c.group_id = _new_group
     and c.status = 'judged' and not c.shadow_only
     and ((c.award_status = 'answerer_moved' and c.answerer_id = _profile)
          or (c.award_status = 'asker_moved' and c.asker_id = _profile))
     and (public.challenge_task_week_frozen_at(c.answer_sent_at) is not null
          or (c.question_sent_at is not null and public.challenge_task_week_frozen_at(c.question_sent_at) is not null));
  update public.challenge_qa_candidates c
     set award_status = null, updated_at = now()
   where c.group_id = _new_group
     and c.status = 'judged' and not c.shadow_only
     and ((c.award_status = 'answerer_moved' and c.answerer_id = _profile)
          or (c.award_status = 'asker_moved' and c.asker_id = _profile))
     and public.challenge_task_week_frozen_at(c.answer_sent_at) is null
     and (c.question_sent_at is null or public.challenge_task_week_frozen_at(c.question_sent_at) is null);
  get diagnostics _qa = row_count;

  if _replayed + _kept + _no_inbox + _qa + _qa_frozen > 0 or _paused then
    begin
      insert into public.admin_actions (actor_user_id, action, target_user_id, details)
      values (auth.uid(), 'group_move_carried', _profile, jsonb_build_object(
        'group_id', _new_group, 'tasks_replayed', _replayed, 'tasks_kept', _kept, 'tasks_no_inbox', _no_inbox,
        'task_outcomes', _outcomes, 'task_error', _err, 'tasks_paused', _paused, 'qa_reopened', _qa, 'qa_frozen_kept', _qa_frozen, 'at', now()));
    exception when others then null;
    end;
  end if;

  return jsonb_build_object('status', 'ok', 'tasks_replayed', _replayed, 'tasks_kept', _kept,
                            'tasks_no_inbox', _no_inbox, 'task_outcomes', _outcomes, 'task_error', _err,
                            'tasks_paused', _paused, 'qa_reopened', _qa, 'qa_frozen_kept', _qa_frozen);
end
$fn$;

revoke execute on function public.challenge_group_move_carry(uuid, uuid) from public, anon, authenticated;
grant execute on function public.challenge_group_move_carry(uuid, uuid) to service_role;

-- ───────────────────────────── 2. the trigger ─────────────────────────────
create or replace function public.profiles_group_move_carry()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  if new.group_id is null or new.group_id is not distinct from old.group_id then
    return null;
  end if;
  begin
    insert into public.admin_actions (actor_user_id, action, target_user_id, details)
    values (auth.uid(), 'group_moved', new.id,
            jsonb_build_object('old_group', old.group_id, 'new_group', new.group_id, 'at', now()));
  exception when others then null;
  end;
  begin
    perform public.challenge_group_move_carry(new.id, new.group_id);
  exception when others then
    -- Never fail the move itself. This row is the signal.
    begin
      insert into public.admin_actions (actor_user_id, action, target_user_id, details)
      values (auth.uid(), 'group_move_carry_error', new.id, jsonb_build_object(
        'old_group', old.group_id, 'new_group', new.group_id, 'error', left(sqlerrm, 300), 'sqlstate', sqlstate,
        'at', now()));
    exception when others then null;
    end;
  end;
  return null;
end
$fn$;

revoke execute on function public.profiles_group_move_carry() from public, anon, authenticated;

drop trigger if exists trg_profiles_zz_group_move_carry on public.profiles;
create trigger trg_profiles_zz_group_move_carry
  after update of group_id on public.profiles
  for each row
  when (old.group_id is distinct from new.group_id and new.group_id is not null)
  execute function public.profiles_group_move_carry();

-- ───────────────────────────── 3. heal ─────────────────────────────
do $$
declare
  _p record;
  _r jsonb;
  _n int := 0;
  _done int := 0;
  _replayed int := 0;
begin
  if exists (select 1 from public.admin_actions where action = 'group_move_carry_healed') then
    raise notice 'group move carry: already healed';
    return;
  end if;
  select count(distinct m.user_id) into _n
    from public.challenge_task_messages m
    join public.profiles p on p.id = m.user_id and p.group_id = m.group_id
   where m.outcome = 'wrong_group';
  -- At most 20 here (evidence: 1); anything beyond is carried by the watchdog's hourly sweep (section 4).
  for _p in
    select distinct m.user_id, m.group_id
      from public.challenge_task_messages m
      join public.profiles p on p.id = m.user_id and p.group_id = m.group_id
     where m.outcome = 'wrong_group'
     limit 20
  loop
    _r := public.challenge_group_move_carry(_p.user_id, _p.group_id);
    _done := _done + 1;
    _replayed := _replayed + coalesce((_r->>'tasks_replayed')::int, 0);
  end loop;
  insert into public.admin_actions (actor_user_id, action, details)
  values (null, 'group_move_carry_healed', jsonb_build_object(
    'migration', '20261005103000', 'students', _n, 'carried', _done, 'tasks_replayed', _replayed, 'at', now()));
end $$;

-- ───────────────────────────── 4. the detector ─────────────────────────────
create or replace function public.challenge_group_mismatch_watchdog()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  _hour int := extract(hour from (now() at time zone 'Asia/Tashkent'))::int;
  _found int := 0;
  _new int := 0;
  _lines text;
  _msg text;
  _tok text;
  _admin record;
  _dm int := 0;
  _n_shown int := 0;
  _sweep record;
  _carried int := 0;
begin
  -- 0. SWEEP (the reconciler leg): a student already in the group of a refused daily-task post whose carry did not
  --    run (the task engine was paused at move time, or the carry errored) is carried now. Bounded per run.
  for _sweep in
    select distinct m.user_id, m.group_id
      from public.challenge_task_messages m
      join public.profiles p on p.id = m.user_id and p.group_id = m.group_id
     where m.outcome = 'wrong_group'
     limit 20
  loop
    begin
      perform public.challenge_group_move_carry(_sweep.user_id, _sweep.group_id);
      _carried := _carried + 1;
    exception when others then null;
    end;
  end loop;

  drop table if exists pg_temp._mm;
  drop table if exists pg_temp._shown;
  create temporary table _mm on commit drop as
  with scope as (
    select s.id from public.challenge_scope_group_ids() s(id)
  ), students as (
    select p.id, p.group_id, p.name, p.last_name, p.telegram_username, p.telegram_id
      from public.profiles p
     where p.group_id in (select id from scope)
       and p.status = 'active' and p.archived_at is null
       and not exists (select 1 from public.user_roles r
                        where r.user_id = p.id and r.role in ('admin', 'superadmin', 'teacher'))
  ), refused as (
    -- a daily-task post refused because the profile points at another group
    select m.user_id, m.group_id as wrote_in, count(*) as n
      from public.challenge_task_messages m
      join students s on s.id = m.user_id
     where m.outcome = 'wrong_group' and m.sent_at > now() - interval '26 hours'
       and m.group_id is distinct from s.group_id
     group by 1, 2
  ), chat as (
    select e.profile_id, e.group_id, count(*) as n
      from public.group_message_events e
     where e.sent_at > now() - interval '48 hours' and e.profile_id is not null
       and e.group_id in (select id from scope)
       and not coalesce(e.is_anon_admin, false)
     group by 1, 2
  ), elsewhere as (
    -- writes only in other challenge groups' chats: ≥ 3 messages there, none in their own
    select s.id as user_id,
           (array_agg(c.group_id order by c.n desc))[1] as wrote_in,
           sum(c.n)::int as n
      from students s
      join chat c on c.profile_id = s.id and c.group_id <> s.group_id
     where not exists (select 1 from chat c2 where c2.profile_id = s.id and c2.group_id = s.group_id)
       -- a student moved in the last 48 h has their history in the old chat: not a mismatch
       and not exists (select 1 from public.admin_actions a
                        where a.action = 'group_moved' and a.target_user_id = s.id
                          and a.created_at > now() - interval '48 hours')
     group by s.id
    having sum(c.n) >= 3
  )
  select s.id, s.name, s.last_name, s.telegram_username,
         gp.name as profile_group,
         gw.name as wrote_group,
         coalesce(r.n, 0)::int as refused_tasks,
         coalesce(e.n, 0)::int as chat_elsewhere
    from students s
    left join refused r on r.user_id = s.id
    left join elsewhere e on e.user_id = s.id
    join public.groups gp on gp.id = s.group_id
    join public.groups gw on gw.id = coalesce(r.wrote_in, e.wrote_in)
   where r.user_id is not null or e.user_id is not null;

  select count(*) into _found from pg_temp._mm;

  -- one alert per student per 20 h
  delete from pg_temp._mm m
   where exists (select 1 from public.admin_actions a
                  where a.action = 'group_mismatch_alerted' and a.target_user_id = m.id
                    and a.created_at > now() - interval '20 hours');
  select count(*) into _new from pg_temp._mm;

  if _new > 0 and _hour between 8 and 21 then
    -- The DM shows at most 15; only those are marked alerted, the rest come in the next run.
    create temporary table _shown on commit drop as
      select * from pg_temp._mm order by refused_tasks desc, chat_elsewhere desc, name limit 15;
    select count(*) into _n_shown from pg_temp._shown;
    select string_agg(
             E'\n• ' || trim(coalesce(m.name, '') || ' ' || coalesce(m.last_name, ''))
             || case when coalesce(m.telegram_username, '') <> '' then ' (@' || replace(m.telegram_username, '@', '') || ')' else '' end
             || ' — platformada ' || m.profile_group || ', yozayotgan joyi ' || m.wrote_group
             || case when m.refused_tasks > 0 then ' · kunlik vazifasi qabul qilinmadi (' || m.refused_tasks || ')' else '' end
             || case when m.chat_elsewhere > 0 then ' · ' || m.chat_elsewhere || ' ta xabar' else '' end,
             '' order by m.name)
      into _lines
      from pg_temp._shown m;

    _msg := '👥 Guruhi mos kelmayotgan o''quvchilar: ' || _new
            || coalesce(_lines, '')
            || case when _new > _n_shown then E'\n… yana ' || (_new - _n_shown) || ' ta keyingi tekshiruvda.' else '' end
            || E'\n\nAgar o''quvchi haqiqatan o''sha guruhda bo''lsa, Admin → O''quvchilar orqali guruhini almashtiring: '
            || 'ballari, kunlik vazifasi va savol-javob ballari avtomatik o''tadi.';

    select value->>'bot_token' into _tok from public.platform_settings where key = 'telegram';
    if coalesce(_tok, '') <> '' then
      for _admin in
        select distinct p.telegram_id from public.profiles p
          join public.user_roles ro on ro.user_id = p.id and ro.role in ('admin', 'superadmin')
         where p.telegram_id is not null limit 3
      loop
        begin
          perform public.ops_net_post(
            p_url        := 'https://api.telegram.org/bot' || _tok || '/sendMessage',
            p_body       := jsonb_build_object('chat_id', _admin.telegram_id, 'text', left(_msg, 3900),
                                               'disable_web_page_preview', true),
            p_headers    := jsonb_build_object('Content-Type', 'application/json'),
            p_purpose    := 'challenge_group_mismatch_watchdog',
            p_timeout_ms := 5000);
          _dm := _dm + 1;
        exception when others then null; end;
      end loop;
    end if;

    if _dm > 0 then
      insert into public.admin_actions (actor_user_id, action, target_user_id, details)
      select null, 'group_mismatch_alerted', m.id, jsonb_build_object(
               'profile_group', m.profile_group, 'wrote_group', m.wrote_group,
               'refused_tasks', m.refused_tasks, 'chat_elsewhere', m.chat_elsewhere, 'at', now())
        from pg_temp._shown m;
    end if;
  end if;

  insert into public.app_settings (key, value)
  values ('group_mismatch_watchdog_state', jsonb_build_object(
    'found', _found, 'new', _new, 'shown', _n_shown, 'dm_attempted', _dm, 'swept_carried', _carried,
    'quiet_hours', not (_hour between 8 and 21),
    'checked_at', now()))
  on conflict (key) do update set value = excluded.value;

  return jsonb_build_object('found', _found, 'new', _new, 'shown', _n_shown, 'dm_attempted', _dm,
                            'swept_carried', _carried, 'checked_at', now());
end
$fn$;

revoke execute on function public.challenge_group_mismatch_watchdog() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'challenge-group-mismatch-watchdog') then
    perform cron.unschedule('challenge-group-mismatch-watchdog');
  end if;
  perform cron.schedule('challenge-group-mismatch-watchdog', '41 * * * *',
                        'select public.challenge_group_mismatch_watchdog()');
end $$;
