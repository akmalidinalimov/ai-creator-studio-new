// «KURATORLAR 6.0» — the words. Hand-written, casual Uzbek, warm but not sugary. Each pool rotates by the Tashkent
// day number, so two days in a row never open the same way (a 14-entry pool repeats after two weeks). Numbers and
// names are filled in by room.ts; nothing here judges a curator — a zero is shown plainly, never commented on.

export const MORNING_OPENERS: string[] = [
  "Assalomu alaykum, aziz kuratorlar! ☀️ Yana bir goʻzal kun boshlandi. Bugun ham oʻquvchilarimizning har bir savoli, har bir vazifasi — orzusi sari bir qadam. Keling, shu qadamlarni birga qoʻyamiz! 💪",
  "Xayrli tong, jamoa! 🌤 Kofe tayyormi? ☕️ Bugun kimdir sizning bitta javobingiz tufayli AI'ni tushunib oladi — kunni shunday boshlash ajoyib emasmi?",
  "Xayrli tong! 🌱 Har bir baholangan vazifa oʻquvchi uchun «men toʻgʻri yoʻldaman» degan signal. Bugun ham shu signalni koʻproq berib turamiz 🙌",
  "Assalomu alaykum! ✨ Yangi kun — yangi savollar, yangi «aha!» lahzalar. Oʻquvchilarimiz sizga ishonadi, bu katta baxt.",
  "Xayrli tong, ustozlar! 🚀 Challenge davom etyapti, oʻquvchilar har kuni oʻsib boryapti. Ularning yonida boʻlganingiz uchun rahmat — bugun ham birgamiz!",
  "Tong muborak! 🌞 Kichik eslatma: tez berilgan javob — oʻquvchi uchun eng katta motivatsiya. Bugun ham savollarni kutdirib qoʻymaymiz 😉",
  "Assalomu alaykum, jamoa! 🌸 Kimdir bugun birinchi marta oʻzi yaratgan rasmini yuboradi — uni birinchi boʻlib siz koʻrasiz. Qanday yoqimli-a 🤩",
  "Xayrli tong! ☀️ Bugun ham oʻquvchilarimizga «sen uddalaysan» deyishni unutmaylik. Bitta iliq soʻz baʼzan butun bir darsdan koʻproq ilhom beradi.",
  "Xayrli tong, aziz kuratorlar! 💡 Har bir savol — oʻquvchi qiziqayotganining belgisi. Bugun ham shu qiziqishni soʻndirmaymiz, aksincha yoqamiz 🔥",
  "Assalomu alaykum! 🌅 Yana bir kun — kimningdir hayotiga ozgina boʻlsa ham oʻzgarish olib kirish uchun yana bir imkoniyat. Ishimizning goʻzalligi ham shunda.",
  "Xayrli tong, jamoa! 🤝 Sizsiz bu Challenge shunchaki videolar toʻplami boʻlib qolardi. Uni jonli qiladigan — aynan sizsiz.",
  "Tong muborak! 🍀 Bugungi kichik maqsad: birorta savol bir soatdan ortiq javobsiz qolmasin. Uddalaymiz-a? 😊",
  "Assalomu alaykum! 🌼 Oʻquvchilar hozir uygʻonib, darslarni ochishyapti. Ular bilan birga yana bir mazmunli kunni boshlaymiz!",
  "Xayrli tong! ✨ Bugun yozgan har bir izohingiz kimgadir ertangi kasbini topishga yordam berishi mumkin. Shunday katta ish qilayotganingiz uchun rahmat!",
];

/** A first line for some days of the week (0 = Sunday … 6 = Saturday), shown before the opener. */
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

export const EVENING_OPENERS: string[] = [
  "Kun yakunlandi, aziz kuratorlar! 🌙 Bugungi mehnatingiz uchun katta rahmat — har bir javob va har bir baho oʻquvchilarimizni oldinga siljitdi.",
  "Xayrli kech, jamoa! ✨ Bugun ham zoʻr ishladingiz. Mana bugungi natijalarimiz 👇",
  "Rahmat, ustozlar! 🙏 Yana bir mazmunli kun ortda qoldi. Qilgan ishingiz har doim ham koʻzga tashlanmaydi, lekin oʻquvchilar uni albatta his qiladi.",
  "Kech kirdi, bugungi natijalar esa yorqin! 🌟 Har biringizga alohida rahmat.",
  "Bugungi kun ham oʻtdi — siz tufayli oʻquvchilarimiz bir qadam oldinda 💫 Mana qisqacha hisobot:",
  "Xayrli kech! 🌆 Charchagan boʻlsangiz kerak — bu esa yaxshi ishlaganingizdan dalolat 😊 Bugungi natijalar:",
  "Jamoa, bugun ham oʻzingizni koʻrsatdingiz! 💪 Katta rahmat. Raqamlarga bir nazar tashlaymiz:",
  "Kun boʻyi oʻquvchilar bilan boʻlganingiz uchun rahmat! ❤️ Mana bugun nimalarga erishdik:",
  "Kechki salom, aziz kuratorlar! 🌙 Bugungi mehnatingiz zoe ketmadi — raqamlar buni aytib turibdi 👇",
  "Yana bir kun, yana oʻnlab kichik gʻalabalar! 🏅 Rahmat sizlarga.",
  "Bugun ham oʻquvchilarimizning savollari javobsiz qolmadi — bu sizning xizmatingiz 🙌 Kun natijalari:",
  "Mehnatingiz uchun rahmat, jamoa! 🌿 Bugun qanday ishlaganimizni koʻraylik:",
  "Kun yakunida bitta soʻz: rahmat! 💙 Endi esa bugungi raqamlar:",
  "Yana bir samarali kun ortda! 🎯 Oʻquvchilar nomidan katta rahmat. Mana natijalar:",
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
