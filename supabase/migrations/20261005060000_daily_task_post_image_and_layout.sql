-- The daily task post: a day image + a clean, structured caption (owner request, 2026-10-05).
--
-- WHY: the first post (2026-10-05) was one dense block — hard to read in Telegram. The owner asked for an image that
-- says the day ("2-KUN VAZIFASI") and a clear, paragraphed description with bold labels / quotes.
--
-- 1. challenge_tasks.image_url (nullable, https only). challenge-tasks-worker (same PR) posts a task that has one as
--    that PHOTO with the task as its caption — still one message, so replies and the recorded message id are
--    unchanged. A caption over Telegram's 1024 visible characters, or a photo Telegram refuses, falls back to the old
--    text post and leaves a DB-visible row. The images are the website's static files
--    public/challenge/days/day-<N>.jpg (same PR).
-- 2. challenge_task_render_post_text(): the layout. Pinned to the reviewed live text (md5 3bf9889b…), replaced whole
--    (an IMMUTABLE sql function; same signature, volatility and search_path; CREATE OR REPLACE keeps owner + ACL):
--        📅 2-KUN VAZIFASI · 6-oktabr, seshanba
--        🎯 Title
--        (blank)
--        the task body — numbered steps
--        (blank)
--        📎 Topshirish: …            (a leading "Topshirish:" in the field is not repeated)
--        ▌💡 Nimani oʻrganasiz: …    (a quote block; a leading "Nimani oʻrganasiz:" is not repeated)
--        📸 Postda @aicreators.students ni belgilang.   (Instagram tasks)
--        (blank)
--        ⏱ ~15 daqiqa · 🏆 +5 ball — bugun 23:59 gacha
--        ⌛ 1–2 kun kechiksa: +3 ball
--        📍 Faqat shu «KUNLIK VAZIFALAR» topigiga yuboring.
--    Every user text is still HTML-escaped; only <b>, <blockquote> and the three entities are produced. The approve
--    guard keeps measuring this same text.
-- 3. The seven approved tasks of 2026-10-06 … 10-13 get their body / learn line / submit hint rewritten as short
--    numbered steps (wording only: type, points, date, rubric and requirements are untouched; each row pinned by id,
--    date and title), and their day image (day number = challenge_task_post_context().day_no, the same number the
--    post header shows). Each resulting post is asserted to fit a photo caption.
-- Replay-safe.

alter table public.challenge_tasks add column if not exists image_url text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'challenge_tasks_image_url_check') then
    alter table public.challenge_tasks add constraint challenge_tasks_image_url_check
      check (image_url is null or (image_url ~ '^https://[^[:space:]]+$' and char_length(image_url) <= 500));
  end if;
end $$;
comment on column public.challenge_tasks.image_url is
  'The day image the task is posted with (a photo with the task as caption); NULL = a text post. 20261005060000.';

-- 2. the layout ---------------------------------------------------------------------------------------------------
do $$
declare
  _md5 text;
begin
  select md5(replace(prosrc, E'\r', '')) into _md5 from pg_proc
   where oid = to_regprocedure('public.challenge_task_render_post_text(text, text, text, text, text, integer, integer, integer, integer, date, text)');
  if _md5 is null then
    raise exception 'ABORT: challenge_task_render_post_text(...) is missing';
  end if;
  if _md5 <> '3bf9889b5f6ca7b4af6ebe6d15e154b6' and not exists (
       select 1 from pg_proc where proname = 'challenge_task_render_post_text' and prosrc like '%KUN VAZIFASI%') then
    raise exception 'ABORT: challenge_task_render_post_text is not the reviewed live text (md5 %)', _md5;
  end if;
end $$;

create or replace function public.challenge_task_render_post_text(_type text, _title text, _body text, _learn text, _hint text,
  _minutes integer, _points integer, _late_points integer, _day_no integer, _task_date date, _tag_handle text)
returns text
language sql
immutable
set search_path to 'public'
as $function$
  -- The daily task post as Telegram HTML (parse_mode HTML), the 2026-10-05 layout (20261005060000): a bold day header,
  -- the title, the body, then labelled sections, separated by blank lines. Pure: every input is an argument. Only <b>,
  -- <blockquote> and the three entities &amp; &lt; &gt; are produced; every user text is escaped. challenge_tasks_guard
  -- measures THIS text (<= 4000, G29); the worker posts it as a photo caption when it fits 1024 visible characters.
  with e as (
    select replace(replace(replace(btrim(coalesce(_title, ''), E' \t\r\n'), '&', '&amp;'), '<', '&lt;'), '>', '&gt;') as title,
           replace(replace(replace(btrim(replace(coalesce(_body, ''), E'\r', ''), E' \t\r\n'), '&', '&amp;'), '<', '&lt;'), '>', '&gt;') as body,
           nullif(replace(replace(replace(btrim(regexp_replace(replace(coalesce(_learn, ''), E'\r', ''), '^[[:space:]]*Nimani[[:space:]]+o.?rganasiz[[:space:]]*:[[:space:]]*', '', 'i'), E' \t\r\n'), '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '') as learn,
           nullif(replace(replace(replace(btrim(regexp_replace(replace(coalesce(_hint, ''), E'\r', ''), '^[[:space:]]*Topshirish[[:space:]]*:[[:space:]]*', '', 'i'), E' \t\r\n'), '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '') as hint,
           nullif(replace(replace(replace(btrim(coalesce(_tag_handle, ''), E' \t\r\n@'), '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '') as tag
  )
  select concat_ws(E'\n',
           '📅 <b>' || coalesce(_day_no::text || '-KUN VAZIFASI', 'KUNLIK VAZIFA') || '</b>'
             || coalesce(' · ' || extract(day from _task_date)::int::text || '-'
                  || (array['yanvar','fevral','mart','aprel','may','iyun','iyul','avgust','sentabr','oktabr','noyabr','dekabr'])[extract(month from _task_date)::int]
                  || ', ' || (array['dushanba','seshanba','chorshanba','payshanba','juma','shanba','yakshanba'])[extract(isodow from _task_date)::int], ''),
           '🎯 <b>' || e.title || '</b>',
           '',
           e.body,
           '',
           case when e.hint is not null then '📎 <b>Topshirish:</b> ' || e.hint end,
           case when e.learn is not null then '<blockquote>💡 <b>Nimani oʻrganasiz:</b> ' || e.learn || '</blockquote>' end,
           case when _type = 'instagram' then '📸 Postda <b>@' || coalesce(e.tag, 'aicreators.students') || '</b> ni belgilang.' end,
           '',
           case when _minutes is not null then '⏱ ~' || _minutes::text || ' daqiqa · ' else '' end
             || '🏆 <b>+' || coalesce(_points, 0)::text || ' ball</b> — bugun 23:59 gacha',
           '⌛ 1–2 kun kechiksa: <b>+' || coalesce(_late_points, 0)::text || ' ball</b>',
           '📍 Faqat shu <b>«KUNLIK VAZIFALAR»</b> topigiga yuboring.')
    from e
$function$;

-- 3. the seven upcoming tasks: numbered steps + their day image ---------------------------------------------------
do $$
declare
  _course constant uuid := 'f502f631-2104-4834-b6c2-702cd3080e27';
  _r record;
  _len int;
  _day int;
begin
  for _r in
    select * from (values
      (4::bigint, date '2026-10-06', 'Work rejimi: raqobatchilar jadvali',
       E'1️⃣ ChatGPTʼda «Work» rejimini yoqing.\n'
       || E'2️⃣ Unga shu vazifani bering:\n'
       || E'«Sohamdagi 5 ta kuchli Instagram akkaunt yoki raqobatchini top va jadval qil: nomi, havolasi, kontent turi, eng yaxshi ishlaydigan post formati va men undan nimani olishim mumkin. Natijani .xlsx fayl qilib ber.»\n'
       || E'3️⃣ Work oʻzi reja tuzib ishlaydi — biroz kuting.\n\n'
       || 'Hisobingizda Work boʻlmasa — oddiy chatda Search (web qidiruv) bilan bajaring.',
       'koʻp bosqichli izlanishni AIʼga topshirib, tayyor jadval olishni.',
       'Topshirish: tayyor jadval (.xlsx fayl yoki skrinshot) — 5 ta qator, har birida havola.'),
      (6, date '2026-10-07', 'Yorugʻlik mashqi: 1 sahna, 3 xil yorugʻlik',
       E'1️⃣ Bitta sahna tanlang: odam portreti (masalan, nonvoyxonadagi nonvoy) yoki mahsulotingiz.\n'
       || E'2️⃣ Bitta promptni bitta vositada (Higgsfield, Syntx, ChatGPT yoki Nano Banana) 3 marta ishlating — har safar faqat yorugʻlik qismini almashtiring:\n'
       || E'• golden hour side light\n• soft window light\n• hard midday sun yoki neon night light\n'
       || '3️⃣ Qaysi yorugʻlikda rasm eng real chiqqanini aniqlang va 3 ta retseptni Retseptlar kitobingizga yozing.',
       'yorugʻlik soʻzlari rasmni qanchalik real qilishini — 3 ta sinalgan yorugʻlik retseptingiz boʻladi.',
       'Topshirish: 3 ta rasm + 3 ta prompt (faqat yorugʻlik soʻzlari farq qiladi).'),
      (8, date '2026-10-08', 'Obyektiv va fon: 35mm yoki 85mm',
       E'1️⃣ Kechagi sahnalaringizdan birini oling.\n'
       || E'2️⃣ 2 ta rasm yarating — promptning qolgan qismi soʻzma-soʻz bir xil qolsin:\n'
       || E'• 35mm lens, f/8, everything in sharp focus\n• 85mm lens, f/1.8, shallow depth of field, blurred background\n'
       || '3️⃣ Qaysi biri mahsulot yoki portretga, qaysi biri joy yoki interyerga mosligini bir gapda yozing va ikkala retseptni kitobingizga qoʻshing.',
       'fonni xiralashtirib obyektni ajratish (85mm) va butun joyni aniq koʻrsatish (35mm) — 2 ta tayyor retsept.',
       'Topshirish: 2 ta rasm + 2 ta prompt + qaysi biri qayerga mosligi haqida 1 gap.'),
      (7, date '2026-10-09', 'Kamera burchagi: 4 rasmli karusel',
       E'1️⃣ Bitta mahsulot yoki qahramon uchun asosiy prompt yozing va unga «eye level, medium shot» qoʻshing.\n'
       || E'2️⃣ Shu promptdan yana 3 ta rasm yarating — faqat burchakni almashtiring:\n'
       || E'• low angle\n• high angle, top-down\n• close-up\n'
       || '3️⃣ 4 ta rasmni karusel qilib Instagramʼga joylang. Captionʼga asosiy promptni va har bir rasmning burchak nomini yozing.',
       'burchak kadr maʼnosini oʻzgartiradi: low angle — kuch, top-down — taom va mahsulot, close-up — tafsilot.',
       'Topshirish: username koʻrinib turgan post skrinshoti + post havolasi.'),
      (9, date '2026-10-10', 'Plastik koʻrinishdan haqiqiy suratga',
       E'1️⃣ Shu haftadagi rasmlaringizdan eng sunʼiy koʻrinadiganini tanlang (silliq «plastik» teri, haddan tashqari yorqin ranglar).\n'
       || E'2️⃣ Promptga faqat shu realizm qatorini qoʻshib, rasmni qayta yarating:\n'
       || E'«natural skin texture with visible pores, small imperfections, fabric wrinkles, natural colour grade, subtle film grain, candid photo»\n'
       || '3️⃣ Ikki rasmni solishtiring va shu qatorni Retseptlar kitobingizga yozing.',
       'AI rasmidagi plastik koʻrinishni yoʻqotadigan realizm qatorini — endi uni har bir mijoz rasmiga qoʻshasiz.',
       'Topshirish: «oldin» va «keyin» rasmlari + promptga qoʻshilgan realizm qatori.'),
      (10, date '2026-10-12', 'Telefon suratidan reklama suratiga',
       E'1️⃣ Uydagi buyumni (krujka, atir, krossovka yoki oʻz mahsulotingiz) telefonda suratga oling.\n'
       || E'2️⃣ Uni ChatGPT yoki Nano Bananaʼga yuklang. Promptga eng yaxshi yorugʻlik, burchak va obyektiv retseptlaringizni qoʻshing va yozing: «shakli, rangi va yozuvlarini oʻzgartirma».\n'
       || '3️⃣ «Telefon surati → AI reklama» karuselini Instagramʼga joylang. Captionʼda ishlatgan 3 ta retseptingizni yozing.',
       'haqiqiy mahsulotni oʻzgartirmasdan reklama sahnasiga joylash — mijozlar eng koʻp soʻraydigan xizmat.',
       'Topshirish: username koʻrinib turgan post skrinshoti + post havolasi.'),
      (26, date '2026-10-13', 'Personaj varaqasi: bitta qahramon, 2 ta sahna',
       E'1️⃣ Brendingiz uchun bitta doimiy qahramon oʻylab toping (masalan, kafe uchun «barista Aziz»).\n'
       || E'2️⃣ Higgsfield, Syntx yoki Nano Bananaʼda uning personaj varaqasini yarating: old, yon va orqa koʻrinish + 2–3 xil yuz ifodasi bitta rasmda.\n'
       || E'3️⃣ Shu varaqni reference qilib, qahramonni 2 xil sahnaga joylashtiring — yuzi va kiyimi oʻzgarmasin.\n'
       || '4️⃣ Yuz oʻzgarib qolsa, darsdagi tuzatish usulini qoʻllang.',
       'bitta qahramonni har xil sahnada bir xil saqlash — brend maskoti yoki seriyali kontent uchun.',
       'Topshirish: personaj varaqasi + qahramon tushgan 2 ta sahna rasmi + ishlatgan promptingiz.')
    ) v(id, d, title, body, learn, hint)
  loop
    if not exists (select 1 from public.challenge_tasks t
                    where t.id = _r.id and t.course_id = _course and t.task_date = _r.d and t.title = _r.title
                      and t.status = 'approved') then
      raise exception 'ABORT: task #% is not the reviewed approved row (% / %)', _r.id, _r.d, _r.title;
    end if;
    if exists (select 1 from public.challenge_task_posts p where p.task_id = _r.id and p.state in ('sent', 'sent_via_sql', 'manual')) then
      raise exception 'ABORT: task #% was already posted', _r.id;
    end if;
    update public.challenge_tasks set body = _r.body, learn_line = _r.learn, submit_hint = _r.hint where id = _r.id;
    select c.day_no into _day from public.challenge_tasks t, lateral public.challenge_task_post_context(t) c where t.id = _r.id;
    update public.challenge_tasks
       set image_url = 'https://www.aicreator.academy/challenge/days/day-' || _day::text || '.jpg'
     where id = _r.id;
    -- the caption must fit: visible characters (tags out, entities in), with a margin for emoji (2 UTF-16 units)
    select char_length(replace(replace(replace(regexp_replace(public.challenge_task_render_post(t), '<[^>]*>', '', 'g'),
                                                '&lt;', '<'), '&gt;', '>'), '&amp;', '&'))
      into _len from public.challenge_tasks t where t.id = _r.id;
    if _len > 980 then
      raise exception 'ABORT: task #% post is % visible characters — too long for a photo caption (<= 980 kept as margin)', _r.id, _len;
    end if;
  end loop;

  insert into public.admin_actions (actor_user_id, action, details)
  values (null, 'challenge_task_post_layout', jsonb_build_object(
    'migration', '20261005060000', 'at', now(), 'tasks', jsonb_build_array(4, 6, 8, 7, 9, 10, 26),
    'image_base', 'https://www.aicreator.academy/challenge/days/'));
end $$;
