-- More descriptive caption openings: name the accomplishment concretely (learned
-- AI, practiced, built skills) so the student feels & understands it — not just a
-- bare stat. Share opener changed to "Bu yutug'ingizni dunyo bilan bo'lishing!".
-- (Still editable in Admin > Batch matnlar.)

update public.badge_messages set body_uz = $md$📲 Bu yutug'ingizni dunyo bilan bo'lishing! Rasmni Instagram Story'ga qo'ying — siz AI'ni o'rganyapsiz, faxrlaning! 🌍
Bizni belgilang: @aicreators.students va @shahlo.alikhanova — sizni qayta ulashamiz! 💛$md$ where code = '__share__';

update public.badge_messages set body_uz = $md$🚀 {{name}}, birinchi darsni tamomlab, AI dunyosiga ilk qadamingizni qo'ydingiz! Eng qiyini — boshlash edi, siz uddaladingiz. Zo'r start! 💪$md$ where code = 'first_lesson';
update public.badge_messages set body_uz = $md$✍️ {{name}}, birinchi vazifani topshirib, AI'ni amalda qo'lladingiz! Endi siz tomoshabin emas — yaratuvchisiz. Zo'r ish! 🙌$md$ where code = 'first_homework';
update public.badge_messages set body_uz = $md$📚 {{name}}, 5 ta darsda AI'ni o'rganib, amaliyot qildingiz! Odat shakllanyapti, to'g'ri yo'ldasiz. Shu tempda! 🔥$md$ where code = 'five_lessons';
update public.badge_messages set body_uz = $md$🎯 {{name}}, 10 ta darsni tamomlab, AI ko'nikmalaringizni mustahkamladingiz! Endi siz haqiqiy o'rganuvchisiz. Zo'r! ⭐$md$ where code = 'ten_lessons';
update public.badge_messages set body_uz = $md$🎓 {{name}}, butun modulni tamomlab, yangi AI ko'nikmasini egalladingiz! Bilimingiz mustahkam — alohidasiz! 🏅$md$ where code = 'module_complete';
update public.badge_messages set body_uz = $md$🔥 {{name}}, 3 kun to'xtovsiz AI'ni o'rgandingiz! Odat shakllanyapti — endi to'xtamang! 💪$md$ where code = 'streak_3';
update public.badge_messages set body_uz = $md$🔥 {{name}}, 7 kun to'xtovsiz AI'ni o'rgandingiz, amaliyot qildingiz! Bu tasodif emas — bu xarakter. Faxrlaning! 👏$md$ where code = 'streak_7';
update public.badge_messages set body_uz = $md$🔥 {{name}}, 14 kun uzluksiz AI'ni o'rganib, ko'nikmangizni oshirdingiz! Bu endi odat emas — bu SIZ. Kuchlisiz! 🌟$md$ where code = 'streak_14';
update public.badge_messages set body_uz = $md$👑 {{name}}, 30 kun to'xtovsiz AI'ni o'rgandingiz — eng zo'r 1% ichidasiz! Bunday sabr chempionlarda bo'ladi! 🏆$md$ where code = 'streak_30';
update public.badge_messages set body_uz = $md$👑 {{name}}, 60 kun — ikki oy uzluksiz AI'ni o'rgandingiz! Bunday izchillik kamdan-kam. Tabriklaymiz! 🔥$md$ where code = 'streak_60';
update public.badge_messages set body_uz = $md$👑 {{name}}, 100 KUN to'xtovsiz AI'ni o'rgandingiz — bu afsona! 🎉 Shu yergacha yetganlar sanoqli. Siz g'ururimizsiz! ✨$md$ where code = 'streak_100';
update public.badge_messages set body_uz = $md$🎓 {{name}}, kursni tamomlab, AI'ni noldan o'rgandingiz va amaliyotchi bo'ldingiz! 🎉 Bu — hayotni o'zgartiradigan yutuq. Tabriklaymiz! 🏆$md$ where code = 'course_complete';
