-- Watch-gate false alarm (2026-10-06 → 10-09; the owner saw "403 ops-github-dispatch", the router trying to send it to
-- the ops agent).
--
-- ROOT CAUSE (verified on prod): watch_gate_watchdog() judged "watched < 20 %" against
--   greatest(lesson_progress.duration_seconds_v2, lessons.duration_seconds)
-- and lessons.duration_seconds is not a reliable length: 596 is a placeholder on 23 lessons, 0 on 143. Module 2 of
-- Challenge 6.0 opened 10-06 with «2.1-Modul: Nimalarni o'rganamiz?» stored as 596 s while the video is 89.6 s
-- (150 players agree: min 89.6, max 89.64). 151 of the 154 flagged "completions" since 10-06 are students who watched
-- that 90-second video to the end (avg max position 87 s). The completions are real; only the detector was wrong.
--
-- CLASS (fanned out): the same `greatest(...)` is used by reconcile_lesson_completions(), where an overstated length
-- can only make it MISS a real completion (1 student stuck on 5.0 «1.1-MODUL», 286 s stored as 596). Three lessons
-- are overstated by > 25 % against >= 137 player reports each.
--
-- FIX:
--  1. watch_gate_watchdog() uses the length the player reported for THAT student (duration_seconds_v2), falling back
--     to lessons.duration_seconds only when the player never reported one. Recomputed on prod: 154 → 0 in the last
--     24 h, 7 genuine low-watch completions in 30 days (threshold 8/day). md5-pinned.
--  2. HEAL: the three overstated lessons get their real length (median of the player reports, guarded on the current
--     placeholder 596). That also lets reconcile_lesson_completions() credit the one stuck student, and fixes the
--     "N daqiqa" shown for those lessons.
-- The watchdog's next run (it posts its own "✅ normallashdi") clears the alert and the router stops dispatching.

do $mig$
declare
  _def text := pg_get_functiondef('public.watch_gate_watchdog()'::regprocedure);
  _old text := 'greatest(coalesce(lp.duration_seconds_v2, 0), coalesce(l.duration_seconds, 0))';
  _new text := 'coalesce(nullif(lp.duration_seconds_v2, 0), nullif(l.duration_seconds, 0), 0)';
begin
  if position(_new in _def) > 0 then
    raise notice 'watch_gate_watchdog already uses the player duration (replay) — skipped';
  else
    if md5(_def) <> 'ed5a09198d9735b7bd601dedaa03ac9e' then
      raise exception 'watch_gate_watchdog drifted (md5 %), refusing to rewrite', md5(_def);
    end if;
    if (length(_def) - length(replace(_def, _old, ''))) / length(_old) <> 2 then
      raise exception 'watch_gate_watchdog: expected the duration expression exactly twice';
    end if;
    execute replace(_def, _old, _new);
  end if;
end
$mig$;

-- 2. heal the overstated lengths (only while they still hold the 596 placeholder)
update public.lessons set duration_seconds = v.secs
  from (values
    ('7963c2eb-b98a-4fec-820e-1cefdb93c0c5'::uuid, 90),   -- 6.0  2.1-Modul: Nimalarni o'rganamiz?            (89.6 s, 150 reports)
    ('31cd8e5e-b0b7-4d5d-b6fd-c4d75c63d916'::uuid, 406),  -- 6.0  2.2-Modul: Qaysi platformadan obuna ...      (406.2 s, 149 reports)
    ('2908a4ec-1a43-4fc8-8833-3e31278bc8f7'::uuid, 286)   -- 5.0  1.1-MODUL: ChatGPT'da ro'yhatdan o'tish ...  (286.2 s, 137 reports)
  ) v(id, secs)
 where lessons.id = v.id and lessons.duration_seconds = 596;

-- self-test (read-only): the watchdog body changed, and the flagged count it will compute is now below its threshold
do $test$
declare _bad int;
begin
  if position('nullif(lp.duration_seconds_v2, 0)' in pg_get_functiondef('public.watch_gate_watchdog()'::regprocedure)) = 0 then
    raise exception 'selftest: watch_gate_watchdog not rewritten';
  end if;
  select count(*) into _bad
    from public.lesson_progress lp join public.lessons l on l.id = lp.lesson_id
   where lp.completed_at is not null and lp.completed_at > now() - interval '24 hours'
     and l.video_provider = 'bunny' and coalesce(l.provider_video_id, '') <> ''
     and coalesce(nullif(lp.duration_seconds_v2, 0), nullif(l.duration_seconds, 0), 0) >= 90
     and coalesce(lp.max_position_seconds, 0) < 0.2 * coalesce(nullif(lp.duration_seconds_v2, 0), nullif(l.duration_seconds, 0), 0);
  raise notice 'watch-gate flagged in the last 24 h after the fix: %', _bad;
end
$test$;
