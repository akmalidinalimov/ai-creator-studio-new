-- Instagram extra tasks: an honest mix-up is a HINT, not a used attempt (owner, 2026-10-07: "if they upload something
-- that is not an Instagram screenshot, let them know the image first needs to be posted on Instagram, then the
-- screenshot with the username sent — make it informative and guiding").
--
-- The bot already tells Instagram screenshots from plain images (the AI's is_instagram_screenshot + the username it
-- reads). Two things change:
--   * the student-facing text (supabase/functions/_shared/daily-task-render.ts igGuide + the result DM): step-by-step
--     guidance instead of "skrinshot Instagramdan emas";
--   * this migration: a rejection for not_instagram / ig_handle_not_visible / ig_unclear no longer uses one of the 3
--     attempts (max_attempts_per_task), so a student who first sends the generated picture can simply post it and send
--     the screenshot. Wrong account, reused or duplicate image, old post, manipulation still count. The free retries are
--     still bounded by ai_max_checks_per_user_day (6).
--     public.challenge_task_rejected_count is THE one count every attempts rule reads (capture, capture_miniapp,
--     move_core, payload, prepare_miniapp, tick — verified in pg_proc 2026-10-07); withdraw_core only mentions it.
--     Rewritten from its LIVE definition, pinned by md5.
--   * heal: today's students refused for one of those reasons, with no accepted / live attempt since, get the new
--     guiding DM now and their group receipt re-rendered with it.

do $mig$
declare
  _def text;
  _old constant text := $o$     and (x.status = 'rejected' or (x.status = 'withdrawn' and x.withdrawn_from = 'rejected'))$o$;
  _n int;
begin
  _def := pg_get_functiondef('public.challenge_task_rejected_count(uuid, bigint)'::regprocedure);
  if md5(_def) <> 'fd62819b4c805804f9ad6834a55b17d4' then
    raise exception 'ABORT: challenge_task_rejected_count drifted from its verified live text (md5 %) — not patching blind', md5(_def);
  end if;
  _n := (length(_def) - length(replace(_def, _old, ''))) / length(_old);
  if _n <> 1 then
    raise exception 'ABORT: challenge_task_rejected_count — expected one occurrence of the status filter, found %', _n;
  end if;
  execute replace(_def, _old, _old || $n$
     -- 20261007133500 (owner): an honest Instagram mix-up is a hint, not a used attempt — the work is not an Instagram
     -- screenshot yet, the username is not visible, or the screenshot is unclear (mirrors daily-task-render IG_FREE_REASONS)
     and coalesce(x.reason, '') not in ('not_instagram', 'ig_handle_not_visible', 'ig_unclear')$n$);
end $mig$;

-- self-test (read-only): a fixture-free check that the function still compiles and runs
do $t$
begin
  perform public.challenge_task_rejected_count('00000000-0000-0000-0000-000000000000'::uuid, 0);
end $t$;

-- heal: the guiding message for today's students refused for a mix-up and not accepted since
do $h$
declare
  _r record;
  _dm int := 0;
  _rerendered int := 0;
begin
  for _r in
    -- each student's NEWEST refusal for the task, only when THAT one is a mix-up (a newer wrong-account refusal is not)
    select n.id, n.user_id, n.task_id
      from (select distinct on (s.user_id, s.task_id) s.id, s.user_id, s.task_id, s.reason
              from public.challenge_task_submissions s join public.challenge_tasks t on t.id = s.task_id
             where t.type = 'instagram' and t.status = 'approved' and t.task_date >= date '2026-10-06'
               and s.status = 'rejected'
               and not exists (select 1 from public.challenge_task_submissions l
                                where l.user_id = s.user_id and l.task_id = s.task_id
                                  and l.status in ('needs_more', 'checking', 'accepted'))
             order by s.user_id, s.task_id, s.id desc) n
     where n.reason in ('not_instagram', 'ig_handle_not_visible', 'ig_unclear')
  loop
    -- the group receipt is re-rendered (the worker edits it) with the guide
    update public.challenge_task_submissions
       set receipt_version = receipt_version + 1,
           receipt_state = case when receipt_state = 'suppressed' and receipt_message_id is null then 'suppressed' else 'pending' end,
           updated_at = now()
     where id = _r.id;
    _rerendered := _rerendered + 1;
    -- and the result DM, once (the worker renders the CURRENT state: rejected + reason → the guide)
    if public.challenge_task_dm_eligible(_r.user_id) then
      insert into public.challenge_task_outbox (user_id, kind, task_id, submission_id, dedupe_key, payload)
      values (_r.user_id, 'result', _r.task_id, _r.id, 'result:' || _r.id::text || ':guide20261007',
              jsonb_build_object('decision', 'rejected', 'reason', 'guide'))
      on conflict (dedupe_key) do nothing;
      _dm := _dm + 1;
    end if;
  end loop;
  insert into public.admin_actions (actor_user_id, action, details)
  values (null, 'challenge_ig_guidance_sent', jsonb_build_object('migration', '20261007133500', 'receipts', _rerendered, 'dms', _dm));
end $h$;
