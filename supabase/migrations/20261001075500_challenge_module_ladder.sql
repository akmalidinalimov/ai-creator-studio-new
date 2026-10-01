-- Challenge 6.0: the MODULE LADDER (owner's decision, 2026-10-01).
--
-- THE RULE
--   Being a member of one of the six "AC CHALLENGE | N-GURUH" Telegram groups earns module 1, and
--   nothing else. The owner opens the next module when the week comes, by hand, in
--   Admin → Kurslar → AI CREATORS CHALLENGE 6.0 → Tariflar: change the "AC CHALLENGE" tier's module
--   limit from 1 to 2, then 3, and so on. One number, every student at once, no per-student work and
--   no sales involvement — which is the point: sales is no longer the bottleneck for joining.
--
-- WHY THIS NEEDS ALMOST NO NEW CODE
--   public.has_module_access(user, module) already enforces exactly this gate, and 5.0 has used it for
--   months (VIP = 8 modules, Premium = 5): an enrollment whose tier has module_limit = N opens the
--   first N modules, ranked `row_number() over (order by position, created_at)`. 6.0's module order is
--   1 Tanishish · 2 Rasm · 3 Video · 4 Claude/Codex · 5 Daromad · 6 BONUS Multfilm, so limit 1 is the
--   first module only. The video endpoint (lesson-video-url) and the lesson UI both read that gate.
--
-- WHAT THIS MIGRATION DOES
--   1. Creates the tier "AC CHALLENGE" on course 6.0 with module_limit = 1 (idempotent on name).
--   2. Points all six Challenge groups at it (groups.tier_id). sync_group_enrollment() treats the
--      group's tier as authoritative for its course, so every future placement — the bot's
--      auto-registration, the /intake form, an admin assignment — inherits limit 1 automatically.
--   3. Seeds homework_capture.auto_register_paid_course_ids = [6.0]. The bot reads it (this PR's code
--      change): on a listed course, an auto-registered member gets a NORMAL account, so the tier is
--      what limits them; everywhere else they stay 'provisional' (no video at all), unchanged. The bot
--      also requires the group's tier to really BOUND access (a positive module_limit), so an
--      unbounded group can never turn a group member into a full-access student.
--   4. Backfills the members who already joined: as of writing, 23 profiles auto-registered into
--      Challenge groups between 06:57 and 07:18 UTC today, every one of them 'provisional', i.e.
--      locked out of every video including module 1. They are exactly the students this ladder is for,
--      so they get the tier and a normal account rather than being deleted.
--
-- WHAT IT DOES NOT TOUCH
--   No profile outside a Challenge 6.0 group. The 5.0 cohort's tiers, the other 'provisional' accounts
--   (trial students of other courses) and every account_type elsewhere are left exactly as they are,
--   and the block below asserts that by counting them before and after.
--
-- FULL ACCESS for a student who pays: clear their 6.0 enrollment's tier (Talabalar → Boshqarish, or
--   the intake form's "To'liq to'lagan" + Tarif "Full"). module_limit NULL = every module. Note that
--   sync_group_enrollment re-applies the GROUP's tier whenever a profile's group_id is written, so
--   re-assigning such a student's group puts them back on the ladder; re-clear the tier afterwards.
--
-- REVERSIBLE: set the six groups' tier_id back to NULL and/or drop the key from homework_capture; the
--   old behaviour (auto-registered members are trial-locked) returns with no code change.

do $$
declare
  _course constant uuid := 'f502f631-2104-4834-b6c2-702cd3080e27';
  _tier uuid;
  _n int;
  _modules int;
  _prov_outside_before int;
  _prov_outside_after int;
  _flipped int;
  _tiered int;
begin
  if not exists (select 1 from public.courses where id = _course and title = 'AI CREATORS CHALLENGE 6.0') then
    raise exception 'ABORT: challenge 6.0 course % not found (or renamed)', _course;
  end if;
  select count(*) into _modules from public.modules where course_id = _course;
  if _modules < 2 then
    raise exception 'ABORT: course 6.0 has % module(s) — a ladder needs at least two', _modules;
  end if;

  -- The provisional accounts that must stay untouched (every trial account NOT in a Challenge group).
  select count(*) into _prov_outside_before
    from public.profiles p
   where p.account_type = 'provisional'
     and coalesce((select g.course_id from public.groups g where g.id = p.group_id), '00000000-0000-0000-0000-000000000000'::uuid) <> _course;

  -- 1. the tier
  select id into _tier from public.course_tiers where course_id = _course and name = 'AC CHALLENGE';
  if _tier is null then
    insert into public.course_tiers (course_id, name, module_limit, position)
    values (_course, 'AC CHALLENGE', 1, 0)
    returning id into _tier;
  end if;
  if (select module_limit from public.course_tiers where id = _tier) is null then
    -- an unbounded "AC CHALLENGE" tier would open the whole course: never leave it that way here
    update public.course_tiers set module_limit = 1 where id = _tier;
  end if;

  -- 2. every Challenge group points at it
  update public.groups set tier_id = _tier
   where course_id = _course and tier_id is distinct from _tier;
  select count(*) into _n from public.groups where course_id = _course;
  if _n <> 6 then
    raise exception 'ABORT: expected 6 challenge groups, found %', _n;
  end if;
  select count(*) into _n from public.groups where course_id = _course and tier_id = _tier;
  if _n <> 6 then
    raise exception 'ABORT: only % of 6 challenge groups carry the AC CHALLENGE tier', _n;
  end if;

  -- 3. the bot's allowlist (shallow merge: every other key of homework_capture is kept)
  update public.platform_settings
     set value = value || jsonb_build_object('auto_register_paid_course_ids', jsonb_build_array(_course::text)),
         updated_at = now()
   where key = 'homework_capture';
  if not found then
    raise exception 'ABORT: platform_settings.homework_capture row is missing';
  end if;

  -- 4. the members who already joined: give them the tier, then lift the trial lock
  insert into public.enrollments (user_id, course_id, tier_id)
  select p.id, _course, _tier
    from public.profiles p join public.groups g on g.id = p.group_id
   where g.course_id = _course
  on conflict (user_id, course_id) do update set tier_id = excluded.tier_id;

  with flip as (
    update public.profiles p set account_type = 'paid'
     where p.account_type = 'provisional'
       and exists (select 1 from public.groups g where g.id = p.group_id and g.course_id = _course)
    returning 1)
  select count(*) into _flipped from flip;

  -- assertions: every Challenge-group member is on the ladder, and nobody else moved
  select count(*) into _n
    from public.profiles p join public.groups g on g.id = p.group_id
   where g.course_id = _course and p.account_type = 'provisional';
  if _n > 0 then
    raise exception 'ABORT: % challenge member(s) are still trial-locked and could not watch module 1', _n;
  end if;
  select count(*) into _n
    from public.profiles p join public.groups g on g.id = p.group_id
    left join public.enrollments e on e.user_id = p.id and e.course_id = _course
   where g.course_id = _course and (e.user_id is null or e.tier_id is distinct from _tier);
  if _n > 0 then
    raise exception 'ABORT: % challenge member(s) are not on the AC CHALLENGE tier', _n;
  end if;
  select count(*) into _tiered from public.enrollments where course_id = _course and tier_id = _tier;

  select count(*) into _prov_outside_after
    from public.profiles p
   where p.account_type = 'provisional'
     and coalesce((select g.course_id from public.groups g where g.id = p.group_id), '00000000-0000-0000-0000-000000000000'::uuid) <> _course;
  if _prov_outside_after <> _prov_outside_before then
    raise exception 'ABORT: trial accounts outside the challenge changed (% -> %)', _prov_outside_before, _prov_outside_after;
  end if;

  -- read-only self-test of the gate itself: with limit 1, module rank 1 is open and rank 2 is not,
  -- for a real challenge member. It calls has_module_access (STABLE, reads only) and writes nothing.
  declare
    _uid uuid;
    _m1 uuid;
    _m2 uuid;
  begin
    select p.id into _uid from public.profiles p join public.groups g on g.id = p.group_id
      where g.course_id = _course limit 1;
    select id into _m1 from (select id, row_number() over (order by position, created_at) rnk
                               from public.modules where course_id = _course) r where rnk = 1;
    select id into _m2 from (select id, row_number() over (order by position, created_at) rnk
                               from public.modules where course_id = _course) r where rnk = 2;
    if _uid is not null and _m1 is not null and _m2 is not null then
      if not public.has_module_access(_uid, _m1) then
        raise exception 'ABORT: self-test — a challenge member cannot open module 1';
      end if;
      if public.has_module_access(_uid, _m2) then
        raise exception 'ABORT: self-test — module 2 is open while the ladder limit is 1';
      end if;
    end if;
  end;

  if not exists (select 1 from public.admin_actions where action = 'challenge_module_ladder_installed') then
    insert into public.admin_actions (actor_user_id, action, details)
    values (null, 'challenge_module_ladder_installed', jsonb_build_object(
      'at', now(),
      'migration', '20261001075500',
      'course_id', _course,
      'tier_id', _tier,
      'module_limit', 1,
      'modules', _modules,
      'groups_pointed_at_tier', 6,
      'members_on_ladder', _tiered,
      'trial_lock_lifted', _flipped,
      'how_to_open_next_module', 'Admin → Kurslar → 6.0 → Tariflar → AC CHALLENGE: module_limit 1 → 2 → 3 …',
      'why', 'membership of a challenge group earns module 1; the owner opens later modules by hand each week'));
  end if;
end $$;
