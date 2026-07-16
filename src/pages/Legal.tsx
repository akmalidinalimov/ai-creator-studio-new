import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";

// Public Privacy Policy + Terms pages. Beyond being the right thing to have, visible, honest
// legal pages + clear company identity are the strongest legitimacy signal for the anti-phishing
// reviewers we're appealing to (phishing sites never have them). Content is factual to what the
// platform actually does; localized uz/ru/en, English fallback.

const CONTACT_EMAIL = "hello@aicreators.app";
const CONTACT_TG = "@aicreators_uz";
const UPDATED = "2026-07-16";

type Section = { h: string; p: string };
type Doc = { title: string; intro: string; sections: Section[] };

const PRIVACY: Record<string, Doc> = {
  en: {
    title: "Privacy Policy",
    intro:
      "AI Creators (“we”) operates the online learning platform at aicreator.academy and an associated Telegram bot for students of our AI course. This policy explains what we collect and why.",
    sections: [
      { h: "Who we are", p: "AI Creators is an online education provider based in Tashkent, Uzbekistan. Contact us any time at " + CONTACT_EMAIL + " or on Telegram " + CONTACT_TG + "." },
      { h: "What we collect", p: "Account details you provide (name, email, and — if you use our Telegram bot — your Telegram username and ID), your lesson progress and watch activity, homework you submit, and points/achievements earned on the platform." },
      { h: "Why we collect it", p: "Solely to deliver the course: to sign you in, show your lessons and progress, let teachers grade your homework, and run the group rating. We do not sell your data or use it for advertising." },
      { h: "Where it is stored", p: "On Supabase (managed PostgreSQL) with row-level security so you can only see your own data. Lesson videos are served via Bunny.net and some images via Cloudinary. Course communication runs through the Telegram Bot API." },
      { h: "Your rights", p: "You can view and edit your profile in the app, and request correction or deletion of your account by contacting us at " + CONTACT_EMAIL + ". We keep your data only as long as your enrolment is active." },
      { h: "Security", p: "All traffic is served over HTTPS. Access to your record requires your authenticated login. We never ask for your password by email or message." },
    ],
  },
  uz: {
    title: "Maxfiylik siyosati",
    intro:
      "AI Creators (“biz”) aicreator.academy onlayn ta’lim platformasi va AI kursi talabalari uchun Telegram botini yuritadi. Ushbu siyosat qanday ma’lumot to’planishi va nima uchun ekanini tushuntiradi.",
    sections: [
      { h: "Biz kimmiz", p: "AI Creators — Toshkent, O’zbekistonda joylashgan onlayn ta’lim provayderi. Bog’lanish: " + CONTACT_EMAIL + " yoki Telegram " + CONTACT_TG + "." },
      { h: "Qanday ma’lumot to’playmiz", p: "Siz bergan hisob ma’lumotlari (ism, email va Telegram botdan foydalansangiz — Telegram username va ID), darslar bo’yicha progress va ko’rish faoliyati, topshirgan vazifalaringiz, hamda ball va yutuqlaringiz." },
      { h: "Nima uchun", p: "Faqat kursni yetkazish uchun: tizimga kirish, darslar va progressni ko’rsatish, o’qituvchilar vazifani baholashi va guruh reytingi uchun. Ma’lumotlaringizni sotmaymiz va reklama uchun ishlatmaymiz." },
      { h: "Qayerda saqlanadi", p: "Supabase (boshqariladigan PostgreSQL) da, siz faqat o’z ma’lumotingizni ko’rasiz. Dars videolari Bunny.net, ba’zi rasmlar Cloudinary orqali. Aloqa Telegram Bot API orqali." },
      { h: "Sizning huquqlaringiz", p: "Profilingizni ilovada ko’rish va tahrirlash mumkin; hisobni tuzatish yoki o’chirishni " + CONTACT_EMAIL + " orqali so’rashingiz mumkin. Ma’lumot faqat o’qish davomida saqlanadi." },
      { h: "Xavfsizlik", p: "Barcha trafik HTTPS orqali. Ma’lumotingizga faqat siz kira olasiz. Biz hech qachon parolingizni email yoki xabar orqali so’ramaymiz." },
    ],
  },
  ru: {
    title: "Политика конфиденциальности",
    intro:
      "AI Creators (“мы”) управляет онлайн-платформой aicreator.academy и Telegram-ботом для студентов нашего курса по ИИ. Эта политика объясняет, какие данные мы собираем и зачем.",
    sections: [
      { h: "Кто мы", p: "AI Creators — провайдер онлайн-образования из Ташкента, Узбекистан. Связь: " + CONTACT_EMAIL + " или Telegram " + CONTACT_TG + "." },
      { h: "Что мы собираем", p: "Данные аккаунта (имя, email, а при использовании Telegram-бота — username и ID), прогресс по урокам, отправленные задания, баллы и достижения." },
      { h: "Зачем", p: "Только для проведения курса: вход, показ уроков и прогресса, проверка заданий преподавателями, рейтинг группы. Мы не продаём данные и не используем их для рекламы." },
      { h: "Где хранится", p: "В Supabase (управляемый PostgreSQL) с доступом только к своим данным. Видео — через Bunny.net, некоторые изображения — Cloudinary. Коммуникация — Telegram Bot API." },
      { h: "Ваши права", p: "Профиль можно смотреть и редактировать в приложении; исправление или удаление аккаунта — по запросу на " + CONTACT_EMAIL + ". Данные хранятся только во время обучения." },
      { h: "Безопасность", p: "Весь трафик по HTTPS. Доступ к записи только после входа. Мы никогда не запрашиваем пароль по почте или в сообщении." },
    ],
  },
};

const TERMS: Record<string, Doc> = {
  en: {
    title: "Terms of Service",
    intro: "By using aicreator.academy and our Telegram bot, you agree to these terms.",
    sections: [
      { h: "The service", p: "AI Creators provides access to a paid online AI course — video lessons, homework, grading, and progress tracking — for enrolled students." },
      { h: "Accounts", p: "You are responsible for your login and for the accuracy of your profile. Accounts are personal; do not share access or submit another person’s work as your own." },
      { h: "Acceptable use", p: "Use the platform only for learning. Do not attempt to disrupt the service, scrape content, or redistribute course materials, which remain our intellectual property." },
      { h: "Payments & access", p: "Course access follows your enrolment/tier. Trial accounts may have limited access until full payment. Contact us for any billing question." },
      { h: "Disclaimer", p: "The course is provided “as is” for educational purposes. We work to keep it available and accurate but do not guarantee specific outcomes." },
      { h: "Contact", p: "Questions about these terms: " + CONTACT_EMAIL + " or Telegram " + CONTACT_TG + "." },
    ],
  },
  uz: {
    title: "Foydalanish shartlari",
    intro: "aicreator.academy va Telegram botimizdan foydalanib, ushbu shartlarga rozilik bildirasiz.",
    sections: [
      { h: "Xizmat", p: "AI Creators ro’yxatdan o’tgan talabalarga pullik onlayn AI kursini — video darslar, vazifalar, baholash va progress — taqdim etadi." },
      { h: "Hisoblar", p: "Login va profil to’g’riligi uchun siz javobgarsiz. Hisob shaxsiy; kirishni ulashmang va boshqaning ishini o’zingizniki sifatida topshirmang." },
      { h: "To’g’ri foydalanish", p: "Platformadan faqat o’qish uchun foydalaning. Xizmatni buzish, kontentni ko’chirish yoki dars materiallarini tarqatishga urinmang — ular bizning mulkimiz." },
      { h: "To’lov va kirish", p: "Kursga kirish tarifingizga bog’liq. Sinov hisoblarida to’liq to’lovgacha kirish cheklangan bo’lishi mumkin. Savollar uchun biz bilan bog’laning." },
      { h: "Ogohlantirish", p: "Kurs ta’lim maqsadida “boricha” taqdim etiladi. Uni ochiq va aniq tutishga harakat qilamiz, lekin aniq natijani kafolatlamaymiz." },
      { h: "Aloqa", p: "Shartlar bo’yicha savollar: " + CONTACT_EMAIL + " yoki Telegram " + CONTACT_TG + "." },
    ],
  },
  ru: {
    title: "Условия использования",
    intro: "Используя aicreator.academy и наш Telegram-бот, вы соглашаетесь с этими условиями.",
    sections: [
      { h: "Сервис", p: "AI Creators предоставляет доступ к платному онлайн-курсу по ИИ — видеоуроки, задания, проверка и прогресс — для зачисленных студентов." },
      { h: "Аккаунты", p: "Вы отвечаете за свой вход и точность профиля. Аккаунт персональный; не передавайте доступ и не выдавайте чужую работу за свою." },
      { h: "Допустимое использование", p: "Используйте платформу только для обучения. Не нарушайте работу сервиса, не копируйте контент и не распространяйте материалы — они наша собственность." },
      { h: "Оплата и доступ", p: "Доступ зависит от вашего тарифа. У пробных аккаунтов доступ может быть ограничен до полной оплаты. По вопросам оплаты свяжитесь с нами." },
      { h: "Отказ от гарантий", p: "Курс предоставляется “как есть” в образовательных целях. Мы стремимся к доступности и точности, но не гарантируем конкретных результатов." },
      { h: "Контакт", p: "Вопросы по условиям: " + CONTACT_EMAIL + " или Telegram " + CONTACT_TG + "." },
    ],
  },
};

function LegalDoc({ docs }: { docs: Record<string, Doc> }) {
  const { i18n, t } = useTranslation();
  const lang = (["uz", "ru", "en"].includes(i18n.language) ? i18n.language : "en") as keyof typeof docs;
  const doc = docs[lang] || docs.en;
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border">
        <div className="container py-4 flex items-center justify-between">
          <Link to="/" aria-label="AI Creators" className="font-semibold tracking-tight">AI Creators</Link>
          <Link to="/" className="text-sm text-muted-foreground hover:text-primary">← {t("common.back", "Back")}</Link>
        </div>
      </header>
      <main className="container max-w-2xl py-12">
        <h1 className="text-3xl font-semibold tracking-tight">{doc.title}</h1>
        <p className="mt-1 text-xs text-muted-foreground">{t("legal.updated", "Last updated")}: {UPDATED}</p>
        <p className="mt-5 text-muted-foreground">{doc.intro}</p>
        <div className="mt-8 space-y-6">
          {doc.sections.map((s, i) => (
            <section key={i}>
              <h2 className="text-lg font-semibold">{s.h}</h2>
              <p className="mt-1 text-sm text-muted-foreground leading-relaxed">{s.p}</p>
            </section>
          ))}
        </div>
        <p className="mt-10 text-sm">
          <a href={`mailto:${CONTACT_EMAIL}`} className="text-primary hover:underline">{CONTACT_EMAIL}</a>
        </p>
      </main>
    </div>
  );
}

export function Privacy() { return <LegalDoc docs={PRIVACY} />; }
export function Terms() { return <LegalDoc docs={TERMS} />; }
