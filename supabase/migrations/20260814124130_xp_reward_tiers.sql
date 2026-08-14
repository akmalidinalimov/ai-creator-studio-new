-- Reward tiers — a coarse PRESTIGE ladder layered on total XP (distinct from the fine-grained level +
-- skill-name framing). 5 tiers by default; the "distance to next tier" is the daily-return hook shown
-- on the profile + dashboard. Recognition/status only for v1 (the tier IS the reward); tunable via
-- platform_settings.xp_tiers (name/emoji/min_xp) with no deploy.
-- Invariant: the tiers array should always include a min_xp:0 floor tier; xp_tier_for still returns a
-- non-null tier even if a hand-edit drops it (falls back to the lowest tier).

insert into platform_settings (key, value)
select 'xp_tiers',
  '[{"name":"Bronze","emoji":"🥉","min_xp":0},
    {"name":"Silver","emoji":"🥈","min_xp":300},
    {"name":"Gold","emoji":"🥇","min_xp":600},
    {"name":"Platinum","emoji":"💎","min_xp":1000},
    {"name":"Diamond","emoji":"👑","min_xp":1500}]'::jsonb
where not exists (select 1 from platform_settings where key = 'xp_tiers');

-- Given a total XP, return the current tier + the next tier + distance/progress toward it, as jsonb.
-- Canonical so the profile, dashboard, and any future backend surface (celebration, group posts) agree.
create or replace function public.xp_tier_for(_total int)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with cfg as (
    select coalesce((select value from platform_settings where key = 'xp_tiers'),
                    '[{"name":"Bronze","emoji":"🥉","min_xp":0}]'::jsonb) as v
  ),
  tiers as (
    select row_number() over (order by (t->>'min_xp')::int) as idx,
           t->>'name' as name, coalesce(t->>'emoji', '') as emoji, (t->>'min_xp')::int as min_xp
    from cfg, jsonb_array_elements(cfg.v) t
  ),
  n as (select greatest(coalesce(_total, 0), 0) as total),
  cur as (
    -- Highest tier at/below the total; falls back to the lowest tier if the total is below every
    -- tier's floor (only possible via a hand-edit dropping the min_xp:0 tier) → tier is never null.
    select tiers.* from tiers, n
    order by (case when tiers.min_xp <= n.total then 0 else 1 end),
             (case when tiers.min_xp <= n.total then -tiers.min_xp else tiers.min_xp end)
    limit 1
  ),
  nxt as (select tiers.* from tiers, n where tiers.min_xp > n.total order by tiers.min_xp asc limit 1)
  select jsonb_build_object(
    'total',      (select total from n),
    'tier_index', (select idx from cur),
    'tier_name',  (select name from cur),
    'tier_emoji', (select emoji from cur),
    'tier_min',   (select min_xp from cur),
    'next_name',  (select name from nxt),
    'next_emoji', (select emoji from nxt),
    'next_min',   (select min_xp from nxt),
    'xp_to_next', case when exists (select 1 from nxt)
                       then (select min_xp from nxt) - (select total from n) else 0 end,
    'progress',   case when exists (select 1 from nxt)
                       then greatest(least(round(((select total from n) - (select min_xp from cur))::numeric
                                  / nullif((select min_xp from nxt) - (select min_xp from cur), 0), 3), 1), 0)
                       else 1 end,
    'is_max',     not exists (select 1 from nxt),
    'tiers',      (select jsonb_agg(jsonb_build_object('name', name, 'emoji', emoji, 'min_xp', min_xp) order by min_xp) from tiers)
  );
$$;
revoke execute on function public.xp_tier_for(int) from public, anon;
grant execute on function public.xp_tier_for(int) to authenticated, service_role;
