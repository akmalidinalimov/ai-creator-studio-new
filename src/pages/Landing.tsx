import { useEffect, useState, useMemo } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { SuzaniStar } from "@/components/landing/SuzaniStar";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import {
  ArrowRight, Play, CheckCircle2, Film, Wand2, DollarSign,
  UserPlus, BookOpen, Rocket, Star, MessageCircle, Twitter,
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

const SHOWCASE = [
  { url: "https://images.unsplash.com/photo-1542831371-29b0f74f9713?w=800&q=80", name: "Aziza · Tashkent", type: "Mini-film · Module 3" },
  { url: "https://images.unsplash.com/photo-1635776062127-d379bfcba9f8?w=800&q=80", name: "Bekzod · Samarkand", type: "Brand identity · Module 2" },
  { url: "https://images.unsplash.com/photo-1620641788421-7a1c342ea42e?w=800&q=80", name: "Madina · Almaty", type: "Editorial series · Module 2" },
  { url: "https://images.unsplash.com/photo-1633101585272-9e0b0c3d9c3c?w=800&q=80", name: "Rustam · Bishkek", type: "Music video · Module 3" },
  { url: "https://images.unsplash.com/photo-1655720828018-edd2daec9349?w=800&q=80", name: "Nilufar · Bukhara", type: "Product launch · Module 5" },
  { url: "https://images.unsplash.com/photo-1614729939124-032d1e6d7b48?w=800&q=80", name: "Diyor · Khiva", type: "Short film · Module 4" },
];

const Brand = ({ to = "/" }: { to?: string }) => (
  <Link to={to} className="flex items-center gap-2 font-semibold tracking-tight">
    <span className="inline-flex items-center justify-center w-7 h-7 rounded-lg bg-primary text-primary-foreground text-[13px] font-bold ring-[3px] ring-primary/10">A</span>
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
        return <em key={i} className="text-primary not-italic font-serif italic">{p.slice(1, -1)}</em>;
      }
      return <span key={i}>{p}</span>;
    });
  };

  const outcomeIcons = [Film, Wand2, DollarSign];
  const stepIcons = [UserPlus, BookOpen, Rocket];

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className={`fixed top-0 inset-x-0 z-40 transition-all duration-300 ${scrolled ? "bg-background/85 backdrop-blur-md border-b border-border" : "bg-transparent"}`}>
        <div className="container flex h-16 items-center justify-between gap-4">
          <Brand />
          <nav className="hidden md:flex items-center gap-7 text-sm">
            <a href="#curriculum" className="text-muted-foreground hover:text-foreground transition-colors">{t("landing.nav.curriculum")}</a>
            <a href="#instructor" className="text-muted-foreground hover:text-foreground transition-colors">{t("landing.nav.instructor")}</a>
            <a href="#pricing" className="text-muted-foreground hover:text-foreground transition-colors">{t("landing.nav.pricing")}</a>
            <a href="#faq" className="text-muted-foreground hover:text-foreground transition-colors">{t("landing.nav.faq")}</a>
          </nav>
          <div className="flex items-center gap-2">
            <LanguageSwitcher />
            <Button asChild variant="outline" size="sm" className="hidden sm:inline-flex">
              <Link to="/login">{t("landing.nav.signIn")}</Link>
            </Button>
            <Button asChild size="sm">
              <Link to="/signup">{t("landing.nav.startFree")} <ArrowRight className="h-3.5 w-3.5" /></Link>
            </Button>
          </div>
        </div>
      </header>

      <section className="relative pt-28 md:pt-32 pb-16 md:pb-24 overflow-hidden">
        <div className="absolute top-32 -left-16 text-primary/[0.07] pointer-events-none hidden md:block">
          <SuzaniStar size={520} />
        </div>
        <div className="container relative grid md:grid-cols-2 gap-10 lg:gap-16 items-center">
          <div className="space-y-6 max-w-xl">
            <h1 className="font-serif text-[40px] md:text-[56px] leading-[1.05] font-semibold tracking-tight">{renderHeadline(headline)}</h1>
            <p className="text-lg text-muted-foreground leading-relaxed">{sub}</p>
            <div className="flex flex-wrap gap-3 pt-2">
              <Button asChild size="lg" className="gap-2"><Link to="/signup">{t("landing.hero.startLearning")} <ArrowRight className="h-4 w-4" /></Link></Button>
              <Button asChild size="lg" variant="outline"><a href="#curriculum">{t("landing.hero.viewCurriculum")}</a></Button>
            </div>
            <div className="flex items-center gap-3 pt-4">
              <div className="flex -space-x-2">
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="w-8 h-8 rounded-full border-2 border-background" style={{ background: `hsl(${174 + i * 20}, 50%, ${40 + i * 8}%)` }} />
                ))}
              </div>
              <p className="text-sm text-muted-foreground">
                <span className="font-medium text-foreground">{t("landing.hero.trustCountStrong")}</span> · 4.9/5 {t("landing.trust.rating")}
              </p>
            </div>
          </div>

          <div className="relative aspect-[5/4] rounded-[22px] overflow-hidden shadow-elevated"
               style={{ background: "linear-gradient(135deg, hsl(174 78% 26%) 0%, hsl(180 60% 8%) 100%)" }}>
            <div className="absolute inset-0 opacity-60" style={{ background: "radial-gradient(circle at 70% 30%, hsl(43 89% 38% / 0.35) 0%, transparent 60%)" }} />
            <div className="absolute inset-0 flex items-center justify-center">
              <button aria-label={t("landing.hero.playLabel")} className="w-20 h-20 rounded-full bg-primary/95 text-primary-foreground flex items-center justify-center shadow-[0_0_0_8px_hsl(172_66%_50%/0.2)] hover:scale-105 transition-transform">
                <Play className="h-8 w-8 ml-1" fill="currentColor" />
              </button>
            </div>
            <div className="absolute bottom-4 left-4 px-3 py-1.5 rounded-full bg-background/90 text-xs font-medium backdrop-blur-sm">
              {t("landing.hero.sampleBadge")}
            </div>
          </div>
        </div>
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
          <h2 className="font-serif text-[36px] md:text-[44px] font-semibold tracking-tight mb-3">{t("landing.outcomes.heading")}</h2>
          <p className="text-muted-foreground mb-12 max-w-2xl">{t("landing.outcomes.subheading")}</p>
          <div className="grid md:grid-cols-3 gap-6">
            {outcomes.map((item, i) => {
              const Icon = outcomeIcons[i] || Film;
              return (
                <div key={i} className="p-7 rounded-2xl bg-card border border-border shadow-soft">
                  <div className="w-11 h-11 rounded-xl bg-accent/60 flex items-center justify-center mb-5">
                    <Icon className="h-5 w-5 text-primary" />
                  </div>
                  <h3 className="font-serif text-2xl font-semibold mb-2">{item.title}</h3>
                  <p className="text-muted-foreground leading-relaxed">{item.body}</p>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      <section id="curriculum" className="py-20 md:py-28 bg-secondary/30">
        <div className="container">
          <h2 className="font-serif text-[36px] md:text-[44px] font-semibold tracking-tight mb-3">{t("landing.curriculum.heading")}</h2>
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
                        <span className="font-serif text-2xl text-primary tabular-nums">0{i + 1}</span>
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
            <h2 className="font-serif text-[36px] md:text-[44px] font-semibold tracking-tight mb-5">{t("landing.instructor.heading")}</h2>
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
                <div className="w-full h-full bg-cream-gradient flex items-center justify-center">
                  <span className="font-serif text-6xl text-primary">A</span>
                </div>
              )}
            </div>
          </div>
        </div>
      </section>

      <section className="py-20 md:py-28 bg-secondary/30">
        <div className="container">
          <h2 className="font-serif text-[36px] md:text-[44px] font-semibold tracking-tight mb-12">{t("landing.howItWorks.heading")}</h2>
          <div className="grid md:grid-cols-3 gap-8">
            {howSteps.map((s, i) => {
              const Icon = stepIcons[i] || Rocket;
              return (
                <div key={i} className="space-y-4">
                  <div className="flex items-baseline gap-3">
                    <span className="font-serif text-5xl text-primary tabular-nums leading-none">0{i + 1}</span>
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

      <section id="showcase" className="py-20 md:py-28">
        <div className="container">
          <h2 className="font-serif text-[36px] md:text-[44px] font-semibold tracking-tight mb-3">{t("landing.showcase.heading")}</h2>
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

      <section id="pricing" className="py-20 md:py-28 bg-secondary/30">
        <div className="container max-w-xl">
          <h2 className="font-serif text-[36px] md:text-[44px] font-semibold tracking-tight text-center mb-12">{t("landing.pricing.heading")}</h2>
          <div className="rounded-2xl border-2 border-primary/20 bg-card p-8 shadow-elevated">
            <div className="text-xs uppercase tracking-wider text-primary font-semibold mb-2">{t("landing.pricing.label")}</div>
            <div className="flex items-baseline gap-2 mb-6">
              <span className="font-serif text-5xl font-semibold">{t("landing.pricing.price")}</span>
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
          <h2 className="font-serif text-[36px] md:text-[44px] font-semibold tracking-tight mb-10 text-center">{t("landing.faq.heading")}</h2>
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
          <h2 className="font-serif text-[36px] md:text-[48px] font-semibold tracking-tight">{t("landing.finalCta.heading")}</h2>
          <p className="text-muted-foreground text-lg">{t("landing.finalCta.sub")}</p>
          <Button asChild size="lg" className="text-base h-12 px-8"><Link to="/signup">{t("landing.finalCta.button")} <ArrowRight className="h-5 w-5" /></Link></Button>
        </div>
      </section>

      <footer className="bg-background border-t border-border">
        <div className="container py-12 grid md:grid-cols-3 gap-8">
          <div className="space-y-4">
            <Brand />
            <p className="text-sm text-muted-foreground max-w-xs">{t("landing.footer.tagline")}</p>
            <div className="flex gap-3">
              <a href="https://t.me" target="_blank" rel="noreferrer" aria-label="Telegram" className="text-muted-foreground hover:text-primary transition-colors"><MessageCircle className="h-5 w-5" /></a>
              <a href="https://twitter.com" target="_blank" rel="noreferrer" aria-label="Twitter" className="text-muted-foreground hover:text-primary transition-colors"><Twitter className="h-5 w-5" /></a>
            </div>
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
