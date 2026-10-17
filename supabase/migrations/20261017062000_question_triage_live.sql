-- Question triage goes LIVE (owner, 2026-10-17: "yes" after the 7-day backtest of 20261016112600).
--
-- Backtest (shadow, 354 messages, 2026-10-09 … 10-16): 48 would be hidden — 45 clearly right (greetings, thanks,
-- «хоп чунарли», commands, a bare link, students chatting/advising each other), 3 borderline, 0 clear questions; 62 the
-- AI leaned "not a question" on but below the threshold stayed questions (real ones among them — the threshold works).
-- One new case since then WAS a real problem the AI would have hidden at 0.80: «Assalomu aleykum … man kiromadim Darsni
-- koromadim». So, together with this switch, the edge function (same PR) never lets the AI hide a message with problem
-- words ("kiromadim", "ko'rolmadim", "ochilmayapti", "чунмамман", "не могу" …) and the threshold rises 0.80 → 0.85.
--
--   1. platform_settings.question_triage: mode 'live', min_conf 0.85, backfill finished (backfill_since removed, so the
--      every-minute cron is idle when nothing is new).
--   2. The open messages the shadow run judged not-a-question are hidden too (a shadow verdict is never applied
--      retroactively by itself) — only the 17 reviewed by hand; three are kept as questions and marked so:
--      #178 «Хаа болди чунмамман рахмат», #233 («…kamchiliklarni aytasiz bo'lsa» — asks for feedback),
--      #382 («man kiromadim, darsni ko'romadim» — a real problem).
-- Teachers: ❓ Savollar → «🙈 Yashirilgan» shows every hidden message of 7 days; «↩️ Bu savol» brings one back.
-- Kill-switch: platform_settings.question_triage.mode = 'shadow' (stop hiding) or enabled = false (stop triage).

update public.platform_settings
   set value = (value - 'backfill_since') || jsonb_build_object('mode', 'live', 'min_conf', 0.85), updated_at = now()
 where key = 'question_triage';

do $$
declare _hidden int; _kept int;
begin
  update public.teacher_questions
     set status = 'dismissed'
   where id in (101, 116, 118, 136, 142, 147, 206, 207, 244, 285, 289, 290, 292, 358, 374, 378, 380)
     and status = 'open' and triage = 'not_question';
  get diagnostics _hidden = row_count;

  update public.teacher_questions
     set triage = 'question', triage_kind = 'problem', triage_reason = 'review_override_20261017'
   where id in (178, 233, 382) and triage = 'not_question';
  get diagnostics _kept = row_count;

  insert into public.admin_actions (actor_user_id, action, details)
  select null, 'question_triage_live', jsonb_build_object('migration', '20261017062000', 'hidden_backlog', _hidden,
         'kept_as_questions', _kept, 'min_conf', 0.85)
  where not exists (select 1 from public.admin_actions where action = 'question_triage_live');
end $$;
