-- DETECTORS for the Mini App watch buttons + daily-reminder COVERAGE (prevention hierarchy layer 5).
--
-- ═══ WHY ═══
-- Owner, 2026-09-30: "every day students get a notification to watch videos; when they click the button it
-- should open in the Mini App, not Telegram's built-in browser". The same branch moves every student watch
-- button (cron-engagement daily / streak / drip, detect-and-nudge, the bot's 📚 Davom etish / /dars /
-- welcome, teacher-nudge-student, re-engagement, broadcasts) from a magic-link url button to a Mini App
-- web_app button, built by ONE helper (_shared/miniapp-button.ts) behind platform_settings.student_miniapp.
-- Three new ways that can quietly fail, each invisible without a detector:
--   1. The helper FALLS BACK to the magic link for a reason that is a fault (MINIAPP_BASE malformed, the
--      magic-link fallback itself failing, Telegram rejecting the web_app button) — students still get a
--      button, so nobody complains, but it is the old browser path again.
--   2. The buttons go out but the Mini App never reports an OPEN (admin_actions 'miniapp_open', written by
--      tg-miniapp-auth for every tap that carries ?src=) — the gate, the /continue route or the deploy
--      order (the frontend must be live first) is broken, and every tap lands somewhere wrong.
--   3. A group of an active course gets NO daily reminders at all (read-only audit 2026-09-30: 5.0 — 157 of
--      157 eligible students reminded or active in 48 h, 6 unreachable, 7 with no telegram_id; Challenge 6.0
--      — published, 6 groups, 0 linked students). Nothing counted reminders per course before this.
--
-- ═══ WHAT ═══
-- public.watch_button_health()   STABLE, read-only. One jsonb verdict:
--   buttons_24h        cron-engagement's per-run tally (engagement_run_done.details.buttons, written by the
--                      new cron-engagement): web_app / magic_link / none / rejected, and `unexpected` = the
--                      fallbacks whose reason is NOT flag_off / watch_off (those two are the kill-switch
--                      working as intended).
--   fault_rows_24h     admin_actions 'miniapp_button_fallback' + 'miniapp_button_rejected' (any sender).
--   opens_48h          admin_actions 'miniapp_open', total and by src.
--   coverage           per published course with groups: students, no_telegram, notifications_off, eligible,
--                      reminded_48h, active_48h, reminded_or_active_48h, unreachable_7d (a reminder /
--                      streak / drip to them failed with a RECIPIENT error: blocked, deleted, never started).
--   silent_groups      active-course groups with eligible students (accounts older than 48 h), at least one
--                      of them inactive for 48 h, and ZERO reminders to any of them in 48 h.
--   digest_line        the two lines ops_daily_digest prints (see below).
--   alarm = fallback_fault (unexpected > 0 or any fault row)
--        or opens_missing  (>= 100 web_app buttons in 48 h and 0 miniapp_open rows)
--        or tally_missing  (cron-engagement ran in the last 2 h — and after this watchdog was seeded — but no
--                           run carried a buttons tally: the new version is not deployed, the "metric nothing
--                           writes" guard. Runs from before the seed are ignored, so the old version's runs
--                           still inside the window cannot alarm on the first check after a deploy.)
--        or coverage_gap   (silent_groups not empty)
-- public.watch_button_watchdog()  SECURITY DEFINER, hourly at :25 (cron 'watch-button-watchdog'). DMs up to 3
--   admins through public.ops_net_post (Content-Type passed), re-alerts every 6 h while it persists, one
--   "recovered" message when it clears, and writes watch_button_watchdog_ALARM / _recovered rows. State row
--   'watch_button_watchdog_state' — its *_watchdog_state name puts it under hw_dm_health_stats()'s liveness
--   scan (and through it the out-of-band GitHub verifier), which flags it if it stops for 25 h.
-- ops_daily_digest(): the "📨 Yetkazildi" block gains the coverage + Mini App lines, e.g.
--      Kunlik dars eslatmasi (48 soat · eslatildi yoki darsda / Telegram bilan): 5.0 157/157 · 6 ta yetib bormaydi · 7 ta Telegramsiz; CH6 0/0
--      Mini App dars tugmalari (24 soat): 131 · ochildi (48 soat): 58
--   Informational: the watchdog above is what alarms, so the "Umumiy" verdict is unchanged.
--
-- ═══ WHY A NEW WATCHDOG, NOT AN EDIT OF engagement_run_watchdog() ═══
-- engagement_run_watchdog() answers "did cron-engagement run to completion"; these are different failure
-- classes (a Mini App route, a Telegram rejection, a course nobody reminds) with their own cooldown and
-- recovery. Keeping them apart also means no live-text rewrite of that function: it is untouched.
--
-- ═══ DESIGNED-OUT (this project's own past watchdog failures) ═══
--   * The metric nothing writes: tally_missing alarms if the tally stops appearing while runs continue.
--   * NULL-as-verdict: counts are count(*) or coalesced sums; jsonb text is regex-guarded before a cast;
--     the watchdog treats an unreadable verdict AS an alarm.
--   * Member noise: coverage counts only reminders and lesson / homework / topic activity — nothing a member
--     posts in their own group's general chat can raise or clear it.
--   * A brand-new group: only accounts older than 48 h count toward silent_groups.
--   * A future last_alert_ms (clock skew, hand edit) would suppress every re-alert: clamped to now.
--   * Telegram's 4096-char limit: the DM is truncated to 3900.
--   * No raw net.http_post (E8): ops_net_post records the URL with the token scrubbed.
--
-- ═══ ops_daily_digest: the pinned-rewrite pattern (as 20260930081000) ═══
-- Edited FROM ITS LIVE pg_get_functiondef, only if its live prosrc (CRs stripped) has the md5 read
-- read-only on 2026-09-30 (b4ee37f3eac4e1a794bbb5cbbc4ac793 — the text 20260930081000 installed; its
-- pg_get_functiondef md5 is 206a45ccf703cc890d782a2ee60e4abc). Anything else aborts with "regenerate".
-- Three edits, each must match exactly once (verified read-only: 1 / 1 / 1). After CREATE OR REPLACE (body
-- validation on) the stored definition must equal the executed text; owner, ACL and SECURITY DEFINER must be
-- unchanged, and anon / authenticated still unable to execute it. The new call is wrapped so a failure in
-- watch_button_health() prints a warning line instead of costing the whole digest.
-- SELF-TEST WITHOUT SENDING: the stored body is cut just before it reads the bot token (asserted: the cut
-- copy has no ops_net_post, no bot_token, no advisory lock), ends by raising the message it built, and runs
-- in a sub-block whose savepoint rolls back anything it did. The rendered digest must carry the coverage
-- line directly under "Baholash eslatmalari", the Mini App line under it, and the blank line before "🆕"
-- (a regex on the shape — admin_actions grows between two statements, so exact numbers could race).
-- REPLAY-SAFE: the marker "(20260930160000)" in the digest body means the rewrite is in place and is
-- skipped; the static checks and the self-test run either way.
-- DRY-RUN, read-only against production on 2026-09-30: the pin matched, all 3 edits matched exactly once,
-- the cut copy had no send, and the self-test rendered the 29.09 digest with
--      Baholash eslatmalari: 5
--      Kunlik dars eslatmasi (48 soat · eslatildi yoki darsda / Telegram bilan): 5.0 157/157 · 6 ta yetib bormaydi · 7 ta Telegramsiz; CH6 0/0
--      Mini App dars tugmalari (24 soat): 0 · ochildi (48 soat): 0
--      (blank line) 🆕 Yangi talabalar …
-- (health RPCs stubbed: the read-only role cannot execute them; this migration runs them for real). The
-- edited definition has md5 d8631faf2a90881996ebc0fd022b472b. watch_button_health()'s body was run as a DO
-- block against production the same day: coverage as above, silent_groups [], tally_missing true (the new
-- cron-engagement is not deployed yet — and runs before this watchdog's seed are ignored, see above).
--
-- ═══ DEPLOY SELF-TEST (watchdog) ═══
-- Calls ONLY watch_button_health(): STABLE, SELECTs only, no DML, no DM, no advisory lock, no auth.uid().
-- It cannot mutate what it checks, and it never calls the watchdog (which sends). It asserts the verdict is
-- non-NULL, not that it is "false" — a real gap at deploy time must not fail the migration.
--
-- KILL-SWITCH: select cron.unschedule('watch-button-watchdog');   (the digest line stays; it only reads)
-- Buttons themselves: platform_settings.student_miniapp.watch_buttons = false (notification buttons back to
-- magic links) or .enabled = false (the whole student Mini App entry), both within 60 s.

create or replace function public.watch_button_health()
returns jsonb
language plpgsql
stable
set search_path to 'public'
as $function$
declare
  _flag jsonb;
  _on boolean;
  _watch boolean;
  _runs_24h int;
  _tally_runs_24h int;
  _web_app_24h bigint;
  _magic_24h bigint;
  _none_24h bigint;
  _rejected_24h bigint;
  _unexpected_24h bigint;
  _unexpected_reasons jsonb;
  _fault_rows jsonb;
  _fault_rows_n bigint;
  _runs_2h int;
  _tally_runs_2h int;
  _web_app_48h bigint;
  _opens_48h bigint;
  _opens_by_src jsonb;
  _coverage jsonb;
  _silent_groups jsonb;
  _cov_line text;
  _btn_line text;
  _fallback_fault boolean;
  _opens_missing boolean;
  _tally_missing boolean;
  _coverage_gap boolean;
  _since timestamptz;
begin
  -- tally_missing only looks at runs AFTER this watchdog was seeded: runs of the previous cron-engagement
  -- version (no tally) inside the 2-hour window must not alarm on the first check after a deploy.
  begin
    select (value->>'first_checked_at')::timestamptz into _since
    from public.app_settings where key = 'watch_button_watchdog_state';
  exception when others then
    _since := null;
  end;
  _since := greatest(now() - interval '2 hours', coalesce(_since, now()));

  select value into _flag from public.platform_settings where key = 'student_miniapp';
  -- The same fail-closed rule as the edge reader: only a JSON boolean true enables.
  _on := coalesce(_flag->'enabled' = 'true'::jsonb, false);
  _watch := _on and coalesce(_flag->'watch_buttons', 'null'::jsonb) <> 'false'::jsonb;

  -- cron-engagement's per-run button tally.
  select count(*),
         count(*) filter (where jsonb_typeof(d.details->'buttons') = 'object'),
         coalesce(sum(case when coalesce(d.details->'buttons'->>'web_app', '') ~ '^[0-9]{1,9}$'
                           then (d.details->'buttons'->>'web_app')::bigint else 0 end), 0),
         coalesce(sum(case when coalesce(d.details->'buttons'->>'magic_link', '') ~ '^[0-9]{1,9}$'
                           then (d.details->'buttons'->>'magic_link')::bigint else 0 end), 0),
         coalesce(sum(case when coalesce(d.details->'buttons'->>'none', '') ~ '^[0-9]{1,9}$'
                           then (d.details->'buttons'->>'none')::bigint else 0 end), 0),
         coalesce(sum(case when coalesce(d.details->'buttons'->>'rejected', '') ~ '^[0-9]{1,9}$'
                           then (d.details->'buttons'->>'rejected')::bigint else 0 end), 0)
    into _runs_24h, _tally_runs_24h, _web_app_24h, _magic_24h, _none_24h, _rejected_24h
  from public.admin_actions d
  where d.action = 'engagement_run_done' and d.created_at > now() - interval '24 hours';

  -- Fallback reasons that are NOT the kill-switch (flag_off / watch_off are the switch working).
  select coalesce(sum(n), 0), coalesce(jsonb_object_agg(k, n), '{}'::jsonb)
    into _unexpected_24h, _unexpected_reasons
  from (
    select r.key as k, sum(case when r.value ~ '^[0-9]{1,9}$' then r.value::bigint else 0 end) as n
    from public.admin_actions d
    cross join lateral jsonb_each_text(
      case when jsonb_typeof(d.details->'buttons'->'reasons') = 'object' then d.details->'buttons'->'reasons'
           else '{}'::jsonb end) r
    where d.action = 'engagement_run_done' and d.created_at > now() - interval '24 hours'
      and r.key not in ('flag_off', 'watch_off', 'ok')
    group by r.key
  ) x
  where n > 0;

  -- Fault rows any sender writes (bad MINIAPP_BASE / direct link, a Telegram rejection of a web_app button).
  select coalesce(sum(n), 0), coalesce(jsonb_object_agg(action, n), '{}'::jsonb)
    into _fault_rows_n, _fault_rows
  from (
    select a.action, count(*) as n from public.admin_actions a
    where a.action in ('miniapp_button_fallback', 'miniapp_button_rejected')
      and a.created_at > now() - interval '24 hours'
    group by a.action
  ) f;

  select count(*), count(*) filter (where jsonb_typeof(d.details->'buttons') = 'object')
    into _runs_2h, _tally_runs_2h
  from public.admin_actions d
  where d.action = 'engagement_run_done' and d.created_at > _since;

  select coalesce(sum(case when coalesce(d.details->'buttons'->>'web_app', '') ~ '^[0-9]{1,9}$'
                           then (d.details->'buttons'->>'web_app')::bigint else 0 end), 0)
    into _web_app_48h
  from public.admin_actions d
  where d.action = 'engagement_run_done' and d.created_at > now() - interval '48 hours';

  select coalesce(sum(n), 0), coalesce(jsonb_object_agg(src, n), '{}'::jsonb)
    into _opens_48h, _opens_by_src
  from (
    select coalesce(a.details->>'src', '?') as src, count(*) as n from public.admin_actions a
    where a.action = 'miniapp_open' and a.created_at > now() - interval '48 hours'
    group by 1
  ) o;

  -- Daily-reminder coverage per active (published, with groups) course.
  with courses_active as (
    select c.id as course_id, c.title from public.courses c
    where c.published and exists (select 1 from public.groups g where g.course_id = c.id)
  ),
  st as (
    select p.id, p.telegram_id, coalesce(p.notifications_enabled, false) as notif, p.created_at,
           g.id as group_id, g.name as group_name, g.course_id
    from public.profiles p
    join public.groups g on g.id = p.group_id
    join courses_active ca on ca.course_id = g.course_id
    where p.status = 'active'
      and not exists (select 1 from public.user_roles r
                      where r.user_id = p.id and r.role in ('teacher', 'admin', 'superadmin'))
  ),
  reminded as (
    select distinct n.user_id from public.notifications_log n
    where n.sent_at > now() - interval '48 hours'
      and n.notification_type in ('daily_reminder', 'streak_warning', 'inactive_3', 'inactive_7', 'inactive_14', 'inactive_30')
  ),
  active as (
    select lp.user_id from public.lesson_progress lp where lp.updated_at > now() - interval '48 hours'
    union select h.user_id from public.homework_submissions h where h.submitted_at > now() - interval '48 hours'
    union select e.profile_id from public.group_message_events e
          where e.sent_at > now() - interval '48 hours' and e.telegram_thread_id is not null
  ),
  unreachable as (
    select distinct a.details->>'recipient' as tg from public.admin_actions a
    where a.action = 'telegram_send_failed' and a.created_at > now() - interval '7 days'
      and a.details->>'recipient_error' = 'true'
      and a.details->>'purpose' in ('daily_reminder', 'streak_warning', 'reengagement_drip')
  ),
  per as (
    select st.*,
           (st.telegram_id is not null and st.notif) as eligible,
           exists (select 1 from reminded r where r.user_id = st.id) as was_reminded,
           exists (select 1 from active a where a.user_id = st.id) as was_active,
           (st.telegram_id is not null and exists (select 1 from unreachable u where u.tg = st.telegram_id::text)) as is_unreachable
    from st
  ),
  cov as (
    select jsonb_build_object(
             'course_id', ca.course_id,
             'course', ca.title,
             'short', case when ca.title ~* 'challenge'
                           then 'CH' || regexp_replace(coalesce(substring(ca.title from '([0-9]+(?:[.,][0-9]+)?)[^0-9]*$'), ''), '[.,]0+$', '')
                           else coalesce(substring(ca.title from '([0-9]+(?:[.,][0-9]+)?)[^0-9]*$'), left(ca.title, 14)) end,
             'students', count(per.id),
             'no_telegram', count(per.id) filter (where per.telegram_id is null),
             'notifications_off', count(per.id) filter (where per.telegram_id is not null and not per.notif),
             'eligible', count(per.id) filter (where per.eligible),
             'reminded_48h', count(per.id) filter (where per.eligible and per.was_reminded),
             'active_48h', count(per.id) filter (where per.eligible and per.was_active),
             'reminded_or_active_48h', count(per.id) filter (where per.eligible and (per.was_reminded or per.was_active)),
             'unreachable_7d', count(per.id) filter (where per.eligible and per.is_unreachable)) as x
    from courses_active ca left join per on per.course_id = ca.course_id
    group by ca.course_id, ca.title
  ),
  grp as (
    select per.group_name, per.course_id,
           count(*) filter (where per.eligible and per.created_at < now() - interval '48 hours') as e,
           count(*) filter (where per.eligible and per.created_at < now() - interval '48 hours' and not per.was_active) as i,
           count(*) filter (where per.eligible and per.was_reminded) as r
    from per group by per.group_id, per.group_name, per.course_id
  )
  select (select coalesce(jsonb_agg(x order by x->>'course'), '[]'::jsonb) from cov),
         (select coalesce(jsonb_agg(jsonb_build_object('group', group_name, 'eligible', e, 'inactive', i)
                                    order by group_name), '[]'::jsonb)
            from grp where e > 0 and i > 0 and r = 0)
    into _coverage, _silent_groups;

  _fallback_fault := coalesce(_unexpected_24h, 0) > 0 or coalesce(_fault_rows_n, 0) > 0;
  _opens_missing := coalesce(_web_app_48h, 0) >= 100 and coalesce(_opens_48h, 0) = 0;
  _tally_missing := coalesce(_runs_2h, 0) > 0 and coalesce(_tally_runs_2h, 0) = 0;
  _coverage_gap := jsonb_array_length(coalesce(_silent_groups, '[]'::jsonb)) > 0;

  select '   Kunlik dars eslatmasi (48 soat · eslatildi yoki darsda / Telegram bilan): '
         || coalesce(string_agg(
              (c->>'short') || ' ' || (c->>'reminded_or_active_48h') || '/' || (c->>'eligible')
              || case when (c->>'unreachable_7d')::int > 0 then ' · ' || (c->>'unreachable_7d') || ' ta yetib bormaydi' else '' end
              || case when (c->>'no_telegram')::int > 0 then ' · ' || (c->>'no_telegram') || ' ta Telegramsiz' else '' end,
              '; ' order by c->>'course'), '—')
         || case when _coverage_gap then ' · ⚠️ ' || jsonb_array_length(_silent_groups) || ' ta guruhga eslatma ketmadi' else '' end
         || E'\n'
    into _cov_line
  from jsonb_array_elements(coalesce(_coverage, '[]'::jsonb)) c;

  _btn_line := '   Mini App dars tugmalari (24 soat): ' || coalesce(_web_app_24h, 0)
            || ' · ochildi (48 soat): ' || coalesce(_opens_48h, 0)
            || case when not _on then ' · Mini App oʻchirilgan'
                    when not _watch then ' · tugmalar oʻchirilgan (watch_buttons)' else '' end
            || case when _fallback_fault then ' · ⚠️ ' || (coalesce(_unexpected_24h, 0) + coalesce(_fault_rows_n, 0)) || ' ta nosozlik' else '' end
            || E'\n';

  return jsonb_build_object(
    'alarm', _fallback_fault or _opens_missing or _tally_missing or _coverage_gap,
    'fallback_fault', _fallback_fault,
    'opens_missing', _opens_missing,
    'tally_missing', _tally_missing,
    'coverage_gap', _coverage_gap,
    'flag_on', _on,
    'watch_on', _watch,
    'buttons_24h', jsonb_build_object(
      'runs', coalesce(_runs_24h, 0), 'runs_with_tally', coalesce(_tally_runs_24h, 0),
      'web_app', coalesce(_web_app_24h, 0), 'magic_link', coalesce(_magic_24h, 0),
      'none', coalesce(_none_24h, 0), 'rejected', coalesce(_rejected_24h, 0),
      'unexpected', coalesce(_unexpected_24h, 0), 'unexpected_reasons', coalesce(_unexpected_reasons, '{}'::jsonb)),
    'fault_rows_24h', coalesce(_fault_rows, '{}'::jsonb),
    'runs_2h', coalesce(_runs_2h, 0),
    'runs_with_tally_2h', coalesce(_tally_runs_2h, 0),
    'web_app_48h', coalesce(_web_app_48h, 0),
    'opens_48h', coalesce(_opens_48h, 0),
    'opens_by_src_48h', coalesce(_opens_by_src, '{}'::jsonb),
    'coverage', coalesce(_coverage, '[]'::jsonb),
    'silent_groups', coalesce(_silent_groups, '[]'::jsonb),
    'digest_line', coalesce(_cov_line, '') || coalesce(_btn_line, ''),
    'checked_at', now());
end;
$function$;

create or replace function public.watch_button_watchdog()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
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
  _groups text;
begin
  select value into _state from public.app_settings where key = 'watch_button_watchdog_state';
  begin
    _r := public.watch_button_health();
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
          _msg := _msg || '🚨 Mini App dars tugmalari: 48 soatda ' || (_r->>'web_app_48h')
               || ' ta tugma yuborildi, lekin birortasi ham ochilmadi (miniapp_open = 0). Mini App kirishi yoki '
               || '/continue sahifasi buzilgan boʻlishi mumkin — telefonda botdagi «Davom etish»ni bosib tekshiring. '
               || 'Tezkor qaytarish: platform_settings.student_miniapp.watch_buttons = false.' || E'\n';
        end if;
        if coalesce(_r->>'fallback_fault', '') = 'true' then
          _msg := _msg || '⚠️ Mini App dars tugmalari: soʻnggi 24 soatda tugmalar Mini App oʻrniga eski havola bilan ketdi '
               || 'yoki Telegram rad etdi — sabablar: ' || coalesce(_r->'buttons_24h'->>'unexpected_reasons', '{}')
               || ', ' || coalesce(_r->>'fault_rows_24h', '{}')
               || '. admin_actions: miniapp_button_fallback / miniapp_button_rejected.' || E'\n';
        end if;
        if coalesce(_r->>'tally_missing', '') = 'true' then
          _msg := _msg || '⚠️ cron-engagement 2 soatda ' || (_r->>'runs_2h')
               || ' marta ishladi, lekin tugmalar hisobini (buttons) yozmadi — yangi versiya deploy boʻlmagan.' || E'\n';
        end if;
        if coalesce(_r->>'coverage_gap', '') = 'true' then
          select string_agg(g->>'group', ', ') into _groups
          from jsonb_array_elements(coalesce(_r->'silent_groups', '[]'::jsonb)) g;
          _msg := _msg || '🚨 Kunlik dars eslatmasi: ' || jsonb_array_length(_r->'silent_groups')
               || ' ta guruhda talabalar bor, lekin 48 soatda ularning birortasiga ham eslatma ketmadi: '
               || coalesce(_groups, '?') || '.' || E'\n';
        end if;
        if _r ? 'health_error' then
          _msg := _msg || '⚠️ watch_button_health() ishlamadi: ' || (_r->>'health_error') || E'\n';
        end if;
        if _msg = '' then
          _msg := '⚠️ Mini App tugmalari watchdog holatni oʻqiy olmadi: ' || coalesce(_r::text, 'NULL') || E'\n';
        end if;
      else
        _msg := '✅ Mini App dars tugmalari va kunlik eslatmalar normallashdi.';
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
            p_purpose    := 'watch_button_watchdog',
            p_timeout_ms := 5000);
          _dm := _dm + 1;
        exception when others then null; end;
      end loop;
    end if;

    begin
      insert into public.admin_actions (actor_user_id, action, details)
      values (null,
              case when _should_alert then 'watch_button_watchdog_ALARM' else 'watch_button_watchdog_recovered' end,
              (_r - 'digest_line' - 'coverage') || jsonb_build_object('dm_attempted', _dm));
    exception when others then null; end;
  end if;

  insert into public.app_settings (key, value)
  values ('watch_button_watchdog_state', jsonb_build_object(
    'alerting', _alarm,
    -- Only a send that was actually attempted starts the 6 h cooldown; otherwise the next run retries.
    'last_alert_ms', case when _should_alert and _dm > 0 then _now_ms else _last_ms end,
    'first_checked_at', coalesce(_state->'first_checked_at', to_jsonb(now())),
    'dm_attempted_last_run', _dm,
    'last_report', _r - 'digest_line',
    'checked_at', now()))
  on conflict (key) do update set value = excluded.value;

  return _r;
end;
$function$;

-- House pattern: PUBLIC first, then the roles; only service_role (and the owner) may run them.
revoke execute on function public.watch_button_health() from public, anon, authenticated;
grant  execute on function public.watch_button_health() to service_role;
revoke execute on function public.watch_button_watchdog() from public, anon, authenticated;
grant  execute on function public.watch_button_watchdog() to service_role;

-- Hourly at :25 — off cron-engagement's :00/:30 ticks and the engagement watchdog's :10/:40.
do $$
begin
  perform cron.unschedule('watch-button-watchdog');
exception when others then null;
end $$;

do $$
begin
  perform cron.schedule('watch-button-watchdog', '25 * * * *',
                        $cmd$ select public.watch_button_watchdog() $cmd$);
exception when others then
  insert into public.admin_actions (actor_user_id, action, details)
  values (null, 'cron_schedule_failed',
          jsonb_build_object('job', 'watch-button-watchdog', 'error', sqlerrm));
end $$;

-- Deploy self-test (read-only: watch_button_health() only, never the watchdog) + state seed. See the header.
do $$
declare
  _r jsonb;
begin
  _r := public.watch_button_health();
  if _r is null or (_r->>'alarm') is null or coalesce(_r->>'digest_line', '') = '' then
    raise exception 'watch_button_health() returned no verdict: %', coalesce(_r::text, 'NULL');
  end if;
  insert into public.app_settings (key, value)
  values ('watch_button_watchdog_state', jsonb_build_object(
    'alerting', false,
    'last_alert_ms', 0,
    'first_checked_at', now(),
    'seeded_by', '20260930160000',
    'last_report', _r - 'digest_line',
    'checked_at', now()))
  on conflict (key) do nothing;
exception when others then
  begin
    insert into public.admin_actions (actor_user_id, action, details)
    values (null, 'watch_button_watchdog_selftest_failed', jsonb_build_object('error', sqlerrm));
  exception when others then null; end;
  begin
    insert into public.app_settings (key, value)
    values ('watch_button_watchdog_state', jsonb_build_object(
      'alerting', true,
      'selftest_failed', sqlerrm,
      'last_alert_ms', 0,
      'checked_at', 'epoch'::timestamptz))
    on conflict (key) do update set value = excluded.value;
  exception when others then null; end;
end $$;

-- ops_daily_digest: the coverage + Mini App lines (pinned rewrite, see the header).
do $mig$
declare
  _pin    constant text := 'b4ee37f3eac4e1a794bbb5cbbc4ac793';  -- md5(replace(prosrc, CR, '')), live, 2026-09-30
  _marker constant text := '(20260930160000)';

  _old1 constant text := E'  _ml_refused int; _ml_expired int; _ml_unknown int; _ml_stamp int; _ml_line text;\n';
  _new1 constant text := E'  _ml_refused int; _ml_expired int; _ml_unknown int; _ml_stamp int; _ml_line text;\n'
                      || E'  _wb jsonb; _wb_line text;\n';

  _old2 constant text := E'  _msg :=\n';
  _new2 constant text :=
       E'  -- Daily-reminder coverage + Mini App watch buttons (20260930160000): informational lines from\n'
    || E'  -- watch_button_health(); watch_button_watchdog() is what alarms. A failure here never costs the digest.\n'
    || E'  begin\n'
    || E'    _wb := public.watch_button_health();\n'
    || E'  exception when others then\n'
    || E'    _wb := null;\n'
    || E'  end;\n'
    || E'  _wb_line := coalesce(nullif(_wb->>''digest_line'', ''''), ''   Kunlik dars eslatmasi: ⚠️ watch_button_health() oʻqilmadi'' || E''\\n'');\n'
    || E'\n'
    || E'  _msg :=\n';

  _old3 constant text := E'    ''   Baholash eslatmalari: '' || _reminders || E''\\n\\n'' ||\n';
  _new3 constant text := E'    ''   Baholash eslatmalari: '' || _reminders || E''\\n'' ||\n'
                      || E'    _wb_line || E''\\n'' ||\n';

  -- The self-test cuts the body here: everything from this line on is the send.
  _tokline constant text := E'  select value->>''bot_token'' into _tok from platform_settings where key=''telegram'';\n';

  _olds text[];
  _news text[];
  _fn regprocedure;
  _src text; _def text; _new text;
  _acl text; _owner oid; _secdef boolean;
  _n int;
  _body text; _do text; _err text;
  _exp_line text;
begin
  -- The CREATE OR REPLACE below must validate the edited body, whatever the session default is.
  perform set_config('check_function_bodies', 'on', true);

  _fn := to_regprocedure('public.ops_daily_digest()');
  if _fn is null then
    raise exception 'ABORT: public.ops_daily_digest() does not exist';
  end if;
  select prosrc, coalesce(array_to_string(proacl, ','), ''), proowner, prosecdef
    into _src, _acl, _owner, _secdef
    from pg_proc where oid = _fn;

  if position(_marker in _src) > 0 then
    raise notice 'ops_daily_digest already prints the watch-button coverage lines -- rewrite skipped';
  else
    if md5(replace(_src, E'\r', '')) <> _pin then
      raise exception 'ABORT: ops_daily_digest changed since it was verified on 2026-09-30 (md5 %); re-read the live definition and regenerate this migration',
        md5(replace(_src, E'\r', ''));
    end if;

    _olds := array[_old1, _old2, _old3];
    _news := array[_new1, _new2, _new3];
    _def := pg_get_functiondef(_fn);
    _new := _def;
    for i in 1 .. array_length(_olds, 1) loop
      _n := (length(_new) - length(replace(_new, _olds[i], ''))) / length(_olds[i]);
      if _n <> 1 then
        raise exception 'ABORT: ops_daily_digest edit % matched % times (want exactly 1); regenerate this migration', i, _n;
      end if;
      _new := replace(_new, _olds[i], _news[i]);
    end loop;

    execute _new;

    -- Post-conditions, from the catalog only.
    if pg_get_functiondef(_fn) is distinct from _new then
      raise exception 'ABORT: ops_daily_digest -- the stored definition differs from the one executed';
    end if;
    if (select coalesce(array_to_string(proacl, ','), '') from pg_proc where oid = _fn) <> _acl
       or (select proowner from pg_proc where oid = _fn) <> _owner
       or (select prosecdef from pg_proc where oid = _fn) <> _secdef then
      raise exception 'ABORT: ops_daily_digest -- owner, ACL or SECURITY DEFINER changed';
    end if;
    if has_function_privilege('anon', _fn, 'EXECUTE') or has_function_privilege('authenticated', _fn, 'EXECUTE') then
      raise exception 'ABORT: ops_daily_digest became executable by anon or authenticated';
    end if;
  end if;

  -- Static checks of what now runs.
  select prosrc into _src from pg_proc where oid = _fn;
  if position('_wb := public.watch_button_health();' in _src) = 0
     or position(E'    _wb_line || E''\\n'' ||\n' in _src) = 0
     or position(_marker in _src) = 0 then
    raise exception 'ABORT: ops_daily_digest -- the watch-button coverage lines are not in the stored body';
  end if;

  -- Self-test: render the digest from the STORED body, cut before the send (see the header).
  _body := split_part(pg_get_functiondef(_fn), E'AS $function$\n', 2);
  _body := left(_body, position('$function$' in _body) - 1);
  _n := (length(_body) - length(replace(_body, _tokline, ''))) / length(_tokline);
  if _n <> 1 then
    raise exception 'ABORT: self-test -- the bot-token line matched % times in ops_daily_digest (want exactly 1)', _n;
  end if;
  _do := left(_body, position(_tokline in _body) - 1)
      || E'  raise exception ''digest_selftest_render:%'', _msg;\nend;\n';
  if position('ops_net_post' in _do) > 0 or position('net.http' in _do) > 0
     or position('bot_token' in _do) > 0 or position('advisory' in _do) > 0
     or position('$selftest$' in _do) > 0 then
    raise exception 'ABORT: self-test -- the cut copy of ops_daily_digest still contains a send, a lock or the quote tag';
  end if;

  -- The function the new lines come from must produce them (same transaction, read-only).
  _exp_line := public.watch_button_health()->>'digest_line';
  if coalesce(_exp_line, '') = '' then
    raise exception 'ABORT: self-test -- watch_button_health() produced no digest_line';
  end if;

  begin
    execute 'do $selftest$' || _do || '$selftest$';
    _err := 'the cut copy returned without raising its message';
  exception when others then
    _err := sqlerrm;   -- the sub-block's savepoint has rolled back whatever the copy did
  end;
  if _err not like 'digest_selftest_render:%' then
    raise exception 'ABORT: self-test -- the rewritten ops_daily_digest does not run: %', _err;
  end if;
  -- Placement and shape, not exact numbers: admin_actions gains rows between two statements of this
  -- transaction (READ COMMITTED), so an exact compare could fail a correct deploy. The coverage line must sit
  -- right under "Baholash eslatmalari", the Mini App line right under it, and the block must still end with
  -- the blank line before "🆕".
  if _err !~ E'Baholash eslatmalari: [0-9]+\n   Kunlik dars eslatmasi \\(48 soat · eslatildi yoki darsda / Telegram bilan\\): [^\n]*\n   Mini App dars tugmalari \\(24 soat\\): [0-9]+ · ochildi \\(48 soat\\): [0-9]+[^\n]*\n\n🆕' then
    raise exception 'ABORT: self-test -- the coverage lines are missing or misplaced in the rendered digest: %', _err;
  end if;

  insert into public.admin_actions (actor_user_id, action, details)
  select null, 'ops_digest_watch_button_coverage',
         jsonb_build_object('function', 'public.ops_daily_digest()',
                            'why', 'daily-reminder coverage per course and Mini App watch-button counts were invisible',
                            'at', now())
  where not exists (select 1 from public.admin_actions where action = 'ops_digest_watch_button_coverage');
end $mig$;
