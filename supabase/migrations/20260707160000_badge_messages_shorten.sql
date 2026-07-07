-- Shorten badge DM captions to ~half length: punchier, less to read over the
-- image, but keeps the praise + pride + share tags. (Still editable in Admin >
-- Batch matnlar.) Only updates rows that still hold the original seeded text is
-- not enforced — this intentionally resets to the new shorter defaults.

update public.badge_messages set body_uz = $md$📲 Buni dunyoga ko'rsating! Rasmni Instagram Story'ga qo'ying — siz AI'ni o'rganyapsiz, faxrlaning! 🌍
Bizni belgilang: @aicreators.students va @shahlo.alikhanova — sizni qayta ulashamiz! 💛$md$ where code = '__share__';

update public.badge_messages set body_uz = $md$🚀 {{name}}, birinchi dars tamom! Eng qiyini — boshlash edi, siz uddaladingiz. Zo'r start! 💪$md$ where code = 'first_lesson';
update public.badge_messages set body_uz = $md$✍️ {{name}}, birinchi vazifa topshirildi! Endi siz tomoshabin emas — yaratuvchisiz. Zo'r ish! 🙌$md$ where code = 'first_homework';
update public.badge_messages set body_uz = $md$📚 {{name}}, 5 dars tamom — odat shakllanyapti! To'g'ri yo'ldasiz, shu tempda! 🔥$md$ where code = 'five_lessons';
update public.badge_messages set body_uz = $md$🎯 {{name}}, 10 dars! Har biri — bir «ha». Endi siz haqiqiy o'rganuvchisiz. Zo'r! ⭐$md$ where code = 'ten_lessons';
update public.badge_messages set body_uz = $md$🎓 {{name}}, modul tamom! Butun bosqichni yakunladingiz — bilimingiz mustahkam. Alohidasiz! 🏅$md$ where code = 'module_complete';
update public.badge_messages set body_uz = $md$🔥 {{name}}, 3 kun ketma-ket! Odat shakllanyapti — endi to'xtamang! 💪$md$ where code = 'streak_3';
update public.badge_messages set body_uz = $md$🔥 {{name}}, 7 kun to'xtovsiz! Bu tasodif emas — bu xarakter. Faxrlaning! 👏$md$ where code = 'streak_7';
update public.badge_messages set body_uz = $md$🔥 {{name}}, 14 kun uzluksiz! Bu endi odat emas — bu SIZ. Kuchlisiz! 🌟$md$ where code = 'streak_14';
update public.badge_messages set body_uz = $md$👑 {{name}}, 30 kun! Siz eng zo'r 1% ichidasiz. Bunday sabr — chempionlarda! 🏆$md$ where code = 'streak_30';
update public.badge_messages set body_uz = $md$👑 {{name}}, 60 kun — ikki oy to'xtovsiz! Bunday izchillik kamdan-kam. Tabriklaymiz! 🔥$md$ where code = 'streak_60';
update public.badge_messages set body_uz = $md$👑 {{name}}, 100 KUN — afsona! 🎉 Shu yergacha yetganlar sanoqli. Siz g'ururimizsiz! ✨$md$ where code = 'streak_100';
update public.badge_messages set body_uz = $md$🎓 {{name}}, KURS TAMOM! 🎉 AI'ni noldan o'rgandingiz — hayotni o'zgartiradigan yutuq. Tabriklaymiz! 🏆$md$ where code = 'course_complete';
