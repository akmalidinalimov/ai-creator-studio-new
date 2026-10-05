-- Challenge 6.0: every extra task is an Instagram publication — a post (carousel) or a Reels (owner, 2026-10-05:
-- "every single task should be either instagram post, instagram stories or reels").
--
-- The 12 draft tasks (Mon/Wed/Fri 10-07 .. 11-02, 20261005194500) become type 'instagram': the work is published on
-- the student's Instagram with @aicreators.students tagged, and submitted as a screenshot (username visible) + the
-- post / Reels link — the same requirements, checker and points (config points.instagram = 8) as the existing
-- Instagram tasks (#10 #12 #15 #18 #23 were already Instagram). Each body ends with what to publish and what the
-- caption says; the 📸 tag line is added by the post layout.
--
-- STORIES are NOT offered yet, on purpose: challenge_task_classify() only recognises instagram.com/(p|reel|reels|tv)
-- links (a stories link would never satisfy ig_link, so the submission would wait in needs_more forever), and the AI
-- check is written for post / Reels screenshots. Stories need their own engine + checker change first.
--
-- check_rubric (what the AI checker grades against) is rewritten for every task whose deliverable changed, in the
-- style of the existing Instagram rubrics; points reset to NULL = the config's Instagram value (8).
--
-- Safe: only DRAFT, never-posted course-6.0 tasks are touched (asserted); the caption must still fit under the image
-- (visible UTF-16 length <= 1000; a task over it posts as text and is listed in the audit row); replay-safe (marker).

do $$
declare
  _course constant uuid := 'f502f631-2104-4834-b6c2-702cd3080e27';
  _accepts constant text[] := array['text', 'photo', 'document', 'link'];
  _requires constant jsonb := '[{"any": ["photo", "image_doc"], "min": 1, "label": "screenshot"}, {"any": ["ig_link"], "min": 1, "label": "ig_link"}]';
  _hint_post constant text := 'Topshirish: username koʻrinib turgan post skrinshoti + post havolasi.';
  _hint_reels constant text := 'Topshirish: username koʻrinib turgan Reels skrinshoti + Reels havolasi.';
  _hint_any constant text := 'Topshirish: username koʻrinib turgan post yoki Reels skrinshoti + uning havolasi.';
  _r record;
  _txt text;
  _len int;
  _no_image jsonb := '[]'::jsonb;
begin
  if exists (select 1 from public.admin_actions where action = 'challenge_tasks_all_instagram' and details->>'marker' = '20261005204000') then
    raise notice 'already applied';
    return;
  end if;
  if exists (select 1 from public.challenge_tasks t
              where t.id in (6, 10, 26, 11, 12, 15, 16, 17, 18, 21, 23, 25)
                and (t.course_id <> _course or t.status <> 'draft')) then
    raise exception 'ABORT: a task to convert is not a course-6.0 draft';
  end if;
  if exists (select 1 from public.challenge_task_posts p
              where p.task_id in (6, 10, 26, 11, 12, 15, 16, 17, 18, 21, 23, 25) and p.state in ('sent', 'sent_via_sql', 'manual'))
     or exists (select 1 from public.challenge_task_submissions s
              where s.task_id in (6, 10, 26, 11, 12, 15, 16, 17, 18, 21, 23, 25) and s.status in ('needs_more', 'checking', 'accepted')) then
    raise exception 'ABORT: a task to convert was posted or has live submissions';
  end if;

  if public.challenge_task_requires_problem('instagram', _requires, _accepts) is not null then
    raise exception 'ABORT: the Instagram requirements are invalid: %', public.challenge_task_requires_problem('instagram', _requires, _accepts);
  end if;

  for _r in
    select * from (values
      (6::bigint, 'Yorugʻlik mashqi: 3 rasmli karusel',
       E'1️⃣ Bitta sahna tanlang: odam portreti (masalan, nonvoyxonadagi nonvoy) yoki mahsulotingiz.\n'
       || E'2️⃣ Bitta promptni bitta vositada (Higgsfield, Syntx, ChatGPT yoki Nano Banana) 3 marta ishlating — faqat yorugʻlik qismini almashtiring: golden hour side light · soft window light · neon night light.\n'
       || '3️⃣ 3 ta rasmni karusel qilib Instagramʼga joylang. Captionʼga 3 ta yorugʻlik promptini va qaysi biri eng real chiqqanini yozing.',
       _hint_post,
       'Screenshot of an Instagram carousel with the student''s username visible and @aicreators.students tagged or mentioned, showing the same subject/scene in three images with visibly different lighting, and a caption with the three lighting prompts (or lighting phrases) and which one looked most real; plus a valid instagram.com/p/ link. Reject a story without a post link, a missing tag, no visible username, fewer than 3 images, or a subject that changes between images. Quality is not graded; watermarks are fine.'),
      (10, null, null, _hint_post,
       'Screenshot of an Instagram carousel with the student''s username visible, showing a real phone photo of an object and an AI-restaged ad version of the same object (same shape/label), with @aicreators.students tagged or mentioned and the prompt used in the caption; plus a valid instagram.com/p/ link. Reject if the link is missing, the tag is absent, the username is not visible, or the two images show different products.'),
      (26, 'Brend qahramoni: personaj karuseli',
       E'1️⃣ Brendingiz uchun bitta doimiy qahramon oʻylab toping (masalan, kafe uchun «barista Aziz»).\n'
       || E'2️⃣ Higgsfield, Syntx yoki Nano Bananaʼda uning personaj varaqasini yarating: old, yon va orqa koʻrinish + 2–3 xil yuz ifodasi.\n'
       || E'3️⃣ Varaqni reference qilib, qahramonni 2 xil sahnaga joylashtiring — yuzi va kiyimi oʻzgarmasin.\n'
       || '4️⃣ Varaq + 2 sahnani karusel qilib Instagramʼga joylang, captionʼda qahramoningizni tanishtiring.',
       _hint_post,
       'Screenshot of an Instagram carousel with the student''s username visible and @aicreators.students tagged or mentioned, showing a character sheet (one character from several angles and/or expressions) and the same character (same face, hair and outfit) in at least two different scenes, with a caption introducing the character; plus a valid instagram.com/p/ link. Reject a story without a post link, a missing tag, no visible username, a missing character sheet, or a face or outfit that clearly changes. Quality is not graded strictly; watermarks are fine.'),
      (11, null,
       E'1️⃣ Darsdagi formula boʻyicha video prompt yozing: kim/nima + nima qilyapti + kamera harakati + joy va yorugʻlik + uslub (masalan, «5 seconds, realistic, cinematic»).\n'
       || E'2️⃣ Seedance, Kling yoki Omni Flashʼda (qaysi birida bepul kredit boʻlsa) bitta 5 soniyalik video yarating — koʻpi bilan 2 ta urinish yetadi.\n'
       || '3️⃣ Videoni Reels qilib Instagramʼga joylang, captionʼga promptingizni qismlarga ajratib yozing.',
       _hint_reels,
       'Screenshot of an Instagram Reel with the student''s username visible and @aicreators.students tagged or mentioned, showing an AI-generated video (not a stock clip or a still image), with the video prompt in the caption split into parts (subject, action, camera movement, environment/light, style/duration - at least 4 of them); plus a valid instagram.com/reel/ or /p/ link. Reject a story without a post link, a missing tag, no visible username, or a caption without the split prompt. Watermarks are fine.'),
      (12, null, null, _hint_reels,
       null),
      (15, null, null, _hint_reels,
       null),
      (16, 'Kontent yordamchi va birinchi post',
       E'1️⃣ claude.aiʼda (bepul akkaunt yetadi) «Kontent yordamchim» Projectʼini yarating: Instructionsʼga brendingiz, auditoriyangiz va ohangingizni yozing, Knowledgeʼga Retseptlar kitobingizni yuklang (parol va telefon raqamini qoʻshmang).\n'
       || E'2️⃣ Soʻrang: «Keyingi hafta uchun 5 ta post gʻoyasi va captionini tuz».\n'
       || '3️⃣ Birinchi gʻoyani rasm bilan post qilib Instagramʼga joylang — captionni oʻz soʻzlaringiz bilan tahrirlang.',
       _hint_post,
       'Screenshot of a published Instagram post with the student''s username visible and @aicreators.students tagged or mentioned, showing an image and a caption that reads as a real post for the student''s brand or niche (prepared with their Claude Project); plus a valid instagram.com/p/ link. Reject a story without a post link, a missing tag, no visible username, or an empty or placeholder caption. Flag a visible phone number, address, email or password.'),
      (17, null,
       E'Skill — Claudeʼga bir marta oʻrgatiladigan va istalgan chatda ishlaydigan usul.\n'
       || E'1️⃣ Claudeʼga yozing: «Menga skill yarat: men mahsulot nomini yozaman, sen mening formulam boʻyicha 1 ta rasm prompti va 1 ta 5 soniyalik video prompti berasan.»\n'
       || E'2️⃣ Skillʼni yangi chatda sinab koʻring va chiqqan promptlar bilan rasm yoki video yarating.\n'
       || '3️⃣ Natijani post yoki Reels qilib Instagramʼga joylang, captionʼga «Prompt: Claude skill» deb yozing.',
       _hint_any,
       'Screenshot of a published Instagram post or Reel with the student''s username visible and @aicreators.students tagged or mentioned, showing an AI-generated image or video, with a caption that mentions the Claude skill (e.g. ''Prompt: Claude skill''); plus a valid instagram.com/p/ or /reel/ link. Reject a story without a post link, a missing tag, or no visible username.'),
      (18, null, null, _hint_post,
       null),
      (21, 'Xizmatingiz va 3 ta paket: narxlar karuseli',
       E'1️⃣ Eng yaxshi chiqqan ishingiz asosida xizmatingizni belgilang (mahsulot surati, rasm → video reklama yoki kontent yordami).\n'
       || E'2️⃣ ChatGPT yoki Claude Projectʼingizdan 3 ta paket soʻrang — Start, Standart, Premium: nima kiradi, necha kunda tayyor boʻladi, narxi (soʻmda).\n'
       || '3️⃣ Har bir paketga namuna ishingiz bilan bitta slayd qiling va karuselni Instagramʼga joylang. Captionʼda: «Buyurtma uchun Directʼga yozing».',
       _hint_post,
       'Screenshot of an Instagram carousel with the student''s username visible and @aicreators.students tagged or mentioned, presenting an AI service with 3 packages (e.g. Start/Standart/Premium) - contents, delivery time and a price for each - illustrated with the student''s own sample work, and a call to action (e.g. DM to order); plus a valid instagram.com/p/ link. Reject a story without a post link, a missing tag, no visible username, or fewer than 3 packages.'),
      (23, null, null, _hint_post,
       null),
      (25, 'Birinchi mijozlar: 3 ta taklif va namuna',
       E'1️⃣ Instagram yoki Telegramʼda yoʻnalishingizdagi 3 ta biznes sahifasini toping va har biriga qisqa taklif yozing: samimiy maqtov, bitta aniq gʻoya, portfolio postingiz havolasi va bepul namuna taklifi.\n'
       || E'2️⃣ Bittasi uchun bepul namuna tayyorlang (rasm yoki 5 soniyalik video).\n'
       || '3️⃣ «Oldin → keyin» namunani post yoki Reels qilib Instagramʼga joylang, captionʼda xizmatingiz va «Directʼga yozing» boʻlsin.',
       _hint_any,
       'Screenshot of a published Instagram post or Reel with the student''s username visible and @aicreators.students tagged or mentioned, showing a before -> after sample made with AI, and a caption that names the student''s service with a call to action (e.g. DM to order); plus a valid instagram.com/p/ or /reel/ link. Reject a story without a post link, a missing tag, or no visible username. The outreach messages themselves are not graded.')
    ) v(id, title, body, hint, rubric)
  loop
    update public.challenge_tasks
       set type = 'instagram', accepts = _accepts, requires = _requires, requires_tag = true,
           title = coalesce(_r.title, title), body = coalesce(_r.body, body), submit_hint = _r.hint,
           check_rubric = coalesce(_r.rubric, check_rubric), points = null,   -- points: config instagram (8)
           min_text_chars = null, min_duration_sec = null
     where id = _r.id and course_id = _course and status = 'draft';
    if not found then
      raise exception 'ABORT: task #% was not updated', _r.id;
    end if;
    -- what Telegram counts for a caption: the VISIBLE text, in UTF-16 units
    select replace(replace(replace(regexp_replace(public.challenge_task_render_post(t), '<[^>]*>', '', 'g'),
                                   '&lt;', '<'), '&gt;', '>'), '&amp;', '&')
      into _txt from public.challenge_tasks t where t.id = _r.id;
    _len := char_length(_txt) + (select count(*)::int from regexp_split_to_table(_txt, '') c where ascii(c) > 65535);
    if _len > 1000 then
      update public.challenge_tasks set image_url = null where id = _r.id;
      _no_image := _no_image || jsonb_build_object('task_id', _r.id, 'caption_len', _len);
    end if;
  end loop;

  insert into public.admin_actions (actor_user_id, action, details)
  values (null, 'challenge_tasks_all_instagram', jsonb_build_object(
    'marker', '20261005204000', 'tasks', jsonb_build_array(6, 10, 26, 11, 12, 15, 16, 17, 18, 21, 23, 25),
    'formats', 'post / carousel / Reels (stories not yet supported by the checker)',
    'posted_as_text_caption_too_long', _no_image, 'at', now()));
end $$;
