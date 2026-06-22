# Anonymous-admin teacher-chat backfill — 2026-06-23 (one-time prod data fix)

## Problem
Teachers answer in the Telegram groups **anonymously** ("as the group"). Telegram delivers those
messages via its **GroupAnonymousBot**, with `message.sender_chat == the group` and `from.is_bot == true`.
The bot's `recordGroupMessageEvent` dropped them with `if (!from || from.is_bot) return`, so **every
anonymous teacher answer was invisible** to Teacher Statistics. Result: 6 of 7 teachers looked silent /
"don't chat" — a false conclusion. (Only Shaxrizoda posts mostly non-anonymously, so she alone showed up.)

## Verified
`webhook_inbox` logs every raw update. Anonymous-admin messages (`sender_chat.id == chat.id`) totalled
**6,887** across its retained history — all mapped cleanly to a group with an assigned teacher.

## Fix (code, version-controlled)
- `supabase/migrations/20260623120000_anon_admin_capture.sql` — adds `is_anon_admin boolean` +
  `author_signature text` to `group_message_events` (+ partial index).
- `supabase/functions/telegram-bot-webhook/index.ts` `recordGroupMessageEvent` — now keeps anonymous-admin
  messages (detect `sender_chat.id === chat.id`), attributes them to the group's `teacher_id`, and stores
  `author_signature`. Going forward these are captured live.

## One-time backfill (run once in the Lovable SQL editor — safe to re-run, `ON CONFLICT DO NOTHING`)
Reconstructed historical anonymous teacher messages from `webhook_inbox` into `group_message_events`,
attributed to each group's teacher. **DO NOT need to re-run** (idempotent).

```sql
with chat_to_group as (
  select telegram_chat_id, group_id from (
    select telegram_chat_id, group_id,
      row_number() over (partition by telegram_chat_id order by count(*) desc) rn
    from group_message_events where group_id is not null
    group by telegram_chat_id, group_id) s where rn=1),
anon as (
  select distinct on (wi.chat_id, (wi.raw_update->'message'->>'message_id'))
    wi.chat_id, (wi.raw_update->'message') as m
  from webhook_inbox wi
  where wi.raw_update->'message'->'sender_chat' is not null
    and (wi.raw_update->'message'->'sender_chat'->>'id') = wi.chat_id::text
  order by wi.chat_id, (wi.raw_update->'message'->>'message_id'), wi.received_at desc)
insert into group_message_events
  (group_id, module_id, profile_id, telegram_user_id, telegram_chat_id,
   telegram_message_id, telegram_thread_id, sent_at, is_anon_admin, author_signature)
select cg.group_id, null, g.teacher_id, (a.m->'from'->>'id')::bigint, a.chat_id,
  (a.m->>'message_id')::bigint, (a.m->>'message_thread_id')::bigint,
  to_timestamp((a.m->>'date')::bigint), true, (a.m->>'author_signature')
from anon a
join chat_to_group cg on cg.telegram_chat_id=a.chat_id
join groups g on g.id=cg.group_id
where (a.m->>'message_id') is not null
on conflict (telegram_chat_id, telegram_message_id) do nothing;
```

## Result (per group, anonymous answers recorded)
Rano 2122 · Dono 1219 · Feruza 1008 · Guli 1213 (2 groups) · Ozoda 684 · **Aisha 627** · Shaxrizoda 14.
All seven teachers now show real chat activity in the dashboard. `admin_teacher_weekly` needed no change
(it already counts `group_message_events` by `profile_id`).
