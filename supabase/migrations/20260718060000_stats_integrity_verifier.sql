-- Daily student-stats integrity verifier (2026-07-18, owner request: never let a student lose
-- points; keep personal stats, personal rating, and group rating correct).
--
-- Personal stats (profile_stats), personal rating, and group rating are ALL derived live from two
-- things: the xp_events ledger and the user_xp total. So policing those two guarantees all three.
-- The existing reconcilers already HEAL (reconcile_all_xp hourly, lesson-completion + badge
-- reconcilers); what was missing is a daily END-TO-END verifier that heals residual drift AND
-- raises an alarm when it finds something it can't fix (= a real code bug for the ops agent).

create or replace function public.verify_student_stats_integrity()
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  _healed_missing int := 0;
  _drift_fixed int := 0;
  _residual_missing int := 0;
  _tok text;
  _admin record;
  _msg text;
begin
  -- 1. HEAL: award any missing lesson/homework/streak/daily XP + rebuild affected totals.
  select coalesce(sum(awarded), 0) into _healed_missing from public.reconcile_all_xp();

  -- 2. HEAL DRIFT *and* MISSING ROWS: rebuild any user_xp that is absent or disagrees with the
  --    ledger. Upsert (not update-only) because a MISSING user_xp row silently reads as 0 in
  --    profile_stats / group_leaderboard / user_group_rating_xp — the exact "lost points" class —
  --    and an update-only heal would neither fix nor detect it (review finding).
  with rebuilt as (
    insert into public.user_xp (user_id, total_xp, level, updated_at)
    select e.user_id, sum(e.amount)::int, public.xp_level_for(sum(e.amount)::int), now()
    from public.xp_events e
    group by e.user_id
    on conflict (user_id) do update
      set total_xp = excluded.total_xp, level = excluded.level, updated_at = now()
      where public.user_xp.total_xp is distinct from excluded.total_xp
    returning 1
  )
  select count(*) into _drift_fixed from rebuilt;

  -- 3. AUDIT RESIDUAL: a REAL student (has a profile) whose homework submission still lacks its
  --    submit-XP after healing → reconcile_all_xp couldn't award it (e.g. the auth.users-join
  --    exclusion class). This is a genuine code bug, not routine drift.
  select count(*) into _residual_missing
  from public.homework_submissions hs
  join public.profiles p on p.id = hs.user_id
  where not exists (
    select 1 from public.xp_events x
    where x.user_id = hs.user_id and x.ref_key = 'hw_submit:' || hs.assignment_id::text);

  -- 4. SIGNAL + ALARM.
  if _healed_missing > 0 or _drift_fixed > 0 or _residual_missing > 0 then
    -- DB-visible signal (agent-readable via the health endpoint's recent_errors).
    begin
      insert into public.platform_error_log (source, action, message, context)
      values ('stats-integrity', 'daily_verify',
        format('healed_missing=%s drift_fixed=%s residual_missing=%s', _healed_missing, _drift_fixed, _residual_missing),
        jsonb_build_object('healed_missing', _healed_missing, 'drift_fixed', _drift_fixed, 'residual_missing', _residual_missing));
    exception when others then null;
    end;

    -- DM admins ONLY on a residual (something healing could NOT fix = likely a real code bug the
    -- ops agent should investigate). Auto-healed drift doesn't alarm — it self-corrected.
    if _residual_missing > 0 then
      select value->>'bot_token' into _tok from public.platform_settings where key = 'telegram';
      if _tok is not null and _tok <> '' then
        _msg := '⚠️ Stats integrity: ' || _residual_missing ||
                ' ta real talaba topshirig''i XP''siz qoldi (avtomatik tuzatib bo''lmadi — kod xatosi bo''lishi mumkin). platform_error_log ''stats-integrity'' ni ko''ring.';
        for _admin in
          select distinct p.telegram_id from public.profiles p
          join public.user_roles r on r.user_id = p.id and r.role in ('admin','superadmin')
          where p.telegram_id is not null limit 3
        loop
          begin
            perform net.http_post(
              url := 'https://api.telegram.org/bot' || _tok || '/sendMessage',
              headers := jsonb_build_object('Content-Type','application/json'),
              body := jsonb_build_object('chat_id', _admin.telegram_id, 'text', _msg));
          exception when others then null;
          end;
        end loop;
      end if;
    end if;
  end if;

  return jsonb_build_object(
    'healed_missing', _healed_missing, 'drift_fixed', _drift_fixed,
    'residual_missing', _residual_missing, 'at', now());
end;
$fn$;

revoke execute on function public.verify_student_stats_integrity() from public, anon, authenticated;
grant execute on function public.verify_student_stats_integrity() to service_role;

-- Daily at 04:40 UTC (09:40 Tashkent), offset from the other reconcilers.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'verify-student-stats-integrity') then
    perform cron.unschedule('verify-student-stats-integrity');
  end if;
  perform cron.schedule('verify-student-stats-integrity', '40 4 * * *',
    $cmd$ select public.verify_student_stats_integrity() $cmd$);
end $$;
