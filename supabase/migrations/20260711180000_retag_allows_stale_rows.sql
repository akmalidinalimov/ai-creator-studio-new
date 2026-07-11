-- Allow re-tagging REOPENED (stale-scored) submissions (2026-07-11).
-- Mis-tag audit found students whose M2 work was auto-filed as M1·V1 and graded 0 (the teacher
-- saw content that didn't match M1). Remediation = reopen (score_is_stale=true) → teacher
-- re-tags to the right task → regrades. The retag RPC refused ANY scored row; stale rows are
-- pending-regrade by definition and must be movable. Hard-graded rows stay protected.
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
    task_number = coalesce(a.task_number, 1),
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
