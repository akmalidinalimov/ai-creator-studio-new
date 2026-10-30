-- Group posts (09:00 / 21:00, group-room) find a group's chat without a «KUNLIK VAZIFALAR» topic.
--
-- group_room_targets read the chat ONLY from groups.daily_task_chat_id, which groups_extract_daily_task_topic fills from
-- the daily-task topic link (and clears when there is none). The owner retired the daily tasks (2026-10-30: "we don't
-- need Kunlik vazifalar anymore … we removed it in 6.0"), so 7.0's groups have no such topic — and would silently get
-- no group posts. Now: daily_task_chat_id, else group_telegram_chat_id(g) — the same chat id every other reader uses
-- (questions inbox, membership check), parsed from the homework topic link. 6.0 is unchanged (its daily_task_chat_id
-- is set and wins).
--
-- Rewritten from the LIVE definition (md5 pinned; a replay with the new body passes).

do $pin$
declare _def text := pg_get_functiondef('public.group_room_targets()'::regprocedure);
begin
  if position('group_telegram_chat_id' in _def) = 0 and md5(_def) <> 'd49ae66fb049244a4899470127801299' then
    raise exception 'group_room_targets changed since 2026-10-30 — re-derive this rewrite from the live definition';
  end if;
end $pin$;

CREATE OR REPLACE FUNCTION public.group_room_targets()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with cfg as (select coalesce(value -> 'course_ids', '[]'::jsonb) c from public.platform_settings where key = 'group_room')
  select coalesce(jsonb_agg(jsonb_build_object(
           'group_id', g.id, 'group_name', g.name, 'chat_id', x.chat,
           'thread_id', g.networking_thread_id,
           'students', (select count(*) from public.profiles p
                         where p.group_id = g.id and p.status = 'active' and p.archived_at is null),
           'ready', x.chat is not null and g.networking_thread_id is not null)
         order by g.name), '[]'::jsonb)
    from public.groups g
    cross join cfg
    cross join lateral (select coalesce(g.daily_task_chat_id, public.group_telegram_chat_id(g.id)) as chat) x
   where g.course_id::text in (select jsonb_array_elements_text(cfg.c));
$function$;

-- ACL exactly as live (service_role only)
revoke execute on function public.group_room_targets() from public, anon, authenticated;
grant execute on function public.group_room_targets() to service_role;

-- self-test (read-only): every 6.0 target keeps the chat it had (daily_task_chat_id), and the function runs
do $test$
declare _bad int;
begin
  select count(*) into _bad
    from jsonb_array_elements(public.group_room_targets()) t
    join public.groups g on g.id = (t->>'group_id')::uuid
   where g.daily_task_chat_id is not null and (t->>'chat_id')::bigint is distinct from g.daily_task_chat_id;
  if _bad > 0 then
    raise exception 'self-test: % group(s) lost their daily_task_chat_id as the group-room chat', _bad;
  end if;
end $test$;
