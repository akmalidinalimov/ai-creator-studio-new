CREATE OR REPLACE FUNCTION public.freeze_challenge_week(_week_start date DEFAULT NULL::date)
 RETURNS TABLE(individual integer, team integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  _this_mon timestamptz; _prev_mon timestamptz; _week date; _manual boolean := (_week_start is not null);
  _ind int := 0; _team int := 0;
begin
  if _manual and extract(dow from _week_start) <> 1 then
    raise exception 'week_start must be a Monday (got % = %)', _week_start, to_char(_week_start, 'Day');
  end if;

  -- Week boundaries in Tashkent, matching post_group_weekly_boards() exactly.
  _this_mon := (date_trunc('week', (now() at time zone 'Asia/Tashkent')) at time zone 'Asia/Tashkent');
  _prev_mon := _this_mon - interval '7 days';
  _week     := coalesce(_week_start, _prev_mon::date);
  if _manual then
    _prev_mon := (_week_start::timestamp at time zone 'Asia/Tashkent');
    _this_mon := _prev_mon + interval '7 days';
  end if;

  -- Was the challenge running during the week being frozen? (Not: is it running right now.)
  if not _manual and not (public.challenge_active(_prev_mon) or public.challenge_active(_this_mon - interval '1 second')) then
    return query select 0, 0; return;
  end if;

  perform pg_advisory_xact_lock(hashtext('freeze_challenge_week'));

  if _manual then
    delete from challenge_weekly_results where week_start = _week;
  end if;

  with staff as (
    select distinct ur.user_id from user_roles ur
    where ur.role in ('teacher'::app_role, 'admin'::app_role, 'superadmin'::app_role)
  ),
  scored as (
    select p.id as user_id, p.group_id,
           ( public.user_group_rating_xp_since(p.id, g.course_id, _prev_mon)
           - public.user_group_rating_xp_since(p.id, g.course_id, _this_mon) ) as pts
    from profiles p
    join groups g on g.id = p.group_id
    where p.group_id in (select public.challenge_scope_group_ids())
      and p.status = 'active' and p.archived_at is null
      and p.id not in (select user_id from staff)
  ),
  ranked as (
    select user_id, group_id, pts,
           row_number() over (partition by group_id order by pts desc, user_id) as rnk
    from scored where pts > 0
  )
  insert into challenge_weekly_results (week_start, kind, group_id, user_id, points, rank, details)
  select _week, 'individual', r.group_id, r.user_id, r.pts::int, r.rnk::int,
         jsonb_build_object('week_points', r.pts, 'frozen_at', now(), 'manual', _manual)
  from ranked r where r.rnk <= 10
  on conflict on constraint uq_challenge_weekly do nothing;
  get diagnostics _ind = row_count;

  insert into challenge_weekly_results (week_start, kind, group_id, user_id, points, rank, details)
  select _week, 'team', t.group_id, null, t.total_points::int,
         (row_number() over (order by t.avg_points desc, t.total_points desc, t.group_id))::int,
         jsonb_build_object('members', t.members, 'total_points', t.total_points,
                            'avg_points', t.avg_points, 'ranked_by', 'avg_points',
                            'frozen_at', now(), 'manual', _manual)
  from public.challenge_team_board(_prev_mon, _this_mon) t
  on conflict on constraint uq_challenge_weekly do nothing;
  get diagnostics _team = row_count;

  begin
    insert into admin_actions (actor_user_id, action, details)
    values (null, 'challenge_week_frozen',
            jsonb_build_object('week', _week, 'individual', _ind, 'team', _team,
                               'manual', _manual, 'at', now()));
  exception when others then null; end;

  return query select _ind, _team;
end;
$function$
