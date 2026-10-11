// «KURATORLAR 6.0» — the words. Hand-written, casual Uzbek, warm but not sugary. Each opener is a bold greeting line +
// a short paragraph; the pools rotate by the Tashkent day number, so two days in a row never open the same way (a
// 14-entry pool repeats after two weeks). Numbers and names are filled in by room.ts; nothing here judges a curator —
// a zero is shown plainly, never commented on.

export type Opener = { head: string; body: string };

export const MORNING_OPENERS: Opener[] = [
  { head: "☀️ Assalomu alaykum, aziz kuratorlar!", body: "Yana bir goʻzal kun boshlandi. Bugun ham oʻquvchilarimizning har bir savoli, har bir vazifasi — orzusi sari bir qadam. Keling, shu qadamlarni birga qoʻyamiz! 💪" },
  { head: "🌤 Xayrli tong, jamoa!", body: "Kofe tayyormi? ☕️ Bugun kimdir sizning bitta javobingiz tufayli AI'ni tushunib oladi — kunni shunday boshlash ajoyib emasmi?" },
  { head: "🌱 Xayrli tong!", body: "Har bir baholangan vazifa oʻquvchi uchun «men toʻgʻri yoʻldaman» degan signal. Bugun ham shu signalni koʻproq berib turamiz 🙌" },
  { head: "✨ Assalomu alaykum!", body: "Yangi kun — yangi savollar, yangi «aha!» lahzalar. Oʻquvchilarimiz sizga ishonadi, bu katta baxt." },
  { head: "🚀 Xayrli tong, ustozlar!", body: "Challenge davom etyapti, oʻquvchilar har kuni oʻsib boryapti. Ularning yonida boʻlganingiz uchun rahmat — bugun ham birgamiz!" },
  { head: "🌞 Tong muborak!", body: "Kichik eslatma: tez berilgan javob — oʻquvchi uchun eng katta motivatsiya. Bugun ham savollarni kutdirib qoʻymaymiz 😉" },
  { head: "🌸 Assalomu alaykum, jamoa!", body: "Kimdir bugun birinchi marta oʻzi yaratgan rasmini yuboradi — uni birinchi boʻlib siz koʻrasiz. Qanday yoqimli-a 🤩" },
  { head: "☀️ Xayrli tong!", body: "Bugun ham oʻquvchilarimizga «sen uddalaysan» deyishni unutmaylik. Bitta iliq soʻz baʼzan butun bir darsdan koʻproq ilhom beradi." },
  { head: "💡 Xayrli tong, aziz kuratorlar!", body: "Har bir savol — oʻquvchi qiziqayotganining belgisi. Bugun ham shu qiziqishni soʻndirmaymiz, aksincha yoqamiz 🔥" },
  { head: "🌅 Assalomu alaykum!", body: "Yana bir kun — kimningdir hayotiga ozgina boʻlsa ham oʻzgarish olib kirish uchun yana bir imkoniyat. Ishimizning goʻzalligi ham shunda." },
  { head: "🤝 Xayrli tong, jamoa!", body: "Sizsiz bu Challenge shunchaki videolar toʻplami boʻlib qolardi. Uni jonli qiladigan — aynan sizsiz." },
  { head: "🍀 Tong muborak!", body: "Bugungi kichik maqsad: birorta savol bir soatdan ortiq javobsiz qolmasin. Uddalaymiz-a? 😊" },
  { head: "🌼 Assalomu alaykum!", body: "Oʻquvchilar hozir uygʻonib, darslarni ochishyapti. Ular bilan birga yana bir mazmunli kunni boshlaymiz!" },
  { head: "✨ Xayrli tong!", body: "Bugun yozgan har bir izohingiz kimgadir ertangi kasbini topishga yordam berishi mumkin. Shunday katta ish qilayotganingiz uchun rahmat!" },
];

/** An extra line for some days of the week (0 = Sunday … 6 = Saturday), shown under the greeting. */
export const WEEKDAY_LINES: Record<number, string> = {
  1: "Yangi hafta muborak! 🎉",
  5: "Juma muborak! 🌿 Hafta yakuniga oz qoldi.",
  6: "Shanba kuni ham oʻquvchilar faol — ular bilan birgamiz 😊",
  0: "Yakshanba boʻlsa ham, kimdir aynan bugun savol beradi 🙂",
};

export const MORNING_CLOSINGS: string[] = [
  "Omad, ustozlar! ❤️",
  "Bugun ham zoʻr kun boʻladi! 🌟",
  "Birga — har doim kuchliroqmiz 💪",
  "Yaxshi kun tilayman! ☀️",
  "Oldinga, jamoa! 🚀",
];

export const EVENING_OPENERS: Opener[] = [
  { head: "🌙 Kun yakunlandi, aziz kuratorlar!", body: "Bugungi mehnatingiz uchun katta rahmat — har bir javob va har bir baho oʻquvchilarimizni oldinga siljitdi." },
  { head: "✨ Xayrli kech, jamoa!", body: "Bugun ham zoʻr ishladingiz. Quyida bugungi natijalarimiz 👇" },
  { head: "🙏 Rahmat, ustozlar!", body: "Yana bir mazmunli kun ortda qoldi. Qilgan ishingiz har doim ham koʻzga tashlanmaydi, lekin oʻquvchilar uni albatta his qiladi." },
  { head: "🌟 Kech kirdi, natijalar esa yorqin!", body: "Har biringizga alohida rahmat — bugun ham oʻquvchilarimiz yolgʻiz qolmadi." },
  { head: "💫 Bugungi kun ham oʻtdi!", body: "Siz tufayli oʻquvchilarimiz yana bir qadam oldinda. Mana qisqacha hisobot 👇" },
  { head: "🌆 Xayrli kech!", body: "Charchagan boʻlsangiz kerak — bu esa yaxshi ishlaganingizdan dalolat 😊" },
  { head: "💪 Jamoa, bugun ham oʻzingizni koʻrsatdingiz!", body: "Katta rahmat. Raqamlarga bir nazar tashlaymiz 👇" },
  { head: "❤️ Rahmat, aziz kuratorlar!", body: "Kun boʻyi oʻquvchilar bilan boʻlganingiz uchun minnatdormiz. Mana bugun nimalarga erishdik 👇" },
  { head: "🌙 Kechki salom!", body: "Bugungi mehnatingiz zoe ketmadi — raqamlar buni aytib turibdi 👇" },
  { head: "🏅 Yana bir kun, yana oʻnlab kichik gʻalabalar!", body: "Har bir javobingiz va bahoingiz uchun rahmat." },
  { head: "🙌 Bugun ham savollar javobsiz qolmadi!", body: "Bu — sizning xizmatingiz. Kun natijalari bilan tanishing 👇" },
  { head: "🌿 Mehnatingiz uchun rahmat, jamoa!", body: "Keling, bugun qanday ishlaganimizni koʻraylik 👇" },
  { head: "💙 Kun yakunida bitta soʻz: rahmat!", body: "Endi esa bugungi raqamlar 👇" },
  { head: "🎯 Yana bir samarali kun ortda!", body: "Oʻquvchilar nomidan katta rahmat. Mana natijalar 👇" },
];

export const EVENING_CLOSINGS: string[] = [
  "Yaxshi dam oling — ertaga yana birgamiz! 🌙",
  "Maroqli dam oling, siz bunga loyiqsiz 😊",
  "Ertagacha! Xayrli tun 🌌",
  "Dam oling, kuch toʻplang — ertaga yangi kun bizni kutyapti ✨",
  "Yana bir bor rahmat. Xayrli tun! 💙",
  "Bugun qilgan ishingizdan faxrlansangiz arziydi. Xayrli tun! 🌙",
];

/** Tashkent day number (UTC+5, no DST): consecutive days → consecutive indices. */
export function tashkentDayNumber(nowMs: number): number {
  return Math.floor((nowMs + 5 * 3_600_000) / 86_400_000);
}

export function pick<T>(pool: T[], day: number, salt = 0): T {
  return pool[((day + salt) % pool.length + pool.length) % pool.length];
}
