-- Challenge 6.0 daily tasks, PR-8: GO-LIVE. Seeds the owner-approved 25-task plan as DRAFTS and switches the engine
-- on (enabled, ai, miniapp). Nothing is approved here: a draft is never posted, scored or alarmed on, so the first
-- student-visible post is Monday 2026-10-05 09:00 -- and only once a human has approved that day's task.
--
-- ═══ WHAT THIS DOES (one DO block: all of it commits, or none of it) ═══
-- 1. SEED: the 25 tasks of the owner-approved v2 plan (weeks[].tasks[]) into public.challenge_tasks for AI CREATORS
--    CHALLENGE 6.0 (f502f631-...), status 'draft', source 'import', Mon-Fri 2026-10-05 .. 2026-11-06 (week N day D =
--    the D-th weekday of week N). The literal rows are the admin importer's OWN output: scripts/gen-daily-tasks-seed.mjs
--    runs parsePlan() + buildImportRows() from src/lib/dailyTasksPlan.ts (the code behind «Rejani import qilish»,
--    ChallengePlanImportDialog.tsx) with start 2026-10-05, weekdays [1..5], defaultPoints {general 5, instagram 8};
--    `node scripts/gen-daily-tasks-seed.mjs --check <this file>` and the PGlite harness both prove the embedded block
--    equals it. Each row is inserted with the SAME column expressions as admin_challenge_tasks_import (PR-2,
--    20260930122010 §4): its RPC cannot be called here (it needs an admin JWT; auth.uid() is NULL in a migration).
--    Idempotent the importer's way: a plan_ref already live for the course, or a date already holding a non-cancelled
--    task, is SKIPPED; an existing row is never updated. Before inserting ANYTHING, every one of the 25 rows must pass
--    challenge_task_requires_problem(type, requires, accepts) IS NULL (the approve guard's rule 3) and
--    challenge_task_post_length(challenge_task_render_post(row)) <= 4000 (rule 4), also measured with the day number
--    the task will carry once every earlier plan day is approved -- else ABORT. Afterwards: each of the 25 dates holds
--    exactly one live task, a DRAFT, carrying that date's plan_ref, and 0 of them is approved -- else ABORT.
-- 2. SWITCH ON: platform_settings.challenge_tasks gets enabled = true, ai = true, miniapp = true (a shallow jsonb
--    merge: every other key -- post / dm / remind / summary / receipts / times / budget / miniapp_link /
--    miniapp_onboarding ... -- is asserted byte-identical afterwards). ai_daily_budget_usd stays 3.
-- 3. SELF-TESTS (read-only; they never send, award, need a JWT or call the tick / watchdog / a claim):
--    * challenge_tasks_config(): active, ai, miniapp; miniapp_link NULL; invalid [] (the watchdog's config_invalid).
--    * challenge_task_is_task_day(6.0, d, cfg) is FALSE for 2026-10-01 .. 2026-10-05 (10-05 is a draft), for every
--      date with no approved task on or before it.
--    * the tick's work for TODAY, read with the tick's own filters: 0 task posts to queue at 09:00, 0 morning / evening
--      DM recipients, no 'no_task_today' row and no 18:00 missing-TOMORROW DM; challenge_tasks_worker_due(cfg) says
--      state active with posts = receipts = dms = 0; challenge_task_check_due() says idle (ai on, nothing queued).
--    * challenge_tasks_health(now()): active, config_invalid [], no calendar alarm (is_task_day / tomorrow false) and
--      no checks_stuck. Every OTHER watchdog condition that holds right now (reconciler age, retry / unknown senders,
--      held senders, bot status, invariants ...) is not caused by this switch: it is written to the audit row as
--      `latent` and printed as a NOTICE, never swallowed.
--    The state assertions (is_task_day, today's work, due counts) run only while no challenge course has an approved
--    task -- the state this file creates. If one exists already (e.g. retro days entered and approved by hand), a
--    task day and its DMs are legitimate: the audit row records the assertion as skipped with that reason.
-- 4. AUDIT ONCE: admin_actions 'challenge_tasks_imported' (the importer's own row shape, actor NULL, when anything was
--    created) and 'challenge_tasks_went_live' (the marker: seed result, config, self_test verdicts, `observed` answers
--    of the read-only calls, latent signals, AI-provider evidence). A replay finds the marker and changes NOTHING: no
--    re-seed (a cancelled plan day stays cancelled), no re-switch (a kill-switch the owner flipped stays flipped).
--
-- NOTE for retro credit (owner decision, not this file): a retro day approved for 2026-10-01 alone makes EVERY later
-- weekday a task day (challenge_task_is_task_day: a weekday on/after the FIRST approved date), so Friday 10-02 would
-- alarm 'no_task_today'. Enter every hand-posted weekday (10-01 AND 10-02) or none (the harness shows it, L5c).
--
-- ═══ VERIFIED LIVE, 2026-09-30 (read-only) ═══
-- * public.challenge_tasks: 0 rows. platform_settings.challenge_tasks: enabled false, ai false, miniapp false,
--   miniapp_link null, miniapp_onboarding false, task_weekdays [1..5], points {general 5, instagram 8}, post 09:00,
--   remind 19:00, summary 20:00, quiet 22:00-08:00, ai_daily_budget_usd 3, test_group_ids []. challenge: enabled,
--   course_ids [6.0], window.start 2026-10-01T00:00+05, end null.
-- * challenge_task_is_task_day (md5 baa7e437...): an APPROVED task date, or a configured weekday on/after the FIRST
--   approved date -- drafts never make a task day, so with only drafts the tick writes no 'no_task_today' row and
--   sends no 18:00 missing-TOMORROW DM. challenge_tasks_guard: inserting a draft runs bookkeeping only.
-- * cron: challenge-tasks-tick (* * * * *), challenge-task-check-kick (* * * * *), challenge-tasks-reconcile
--   (4-59/10), challenge-tasks-watchdog (47 * * * *) -- all active, all heartbeating while paused.
-- * Edge functions challenge-tasks-worker and challenge-task-check are deployed (v1). challenge-task-check reads the
--   SAME provider secrets as challenge-qa-judge (ANTHROPIC_API_KEY, else OpenAI_AIStudentSupport / OPENAI_API_KEY:
--   project-wide edge secrets). challenge-qa-judge (shadow mode, every 10 min) logged 51 runs on 2026-09-30, every
--   one status 'ok' and none 'no_key' -- its claim returns 'no_key' when NO provider key is set -- so at least one key
--   is configured.
--   Not provable read-only: that the key is VALID (no provider call has been made yet: challenge_qa_ai_calls and
--   challenge_task_ai_calls are empty). An invalid key shows up as 'challenge_task_check_provider_auth_failed' (once a
--   day) and, 90 minutes on, the engine watchdog's checks_stuck alarm.
-- * tg-miniapp-auth (also on PR-7's branch) still answers 403 not_linked to a Telegram user without a profile: there
--   is no member onboarding, so miniapp_onboarding stays false and miniapp_link stays NULL (see d1).
--
-- ═══ DEVIATIONS (each argued; the PR body repeats them) ═══
-- d1 miniapp_link is NOT set. PR-7's contract (and PR-3's config parser, G28): challenge_tasks_config() accepts a
--    miniapp_link only when miniapp_onboarding = true, otherwise it reports it invalid -- the watchdog's config_invalid
--    alarm, i.e. an alarm caused purely by the switch. And onboarding does not exist: a startapp link in the group post
--    would send every member without a linked profile into tg-miniapp-auth's not_linked wall. So the post button stays
--    t.me/<bot>?start=dt_<id> (spec C10: works for every member and makes them DM-able), and miniapp = true switches on
--    exactly what PR-7 built: the Mini App pages, the Dashboard card and submit-daily-task for signed-in students. The
--    startapp link is a later, separate switch (miniapp_onboarding + miniapp_link) once onboarding ships.
-- d2 The seed is validated against the render ALSO with its final day number (the draft renders as day 1; approved
--    one by one it becomes day 1..25): stricter than the guard at insert time, never looser. Approval re-checks anyway.
--
-- ═══ KILL-SWITCHES ═══
-- platform_settings.challenge_tasks.enabled = false: the next minute's tick, check kick and reconciler are heartbeat
-- only; the bot answers 'disabled' (no capture, no receipt). Per feature: ai (checks: text-only / instagram work is
-- held 'ai_off' / 'ig_waiting_ai', nothing is lost), miniapp (Mini App pages hidden, submit-daily-task refuses), dm
-- (morning / evening / result DMs), post (09:00 posts + the SQL fallback poster), summary (20:00 topic summary),
-- remind (evening DMs), receipts (group receipts). A task that should not go out: cancel it (or leave it a draft).
--
-- ═══ DETECTION ═══
-- admin_actions 'challenge_tasks_went_live' (this file, once) and 'challenge_tasks_imported'; everything after it is
-- the existing engine's: tick heartbeat (app_settings challenge_tasks_tick_state), 'challenge_task_no_task_today' /
-- 'challenge_task_no_task_tomorrow' (+ admin DM at 18:00), the watchdog at :47 (post_missing, capture_liveness,
-- checks_stuck, config_invalid, tick / worker alarms ...), challenge_tasks_health().
-- BLIND SPOT (by PR-3's d4 rule, unchanged here): until the FIRST task is approved no date is a task day, so a week 1
-- that is never approved alarms NOTHING -- Monday 09:00 simply posts nothing. Week 1's approval is therefore a human
-- step on the go-live checklist (PR-9's approval message / Admin -> Kunlik vazifalar). From then on the 18:00 check
-- nudges before every weekday whose task is still a draft (the harness shows Sunday 10-11 for W2D1, L7f).
--
-- PGlite harness: supabase/functions/_challenge/testing/daily-tasks-go-live-check.ts (#218 + PR-1/2/3/6/5 + THIS file:
-- the seed equals the importer's output, validation aborts atomically, idempotence, the switch, then the REAL tick on
-- a pinned clock through Thursday .. Monday: nothing is posted, DM'd or alarmed until a task is approved).
-- Merge LAST: PR-7 (Mini App, no migration) -> PR-9 -> THIS. Label migration-approved, NEVER ops-agent.

do $go_live$
declare
  _course constant uuid := 'f502f631-2104-4834-b6c2-702cd3080e27';
  _first constant date := date '2026-10-05';
  _last constant date := date '2026-11-06';
  _file constant text := '20260930203000_challenge_daily_tasks_go_live.sql';
  -- ▼ SEED ITEMS (generated by scripts/gen-daily-tasks-seed.mjs; do not edit by hand) ▼
  _items constant jsonb := $seed$[
  {"task_date":"2026-10-05","type":"general","title":"ChatGPTʼni oʻzingizga moslang","body":"Settings → Personalization boʻlimiga oʻzingiz haqingizda yozing: kimsiz, sohangiz, auditoriyangiz va sizga qulay javob uslubi (masalan, “oʻzbekcha, qisqa, misollar bilan”). Keyin yangi chat ochib, soʻrang: “Sohamda AIʼdan foydalanishning 3 ta usulini ayt.” Javob sizga moslashmagan boʻlsa, sozlamani aniqroq qilib qayta yozing va yana soʻrang.","learn_line":"Nimani oʻrganasiz: ChatGPTʼga har safar oʻzingizni qayta tanishtirmaslikni — endi har bir chat (post, mijozga javob, prompt) sohangiz va uslubingizni bilgan holda boshlanadi.","submit_hint":"Topshirish: 2 ta skrinshot — toʻldirilgan Personalization sozlamasi va yangi chatdagi javob (email koʻrinmasin).","accepts":["text","photo","document"],"requires":[{"any":["photo","image_doc"],"min":1,"label":"screenshot"}],"min_duration_sec":null,"minutes":10,"points":null,"check_rubric":"Two screenshots: (1) ChatGPT Settings > Personalization / custom instructions filled with the student's own context (who they are, niche, audience, preferred answer style); (2) a reply in a new chat that reflects that context (niche-specific, in the requested style) and lists about 3 ways to use AI. Reject if the Personalization fields are empty, only one screenshot is sent, or the reply is unrelated. Flag a visible email or password.","requires_tag":null,"plan_ref":"W1D1","plan_format":"screenshot (2)"},
  {"task_date":"2026-10-06","type":"general","title":"Shaxsiy prompt shabloningiz","body":"Har hafta takrorlanadigan bitta ishingizni tanlang: post matni, mijozga javob yoki mahsulot tavsifi. Avval buni bitta qisqa gap bilan soʻrang, keyin yangi chatda formula bilan yozing — Rol + Vazifa + Kontekst (kim uchun, qaysi ohangda) + Format (hajmi, tuzilishi) — va ikki javobni solishtiring. Yaxshiroq chiqqan promptdagi oʻzgaruvchan joylarni [mahsulot], [auditoriya] kabi kvadrat qavsli soʻzlar bilan almashtiring, soʻng Notes yoki Google Docsʼda “Retseptlar kitobi” nomli hujjat ochib, uni birinchi retsept sifatida saqlang.","learn_line":"Nimani oʻrganasiz: har safar noldan yozmay, faqat qavs ichini almashtirib ishlatiladigan shablon tuzishni — bu Retseptlar kitobingizdagi 1-retsept; 2–3-haftalarda unga rasm va video retseptlari qoʻshiladi.","submit_hint":"Topshirish: [qavsli] shablon matni + shu shablon bilan olingan javob skrinshoti.","accepts":["text","photo","document"],"requires":[{"any":["text"],"min":1,"label":"text"},{"any":["photo","image_doc"],"min":1,"label":"screenshot"}],"min_duration_sec":null,"minutes":15,"points":null,"check_rubric":"A reusable prompt template that contains role, task, context (audience/tone) and format parts and at least 2 [bracketed] placeholders such as [product] or [audience], plus one screenshot of a ChatGPT answer produced with the template filled in. Reject if there are no placeholders, most of the four parts are missing, or no answer screenshot is sent.","requires_tag":null,"plan_ref":"W1D2","plan_format":"text + screenshot"},
  {"task_date":"2026-10-07","type":"general","title":"Brendingiz uchun Project","body":"ChatGPTʼda brendingiz yoki sohangiz nomi bilan Project yarating. Instructionsʼga kimligingiz, auditoriyangiz, ohangingiz va nimalarni yozmaslik kerakligini kiriting, fayl sifatida esa xizmatlaringiz roʻyxatini yoki 3–5 ta eski postingizni yuklang. Keyin Project ichida real vaziyatni sinab koʻring: “Mijoz narxingiz qimmat deb yozdi — mening uslubimda xushmuomala javob yoz.”","learn_line":"Nimani oʻrganasiz: brendingizni biladigan doimiy ish joyi yaratishni — mijozlarga javob, eʼlon va boshqa matnlarni endi shu Project ichida bir necha soniyada tayyorlaysiz.","submit_hint":"Topshirish: Project skrinshoti (nomi, Instructions va fayl koʻrinsin) + shu Project ichidagi javob skrinshoti.","accepts":["text","photo","document"],"requires":[{"any":["photo","image_doc"],"min":1,"label":"screenshot"}],"min_duration_sec":null,"minutes":15,"points":null,"check_rubric":"(1) Screenshot of a ChatGPT Project showing a name, filled Instructions (who/audience/tone/don'ts) and at least one uploaded file; (2) screenshot of a reply inside that Project to a client objection about price, written in a brand-consistent tone. Reject a normal chat with no Project, empty Instructions or no uploaded file. Flag a visible phone number, email or password.","requires_tag":null,"plan_ref":"W1D3","plan_format":"screenshot (2)"},
  {"task_date":"2026-10-08","type":"general","title":"Work rejimi: raqobatchilar jadvali","body":"ChatGPTʼda Work rejimini yoqing va vazifani toʻliq yozib bering: “Sohamdagi 5 ta kuchli Instagram akkaunt yoki raqobatchini top va jadval qil: nomi, havolasi, kontent turi, eng yaxshi ishlaydigan post formati va men undan nimani olishim mumkin. Natijani .xlsx fayl qilib ber.” Work oʻzi reja tuzib ishlaydi — biroz kuting. Hisobingizda Work boʻlmasa, oddiy chatda Search (web qidiruv) bilan bajaring.","learn_line":"Nimani oʻrganasiz: koʻp bosqichli izlanishni AIʼga topshirib, tayyor jadval olishni — keyingi haftalarda gʻoya, namuna va narxlarni izlaganda ham xuddi shu usulni qoʻllaysiz.","submit_hint":"Topshirish: tayyor jadval (.xlsx fayl yoki skrinshot) — 5 ta qator, har birida havola.","accepts":["text","photo","document"],"requires":[{"any":["photo","image_doc","document"],"min":1,"label":"file"}],"min_duration_sec":null,"minutes":20,"points":null,"check_rubric":"A table as an .xlsx/.csv file or a screenshot with about 5 rows (accounts or competitors in one niche) and columns such as name, link, content type, best-performing format and a takeaway for the student. Links look like real profile or website URLs. A Chat + Search result is accepted as the fallback. Reject if there is no table, fewer than 3 rows, or no links.","requires_tag":null,"plan_ref":"W1D4","plan_format":"file (.xlsx/.csv) or screenshot"},
  {"task_date":"2026-10-09","type":"instagram","title":"Tanishuv posti: captionʼni Project yozadi","body":"Brend Projectʼingizda soʻrang: “Mening ohangimda tanishuv posti uchun Instagram caption yoz: kimligim va nega AI oʻrganayotganim, kuchli birinchi qator, 3–4 ta qisqa gap va obunachilarga savol.” Captionʼni oʻz soʻzlaringiz bilan tahrirlang, oʻz suratingiz bilan post qiling va @aicreators.studentsʼni belgilang. Shu akkaunt 5-haftada portfoliongizga aylanadi.","learn_line":"Nimani oʻrganasiz: Projectʼdan olingan matnni oʻzingizniki qilib tahrirlashni — keyingi har bir post captionʼini shu tartibda 5 daqiqada tayyorlaysiz.","submit_hint":"Topshirish: username koʻrinib turgan post skrinshoti + post havolasi.","accepts":["text","photo","document","link"],"requires":[{"any":["photo","image_doc"],"min":1,"label":"screenshot"},{"any":["ig_link"],"min":1,"label":"ig_link"}],"min_duration_sec":null,"minutes":15,"points":null,"check_rubric":"Screenshot of an Instagram feed post or Reel with the student's username visible, @aicreators.students tagged or mentioned, and a self-introduction / 'why I am learning AI' caption; plus a valid instagram.com/p/ or /reel/ link. Reject a story without a post link, a missing tag, or no visible username.","requires_tag":true,"plan_ref":"W1D5","plan_format":"Instagram post: screenshot + link"},
  {"task_date":"2026-10-12","type":"general","title":"Yorugʻlik mashqi: 1 sahna, 3 xil yorugʻlik","body":"Bitta sahna tanlang: oʻylab topilgan odam portreti (masalan, nonvoyxonadagi nonvoy) yoki mahsulotingiz. Bitta promptni bitta vositada — ChatGPT, Nano Banana (Gemini) yoki Higgsfieldʼda — 3 marta ishlating va har safar faqat yorugʻlik qismini almashtiring, masalan: “golden hour side light”, “soft window light”, “hard midday sun” yoki “neon night light”. Qaysi yorugʻlikda rasm eng real chiqqanini aniqlang va 3 ta yorugʻlik retseptini Retseptlar kitobingizga yozing.","learn_line":"Nimani oʻrganasiz: yorugʻlik soʻzlari rasmni qanchalik real qilishini oʻz koʻzingiz bilan koʻrasiz — mahsulot yoki portret buyurtmasida darhol ishlatadigan 3 ta sinalgan yorugʻlik retseptingiz boʻladi.","submit_hint":"Topshirish: 3 ta rasm + 3 ta prompt (faqat yorugʻlik soʻzlari farq qiladi).","accepts":["text","photo","document"],"requires":[{"any":["photo","image_doc"],"min":1,"label":"screenshot"},{"any":["text"],"min":1,"label":"text"}],"min_duration_sec":null,"minutes":20,"points":null,"check_rubric":"Three images of the same subject/scene with visibly different lighting (e.g. warm low sun, soft diffused window light, hard shadows, neon), plus three prompts that are identical except for the lighting phrase. Reject if there are fewer than 3 images or prompts, the subject changes between images, or the prompts differ in more than the lighting part. Quality is not graded; watermarks are fine.","requires_tag":null,"plan_ref":"W2D1","plan_format":"image (3) + text (3 prompts)"},
  {"task_date":"2026-10-13","type":"instagram","title":"Kamera burchagi: 4 rasmli karusel","body":"Bitta mahsulot yoki qahramon uchun asosiy prompt yozing va unga “eye level, medium shot” soʻzlarini qoʻshing. Keyin shu promptdan yana 3 ta rasm yarating, har safar faqat shu qismni almashtirib: “low angle”, “high angle, top-down” va “close-up”. 4 ta rasmni karusel qilib Instagramʼga joylang, captionʼga asosiy promptni va har bir rasmning burchak nomini yozing hamda @aicreators.studentsʼni belgilang.","learn_line":"Nimani oʻrganasiz: burchak kadrning maʼnosini oʻzgartirishini — low angle mahsulotni kuchli koʻrsatadi, top-down taom va mahsulot uchun qulay, close-up esa tafsilot va sifatni ochib beradi; 4 ta burchak retsepti kitobingizga qoʻshiladi.","submit_hint":"Topshirish: username koʻrinib turgan post skrinshoti + post havolasi.","accepts":["text","photo","document","link"],"requires":[{"any":["photo","image_doc"],"min":1,"label":"screenshot"},{"any":["ig_link"],"min":1,"label":"ig_link"}],"min_duration_sec":null,"minutes":20,"points":null,"check_rubric":"Screenshot of an Instagram carousel with the student's username visible and @aicreators.students tagged or mentioned; the slides show the same product or character, and the caption names the angles/shot sizes (eye level, low angle, high angle/top-down, close-up) and contains the base prompt. Plus a valid instagram.com/p/ link. Reject a single image or a story, a missing link or tag, no visible username, or a caption without angle names.","requires_tag":true,"plan_ref":"W2D2","plan_format":"Instagram carousel: screenshot + link"},
  {"task_date":"2026-10-14","type":"general","title":"Obyektiv va fon: 35mm yoki 85mm","body":"Shu haftadagi sahnalaringizdan birini oling va 2 ta rasm yarating: birida “35mm lens, f/8, everything in sharp focus”, ikkinchisida “85mm lens, f/1.8, shallow depth of field, blurred background” boʻlsin. Promptning qolgan qismi soʻzma-soʻz bir xil qolsin. Natijaga qarab, qaysi biri mahsulot yoki portretga, qaysi biri joy yoki interyerga mosligini bir gapda yozing va ikkala retseptni kitobingizga qoʻshing.","learn_line":"Nimani oʻrganasiz: fonni xiralashtirib asosiy obyektni ajratishni (85mm, f/1.8) va butun joyni aniq koʻrsatishni (35mm, f/8) — mahsulot, portret va interyer suratlari uchun 2 ta tayyor obyektiv retsepti.","submit_hint":"Topshirish: 2 ta rasm + 2 ta prompt + qaysi biri qayerga mosligi haqida 1 gap.","accepts":["text","photo","document"],"requires":[{"any":["photo","image_doc"],"min":1,"label":"screenshot"},{"any":["text"],"min":1,"label":"text"}],"min_duration_sec":null,"minutes":15,"points":null,"check_rubric":"Two images of the same scene, one with deep focus (background sharp) and one with shallow depth of field (background clearly blurred), plus two prompts identical except for the lens/aperture phrase (e.g. 35mm f/8 vs 85mm f/1.8) and one sentence on when to use each. Reject if the prompts differ in more than the lens part, the two images look the same in focus, or a prompt is missing.","requires_tag":null,"plan_ref":"W2D3","plan_format":"image (2) + text"},
  {"task_date":"2026-10-15","type":"general","title":"Plastik koʻrinishdan haqiqiy suratga","body":"Shu haftadagi rasmlaringizdan eng sunʼiy koʻrinadiganini tanlang: silliq, plastikdek teri, haddan tashqari yorqin ranglar yoki juda mukammal yuzalar. Promptga faqat realizm qatorini qoʻshib, rasmni qayta yarating, masalan: “natural skin texture with visible pores, small imperfections, fabric wrinkles, natural colour grade, subtle film grain, candid photo”. Ikki rasmni yonma-yon qoʻyib, qaysi sunʼiylik belgilari yoʻqolganini koʻring va shu qatorni Retseptlar kitobingizga yozing.","learn_line":"Nimani oʻrganasiz: AI rasmidagi plastik koʻrinishni yoʻqotadigan realizm qatorini — endi uni har bir mijoz rasmi promptining oxiriga qoʻshasiz.","submit_hint":"Topshirish: “oldin” va “keyin” rasmlari + promptga qoʻshilgan realizm qatori.","accepts":["text","photo","document"],"requires":[{"any":["photo","image_doc"],"min":1,"label":"screenshot"},{"any":["text"],"min":1,"label":"text"}],"min_duration_sec":null,"minutes":15,"points":null,"check_rubric":"Two images of the same scene (before and after; an album or side-by-side is fine) where the after image looks more photographic (visible texture, less plastic smoothness or oversaturation), plus the realism line added to the prompt (texture, imperfections, natural colour, grain or similar). Reject if only one image is sent, the scenes are unrelated, or no realism line is written. Quality is not graded strictly.","requires_tag":null,"plan_ref":"W2D4","plan_format":"image (2) + text"},
  {"task_date":"2026-10-16","type":"instagram","title":"Telefon suratidan reklama suratiga","body":"Uydagi biror buyumni (krujka, atir, krossovka yoki oʻz mahsulotingiz) telefonda suratga oling va ChatGPT yoki Nano Bananaʼga yuklang. Promptga shu haftadagi eng yaxshi yorugʻlik, burchak va obyektiv retseptlaringizdan bittadan qoʻshing hamda “shakli, rangi va yozuvlarini oʻzgartirma” deb yozing. “Telefon surati → AI reklama” karuselini Instagramʼga joylang, captionʼda ishlatgan 3 ta retseptingizni yozing va @aicreators.studentsʼni belgilang.","learn_line":"Nimani oʻrganasiz: haqiqiy mahsulotni oʻzgartirmasdan professional reklama sahnasiga joylashtirishni — bu mijozlar eng koʻp soʻraydigan xizmat, 5-haftada aynan shuni sotasiz.","submit_hint":"Topshirish: username koʻrinib turgan post skrinshoti + post havolasi.","accepts":["text","photo","document","link"],"requires":[{"any":["photo","image_doc"],"min":1,"label":"screenshot"},{"any":["ig_link"],"min":1,"label":"ig_link"}],"min_duration_sec":null,"minutes":20,"points":null,"check_rubric":"Screenshot of an Instagram carousel with the student's username visible, showing a real phone photo of an object and an AI-restaged ad version of the same object (same shape/label), with @aicreators.students tagged or mentioned and a caption naming the lighting, angle and lens recipes used; plus a valid instagram.com/p/ link. Reject if the link is missing, the tag is absent, the username is not visible, or the two images show different products.","requires_tag":true,"plan_ref":"W2D5","plan_format":"Instagram carousel: screenshot + link"},
  {"task_date":"2026-10-19","type":"general","title":"Harakat formulasi: birinchi 5 soniya","body":"Darsdagi formula boʻyicha video prompt yozing va har bir qismini alohida qatorga joylang: kim/nima + nima qilyapti + kamera harakati + joy va yorugʻlik + uslub (masalan, “5 seconds, realistic, cinematic”). Seedance, Kling yoki Omni Flashʼda (qaysi birida bepul kredit boʻlsa, oʻshanda) bitta 5 soniyalik video yarating — bu hafta har vazifaga koʻpi bilan 2 ta video yetadi. Inglizcha yozish qiyin boʻlsa, Projectʼingizga tarjima qildiring. Oxirida formulani [qavsli] shablon qilib Retseptlar kitobingizga saqlang.","learn_line":"Nimani oʻrganasiz: video modelga nimani va qanday tartibda aytish kerakligini — shu shablon bilan har qanday reklama kadrini 1–2 urinishda olasiz va kreditlarni behuda sarflamaysiz.","submit_hint":"Topshirish: qismlarga ajratilgan prompt + tayyor 5 soniyalik video.","accepts":["text","video","document"],"requires":[{"any":["video","video_doc"],"min":1,"label":"video"},{"any":["text"],"min":1,"label":"text"}],"min_duration_sec":null,"minutes":20,"points":null,"check_rubric":"An AI-generated video (file, screen recording or link to the generated clip) and a prompt split into labelled parts: subject, action, camera movement, environment/light, style/duration. The clip plausibly matches the prompt (same subject and setting). Watermarks are fine. Reject if the video or the prompt is missing, the prompt has fewer than 4 of the parts, or the video is a stock clip or a still image.","requires_tag":null,"plan_ref":"W3D1","plan_format":"video + text"},
  {"task_date":"2026-10-20","type":"instagram","title":"Rasmingizni jonlantiring: rasm → video","body":"2-haftadagi eng yaxshi rasmingizni (masalan, reklama suratingizni) image-to-video orqali videoga aylantiring. Promptda rasmni qayta tasvirlamang — faqat nima harakatlanishini va kamera qanday yurishini yozing, masalan: “steam slowly rises from the cup, slow push-in”; harakat sekin va kichik boʻlsa, yozuv va shakllar buzilmaydi. Baʼzi servislar haqiqiy odam yuzi tushgan rasmni qabul qilmaydi, shuning uchun mahsulot yoki AI-qahramon rasmini tanlang. “Rasm → Video” Reelsʼini Instagramʼga joylang, captionʼga harakat promptingizni yozing va @aicreators.studentsʼni belgilang.","learn_line":"Nimani oʻrganasiz: image-to-video promptida faqat harakatni yozish qoidasini — mijozning tayyor mahsulot suratini bir necha daqiqada harakatli Reelsʼga aylantirasiz.","submit_hint":"Topshirish: username koʻrinib turgan Reels skrinshoti + post havolasi.","accepts":["text","photo","document","link"],"requires":[{"any":["photo","image_doc"],"min":1,"label":"screenshot"},{"any":["ig_link"],"min":1,"label":"ig_link"}],"min_duration_sec":null,"minutes":25,"points":null,"check_rubric":"Screenshot of an Instagram Reel or post with the student's username visible and @aicreators.students tagged or mentioned, showing an AI video animated from a still image (ideally still and clip as before/after, or 'Rasm → Video' in the caption) with the motion prompt in the caption; plus a valid instagram.com/reel/ or /p/ link. Reject a story without a post link, a missing tag, or no visible username.","requires_tag":true,"plan_ref":"W3D2","plan_format":"Instagram Reel: screenshot + link"},
  {"task_date":"2026-10-21","type":"general","title":"Kamera harakati: 1 kadr, 2 xil harakat","body":"Kechagi rasmingizni yana boshlangʻich kadr qilib oling va 2 ta video yarating: prompt bir xil, faqat kamera harakati boshqa — masalan, “slow push-in” va “orbit around the subject” (yoki “pull-out”, “pan left”, “crane up”, “handheld”). Boshlangʻich rasm bir xil boʻlgani uchun farqni faqat kamera harakati beradi. Har bir harakat qachon kerakligini bir qatordan Retseptlar kitobingizga yozing.","learn_line":"Nimani oʻrganasiz: kamera harakati kadrga maʼno berishini — push-in eʼtiborni mahsulotga tortadi, orbit uni har tomondan koʻrsatadi, pull-out atrofni ochib beradi; endi reklama uchun harakatni taxminan emas, ongli ravishda tanlaysiz.","submit_hint":"Topshirish: 2 ta video + 2 ta prompt (faqat kamera harakati farq qiladi).","accepts":["text","video","document"],"requires":[{"any":["video","video_doc"],"min":1,"label":"video"},{"any":["text"],"min":1,"label":"text"}],"min_duration_sec":null,"minutes":25,"points":null,"check_rubric":"Two AI-generated clips (or one screen recording showing both) animated from the same starting image, plus two prompts identical except for the camera-movement phrase (e.g. push-in vs orbit, pull-out, pan, crane, tracking, handheld). The clips show different camera motion of the same scene. Watermarks are fine. Reject a single video, prompts that differ in more than the camera phrase, or unrelated scenes.","requires_tag":null,"plan_ref":"W3D3","plan_format":"video (2) + text"},
  {"task_date":"2026-10-22","type":"general","title":"Izchillik: bitta mahsulot, 2 ta kadr","body":"Mahsulotingiz yoki qahramoningiz uchun 2–3 gaplik doimiy tavsif yozing: rangi, shakli, yozuvi yoki kiyimi. Kechagi videolaringizdan biri 1-kadr boʻladi; 2-kadrni oʻsha rasmdan boshqa planda yarating (masalan, 1-kadr umumiy plan boʻlsa, 2-kadr “close-up”) va promptga doimiy tavsifni soʻzma-soʻz qoʻshing. Ikki kadrni yonma-yon koʻrib, mahsulot oʻzgarmaganini tekshiring; buni Klingʼdagi Start/End Frame yoki Multishot bilan ham qilsa boʻladi.","learn_line":"Nimani oʻrganasiz: izchillik retseptini — bitta reference rasm va har bir promptda soʻzma-soʻz takrorlanadigan doimiy tavsif; shunda mijoz mahsuloti butun reklama davomida bir xil koʻrinadi.","submit_hint":"Topshirish: 2 ta video (eski 1-kadr va yangi 2-kadr) + doimiy tavsif matni.","accepts":["text","video","document"],"requires":[{"any":["video","video_doc"],"min":1,"label":"video"},{"any":["text"],"min":1,"label":"text"}],"min_duration_sec":null,"minutes":25,"points":null,"check_rubric":"Two AI clips (an earlier one reused as shot 1 plus a new shot 2) showing the same product or character with the same colours, shape and label/clothing in two different framings (e.g. wide and close-up), plus an anchor description of 2-3 sentences that appears word-for-word in the shot-2 prompt. Reject if only one clip is sent, the product/character clearly changes between clips, or the anchor text is missing.","requires_tag":null,"plan_ref":"W3D4","plan_format":"video (2) + text"},
  {"task_date":"2026-10-23","type":"instagram","title":"3 kadrlik mini-reklama: ritm va kesish","body":"Shu haftadagi videolaringizdan 3 kadrlik ketma-ketlik yigʻing: 1) hook — birinchi soniyada eʼtibor tortadigan kadr, 2) tafsilot — close-up, 3) yakun — mahsulot va qisqa yozuv. Har bir kadrni 2–3 soniyagacha qisqartiring va harakat davom etayotgan joyda kesing; CapCut yoki Instagram muharririda montaj qiling, yangi video yaratish shart emas (kerak boʻlsa, koʻpi bilan 1 ta). Instagramʼga Reels qilib joylang, captionʼga 3 kadrlik rejangizni yozing va @aicreators.studentsʼni belgilang.","learn_line":"Nimani oʻrganasiz: kliplarni reklama ritmiga solishni — hook, tafsilot, yakun va 2–3 soniyalik kesishlar; har bir mijoz Reelsʼini shu sxema boʻyicha yigʻasiz.","submit_hint":"Topshirish: username koʻrinib turgan Reels skrinshoti + post havolasi.","accepts":["text","photo","document","link"],"requires":[{"any":["photo","image_doc"],"min":1,"label":"screenshot"},{"any":["ig_link"],"min":1,"label":"ig_link"}],"min_duration_sec":null,"minutes":25,"points":null,"check_rubric":"Screenshot of an Instagram Reel with the student's username visible and @aicreators.students tagged or mentioned, and a caption that lists a 3-shot plan (hook / detail or close-up / ending); plus a valid instagram.com/reel/ or /p/ link. Reject a story without a post link, a missing tag, no visible username, or a caption without the shot plan. Length and editing quality are not graded.","requires_tag":true,"plan_ref":"W3D5","plan_format":"Instagram Reel: screenshot + link"},
  {"task_date":"2026-10-26","type":"general","title":"Claude Project: kontent yordamchingiz","body":"claude.aiʼda (bepul akkaunt yetadi) “Kontent yordamchim” nomli Project yarating. Instructionsʼga brendingiz, auditoriyangiz, ohangingiz va taqiqlarni yozing, Knowledgeʼga esa Retseptlar kitobingiz va xizmatlaringiz roʻyxatini yuklang (telefon raqami, pasport maʼlumotlari va parollarni qoʻshmang). Keyin soʻrang: “Keyingi hafta uchun 5 kunlik kontent-reja tuz: har bir kun uchun gʻoya, format (rasm yoki Reels) va caption.”","learn_line":"Nimani oʻrganasiz: brendingiz va retseptlaringizni biladigan yordamchi yaratishni — haftalik kontent-reja endi bir soʻrovda tayyor boʻladi, siz faqat tanlab, tahrirlaysiz.","submit_hint":"Topshirish: Project skrinshoti (nomi, Instructions va Knowledge fayllari koʻrinsin) + Claude tuzgan 5 kunlik reja (matn yoki skrinshot).","accepts":["text","photo","document"],"requires":[{"any":["photo","image_doc"],"min":1,"label":"screenshot"},{"any":["text"],"min":1,"label":"text"}],"min_duration_sec":null,"minutes":20,"points":null,"check_rubric":"Screenshot from claude.ai (not ChatGPT) of a Project with a visible name, non-empty Instructions (brand/audience/tone) and at least one Knowledge file (ideally the recipe book); plus Claude's reply inside that Project with a 5-day content plan (idea, format and caption per day). Reject a plain chat with no Project, empty Instructions, no file, or a plan with fewer than 5 days. Flag a visible phone number, address, email, passport or password.","requires_tag":null,"plan_ref":"W4D1","plan_format":"screenshot + text"},
  {"task_date":"2026-10-27","type":"general","title":"Skill: gʻoyadan tayyor promptgacha","body":"Skill — Claudeʼga bir marta oʻrgatiladigan va istalgan chatda ishlaydigan tayyor usul. Claudeʼga yozing: “Menga skill yarat: men gʻoya yoki mahsulot nomini yozaman, sen esa mening formulam boʻyicha 1 ta rasm prompti (obyekt, joy, yorugʻlik, burchak, obyektiv, realizm) va 1 ta 5 soniyalik video prompti (harakat, kamera, muhit, uslub) berasan.” Skillʼni saqlang va yangi chatda boshqa mahsulot bilan sinab koʻring. Skills boʻlimi (Settings → Capabilities) koʻrinmasa, Claude bergan SKILL.md faylini saqlab qoʻying.","learn_line":"Nimani oʻrganasiz: 2–3-haftadagi formulangizni har safar qayta tushuntirmasdan ishlatishni — mijoz gʻoyasini 30 soniyada tayyor rasm va video promptiga aylantirasiz.","submit_hint":"Topshirish: Skills roʻyxatidagi skillʼingiz (yoki SKILL.md) skrinshoti + yangi chatda skill yozib bergan rasm va video prompti.","accepts":["text","photo","document"],"requires":[{"any":["photo","image_doc"],"min":1,"label":"screenshot"},{"any":["text"],"min":1,"label":"text"}],"min_duration_sec":null,"minutes":20,"points":null,"check_rubric":"(1) A screenshot of Claude's Skills list showing a custom skill (or of a SKILL.md file) about turning an idea into image and video prompts; (2) output from a new chat (text or screenshot) containing one image prompt with lighting, angle and lens details and one video prompt with an action and a camera move. Reject an ordinary chat with no sign of a skill or SKILL.md, or output without both prompts. Flag a visible email.","requires_tag":null,"plan_ref":"W4D2","plan_format":"screenshot + text"},
  {"task_date":"2026-10-28","type":"instagram","title":"Gʻoyadan postgacha: yordamchingiz bilan","body":"Kontent-rejangizdan bitta gʻoyani oling, uni skillʼingizga bering va chiqqan rasm promptini ChatGPT yoki Nano Bananaʼda ishlating. Captionʼni Claude Projectʼingizda yozdiring, oʻz soʻzlaringiz bilan biroz tahrirlang va oxiriga “Prompt: Claude skill + mening retseptlarim” deb qoʻshing. Postni Instagramʼga joylang va @aicreators.studentsʼni belgilang.","learn_line":"Nimani oʻrganasiz: reja → skill → rasm → caption zanjirini 20 daqiqada bosib oʻtishni — bu sizning kundalik kontent tayyorlash jarayoningiz.","submit_hint":"Topshirish: username koʻrinib turgan post skrinshoti + post havolasi.","accepts":["text","photo","document","link"],"requires":[{"any":["photo","image_doc"],"min":1,"label":"screenshot"},{"any":["ig_link"],"min":1,"label":"ig_link"}],"min_duration_sec":null,"minutes":20,"points":null,"check_rubric":"Screenshot of a published Instagram post or Reel with the student's username visible, an AI-generated image or clip, @aicreators.students tagged or mentioned, and a caption that mentions the Claude skill/recipes; plus a valid instagram.com/p/ or /reel/ link. Reject a story without a post link, a missing tag, or no visible username.","requires_tag":true,"plan_ref":"W4D3","plan_format":"Instagram post: screenshot + link"},
  {"task_date":"2026-10-29","type":"general","title":"Cowork: papka va Retseptlar kitobi tartibda","body":"Kompyuteringizda “AI-ishlarim” papkasini yarating va unga 2–3-haftadagi rasm va videolaringizni hamda Retseptlar kitobingizni joylang (shaxsiy hujjat va parollarni qoʻymang). Claude Coworkʼga shu papkani ochib bering va yozing: “Fayllarni rasm va video papkalariga ajrat, nomlarini tushunarli qil va retseptlarimdan yorugʻlik, burchak, obyektiv, realizm va kamera harakati boʻlimlari bor Retseptlar-kitobi.docx faylini yarat.” Hisobingizda Cowork boʻlmasa, xuddi shu vazifani Codexʼda bajaring; kompyuter boʻlmasa, faqat hujjatni ChatGPT yoki Claude chatida yarating.","learn_line":"Nimani oʻrganasiz: fayllar bilan bogʻliq zerikarli ishni agentga topshirishni — har bir mijoz loyihasini shu tarzda bitta buyruq bilan tartibga solasiz, Retseptlar kitobingiz esa tayyor hujjatga aylanadi.","submit_hint":"Topshirish: tartibga solingan papka skrinshoti + yaratilgan Retseptlar kitobi fayli (.docx, .pdf yoki .md).","accepts":["text","photo","document"],"requires":[{"any":["photo","image_doc"],"min":1,"label":"screenshot"},{"any":["image_doc","document"],"min":1,"label":"file"}],"min_duration_sec":null,"minutes":20,"points":null,"check_rubric":"(1) A screenshot of a folder (file explorer or the Cowork/Codex session) with files sorted into subfolders such as images/videos and readable names; (2) a document (.docx, .pdf or .md) titled like a recipe book with sections such as lighting, angle, lens, realism and camera movement containing prompt recipes. A Codex session is an accepted fallback; phone-only students may send only the document. Reject if only a chat is shown with no folder or file, or the document is empty or unrelated. Flag visible passwords, API keys or personal documents.","requires_tag":null,"plan_ref":"W4D4","plan_format":"screenshot + file"},
  {"task_date":"2026-10-30","type":"general","title":"Codex: portfolio sahifangiz","body":"Kompyuterda Codexʼni oching va kechagi “AI-ishlarim” papkasini tanlang. Yozing: “Shu papkadagi rasm va videolarimdan bir sahifali portfolio sayt yarat: ismim, 3 ta xizmatim, ishlar galereyasi va Telegram orqali bogʻlanish tugmasi; telefonda ham chiroyli koʻrinsin.” Saytni brauzerda ochib, sizga yoqmagan bitta joyini ikkinchi prompt bilan tuzating (saytga telefon raqamingizni yozmang). Kompyuter boʻlmasa, shu soʻrovni ChatGPT chatiga yuboring va natijani Canvas Preview orqali koʻring.","learn_line":"Nimani oʻrganasiz: Codex yordamida oʻz fayllaringizdan ishlaydigan sahifa yaratishni — mijozlarga koʻrsatadigan portfolio sahifangizning tayyor fayli qoʻlingizda boʻladi.","submit_hint":"Topshirish: brauzerda ochilgan portfolio sahifangiz skrinshoti (galereya va bogʻlanish tugmasi koʻrinsin; API kalit va token koʻrinmasin).","accepts":["text","photo","document"],"requires":[{"any":["photo","image_doc"],"min":1,"label":"screenshot"}],"min_duration_sec":null,"minutes":20,"points":null,"check_rubric":"A screenshot of a rendered one-page portfolio website in a browser or ChatGPT Canvas Preview with a name/title, services, a gallery of images (the student's AI works, or placeholders in the Canvas fallback) and a contact/Telegram button. Reject a screenshot of raw code only or an unrelated website. Flag a visible phone number, API key, token or password.","requires_tag":null,"plan_ref":"W4D5","plan_format":"screenshot"},
  {"task_date":"2026-11-02","type":"general","title":"Xizmatingiz va 3 ta paket","body":"2–4-haftalarda eng yaxshi chiqqan ishingizni tanlang (mahsulot surati, rasm → video reklama yoki kontent yordamchi) va shu asosida xizmatingizni belgilang. ChatGPT yoki Claude Projectʼingizdan 3 ta paket tuzib berishni soʻrang — Start, Standart va Premium: har biriga nima kiradi (masalan, “3 xil yorugʻlikda 5 ta mahsulot surati”), necha kunda tayyor boʻladi va narxi qancha (soʻmda). Har bir paketga oʻzingiz yaratgan bitta namunani biriktiring — mijozga aynan shuni koʻrsatasiz.","learn_line":"Nimani oʻrganasiz: koʻnikmani aniq natija, muddat va narxga ega mahsulotga aylantirishni — mijoz “nima qilasiz, narxi qancha?” deb soʻrasa, tayyor javobingiz boʻladi.","submit_hint":"Topshirish: 3 ta paketli narxnoma (har bir paketning tarkibi, muddati, narxi va namunasi bilan).","accepts":["text","photo","document"],"requires":[{"any":["text","photo","image_doc"],"min":1,"label":"text"}],"min_duration_sec":null,"minutes":15,"points":null,"check_rubric":"Text or a screenshot of a price list with 3 packages (e.g. Start/Standart/Premium) for an AI service aimed at a named niche, each with contents, delivery time, a price (so'm or another currency) and a reference to one of the student's own sample works. Reject empty or off-topic submissions, fewer than 3 packages, or a copy of the task text.","requires_tag":null,"plan_ref":"W5D1","plan_format":"text (or screenshot)"},
  {"task_date":"2026-11-03","type":"general","title":"Mijoz brifi: 7 ta savol","body":"Har bir buyurtma savoldan boshlanadi: mijoz nimani xohlashini aniq bilmasangiz, ishni qayta-qayta oʻzgartirishga toʻgʻri keladi. Projectʼingizdan xizmatingiz uchun 7 savoldan iborat brif tuzishni soʻrang: mahsulot, auditoriya, format (4:5 yoki 9:16), kayfiyat va yorugʻlik, namunalar, muddat va qayerda ishlatilishi. Savollarni oʻzingizga moslang va Telegramʼda yuborishga tayyor xabar yoki Google Forms koʻrinishiga keltiring.","learn_line":"Nimani oʻrganasiz: mijoz javoblarini retseptlaringizga bogʻlashni — “iliq, kechki kayfiyat” degan javob darhol golden hour retseptiga aylanadi va tuzatishlar kamayadi.","submit_hint":"Topshirish: 7 savollik brif (matn, skrinshot yoki Google Forms havolasi).","accepts":["text","photo","document","link"],"requires":[{"any":["text","photo","image_doc","link"],"min":1,"label":"text"}],"min_duration_sec":null,"minutes":15,"points":null,"check_rubric":"A client brief with about 7 questions (text, screenshot or a Google Forms link) covering items such as product, audience, format/aspect ratio, mood/lighting, references, deadline and where it will be used, adapted to the student's service. Reject fewer than 5 questions, a generic text unrelated to image/video/content services, or a copy of the task text.","requires_tag":null,"plan_ref":"W5D2","plan_format":"text, screenshot or link"},
  {"task_date":"2026-11-04","type":"instagram","title":"Portfolio karusel: haqiqiy ishlaringiz","body":"2–4-haftadagi eng yaxshi 4–5 ta ishingizni bitta karuselga jamlang: birinchi slaydga eng kuchli “oldin → keyin” juftligini qoʻying va bitta videoni ham qoʻshing. Captionʼda har bir slayd qaysi xizmatga tegishli ekanini, 1-kundagi paketlardan birini va “Buyurtma uchun Directʼga yozing” chaqirigʻini yozing. Postni Instagramʼga joylang va @aicreators.studentsʼni belgilang.","learn_line":"Nimani oʻrganasiz: tarqoq mashqlarni mijoz olib keladigan portfolioga aylantirishni — 5-kundagi xabarlaringizda aynan shu post havolasini yuborasiz.","submit_hint":"Topshirish: username koʻrinib turgan post skrinshoti + post havolasi.","accepts":["text","photo","document","link"],"requires":[{"any":["photo","image_doc"],"min":1,"label":"screenshot"},{"any":["ig_link"],"min":1,"label":"ig_link"}],"min_duration_sec":null,"minutes":20,"points":null,"check_rubric":"Screenshot of an Instagram carousel with the student's username visible, showing AI-made work (images and/or video), a caption that names the services, a package or price and a call to action (e.g. DM to order), with @aicreators.students tagged or mentioned; plus a valid instagram.com/p/ link. Reject a story without a post link, a missing tag, or no visible username.","requires_tag":true,"plan_ref":"W5D3","plan_format":"Instagram carousel: screenshot + link"},
  {"task_date":"2026-11-05","type":"general","title":"30 soniyalik ovozli taklif","body":"ChatGPTʼning ovozli rejimini (Voice) yoqing va unga yoʻnalishingizdagi biznes egasi rolini bering: u xizmatingizni tinglab, 2 ta eʼtiroz bildirsin (masalan, “qimmat” yoki “AI rasm sunʼiy koʻrinadi”), siz esa javob berib mashq qiling. Keyin 30–60 soniyalik ovozli xabar yozib oling: kimsiz, qanday xizmat taklif qilasiz, kimlar uchun, paketingiz narxi va siz bilan qanday bogʻlanish mumkin. Misol sifatida portfolio postingizdagi bitta natijani tilga oling.","learn_line":"Nimani oʻrganasiz: oʻzingizni 30 soniyada taqdim etishni va eng koʻp uchraydigan 2 ta eʼtirozga javob berishni — buni mijoz bilan qoʻngʻiroqda yoki ovozli xabarda darhol ishlatasiz.","submit_hint":"Topshirish: 30–60 soniyalik ovozli xabar yoki dumaloq video xabar.","accepts":["text","voice","video_note","audio"],"requires":[{"any":["voice","video_note","audio"],"min":1,"label":"voice"}],"min_duration_sec":20,"minutes":15,"points":null,"check_rubric":"A voice message or round video note of roughly 20-90 seconds spoken by the student (Uzbek, Russian or English) whose transcript mentions (1) an AI service they offer, (2) who it is for, (3) a price or package and (4) how to contact/order. Reject silence, music only, text-only submissions, or content unrelated to offering a service. Delivery quality is not graded.","requires_tag":null,"plan_ref":"W5D4","plan_format":"voice (or round video note)"},
  {"task_date":"2026-11-06","type":"general","title":"Birinchi 3 ta taklifni yuboring","body":"Instagram yoki Telegramʼda yoʻnalishingizdagi 3 ta biznes sahifasini toping va ularning rasm yoki videolarini qanday yaxshilash mumkinligini aniqlang (masalan, “suratlaringiz qorongʻi — yumshoq yorugʻlikda mahsulot ancha jozibali koʻrinadi”). Har biriga alohida qisqa xabar yozib yuboring: samimiy maqtov, bitta aniq gʻoya, portfolio postingiz havolasi va bepul namuna taklifi. Faqat biznes sahifalariga yozing, spam qilmang: javob kelmasa ham, boshlaganingizning oʻzi katta qadam.","learn_line":"Nimani oʻrganasiz: shablon emas, aniq biznesga moslangan xabar yozishni — har hafta 3 ta shunday xabar yuborish mijoz topishdagi asosiy odatingizga aylanadi.","submit_hint":"Topshirish: 3 ta biznesga yuborilgan xabarlar skrinshoti (qabul qiluvchi nomini yashirsangiz boʻladi).","accepts":["text","photo","document"],"requires":[{"any":["photo","image_doc"],"min":1,"label":"screenshot"}],"min_duration_sec":null,"minutes":20,"points":null,"check_rubric":"Screenshot(s) showing at least 3 direct messages actually sent (not drafts) on Instagram or Telegram to 3 different accounts, each with a specific improvement idea, a link or reference to the student's portfolio and a free-sample offer. Recipient names may be blurred. Reject a ChatGPT chat only, the same screenshot repeated, or fewer than 3 sent messages.","requires_tag":null,"plan_ref":"W5D5","plan_format":"screenshot (up to 3)"}
]$seed$::jsonb;
  -- ▲ SEED ITEMS ▲
  _done timestamptz;
  _dates date[];
  _refs text[];
  _it jsonb;
  _n int;
  _i int;
  _ref text;
  _date date;
  _row public.challenge_tasks;
  _ctx record;
  _problem text;
  _len int;
  _len_final int;
  _max_len int := 0;
  _max_len_final int := 0;
  _prior int;
  _id bigint;
  _created bigint[] := '{}';
  _skipped jsonb := '[]'::jsonb;
  _live record;
  _before jsonb;
  _after jsonb;
  _cfg jsonb;
  _today date;
  _approved_any boolean;
  _tests jsonb := '{}'::jsonb;
  _bad text[] := '{}';
  _d date;
  _due jsonb;
  _chk jsonb;
  _h jsonb;
  _c jsonb;
  _g jsonb;
  _latent text[] := '{}';
  _work jsonb;
  _ai jsonb;
begin
  -- ═══════════════════════════════ 0. Prerequisites (read-only) ═══════════════════════════════
  if to_regprocedure('public.challenge_tasks_config()') is null
     or to_regprocedure('public.challenge_task_requires_problem(text, jsonb, text[])') is null
     or to_regprocedure('public.challenge_task_render_post(public.challenge_tasks)') is null
     or to_regprocedure('public.challenge_task_render_post_text(text, text, text, text, text, integer, integer, integer, integer, date, text)') is null
     or to_regprocedure('public.challenge_task_post_context(public.challenge_tasks)') is null
     or to_regprocedure('public.challenge_task_post_length(text)') is null
     or to_regprocedure('public.challenge_task_is_task_day(uuid, date, jsonb)') is null
     or to_regprocedure('public.challenge_task_local_date(timestamptz)') is null
     or to_regprocedure('public.challenge_task_topics()') is null
     or to_regprocedure('public.challenge_tasks_health(timestamptz)') is null then
    raise exception 'ABORT: Daily Tasks PR-2 (20260930122010) and PR-3 (20260930150020) must be applied first';
  end if;
  if to_regprocedure('public.challenge_tasks_worker_due(jsonb)') is null or to_regprocedure('public.challenge_tasks_tick()') is null then
    raise exception 'ABORT: Daily Tasks PR-5 (20260930152010, the tick) must be applied first';
  end if;
  if to_regprocedure('public.challenge_task_check_due()') is null or to_regprocedure('public.challenge_task_check_kick()') is null then
    raise exception 'ABORT: Daily Tasks PR-6 (20260930151010, the AI check) must be applied first';
  end if;
  if (select count(*) from cron.job
       where active and jobname in ('challenge-tasks-tick', 'challenge-task-check-kick', 'challenge-tasks-reconcile',
                                    'challenge-tasks-watchdog')) <> 4 then
    raise exception 'ABORT: a daily-tasks cron job (tick / check kick / reconcile / watchdog) is missing or inactive -- switching on would do nothing, or run unwatched';
  end if;
  if not exists (select 1 from public.courses where id = _course and title = 'AI CREATORS CHALLENGE 6.0') then
    raise exception 'ABORT: course % (AI CREATORS CHALLENGE 6.0) not found or renamed', _course;
  end if;
  if jsonb_typeof((select value from public.platform_settings where key = 'challenge_tasks')) is distinct from 'object' then
    raise exception 'ABORT: platform_settings.challenge_tasks is missing or not an object';
  end if;
  if not exists (select 1 from public.platform_settings ps, jsonb_array_elements_text(
                   case when jsonb_typeof(ps.value->'course_ids') = 'array' then ps.value->'course_ids' else '[]'::jsonb end) x
                  where ps.key = 'challenge' and x = _course::text) then
    raise exception 'ABORT: the 6.0 course is not in platform_settings.challenge.course_ids -- its tasks could never be approved';
  end if;
  -- The seed literal was generated for THESE importer inputs; different live defaults would change what the importer
  -- stores (points is written only when it differs from the configured default) -> regenerate instead.
  _cfg := public.challenge_tasks_config();
  if _cfg->'points' is distinct from '{"general": 5, "instagram": 8}'::jsonb or _cfg->'task_weekdays' is distinct from '[1, 2, 3, 4, 5]'::jsonb then
    raise exception 'ABORT: challenge_tasks points % / task_weekdays % are not the importer inputs this seed was generated for ({general 5, instagram 8}, [1..5]) -- regenerate it (scripts/gen-daily-tasks-seed.mjs)',
      _cfg->'points', _cfg->'task_weekdays';
  end if;

  -- ═══ replay: the marker means this already ran -- change nothing (no re-seed, no re-switch) ═══
  select a.created_at into _done from public.admin_actions a where a.action = 'challenge_tasks_went_live' order by a.created_at limit 1;
  if _done is not null then
    raise notice 'challenge_tasks went live at % (admin_actions challenge_tasks_went_live) -- replay changes nothing', _done;
    return;
  end if;
  perform pg_advisory_xact_lock(hashtext('challenge_tasks_import:' || _course::text));   -- the importer's lock: one calendar writer

  -- ═══════════════════════════════ 1. The seed ═══════════════════════════════
  -- 1a. shape: 25 items in plan order, item i = week (i / 5) + 1, day (i % 5) + 1, on the i-th weekday from 2026-10-05
  select array_agg(d::date order by d) into _dates
    from generate_series(_first::timestamp, _last::timestamp, interval '1 day') d
   where extract(isodow from d) between 1 and 5;
  _refs := array(select 'W' || (i / 5 + 1)::text || 'D' || (i % 5 + 1)::text from generate_series(0, 24) i order by i);
  if jsonb_typeof(_items) <> 'array' or jsonb_array_length(_items) <> 25 or cardinality(_dates) <> 25 then
    raise exception 'ABORT: the seed must hold 25 items for 25 weekdays (items %, weekdays %)', jsonb_array_length(_items), cardinality(_dates);
  end if;
  for _i in 1 .. 25 loop
    _it := _items -> (_i - 1);
    if (_it->>'plan_ref') is distinct from _refs[_i] or (_it->>'task_date') is distinct from _dates[_i]::text then
      raise exception 'ABORT: seed item % is % on %, expected % on %', _i, _it->>'plan_ref', _it->>'task_date', _refs[_i], _dates[_i];
    end if;
  end loop;

  -- 1b. EVERY row passes the approve guard's rules 3 and 4 before anything is inserted
  _prior := (select count(*)::int from public.challenge_tasks t where t.course_id = _course and t.status = 'approved' and t.task_date < _first);
  for _i in 1 .. 25 loop
    _it := _items -> (_i - 1);
    _row := jsonb_populate_record(null::public.challenge_tasks, jsonb_build_object(
      'course_id', _course, 'task_date', _it->>'task_date', 'type', _it->>'type', 'title', _it->>'title', 'body', _it->>'body',
      'learn_line', nullif(btrim(coalesce(_it->>'learn_line', '')), ''), 'submit_hint', nullif(btrim(coalesce(_it->>'submit_hint', '')), ''),
      'accepts', _it->'accepts', 'requires', coalesce(_it->'requires', '[]'::jsonb),
      'min_text_chars', _it->'min_text_chars', 'min_duration_sec', _it->'min_duration_sec', 'minutes', _it->'minutes',
      'points', _it->'points', 'check_rubric', nullif(btrim(coalesce(_it->>'check_rubric', '')), ''),
      'requires_tag', _it->'requires_tag', 'status', 'draft', 'source', 'import', 'plan_ref', _it->>'plan_ref',
      'plan_format', nullif(btrim(coalesce(_it->>'plan_format', '')), '')));
    _problem := public.challenge_task_requires_problem(_row.type, _row.requires, _row.accepts);
    if _problem is not null then
      raise exception 'ABORT: seed % (%): %', _row.plan_ref, _row.task_date, _problem;
    end if;
    _len := public.challenge_task_post_length(public.challenge_task_render_post(_row));
    select * into _ctx from public.challenge_task_post_context(_row);
    _len_final := public.challenge_task_post_length(public.challenge_task_render_post_text(
      _row.type, _row.title, _row.body, _row.learn_line, _row.submit_hint, _row.minutes, _ctx.points, _ctx.late_points,
      _prior + _i, _row.task_date, _ctx.tag_handle));
    if _len > 4000 or _len_final > 4000 then
      raise exception 'ABORT: seed % (%) renders % / % characters (> 4000)', _row.plan_ref, _row.task_date, _len, _len_final;
    end if;
    _max_len := greatest(_max_len, _len);
    _max_len_final := greatest(_max_len_final, _len_final);
  end loop;

  -- 1c. insert, the importer's way (admin_challenge_tasks_import: same skips, same column expressions, drafts only)
  for _it, _n in select e.value, e.n from jsonb_array_elements(_items) with ordinality e(value, n) order by e.n loop
    _ref := nullif(btrim(coalesce(_it->>'plan_ref', '')), '');
    _date := (_it->>'task_date')::date;
    if _ref is not null and exists (select 1 from public.challenge_tasks t
                                     where t.course_id = _course and t.plan_ref = _ref and t.status <> 'cancelled') then
      _skipped := _skipped || jsonb_build_object('plan_ref', _ref, 'task_date', _date, 'reason', 'plan_ref_exists');
      continue;
    end if;
    if exists (select 1 from public.challenge_tasks t
                where t.course_id = _course and t.task_date = _date and t.status <> 'cancelled') then
      _skipped := _skipped || jsonb_build_object('plan_ref', _ref, 'task_date', _date, 'reason', 'date_taken');
      continue;
    end if;
    insert into public.challenge_tasks (course_id, task_date, type, title, body, learn_line, submit_hint, accepts, requires,
                                        min_text_chars, min_duration_sec, minutes, points, check_rubric, requires_tag,
                                        status, source, plan_ref, plan_format)
    values (_course, _date, _it->>'type', _it->>'title', _it->>'body',
            nullif(btrim(coalesce(_it->>'learn_line', '')), ''), nullif(btrim(coalesce(_it->>'submit_hint', '')), ''),
            array(select jsonb_array_elements_text(_it->'accepts')),
            coalesce(_it->'requires', '[]'::jsonb),
            (_it->>'min_text_chars')::int, (_it->>'min_duration_sec')::int, (_it->>'minutes')::int, (_it->>'points')::int,
            nullif(btrim(coalesce(_it->>'check_rubric', '')), ''), (_it->>'requires_tag')::boolean,
            'draft', 'import', _ref, nullif(btrim(coalesce(_it->>'plan_format', '')), ''))
    returning id into _id;
    _created := _created || _id;
  end loop;

  -- 1d. the calendar IS the plan: one live DRAFT per date with that date's plan_ref, 0 approved, no plan_ref elsewhere
  for _i in 1 .. 25 loop
    select count(*)::int as n, min(t.status) as status, min(t.plan_ref) as plan_ref into _live
      from public.challenge_tasks t
     where t.course_id = _course and t.task_date = _dates[_i] and t.status <> 'cancelled';
    if _live.n <> 1 or _live.status is distinct from 'draft' or _live.plan_ref is distinct from _refs[_i] then
      raise exception 'ABORT: % should hold one draft % -- found % live task(s), status %, plan_ref %',
        _dates[_i], _refs[_i], _live.n, _live.status, _live.plan_ref;
    end if;
  end loop;
  if (select count(*) from public.challenge_tasks t
       where t.course_id = _course and t.status = 'approved' and t.task_date between _first and _last) <> 0 then
    raise exception 'ABORT: an approved task sits on a seeded plan date';
  end if;
  if (select count(*) from public.challenge_tasks t
       where t.course_id = _course and t.status <> 'cancelled' and t.plan_ref = any(_refs)) <> 25 then
    raise exception 'ABORT: a plan_ref (W1D1..W5D5) is also live on a date outside the plan calendar';
  end if;

  -- ═══════════════════════════════ 2. Switch on ═══════════════════════════════
  select ps.value into _before from public.platform_settings ps where ps.key = 'challenge_tasks' for update;
  update public.platform_settings
     set value = value || jsonb_build_object('enabled', true, 'ai', true, 'miniapp', true), updated_at = now()
   where key = 'challenge_tasks';
  select ps.value into _after from public.platform_settings ps where ps.key = 'challenge_tasks';
  if _after->'enabled' is distinct from 'true'::jsonb or _after->'ai' is distinct from 'true'::jsonb
     or _after->'miniapp' is distinct from 'true'::jsonb
     or (_after - 'enabled' - 'ai' - 'miniapp') is distinct from (_before - 'enabled' - 'ai' - 'miniapp') then
    raise exception 'ABORT: the switch did not land as a pure 3-key merge: %', _after;
  end if;

  -- ═══════════════════════════════ 3. Self-tests (read-only) ═══════════════════════════════
  _cfg := public.challenge_tasks_config();
  _today := public.challenge_task_local_date(now());
  -- (a) the parsed config: live, and nothing the watchdog would call invalid
  if coalesce((_cfg->>'active')::boolean, false) is not true then
    _bad := _bad || ('not_active: challenge.enabled ' || coalesce(_cfg->>'challenge_enabled', 'null') || ', win_bad ' || coalesce(_cfg->>'win_bad', 'null'));
  end if;
  if (_cfg->>'enabled')::boolean is not true or (_cfg->>'ai')::boolean is not true or (_cfg->>'miniapp')::boolean is not true then
    _bad := _bad || ('flags: ' || jsonb_build_object('enabled', _cfg->'enabled', 'ai', _cfg->'ai', 'miniapp', _cfg->'miniapp')::text);
  end if;
  if jsonb_typeof(_cfg->'miniapp_link') is distinct from 'null' then
    _bad := _bad || ('miniapp_link: ' || (_cfg->'miniapp_link')::text);
  end if;
  if jsonb_array_length(coalesce(_cfg->'invalid', '[]'::jsonb)) > 0 then
    _bad := _bad || ('config_invalid: ' || (_cfg->'invalid')::text);
  end if;
  if coalesce((_cfg->>'ai_daily_budget_usd')::numeric, 0) <= 0 then
    _bad := _bad || ('ai_daily_budget_usd: ' || coalesce(_cfg->>'ai_daily_budget_usd', 'null'));
  end if;
  _tests := _tests || jsonb_build_object('config', 'asserted');

  -- (b) task days. Expected FALSE for every date that has no approved task of the course on or before it (drafts
  --     never make a task day); a date after an approved one is legitimately a task day and is skipped.
  _n := 0;
  for _d in select g::date from generate_series(date '2026-10-01', _first, interval '1 day') g loop
    if exists (select 1 from public.challenge_tasks t where t.course_id = _course and t.status = 'approved' and t.task_date <= _d) then
      continue;
    end if;
    _n := _n + 1;
    if public.challenge_task_is_task_day(_course, _d, _cfg) then
      _bad := _bad || ('is_task_day(' || _d || ') is true with no approved task on or before it');
    end if;
  end loop;
  _tests := _tests || jsonb_build_object('is_task_day_false', jsonb_build_object('asserted_dates', _n, 'of', (_first - date '2026-10-01') + 1));

  -- (c) today's work, read with the tick's own filters, and the kick decisions
  _approved_any := exists (select 1 from public.challenge_tasks t
                            where t.status = 'approved' and t.course_id in (select g.course_id from public.challenge_task_topics() g));
  _work := jsonb_build_object(
    'posts_to_queue', (select count(*) from public.challenge_task_topics() g
                         join public.challenge_tasks t on t.course_id = g.course_id and t.task_date = _today and t.status = 'approved'),
    'dm_tasks_open', (select count(*) from public.challenge_tasks t
                        where t.status = 'approved' and t.task_date between _today - coalesce((_cfg->>'late_days')::int, 2) and _today
                          and t.course_id in (select g.course_id from public.challenge_task_topics() g)),
    'no_task_today', (select count(*) from (select g.course_id from public.challenge_task_topics() g group by g.course_id
                                            having bool_or(not g.is_test)) c
                       where public.challenge_task_is_task_day(c.course_id, _today, _cfg)
                         and not exists (select 1 from public.challenge_tasks t
                                          where t.course_id = c.course_id and t.task_date = _today and t.status = 'approved')),
    'tomorrow_alert', (select count(*) from (select g.course_id from public.challenge_task_topics() g group by g.course_id
                                             having bool_or(not g.is_test)) c
                        where public.challenge_task_is_task_day(c.course_id, _today + 1, _cfg)
                          and not exists (select 1 from public.challenge_tasks t
                                           where t.course_id = c.course_id and t.task_date = _today + 1 and t.status = 'approved')));
  _due := public.challenge_tasks_worker_due(_cfg);
  _chk := public.challenge_task_check_due();
  if not _approved_any then
    if (_work->>'posts_to_queue')::int <> 0 or (_work->>'dm_tasks_open')::int <> 0 or (_work->>'no_task_today')::int <> 0
       or (_work->>'tomorrow_alert')::int <> 0 then
      _bad := _bad || ('tick_work_today: ' || _work::text);
    end if;
    if _due->>'state' is distinct from 'active' or coalesce((_due->>'posts')::int, -1) <> 0
       or coalesce((_due->>'receipts')::int, -1) <> 0 or coalesce((_due->>'dms')::int, -1) <> 0 then
      _bad := _bad || ('worker_due: ' || _due::text);
    end if;
    if _chk->>'state' is distinct from 'idle' or coalesce((_chk->>'due')::int, -1) <> 0 then
      _bad := _bad || ('check_due: ' || _chk::text);
    end if;
    _tests := _tests || jsonb_build_object('today_work', 'asserted', 'worker_due', 'asserted', 'check_due', 'asserted');
  else
    _tests := _tests || jsonb_build_object('today_work', 'skipped: an approved task exists', 'worker_due', 'skipped: an approved task exists',
                                           'check_due', 'skipped: an approved task exists');
  end if;

  -- (d) the engine health: no alarm the SWITCH causes; every other live condition recorded as latent
  _h := public.challenge_tasks_health(now());
  if (_h#>>'{state,active}')::boolean is not true then
    _bad := _bad || 'health: state.active is not true'::text;
  end if;
  if jsonb_array_length(coalesce(_h#>'{state,config_invalid}', '[]'::jsonb)) > 0 then
    _bad := _bad || ('health: config_invalid ' || (_h#>'{state,config_invalid}')::text);
  end if;
  if coalesce((_h#>>'{checks,oldest_min}')::numeric, 0) > 90 or coalesce((_h#>>'{checks,stuck_attempts}')::int, 0) > 0 then
    _bad := _bad || ('health: checks_stuck with ai on ' || coalesce((_h->'checks')::text, 'null'));
  end if;
  if not _approved_any then
    for _c in select value from jsonb_array_elements(coalesce(_h#>'{today,courses}', '[]'::jsonb)) loop
      if coalesce((_c->>'is_task_day')::boolean, false) or coalesce((_c->>'tomorrow_is_task_day')::boolean, false) then
        _bad := _bad || ('health: calendar alarm for course ' || (_c->>'course_id'));
      end if;
    end loop;
    _tests := _tests || jsonb_build_object('health_calendar', 'asserted');
  else
    _tests := _tests || jsonb_build_object('health_calendar', 'skipped: an approved task exists');
  end if;
  -- latent: the watchdog conditions (same thresholds) that do not depend on this switch
  if (_h#>>'{state,last_reconcile_at}') is null or (_h#>>'{state,last_reconcile_at}')::timestamptz < now() - interval '40 minutes' then
    _latent := _latent || 'reconciler_silent'::text;
  end if;
  if coalesce((_h#>>'{retry,pending_60}')::int, 0) >= 5 then _latent := _latent || 'retry_pending'::text; end if;
  if coalesce((_h#>>'{retry,unknown_sender_stuck_2h}')::int, 0) >= 3 then _latent := _latent || 'unknown_senders'::text; end if;
  if coalesce((_h#>>'{held_24h,today}')::int, 0) >= 1 then _latent := _latent || 'held_senders'::text; end if;
  if coalesce((_h->>'username_match_unlinked_2h_old')::int, 0) > 0 then _latent := _latent || 'username_unlinked'::text; end if;
  if coalesce((_h->>'topic_missing_24h')::int, 0) > 0 then _latent := _latent || 'topic_missing'::text; end if;
  if coalesce((_h->>'misplaced_homework_autotag_24h')::int, 0) >= 5 then _latent := _latent || 'misplaced_homework'::text; end if;
  if coalesce((_h#>>'{invariants,awards_after_freeze_7d}')::int, 0) > 0 then _latent := _latent || 'awards_after_freeze'::text; end if;
  if coalesce((_h#>>'{invariants,ledger_drift}')::int, 0) > 0 or coalesce((_h#>>'{invariants,streak_awards_without_xp}')::int, 0) > 0
     or coalesce((_h#>>'{invariants,streak_awards_excess}')::int, 0) > 0 or coalesce((_h#>>'{invariants,topic_points_leak_24h}')::int, 0) > 0
     or coalesce((_h#>>'{invariants,live_duplicates}')::int, 0) > 0 then
    _latent := _latent || 'invariant'::text;
  end if;
  for _g in select value from jsonb_array_elements(coalesce(_h->'groups', '[]'::jsonb)) loop
    if _g#>>'{bot_status,status}' is not null and _g#>>'{bot_status,status}' <> 'administrator' then
      _latent := _latent || ('bot_status:' || (_g->>'chat_id'));
    end if;
  end loop;
  if cardinality(_latent) > 0 then
    raise notice 'challenge_tasks go-live: pre-existing conditions the watchdog will now report (not caused by the switch): %',
      array_to_string(_latent, ', ');
  end if;

  if cardinality(_bad) > 0 then
    raise exception 'ABORT: daily-tasks go-live self-test failed: %', array_to_string(_bad, ' | ');
  end if;

  -- evidence for ai = true (recorded, never printed as a secret: statuses and timestamps only)
  _ai := jsonb_build_object(
    'qa_judge_last', (select jsonb_build_object('status', a.details->>'status', 'at', a.created_at) from public.admin_actions a
                       where a.action = 'challenge_qa_judge_run' order by a.created_at desc limit 1),
    'qa_judge_ok_24h', (select count(*) from public.admin_actions a
                         where a.action = 'challenge_qa_judge_run' and a.created_at >= now() - interval '24 hours'
                           and a.details->>'status' = 'ok'),
    'no_provider_7d', (select count(*) from public.admin_actions a
                        where a.action in ('challenge_qa_no_provider', 'challenge_task_check_no_provider')
                          and a.created_at >= now() - interval '7 days'),
    'auth_failed_7d', (select count(*) from public.admin_actions a
                        where a.action in ('challenge_qa_provider_auth_failed', 'challenge_task_check_provider_auth_failed')
                          and a.created_at >= now() - interval '7 days'));
  if coalesce((_ai->>'qa_judge_ok_24h')::int, 0) = 0 or coalesce((_ai->>'no_provider_7d')::int, 0) > 0
     or coalesce((_ai->>'auth_failed_7d')::int, 0) > 0 then
    raise notice 'challenge_tasks go-live: an AI provider key is NOT evidenced (qa-judge %): ai = true will hold checks until one is set',
      _ai::text;
  end if;

  -- ═══════════════════════════════ 4. Audit once ═══════════════════════════════
  if cardinality(_created) > 0 then
    insert into public.admin_actions (actor_user_id, action, details)
    values (null, 'challenge_tasks_imported', jsonb_build_object(
      'course_id', _course, 'items', jsonb_array_length(_items), 'created', cardinality(_created),
      'created_ids', to_jsonb(_created), 'skipped', _skipped, 'via', _file));
  end if;
  insert into public.admin_actions (actor_user_id, action, details)
  values (null, 'challenge_tasks_went_live', jsonb_build_object(
    'migration', _file, 'course_id', _course,
    'seed', jsonb_build_object('created', cardinality(_created), 'skipped', _skipped, 'first', _first, 'last', _last,
                               'max_post_length', _max_len, 'max_post_length_final_day_no', _max_len_final),
    'config', jsonb_build_object('enabled', _cfg->'enabled', 'active', _cfg->'active', 'ai', _cfg->'ai', 'miniapp', _cfg->'miniapp',
                                 'miniapp_link', _cfg->'miniapp_link', 'miniapp_onboarding', _cfg->'miniapp_onboarding',
                                 'post', _cfg->'post', 'dm', _cfg->'dm', 'remind', _cfg->'remind', 'summary', _cfg->'summary',
                                 'receipts', _cfg->'receipts', 'ai_daily_budget_usd', _cfg->'ai_daily_budget_usd'),
    'previous', jsonb_build_object('enabled', _before->'enabled', 'ai', _before->'ai', 'miniapp', _before->'miniapp'),
    'self_test', _tests,
    'observed', jsonb_build_object('today', _today, 'tick_work_today', _work, 'worker_due', _due, 'check_due', _chk),
    'latent', to_jsonb(_latent),
    'ai_provider_evidence', _ai,
    'at', now()));
end
$go_live$;
