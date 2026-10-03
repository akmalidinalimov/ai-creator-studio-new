-- Homework posts silently dropped by a tier-blind auto-guess: column, heal, and the missing detector.
--
-- WHAT HAPPENED (2026-10-02/03, found by the owner-requested health check)
--   Picker mode holds a bare homework post and asks "which task?". If the student does not pick, the
--   expiry sweep auto-guesses a task. The guess looked at EVERY module of the course. On the
--   Challenge 6.0 ladder (module_limit 1; module 1 has one task) a student whose module-1 homework is
--   graded gets a guess in module 2, which is locked, and finalize then dropped the post as
--   'guess_tier_locked': no reaction, the picker deleted, nothing in the thread. 8 posts from 7
--   students (7 in AC CHALLENGE groups 1-2, 1 in 1-GURUH PRE 5.0), including a module-1 redo.
--   The drop WAS recorded (admin_actions hw_capture_skipped), but nothing reads those rows, so no
--   one was told. pkAsk itself promises "accepted even if you don't pick".
--
-- THE FIX (telegram-bot-webhook, same PR)
--   * The guess only considers modules the student can open (homework-routing.ts chooseGuessLeaf).
--   * When the guess is a graded task, the sweep asks ONCE more, in the thread, with the picker's own
--     resubmit button (15 min); only an unanswered second ask consumes the post, and then a note in
--     the thread says it was not filed. auto_asked_at (below) marks that second ask.
--   * A locked-module guess that is still possible (a per-module topic) leaves a note instead of
--     vanishing.
--
-- THIS MIGRATION
--   1. hw_pending_posts.auto_asked_at — the second-ask marker. Nullable, no default: every existing
--      row reads "not asked yet", which is the old behaviour.
--   2. HEAL: the posts dropped as guess_tier_locked since 2026-10-01 (Tashkent) are re-armed (the latest
--      one per student and thread)
--      (state 'pending', expires now), so the next sweep runs them through the new path: the student
--      gets the resubmit question under their own post. Selected by evidence, not by id: an 'expired'
--      row with a guess_tier_locked skip row for the same chat + sender at or after it. Skipped when
--      the student already has a live pending post in that thread (the one-live-post unique index).
--   3. DETECTOR: hw_capture_loss_watchdog(), hourly at :33. It DMs the admins about every NEW
--      hw_capture_failed row and every hw_capture_skipped row whose reason means the post went nowhere
--      AND the student was not told. Reasons that tell the student (a 🙈 cap, a redirect hint, an
--      "already graded" note) stay countable and unalarmed, as capture-signals.ts intends. Its state row
--      'hw_capture_loss_watchdog_state' carries checked_at, so hw_dm_health_stats().stale_watchdogs and
--      the daily GitHub verifier catch a cron that stops. Kill-switch: platform_settings
--      'hw_capture_loss_watchdog' {"enabled": false}.
--   No self-test calls the watchdog: it sends Telegram messages, and a deploy must not.

alter table public.hw_pending_posts add column if not exists auto_asked_at timestamptz;

comment on column public.hw_pending_posts.auto_asked_at is
  'When the expiry sweep asked a second time (its guess was a graded task). Set once; the next expiry consumes the post with a note. 20261003050000.';

-- 2. HEAL --------------------------------------------------------------------------------------------
do $$
declare
  _n int;
begin
  -- The skip row is written once per (reason, chat, sender, Tashkent day), so a second drop on the same
  -- day has no row of its own: match on the day. Only the LATEST dropped post per (student, thread) is
  -- re-armed, because one thread holds at most one live pending post (uq_hw_pending_live).
  with dropped as (
    select distinct on (pp.user_id, pp.telegram_chat_id, pp.telegram_thread_id) pp.id
      from public.hw_pending_posts pp
     where pp.state = 'expired'
       and pp.created_at >= timestamptz '2026-09-30 19:00:00+00'
       and exists (
         select 1 from public.admin_actions a
          where a.action = 'hw_capture_skipped'
            and a.details->>'reason' = 'guess_tier_locked'
            and a.details->>'chat_id' = pp.telegram_chat_id::text
            and a.details->>'telegram_id' = pp.from_tg_id::text
            and (a.created_at at time zone 'Asia/Tashkent')::date = (pp.created_at at time zone 'Asia/Tashkent')::date)
       and not exists (
         select 1 from public.hw_pending_posts live
          where live.user_id = pp.user_id
            and live.telegram_chat_id = pp.telegram_chat_id
            and live.telegram_thread_id = pp.telegram_thread_id
            and live.state = 'pending')
     order by pp.user_id, pp.telegram_chat_id, pp.telegram_thread_id, pp.created_at desc
  ), rearmed as (
    update public.hw_pending_posts pp
       set state = 'pending', expires_at = now(), reminder_at = now(), picker_message_id = null, auto_asked_at = null
      from dropped d
     where pp.id = d.id
       and pp.state = 'expired'
    returning pp.id
  )
  select count(*) into _n from rearmed;

  -- Evidence on 2026-10-03: 7 (8 dropped posts, two of them one student's in one thread). A few more
  -- may drop before this deploys; far more means the selection is wrong, so stop rather than re-arm.
  if _n > 40 then
    raise exception 'ABORT: the heal selected % posts, expected about 7', _n;
  end if;

  if not exists (select 1 from public.admin_actions where action = 'hw_guess_tier_locked_healed') then
    insert into public.admin_actions (actor_user_id, action, details)
    values (null, 'hw_guess_tier_locked_healed', jsonb_build_object(
      'at', now(), 'migration', '20261003050000', 'rearmed', _n,
      'why', 'posts dropped as guess_tier_locked since 2026-10-01 get the new resubmit question'));
  end if;
end $$;

-- 3. DETECTOR ----------------------------------------------------------------------------------------
create or replace function public.hw_capture_loss_watchdog()
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
-- Hourly. A homework post that went into no submission AND whose student was not told is a lost
-- piece of work; this DMs the admins about each new one (up to 10 per run, the rest next run).
declare
  _cfg jsonb;
  _state jsonb;
  _since timestamptz;
  _total int;
  _shown int;
  _upto timestamptz;
  _lines text;
  _tok text;
  _admin record;
  _dm int := 0;
  _msg text;
begin
  select value into _state from public.app_settings where key = 'hw_capture_loss_watchdog_state';
  if jsonb_typeof(_state) is distinct from 'object' then _state := '{}'::jsonb; end if;

  select value into _cfg from public.platform_settings where key = 'hw_capture_loss_watchdog';
  if coalesce(_cfg->>'enabled', '') = 'false' then
    insert into public.app_settings (key, value)
    values ('hw_capture_loss_watchdog_state', _state || jsonb_build_object('enabled', false, 'checked_at', now()))
    on conflict (key) do update set value = excluded.value;
    return jsonb_build_object('disabled', true, 'checked_at', now());
  end if;

  begin
    _since := (_state->>'seen_upto')::timestamptz;
  exception when others then
    _since := null;
  end;
  _since := least(coalesce(_since, now() - interval '1 hour'), now());

  with loss as (
    select a.created_at, a.action, a.details
      from public.admin_actions a
     where a.created_at > _since
       and (a.action in ('hw_capture_failed', 'auto_register_failed')
            or (a.action = 'hw_capture_skipped'
                and a.details->>'reason' in ('guess_tier_locked', 'tier_locked', 'sweep_unresolved',
                                             'pending_other_course', 'assignment_unresolved', 'sender_has_no_group')))
  ), shown as (
    select * from loss order by created_at limit 10
  )
  select (select count(*) from loss),
         (select count(*) from shown),
         (select max(created_at) from shown),
         (select string_agg(
                   E'\n• ' || replace(s.action, 'hw_capture_', '') || ' / ' || coalesce(s.details->>'reason', '?')
                   || case when coalesce(s.details->>'chat_id', '') ~ '^-100[0-9]+$'
                                and coalesce(s.details->>'message_id', '') ~ '^[0-9]+$'
                           then ' — https://t.me/c/' || substr(s.details->>'chat_id', 5) || '/'
                                || case when coalesce(s.details->>'thread_id', '') ~ '^[0-9]+$'
                                        then (s.details->>'thread_id') || '/' else '' end
                                || (s.details->>'message_id')
                           else '' end,
                   '' order by s.created_at)
            from shown s)
    into _total, _shown, _upto, _lines;

  if _shown > 0 then
    _msg := '⚠️ Uy vazifasi yo''qolmoqda: ' || _total || ' ta post hech qaysi vazifaga tushmadi va talabaga aytilmadi.'
            || coalesce(_lines, '')
            || case when _total > _shown then E'\n… yana ' || (_total - _shown) || ' ta keyingi tekshiruvda.' else '' end
            || E'\n(admin_actions: hw_capture_skipped / hw_capture_failed)';
    select value->>'bot_token' into _tok from public.platform_settings where key = 'telegram';
    if coalesce(_tok, '') <> '' then
      for _admin in
        select distinct p.telegram_id from public.profiles p
          join public.user_roles ro on ro.user_id = p.id and ro.role in ('admin', 'superadmin')
         where p.telegram_id is not null limit 3
      loop
        begin
          perform public.ops_net_post(
            p_url        := 'https://api.telegram.org/bot' || _tok || '/sendMessage',
            p_body       := jsonb_build_object('chat_id', _admin.telegram_id, 'text', left(_msg, 3900),
                                               'disable_web_page_preview', true),
            p_headers    := jsonb_build_object('Content-Type', 'application/json'),
            p_purpose    := 'hw_capture_loss_watchdog',
            p_timeout_ms := 5000);
          _dm := _dm + 1;
        exception when others then null; end;
      end loop;
    end if;

    if _dm > 0 then
      begin
        insert into public.admin_actions (actor_user_id, action, details)
        values (null, 'hw_capture_loss_watchdog_ALARM',
                jsonb_build_object('total', _total, 'shown', _shown, 'since', _since, 'upto', _upto, 'dm_attempted', _dm));
      exception when others then null; end;
      _state := _state || jsonb_build_object('seen_upto', _upto, 'undelivered', null, 'last_alert_at', now());
    else
      -- Nothing reached ops_net_post (no token / no admin / it raised): keep seen_upto so the next hour
      -- retries, and write ONE row per episode instead of one per hour.
      if _state->'undelivered' is null or jsonb_typeof(_state->'undelivered') = 'null' then
        begin
          insert into public.admin_actions (actor_user_id, action, details)
          values (null, 'hw_capture_loss_watchdog_undelivered', jsonb_build_object('total', _total, 'since', _since));
        exception when others then null; end;
      end if;
      _state := _state || jsonb_build_object('undelivered', now());
    end if;
  else
    _state := _state || jsonb_build_object('seen_upto', now(), 'undelivered', null);
  end if;

  insert into public.app_settings (key, value)
  values ('hw_capture_loss_watchdog_state', _state || jsonb_build_object(
    'enabled', true, 'last_total', _total, 'last_dm', _dm, 'checked_at', now()))
  on conflict (key) do update set value = excluded.value;

  return jsonb_build_object('total', _total, 'shown', _shown, 'dm_attempted', _dm, 'since', _since, 'checked_at', now());
end
$fn$;

revoke execute on function public.hw_capture_loss_watchdog() from public, anon, authenticated;

-- Start watching from now: the 8 drops above are being healed, and were reported in the PR.
insert into public.app_settings (key, value)
values ('hw_capture_loss_watchdog_state', jsonb_build_object('seen_upto', now(), 'enabled', true, 'checked_at', now()))
on conflict (key) do nothing;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'hw-capture-loss-watchdog') then
    perform cron.unschedule('hw-capture-loss-watchdog');
  end if;
  perform cron.schedule('hw-capture-loss-watchdog', '33 * * * *', 'select public.hw_capture_loss_watchdog()');
end $$;
