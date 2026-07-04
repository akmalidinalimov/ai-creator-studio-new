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

interface Module {
  id: string;
  title: string;
  position: number;
  lessons: { id: string; title: string; duration_seconds: number | null; published: boolean; position: number }[];
}

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
  const [modules, setModules] = useState<Module[]>([]);
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
      const { data: mods } = await supabase
        .from("modules")
        .select("id, title, position, lessons(id, title, duration_seconds, published, position)")
        .eq("course_id", course.id)
        .order("position", { ascending: true });
      const cleaned = (mods || []).map((m: any) => ({
        ...m,
        lessons: (m.lessons || []).filter((l: any) => l.published).sort((a: any, b: any) => a.position - b.position),
      }));
      setModules(cleaned);
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
  const pricingFeatures = useMemo(() => (t("landing.pricing.features", { returnObjects: true }) as string[]) || [], [t]);
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
              <span className="w-[7px] h-[7px] rounded-full bg-[#6FE6CE] shadow-[0_0_12px_#6FE6CE]" /> {t("landing.hero.badge", "14-hour curriculum · Telegram-first")}
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
              <div className="flex justify-between mt-3.5 text-[12.5px] text-[#9FB2AD]"><span>Module 3 of 5</span><span>72% complete</span></div>
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
          <span className="text-muted-foreground"><span className="font-semibold text-foreground">1,247</span> {t("landing.trust.creators")}</span>
          <span className="hidden sm:block w-px h-4 bg-border" />
          <span className="text-muted-foreground"><span className="font-semibold text-foreground">4.9/5</span> {t("landing.trust.rating")}</span>
          <span className="hidden sm:block w-px h-4 bg-border" />
          <span className="text-muted-foreground"><span className="font-semibold text-foreground">30+</span> {t("landing.trust.countries")}</span>
          <span className="hidden sm:block w-px h-4 bg-border" />
          <span className="text-muted-foreground"><span className="font-semibold text-foreground">14h</span> {t("landing.trust.ofCurriculum")}</span>
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
          <h2 className="font-display text-[36px] md:text-[44px] font-semibold tracking-tight mb-3">{t("landing.curriculum.heading")}</h2>
          <p className="text-muted-foreground mb-10 max-w-2xl">{t("landing.curriculum.sub")}</p>

          {modules.length === 0 ? (
            <div className="rounded-xl border border-border bg-card p-10 text-center text-muted-foreground">
              {t("landing.curriculum.comingSoon")}
            </div>
          ) : (
            <Accordion type="single" collapsible defaultValue={modules[0]?.id} className="space-y-3">
              {modules.map((m, i) => {
                const totalSec = m.lessons.reduce((s, l) => s + (l.duration_seconds || 0), 0);
                const totalMin = Math.round(totalSec / 60);
                return (
                  <AccordionItem key={m.id} value={m.id} className="border border-border rounded-xl bg-card px-5 shadow-soft">
                    <AccordionTrigger className="hover:no-underline py-5">
                      <div className="flex items-center gap-4 text-left">
                        <span className="font-display text-2xl text-primary tabular-nums">0{i + 1}</span>
                        <div>
                          <div className="font-semibold text-base">{m.title}</div>
                          <div className="text-xs text-muted-foreground mt-0.5">{t("landing.curriculum.lessonsCount", { n: m.lessons.length, min: totalMin })}</div>
                        </div>
                      </div>
                    </AccordionTrigger>
                    <AccordionContent className="pb-5">
                      <ul className="space-y-2 pl-12">
                        {m.lessons.map((l) => (
                          <li key={l.id} className="flex items-center justify-between text-sm border-b border-border/50 pb-2 last:border-b-0 last:pb-0">
                            <span className="text-foreground/80">{l.title}</span>
                            {l.duration_seconds && (
                              <span className="text-xs text-muted-foreground tabular-nums">{Math.round(l.duration_seconds / 60)} {t("landing.curriculum.minSuffix")}</span>
                            )}
                          </li>
                        ))}
                      </ul>
                    </AccordionContent>
                  </AccordionItem>
                );
              })}
            </Accordion>
          )}
        </div>
      </section>

      <section id="instructor" className="py-20 md:py-28">
        <div className="container grid md:grid-cols-[1fr_240px] gap-10 md:gap-16 items-center">
          <div>
            <h2 className="font-display text-[36px] md:text-[44px] font-semibold tracking-tight mb-5">{t("landing.instructor.heading")}</h2>
            <div className="space-y-4 text-muted-foreground leading-relaxed prose-tight max-w-2xl">
              {(copy.instructorBio || t("landing.instructor.bioDefault")).split("\n\n").map((p, i) => <p key={i}>{p}</p>)}
            </div>
            <div className="mt-5 inline-flex items-center gap-2 text-sm text-primary font-medium">
              <Star className="h-4 w-4 fill-current" />
              {t("landing.instructor.credibility")}
            </div>
          </div>
          <div className="md:order-last order-first">
            <div className="w-60 h-60 mx-auto rounded-full overflow-hidden ring-8 ring-accent/40 shadow-elevated">
              {copy.instructorPhotoUrl ? (
                <img src={copy.instructorPhotoUrl} alt="Instructor" className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full flex items-center justify-center" style={{ background: "linear-gradient(150deg,#14211E,#0A0D0C)" }}>
                  <span className="font-display text-6xl text-primary">A</span>
                </div>
              )}
            </div>
          </div>
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
        <div className="container max-w-xl">
          <h2 className="font-display text-[36px] md:text-[44px] font-semibold tracking-tight text-center mb-12">{t("landing.pricing.heading")}</h2>
          <div className="rounded-2xl border-2 border-primary/20 bg-card p-8 shadow-elevated">
            <div className="text-xs uppercase tracking-wider text-primary font-semibold mb-2">{t("landing.pricing.label")}</div>
            <div className="flex items-baseline gap-2 mb-6">
              <span className="font-display text-5xl font-semibold">{t("landing.pricing.price")}</span>
              <span className="text-muted-foreground text-sm">{t("landing.pricing.priceSuffix")}</span>
            </div>
            <ul className="space-y-3 mb-8">
              {pricingFeatures.map((f, i) => (
                <li key={i} className="flex items-start gap-2 text-sm">
                  <CheckCircle2 className="h-4 w-4 text-primary mt-0.5 shrink-0" />
                  <span>{f}</span>
                </li>
              ))}
            </ul>
            <Button asChild size="lg" className="w-full"><Link to="/signup">{t("landing.pricing.cta")} <ArrowRight className="h-4 w-4" /></Link></Button>
          </div>
          <p className="text-xs text-center text-muted-foreground mt-4">{t("landing.pricing.footnote")}</p>
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
