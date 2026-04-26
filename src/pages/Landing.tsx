import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { SuzaniStar } from "@/components/landing/SuzaniStar";
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

const DEFAULT_FAQ = [
  { q: "Do I need any AI experience to start?", a: "No. The first module assumes zero background — you'll be generating images by lesson 3." },
  { q: "How much time per week?", a: "3–5 hours. The full curriculum is ~14 hours; most students finish in 4–6 weeks." },
  { q: "Can I follow on my phone?", a: "Yes. The video player and AI tutor are mobile-first. Lessons stream in adaptive HD." },
  { q: "What if I get stuck on a lesson?", a: "Every lesson has the AI Study Assistant — it's trained on the transcript and can explain, summarize, or quiz you." },
  { q: "Do you provide certificates?", a: "Module-level certificates of completion will roll out in the next update." },
  { q: "Is the content in English, Russian, or Uzbek?", a: "Lessons are taught in English with Russian and Uzbek subtitles. UI is fully translated." },
  { q: "Can I download the videos?", a: "No — videos stream from secure storage to protect creator IP. Notes and transcripts are downloadable." },
  { q: "How do I cancel?", a: "Signup is free. There's nothing to cancel until our premium tier launches." },
];

const SHOWCASE = [
  { url: "https://images.unsplash.com/photo-1542831371-29b0f74f9713?w=800&q=80", name: "Aziza · Tashkent", type: "Mini-film · Module 3" },
  { url: "https://images.unsplash.com/photo-1635776062127-d379bfcba9f8?w=800&q=80", name: "Bekzod · Samarkand", type: "Brand identity · Module 2" },
  { url: "https://images.unsplash.com/photo-1620641788421-7a1c342ea42e?w=800&q=80", name: "Madina · Almaty", type: "Editorial series · Module 2" },
  { url: "https://images.unsplash.com/photo-1633101585272-9e0b0c3d9c3c?w=800&q=80", name: "Rustam · Bishkek", type: "Music video · Module 3" },
  { url: "https://images.unsplash.com/photo-1655720828018-edd2daec9349?w=800&q=80", name: "Nilufar · Bukhara", type: "Product launch · Module 5" },
  { url: "https://images.unsplash.com/photo-1614729939124-032d1e6d7b48?w=800&q=80", name: "Diyor · Khiva", type: "Short film · Module 4" },
];

const fmtMin = (s?: number | null) => {
  if (!s) return "";
  const m = Math.round(s / 60);
  return `${m} min`;
};

const Brand = ({ to = "/" }: { to?: string }) => (
  <Link to={to} className="flex items-center gap-2 font-semibold tracking-tight">
    <span className="inline-flex items-center justify-center w-7 h-7 rounded-lg bg-primary text-primary-foreground text-[13px] font-bold ring-[3px] ring-primary/10">A</span>
    <span className="text-[15px]">AI Creators</span>
  </Link>
);

export default function Landing() {
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
      // Load default-for-signup published course's curriculum
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
        lessons: (m.lessons || [])
          .filter((l: any) => l.published)
          .sort((a: any, b: any) => a.position - b.position),
      }));
      setModules(cleaned);
    })();

    // Load admin-editable copy
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

  const faq = copy.faq && copy.faq.length > 0 ? copy.faq : DEFAULT_FAQ;
  const headline = copy.headline || "Build, ship, and monetize {with AI}.";
  const sub = copy.sub || "A 14-hour curriculum for the new generation of AI-native creators. Foundations to image, video, content, and monetization — without the fluff. Five modules, twenty lessons, designed to compound.";

  // Render headline: split on {...} tokens for italic teal
  const renderHeadline = (text: string) => {
    const parts = text.split(/(\{[^}]+\})/g);
    return parts.map((p, i) => {
      if (p.startsWith("{") && p.endsWith("}")) {
        return <em key={i} className="text-primary not-italic font-serif italic">{p.slice(1, -1)}</em>;
      }
      return <span key={i}>{p}</span>;
    });
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* NAV */}
      <header
        className={`fixed top-0 inset-x-0 z-40 transition-all duration-300 ${
          scrolled ? "bg-background/85 backdrop-blur-md border-b border-border" : "bg-transparent"
        }`}
      >
        <div className="container flex h-16 items-center justify-between gap-4">
          <Brand />
          <nav className="hidden md:flex items-center gap-7 text-sm">
            <a href="#curriculum" className="text-muted-foreground hover:text-foreground transition-colors">Curriculum</a>
            <a href="#instructor" className="text-muted-foreground hover:text-foreground transition-colors">Instructor</a>
            <a href="#pricing" className="text-muted-foreground hover:text-foreground transition-colors">Pricing</a>
            <a href="#faq" className="text-muted-foreground hover:text-foreground transition-colors">FAQ</a>
          </nav>
          <div className="flex items-center gap-2">
            <Button asChild variant="outline" size="sm" className="hidden sm:inline-flex">
              <Link to="/login">Sign in</Link>
            </Button>
            <Button asChild size="sm">
              <Link to="/signup">Start free <ArrowRight className="h-3.5 w-3.5" /></Link>
            </Button>
          </div>
        </div>
      </header>

      {/* HERO */}
      <section className="relative pt-28 md:pt-32 pb-16 md:pb-24 overflow-hidden">
        <div className="absolute top-32 -left-16 text-primary/[0.07] pointer-events-none hidden md:block">
          <SuzaniStar size={520} />
        </div>
        <div className="container relative grid md:grid-cols-2 gap-10 lg:gap-16 items-center">
          <div className="space-y-6 max-w-xl">
            <h1 className="font-serif text-[40px] md:text-[56px] leading-[1.05] font-semibold tracking-tight">
              {renderHeadline(headline)}
            </h1>
            <p className="text-lg text-muted-foreground leading-relaxed">{sub}</p>
            <div className="flex flex-wrap gap-3 pt-2">
              <Button asChild size="lg" className="gap-2">
                <Link to="/signup">Start learning free <ArrowRight className="h-4 w-4" /></Link>
              </Button>
              <Button asChild size="lg" variant="outline">
                <a href="#curriculum">View curriculum</a>
              </Button>
            </div>
            <div className="flex items-center gap-3 pt-4">
              <div className="flex -space-x-2">
                {[0, 1, 2, 3].map((i) => (
                  <div
                    key={i}
                    className="w-8 h-8 rounded-full border-2 border-background"
                    style={{ background: `hsl(${174 + i * 20}, 50%, ${40 + i * 8}%)` }}
                  />
                ))}
              </div>
              <p className="text-sm text-muted-foreground">
                Joined by <span className="font-medium text-foreground">1,247 creators</span> · 4.9/5 rating
              </p>
            </div>
          </div>

          {/* Hero art */}
          <div className="relative aspect-[5/4] rounded-[22px] overflow-hidden shadow-elevated"
               style={{ background: "linear-gradient(135deg, hsl(174 78% 26%) 0%, hsl(180 60% 8%) 100%)" }}>
            <div className="absolute inset-0 opacity-60"
                 style={{ background: "radial-gradient(circle at 70% 30%, hsl(43 89% 38% / 0.35) 0%, transparent 60%)" }} />
            <div className="absolute inset-0 flex items-center justify-center">
              <button
                aria-label="Play sample"
                className="w-20 h-20 rounded-full bg-primary/95 text-primary-foreground flex items-center justify-center shadow-[0_0_0_8px_hsl(172_66%_50%/0.2)] hover:scale-105 transition-transform"
              >
                <Play className="h-8 w-8 ml-1" fill="currentColor" />
              </button>
            </div>
            <div className="absolute bottom-4 left-4 px-3 py-1.5 rounded-full bg-background/90 text-xs font-medium backdrop-blur-sm">
              Sample lesson · 8 min
            </div>
          </div>
        </div>
      </section>

      {/* TRUST BAR */}
      <section className="border-y border-border bg-secondary/40">
        <div className="container py-5 flex flex-wrap items-center justify-center gap-x-10 gap-y-2 text-sm">
          <span className="text-muted-foreground"><span className="font-semibold text-foreground">1,247</span> creators</span>
          <span className="hidden sm:block w-px h-4 bg-border" />
          <span className="text-muted-foreground"><span className="font-semibold text-foreground">4.9/5</span> rating</span>
          <span className="hidden sm:block w-px h-4 bg-border" />
          <span className="text-muted-foreground"><span className="font-semibold text-foreground">30+</span> countries</span>
          <span className="hidden sm:block w-px h-4 bg-border" />
          <span className="text-muted-foreground"><span className="font-semibold text-foreground">14h</span> of curriculum</span>
        </div>
      </section>

      {/* OUTCOMES */}
      <section id="outcomes" className="py-20 md:py-28">
        <div className="container">
          <h2 className="font-serif text-[36px] md:text-[44px] font-semibold tracking-tight mb-3">By the end, you will:</h2>
          <p className="text-muted-foreground mb-12 max-w-2xl">Three concrete outcomes — not vague promises.</p>
          <div className="grid md:grid-cols-3 gap-6">
            {[
              { Icon: Film, title: "Ship a mini-film.", body: "From script to anchor frames to multishot animation. By the end of module 3, you have a finished film." },
              { Icon: Wand2, title: "Build a recognizable style.", body: "Composition, references, palettes. Students leave with a visual signature, not a prompt cheat-sheet." },
              { Icon: DollarSign, title: "Turn skill into income.", body: "Productize, sell, scale. Module 5 covers offers, pricing, and the launch playbook that actually works." },
            ].map(({ Icon, title, body }) => (
              <div key={title} className="p-7 rounded-2xl bg-card border border-border shadow-soft">
                <div className="w-11 h-11 rounded-xl bg-accent/60 flex items-center justify-center mb-5">
                  <Icon className="h-5 w-5 text-primary" />
                </div>
                <h3 className="font-serif text-2xl font-semibold mb-2">{title}</h3>
                <p className="text-muted-foreground leading-relaxed">{body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CURRICULUM */}
      <section id="curriculum" className="py-20 md:py-28 bg-secondary/30">
        <div className="container">
          <h2 className="font-serif text-[36px] md:text-[44px] font-semibold tracking-tight mb-3">What you'll learn over 14 hours</h2>
          <p className="text-muted-foreground mb-10 max-w-2xl">Five modules. Twenty lessons. Built to compound.</p>

          {modules.length === 0 ? (
            <div className="rounded-xl border border-border bg-card p-10 text-center text-muted-foreground">
              Curriculum coming soon.
            </div>
          ) : (
            <Accordion type="single" collapsible defaultValue={modules[0]?.id} className="space-y-3">
              {modules.map((m, i) => {
                const totalSec = m.lessons.reduce((s, l) => s + (l.duration_seconds || 0), 0);
                const totalMin = Math.round(totalSec / 60);
                return (
                  <AccordionItem
                    key={m.id}
                    value={m.id}
                    className="border border-border rounded-xl bg-card px-5 shadow-soft"
                  >
                    <AccordionTrigger className="hover:no-underline py-5">
                      <div className="flex items-center gap-4 text-left">
                        <span className="font-serif text-2xl text-primary tabular-nums">0{i + 1}</span>
                        <div>
                          <div className="font-semibold text-base">{m.title}</div>
                          <div className="text-xs text-muted-foreground mt-0.5">{m.lessons.length} lessons · {totalMin} min</div>
                        </div>
                      </div>
                    </AccordionTrigger>
                    <AccordionContent className="pb-5">
                      <ul className="space-y-2 pl-12">
                        {m.lessons.map((l) => (
                          <li key={l.id} className="flex items-center justify-between text-sm border-b border-border/50 pb-2 last:border-b-0 last:pb-0">
                            <span className="text-foreground/80">{l.title}</span>
                            {l.duration_seconds && (
                              <span className="text-xs text-muted-foreground tabular-nums">{fmtMin(l.duration_seconds)}</span>
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

      {/* INSTRUCTOR */}
      <section id="instructor" className="py-20 md:py-28">
        <div className="container grid md:grid-cols-[1fr_240px] gap-10 md:gap-16 items-center">
          <div>
            <h2 className="font-serif text-[36px] md:text-[44px] font-semibold tracking-tight mb-5">Meet your instructor</h2>
            <div className="space-y-4 text-muted-foreground leading-relaxed prose-tight max-w-2xl">
              {(copy.instructorBio || "An AI-native filmmaker, designer, and educator. Built award-winning short films using only AI tools, taught hundreds of students across Central Asia, and shipped commercial work for brands like Uzum, Humo, and Click. This curriculum is the playbook used to do it.")
                .split("\n\n")
                .map((p, i) => <p key={i}>{p}</p>)}
            </div>
            <div className="mt-5 inline-flex items-center gap-2 text-sm text-primary font-medium">
              <Star className="h-4 w-4 fill-current" />
              Built X · taught Y · shipped Z
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

      {/* HOW IT WORKS */}
      <section className="py-20 md:py-28 bg-secondary/30">
        <div className="container">
          <h2 className="font-serif text-[36px] md:text-[44px] font-semibold tracking-tight mb-12">How it works</h2>
          <div className="grid md:grid-cols-3 gap-8">
            {[
              { Icon: UserPlus, title: "Sign up free.", body: "One click with Telegram, Google, or email. No card required." },
              { Icon: BookOpen, title: "Watch and take notes.", body: "Lessons stream in HD. Your AI Study Assistant has the transcript memorized." },
              { Icon: Rocket, title: "Ship your first project.", body: "Module exercises produce real work — image sets, scripts, mini-films, offers." },
            ].map((s, i) => (
              <div key={s.title} className="space-y-4">
                <div className="flex items-baseline gap-3">
                  <span className="font-serif text-5xl text-primary tabular-nums leading-none">0{i + 1}</span>
                  <s.Icon className="h-5 w-5 text-muted-foreground" />
                </div>
                <h3 className="font-semibold text-lg">{s.title}</h3>
                <p className="text-muted-foreground leading-relaxed">{s.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* SHOWCASE */}
      <section id="showcase" className="py-20 md:py-28">
        <div className="container">
          <h2 className="font-serif text-[36px] md:text-[44px] font-semibold tracking-tight mb-3">What our students build.</h2>
          <p className="text-muted-foreground mb-10 max-w-2xl">Module exercises, capstone projects, and commercial work — shipped by students across the curriculum.</p>
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

      {/* PRICING */}
      <section id="pricing" className="py-20 md:py-28 bg-secondary/30">
        <div className="container max-w-xl">
          <h2 className="font-serif text-[36px] md:text-[44px] font-semibold tracking-tight text-center mb-12">
            Start free. Upgrade when you're hooked.
          </h2>
          <div className="rounded-2xl border-2 border-primary/20 bg-card p-8 shadow-elevated">
            <div className="text-xs uppercase tracking-wider text-primary font-semibold mb-2">AI Creators · Full Course</div>
            <div className="flex items-baseline gap-2 mb-6">
              <span className="font-serif text-5xl font-semibold">Free</span>
              <span className="text-muted-foreground text-sm">for now</span>
            </div>
            <ul className="space-y-3 mb-8">
              {[
                "All 5 modules · 20 lessons · 14 hours",
                "AI Study Assistant trained on every lesson",
                "Streaming HD video on every device",
                "Notes, bookmarks, and transcripts",
                "Telegram-native sign-in",
                "New lessons added monthly",
              ].map((f) => (
                <li key={f} className="flex items-start gap-2 text-sm">
                  <CheckCircle2 className="h-4 w-4 text-primary mt-0.5 shrink-0" />
                  <span>{f}</span>
                </li>
              ))}
            </ul>
            <Button asChild size="lg" className="w-full">
              <Link to="/signup">Start learning free <ArrowRight className="h-4 w-4" /></Link>
            </Button>
          </div>
          <p className="text-xs text-center text-muted-foreground mt-4">
            Premium tier coming soon · taught in English with Russian + Uzbek subtitles.
          </p>
        </div>
      </section>

      {/* FAQ */}
      <section id="faq" className="py-20 md:py-28">
        <div className="container max-w-3xl">
          <h2 className="font-serif text-[36px] md:text-[44px] font-semibold tracking-tight mb-10 text-center">Questions, answered.</h2>
          <Accordion type="single" collapsible className="space-y-2">
            {faq.map((item, i) => (
              <AccordionItem
                key={i}
                value={`q-${i}`}
                className="border border-border rounded-xl bg-card px-5"
              >
                <AccordionTrigger className="hover:no-underline py-4 text-left text-base font-medium">
                  {item.q}
                </AccordionTrigger>
                <AccordionContent className="pb-4 text-muted-foreground leading-relaxed">
                  {item.a}
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </div>
      </section>

      {/* FINAL CTA */}
      <section className="py-20 md:py-28 bg-secondary/60 border-y border-border">
        <div className="container max-w-2xl text-center space-y-6">
          <h2 className="font-serif text-[36px] md:text-[48px] font-semibold tracking-tight">
            Ready to start building?
          </h2>
          <p className="text-muted-foreground text-lg">Free signup · 2 minutes · cancel anytime.</p>
          <Button asChild size="lg" className="text-base h-12 px-8">
            <Link to="/signup">Start learning free <ArrowRight className="h-5 w-5" /></Link>
          </Button>
        </div>
      </section>

      {/* FOOTER */}
      <footer className="bg-background border-t border-border">
        <div className="container py-12 grid md:grid-cols-3 gap-8">
          <div className="space-y-4">
            <Brand />
            <p className="text-sm text-muted-foreground max-w-xs">A 14-hour curriculum for AI-native creators. Built in Tashkent, taught everywhere.</p>
            <div className="flex gap-3">
              <a href="https://t.me" target="_blank" rel="noreferrer" aria-label="Telegram" className="text-muted-foreground hover:text-primary transition-colors">
                <MessageCircle className="h-5 w-5" />
              </a>
              <a href="https://twitter.com" target="_blank" rel="noreferrer" aria-label="Twitter" className="text-muted-foreground hover:text-primary transition-colors">
                <Twitter className="h-5 w-5" />
              </a>
            </div>
          </div>
          <div className="space-y-3 text-sm">
            <div className="font-semibold text-xs uppercase tracking-wider text-muted-foreground">Course</div>
            <div className="space-y-2">
              <a href="#curriculum" className="block hover:text-primary">Curriculum</a>
              <a href="#instructor" className="block hover:text-primary">Instructor</a>
              <a href="#pricing" className="block hover:text-primary">Pricing</a>
              <a href="#faq" className="block hover:text-primary">FAQ</a>
            </div>
          </div>
          <div className="space-y-3 text-sm">
            <div className="font-semibold text-xs uppercase tracking-wider text-muted-foreground">Company</div>
            <div className="space-y-2">
              <Link to="/login" className="block hover:text-primary">Sign in</Link>
              <Link to="/signup" className="block hover:text-primary">Sign up</Link>
              <a href="mailto:hello@aicreators.app" className="block hover:text-primary">Contact</a>
            </div>
          </div>
        </div>
        <div className="border-t border-border">
          <div className="container py-5 text-xs text-muted-foreground flex flex-wrap items-center justify-between gap-2">
            <span>© 2026 AI Creators · Made in Tashkent</span>
            <span>{courseTitle}</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
