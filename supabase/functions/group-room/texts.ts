// The student groups' morning / evening captions — hand-written, casual Uzbek, warm but not sugary. Pools rotate by
// the Tashkent day number (pick() from teacher-room), so two days in a row never read the same. Every caption is an
// image caption: Telegram allows 1,024 characters, and room.test.ts renders the longest combination to prove it fits.

export type Opener = { head: string; body: string };

export const MORNING_OPENERS: Opener[] = [
  { head: "☀️ Xayrli tong, ijodkorlar!", body: "Yangi kun — yangi imkoniyat. Bugun bitta kichik qadam ham ertangi katta natijaning boshlanishi boʻladi." },
  { head: "🌤 Assalomu alaykum, aziz guruh!", body: "Kofe tayyormi? ☕️ Bugun AI bilan nimadir yaratib, oʻzingizni hayratda qoldiring!" },
  { head: "🚀 Xayrli tong!", body: "Siz har kuni bir pogʻona yuqoriga koʻtarilyapsiz. Bugun ham shu yoʻlni birga davom ettiramiz!" },
  { head: "🌱 Tong muborak!", body: "Eng zoʻr ijodkorlar ham bir vaqtlar birinchi rasmini yaratgan. Bugun sizning navbatingiz 😉" },
  { head: "✨ Assalomu alaykum!", body: "Darsda koʻrgan narsangizni bugun qoʻlda sinab koʻrsangiz, u bir umr esingizda qoladi." },
  { head: "🌞 Xayrli tong, jamoa!", body: "Bugun nima yaratamiz? Rasmmi, videomi yoki yangi promptmi — tanlov sizda!" },
  { head: "💡 Xayrli tong!", body: "Gʻoya kutib turmaydi — uni bugun yarating. Mukammal boʻlishi shart emas, boshlash muhim." },
  { head: "🌸 Assalomu alaykum, ijodkorlar!", body: "Guruhimiz kundan-kunga kuchayib boryapti. Bugun ham bir-birimizga ilhom beramiz 🤝" },
  { head: "🔥 Xayrli tong!", body: "Kecha qilgan ishingizdan bir qadam oldinga oʻting. Bugungi versiyangiz kechagidan zoʻrroq chiqadi!" },
  { head: "🌅 Tong muborak, aziz guruh!", body: "AI — bu vosita, sehrgar esa sizsiz. Bugun shu sehrni ishga solamiz ✨" },
  { head: "🍀 Assalomu alaykum!", body: "Har bir yaratgan ishingiz — portfolioingizdagi yana bir sahifa. Bugun yangi sahifa ochamiz!" },
  { head: "🎯 Xayrli tong!", body: "Bugungi kichik maqsad: bitta ish yaratib, uni guruhda ulashish. Uddalaymiz-a? 😊" },
  { head: "☀️ Assalomu alaykum, jamoa!", body: "Siz bu yerga oʻrganish uchun keldingiz — va har kuni oʻrganyapsiz. Bu bilan faxrlaning!" },
  { head: "🌼 Xayrli tong, ijodkorlar!", body: "Bugun ham ilhom, amaliyot va yaxshi kayfiyat tilaymiz. Oldinga! 💪" },
];

/** An extra line on some weekdays (0 = Sunday … 6 = Saturday), under the greeting. */
export const WEEKDAY_LINES: Record<number, string> = {
  1: "Yangi hafta muborak! 🎉",
  5: "Juma muborak! 🌿",
  6: "Shanba — amaliyot uchun eng zoʻr kun 🙌",
  0: "Yakshanba — erkin ijod kuni 🎨",
};

/** The suggested actions; three of them rotate into each morning post. */
export const ACTIONS: string[] = [
  "🎨 Bugun bitta yangi rasm yarating va shu yerda ulashing",
  "🎬 Qisqa video yaratib koʻring — hatto 5 soniyalik ham hisob",
  "📸 Eng yaxshi ishingizni Instagram'ga joylang — portfolio shunday boshlanadi",
  "🤝 Kursdoshingizning savoliga javob bering — oʻrgatgan odam ikki barobar oʻrganadi",
  "❓ Tushunmagan joyingizni «KURATORGA SAVOLLAR»da soʻrang — savol berish kuch belgisi",
  "📚 Bitta darsni koʻrib, oʻsha kuni amalda sinab koʻring",
  "✍️ Yangi prompt yozib, natijani kechagi bilan solishtiring",
  "💬 Birorta kursdoshingiz ishiga iliq izoh qoldiring",
  "📝 Uyga vazifangizni bugun topshiring — kurator kutib turibdi",
  "🧪 Bitta AI vositasida hali sinamagan funksiyani sinab koʻring",
  "🎞 Rasmlaringizdan bittasini videoga aylantirib koʻring",
  "🌟 Bugun yaratgan ishingizni guruhda «Mana mening ishim!» deb ulashing",
];

export const MORNING_CLOSINGS: string[] = [
  "Omad, ijodkorlar! Bugun sizdan zoʻr ishlar kutamiz 🚀",
  "Kun mazmunli va ilhomli oʻtsin! ✨",
  "Biz siz bilan faxrlanamiz — oldinga! 💪",
  "Ishlaringizni guruhda koʻrishni intiqlik bilan kutamiz 🤩",
  "Bugun ham birgamiz — omad! 🍀",
  "Kichik qadamlar — katta natijalar. Boshladik! 🔥",
  "Kayfiyatingiz chogʻ, ilhomingiz baland boʻlsin! ☀️",
];

/** A day with real activity. */
export const EVENING_OPENERS: Opener[] = [
  { head: "🌙 Xayrli kech, aziz guruh!", body: "Bugun ajoyib kun boʻldi — har biringizning mehnatingiz uchun katta rahmat!" },
  { head: "✨ Rahmat, ijodkorlar!", body: "Bugun yana bir pogʻona yuqoriga koʻtarildik. Siz bilan faxrlanamiz!" },
  { head: "🌟 Xayrli kech!", body: "Qanday zoʻr kun oʻtdi! Darslar, vazifalar, savollar — hammasi uchun rahmat 🙏" },
  { head: "💜 Assalomu alaykum, jamoa!", body: "Bugungi faolligingiz bizni juda xursand qildi. Shu ruhda davom etamiz!" },
  { head: "🌙 Rahmat, aziz guruh!", body: "Bugun har biringiz oʻz hissangizni qoʻshdingiz — shuning uchun guruhimiz kuchli." },
  { head: "🎉 Xayrli kech!", body: "Yana bir mazmunli kun ortda qoldi. Qilgan har bir ishingiz uchun rahmat!" },
  { head: "✨ Xayrli kech, ijodkorlar!", body: "Bugun koʻrgan ishlaringiz ilhomlantirdi. Siz haqiqiy ijodkorlarsiz!" },
];

/** A quiet day: still a thank-you, never "spectacular". */
export const QUIET_OPENERS: Opener[] = [
  { head: "🌙 Xayrli kech, aziz guruh!", body: "Bugun biroz sokin kun boʻldi — hammaga ham dam kerak 😊 Ertaga yangi kuch bilan davom etamiz!" },
  { head: "✨ Xayrli kech!", body: "Bugun kim dars koʻrgan, kim vazifa qilgan boʻlsa — rahmat! Ertaga yanada faolroq boʻlamiz 💪" },
  { head: "🌙 Rahmat, ijodkorlar!", body: "Har kuni ham shiddatli boʻlishi shart emas. Muhimi — toʻxtamaslik. Ertaga birga davom etamiz!" },
];

export const EVENING_CLOSINGS: string[] = [
  "Yaxshi dam oling — ertaga yana davom etamiz! 🌙",
  "Xayrli tun, ijodkorlar! Ertaga yangi gʻoyalar bilan uchrashamiz ✨",
  "Rahmat va xayrli tun! 💜",
  "Ertangi kun bugungidan ham zoʻr boʻladi — ishonamiz! 🚀",
  "Yaxshi dam oling, kuch toʻplang! 😊",
  "Siz bilan har kuni faxrlanamiz. Xayrli tun! 🌟",
  "Ertaga uchrashguncha! 🌙",
];
