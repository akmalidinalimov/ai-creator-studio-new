-- Move 14 Challenge 6.0 students to AC CHALLENGE | 4-GURUH on the platform (owner request, 2026-10-03).
--
-- WHY
--   The owner moved these students into the group-4 Telegram chat. The platform still had them in group
--   2 or 3, so:
--   * the bot treated their posts in group 4's homework topic as "another group's topic" and did not
--     record them (Hosiyat99 twice, robiyamuhammadjanova, Shokabirovlar);
--   * their homework was announced to group 2's or 3's teacher, not to group 4's new teacher (nigorakm,
--     added 2026-10-03 15:46 UTC);
--   * their chat points from the group-4 chat were not counted (the challenge counts only messages in
--     the student's current group).
--   Evidence: the bot's chat_member / join / message records. 12 of them are now only in the group-4
--   chat; whodareswinsN and nozimaxon1111999 joined group 4 last (2026-10-02 / 2026-10-03), and the
--   owner is removing them from their old chats.
--
-- WHAT A GROUP CHANGE DOES HERE (verified against the live triggers)
--   * Same course (6.0 -> 6.0): trg_profiles_aa_course_move_guard returns at once (not a cross-course
--     move).
--   * trg_profiles_sync_group_enrollment re-upserts the 6.0 enrollment with group 4's tier, which is the
--     same AC CHALLENGE tier (module_limit 1) as groups 2 and 3, so lesson access does not change.
--   * trg_profiles_challenge_retro_credit runs challenge_retro_attach(): the group-4 chat messages they
--     wrote while listed elsewhere are credited, through the usual idempotent ref keys.
--   * Points do not move or reset. user_group_rating_xp() is per course, not per group; the students
--     appear on group 4's board with the points they already have.
--   * Homework: reconcile_teacher_dm_queue() (every 15 min) gives every ungraded submission from the
--     last 48 h a DM to the teachers of the student's CURRENT group. So the 4 ungraded ones (itdocs_uz,
--     nozimaxon1111999, Oygul_uzb, FarizaSanjarovna; the oldest is about 23 h old today) reach nigorakm
--     on its next run. Graded work stays graded.
--   The profiles column guard restricts only the authenticated/anon roles; this write is audited as
--   profile_privileged_change like every service-side group change.
--
-- SAFETY
--   Each student is pinned to the group they were verified in. A student who is no longer there (moved
--   by hand in the admin panel meanwhile, or moved elsewhere) is left alone and listed in the audit row.
--   Replay-safe: a second run finds nobody in their old group and changes nothing.

do $$
declare
  _g4 constant uuid := '93e8e7b0-275c-47a9-a97d-ff28e26c8f5b';
  _course constant uuid := 'f502f631-2104-4834-b6c2-702cd3080e27';
  _moved uuid[];
  _skipped jsonb;
begin
  if not exists (select 1 from public.groups where id = _g4 and course_id = _course and name = 'AC CHALLENGE | 4-GURUH') then
    raise exception 'ABORT: group 4 is not the expected AC CHALLENGE | 4-GURUH of course 6.0';
  end if;
  if not exists (select 1 from public.group_teachers where group_id = _g4)
     and not exists (select 1 from public.groups where id = _g4 and teacher_id is not null) then
    raise exception 'ABORT: group 4 has no teacher; moving students there would leave their homework unannounced';
  end if;

  create temporary table _move (profile_id uuid primary key, from_group uuid not null, username text not null) on commit drop;
  insert into _move values
    -- from AC CHALLENGE | 2-GURUH
    ('7ba56d35-6db9-4a25-b2f0-27423155c741', 'c092a0db-b55f-4fa7-8548-befad285037b', 'Hosiyat99'),
    ('52f3c697-2aca-4d0f-b18d-f4620f7580e2', 'c092a0db-b55f-4fa7-8548-befad285037b', 'M_Matisha'),
    ('b6cd6f62-0ec2-4611-8eaa-c04d4c9f4265', 'c092a0db-b55f-4fa7-8548-befad285037b', 'premiumplatokadmin'),
    ('71fe5183-2c4f-40e2-a2ac-345a6c436153', 'c092a0db-b55f-4fa7-8548-befad285037b', 'robiyamuhammadjanova'),
    ('8d1e1a57-97bd-4883-802b-6f10a0e08c99', 'c092a0db-b55f-4fa7-8548-befad285037b', 'Shokabirovlar'),
    ('c4c9df13-d6be-4f12-81c5-321e1ab577cf', 'c092a0db-b55f-4fa7-8548-befad285037b', 'Solarex_ROP'),
    ('4d7d4058-2229-4cd8-8692-cbbabf0ad689', 'c092a0db-b55f-4fa7-8548-befad285037b', 'whodareswinsN'),
    -- from AC CHALLENGE | 3-GURUH
    ('685f2c9c-ba65-4f45-adb2-f8d4380e71ce', '3a7ebea8-80eb-4b64-a282-471a0fa12ef4', 'FarizaSanjarovna'),
    ('0198174f-eee3-4b92-b7e7-fe6496971c18', '3a7ebea8-80eb-4b64-a282-471a0fa12ef4', 'itdocs_uz'),
    ('309e1c83-4123-42c5-b41c-44e599066575', '3a7ebea8-80eb-4b64-a282-471a0fa12ef4', 'Oygul_uzb'),
    ('45b09e1a-b1cd-42f9-86fa-714df66b3865', '3a7ebea8-80eb-4b64-a282-471a0fa12ef4', 'QodirovaN96'),
    ('5ba5b937-4214-4f3e-8954-328358484503', '3a7ebea8-80eb-4b64-a282-471a0fa12ef4', 'Umida_Kholdaraliyeva'),
    ('c15ce092-6a74-4f39-ae15-f9c342a824ce', '3a7ebea8-80eb-4b64-a282-471a0fa12ef4', 'Mukhlisa (tg 5756660303)'),
    ('11246c31-2e24-4207-844a-707853b4b8f0', '3a7ebea8-80eb-4b64-a282-471a0fa12ef4', 'nozimaxon1111999');

  -- Students only: never move a staff account.
  if exists (select 1 from _move m join public.user_roles r on r.user_id = m.profile_id
              where r.role in ('admin', 'superadmin', 'teacher')) then
    raise exception 'ABORT: a staff account is on the move list';
  end if;

  with moved as (
    update public.profiles p
       set group_id = _g4
      from _move m
     where p.id = m.profile_id
       and p.group_id = m.from_group
    returning p.id
  )
  select coalesce(array_agg(id), '{}') into _moved from moved;

  select coalesce(jsonb_agg(jsonb_build_object('username', m.username, 'now_in', g.name)), '[]'::jsonb)
    into _skipped
    from _move m join public.profiles p on p.id = m.profile_id left join public.groups g on g.id = p.group_id
   where not (m.profile_id = any(_moved));

  if not exists (select 1 from public.admin_actions where action = 'students_moved_to_challenge_group_4'
                  and details->>'migration' = '20261003160000') then
    insert into public.admin_actions (actor_user_id, action, target_resource_type, target_resource_id, details)
    values (null, 'students_moved_to_challenge_group_4', 'group', _g4, jsonb_build_object(
      'migration', '20261003160000', 'at', now(),
      'moved', cardinality(_moved), 'moved_ids', to_jsonb(_moved),
      'not_moved', _skipped,
      'why', 'owner moved them to the group-4 Telegram chat; the platform still listed groups 2/3'));
  end if;
end $$;
