-- Challenge points: stop paying chatter, pay real questions and helpful answers (owner request, 2026-10-05).
--
-- WHY: students complained that anyone who chats a lot earns points (+1 per message, up to 5 a day) whatever they
-- write, while students who ask real questions or share experience earn nothing for it. On 2026-10-05: chat was 5.9%
-- of all 6.0 points (1,158 points, up to 25 per student in 6 days), and no question or answer had ever paid — the AI
-- judge (challenge-qa-judge) has been judging every question→answer pair in 'shadow' mode (paying nothing).
--
-- THE NEW RULES (owner-approved)
--   * chat: +1 per message → OFF (points.chat = 0). Points already earned stay.
--   * a HELPFUL ANSWER to a real learning / platform question (the AI judge's verdict): +3 to the answerer
--     (qa.mode shadow → live; the existing answer caps stay: 3 answers/day, 2 paid answers per question, …).
--   * a REAL QUESTION that got a helpful answer: +2 to the asker, once per question (new; reason
--     'challenge_question', ref 'ch_ask:<chat>:<question message>').
--   * questions + answers together: at most 10 points per student per Tashkent day (caps.qa_points_per_day = 10; an
--     answer that would cross it is 'capped_daily_total', a question is simply not paid).
--   * own work shared in the group: +5, now at most 2 a day (was 3).
--   * NOT retroactive: every Q&A pair from before this migration is closed as 'out_of_window', so the 6-day shadow
--     backlog (227 answers that would have paid) does not flood totals; last week was already frozen this morning.
--
-- challenge_qa_apply() changes by a PINNED rewrite of the live text (md5 d7fe9e64…): three anchors, each asserted to
-- occur exactly once; owner / ACL / SECURITY DEFINER asserted unchanged. Replay-safe.

-- the daily Q&A points of one student (answers + questions), by the Tashkent date of the event
create or replace function public.challenge_qa_points_on(_user uuid, _day date)
returns integer
language sql
stable
security definer
set search_path = public
as $fn$
  select coalesce(sum(e.amount), 0)::int
    from public.xp_events e
   where e.user_id = _user
     and e.reason in ('challenge_answer', 'challenge_question')
     and (e.created_at at time zone 'Asia/Tashkent')::date = _day
$fn$;
revoke execute on function public.challenge_qa_points_on(uuid, date) from public, anon, authenticated;
grant execute on function public.challenge_qa_points_on(uuid, date) to service_role;

-- the new award status
alter table public.challenge_qa_candidates drop constraint if exists challenge_qa_candidates_award_status_check;
alter table public.challenge_qa_candidates add constraint challenge_qa_candidates_award_status_check
  check (award_status = any (array['awarded', 'not_passed', 'out_of_window', 'answerer_moved', 'asker_moved', 'voided',
                                   'capped_answerer_day', 'capped_pair_7d', 'capped_question', 'capped_asker_day',
                                   'pair_day_already_paid', 'capped_daily_total']));

-- challenge_qa_apply(): the asker's +2 and the daily total
do $$
declare
  _oid oid := to_regprocedure('public.challenge_qa_apply()');
  _src text; _def text; _new text; _acl text; _owner oid; _secdef boolean;
  _a1_old constant text := E'  _pr record;\nbegin\n';
  _a1_new constant text := E'  _pr record;\n'
    || E'  _p_q int := 2; _cap_total int := 10;   -- 20261005070000: the asker''s points and the daily Q&A total\n'
    || E'begin\n';
  _a2_old constant text := E'  _live := _mode = ''live'';\n';
  _a2_new constant text := E'  _live := _mode = ''live'';\n'
    || E'  select case when coalesce(ps.value->''points''->>''question'', '''') ~ ''^[0-9]{1,2}$'' then (ps.value->''points''->>''question'')::int else 2 end,\n'
    || E'         case when coalesce(ps.value->''caps''->>''qa_points_per_day'', '''') ~ ''^[0-9]{1,3}$'' then (ps.value->''caps''->>''qa_points_per_day'')::int else 10 end\n'
    || E'    into _p_q, _cap_total from public.platform_settings ps where ps.key = ''challenge'';\n'
    || E'  _p_q := coalesce(_p_q, 2); _cap_total := coalesce(_cap_total, 10);\n';
  _a3_old constant text := E'    -- Pay under the SHARED community key: one pair-day pays once, whichever engine or run comes first.\n';
  _a3_new constant text := E'    -- The daily Q&A total (20261005070000): answers + questions pay at most _cap_total points per student per\n'
    || E'    -- Tashkent day; an answer that would cross it is not paid.\n'
    || E'    if _st is null and _live\n'
    || E'       and public.challenge_qa_points_on(_r.answerer_id, (_r.answer_sent_at at time zone ''Asia/Tashkent'')::date) + _p > _cap_total then\n'
    || E'      _st := ''capped_daily_total'';\n'
    || E'    end if;\n\n'
    || _a3_old;
  _a4_old constant text := E'            _st := ''awarded'';\n'
    || E'            if not (_r.answerer_id = any(_touched)) then _touched := array_append(_touched, _r.answerer_id); end if;\n';
  _a4_new constant text := _a4_old
    || E'            -- The asker of the real question this helpful answer answered: +_p_q, once per question, inside\n'
    || E'            -- their own daily Q&A total (20261005070000).\n'
    || E'            if _p_q > 0 and _r.asker_id is not null and _r.asker_id <> _r.answerer_id\n'
    || E'               and public.challenge_qa_points_on(_r.asker_id,\n'
    || E'                     (coalesce(_r.question_sent_at, _r.answer_sent_at) at time zone ''Asia/Tashkent'')::date) + _p_q <= _cap_total then\n'
    || E'              insert into public.xp_events (user_id, amount, reason, ref_key, created_at)\n'
    || E'              values (_r.asker_id, _p_q, ''challenge_question'',\n'
    || E'                      ''ch_ask:'' || _r.chat_id::text || '':'' || _r.question_msg_id::text, coalesce(_r.question_sent_at, _r.answer_sent_at))\n'
    || E'              on conflict (user_id, ref_key) do nothing;\n'
    || E'              if found and not (_r.asker_id = any(_touched)) then _touched := array_append(_touched, _r.asker_id); end if;\n'
    || E'            end if;\n';
  _n int;
begin
  if _oid is null then raise exception 'ABORT: challenge_qa_apply() is missing'; end if;
  select prosrc, array_to_string(proacl, ','), proowner, prosecdef into _src, _acl, _owner, _secdef from pg_proc where oid = _oid;
  if position('20261005070000' in _src) > 0 then
    raise notice 'challenge_qa_apply already rewritten';
    return;
  end if;
  if md5(replace(_src, E'\r', '')) <> 'd7fe9e64b84a67b8cfed4a0255b6df2b' then
    raise exception 'ABORT: challenge_qa_apply() is not the reviewed live text';
  end if;
  _def := replace(pg_get_functiondef(_oid), E'\r', '');
  foreach _new in array array[_a1_old, _a2_old, _a3_old, _a4_old] loop
    _n := (length(_def) - length(replace(_def, _new, ''))) / length(_new);
    if _n <> 1 then raise exception 'ABORT: an anchor occurs % times, expected 1: %', _n, left(_new, 60); end if;
  end loop;
  _def := replace(_def, _a1_old, _a1_new);
  _def := replace(_def, _a2_old, _a2_new);
  _def := replace(_def, _a3_old, _a3_new);
  _def := replace(_def, _a4_old, _a4_new);
  execute _def;
  select prosrc into _src from pg_proc where oid = _oid;
  if position('capped_daily_total' in _src) = 0 or position('ch_ask:' in _src) = 0 then
    raise exception 'ABORT: challenge_qa_apply() was not rewritten cleanly';
  end if;
  if (select array_to_string(proacl, ',') from pg_proc where oid = _oid) is distinct from _acl
     or (select proowner from pg_proc where oid = _oid) <> _owner
     or (select prosecdef from pg_proc where oid = _oid) is distinct from _secdef then
    raise exception 'ABORT: challenge_qa_apply() changed its owner, ACL or SECURITY DEFINER';
  end if;
end $$;

-- not retroactive + the new settings (one transaction: the backlog is closed before 'live' can pay it)
do $$
declare
  _closed int;
  _before jsonb;
  _after jsonb;
begin
  if exists (select 1 from public.admin_actions where action = 'challenge_qa_went_live') then
    raise notice 'Q&A points already live';
    return;
  end if;

  update public.challenge_qa_candidates
     set award_status = 'out_of_window', updated_at = now()
   where not shadow_only and award_status is null and answer_sent_at < now();
  get diagnostics _closed = row_count;

  select value into _before from public.platform_settings where key = 'challenge';
  update public.platform_settings
     set value = jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(value,
                   '{points,chat}', '0'::jsonb),
                   '{points,question}', '2'::jsonb),
                   '{caps,group_media_per_day}', '2'::jsonb),
                   '{caps,qa_points_per_day}', '10'::jsonb),
                   '{qa,mode}', '"live"'::jsonb)
   where key = 'challenge';
  select value into _after from public.platform_settings where key = 'challenge';
  if _after->'qa'->>'mode' <> 'live' or (_after->'points'->>'chat')::int <> 0
     or (_after->'caps'->>'qa_points_per_day')::int <> 10 or (_after->'caps'->>'group_media_per_day')::int <> 2 then
    raise exception 'ABORT: the challenge settings did not take the new values';
  end if;

  insert into public.admin_actions (actor_user_id, action, details)
  values (null, 'challenge_qa_went_live', jsonb_build_object(
    'migration', '20261005070000', 'at', now(), 'backlog_closed_out_of_window', _closed,
    'before', jsonb_build_object('points', _before->'points', 'caps', _before->'caps', 'qa_mode', _before->'qa'->'mode'),
    'after', jsonb_build_object('points', _after->'points', 'caps', _after->'caps', 'qa_mode', _after->'qa'->'mode'),
    'rules', 'chat 0; helpful answer +3; answered real question +2; Q&A <= 10/day; own work +5 x2/day'));
end $$;
