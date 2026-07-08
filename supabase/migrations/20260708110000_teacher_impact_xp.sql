-- Teacher IMPACT XP (2026-07-08) — Teacher Engagement, Phase 1b.
-- The research's single strongest motivator for teachers is seeing their impact on students.
-- Award the student's group teacher +25 XP each time one of their students completes a module.
--
-- Signal source: nudge_module_celebrations — inserted exactly once per (student, module) when a
-- module is completed (PK profile_id, module_id), so awards are naturally deduplicated. Reuses the
-- generic award_xp; wrapped so it can never break the completion write. Additive only.

create or replace function public.xp_on_student_module_impact()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  _teacher uuid;
begin
  select g.teacher_id into _teacher
  from public.profiles p
  join public.groups g on g.id = p.group_id
  where p.id = new.profile_id;

  if _teacher is not null then
    begin
      perform public.award_xp(_teacher, 25, 'teacher_impact',
        'timpact:mod:' || new.profile_id::text || ':' || new.module_id::text);
    exception when others then
      raise warning 'xp_on_student_module_impact skipped (%, %): %', new.profile_id, new.module_id, sqlerrm;
    end;
  end if;
  return new;
end;
$$;
revoke execute on function public.xp_on_student_module_impact() from public, anon, authenticated;
drop trigger if exists trg_xp_student_module_impact on public.nudge_module_celebrations;
create trigger trg_xp_student_module_impact
  after insert on public.nudge_module_celebrations
  for each row execute function public.xp_on_student_module_impact();

-- Backfill: credit teachers for their students' past module completions (idempotent ref_key).
insert into public.xp_events (user_id, amount, reason, ref_key, created_at)
select g.teacher_id, 25, 'teacher_impact',
       'timpact:mod:' || nmc.profile_id::text || ':' || nmc.module_id::text,
       coalesce(nmc.queued_at, now())
from public.nudge_module_celebrations nmc
join public.profiles p on p.id = nmc.profile_id
join public.groups g on g.id = p.group_id
join auth.users u on u.id = g.teacher_id
where g.teacher_id is not null
on conflict (user_id, ref_key) do nothing;

-- Rebuild running totals from the authoritative ledger (idempotent).
insert into public.user_xp (user_id, total_xp, level, updated_at)
select e.user_id, sum(e.amount)::int, public.xp_level_for(sum(e.amount)::int), now()
from public.xp_events e
group by e.user_id
on conflict (user_id) do update
  set total_xp = excluded.total_xp, level = excluded.level, updated_at = now();
