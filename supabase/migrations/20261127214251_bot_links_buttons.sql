-- 🎁 Bonus darslar / 📣 Kurs Telegrami (telegram-bot-webhook/links-menu.ts), owner request 2026-11-27.
--
-- 1. Seed platform_settings 'bonus_courses' = {"items":[]}: the list of bonus courses (title + https://t.me/ channel
--    link) the owner fills in Admin → Sozlamalar. Empty = the bot answers "tez orada qo'shiladi" and logs
--    admin_actions 'bonus_links_missing' (at most once per 6 h per isolate). Never overwrites an existing row.
-- 2. course_links_health(): a READ-ONLY count of the links 📣 Kurs Telegrami cannot show — published courses without a
--    valid courses.telegram_channel_url, and real groups of published courses (never the course's channel holding
--    group, courses.channel_group_id, which has no chat) without a valid groups.telegram_group_url. "Valid" is the
--    bot's own rule: ^https://t\.me/ (anything else is dropped, because one bad URL makes Telegram refuse the whole
--    message). No cron, no alert: course_wiring_issues() / course_wiring_watchdog() are untouched. The per-tap signal
--    is admin_actions 'course_links_missing' (one row per course+group per Tashkent day).

insert into public.platform_settings (key, value)
values ('bonus_courses', '{"items":[]}'::jsonb)
on conflict (key) do nothing;

create or replace function public.course_links_health()
returns table(courses_without_channel integer, groups_without_link integer)
language sql stable set search_path to 'public', 'pg_temp' as $function$
  select
    (select count(*)::int
       from public.courses c
      where c.published
        and coalesce(c.telegram_channel_url, '') !~ '^https://t\.me/[^[:space:]]+$'),
    (select count(*)::int
       from public.groups g
       join public.courses c on c.id = g.course_id
      where c.published
        and g.id is distinct from c.channel_group_id
        and coalesce(g.telegram_group_url, '') !~ '^https://t\.me/[^[:space:]]+$');
$function$;

revoke execute on function public.course_links_health() from public, anon, authenticated;
grant execute on function public.course_links_health() to service_role;
