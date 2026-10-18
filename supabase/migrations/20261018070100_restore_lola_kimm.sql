-- Restore @Lola_Kimm (Lola Rakhimova, AC CHALLENGE | 1-GURUH) after a wrong deletion — owner request 2026-10-18.
--
-- 2026-10-17 17:38 UTC an admin «remove user» deleted her account c358f927-… (auth.admin.deleteUser). Every table
-- with an ON DELETE CASCADE foreign key to the user went with it: xp_events, user_xp, lesson_progress, streaks,
-- enrollments, challenge_task_submissions, … At 18:33 she was re-added as b02da7ce-… and started over (12 lessons
-- re-watched, M1V1 re-uploaded, 5 badges re-earned).
--
-- What survived, and is restored onto the new account here:
--   • homework_submissions (no FK to the user): M1V1 10, M2V1 «DNK» 10, M2V2 «rasmlar» 8 — moved as they are.
--     The ungraded re-upload of M1V1 made on the new account (18 Oct) is removed: the graded original replaces it
--     (the guard trigger keeps a copy in progress_audit).
--   • lesson_progress: lesson_progress_guard copied all 23 rows to progress_audit before the cascade deleted them.
--     11 lessons the new account does not have are re-inserted; the 12 re-watched ones keep the ORIGINAL completion
--     date and the larger watch numbers.
--   • user_badges (9), daily_watch_summary (12 days), nudge_module_celebrations — moved (no new badge / module DMs:
--     the badge DM fires on INSERT only, and the celebration rows are moved before any lesson row is written).
--   • streak: she was on a 14-day streak on 17 Oct (streak_14 badge), the new account continued on 18 Oct.
--   • challenge daily task 2 (5 Oct): its submission row is re-created (accepted, 5 points) so the challenge ledger
--     heal keeps the +5 instead of re-settling it to 0.
--
-- Points (xp_events) were NOT kept anywhere, so they are re-derived exactly as the platform awards them, each with
-- its ORIGINAL date (the rating's 2026-10-08 content-only cut-over and the weekly boards depend on the date):
--   lesson_complete 20 × 22 · homework_submit 15 × 3 · homework_high_score 25 × 2 · daily_active 5 × 12 days
--   (= reconcile_all_xp's own rules) · streak_7 50 on 2026-10-08 (the streak_7 badge's timestamp)
--   · challenge, from her raw group messages under the rules in force then, two confirmed by audit rows:
--     ch_chat :482 +1 (01 Oct intro — challenge_retro_credit_run chat_awarded=1), ch_img :1945 +5 (04 Oct video,
--     topic 4), ch_chat :1956 +1 (04 Oct reply), ch_task:2 +5 (05 Oct — challenge_task_points_changed amount 5),
--     ch_img :2957 +5 (06 Oct image, topic 4).
-- Already-existing events of the new account with the same ref_key keep one row, dated to the earlier time.
--
-- Not recoverable (no copy exists): quiz attempts, lesson notes/bookmarks, the photos of the task-2 submission
-- (challenge_task_messages), weekly challenge results, the old streak's freeze count.
--
-- Idempotent: refuses to run twice (admin_actions 'account_restored'), and every step is keyed.

do $$
declare
  _old constant uuid := 'c358f927-bf01-4463-ab1c-353e8bd86644';
  _new constant uuid := 'b02da7ce-84cf-46ca-893d-edbb6bdd118e';
  _n_hw int; _n_hw_dup int; _n_lp_ins int; _n_lp_upd int; _n_badge int; _n_dws int; _n_xp int; _total int;
  _s record; _streak_merged boolean := false; _dup_ids uuid[];
begin
  if exists (select 1 from public.admin_actions where action = 'account_restored' and target_user_id = _new
              and details->>'old_user_id' = _old::text) then
    raise notice 'restore_lola_kimm: already restored — nothing to do';
    return;
  end if;
  -- the right two accounts: the old one is gone from auth, the new one is hers (same Telegram id)
  if exists (select 1 from auth.users where id = _old)
     or not exists (select 1 from public.profiles where id = _new and telegram_id = 59105693) then
    raise exception 'restore_lola_kimm: unexpected account state — refusing';
  end if;

  -- 1. module celebrations + badges + watch days (UPDATEs: no insert-triggered DMs)
  update public.nudge_module_celebrations c set profile_id = _new
   where c.profile_id = _old
     and not exists (select 1 from public.nudge_module_celebrations x where x.profile_id = _new and x.module_id = c.module_id);
  delete from public.nudge_module_celebrations where profile_id = _old;

  update public.user_badges nb set earned_at = ob.earned_at
    from public.user_badges ob
   where nb.user_id = _new and ob.user_id = _old and ob.badge_id = nb.badge_id and ob.earned_at < nb.earned_at;
  update public.user_badges b set user_id = _new
   where b.user_id = _old
     and not exists (select 1 from public.user_badges x where x.user_id = _new and x.badge_id = b.badge_id);
  get diagnostics _n_badge = row_count;
  delete from public.user_badges where user_id = _old;

  update public.daily_watch_summary d set user_id = _new
   where d.user_id = _old
     and not exists (select 1 from public.daily_watch_summary x where x.user_id = _new and x.watch_date = d.watch_date);
  get diagnostics _n_dws = row_count;
  delete from public.daily_watch_summary where user_id = _old;

  -- 2a. the daily task 2 she completed on 5 Oct: its submission row went with the cascade. Re-created ACCEPTED with
  --     its original id and the values the engine wrote (challenge_task_points_changed: submission 116, 5 points,
  --     late_days 0, posted 18:35:11) — reconcile_challenge_tasks' ledger heal re-settles (= deletes) any
  --     ch_task event that has no accepted submission behind it, so the +5 below needs this row to survive.
  insert into public.challenge_task_submissions
    (id, task_id, user_id, group_id, source, attributed_via, status, submitted_at, last_item_at, late_days,
     points_awarded, attempt_no, check_version, checked_version, checked_at, accepted_at, xp_created_at, awarded_at,
     receipt_state, receipt_version, receipt_sent_version, created_at, updated_at)
  overriding system value   -- id is GENERATED ALWAYS; 116 is the id the engine issued then (the sequence is past it)
  select 116, 2, _new, 'f675a2fd-b1ce-4d28-94a4-7fc0e1a91515', 'topic', 'today', 'accepted',
         timestamptz '2026-10-05 18:35:11+00', timestamptz '2026-10-05 18:35:12+00', 0,
         5, 1, 1, 1, timestamptz '2026-10-05 18:36:04.254328+00', timestamptz '2026-10-05 18:36:04.254328+00',
         timestamptz '2026-10-05 18:35:11+00', timestamptz '2026-10-05 18:36:04.254328+00',
         'sent', 1, 1, timestamptz '2026-10-05 18:35:11+00', now()
   where not exists (select 1 from public.challenge_task_submissions where id = 116 or (user_id = _new and task_id = 2));

  -- 2. points, with original dates — BEFORE the lesson rows, so their award triggers find them and add nothing
  with ev(amount, reason, ref_key, at) as (
    select 20, 'lesson_complete', 'lesson:' || (a.before->>'lesson_id'), (a.before->>'completed_at')::timestamptz
      from (select distinct on (a.before->>'lesson_id') a.before
              from public.progress_audit a
             where a.user_id = _old and a.table_name = 'lesson_progress' and a.op = 'DELETE'
             order by a.before->>'lesson_id', a.changed_at desc) a
     where a.before->>'completed_at' is not null
    union all
    select 15, 'homework_submit', 'hw_submit:' || hs.assignment_id, hs.submitted_at
      from public.homework_submissions hs where hs.user_id = _old
    union all
    select 25, 'homework_high_score', 'hw_score:' || hs.assignment_id, coalesce(hs.scored_at, hs.submitted_at)
      from public.homework_submissions hs where hs.user_id = _old and hs.score >= 9
    union all
    -- noon Tashkent of the day, not updated_at (bumped by every later watch that day): 8 Oct's point stays before the
    -- 09:24 UTC rating cut-over, as the original was (she completed a lesson at 07:37 UTC that morning)
    select 5, 'daily_active', 'day:' || d.watch_date, (d.watch_date + time '12:00') at time zone 'Asia/Tashkent'
      from public.daily_watch_summary d where d.user_id = _new and d.watch_date <= date '2026-10-17'
    union all values
      (50, 'streak_7', 'streak7:2026-10-08', timestamptz '2026-10-08 07:37:33.491484+00'),
      (1, 'challenge_chat', 'ch_chat:-1004440955972:482', timestamptz '2026-10-01 18:17:43+00'),
      (5, 'challenge_group_media', 'ch_img:-1004440955972:1945', timestamptz '2026-10-04 14:40:32+00'),
      (1, 'challenge_chat', 'ch_chat:-1004440955972:1956', timestamptz '2026-10-04 15:03:46+00'),
      (5, 'challenge_task', 'ch_task:2', timestamptz '2026-10-05 18:35:11+00'),
      (5, 'challenge_group_media', 'ch_img:-1004440955972:2957', timestamptz '2026-10-06 06:54:51+00')
  )
  insert into public.xp_events (user_id, amount, reason, ref_key, created_at)
  select _new, e.amount, e.reason, e.ref_key, e.at from ev e where e.at is not null
  on conflict (user_id, ref_key) do update set created_at = least(public.xp_events.created_at, excluded.created_at);
  get diagnostics _n_xp = row_count;

  -- 3. lessons: the re-watched ones keep the original completion + the larger numbers; the rest come back.
  --    Their streak trigger would count the day this migration runs as an active day — the streak is saved here and
  --    put back right after, so only real activity counts.
  select * into _s from public.streaks where user_id = _new;
  update public.lesson_progress n
     set completed_at = case when o.completed_at is null then n.completed_at
                             when n.completed_at is null then o.completed_at
                             else least(n.completed_at, o.completed_at) end,
         seconds_watched = greatest(coalesce(n.seconds_watched, 0), coalesce(o.seconds_watched, 0)),
         last_position_seconds = greatest(coalesce(n.last_position_seconds, 0), coalesce(o.last_position_seconds, 0)),
         max_position_seconds = greatest(n.max_position_seconds, coalesce(o.max_position_seconds, 0)),
         watch_seconds_total = n.watch_seconds_total + coalesce(o.watch_seconds_total, 0),
         duration_seconds_v2 = coalesce(n.duration_seconds_v2, o.duration_seconds_v2)
    from (select (jsonb_populate_record(null::public.lesson_progress, a.before)).*
            from (select distinct on (a.before->>'lesson_id') a.before
                    from public.progress_audit a
                   where a.user_id = _old and a.table_name = 'lesson_progress' and a.op = 'DELETE'
                   order by a.before->>'lesson_id', a.changed_at desc) a) o
   where n.user_id = _new and n.lesson_id = o.lesson_id;
  get diagnostics _n_lp_upd = row_count;

  insert into public.lesson_progress (id, user_id, lesson_id, completed_at, seconds_watched, last_position_seconds,
                                      updated_at, max_position_seconds, watch_seconds_total, duration_seconds_v2)
  select o.id, _new, o.lesson_id, o.completed_at, o.seconds_watched, o.last_position_seconds,
         o.updated_at, coalesce(o.max_position_seconds, 0), coalesce(o.watch_seconds_total, 0), o.duration_seconds_v2
    from (select (jsonb_populate_record(null::public.lesson_progress, a.before)).*
            from (select distinct on (a.before->>'lesson_id') a.before
                    from public.progress_audit a
                   where a.user_id = _old and a.table_name = 'lesson_progress' and a.op = 'DELETE'
                   order by a.before->>'lesson_id', a.changed_at desc) a) o
   where not exists (select 1 from public.lesson_progress x where x.user_id = _new and x.lesson_id = o.lesson_id)
     and not exists (select 1 from public.lesson_progress x where x.id = o.id);
  get diagnostics _n_lp_ins = row_count;
  if _s.user_id is not null then
    update public.streaks set current_streak = _s.current_streak, longest_streak = _s.longest_streak,
                              last_active_date = _s.last_active_date, freezes_remaining = _s.freezes_remaining
     where user_id = _new;
  end if;

  -- 4. homework: the graded originals replace the ungraded re-upload of the same task
  with d as (
    delete from public.homework_submissions n
     where n.user_id = _new and n.score is null
       and exists (select 1 from public.homework_submissions o where o.user_id = _old and o.assignment_id = n.assignment_id)
    returning n.id
  )
  select coalesce(array_agg(id), '{}'), count(*)::int into _dup_ids, _n_hw_dup from d;
  update public.homework_submissions set user_id = _new
   where user_id = _old
     and not exists (select 1 from public.homework_submissions x
                      where x.user_id = _new and x.assignment_id = public.homework_submissions.assignment_id);
  get diagnostics _n_hw = row_count;
  -- teacher DMs: already-sent history follows her; nothing unsent may fire for graded or removed work
  update public.homework_teacher_dm_queue set student_id = _new where student_id = _old and sent_at is not null;
  delete from public.homework_teacher_dm_queue
   where sent_at is null and (student_id = _old or submission_id = any(_dup_ids));
  -- picker intents live 10 minutes; the old account's are dead (moving one could collide with the new account's)
  delete from public.bot_homework_intents where user_id = _old;

  -- 5. streak: 14 days on 17 Oct, continued by the new account from 18 Oct
  -- (only when the new account's streak runs unbroken from 18 Oct, the day after the old one's last day)
  if _s.user_id is not null and _s.last_active_date - (_s.current_streak - 1) = date '2026-10-18' then
    update public.streaks
       set current_streak = 14 + _s.current_streak,
           longest_streak = greatest(longest_streak, 14 + _s.current_streak)
     where user_id = _new;
    _streak_merged := true;
  else
    raise notice 'restore_lola_kimm: streak NOT merged (new streak % from %)', _s.current_streak, _s.last_active_date;
  end if;

  -- 6. the total from the events (the same rebuild reconcile_all_xp does)
  select coalesce(sum(amount), 0)::int into _total from public.xp_events where user_id = _new;
  insert into public.user_xp (user_id, total_xp, level, updated_at)
  values (_new, _total, public.xp_level_for(_total), now())
  on conflict (user_id) do update set total_xp = excluded.total_xp, level = excluded.level, updated_at = now();

  insert into public.admin_actions (actor_user_id, action, target_user_id, target_resource_type, target_resource_id, details)
  values (null, 'account_restored', _new, 'profile', _new,
          jsonb_build_object('migration', '20261018070100', 'requested_by', 'owner', 'old_user_id', _old,
                             'deleted_at', '2026-10-17T17:38:05Z', 'homework_moved', _n_hw, 'homework_reupload_removed', _n_hw_dup,
                             'lessons_restored', _n_lp_ins, 'lessons_merged', _n_lp_upd, 'badges_moved', _n_badge,
                             'watch_days_moved', _n_dws, 'xp_events_written', _n_xp, 'total_xp', _total,
                             'streak_merged', _streak_merged, 'task2_submission', 116));
  raise notice 'restore_lola_kimm: hw %, reupload removed %, lessons +% / merged %, badges %, days %, xp rows %, total %',
    _n_hw, _n_hw_dup, _n_lp_ins, _n_lp_upd, _n_badge, _n_dws, _n_xp, _total;
end $$;
