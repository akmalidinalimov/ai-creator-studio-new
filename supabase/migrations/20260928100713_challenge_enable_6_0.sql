-- Challenge 6.0: switch the points engine ON, scoped to the AI CREATORS CHALLENGE 6.0 course only,
-- starting 2026-10-01 00:00 Tashkent (owner's decision, 2026-09-28).
--
-- Until now platform_settings.challenge was seeded disabled with an empty scope, so 6.0 students
-- (the course was published 2026-09-28) would have earned no challenge points at all.
--
-- What this sets (every other key -- points, caps, window.end -- is left exactly as it is):
--   enabled      = true
--   course_ids   = [6.0]            every group of 6.0 is in scope, including groups created later
--   group_ids    = []               no hand-picked extra groups (a 5.0 group can never slip in)
--   window.start = 2026-10-01 00:00 Tashkent
--   window.end   = unchanged (null) the challenge stays open until the owner sets an end date
--
-- challenge_active() is false until the start, so every leg (reconciler, watchdog, weekly job) stays
-- inert until then; the reconciler never looks back more than 24 h, so nothing pre-start is paid.
-- Kill-switch: set value->'enabled' to false (every leg re-reads the flag on each run).

do $$
declare
  _course constant uuid := 'f502f631-2104-4834-b6c2-702cd3080e27';
  _start  constant timestamptz := '2026-10-01T00:00:00+05:00';
  _v jsonb;
  _foreign int;
begin
  if not exists (select 1 from public.courses where id = _course and title = 'AI CREATORS CHALLENGE 6.0') then
    raise exception 'challenge 6.0 course % not found (or renamed) -- refusing to scope the challenge blindly', _course;
  end if;

  update public.platform_settings
     set value = jsonb_set(
                   jsonb_set(
                     jsonb_set(
                       jsonb_set(value, '{enabled}', 'true'::jsonb),
                       '{course_ids}', jsonb_build_array(_course::text)),
                     '{group_ids}', '[]'::jsonb),
                   '{window,start}', to_jsonb('2026-10-01T00:00:00+05:00'::text)),
         updated_at = now()
   where key = 'challenge';
  if not found then
    raise exception 'platform_settings.challenge row missing';
  end if;

  -- Assert the result, not the intent.
  select value into _v from public.platform_settings where key = 'challenge';
  if (_v->>'enabled')::boolean is distinct from true
     or _v->'course_ids' <> jsonb_build_array(_course::text)
     or _v->'group_ids' <> '[]'::jsonb
     or (_v->'window'->>'start')::timestamptz <> _start then
    raise exception 'challenge config not as intended: %', _v;
  end if;
  -- Off one second before the start, on at the start (a replay after the start still passes).
  if public.challenge_active(_start - interval '1 second') or not public.challenge_active(_start) then
    raise exception 'challenge_active() does not switch on exactly at %: %', _start, _v;
  end if;

  -- The one real failure mode is scope: no group outside 6.0 (i.e. no 5.0 group) may be in it.
  select count(*) into _foreign
    from public.groups g
   where g.id in (select public.challenge_scope_group_ids())
     and g.course_id is distinct from _course;
  if _foreign > 0 then
    raise exception 'challenge scope contains % group(s) outside 6.0', _foreign;
  end if;

  -- Audit once, even if a racing deploy replays this file.
  if not exists (select 1 from public.admin_actions
                  where action = 'challenge_enabled' and details->>'course_id' = _course::text) then
    insert into public.admin_actions (actor_user_id, action, details)
    values (null, 'challenge_enabled', jsonb_build_object('course_id', _course, 'config', _v, 'at', now()));
  end if;
end $$;
