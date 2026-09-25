-- community_xp_health(): make the forum-topic guard watch itself.
--
-- WHY: 20260925050000 stops an ordinary post in a forum topic from being stored (and paid) as a reply
-- to the topic's creator. The bot-side half of that fix is a heuristic on one Telegram field
-- (`reply_to_message.forum_topic_created`). Heuristics drift: if Telegram reshapes the service message,
-- or a deploy reverts the guard, the bot silently resumes writing person-shaped rows for topic posts and
-- nobody finds out until someone audits by hand — which is exactly how the original bug was found.
--
-- THE SIGNAL: a stored row that has a resolved reply_to_user_id AND whose reply_to_message_id equals its
-- telegram_thread_id is, by definition, an implicit topic reply that the capture guard failed to drop.
-- After the bot fix, NEW rows of that shape must not exist. Measured at authoring time (pre-fix) the
-- 24h count was non-zero and the 7-day count was 1,006, so the detector is demonstrably sensitive —
-- it is not a field that reads zero because it can never read anything else.
--
-- READ THE 24h FIELD, NOT THE 7d ONE, RIGHT AFTER DEPLOY. `_7d` includes rows written BEFORE the fix
-- and therefore drains to zero over a week; `_24h` should reach zero within a day. Both are reported so
-- the drain is visible rather than looking like a partial failure.
--
-- Computed on demand, so it costs nothing until read and writes nothing per message — a per-event
-- counter on a path this hot (61,911 rows historically) would be its own problem.
--
-- Idempotent + replay-safe: create-or-replace of a read-only reporting function. No XP is touched.

create or replace function public.community_xp_health()
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $function$
  select jsonb_build_object(
    'events',   (select count(*) from xp_events where reason in ('community_help','community_question')),
    'xp_total', (select coalesce(sum(amount),0) from xp_events where reason in ('community_help','community_question')),
    'students', (select count(distinct user_id) from xp_events where reason in ('community_help','community_question')),
    'help',     (select count(*) from xp_events where reason = 'community_help'),
    'question', (select count(*) from xp_events where reason = 'community_question'),
    -- Capture-guard drift: must be 0 for rows written after the bot fix. Non-zero = the bot has resumed
    -- storing forum-topic posts as replies to a person, and the help branch is farmable again.
    'topic_guard_leaks_24h',
      (select count(*) from group_message_events
        where reply_to_user_id is not null
          and reply_to_message_id = telegram_thread_id
          and sent_at > now() - interval '24 hours'),
    -- Context: still counts pre-fix rows, so it drains to 0 over a week rather than dropping at once.
    'topic_guard_leaks_7d',
      (select count(*) from group_message_events
        where reply_to_user_id is not null
          and reply_to_message_id = telegram_thread_id
          and sent_at > now() - interval '7 days'),
    'last_run', (select max(created_at) from admin_actions where action = 'community_xp_reconciled'),
    'checked_at', now()
  );
$function$;
revoke execute on function public.community_xp_health() from public, anon, authenticated;
