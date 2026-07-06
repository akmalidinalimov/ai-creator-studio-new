-- Editable badge DM captions ("Batch texts" admin section).
-- notify-badge-award reads these at send time (service role bypasses RLS).
-- Each badge has a tailored praise paragraph; the special code '__share__' is
-- the shared "why share + tags" block appended to every card caption.
-- {{name}} is replaced with the student's first name at send time.

create table if not exists public.badge_messages (
  code       text primary key,
  body_uz    text not null,
  updated_at timestamptz not null default now(),
  updated_by uuid
);

alter table public.badge_messages enable row level security;

drop policy if exists "badge_messages admin read"   on public.badge_messages;
drop policy if exists "badge_messages admin insert" on public.badge_messages;
drop policy if exists "badge_messages admin update" on public.badge_messages;

create policy "badge_messages admin read" on public.badge_messages
  for select to authenticated using (has_role(auth.uid(), 'admin'::app_role));
create policy "badge_messages admin insert" on public.badge_messages
  for insert to authenticated with check (has_role(auth.uid(), 'admin'::app_role));
create policy "badge_messages admin update" on public.badge_messages
  for update to authenticated
  using (has_role(auth.uid(), 'admin'::app_role))
  with check (has_role(auth.uid(), 'admin'::app_role));

-- keep updated_at fresh
create or replace function public.touch_badge_messages()
returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists trg_touch_badge_messages on public.badge_messages;
create trigger trg_touch_badge_messages before update on public.badge_messages
  for each row execute function public.touch_badge_messages();

-- ---- Seed defaults (motivational, casual Uzbek, emoji-rich) ----
insert into public.badge_messages (code, body_uz) values
('__share__', $md$📲 Endi navbat — bu g'alabani dunyoga ko'rsatishga!

Ushbu rasmni Instagram Story'ngizga joylang. Nega? Chunki siz kelajak kasbini — sun'iy intellektni o'rganyapsiz, va bu bilan faxrlanishga to'liq haqingiz bor! 🌍 Sizning bitta postingiz kimningdir «men ham boshlayapman» deyishiga turtki bo'ladi. 🔥

Story'da bizni belgilang 👉 @aicreators.students va @shahlo.alikhanova — biz eng zo'r story'larni o'z sahifamizda qayta ulashamiz va sizni butun jamoaga tanitamiz! 💛$md$),

('first_lesson', $md$🚀 {{name}}, tabriklaymiz — birinchi darsni tamomladingiz! Eng qiyini nima bilasizmi? Boshlash. Ko'pchilik shuni ham uddalay olmaydi, lekin siz qildingiz. Bugun siz shunchaki bir dars ko'rmadingiz — o'zingizga «men eplayman» dedingiz. Bu — katta gap. Zo'r ketyapsiz, shu ruhda davom eting! 💪$md$),

('first_homework', $md$✍️ {{name}}, birinchi vazifangizni topshirdingiz — endi siz tomoshabin emas, chinakam yaratuvchisiz! 🎨 Bilim olish — bir gap, uni ishlatib biror narsa yaratish — butunlay boshqa daraja. Siz o'sha darajaga qadam qo'ydingiz. O'zingiz bilan faxrlaning, bu chindan arziydi! 🙌$md$),

('five_lessons', $md$📚 {{name}}, 5 ta dars ortda qoldi — odat shakllanyapti! Bitta-ikkita dars hammaga oson, lekin 5 tasiga yetib kelish — bu izchillik, bu xarakter. Siz to'g'ri yo'ldasiz, natija endi uzoq emas. Shu tempni ushlab turing, {{name}}, siz zo'rsiz! 🔥$md$),

('ten_lessons', $md$🎯 {{name}}, 10 ta dars — bu 10 ta «ha» degan qaroringiz! Har safar dangasalikni yengib, o'rganishni tanladingiz. Oson emas edi, lekin siz uddaladingiz. Endi siz haqiqiy o'rganuvchisiz — va bu kelajakda sizga katta imkoniyatlar ochadi. Zo'r ish! ⭐$md$),

('module_complete', $md$🎓 {{name}}, butun bir modulni tamomladingiz — bu jiddiy yutuq! Bir nechta dars emas, to'liq bir bosqichni oxiriga yetkazdingiz. Bilimingiz endi mustahkam va sertifikatga ham loyiqsiz. Bunday izchillik har kimda ham bo'lavermaydi — {{name}}, siz alohidasiz! 🏅$md$),

('streak_3', $md$🔥 {{name}}, 3 kun ketma-ket! Odat aynan shunday — kichik, ammo kunlik qadamlardan tug'iladi. Uch kun to'xtamay o'rgandingiz, demak allaqachon ko'pchilikdan oldindasiz. Endi to'xtamang — eng qizig'i endi boshlanadi! 💪$md$),

('streak_7', $md$🔥 {{name}}, bir hafta — bir kun ham qoldirmay! Buni har kim uddalay olmaydi. Bir haftalik izchillik tasodif emas — bu sizning xarakteringiz. Siz o'zingizga har kuni «davom etaman» dedingiz va so'zingizda turdingiz. Bu bilan chin dildan faxrlaning! 👏$md$),

('streak_14', $md$🔥 {{name}}, 14 kun uzluksiz — bu endi shunchaki odat emas, bu SIZ! Ikki hafta har kuni o'zingiz ustingizda ishlash — bunga faqat kuchli odamlar qodir. Siz o'sha odamlardansiz, {{name}}. Bu natija bilan o'zingizni maqtashga to'liq haqingiz bor! 🌟$md$),

('streak_30', $md$👑 {{name}}, 30 kun ketma-ket?! Siz o'rganuvchilarning eng zo'r 1% ichidasiz! Bir oy davomida har kuni, hech to'xtamay — bunday sabr chempionlarda bo'ladi. Bu allaqachon oddiy o'qish emas, bu turmush tarzi. {{name}}, siz haqiqiy namunasiz! 🏆$md$),

('streak_60', $md$👑 {{name}}, 60 kun — ikki oy uzluksiz! Buni so'z bilan ta'riflash qiyin. Bunday izchillikka ega odamlar barmoq bilan sanarli. Siz shunchaki o'rganmayapsiz — o'zingizni butunlay o'zgartiryapsiz. Shu darajaga chiqqaningiz bilan chin dildan tabriklaymiz! 🔥$md$),

('streak_100', $md$👑 {{name}}, 100 KUN! Bu — afsona! 🎉 Uch oydan ko'proq, har kuni, hech qachon to'xtamay. Minglab odam boshlaydi, ammo shu yergacha yetib kelganlar — sanoqli. Siz o'sha sanoqlilardansiz. {{name}}, siz bizning haqiqiy g'ururimizsiz! 👑✨$md$),

('course_complete', $md$🎓 {{name}}, KURSNI TAMOMLADINGIZ! 🎉 Boshlab, oxirigacha yetkazgan odam — bu butunlay boshqa toifa inson, va bugun siz o'shasiz! Siz sun'iy intellektni noldan o'rgandingiz va endi uni ishda qo'llay olasiz. Bu — hayotingizni o'zgartiradigan yutuq. AI Creators bitiruvchisi sifatida sizni chin dildan tabriklaymiz! 🏆💛$md$)
on conflict (code) do nothing;
