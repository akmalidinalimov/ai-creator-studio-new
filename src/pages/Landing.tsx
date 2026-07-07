import { useEffect, useState, useMemo } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { SuzaniStar } from "@/components/landing/SuzaniStar";
import { PixelDissolve } from "@/components/landing/PixelDissolve";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import {
  ArrowRight, Play, CheckCircle2, Film, Wand2, DollarSign,
  UserPlus, BookOpen, Rocket, Star, Menu, X, ChevronDown,
} from "lucide-react";

// Public marketing curriculum — descriptive only. Deliberately does NOT expose
// per-lesson titles or durations (that's confidential competitive info). Hardcoded
// so the homepage never queries lessons.
const MODULES: { n: string; title: string; body: string }[] = [
  { n: "01", title: "AI bilan tanishuv va kreativ fikrlash", body: "Sun'iy intellekt dunyosiga ilk qadam. Kreativ fikrlashni rivojlantirib, cheksiz g'oyalar topishni o'rganasiz." },
  { n: "02", title: "Brendlar to'laydigan professional rasmlar", body: "AI yordamida brendlar pul to'laydigan darajadagi professional rasmlarni atigi 7 qadamda yaratasiz." },
  { n: "03", title: "Kreativ reklama videolari", body: "Ijtimoiy tarmoqlarda e'tiborni tortadigan kreativ reklama videolarini AI bilan tayyorlash sirlarini egallaysiz." },
  { n: "04", title: "AI bilan multfilm yaratish", body: "G'oyadan tayyor multfilmgacha — ssenariy yozib, AI yordamida o'z multfilmingizni yaratasiz." },
  { n: "05", title: "Birinchi mijoz va daromad", body: "AI orqali birinchi mijozlaringizni topasiz, xizmatga to'g'ri narx qo'yasiz va mijoz bilan professional ishlashni o'rganasiz." },
  { n: "06", title: "Yuzsiz blog va shaxsiy AI avatar", body: "Kamera oldiga chiqmasdan, shaxsiy AI avataringiz bilan blog yuritish va kuchli shaxsiy brend qurasiz." },
  { n: "07", title: "Telegram bot va avtomatlashtirish", body: "AI yordamida shaxsiy Telegram bot va assistent yaratib, ishingizni to'liq avtomatlashtirasiz." },
  { n: "08", title: "Shablon va tayyor workflowlar", body: "Bir marta workflow tuzasiz — u siz uchun doimo kreativ rasm va videolarni o'zi tayyorlab beradi." },
];

// The two founders. photo: fill with a hosted image URL; empty → initials avatar.
const FOUNDERS: { name: string; role: string; initials: string; photo: string }[] = [
  { name: "Shahlo Alikhanova", role: "Marketing va AI mutaxassisi", initials: "SH", photo: "" },
  { name: "Akmalidin Alimov", role: "Muhandis (Engineer) va AI mutaxassisi", initials: "A", photo: "" },
];

interface LandingCopy {
  headline?: string;
  sub?: string;
  instructorBio?: string;
  instructorPhotoUrl?: string;
  faq?: { q: string; a: string }[];
}

// Real student work only. The previous entries were fabricated names/cities
// over Unsplash stock photos — invented social proof on a real school's page,
// which is a trust/legal risk. Populate this with consented student projects
// (self-hosted assets), or wire it to a curated table. Until then the showcase
// section stays hidden (guarded by SHOWCASE.length below) rather than faked.
const SHOWCASE: { url: string; name: string; type: string }[] = [];

const Brand = ({ to = "/" }: { to?: string }) => (
  <Link to={to} className="flex items-center gap-2 font-semibold tracking-tight">
    <span aria-hidden="true" className="inline-flex items-center justify-center w-7 h-7 rounded-lg bg-primary text-primary-foreground text-[13px] font-bold ring-[3px] ring-primary/10">A</span>
    <span className="text-[15px]">AI Creators</span>
  </Link>
);

export default function Landing() {
  const { t } = useTranslation();
  const { user, role, loading: authLoading } = useAuth();
  const nav = useNavigate();
  const [scrolled, setScrolled] = useState(false);
  const [courseTitle, setCourseTitle] = useState("AI Creators");
  const [copy, setCopy] = useState<LandingCopy>({});
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (!authLoading && user) {
      nav(role === "admin" ? "/admin/dashboard" : "/dashboard", { replace: true });
    }
  }, [user, role, authLoading, nav]);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 40);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    (async () => {
      const { data: course } = await supabase
        .from("courses")
        .select("id, title")
        .eq("published", true)
        .order("is_default_for_signup", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!course) return;
      setCourseTitle(course.title);
    })();

    (async () => {
      const keys = ["landing.hero.headline", "landing.hero.sub", "landing.instructor.bio", "landing.instructor.photo_url", "landing.faq"];
      const { data } = await supabase.from("platform_settings").select("key, value").in("key", keys);
      const map = new Map((data || []).map((r: any) => [r.key, r.value]));
      setCopy({
        headline: (map.get("landing.hero.headline") as any)?.text,
        sub: (map.get("landing.hero.sub") as any)?.text,
        instructorBio: (map.get("landing.instructor.bio") as any)?.text,
        instructorPhotoUrl: (map.get("landing.instructor.photo_url") as any)?.url,
        faq: (map.get("landing.faq") as any)?.items as { q: string; a: string }[] | undefined,
      });
    })();
  }, []);

  const outcomes = useMemo(() => (t("landing.outcomes.items", { returnObjects: true }) as { title: string; body: string }[]) || [], [t]);
  const howSteps = useMemo(() => (t("landing.howItWorks.steps", { returnObjects: true }) as { title: string; body: string }[]) || [], [t]);
  const faqDefault = useMemo(() => (t("landing.faq.items", { returnObjects: true }) as { q: string; a: string }[]) || [], [t]);
  const faq = copy.faq && copy.faq.length > 0 ? copy.faq : faqDefault;

  const headline = copy.headline || t("landing.hero.headlineDefault");
  const sub = copy.sub || t("landing.hero.subDefault");

  const renderHeadline = (text: string) => {
    const parts = text.split(/(\{[^}]+\})/g);
    return parts.map((p, i) => {
      if (p.startsWith("{") && p.endsWith("}")) {
        return <em key={i} className="text-primary not-italic font-display italic">{p.slice(1, -1)}</em>;
      }
      return <span key={i}>{p}</span>;
    });
  };

  const outcomeIcons = [Film, Wand2, DollarSign];
  const stepIcons = [UserPlus, BookOpen, Rocket];

  const renderHeadlineDark = (text: string) => {
    const parts = text.split(/(\{[^}]+\})/g);
    return parts.map((p, i) =>
      p.startsWith("{") && p.endsWith("}")
        ? <span key={i} className="text-[#6FE6CE]">{p.slice(1, -1)}</span>
        : <span key={i}>{p}</span>
    );
  };

  return (
    <div className="landing-dark min-h-screen bg-background text-foreground font-brandbody">
      <header className={`fixed top-0 inset-x-0 z-40 transition-all duration-300 ${scrolled ? "bg-[#0A0D0C]/85 backdrop-blur-md border-b border-white/10" : "bg-transparent"}`}>
        <div className="container flex h-16 items-center justify-between gap-4">
          <Link to="/" className="flex items-center gap-2 font-display text-[19px] font-semibold text-white tracking-tight">
            <span className="text-[#2FB39B]">✦</span> AI Creators
          </Link>
          <nav className="hidden md:flex items-center gap-8 text-sm font-brandbody">
            <a href="#curriculum" className="text-[#9FB2AD] hover:text-white transition-colors">{t("landing.nav.curriculum")}</a>
            <a href="#instructor" className="text-[#9FB2AD] hover:text-white transition-colors">{t("landing.nav.instructor")}</a>
            <a href="#pricing" className="text-[#9FB2AD] hover:text-white transition-colors">{t("landing.nav.pricing")}</a>
            <a href="#faq" className="text-[#9FB2AD] hover:text-white transition-colors">{t("landing.nav.faq")}</a>
          </nav>
          <div className="flex items-center gap-2">
            <LanguageSwitcher />
            <Button asChild variant="ghost" size="sm" className="hidden sm:inline-flex text-white hover:bg-white/10 hover:text-white">
              <Link to="/login">{t("landing.nav.signIn")}</Link>
            </Button>
            <Button asChild size="sm" className="hidden sm:inline-flex bg-gradient-to-b from-[#6FE6CE] to-[#2FB39B] text-[#052220] hover:opacity-90">
              <Link to="/signup">{t("landing.nav.startFree")} <ArrowRight className="h-3.5 w-3.5" /></Link>
            </Button>
            <button
              type="button"
              aria-label={menuOpen ? "Close menu" : "Open menu"}
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((o) => !o)}
              className="md:hidden inline-flex items-center justify-center w-10 h-10 rounded-lg text-white hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#6FE6CE]"
            >
              {menuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </button>
          </div>
        </div>
        {menuOpen && (
          <div className="md:hidden border-t border-white/10 bg-[#0A0D0C]/95 backdrop-blur-md">
            <nav className="container flex flex-col py-3 font-brandbody">
              {[["#curriculum", t("landing.nav.curriculum")], ["#instructor", t("landing.nav.instructor")], ["#pricing", t("landing.nav.pricing")], ["#faq", t("landing.nav.faq")]].map(([href, label]) => (
                <a key={href} href={href} onClick={() => setMenuOpen(false)} className="py-3 text-[15px] text-[#C4D3CE] hover:text-white">{label}</a>
              ))}
              <div className="flex gap-2 pt-2 pb-1">
                <Button asChild variant="outline" className="flex-1 border-white/15 bg-transparent text-white hover:bg-white/10 hover:text-white"><Link to="/login" onClick={() => setMenuOpen(false)}>{t("landing.nav.signIn")}</Link></Button>
                <Button asChild className="flex-1 bg-gradient-to-b from-[#6FE6CE] to-[#2FB39B] text-[#052220]"><Link to="/signup" onClick={() => setMenuOpen(false)}>{t("landing.nav.startFree")}</Link></Button>
              </div>
            </nav>
          </div>
        )}
      </header>

      <section className="relative overflow-hidden bg-[#0A0D0C] text-[#F3F7F5]">
        <div aria-hidden className="pointer-events-none absolute -top-[10%] -right-[8%] w-[70%] h-[80%] blur-2xl"
          style={{ background: "radial-gradient(closest-side, rgba(47,179,155,.18), transparent 70%)" }} />
        <div aria-hidden className="pointer-events-none absolute inset-0 opacity-50"
          style={{
            backgroundImage: "linear-gradient(rgba(120,180,168,.10) 1px,transparent 1px),linear-gradient(90deg,rgba(120,180,168,.10) 1px,transparent 1px)",
            backgroundSize: "72px 72px",
            maskImage: "radial-gradient(120% 100% at 20% 20%,#000,transparent 75%)",
            WebkitMaskImage: "radial-gradient(120% 100% at 20% 20%,#000,transparent 75%)",
          }} />
        <PixelDissolve className="absolute inset-0 w-full h-full" />

        <div className="container relative z-[3] grid lg:grid-cols-[1.15fr_.85fr] gap-10 items-center min-h-screen pt-28 pb-16">
          <div className="max-w-2xl">
            <span className="hero-rise inline-flex items-center gap-2.5 text-[13.5px] font-semibold text-[#6FE6CE] border border-white/10 bg-[rgba(47,179,155,.06)] rounded-full px-4 py-2" style={{ animationDelay: "0s" }}>
              <span className="w-[7px] h-[7px] rounded-full bg-[#6FE6CE] shadow-[0_0_12px_#6FE6CE]" /> {t("landing.hero.badge", "8 ta amaliy modul · Telegram-first")}
            </span>
            <h1 className="hero-rise font-display font-semibold text-[clamp(44px,6.4vw,88px)] leading-[.98] mt-6 text-balance" style={{ animationDelay: ".06s" }}>
              {renderHeadlineDark(headline)} <span className="text-[#2FB39B] text-[.7em] align-[.06em]">✦</span>
            </h1>
            <p className="hero-rise mt-6 text-[clamp(17px,1.5vw,20px)] leading-relaxed text-[#CBD9D4] max-w-[52ch]" style={{ animationDelay: ".12s" }}>{sub}</p>
            <div className="hero-rise mt-9 flex flex-wrap gap-3.5" style={{ animationDelay: ".18s" }}>
              <Button asChild size="lg" className="bg-gradient-to-b from-[#6FE6CE] to-[#2FB39B] text-[#052220] shadow-[0_10px_30px_rgba(47,179,155,.32)] hover:-translate-y-0.5 transition-transform focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#6FE6CE]">
                <Link to="/signup">{t("landing.hero.startLearning")} <ArrowRight className="h-4 w-4" /></Link>
              </Button>
              <Button asChild size="lg" variant="outline" className="border-white/15 bg-transparent text-white hover:bg-white/10 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#6FE6CE]">
                <a href="#curriculum">{t("landing.hero.viewCurriculum")}</a>
              </Button>
            </div>
            <div className="hero-rise mt-11 flex items-center gap-5 flex-wrap" style={{ animationDelay: ".24s" }}>
              <div className="flex -space-x-3">
                {["A", "M", "N", "R"].map((c, i) => (
                  <span key={i} className="w-11 h-11 rounded-full border-2 border-[#0A0D0C] flex items-center justify-center font-bold text-[15px] text-[#052220]" style={{ background: "linear-gradient(150deg,#6FE6CE,#0F766E)" }}>{c}</span>
                ))}
              </div>
              <p className="text-sm text-[#9FB2AD] leading-snug">
                <span className="text-white font-bold">{t("landing.hero.trustCountStrong")}</span> {t("landing.trust.building", "already building")}<br />
                <span className="text-[#E0BE6A] tracking-widest">★★★★★</span> 4.9 · {t("landing.trust.rating")}
              </p>
            </div>
          </div>

          {/* Floating product card — the loop itself is the hero */}
          <div className="hidden lg:flex hero-rise justify-center" style={{ animationDelay: ".1s" }}>
            <div className="floaty w-[330px] rounded-[26px] p-7 border border-white/10 shadow-[0_40px_90px_rgba(0,0,0,.55)]"
              style={{ background: "linear-gradient(160deg,rgba(20,32,30,.9),rgba(10,16,15,.92))", backdropFilter: "blur(6px)" }}>
              <div className="flex items-center gap-3.5">
                <div className="relative">
                  <div className="w-16 h-16 rounded-full flex items-center justify-center font-display font-semibold text-[28px] text-[#052220]" style={{ background: "linear-gradient(150deg,#6FE6CE,#0F766E)" }}>A</div>
                  <span className="livepulse absolute bottom-0.5 right-0.5 w-3.5 h-3.5 rounded-full bg-[#6FE6CE] border-2 border-[#0E1413]" aria-hidden />
                </div>
                <div><div className="font-display font-semibold text-[19px] text-white">Akmal Alimov</div><div className="text-[13px] text-[#9FB2AD] mt-0.5">AI Creator · Level 4</div></div>
              </div>
              <div className="font-display font-bold text-[64px] leading-none mt-6 text-white">30<span className="text-[#6FE6CE] text-[26px]">-day</span></div>
              <div className="text-sm text-[#9FB2AD] mt-1.5">streak · top 5% this month</div>
              <div className="h-2 rounded-md bg-white/[.06] mt-5 overflow-hidden"><div className="h-full w-[72%]" style={{ background: "linear-gradient(90deg,#2FB39B,#6FE6CE)" }} /></div>
              <div className="flex justify-between mt-3.5 text-[12.5px] text-[#9FB2AD]"><span>Module 3 of 8</span><span>72% complete</span></div>
              <div className="flex gap-2 mt-5">
                {[["#4", "Rank"], ["27", "Lessons"], ["8", "Badges"]].map(([n, l]) => (
                  <div key={l} className="flex-1 text-center border border-white/10 rounded-2xl py-3"><div className="font-display font-semibold text-[24px] text-[#6FE6CE]">{n}</div><div className="text-[11px] text-[#9FB2AD] mt-0.5 uppercase tracking-wider">{l}</div></div>
                ))}
              </div>
            </div>
          </div>
        </div>
        <a href="#curriculum" aria-label={t("landing.hero.viewCurriculum")} className="absolute bottom-6 left-1/2 -translate-x-1/2 z-[3] hidden md:flex flex-col items-center gap-1.5 text-[#9FB2AD] hover:text-white transition-colors">
          <span className="text-[11px] uppercase tracking-[.2em]">Scroll</span>
          <ChevronDown className="scrollcue h-5 w-5" />
        </a>
      </section>

      <section className="border-y border-border bg-secondary/40">
        <div className="container py-5 flex flex-wrap items-center justify-center gap-x-10 gap-y-2 text-sm">
          <span className="text-muted-foreground"><span className="font-semibold text-foreground">1 500+</span> {t("landing.trust.creators")}</span>
          <span className="hidden sm:block w-px h-4 bg-border" />
          <span className="text-muted-foreground"><span className="font-semibold text-foreground">4.9/5</span> {t("landing.trust.rating")}</span>
          <span className="hidden sm:block w-px h-4 bg-border" />
          <span className="text-muted-foreground"><span className="font-semibold text-foreground">30+</span> {t("landing.trust.countries")}</span>
          <span className="hidden sm:block w-px h-4 bg-border" />
          <span className="text-muted-foreground"><span className="font-semibold text-foreground">8</span> {t("landing.trust.modulesStat", "ta modul")}</span>
        </div>
      </section>

      {/* Mission — the movement, not a course */}
      <section className="py-20 md:py-28 bg-[#0A0D0C] text-[#F3F7F5] relative overflow-hidden">
        <div aria-hidden className="pointer-events-none absolute -bottom-[20%] left-1/2 -translate-x-1/2 w-[80%] h-[70%] blur-3xl" style={{ background: "radial-gradient(closest-side, rgba(47,179,155,.14), transparent 70%)" }} />
        <div className="container max-w-3xl relative z-10 text-center">
          <span className="inline-flex items-center gap-2 text-[13px] font-semibold text-[#6FE6CE] border border-white/10 bg-[rgba(47,179,155,.06)] rounded-full px-4 py-2">Bizning maqsadimiz</span>
          <h2 className="font-display font-semibold text-[clamp(34px,5vw,56px)] leading-[1.05] mt-6">100 000 hayotni o'zgartirish</h2>
          <p className="text-[#6FE6CE] font-medium text-lg md:text-xl mt-4">Biz kurs sotmaymiz. Biz hayotlarni o'zgartiramiz.</p>
          <div className="space-y-5 text-[#CBD9D4] leading-relaxed text-[16px] md:text-[17px] mt-8 text-left md:text-center">
            <p>Men va turmush o'rtog'im bitta orzu bilan yashaymiz: O'zbekistonda <b className="text-white">100 000 insonga</b> AI orqali daromad topishni o'rgatish. Uyda, oila bag'rida o'tirib — yurtini, yaqinlarini tark etmasdan, kamroq ishlab, ko'proq topish.</p>
            <p>Bu shunchaki kurs emas — bu <b className="text-white">harakat</b>. Bu yerda siz faqat rasm yoki video yaratishni emas, o'z hayotingizni o'zgartirishni, o'zingizni qaytadan kashf etishni va ichingizdagi kuchni uyg'otishni o'rganasiz.</p>
          </div>
          <div className="mt-12 max-w-xl mx-auto">
            <div className="flex items-end justify-between text-sm text-[#9FB2AD] mb-2">
              <span><b className="text-white text-base">1 500+</b> inson</span>
              <span>100 000</span>
            </div>
            <div className="h-2.5 rounded-full bg-white/[.08] overflow-hidden">
              <div className="h-full rounded-full" style={{ width: "1.5%", minWidth: "12px", background: "linear-gradient(90deg,#2FB39B,#6FE6CE)" }} />
            </div>
            <p className="text-[15px] text-[#9FB2AD] mt-4">Biz allaqachon <b className="text-white">1 500 dan ortiq</b> insonga yordam berdik — bu maqsadimizning atigi <b className="text-white">1.5%</b>i. Tizim ishlaydi: u 1 500 kishi uchun natija berdi — demak, siz uchun ham beradi.</p>
          </div>
          <Button asChild size="lg" className="mt-10 bg-gradient-to-b from-[#6FE6CE] to-[#2FB39B] text-[#052220] hover:-translate-y-0.5 transition-transform">
            <Link to="/signup">Harakatga qo'shiling <ArrowRight className="h-4 w-4" /></Link>
          </Button>
        </div>
      </section>

      <section id="outcomes" className="py-20 md:py-28">
        <div className="container">
          <h2 className="font-display text-[36px] md:text-[44px] font-semibold tracking-tight mb-3">{t("landing.outcomes.heading")}</h2>
          <p className="text-muted-foreground mb-12 max-w-2xl">{t("landing.outcomes.subheading")}</p>
          <div className="grid md:grid-cols-3 gap-6">
            {outcomes.map((item, i) => {
              const Icon = outcomeIcons[i] || Film;
              return (
                <div key={i} className="p-7 rounded-2xl bg-card border border-border shadow-soft">
                  <div className="w-11 h-11 rounded-xl bg-accent/60 flex items-center justify-center mb-5">
                    <Icon className="h-5 w-5 text-primary" />
                  </div>
                  <h3 className="font-display text-2xl font-semibold mb-2">{item.title}</h3>
                  <p className="text-muted-foreground leading-relaxed">{item.body}</p>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      <section id="curriculum" className="py-20 md:py-28 bg-secondary/30">
        <div className="container">
          <div className="flex flex-wrap items-end justify-between gap-3 mb-3">
            <h2 className="font-display text-[36px] md:text-[44px] font-semibold tracking-tight">Kurs dasturi — 8 ta modul</h2>
            <span className="text-sm font-semibold text-primary">Premium — 5 hafta · VIP — 8 hafta</span>
          </div>
          <p className="text-muted-foreground mb-10 max-w-2xl">Noldan professional AI kreatorgacha. Har bir modul — real daromadga olib boradigan amaliy bosqich.</p>
          <div className="grid md:grid-cols-2 gap-5">
            {MODULES.map((m) => (
              <div key={m.n} className="p-6 md:p-7 rounded-2xl bg-card border border-border shadow-soft flex gap-5 hover:border-primary/40 transition-colors">
                <span className="font-display text-3xl md:text-4xl text-primary tabular-nums shrink-0 leading-none">{m.n}</span>
                <div>
                  <h3 className="font-semibold text-lg mb-1.5">{m.title}</h3>
                  <p className="text-muted-foreground leading-relaxed text-[15px]">{m.body}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="instructor" className="py-20 md:py-28">
        <div className="container max-w-3xl">
          <h2 className="font-display text-[36px] md:text-[44px] font-semibold tracking-tight text-center mb-3">Sizni Shvetsiyalik AI mutaxassislari o'qitadi</h2>
          <p className="text-muted-foreground text-center max-w-2xl mx-auto mb-12 leading-relaxed">Biz Shvetsiyada o'z firmamizda AI loyihalari ustida ishlaymiz va bundan real daromad olamiz. Yevropadagi muhandislik va marketing tajribamiz — O'zbekistondagi ko'plab mutaxassislar tajribasidan ustun. Endi shu bilim va tajribani to'g'ridan-to'g'ri sizga olib kelmoqdamiz.</p>
          <div className="grid sm:grid-cols-2 gap-5">
            {FOUNDERS.map((f) => (
              <div key={f.name} className="rounded-2xl border border-border bg-card p-6 flex items-center gap-5 shadow-soft">
                <div className="w-20 h-20 rounded-2xl overflow-hidden ring-4 ring-accent/40 shrink-0">
                  {f.photo ? (
                    <img src={f.photo} alt={f.name} className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center font-display text-2xl font-semibold text-[#052220]" style={{ background: "linear-gradient(150deg,#6FE6CE,#0F766E)" }}>{f.initials}</div>
                  )}
                </div>
                <div>
                  <div className="font-display text-lg font-semibold leading-tight">{f.name}</div>
                  <div className="text-primary text-sm font-medium mt-0.5">{f.role}</div>
                  <div className="inline-flex items-center gap-1.5 text-xs text-muted-foreground mt-1.5"><Star className="h-3 w-3 fill-current text-primary" /> Shvetsiyadan</div>
                </div>
              </div>
            ))}
          </div>
          <p className="text-center text-sm text-muted-foreground max-w-2xl mx-auto mt-8">Bizning Yevropadagi solishtirib bo'lmas tajribamiz — bu sizning eng katta ustunligingiz.</p>
        </div>
      </section>

      <section className="py-20 md:py-28 bg-secondary/30">
        <div className="container">
          <h2 className="font-display text-[36px] md:text-[44px] font-semibold tracking-tight mb-12">{t("landing.howItWorks.heading")}</h2>
          <div className="grid md:grid-cols-3 gap-8">
            {howSteps.map((s, i) => {
              const Icon = stepIcons[i] || Rocket;
              return (
                <div key={i} className="space-y-4">
                  <div className="flex items-baseline gap-3">
                    <span className="font-display text-5xl text-primary tabular-nums leading-none">0{i + 1}</span>
                    <Icon className="h-5 w-5 text-muted-foreground" />
                  </div>
                  <h3 className="font-semibold text-lg">{s.title}</h3>
                  <p className="text-muted-foreground leading-relaxed">{s.body}</p>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {SHOWCASE.length > 0 && (
      <section id="showcase" className="py-20 md:py-28">
        <div className="container">
          <h2 className="font-display text-[36px] md:text-[44px] font-semibold tracking-tight mb-3">{t("landing.showcase.heading")}</h2>
          <p className="text-muted-foreground mb-10 max-w-2xl">{t("landing.showcase.sub")}</p>
        </div>
        <div className="overflow-x-auto scrollbar-hide snap-x snap-mandatory">
          <div className="flex gap-4 px-[max(1rem,calc((100vw-1280px)/2+1rem))] pb-2">
            {SHOWCASE.map((s) => (
              <div key={s.url} className="snap-start shrink-0 w-72 md:w-80">
                <div className="aspect-[4/5] rounded-xl overflow-hidden bg-secondary border border-border shadow-soft">
                  <img src={s.url} alt={s.name} className="w-full h-full object-cover" loading="lazy" />
                </div>
                <div className="mt-3">
                  <div className="font-medium text-sm">{s.name}</div>
                  <div className="text-xs text-muted-foreground">{s.type}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>
      )}

      <section id="pricing" className="py-20 md:py-28 bg-secondary/30">
        <div className="container max-w-4xl">
          <h2 className="font-display text-[36px] md:text-[44px] font-semibold tracking-tight text-center mb-2">Tarifni tanlang</h2>
          <p className="text-muted-foreground text-center mb-12 max-w-2xl mx-auto">Har ikkala tarif ham to'liq 8 modul va 3 ta bonus kursni o'z ichiga oladi.</p>

          <div className="grid md:grid-cols-2 gap-6 items-stretch">
            {/* Premium */}
            <div className="rounded-2xl border-2 border-border bg-card p-8 shadow-soft flex flex-col">
              <div className="text-xs uppercase tracking-wider text-primary font-semibold mb-1">Premium</div>
              <div className="font-display text-4xl font-semibold mb-1">5 hafta</div>
              <p className="text-muted-foreground text-sm mb-6">To'liq kurs dasturi va barcha bonuslar bilan.</p>
              <ul className="space-y-3 mb-8 flex-1">
                {["Barcha 8 ta modul — to'liq kurs dasturi", "3 ta bonus kurs: SMM, Mobilografiya, YouTube", "Amaliy vazifalar va ustozdan shaxsiy fikr-mulohaza", "Yopiq jamoa va qo'llab-quvvatlash", "Bitirish sertifikati"].map((f, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm"><CheckCircle2 className="h-4 w-4 text-primary mt-0.5 shrink-0" /><span>{f}</span></li>
                ))}
              </ul>
              <Button asChild size="lg" variant="outline" className="w-full"><Link to="/signup">Ro'yxatdan o'tish <ArrowRight className="h-4 w-4" /></Link></Button>
            </div>

            {/* VIP */}
            <div className="relative rounded-2xl border-2 border-primary/40 bg-card p-8 shadow-elevated flex flex-col">
              <span className="absolute -top-3 left-1/2 -translate-x-1/2 bg-primary text-primary-foreground text-[11px] font-semibold uppercase tracking-wider px-3 py-1 rounded-full whitespace-nowrap">Eng yaxshi tanlov</span>
              <div className="text-xs uppercase tracking-wider text-primary font-semibold mb-1">VIP</div>
              <div className="font-display text-4xl font-semibold mb-1">8 hafta</div>
              <p className="text-muted-foreground text-sm mb-6">Premium'dagi hamma narsa + eksklyuziv imkoniyatlar.</p>
              <ul className="space-y-3 mb-8 flex-1">
                {["Premium tarifidagi barcha imkoniyatlar", "8 haftalik kengaytirilgan qo'llab-quvvatlash", "☕ Shvetsiyalik AI ekspertlari bilan nonushta — ular O'zbekistonga tashrif buyurganda", "Shaxsiy e'tibor va ustuvor yordam"].map((f, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm"><CheckCircle2 className="h-4 w-4 text-primary mt-0.5 shrink-0" /><span>{f}</span></li>
                ))}
              </ul>
              <Button asChild size="lg" className="w-full"><Link to="/signup">VIP'ga yozilish <ArrowRight className="h-4 w-4" /></Link></Button>
            </div>
          </div>

          {/* Bonus courses */}
          <div className="mt-14">
            <h3 className="font-display text-2xl md:text-3xl font-semibold text-center mb-2">🎁 Sovg'a — 3 ta bonus kurs</h3>
            <p className="text-muted-foreground text-center text-sm mb-7">Asosiy kurs bilan birga quyidagi kurslarni ham BEPUL olasiz</p>
            <div className="grid sm:grid-cols-3 gap-4">
              {[["SMM kursi", "Ijtimoiy tarmoqlarni professional boshqarish"], ["Mobilografiya kursi", "Telefon bilan sifatli suratga olish va montaj"], ["YouTube kursi", "YouTube kanal ochish va rivojlantirish"]].map(([name, desc]) => (
                <div key={name} className="rounded-2xl border border-border bg-card p-5 text-center shadow-soft">
                  <div className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-primary mb-2"><Star className="h-3.5 w-3.5 fill-current" /> Bonus</div>
                  <div className="font-semibold">{name}</div>
                  <div className="text-xs text-muted-foreground mt-1">{desc}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Refund incentive */}
          <div className="mt-12 rounded-2xl border border-primary/30 bg-primary/[0.05] p-7 md:p-9 text-center">
            <div className="text-3xl mb-2">💸</div>
            <h3 className="font-display text-2xl md:text-3xl font-semibold mb-2">Mehnatingiz qaytariladi</h3>
            <p className="text-muted-foreground max-w-2xl mx-auto leading-relaxed">Kursni muvaffaqiyatli yakunlagan va yuqori natija ko'rsatgan talabalar orasidan <b className="text-foreground">5 nafari to'lovni to'liq qaytarib oladi</b> — tirishqoqligingiz uchun bizning minnatdorchiligimiz.</p>
          </div>

          <div className="mt-10 text-center">
            <Button asChild size="lg"><Link to="/signup">Hoziroq boshlash <ArrowRight className="h-4 w-4" /></Link></Button>
          </div>
        </div>
      </section>

      <section id="faq" className="py-20 md:py-28">
        <div className="container max-w-3xl">
          <h2 className="font-display text-[36px] md:text-[44px] font-semibold tracking-tight mb-10 text-center">{t("landing.faq.heading")}</h2>
          <Accordion type="single" collapsible className="space-y-2">
            {faq.map((item, i) => (
              <AccordionItem key={i} value={`q-${i}`} className="border border-border rounded-xl bg-card px-5">
                <AccordionTrigger className="hover:no-underline py-4 text-left text-base font-medium">{item.q}</AccordionTrigger>
                <AccordionContent className="pb-4 text-muted-foreground leading-relaxed">{item.a}</AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </div>
      </section>

      <section className="py-20 md:py-28 bg-secondary/60 border-y border-border">
        <div className="container max-w-2xl text-center space-y-6">
          <h2 className="font-display text-[36px] md:text-[48px] font-semibold tracking-tight">{t("landing.finalCta.heading")}</h2>
          <p className="text-muted-foreground text-lg">{t("landing.finalCta.sub")}</p>
          <Button asChild size="lg" className="text-base h-12 px-8"><Link to="/signup">{t("landing.finalCta.button")} <ArrowRight className="h-5 w-5" /></Link></Button>
        </div>
      </section>

      <footer className="bg-background border-t border-border">
        <div className="container py-12 grid md:grid-cols-3 gap-8">
          <div className="space-y-4">
            <Brand />
            <p className="text-sm text-muted-foreground max-w-xs">{t("landing.footer.tagline")}</p>
          </div>
          <div className="space-y-3 text-sm">
            <div className="font-semibold text-xs uppercase tracking-wider text-muted-foreground">{t("landing.footer.course")}</div>
            <div className="space-y-2">
              <a href="#curriculum" className="block hover:text-primary">{t("landing.nav.curriculum")}</a>
              <a href="#instructor" className="block hover:text-primary">{t("landing.nav.instructor")}</a>
              <a href="#pricing" className="block hover:text-primary">{t("landing.nav.pricing")}</a>
              <a href="#faq" className="block hover:text-primary">{t("landing.nav.faq")}</a>
            </div>
          </div>
          <div className="space-y-3 text-sm">
            <div className="font-semibold text-xs uppercase tracking-wider text-muted-foreground">{t("landing.footer.company")}</div>
            <div className="space-y-2">
              <Link to="/login" className="block hover:text-primary">{t("landing.nav.signIn")}</Link>
              <Link to="/signup" className="block hover:text-primary">{t("auth.signUp")}</Link>
              <a href="mailto:hello@aicreators.app" className="block hover:text-primary">{t("landing.footer.contact")}</a>
            </div>
          </div>
        </div>
        <div className="border-t border-border">
          <div className="container py-5 text-xs text-muted-foreground flex flex-wrap items-center justify-between gap-2">
            <span>{t("landing.footer.copyright")}</span>
            <span>{courseTitle}</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
