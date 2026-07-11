-- Teacher-side homework re-tag (2026-07-11).
-- The in-group capture auto-guesses which assignment a bare topic post belongs to; when the guess
-- is wrong the teacher fixes it at grading time (one tap in the bot). This function is that fix:
-- move an UNGRADED submission to another assignment atomically, keeping XP exactly correct.
--
-- XP correctness: homework XP is keyed 'hw_submit:<assignment_id>' per user, and the hourly
-- reconcile_all_xp() re-derives events from homework_submissions. If we moved the row without
-- moving its xp_event, the reconciler would insert a NEW +15 for the new assignment while the old
-- orphaned event kept its +15 -> double award. So the event's ref_key moves in the same
-- transaction, and the user's total is rebuilt from events.
--
-- Returns jsonb: { status, submission_id }
--   status: moved | merged | not_found | already_graded | same | bad_assignment | target_graded
--   submission_id: the surviving submission row (target's id on merge).

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
  if _sub.score is not null then return jsonb_build_object('status', 'already_graded', 'submission_id', _sub.id); end if;
  _old := _sub.assignment_id;
  if _old = _new_assignment then return jsonb_build_object('status', 'same', 'submission_id', _sub.id); end if;
  if not exists (select 1 from homework_assignments where id = _new_assignment and is_active) then
    return jsonb_build_object('status', 'bad_assignment', 'submission_id', _sub.id);
  end if;

  select * into _target from homework_submissions
   where user_id = _sub.user_id and assignment_id = _new_assignment;

  if _target.id is not null then
    if _target.score is not null then
      return jsonb_build_object('status', 'target_graded', 'submission_id', _sub.id);
    end if;
    -- MERGE: the student already has an ungraded submission on the target task. Fold this
    -- post's media/text into it (cap 10 items, same as capture) and drop the source row.
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
    delete from homework_submissions where id = _sub.id;
    -- Target already carries its own hw_submit event; the source's event is now orphaned — drop it.
    delete from xp_events where user_id = _sub.user_id and ref_key = 'hw_submit:' || _old::text;
    _survivor := _target.id; _status := 'merged';
  else
    -- MOVE: simple re-point. Move the xp_event's ref_key with it (delete any stray target-key
    -- event first so the unique (user_id, ref_key) can never conflict).
    update homework_submissions set assignment_id = _new_assignment where id = _sub.id;
    delete from xp_events where user_id = _sub.user_id and ref_key = 'hw_submit:' || _new_assignment::text;
    update xp_events set ref_key = 'hw_submit:' || _new_assignment::text
     where user_id = _sub.user_id and ref_key = 'hw_submit:' || _old::text;
    _survivor := _sub.id; _status := 'moved';
  end if;

  -- Keep the teacher DM queue rows consistent (cosmetic labels used by /galaba lists).
  update homework_teacher_dm_queue q set
    assignment_id = _new_assignment,
    module_id = a.module_id,
    module_number = m.position + 1,
    task_number = coalesce(a.task_number, 1),
    assignment_title = a.title
  from homework_assignments a join modules m on m.id = a.module_id
  where a.id = _new_assignment and q.submission_id in (_submission, _survivor);

  -- Rebuild this user's XP total from events (same statement as reconcile_all_xp).
  insert into user_xp (user_id, total_xp, level, updated_at)
  select e.user_id, sum(e.amount)::int, public.xp_level_for(sum(e.amount)::int), now()
  from xp_events e where e.user_id = _sub.user_id
  group by e.user_id
  on conflict (user_id) do update
    set total_xp = excluded.total_xp, level = excluded.level, updated_at = now();

  -- Audit
  begin
    insert into admin_actions (actor_user_id, action, target_user_id, target_resource_type, target_resource_id, details)
    values (auth.uid(), 'homework_retagged', _sub.user_id, 'homework_submission', _survivor,
            jsonb_build_object('from_assignment', _old, 'to_assignment', _new_assignment, 'result', _status));
  exception when others then null; -- audit best-effort
  end;

  return jsonb_build_object('status', _status, 'submission_id', _survivor);
end;
$$;
-- Bot calls with service role; keep it away from end-user roles.
revoke execute on function public.admin_retag_submission(uuid, uuid) from public, anon, authenticated;
