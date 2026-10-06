// Template replies to the student, per rule message_key (uz / ru / en). Used when the AI step is unavailable (no key,
// budget spent, invalid output) and as the AI's fallback. Plain text — the bot escapes it and adds the support header
// and footer («💬 Yordam xizmati javobi (#N)» … «✅ Muammongiz hal qilindi»).
export type Locale = "uz" | "ru" | "en";

type Tpl = (args: Record<string, unknown>) => string;
const T: Record<string, Record<Locale, Tpl>> = {
  group_fixed: {
    uz: () => "Guruhingiz platformada toʻgʻrilandi — endi bot sizni guruhingizda taniydi. Qabul qilinmagan vazifalaringizni guruhdagi tegishli topikka qayta yuboring.",
    ru: () => "Ваша группа на платформе исправлена — теперь бот узнаёт вас в группе. Отправьте непринятые задания ещё раз в нужную тему группы.",
    en: () => "Your group on the platform is fixed — the bot now recognises you in your group. Please resend any work that wasn't accepted to the right topic.",
  },
  identity_fixed: {
    uz: () => "Sizning ikkita hisobingiz bor edi — ular bittaga keltirildi va guruhingiz toʻgʻrilandi. Qabul qilinmagan vazifalaringizni qayta yuboring.",
    ru: () => "У вас было два аккаунта — мы оставили один и исправили группу. Отправьте непринятые задания ещё раз.",
    en: () => "You had two accounts — they're now one and your group is fixed. Please resend any work that wasn't accepted.",
  },
  moved_group: {
    uz: () => "Platformadagi guruhingiz siz yozayotgan guruhga oʻzgartirildi. Ballaringiz va vazifalaringiz shu guruhga oʻtadi.",
    ru: () => "Ваша группа на платформе изменена на ту, где вы пишете. Баллы и задания переходят в эту группу.",
    en: () => "Your platform group now matches the group you post in. Your points and work move with you.",
  },
  post_in_own_group: {
    uz: () => "Platformada siz boshqa guruhdasiz. Vazifalarni oʻz guruhingizdagi topiklarga yuboring — shunda ular qabul qilinadi.",
    ru: () => "На платформе вы в другой группе. Отправляйте задания в темы своей группы — тогда они будут приняты.",
    en: () => "On the platform you're in a different group. Post your work in your own group's topics so it's accepted.",
  },
  access_opened: {
    uz: () => "Hisobingiz toʻliq ochildi — endi darslar koʻrinadi.",
    ru: () => "Ваш аккаунт полностью открыт — уроки теперь доступны.",
    en: () => "Your account is fully open — the lessons are available now.",
  },
  tier_limit: {
    uz: (a) => `Bu dars hali yopiq: ${a.locked ?? "keyingi modullar"} tarif boʻyicha keyinroq ochiladi. Ochiq modullardagi darslarni davom ettiring.`,
    ru: (a) => `Этот урок пока закрыт: ${a.locked ?? "следующие модули"} откроются позже по тарифу. Продолжайте уроки в открытых модулях.`,
    en: (a) => `That lesson isn't open yet: ${a.locked ?? "the next modules"} open later in your plan. Keep going with the open modules.`,
  },
  dm_now_works: {
    uz: () => "Endi bot sizga xabar yubora oladi. Botni bloklamang — natijalar va eslatmalar shu yerga keladi.",
    ru: () => "Теперь бот может присылать вам сообщения. Не блокируйте бота — результаты и напоминания приходят сюда.",
    en: () => "The bot can message you now. Please don't block it — results and reminders arrive here.",
  },
  repost_homework: {
    uz: () => "Uyga vazifangiz bot tomonidan qabul qilinmagan edi. Iltimos, uni guruhdagi «UYGA VAZIFA» topigiga qayta yuboring va vazifani tugmadan tanlang.",
    ru: () => "Бот не принял ваше домашнее задание. Отправьте его ещё раз в тему «UYGA VAZIFA» группы и выберите задание кнопкой.",
    en: () => "The bot didn't accept your homework. Please post it again in the group's «UYGA VAZIFA» topic and pick the task with the button.",
  },
  task_missing_part: {
    uz: (a) => `Qoʻshimcha vazifangiz hali toʻliq emas — yetishmayotgani: ${a.missing ?? "?"}. Shu qismini «QOʻSHIMCHA VAZIFALAR» topigiga yuboring.`,
    ru: (a) => `Дополнительное задание ещё не полное — не хватает: ${a.missing ?? "?"}. Отправьте эту часть в тему «QOʻSHIMCHA VAZIFALAR».`,
    en: (a) => `Your extra task isn't complete yet — missing: ${a.missing ?? "?"}. Send that part to the «QOʻSHIMCHA VAZIFALAR» topic.`,
  },
  points_restored: {
    uz: () => "Ballaringiz qayta hisoblandi — guruhingizdagi barcha faolligingiz hisobga olindi.",
    ru: () => "Ваши баллы пересчитаны — учтена вся ваша активность в группе.",
    en: () => "Your points were recalculated — all your activity in the group now counts.",
  },
  investigating: {
    uz: () => "Rahmat, muammo texnik tomondan oʻrganilmoqda. Tuzatilishi bilan shu yerga xabar beramiz.",
    ru: () => "Спасибо, проблему изучают технически. Сообщим здесь, как только исправим.",
    en: () => "Thanks — the issue is being looked at on the technical side. We'll let you know here once it's fixed.",
  },
  unknown: {
    uz: () => "Rahmat, murojaatingiz koʻrib chiqildi. Muammo davom etsa, «❓ Yordam» orqali skrinshot bilan yana yozing.",
    ru: () => "Спасибо, ваше обращение рассмотрено. Если проблема останется, напишите снова через «❓ Помощь» со скриншотом.",
    en: () => "Thanks, your request was reviewed. If the problem continues, write again via «❓ Help» with a screenshot.",
  },
};

export function templateReply(key: string | null | undefined, locale: Locale, args: Record<string, unknown> = {}): string {
  const k = key && T[key] ? key : "unknown";
  return (T[k][locale] ?? T[k].uz)(args ?? {});
}
