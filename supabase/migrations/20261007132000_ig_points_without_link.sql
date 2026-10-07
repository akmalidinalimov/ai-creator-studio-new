-- Instagram extra tasks: an accepted screenshot WITHOUT a post link is paid its 8 points (2026-10-07).
--
-- 20261007124000 made the link optional in the CHECK (evaluate + check_record) — the re-check accepted 6 submissions,
-- but 5 of them were paid 0: the PAYOUT has its own hard-coded link rule. challenge_task_settle_ut (the only writer of
-- daily-task points) sets `_amount := 0` when an instagram submission has no shortcode, because the shortcode is what
-- it claims in challenge_ig_posts to stop one post being paid twice. And the drift detector in challenge_tasks_health
-- deliberately ignored "instagram, accepted, no shortcode, no points" — so the unpaid rows raised no alarm.
--
-- Fan-out of every live function that reads the shortcode (2026-10-07): classify / check_claim / move_core only carry
-- it; evaluate was fixed by 20261007124000; settle_ut and challenge_tasks_health are fixed here. Nothing else gates on it.
--
-- Fix (same switch, challenge_tasks.ig.require_link = false since 20261007124000):
--   * settle_ut: no shortcode → still paid while links are optional (one post paid twice is still stopped by the image
--     dHash near-duplicate rule and by exact-file reuse; a link, when there is one, is still claimed as before);
--   * challenge_tasks_health: an accepted no-link instagram row without points counts as DRIFT again while links are
--     optional — the watchdog alarms on it instead of hiding it;
--   * heal: every accepted instagram submission left at 0 points is settled again (5 today: 139 157 163 166 180).
-- Rewritten from the LIVE definitions, pinned by md5 (verified 2026-10-07); a drifted definition aborts.

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
      ('public.challenge_task_settle_ut(uuid, bigint, jsonb)', '4ad27a35c62e26ade5f24b25819dd844', jsonb_build_array(
         jsonb_build_array(
           $o$        if _s.ig_shortcode is null then
          _amount := 0;
        else$o$,
           $n$        if _s.ig_shortcode is null then
          -- 20261007132000 (owner): no link is needed — a screenshot pays while links are optional
          -- (challenge_tasks.ig.require_link = false); the image dHash / file-reuse rules still stop a double payment
          if coalesce((_cfg->'ig'->>'require_link')::boolean, true) then
            _amount := 0;
          end if;
        else$n$))),
      ('public.challenge_tasks_health(timestamp with time zone)', 'f39dce52ad2b91696ba73581c8579ff4', jsonb_build_array(
         jsonb_build_array(
           $o$           and not (t.type = 'instagram' and s.ig_shortcode is null))$o$,
           -- 20261007132000: a no-link instagram row is legitimately unpaid ONLY while links are required
           $n$           and not (t.type = 'instagram' and s.ig_shortcode is null
                    and coalesce((_cfg->'ig'->>'require_link')::boolean, true)))$n$)))
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

-- heal: pay every accepted instagram submission that was left at 0 points (one student at a time; a failure is
-- recorded, never aborts the others)
do $h$
declare
  _cfg jsonb := public.challenge_tasks_config();
  _r record;
  _paid jsonb := '[]'::jsonb;
  _failed jsonb := '[]'::jsonb;
  _amt int;
begin
  if coalesce((_cfg->'ig'->>'require_link')::boolean, true) then
    raise notice 'links are required again (challenge_tasks.ig.require_link) — nothing to heal';
    return;
  end if;
  for _r in
    select s.id, s.user_id, s.task_id
      from public.challenge_task_submissions s join public.challenge_tasks t on t.id = s.task_id
     where t.type = 'instagram' and t.status = 'approved' and s.status = 'accepted' and s.ig_shortcode is null
       and coalesce(s.points_awarded, 0) = 0
     order by s.id
  loop
    begin
      _amt := public.challenge_task_settle_ut(_r.user_id, _r.task_id, _cfg);
      _paid := _paid || jsonb_build_object('submission', _r.id, 'amount', _amt);
    exception when others then
      _failed := _failed || jsonb_build_object('submission', _r.id, 'error', left(sqlerrm, 200));
    end;
  end loop;
  insert into public.admin_actions (actor_user_id, action, details)
  values (null, 'challenge_ig_unpaid_healed', jsonb_build_object('migration', '20261007132000', 'paid', _paid, 'failed', _failed));
end $h$;
