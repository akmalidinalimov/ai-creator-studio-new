-- Students could never resolve their group's homework TOPIC LINK — a silent, pre-existing bug.
--
-- public.groups has exactly ONE RLS policy ("groups admin all": ALL to authenticated WHERE
-- has_role(auth.uid(),'admin')). So a STUDENT selecting groups.homework_topic_url gets zero rows and the
-- client resolved the link as NULL. Both student-facing call sites then rendered NOTHING at all
-- (`{topicUrl && ...}`), so the "post your video/document in your group topic" deep-link has never once
-- appeared for a student — invisible until the Mini App homework upload added a loud fallback, which
-- surfaced it as "Guruh topiki sozlanmagan" even though the link IS configured in the admin panel
-- (admins can read it; students cannot). Affected: components/homework/HomeworkSubmit.tsx and
-- components/lesson/HomeworkSection.tsx.
--
-- FIX (minimal exposure, no new table access): a SECURITY DEFINER accessor that returns ONLY the caller's
-- OWN homework topic url. It does NOT open groups (or group_module_topics) to students — the whole row,
-- other groups, and every other column stay unreadable. Precedence mirrors the existing client logic:
-- the per-module topic (group_module_topics) when a module is given, else the group-level fallback.
--
-- ANON SAFETY (see the SECURITY DEFINER anon-guard lesson: `auth.uid() is null` LEAKS to anon because
-- anon's uid is null too): this never uses that idiom. It JOINS on profiles.id = auth.uid(), so for anon
-- (uid NULL) no profile row matches and it returns NULL. EXECUTE is also revoked from public/anon.
create or replace function public.my_homework_topic_url(p_module_id uuid default null)
returns text
language sql
stable
security definer
set search_path = public
as $fn$
  select coalesce(
    (select gmt.telegram_topic_url
       from public.group_module_topics gmt
       join public.profiles p on p.id = auth.uid()
      where gmt.group_id = p.group_id
        and p_module_id is not null
        and gmt.module_id = p_module_id
      limit 1),
    (select g.homework_topic_url
       from public.groups g
       join public.profiles p on p.id = auth.uid()
      where g.id = p.group_id
      limit 1)
  );
$fn$;

revoke execute on function public.my_homework_topic_url(uuid) from public, anon;
grant execute on function public.my_homework_topic_url(uuid) to authenticated;
