-- Quick win Q6 — wire two designed-but-unearnable badges: level_5 + perfect_score.
-- These presets exist in _shared/badge-presets.ts (render side) but had NO `badges` row and NO
-- award trigger, so they could never be earned. This adds the row + a real-time award trigger for
-- each, then heals history with a SILENT backfill (existing qualifiers — measured ~201 level_5 /
-- ~230 perfect_score — get the badge without a surprise 9pm "new badge!" DM: the trg_queue_badge_dm
-- enqueue trigger is disabled for the backfill).
--
-- Delivery for FUTURE awards flows through queue_badge_dm → notify-badge-award (as TEXT until a
-- CODE_TO_IMG entry adds a Cloudinary image card — a follow-up). Awards are idempotent via
-- award_badge()'s ON CONFLICT and user_badges' unique (user_id, badge_id).
-- Companion: 20260810140100 adds both to reconcile_missing_badges() (the daily self-heal leg).

-- 1. Seed the two badges (idempotent).
insert into public.badges (code, name_uz, name_ru, name_en, description_uz, description_ru, description_en, icon, position, criteria) values
  ('level_5',
   '5-daraja', '5-й уровень', 'Level 5',
   '1000 XP to''pladingiz — Master yo''lidasiz.', 'Вы набрали 1000 XP — на пути к мастеру.', 'You reached 1000 XP — on the path to Master.',
   '⚡', 13, jsonb_build_object('type','level','min',5)),
  ('perfect_score',
   'Mukammal baho', 'Идеальная оценка', 'Perfect score',
   'Vazifaga to''liq ball oldingiz.', 'Вы получили максимальный балл за задание.', 'You earned full marks on a homework.',
   '💯', 14, jsonb_build_object('type','homework_perfect'))
on conflict (code) do nothing;

-- 2. level_5 — award when a student's XP level reaches 5. Trigger on user_xp; WHEN gate keeps it off
--    the hot path for the <level-5 majority. award_badge is idempotent + exception-wrapped so it can
--    never abort the XP upsert that fired it.
create or replace function public.award_level_badges()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if new.level >= 5 then
    begin perform public.award_badge(new.user_id, 'level_5'); exception when others then null; end;
  end if;
  return new;
end;
$$;
revoke execute on function public.award_level_badges() from public, anon, authenticated;
drop trigger if exists trg_award_level_badges on public.user_xp;
create trigger trg_award_level_badges
  after insert or update of level on public.user_xp
  for each row when (new.level >= 5)
  execute function public.award_level_badges();

-- 3. perfect_score — award when a homework is scored to the assignment's max_score (NULL max_score is
--    treated as 10, matching the grader's implicit max). WHEN gate skips the null-score insert/resubmit
--    rows; award is idempotent + exception-wrapped so it can never abort a homework grade write.
create or replace function public.award_perfect_score_badge()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare _max int;
begin
  if new.score is not null and (tg_op = 'INSERT' or old.score is distinct from new.score) then
    select coalesce(max_score, 10) into _max from public.homework_assignments where id = new.assignment_id;
    if _max is not null and new.score >= _max then
      begin perform public.award_badge(new.user_id, 'perfect_score'); exception when others then null; end;
    end if;
  end if;
  return new;
end;
$$;
revoke execute on function public.award_perfect_score_badge() from public, anon, authenticated;
drop trigger if exists trg_award_perfect_score on public.homework_submissions;
create trigger trg_award_perfect_score
  after insert or update of score on public.homework_submissions
  for each row when (new.score is not null)
  execute function public.award_perfect_score_badge();

-- 4. Heal history — SILENT backfill (disable the badge-DM enqueue trigger so old achievements don't
--    ping students today). Idempotent; re-enables the trigger even on error. The whole migration file
--    applies as one transaction, so a failure here rolls the entire file back atomically.
do $$
begin
  alter table public.user_badges disable trigger trg_queue_badge_dm;

  -- level_5: everyone already at level >= 5
  insert into public.user_badges (user_id, badge_id)
  select ux.user_id, b.id
  from public.user_xp ux
  cross join (select id from public.badges where code = 'level_5') b
  where ux.level >= 5
  on conflict (user_id, badge_id) do nothing;

  -- perfect_score: anyone with a graded homework at the assignment's max (NULL max => 10)
  insert into public.user_badges (user_id, badge_id)
  select distinct hs.user_id, b.id
  from public.homework_submissions hs
  join public.homework_assignments ha on ha.id = hs.assignment_id
  cross join (select id from public.badges where code = 'perfect_score') b
  where hs.score is not null and hs.score >= coalesce(ha.max_score, 10)
  on conflict (user_id, badge_id) do nothing;

  alter table public.user_badges enable trigger trg_queue_badge_dm;
exception when others then
  begin alter table public.user_badges enable trigger trg_queue_badge_dm; exception when others then null; end;
  raise;
end $$;
