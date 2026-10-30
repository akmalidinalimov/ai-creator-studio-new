-- 7.0: out of the challenge scope; into the Monday weekly Top-10 (owner, 2026-10-30: the daily tasks / challenge points
-- are retired — "we don't need Kunlik vazifalar anymore … we removed it in 6.0").
--
-- 1. challenge.course_ids − 7.0 (added by 20261030142800 to mirror 6.0). Nothing in the challenge engine serves 7.0 now
--    (daily tasks retired, every challenge point type is 0), and keeping it there would HARM: post_challenge_team_board
--    ranks every group of challenge_scope_group_ids() against each other — next Monday's team board would mix 6.0 and
--    7.0 groups into one ranking, posted into both cohorts' chats — and challenge_health would count the KANAL holding
--    group (no chat, by design) as a group missing its homework topic.
-- 2. group_weekly_board.topics + the four 7.0 groups → topic "1" (General), exactly as every 6.0 group. The holding
--    group «… | KANAL» has no chat and is left out.
-- Set-wise, so a replay or a hand edit changes nothing.

do $$
declare
  _c constant text := 'a13b606e-11d3-47e5-a2ff-6815790f7311';
  _add jsonb;
begin
  update public.platform_settings
     set value = jsonb_set(value, '{course_ids}',
                           coalesce((select jsonb_agg(x) from jsonb_array_elements(value->'course_ids') x where x #>> '{}' <> _c),
                                    '[]'::jsonb)),
         updated_at = now()
   where key = 'challenge' and coalesce(value->'course_ids', '[]'::jsonb) ? _c;

  select coalesce(jsonb_object_agg(g.id::text, '1'), '{}'::jsonb) into _add
    from public.groups g
   where g.course_id::text = _c and g.name like 'AC CHALLENGE 7.0 | _-GURUH';
  update public.platform_settings
     set value = jsonb_set(value, '{topics}', _add || coalesce(value->'topics', '{}'::jsonb)),
         updated_at = now()
   where key = 'group_weekly_board';

  insert into public.admin_actions (actor_user_id, action, details)
  values (null, 'course_boards_scope', jsonb_build_object('migration', '20261030154200', 'course_id', _c,
          'challenge_scope', 'removed', 'weekly_board_groups', (select count(*) from jsonb_object_keys(_add))));
end $$;
