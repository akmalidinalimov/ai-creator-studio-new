-- TEACHER FOLLOW-UPS from the #233-#240 reviews: ONE waiting rule for every teacher count, a detector for the
-- teacher Mini App buttons, and the 🎯 Mini App button on the SQL fallback teacher DM.
--
-- ═══ 1. ONE WAITING RULE (verified read-only against production, 2026-10-01) ═══
-- The grading queue (teacher_pending_submissions) and the "N kutilmoqda" badge (teacher_groups, since #235 /
-- 20260930182000) count a submission as waiting when it is ungraded OR a resubmission awaiting a re-grade:
-- `(hs.score is null or hs.score_is_stale is true)`. start_homework_resubmission()'s graded branch KEEPS the
-- score and only sets score_is_stale, so `score is null` alone misses every re-grade. Five teacher-facing
-- counts still used `score is null` only:
--   teacher_group_signals()             (#236) the per-group engine of the 21:00 digest, the hourly nudge and the
--                                       daily report's "📥 Baholanmagan" backlog and its "📝 Baholash (N)" button
--   teacher_engagement_xp_candidates()  (#236) the +20 teacher_queue_clear: paid while a re-grade still waited
--   teacher_weekly_self()               the teacher's own backlog (web profile, bot card, weekly digest)
--   teacher_group_statistics(uuid)      the per-group "pending_homework_count" (/tstats and the bot's group stats)
--   teacher_group_statistics(uuid,uuid)
-- Today, 2-GURUH VIP 5.0: queue and badge 7, digest / nudge / daily report 6 (one stale re-grade, submission
-- e41e7e3b, resubmitted 2026-09-29 18:48). The daily report's 📝 Baholash (N) opens /tg/teacher/grade, the WHOLE
-- queue ("Hammasi" filter, teacher_group_ids = the same pairs as teacher_group_pairs), so N read 6 for a queue of 7.
-- FIX: each of the five gets the queue's rule, one line each, as a pinned rewrite (below). Nothing else changes.
-- The TypeScript side already uses it everywhere (the bot's `score.is.null,score_is_stale.is.true`).
-- Admin-only analytics that also read `score is null` (admin_teacher_stats, admin_teacher_groups,
-- admin_teacher_weekly, admin_course_group_stats, homework_pending_count_for_user) are left as they are on
-- purpose: they are not shown to teachers next to the badge, and today they differ by that one row.
--
-- QUEUE-CLEAR XP. Paid by award_teacher_engagement_xp() (cron :07 every 4 h) from the candidates, with the ref key
-- 'tqueueclear:<teacher>:<Tashkent date>', for TODAY only. NO reconciler re-derives it: reconcile_all_xp() rebuilds
-- lesson_complete / homework_submit / homework_high_score / daily_active only, and no function deletes
-- teacher_queue_clear rows (checked in pg_proc and cron.job, 2026-10-01). So the stricter rule claws nothing back:
-- the 73 past awards (1,460 XP, 2026-07-08 .. 09-24) stay. Read-only estimate of the class: up to 16 of them were
-- paid while a resubmission (attempt > 1) of the teacher's groups was waiting for its re-grade; they are left
-- alone, as #236 decided for teacher_answer. From now on a teacher earns the +20 only when the queue is empty.
-- Today nobody's candidate changes (Rano's group also has 6 ungraded).
--
-- ═══ 2. TEACHER BUTTON DETECTOR ═══
-- #239 moved the teacher DMs' buttons into the teacher Mini App and, by design, keeps their signals OUT of the
-- student detector: 'teacher_miniapp_button_fallback' (a malformed MINIAPP_BASE), 'teacher_miniapp_button_rejected'
-- (Telegram refused a web_app button; the sender resent today's keyboard) and 'teacher_miniapp_open' (a tap). Nothing
-- read them (pg_proc, cron.job: 0 hits), so a broken teacher button fell back quietly.
-- public.teacher_button_health()  STABLE, read-only, one jsonb verdict:
--   button_fault   any fallback / rejected row in 24 h. A rejected row whose Telegram description is about ONE
--                  member (blocked, never started, "user not found" ...) is counted apart
--                  (fault_rows_recipient_24h) and never alarms — the same regex fix/telegram-recipient-class gives
--                  the student detector (telegram-classify.ts isRecipientError plus its additions, verbatim).
--   opens_missing  the flag is on, at least 10 🎯 Baholash buttons went out (teacher new-homework DMs delivered —
--                  every one carries the button while the flag is on, a fault writes its own row — plus the 24 h
--                  reminders' buttons.web_app) and ZERO teacher_miniapp_open, counted only since this detector
--                  started AND since the flag was last seen switching on, 72 h at most.
--   tally_missing  a teacher-daily-digest run or a teacher ungraded reminder since the seed without its
--                  details.buttons tally (the new sender code is not deployed: "the metric nothing writes").
--   informational: flag_read_failed_24h (the senders' 'teacher_miniapp_flag_read_failed': they keep today's buttons),
--                  the daily report's web_app buttons, the drainer's per-DM button, opens by src.
-- public.teacher_button_watchdog()  SECURITY DEFINER, hourly at :33 (cron 'teacher-button-watchdog'). DMs up to 3
--   admins through public.ops_net_post (Content-Type passed), re-alerts every 6 h while it persists, one
--   "recovered" message, teacher_button_watchdog_ALARM / _recovered rows. State row 'teacher_button_watchdog_state':
--   its *_watchdog_state name puts it under hw_dm_health_stats()'s liveness scan (and through it the out-of-band
--   GitHub verifier), which flags it if it stops for 25 h. watch_button_health / watch_button_watchdog are NOT
--   touched (fix/telegram-recipient-class rewrites them).
--
-- ═══ 3. THE SQL FALLBACK TEACHER DM GETS THE 🎯 MINI APP BUTTON ═══
-- hw_dm_fallback_deliver() (live md5 4025f040…, 20260930182000) delivers the new-homework DM when the drainer is
-- down. The drainer (notify-homework-submission) has sent, since #239, [🎯 Baholash ↗ web_app] first and the
-- in-chat flow as "🎤 Chatda (ovoz bilan)" when platform_settings.teacher_miniapp is on; the fallback still sent
-- only the callback. Now its keyboard is public.hw_dm_fallback_keyboard(submission, message_url, app_on):
--   app_on (flag on AND a private chat, telegram_id > 0 — teacherAppButton's rules):
--     [🎯 Baholash ↗ web_app https://www.aicreator.academy/tg/teacher/grade?sub=<id>&src=teacher_hw_dm&ref=<id>]
--     [📂 Postni ko'rish? , 🎤 Chatda (ovoz bilan) (gs:open:<id>)]
--   off: today's keyboard, the same jsonb as before, byte for byte.
-- The url is MINIAPP_BASE's default (_shared/miniapp-button.ts DEFAULT_MINIAPP_BASE) + withTrack(teacherGradePath(id),
-- {src: 'teacher_hw_dm', ref: id}) — SQL cannot read the edge secret, the same choice every SQL admin link makes.
-- The flag is public.teacher_miniapp_enabled(), the SQL twin of parseTeacherMiniAppFlag: no row → on; a row → only
-- {"enabled": true}. Kept in step by this file's keyboard parity cases (asserted below) and
-- src/test/hw-dm-fallback-keyboard-parity.test.ts (vitest, CI: TypeScript = the same cases). The fallback cannot
-- resend after a Telegram refusal (pg_net is fire-and-forget); the drainer sends the identical url every day and
-- would raise teacher_miniapp_button_rejected (now alarmed) first, and teacher_miniapp.enabled=false reverts both.
--
-- ═══ 4. "📝 Baholash (N)" = THE QUEUE IT OPENS ═══
-- teacher_daily_report().ungraded_backlog is sum(teacher_group_signals().pending_homework) per teacher, so item 1
-- fixes it; the self-test below asserts report backlog = signals sum = the rule's count, per teacher.
--
-- ═══ HOW (the pinned-rewrite pattern, as 20260930182000) ═══
-- Each function is rewritten FROM ITS LIVE pg_get_functiondef, only if md5(replace(prosrc, CR, '')) is the value
-- read on 2026-10-01; anything else aborts with "regenerate". Every edit must match exactly once. After EXECUTE
-- (body validation on) the stored definition must equal the executed one; owner, ACL, SECURITY DEFINER,
-- search_path and volatility must be unchanged, and the new body must have the md5 the PGlite harness verified.
-- REPLAY-SAFE: the marker "(20261001080000)" means a rewrite is in place; its body must then have the verified md5,
-- and it is skipped. Helpers are CREATE OR REPLACE; the cron job is re-made; the state seed and audit are once.
-- Harness: supabase/functions/_teacher/testing/teacher-waiting-rule-check.ts (PGlite, on production's text: the
-- committed live fixtures + 20260930182000 + 20260930183000 reproduce every pin; teacher_group_statistics from
-- teacher_group_statistics.live-2026-10-01.sql).
--
-- ═══ SELF-TEST (read-only: never sends, awards, needs a JWT, or mutates what it checks) ═══
--   W1 every teacher_group_signals row: pending_homework = the queue's rule counted for its group.
--   W2 teacher_daily_report (its guard admits auth.uid() IS NULL — the cron's service role, and this migration):
--      ungraded_backlog = the signals' sum per teacher.  W3 teacher_nudge_signals: the same.
--   W4 no queue-clear candidate teacher has anything waiting, by the rule, in a group they teach.
--   W5 the badge and the queue carry the very rule (catalog); teacher_weekly_self / teacher_group_statistics need a
--      JWT, so they are checked from the catalog here and end to end in the harness.
--   K  hw_dm_fallback_keyboard = "want" on every keyboard parity case (a pure function).
--   F  hw_dm_fallback_deliver is NOT called (it sends): its candidate SELECT is cut from the stored body and run.
--   H  teacher_button_health() returns a verdict (the SHAPE, never "false": a real fault at deploy must not fail it).
--   teacher_button_watchdog() is never called here (it sends).
--
-- KILL-SWITCHES: select cron.unschedule('teacher-button-watchdog');  — the detector.
--   platform_settings.teacher_miniapp = {"enabled": false}  — every teacher Mini App button, the fallback's included.

-- ─────────────────────────────── helpers ───────────────────────────────
create or replace function public.teacher_miniapp_enabled()
returns boolean
language sql
stable
set search_path to 'public'
as $fn$
  -- (20261001080000) platform_settings.teacher_miniapp, the SQL twin of _shared/teacher-miniapp.ts
  -- parseTeacherMiniAppFlag: no row -> ON (the seed is {"enabled": true}); a row -> only a JSON true enables.
  select coalesce((select case when jsonb_typeof(ps.value) = 'object'
                               then coalesce(ps.value->'enabled' = 'true'::jsonb, false)
                               else false end
                     from public.platform_settings ps
                    where ps.key = 'teacher_miniapp'), true)
$fn$;

create or replace function public.hw_dm_fallback_keyboard(p_submission_id uuid, p_message_url text, p_app_on boolean)
returns jsonb
language sql
immutable
parallel safe
set search_path to 'public'
as $fn$
  -- (20261001080000) The keyboard of the SQL fallback teacher DM (hw_dm_fallback_deliver).
  --   p_app_on false: TODAY's keyboard, unchanged — [📂 Postni ko'rish (a https://t.me/c/ post only), 🎯 Baholash (gs:open)]
  --   p_app_on true:  the drainer's (notify-homework-submission/copy.ts submissionDmKeyboard + _shared/teacher-miniapp.ts
  --                   teacherAppButton): [🎯 Baholash ↗ web_app] · [📂 Postni ko'rish?, 🎤 Chatda (ovoz bilan) (gs:open)]
  -- The url = DEFAULT_MINIAPP_BASE + withTrack(teacherGradePath(id), {src: 'teacher_hw_dm', ref: id}), byte for byte.
  -- gs:open:<uuid> = 44 bytes, under Telegram's 64-byte callback_data cap.
  select jsonb_build_object('inline_keyboard',
    case when p_app_on
         then jsonb_build_array(jsonb_build_array(jsonb_build_object(
                'text', '🎯 Baholash',
                'web_app', jsonb_build_object('url',
                  'https://www.aicreator.academy/tg/teacher/grade'
                  || case when p_submission_id is null then '?src=teacher_hw_dm'
                          else '?sub=' || lower(p_submission_id::text) || '&src=teacher_hw_dm&ref='
                               || lower(p_submission_id::text) end))))
         else '[]'::jsonb end
    || jsonb_build_array(
         case when p_message_url like 'https://t.me/c/%'
              then jsonb_build_array(jsonb_build_object('text', '📂 Postni ko''rish', 'url', p_message_url))
              else '[]'::jsonb end
         || jsonb_build_array(jsonb_build_object(
              'text', case when p_app_on then '🎤 Chatda (ovoz bilan)' else '🎯 Baholash' end,
              'callback_data', 'gs:open:' || p_submission_id))))
$fn$;

create or replace function public.teacher_button_health()
returns jsonb
language plpgsql
stable
set search_path to 'public'
as $function$
-- (20261001080000) Is every teacher Mini App button (#239) working? One read-only verdict; see the migration header.
declare
  -- telegram-classify.ts isRecipientError + the per-recipient answers fix/telegram-recipient-class adds, verbatim:
  -- a refusal about ONE member (blocked the bot, never started it, gone) is not a fault of our button.
  _recipient_rx constant text := 'bot was blocked|chat not found|user is deactivated|can''t initiate|peer_id_invalid|user_is_blocked|have no rights|forbidden|chat_id is empty|bots can''t send|user not found|user_id_invalid|invalid user_id|participant_id_invalid|member not found|not enough rights|group chat was upgraded';
  _min_grade_buttons constant int := 10;
  _state jsonb;
  _first timestamptz;
  _flag_since timestamptz;
  _since timestamptz;
  _tally_since timestamptz;
  _on boolean;
  _fault_n bigint;
  _fault_rows jsonb;
  _recipient_n bigint;
  _flag_read_failed bigint;
  _hw_dms bigint;
  _drainer_web_app bigint;
  _rem_web_app bigint;
  _rem_rows bigint;
  _rem_rows_tally bigint;
  _rep_web_app bigint;
  _rep_runs bigint;
  _rep_runs_tally bigint;
  _opens bigint;
  _opens_by_src jsonb;
  _grade_buttons bigint;
  _button_fault boolean;
  _opens_missing boolean;
  _tally_missing boolean;
begin
  select value into _state from public.app_settings where key = 'teacher_button_watchdog_state';
  begin
    _first := (_state->>'first_checked_at')::timestamptz;
  exception when others then
    _first := null;
  end;
  begin
    _flag_since := (_state->>'flag_on_since')::timestamptz;
  exception when others then
    _flag_since := null;
  end;
  _on := public.teacher_miniapp_enabled();
  -- Only buttons sent while this detector watched AND the flag was on count, 72 h at most: traffic from before
  -- the deploy or the switch-on must never read as "sent but never opened". No state row -> an empty window.
  _since := greatest(now() - interval '72 hours', coalesce(_first, now()), coalesce(_flag_since, now()));
  _tally_since := greatest(now() - interval '48 hours', coalesce(_first, now()));

  -- Faults (24 h): a malformed MINIAPP_BASE, or Telegram refusing a teacher web_app button.
  select coalesce(sum(f.n) filter (where not f.rcpt), 0),
         coalesce(jsonb_object_agg(f.action, f.n) filter (where not f.rcpt), '{}'::jsonb),
         coalesce(sum(f.n) filter (where f.rcpt), 0)
    into _fault_n, _fault_rows, _recipient_n
  from (
    select a.action,
           (a.action = 'teacher_miniapp_button_rejected'
            and coalesce(a.details->>'error', '') ~* _recipient_rx) as rcpt,
           count(*) as n
    from public.admin_actions a
    where a.action in ('teacher_miniapp_button_fallback', 'teacher_miniapp_button_rejected')
      and a.created_at > now() - interval '24 hours'
    group by 1, 2
  ) f;

  select count(*) into _flag_read_failed from public.admin_actions a
  where a.action = 'teacher_miniapp_flag_read_failed' and a.created_at > now() - interval '24 hours';

  -- 🎯 Baholash buttons out. Every delivered teacher new-homework DM carries one while the flag is on (the bot's
  -- immediate send and the drainer stamp the same queue row; the bot records no per-DM row of its own).
  select count(*) into _hw_dms from public.homework_teacher_dm_queue q
  where q.sent_at > _since and (q.error is null or q.error = 'sql_fallback_delivery');
  select count(*) into _drainer_web_app from public.admin_actions a
  where a.action = 'homework_submission_dm_sent' and a.created_at > _since and a.details->>'button' = 'web_app';
  select coalesce(sum(case when coalesce(a.details->'buttons'->>'web_app', '') ~ '^[0-9]{1,9}$'
                           then (a.details->'buttons'->>'web_app')::bigint else 0 end), 0)
    into _rem_web_app
  from public.admin_actions a
  where a.action = 'ungraded_homework_reminder_sent' and a.created_at > _since;
  select coalesce(sum(case when coalesce(a.details->'buttons'->>'web_app', '') ~ '^[0-9]{1,9}$'
                           then (a.details->'buttons'->>'web_app')::bigint else 0 end), 0)
    into _rep_web_app
  from public.admin_actions a
  where a.action = 'teacher_daily_report_run' and a.created_at > _since;

  -- The tallies the senders must write (since the seed).
  select count(*), count(*) filter (where jsonb_typeof(a.details->'buttons') = 'object')
    into _rem_rows, _rem_rows_tally
  from public.admin_actions a
  where a.action = 'ungraded_homework_reminder_sent' and a.created_at > _tally_since
    and a.details->>'recipient_kind' = 'teacher';
  select count(*), count(*) filter (where jsonb_typeof(a.details->'buttons') = 'object')
    into _rep_runs, _rep_runs_tally
  from public.admin_actions a
  where a.action = 'teacher_daily_report_run' and a.created_at > _tally_since;

  select coalesce(sum(o.n), 0), coalesce(jsonb_object_agg(o.src, o.n), '{}'::jsonb)
    into _opens, _opens_by_src
  from (
    select coalesce(a.details->>'src', '?') as src, count(*) as n
    from public.admin_actions a
    where a.action = 'teacher_miniapp_open' and a.created_at > _since
    group by 1
  ) o;

  _grade_buttons := case when _on then coalesce(_hw_dms, 0) + coalesce(_rem_web_app, 0) else 0 end;
  _button_fault := coalesce(_fault_n, 0) > 0;
  _opens_missing := _on and _grade_buttons >= _min_grade_buttons and coalesce(_opens, 0) = 0;
  _tally_missing := coalesce(_rep_runs, 0) > coalesce(_rep_runs_tally, 0)
                    or coalesce(_rem_rows, 0) > coalesce(_rem_rows_tally, 0);

  return jsonb_build_object(
    'alarm', _button_fault or _opens_missing or _tally_missing,
    'button_fault', _button_fault,
    'opens_missing', _opens_missing,
    'tally_missing', _tally_missing,
    'flag_on', _on,
    'since', _since,
    'fault_rows_24h', coalesce(_fault_rows, '{}'::jsonb),
    'fault_rows_recipient_24h', coalesce(_recipient_n, 0),
    'flag_read_failed_24h', coalesce(_flag_read_failed, 0),
    'buttons', jsonb_build_object(
      'hw_dms', coalesce(_hw_dms, 0), 'drainer_web_app', coalesce(_drainer_web_app, 0),
      'reminder_web_app', coalesce(_rem_web_app, 0), 'report_web_app', coalesce(_rep_web_app, 0),
      'grade_buttons', _grade_buttons, 'min_grade_buttons', _min_grade_buttons),
    'opens', coalesce(_opens, 0),
    'opens_by_src', coalesce(_opens_by_src, '{}'::jsonb),
    'tally', jsonb_build_object(
      'report_runs', coalesce(_rep_runs, 0), 'report_runs_with_tally', coalesce(_rep_runs_tally, 0),
      'reminder_rows', coalesce(_rem_rows, 0), 'reminder_rows_with_tally', coalesce(_rem_rows_tally, 0)),
    'checked_at', now());
end;
$function$;

create or replace function public.teacher_button_watchdog()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
-- (20261001080000) Hourly: teacher_button_health() -> a DM to the admins on an alarm (re-sent every 6 h while it
-- lasts), one "recovered" DM, and the state row teacher_button_watchdog_state (its checked_at is the liveness signal
-- hw_dm_health_stats() reads).
declare
  _r jsonb;
  _alarm boolean;
  _state jsonb;
  _alerting boolean;
  _last_ms bigint;
  _should_alert boolean := false;
  _recovered boolean := false;
  _now_ms bigint := (extract(epoch from now()) * 1000)::bigint;
  _tok text;
  _admin record;
  _msg text := '';
  _req bigint;
  _dm int := 0;
  _on boolean;
  _flag_since timestamptz;
begin
  select value into _state from public.app_settings where key = 'teacher_button_watchdog_state';
  -- When the flag was last seen switching on bounds the "sent but never opened" window (teacher_button_health).
  begin
    _on := public.teacher_miniapp_enabled();
    _flag_since := (_state->>'flag_on_since')::timestamptz;
  exception when others then
    _flag_since := null;
  end;
  _flag_since := case when _on then coalesce(_flag_since, now()) else null end;

  begin
    _r := public.teacher_button_health();
  exception when others then
    _r := jsonb_build_object('alarm', true, 'health_error', left(sqlerrm, 300));
  end;
  -- A verdict we cannot read is itself an alarm, never a quiet "false".
  _alarm := coalesce(_r->>'alarm' = 'true', true);

  _alerting := coalesce(_state->>'alerting', '') = 'true';
  _last_ms := least(
    coalesce(case when coalesce(_state->>'last_alert_ms', '') ~ '^[0-9]{1,15}$'
                  then (_state->>'last_alert_ms')::bigint end, 0),
    _now_ms);

  if _alarm then
    if (not _alerting) or (_now_ms - _last_ms > 21600000) then _should_alert := true; end if; -- 6 h
  elsif _alerting then
    _recovered := true;
  end if;

  if _should_alert or _recovered then
    select value->>'bot_token' into _tok from public.platform_settings where key = 'telegram';
    if coalesce(_tok, '') <> '' then
      if _should_alert then
        if coalesce(_r->>'opens_missing', '') = 'true' then
          _msg := _msg || '🚨 Ustoz Mini App tugmalari: ustozlarga ' || coalesce(_r->'buttons'->>'grade_buttons', '?')
               || ' ta «🎯 Baholash» tugmasi yuborildi, lekin birortasi ham ochilmadi (teacher_miniapp_open = 0, '
               || to_char((_r->>'since')::timestamptz at time zone 'Asia/Tashkent', 'DD.MM HH24:MI') || ' dan beri). '
               || 'Ustoz ilovasi (/tg/teacher) yoki tg-miniapp-auth buzilgan boʻlishi mumkin — ustoz akkauntida '
               || '«🎯 Baholash»ni bosib tekshiring. Tezkor qaytarish: platform_settings.teacher_miniapp = '
               || '{"enabled": false} (ustozlarga eski tugmalar qaytadi).' || E'\n';
        end if;
        if coalesce(_r->>'button_fault', '') = 'true' then
          _msg := _msg || '⚠️ Ustoz Mini App tugmalari: soʻnggi 24 soatda tugma ishlamadi — '
               || coalesce(_r->>'fault_rows_24h', '{}')
               || '. Ustozlarga eski tugma ketdi, xabar yoʻqolmadi. teacher_miniapp_button_fallback = MINIAPP_BASE '
               || 'notoʻgʻri; teacher_miniapp_button_rejected = Telegram rad etdi (admin_actions). Tezkor oʻchirish: '
               || 'platform_settings.teacher_miniapp = {"enabled": false}.' || E'\n';
        end if;
        if coalesce(_r->>'tally_missing', '') = 'true' then
          _msg := _msg || '⚠️ Ustoz tugmalari hisobi yozilmayapti: teacher-daily-digest yoki '
               || 'cron-ungraded-homework-reminder «buttons» maydonisiz ishladi — yangi versiya deploy boʻlmagan. '
               || coalesce(_r->>'tally', '{}') || E'\n';
        end if;
        if _r ? 'health_error' then
          _msg := _msg || '⚠️ teacher_button_health() ishlamadi: ' || (_r->>'health_error') || E'\n';
        end if;
        if _msg = '' then
          _msg := '⚠️ Ustoz tugmalari watchdog holatni oʻqiy olmadi: ' || coalesce(_r::text, 'NULL') || E'\n';
        end if;
      else
        _msg := '✅ Ustoz Mini App tugmalari normallashdi.';
      end if;

      for _admin in
        select distinct p.telegram_id from public.profiles p
        join public.user_roles r on r.user_id = p.id and r.role in ('admin', 'superadmin')
        where p.telegram_id is not null limit 3
      loop
        begin
          _req := public.ops_net_post(
            p_url        := 'https://api.telegram.org/bot' || _tok || '/sendMessage',
            p_body       := jsonb_build_object('chat_id', _admin.telegram_id, 'text', left(_msg, 3900)),
            p_headers    := jsonb_build_object('Content-Type', 'application/json'),
            p_purpose    := 'teacher_button_watchdog',
            p_timeout_ms := 5000);
          _dm := _dm + 1;
        exception when others then null; end;
      end loop;
    end if;

    begin
      insert into public.admin_actions (actor_user_id, action, details)
      values (null,
              case when _should_alert then 'teacher_button_watchdog_ALARM' else 'teacher_button_watchdog_recovered' end,
              _r || jsonb_build_object('dm_attempted', _dm));
    exception when others then null; end;
  end if;

  insert into public.app_settings (key, value)
  values ('teacher_button_watchdog_state', jsonb_build_object(
    'alerting', _alarm,
    -- Only a send that was actually attempted starts the 6 h cooldown; otherwise the next run retries.
    'last_alert_ms', case when _should_alert and _dm > 0 then _now_ms else _last_ms end,
    'first_checked_at', coalesce(_state->'first_checked_at', to_jsonb(now())),
    'flag_on_since', to_jsonb(_flag_since),
    'dm_attempted_last_run', _dm,
    'last_report', _r,
    'checked_at', now()))
  on conflict (key) do update set value = excluded.value;

  return _r;
end;
$function$;

-- House pattern: PUBLIC first, then the roles; only service_role (and the owner) may run them.
revoke execute on function public.teacher_miniapp_enabled() from public, anon, authenticated;
grant  execute on function public.teacher_miniapp_enabled() to service_role;
revoke execute on function public.hw_dm_fallback_keyboard(uuid, text, boolean) from public, anon, authenticated;
grant  execute on function public.hw_dm_fallback_keyboard(uuid, text, boolean) to service_role;
revoke execute on function public.teacher_button_health() from public, anon, authenticated;
grant  execute on function public.teacher_button_health() to service_role;
revoke execute on function public.teacher_button_watchdog() from public, anon, authenticated;
grant  execute on function public.teacher_button_watchdog() to service_role;

-- ─────────────────────────────── the pinned rewrites (1 + 3) ───────────────────────────────
do $mig$
declare
  _marker constant text := '(20261001080000)';
  r record;
  _fn regprocedure;
  _src text; _def text; _new text; _n int;
  _acl text[]; _owner oid; _secdef boolean; _pcfg text[]; _vol "char";
begin
  perform set_config('check_function_bodies', 'on', true);

  for r in
    select * from (values
      ('public.teacher_group_signals(integer,integer)',
       'd39a752d293d78b717b08837759e2b03',                -- live md5(replace(prosrc, CR, '')), 2026-10-01
       'b854358086ef68cc8b11ae8f82182a9b',                -- the rewritten body (PGlite harness)
       array[
         array_to_string(array[
           $t$    where hs.score is null and hs.submitted_at is not null$t$,
           $t$      and pr.group_id in (select tp.gid from tp)$t$], E'\n') || E'\n'],
       array[
         array_to_string(array[
           $t$    -- (20261001080000) the grading queue's rule (teacher_pending_submissions, the teacher_groups badge): ungraded$t$,
           $t$    -- OR a resubmission awaiting a re-grade, so the digest, the nudge and the daily report count what the queue shows.$t$,
           $t$    where (hs.score is null or hs.score_is_stale is true) and hs.submitted_at is not null$t$,
           $t$      and pr.group_id in (select tp.gid from tp)$t$], E'\n') || E'\n']),
      ('public.teacher_engagement_xp_candidates(integer)',
       '5722017aad9d568961f055bfeea346ea',
       '369a55107669329a39cf98c6c1cc22ee',
       array[
         $t$        where g2.tid = t.tid and hs2.score is null and hs2.submitted_at is not null)$t$ || E'\n'],
       array[
         array_to_string(array[
           $t$        -- (20261001080000) nothing waiting by the grading queue's rule: ungraded OR awaiting a re-grade$t$,
           $t$        where g2.tid = t.tid and (hs2.score is null or hs2.score_is_stale is true) and hs2.submitted_at is not null)$t$],
           E'\n') || E'\n']),
      ('public.teacher_weekly_self(uuid,integer)',
       '760558b6097397e1692db23dc2947fb0',
       '716dc3f3ec1d0e1cc474ac8fcd996a1d',
       array[
         array_to_string(array[
           $t$    join my_groups mg on mg.gid = pr.group_id$t$,
           $t$    where hs.score is null and hs.submitted_at is not null$t$], E'\n') || E'\n'],
       array[
         array_to_string(array[
           $t$    join my_groups mg on mg.gid = pr.group_id$t$,
           $t$    -- (20261001080000) the grading queue's rule: ungraded OR a resubmission awaiting a re-grade$t$,
           $t$    where (hs.score is null or hs.score_is_stale is true) and hs.submitted_at is not null$t$], E'\n') || E'\n']),
      ('public.teacher_group_statistics(uuid)',
       '5dd42fce227c1070a9c4829e426b1e69',
       '17572fa7d51506a7d8047e1e2b9c8f63',
       array[
         $t$  WHERE p.group_id = p_group_id AND hs.score IS NULL;$t$ || E'\n'],
       array[
         array_to_string(array[
           $t$  -- (20261001080000) the grading queue's rule: ungraded OR a resubmission awaiting a re-grade$t$,
           $t$  WHERE p.group_id = p_group_id AND (hs.score IS NULL OR hs.score_is_stale IS TRUE);$t$], E'\n') || E'\n']),
      ('public.teacher_group_statistics(uuid,uuid)',
       '41792ee8bb9e733c7784d691d694685c',
       '22d68eea3b2b3916ea8bb4c9f889e928',
       array[
         $t$  WHERE p.group_id = p_group_id AND hs.score IS NULL;$t$ || E'\n'],
       array[
         array_to_string(array[
           $t$  -- (20261001080000) the grading queue's rule: ungraded OR a resubmission awaiting a re-grade$t$,
           $t$  WHERE p.group_id = p_group_id AND (hs.score IS NULL OR hs.score_is_stale IS TRUE);$t$], E'\n') || E'\n']),
      ('public.hw_dm_fallback_deliver()',
       '4025f0407f7bbc7d823c0f14c72ff58b',
       'da17b08ba3b5546de5658697029daf4b',
       array[
         $t$  _admin record;$t$ || E'\n',
         $t$  if _tok is null or _tok = '' then return 0; end if;$t$ || E'\n',
         array_to_string(array[
           $t$          'reply_markup', jsonb_build_object('inline_keyboard', jsonb_build_array($t$,
           $t$            case when _row.message_url like 'https://t.me/c/%'$t$,
           $t$                 then jsonb_build_array($t$,
           $t$                        jsonb_build_object('text', '📂 Postni ko''rish', 'url', _row.message_url),$t$,
           $t$                        jsonb_build_object('text', '🎯 Baholash', 'callback_data', 'gs:open:' || _row.submission_id))$t$,
           $t$                 else jsonb_build_array($t$,
           $t$                        jsonb_build_object('text', '🎯 Baholash', 'callback_data', 'gs:open:' || _row.submission_id))$t$,
           $t$            end))$t$], E'\n') || E'\n'],
       array[
         array_to_string(array[
           $t$  _admin record;$t$,
           $t$  _app_on boolean;  -- (20261001080000) platform_settings.teacher_miniapp, read once per run$t$], E'\n') || E'\n',
         array_to_string(array[
           $t$  if _tok is null or _tok = '' then return 0; end if;$t$,
           $t$$t$,
           $t$  -- (20261001080000) the drainer's 🎯 Baholash web_app row (the teacher Mini App) while$t$,
           $t$  -- platform_settings.teacher_miniapp is on: the SAME rule as _shared/teacher-miniapp.ts (no row = on).$t$,
           $t$  _app_on := public.teacher_miniapp_enabled();$t$], E'\n') || E'\n',
         array_to_string(array[
           $t$          -- (20261001080000) the keyboard is public.hw_dm_fallback_keyboard(): today's buttons, and -- with the$t$,
           $t$          -- teacher Mini App on and a private chat (teacherAppButton's rules) -- the drainer's 🎯 web_app row first.$t$,
           $t$          'reply_markup', public.hw_dm_fallback_keyboard(_row.submission_id, _row.message_url,$t$,
           $t$                                                        _app_on and _row.telegram_id > 0)$t$], E'\n') || E'\n'])
    ) v(sig, pin, new_pin, olds, news)
  loop
    _fn := to_regprocedure(r.sig);
    if _fn is null then
      raise exception 'ABORT: % not found', r.sig;
    end if;
    select prosrc, array(select x::text from unnest(proacl) x order by 1), proowner, prosecdef, proconfig, provolatile
      into _src, _acl, _owner, _secdef, _pcfg, _vol
      from pg_proc where oid = _fn;

    if position(_marker in _src) > 0 then                   -- replay
      if md5(replace(_src, E'\r', '')) <> r.new_pin then
        raise exception 'ABORT: % carries the 20261001080000 marker but not the harness-verified body (md5 %)', r.sig,
          md5(replace(_src, E'\r', ''));
      end if;
      raise notice '% already rewritten -- skipped', r.sig;
      continue;
    end if;
    if md5(replace(_src, E'\r', '')) <> r.pin then
      raise exception 'ABORT: % changed since it was verified on 2026-10-01 (md5 %); re-read the live definition and regenerate this migration',
        r.sig, md5(replace(_src, E'\r', ''));
    end if;

    _def := pg_get_functiondef(_fn);
    _new := _def;
    for i in 1 .. array_length(r.olds, 1) loop
      _n := (length(_new) - length(replace(_new, r.olds[i], ''))) / length(r.olds[i]);
      if _n <> 1 then
        raise exception 'ABORT: % edit % matched % times (want exactly 1); regenerate this migration', r.sig, i, _n;
      end if;
      _new := replace(_new, r.olds[i], r.news[i]);
    end loop;

    execute _new;

    if pg_get_functiondef(_fn) is distinct from _new then
      raise exception 'ABORT: % -- the stored definition differs from the one executed', r.sig;
    end if;
    if (select array(select x::text from unnest(proacl) x order by 1) from pg_proc where oid = _fn) is distinct from _acl
       or (select proowner from pg_proc where oid = _fn) <> _owner
       or (select prosecdef from pg_proc where oid = _fn) <> _secdef
       or (select proconfig from pg_proc where oid = _fn) is distinct from _pcfg
       or (select provolatile from pg_proc where oid = _fn) <> _vol then
      raise exception 'ABORT: % -- owner, ACL, SECURITY DEFINER, search_path or volatility changed', r.sig;
    end if;
    if (select md5(replace(prosrc, E'\r', '')) from pg_proc where oid = _fn) <> r.new_pin then
      raise exception 'ABORT: % -- the rewritten body is not the harness-verified one (md5 %)', r.sig,
        (select md5(replace(prosrc, E'\r', '')) from pg_proc where oid = _fn);
    end if;
  end loop;
end $mig$;

-- ─────────────────────────────── the watchdog's schedule ───────────────────────────────
-- Hourly at :33 — clear of the other watchdogs' minutes (:13 :17 :19 :23 :25 :37 :45 :47 :49 :52 :57).
do $$
begin
  perform cron.unschedule('teacher-button-watchdog');
exception when others then null;
end $$;

do $$
begin
  perform cron.schedule('teacher-button-watchdog', '33 * * * *',
                        $cmd$ select public.teacher_button_watchdog() $cmd$);
exception when others then
  insert into public.admin_actions (actor_user_id, action, details)
  values (null, 'cron_schedule_failed',
          jsonb_build_object('job', 'teacher-button-watchdog', 'error', sqlerrm));
end $$;

-- ─────────────────────────────── self-tests + state seed + audit ───────────────────────────────
do $mig$
declare
  _marker constant text := '(20261001080000)';
  -- keyboard-parity-cases:begin  (read by src/test/hw-dm-fallback-keyboard-parity.test.ts; "want" = TypeScript's)
  _kb_cases constant jsonb := $kb$[
    {"sub":"e41e7e3b-8b35-4d9e-8cc4-fa359d7902bb","url":"https://t.me/c/2405781239/7/1234","app":true,"want":{"inline_keyboard":[[{"text":"🎯 Baholash","web_app":{"url":"https://www.aicreator.academy/tg/teacher/grade?sub=e41e7e3b-8b35-4d9e-8cc4-fa359d7902bb&src=teacher_hw_dm&ref=e41e7e3b-8b35-4d9e-8cc4-fa359d7902bb"}}],[{"text":"📂 Postni ko'rish","url":"https://t.me/c/2405781239/7/1234"},{"text":"🎤 Chatda (ovoz bilan)","callback_data":"gs:open:e41e7e3b-8b35-4d9e-8cc4-fa359d7902bb"}]]}},
    {"sub":"e41e7e3b-8b35-4d9e-8cc4-fa359d7902bb","url":"https://t.me/c/2405781239/7/1234","app":false,"want":{"inline_keyboard":[[{"text":"📂 Postni ko'rish","url":"https://t.me/c/2405781239/7/1234"},{"text":"🎯 Baholash","callback_data":"gs:open:e41e7e3b-8b35-4d9e-8cc4-fa359d7902bb"}]]}},
    {"sub":"0b5f4a2e-77aa-4c1e-9d3b-1f2e3d4c5b6a","url":"https://t.me/aicreatorsdarsliklari_bot?start=hw_0b5f4a2e_1","app":true,"want":{"inline_keyboard":[[{"text":"🎯 Baholash","web_app":{"url":"https://www.aicreator.academy/tg/teacher/grade?sub=0b5f4a2e-77aa-4c1e-9d3b-1f2e3d4c5b6a&src=teacher_hw_dm&ref=0b5f4a2e-77aa-4c1e-9d3b-1f2e3d4c5b6a"}}],[{"text":"🎤 Chatda (ovoz bilan)","callback_data":"gs:open:0b5f4a2e-77aa-4c1e-9d3b-1f2e3d4c5b6a"}]]}},
    {"sub":"0b5f4a2e-77aa-4c1e-9d3b-1f2e3d4c5b6a","url":"https://t.me/aicreatorsdarsliklari_bot?start=hw_0b5f4a2e_1","app":false,"want":{"inline_keyboard":[[{"text":"🎯 Baholash","callback_data":"gs:open:0b5f4a2e-77aa-4c1e-9d3b-1f2e3d4c5b6a"}]]}},
    {"sub":"ffffffff-ffff-4fff-bfff-ffffffffffff","url":"https://t.me/cx/1/2","app":true,"want":{"inline_keyboard":[[{"text":"🎯 Baholash","web_app":{"url":"https://www.aicreator.academy/tg/teacher/grade?sub=ffffffff-ffff-4fff-bfff-ffffffffffff&src=teacher_hw_dm&ref=ffffffff-ffff-4fff-bfff-ffffffffffff"}}],[{"text":"🎤 Chatda (ovoz bilan)","callback_data":"gs:open:ffffffff-ffff-4fff-bfff-ffffffffffff"}]]}},
    {"sub":"00000000-0000-4000-8000-000000000000","url":"","app":true,"want":{"inline_keyboard":[[{"text":"🎯 Baholash","web_app":{"url":"https://www.aicreator.academy/tg/teacher/grade?sub=00000000-0000-4000-8000-000000000000&src=teacher_hw_dm&ref=00000000-0000-4000-8000-000000000000"}}],[{"text":"🎤 Chatda (ovoz bilan)","callback_data":"gs:open:00000000-0000-4000-8000-000000000000"}]]}},
    {"sub":"00000000-0000-4000-8000-000000000000","url":"http://t.me/c/1/2/3","app":false,"want":{"inline_keyboard":[[{"text":"🎯 Baholash","callback_data":"gs:open:00000000-0000-4000-8000-000000000000"}]]}}
  ]$kb$;
  -- keyboard-parity-cases:end
  _c jsonb;
  _got jsonb;
  _src text;
  _q text;
  _n int;
  _bad text;
  _sig text;
  _h jsonb;
  _on boolean;
  _stale int;
  _diff jsonb;
  _clear int;
begin
  -- Static: every rewrite is in place and the old rule is gone.
  for _sig in select unnest(array['public.teacher_group_signals(integer,integer)',
                                  'public.teacher_engagement_xp_candidates(integer)',
                                  'public.teacher_weekly_self(uuid,integer)',
                                  'public.teacher_group_statistics(uuid)',
                                  'public.teacher_group_statistics(uuid,uuid)',
                                  'public.hw_dm_fallback_deliver()'])
  loop
    select prosrc into _src from pg_proc where oid = to_regprocedure(_sig);
    if _src is null or position(_marker in _src) = 0 then
      raise exception 'ABORT: % does not carry the 20261001080000 marker after the rewrite', _sig;
    end if;
    if position('hs.score is null and hs.submitted_at is not null' in _src) > 0
       or position('hs2.score is null and hs2.submitted_at is not null' in _src) > 0
       or position('AND hs.score IS NULL;' in _src) > 0 then
      raise exception 'ABORT: % still counts "waiting" as score is null only', _sig;
    end if;
  end loop;

  -- W5. The badge and the queue carry the very rule the rewrites now use (catalog; their guards need a JWT).
  select prosrc into _src from pg_proc where oid = 'public.teacher_groups(uuid)'::regprocedure;
  if position('where (hs.score is null or hs.score_is_stale is true)' in _src) = 0 then
    raise exception 'ABORT: self-test W5 -- teacher_groups (the badge) no longer uses the queue''s rule';
  end if;
  select prosrc into _src from pg_proc where oid = 'public.teacher_pending_submissions(uuid,uuid)'::regprocedure;
  if position('and (hs.score is null or hs.score_is_stale is true)' in _src) = 0 then
    raise exception 'ABORT: self-test W5 -- teacher_pending_submissions (the queue) no longer uses the rule';
  end if;

  -- W1. Every (teacher, group) line: pending_homework = the queue's rule for that group.
  select string_agg(s.group_id::text || ':' || s.pending_homework || '<>' || c.n, ', ') into _bad
  from public.teacher_group_signals(8, 3) s
  cross join lateral (
    select count(*)::int as n from public.homework_submissions hs
    join public.profiles p on p.id = hs.user_id
    where p.group_id = s.group_id and (hs.score is null or hs.score_is_stale is true)
  ) c
  where s.pending_homework <> c.n;
  if _bad is not null then
    raise exception 'ABORT: self-test W1 -- teacher_group_signals disagrees with the queue''s rule: %', _bad;
  end if;

  -- W2. The daily report's backlog (the "📝 Baholash (N)" button) = the signals' sum = the teacher's queue.
  select string_agg(r.teacher_id::text, ', ') into _bad
  from public.teacher_daily_report() r
  where r.ungraded_backlog <> coalesce((select sum(s.pending_homework)::int from public.teacher_group_signals() s
                                        where s.teacher_id = r.teacher_id), 0)
     or r.ungraded_backlog <> (select count(*)::int from public.homework_submissions hs
                               join public.profiles p on p.id = hs.user_id
                               where (hs.score is null or hs.score_is_stale is true)
                                 and p.group_id in (select tp.group_id from public.teacher_group_pairs() tp
                                                    where tp.teacher_id = r.teacher_id));
  if _bad is not null then
    raise exception 'ABORT: self-test W2 -- teacher_daily_report backlog disagrees with the queue for %', _bad;
  end if;

  -- W3. The nudge's pending total = the signals' sum.
  select string_agg(n.teacher_id::text, ', ') into _bad
  from public.teacher_nudge_signals(8, 3) n
  where n.pending_homework <> coalesce((select sum(s.pending_homework)::int from public.teacher_group_signals(8, 3) s
                                        where s.teacher_id = n.teacher_id), 0);
  if _bad is not null then
    raise exception 'ABORT: self-test W3 -- teacher_nudge_signals disagrees with teacher_group_signals for %', _bad;
  end if;

  -- W4. No queue-clear candidate has anything waiting (read-only; the :07 cron does the paying).
  select count(*) into _clear from public.teacher_engagement_xp_candidates(26) c where c.reason = 'teacher_queue_clear';
  if exists (select 1 from public.teacher_engagement_xp_candidates(26) c
             where c.reason = 'teacher_queue_clear'
               and exists (select 1 from public.homework_submissions hs
                           join public.profiles p on p.id = hs.user_id
                           join public.teacher_group_pairs() tp on tp.group_id = p.group_id and tp.teacher_id = c.teacher_id
                           where (hs.score is null or hs.score_is_stale is true))) then
    raise exception 'ABORT: self-test W4 -- a queue-clear candidate still has homework waiting';
  end if;

  -- K. The fallback keyboard = TypeScript's on every parity case (a pure function: nothing is written).
  if jsonb_array_length(_kb_cases) < 7 then
    raise exception 'ABORT: self-test K -- only % keyboard parity cases', jsonb_array_length(_kb_cases);
  end if;
  for _c in select value from jsonb_array_elements(_kb_cases) loop
    _got := public.hw_dm_fallback_keyboard((_c->>'sub')::uuid, _c->>'url', (_c->>'app')::boolean);
    if _got is distinct from _c->'want' then
      raise exception 'ABORT: self-test K -- hw_dm_fallback_keyboard(%) = %, TypeScript says %', _c - 'want', _got, _c->'want';
    end if;
  end loop;

  -- F. hw_dm_fallback_deliver: NOT called (it sends). The stored body uses the helpers, and its candidate SELECT —
  --    cut from the stored body — still runs (read-only).
  select prosrc into _src from pg_proc where oid = 'public.hw_dm_fallback_deliver()'::regprocedure;
  if position('_app_on := public.teacher_miniapp_enabled();' in _src) = 0
     or position('public.hw_dm_fallback_keyboard(_row.submission_id, _row.message_url,' in _src) = 0
     or position('_app_on and _row.telegram_id > 0)' in _src) = 0
     or position($t$'callback_data', 'gs:open:' || _row.submission_id$t$ in _src) > 0 then
    raise exception 'ABORT: self-test F -- hw_dm_fallback_deliver does not build its keyboard with the helper';
  end if;
  _n := (length(_src) - length(replace(_src, E'  for _row in\n', ''))) / length(E'  for _row in\n');
  if _n <> 1 then
    raise exception 'ABORT: self-test F -- "for _row in" matched % times in hw_dm_fallback_deliver (want 1)', _n;
  end if;
  _q := split_part(split_part(_src, E'  for _row in\n', 2), E'\n  loop\n', 1);
  if _q not like '%from homework_teacher_dm_queue q%' or position(';' in _q) > 0 then
    raise exception 'ABORT: self-test F -- could not cut the candidate query out of hw_dm_fallback_deliver';
  end if;
  execute format('select count(*) from (select telegram_id, submission_id, message_url from (%s) z) y', _q) into _n;

  -- H. The detector returns a verdict (its SHAPE: a real fault at deploy time must not fail the migration).
  _on := public.teacher_miniapp_enabled();
  if _on is null then
    raise exception 'ABORT: self-test H -- teacher_miniapp_enabled() returned NULL';
  end if;
  _h := public.teacher_button_health();
  if _h is null or jsonb_typeof(_h->'alarm') <> 'boolean' or jsonb_typeof(_h->'button_fault') <> 'boolean'
     or jsonb_typeof(_h->'opens_missing') <> 'boolean' or jsonb_typeof(_h->'tally_missing') <> 'boolean'
     or jsonb_typeof(_h->'buttons') <> 'object' then
    raise exception 'ABORT: self-test H -- teacher_button_health() returned no verdict: %', coalesce(_h::text, 'NULL');
  end if;

  -- Grants: the four new functions are service_role only.
  select string_agg(p, ', ') into _bad
  from unnest(array['public.teacher_miniapp_enabled()', 'public.hw_dm_fallback_keyboard(uuid,text,boolean)',
                    'public.teacher_button_health()', 'public.teacher_button_watchdog()']) p
  where has_function_privilege('anon', p::regprocedure, 'EXECUTE')
     or has_function_privilege('authenticated', p::regprocedure, 'EXECUTE')
     or not has_function_privilege('service_role', p::regprocedure, 'EXECUTE');
  if _bad is not null then
    raise exception 'ABORT: grants -- not service_role-only: %', _bad;
  end if;

  -- The detector's state (its liveness row) — seeded once; the watchdog owns it from the first run.
  insert into public.app_settings (key, value)
  values ('teacher_button_watchdog_state', jsonb_build_object(
    'alerting', false,
    'last_alert_ms', 0,
    'first_checked_at', now(),
    'flag_on_since', case when _on then to_jsonb(now()) else 'null'::jsonb end,
    'seeded_by', '20261001080000',
    'last_report', _h,
    'checked_at', now()))
  on conflict (key) do nothing;

  -- The audit: what changed, today's numbers.
  select count(*) into _stale from public.homework_submissions hs where hs.score_is_stale is true and hs.score is not null;
  select coalesce(jsonb_object_agg(g.name, jsonb_build_object('score_is_null', d.old_n, 'queue_rule', d.new_n)), '{}'::jsonb)
    into _diff
  from (
    select p.group_id, count(*) filter (where hs.score is null)::int as old_n,
           count(*) filter (where hs.score is null or hs.score_is_stale is true)::int as new_n
    from public.homework_submissions hs join public.profiles p on p.id = hs.user_id
    where p.group_id in (select tp.group_id from public.teacher_group_pairs() tp)
    group by p.group_id
  ) d join public.groups g on g.id = d.group_id
  where d.old_n <> d.new_n;

  insert into public.admin_actions (actor_user_id, action, details)
  select null, 'teacher_waiting_rule_applied',
         jsonb_build_object('migration', '20261001080000',
                            'rewritten', jsonb_build_array('teacher_group_signals(integer,integer)',
                                                           'teacher_engagement_xp_candidates(integer)',
                                                           'teacher_weekly_self(uuid,integer)',
                                                           'teacher_group_statistics(uuid)',
                                                           'teacher_group_statistics(uuid,uuid)',
                                                           'hw_dm_fallback_deliver()'),
                            'new', jsonb_build_array('teacher_miniapp_enabled()',
                                                     'hw_dm_fallback_keyboard(uuid,text,boolean)',
                                                     'teacher_button_health()', 'teacher_button_watchdog()'),
                            'stale_regrades_waiting_now', _stale,
                            'groups_whose_count_changes', _diff,
                            'queue_clear_candidates_now', _clear,
                            'fallback_candidates_now', _n,
                            'teacher_miniapp_on', _on,
                            'keyboard_parity_cases', jsonb_array_length(_kb_cases),
                            'at', now())
  where not exists (select 1 from public.admin_actions where action = 'teacher_waiting_rule_applied');
end $mig$;
