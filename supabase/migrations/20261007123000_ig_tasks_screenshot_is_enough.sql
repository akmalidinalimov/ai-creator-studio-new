-- Instagram extra tasks: an Instagram SCREENSHOT whose username matches the student's saved handle pays the 8 points
-- (owner, 2026-10-07: "people are uploading screenshots but not getting points … stories, feeds or reels — everything
-- needs to be identified as Instagram; if the username matches the one in the profile, give the points").
--
-- Evidence (task #6, 2026-10-07, the first Instagram task): 20 accepted, 10 needs_more, 10 rejected:
--   * 10 needs_more = missing ig_link: a screenshot (often a STORY, which has no post link) without a post link.
--     challenge_task_evaluate HARD-CODES the link for every instagram task, whatever the task's requires say.
--   * 5 rejected ig_tag_missing: username matched, but the @aicreators.students tag was not visible.
--   * 2 rejected ig_handle_mismatch on the SAME account: 'benzol.avto_ehtiyot_qismlar' seen vs
--     'benzol_avto.extiyot.qismlar' saved (dots/underscores swapped → edit distance 4 > 1), and a story where the
--     model read the display name ('Robiya') instead of the username.
--   * the model's instructions defined an Instagram screenshot as "a post or reel" — a story could be labelled not
--     Instagram (fixed in challenge-task-check/verdict.ts, PROMPT_VERSION task-v2, deployed BEFORE this migration).
--
-- The fix — switchable, no edit of the frozen task rows (challenge_tasks_lock freezes requires / requires_tag of a posted
-- task, and rightly so):
--   1. challenge_tasks.ig.require_link / ig.require_tag (new config keys, default TRUE = old behaviour), set FALSE here:
--      challenge_tasks_config parses them; challenge_task_evaluate drops the link requirement (and the link-reuse
--      reasons) when require_link is off; challenge_task_check_record skips the tag check when require_tag is off.
--   2. Handles are compared without dots and underscores (benzol.avto_ehtiyot ≈ benzol_avto.extiyot), still within
--      ig.handle_edit_distance (1). Everything else stays: Instagram-or-not, the visible username must match the
--      saved handle, no near-duplicate / reused image, no manipulation, not an old post, an unsure verdict never pays.
--   3. The wording of the upcoming Instagram tasks (rubric = what the model is told; submit hint).
--   4. Heal task history: every instagram submission refused ONLY for a rule that no longer applies (needs_more for
--      the link; rejected for tag / handle / not-Instagram / unclear) is checked again with the new rules and prompt.
-- Kill-switch: set challenge_tasks.ig.require_link / require_tag back to true.
--
-- The three function texts are rewritten from their LIVE definitions, pinned by md5 (verified 2026-10-07); a drifted
-- definition aborts the migration instead of being patched blind.

do $mig$
declare
  _def text;
  _new text;
  _fn text;
  _pairs jsonb;
  _p jsonb;
  _md5 text;
  _n int;
begin
  for _fn, _md5, _pairs in
    select * from (values
      ('public.challenge_tasks_config()', 'dc2a2eda09c0cd4785c7ac5fc7612633', jsonb_build_array(
         jsonb_build_array(
           $o$array['require_recent', 'existence_probe', 'lock_handle_after_accept']$o$,
           $n$array['require_recent', 'existence_probe', 'lock_handle_after_accept', 'require_link', 'require_tag']$n$))),
      ('public.challenge_task_evaluate(bigint, jsonb, boolean)', '558a6714cd69c978904cb191724c8e41', jsonb_build_array(
         jsonb_build_array(
           $o$    if _sc is null and not ('ig_link' = any(_missing)) then
      _missing := _missing || 'ig_link'::text;
    end if;$o$,
           $n$    if coalesce((_cfg->'ig'->>'require_link')::boolean, true) then
      if _sc is null and not ('ig_link' = any(_missing)) then
        _missing := _missing || 'ig_link'::text;
      end if;
    else
      -- 20261007123000 (owner): the screenshot is enough — the post link is optional (a story has none)
      _missing := array_remove(_missing, 'ig_link');
    end if;$n$),
         jsonb_build_array(
           $o$    if _sc is null and _any_sc then
      _reason := 'ig_link_reused';
    elsif _sc is null and _share then
      _reason := 'ig_link_share';
    end if;$o$,
           $n$    if not coalesce((_cfg->'ig'->>'require_link')::boolean, true) then
      null;                                       -- the link is optional: a reused / share link is no reason
    elsif _sc is null and _any_sc then
      _reason := 'ig_link_reused';
    elsif _sc is null and _share then
      _reason := 'ig_link_share';
    end if;$n$))),
      ('public.challenge_task_check_record(bigint, uuid, integer, jsonb, jsonb)', 'ce9548ed40f164ce45bfca3063e0965e', jsonb_build_array(
         jsonb_build_array(
           $o$public.challenge_task_edit_distance(_seen, coalesce($o$,
           -- 20261007123000: compared without dots / underscores (the same account written two ways)
           $n$public.challenge_task_edit_distance(translate(_seen, '._', ''), translate(coalesce($n$),
         jsonb_build_array(
           $o$where p.id = _s.user_id)))$o$,
           $n$where p.id = _s.user_id)), '._', ''))$n$),
         jsonb_build_array(
           $o$elsif coalesce(_t.requires_tag, true) and not (_v->>'tag_seen')::boolean$o$,
           $n$elsif coalesce(_t.requires_tag, true) and coalesce((_cfg->'ig'->>'require_tag')::boolean, true)
          and not (_v->>'tag_seen')::boolean$n$)))
    ) v(fn, md5, pairs)
  loop
    _def := pg_get_functiondef(_fn::regprocedure);
    if md5(_def) <> _md5 then
      raise exception 'ABORT: % drifted from its verified live text (md5 % <> %) — not patching blind', _fn, md5(_def), _md5;
    end if;
    _new := _def;
    for _p in select value from jsonb_array_elements(_pairs) loop
      _n := (length(_new) - length(replace(_new, _p->>0, ''))) / length(_p->>0);
      if _n <> 1 then
        raise exception 'ABORT: % — expected exactly one occurrence of «%», found %', _fn, left(_p->>0, 60), _n;
      end if;
      _new := replace(_new, _p->>0, _p->>1);
    end loop;
    execute _new;
  end loop;
end $mig$;

-- 1. the switches
update public.platform_settings
   set value = jsonb_set(jsonb_set(value, '{ig,require_link}', 'false'::jsonb, true), '{ig,require_tag}', 'false'::jsonb, true),
       updated_at = now()
 where key = 'challenge_tasks';

-- self-test (read-only): the parser now carries the switches, as set
do $t$
begin
  if coalesce((public.challenge_tasks_config()->'ig'->>'require_link')::boolean, true)
     or coalesce((public.challenge_tasks_config()->'ig'->>'require_tag')::boolean, true) then
    raise exception 'ABORT: challenge_tasks_config does not report require_link / require_tag = false: %',
      public.challenge_tasks_config()->'ig';
  end if;
end $t$;

-- 3. what the model is told and what students read, for the upcoming Instagram tasks (wording stays editable).
--    One task at a time: an approved task re-checked by trg_challenge_tasks_guard that fails some unrelated check
--    keeps its old wording (counted below) instead of aborting the whole fix.
do $w$
declare
  _t record;
  _ok int := 0;
  _failed jsonb := '[]'::jsonb;
begin
  for _t in
    select id, title from public.challenge_tasks
     where type = 'instagram' and status <> 'cancelled' and task_date >= date '2026-10-07' order by id
  loop
    begin
      update public.challenge_tasks
         set check_rubric = format('Screenshot of the student''s own Instagram content for the task «%s»: a story, a feed post, a carousel or a Reel — all count. The student''s @username must be visible (story: top-left next to the profile picture; post / Reel: the header). A post link and a tag of @aicreators.students are welcome but not required.', _t.title),
             submit_hint = 'Topshirish: Instagram story, post yoki Reels skrinshoti — username koʻrinib tursin. Havola va teg ixtiyoriy.',
             updated_at = now()
       where id = _t.id;
      _ok := _ok + 1;
    exception when others then
      _failed := _failed || jsonb_build_object('task_id', _t.id, 'error', left(sqlerrm, 200));
    end;
  end loop;
  insert into public.admin_actions (actor_user_id, action, details)
  values (null, 'challenge_ig_task_wording_updated', jsonb_build_object('migration', '20261007123000', 'updated', _ok, 'failed', _failed));
end $w$;

-- 4. heal: checked again with the new rules and the new prompt (task-v2 is deployed before migrations run).
--    (a) needs_more only for the link → re-evaluated (the link is optional now).
--    (b) rejected for a rule that no longer applies → reopened ONLY when the student has no live attempt for that task
--        (uq_ctask_sub_live: one needs_more / checking / accepted row per student and task — most students already
--        retried and were accepted), and only their NEWEST such row. Every row in its own sub-block: one row can never
--        abort the fix.
do $h$
declare
  _cfg jsonb := public.challenge_tasks_config();
  _r record;
  _links int := 0;
  _reopened int := 0;
  _skipped jsonb := '[]'::jsonb;
  _ids bigint[] := '{}';
begin
  for _r in
    select s.id from public.challenge_task_submissions s join public.challenge_tasks t on t.id = s.task_id
     where t.type = 'instagram' and t.status <> 'cancelled' and s.status = 'needs_more' and 'ig_link' = any(s.missing)
     order by s.id
  loop
    begin
      perform public.challenge_task_evaluate(_r.id, _cfg, true);
      _links := _links + 1;
      _ids := _ids || _r.id;
    exception when others then
      _skipped := _skipped || jsonb_build_object('id', _r.id, 'error', left(sqlerrm, 200));
    end;
  end loop;

  for _r in
    select distinct on (s.user_id, s.task_id) s.id
      from public.challenge_task_submissions s join public.challenge_tasks t on t.id = s.task_id
     where t.type = 'instagram' and t.status <> 'cancelled' and s.status = 'rejected'
       and s.reason in ('ig_tag_missing', 'ig_handle_mismatch', 'ig_handle_not_visible', 'not_instagram', 'ig_unclear')
       and not exists (select 1 from public.challenge_task_submissions l
                        where l.user_id = s.user_id and l.task_id = s.task_id
                          and l.status in ('needs_more', 'checking', 'accepted'))
     order by s.user_id, s.task_id, s.attempt_no desc, s.id desc
  loop
    begin
      update public.challenge_task_submissions
         set status = 'needs_more', reason = null, missing = '{}', updated_at = now()
       where id = _r.id and status = 'rejected';
      perform public.challenge_task_evaluate(_r.id, _cfg, true);
      _reopened := _reopened + 1;
      _ids := _ids || _r.id;
    exception when others then
      _skipped := _skipped || jsonb_build_object('id', _r.id, 'error', left(sqlerrm, 200));
    end;
  end loop;

  insert into public.admin_actions (actor_user_id, action, details)
  values (null, 'challenge_ig_rules_relaxed', jsonb_build_object(
    'migration', '20261007123000', 'require_link', false, 'require_tag', false, 'handle_compare', 'without dots/underscores',
    'prompt_version', 'task-v2', 'rechecked_link_only', _links, 'rechecked_rejected', _reopened, 'submission_ids', to_jsonb(_ids),
    'skipped', _skipped));
end $h$;
