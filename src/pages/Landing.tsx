import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import "./landing-split.css";
import "./landingReel.css";
import { LANDING_SPLIT_HTML } from "./landingSplitHtml";

// Public marketing landing for the 5-week AI CREATORS challenge ("Split Hero").
// The design is the approved, mobile-verified page; its exact markup lives in
// landingSplitHtml.ts (trusted static content — no user input) and its CSS in
// landing-split.css, scoped under `.aicl` so nothing collides with the app's
// Tailwind. The vanilla interactions from the design are re-authored below as a
// scoped, cleaned-up effect (reveal-on-scroll, count-up, progress fill, deck
// parallax, the winners reel, the lead form, and the mobile nav).
//
// The lead form POSTs to the submit-lead edge function (via the /sb proxy): it persists the
// lead and DMs admins. Media (welcome video, teacher photos) are still placeholders.
export default function Landing() {
  const { user, role, loading } = useAuth();
  const nav = useNavigate();
  const rootRef = useRef<HTMLDivElement>(null);

  // Logged-in visitors skip the marketing page.
  useEffect(() => {
    if (!loading && user) {
      nav(role === "admin" ? "/admin/dashboard" : "/dashboard", { replace: true });
    }
  }, [user, role, loading, nav]);

  // Interactions for the injected markup. Everything is scoped to `root` and
  // torn down on unmount so a second mount (StrictMode) never double-binds.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const rm = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const hasIO = "IntersectionObserver" in window;
    const cleanups: Array<() => void> = [];
    const observers: IntersectionObserver[] = [];
    const qa = (sel: string) => Array.from(root.querySelectorAll<HTMLElement>(sel));

    // --- scroll-reveal ---
    if (hasIO && !rm) {
      const io = new IntersectionObserver(
        (entries) => entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } }),
        { threshold: 0.14, rootMargin: "0px 0px -8% 0px" },
      );
      qa(".reveal").forEach((el) => io.observe(el));
      observers.push(io);
    } else {
      qa(".reveal").forEach((el) => el.classList.add("in"));
    }

    // --- count-up ---
    const animateCount = (el: HTMLElement) => {
      const target = parseFloat(el.getAttribute("data-count") || "");
      const suffix = el.getAttribute("data-suffix") || "";
      if (isNaN(target)) return;
      if (rm) { el.textContent = target.toLocaleString("ru-RU") + suffix; return; }
      const dur = 1300;
      let t0: number | null = null;
      const step = (ts: number) => {
        if (t0 === null) t0 = ts;
        const p = Math.min((ts - t0) / dur, 1);
        const eased = 1 - Math.pow(1 - p, 3);
        el.textContent = Math.round(target * eased).toLocaleString("ru-RU") + suffix;
        if (p < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    };
    if (hasIO) {
      const cIO = new IntersectionObserver(
        (entries) => entries.forEach((e) => { if (e.isIntersecting) { animateCount(e.target as HTMLElement); cIO.unobserve(e.target); } }),
        { threshold: 0.6 },
      );
      qa("[data-count]").forEach((el) => cIO.observe(el));
      observers.push(cIO);
    } else {
      qa("[data-count]").forEach(animateCount);
    }

    // --- mission progress bar fill ---
    const pf = root.querySelector<HTMLElement>(".prog-fill");
    if (pf) {
      const to = () => { pf.style.width = (pf.getAttribute("data-fill") || "1.5") + "%"; };
      if (rm || !hasIO) { to(); }
      else {
        pf.style.width = "0";
        const pIO = new IntersectionObserver(
          (entries) => entries.forEach((e) => { if (e.isIntersecting) { to(); pIO.unobserve(e.target); } }),
          { threshold: 0.6 },
        );
        pIO.observe(pf);
        observers.push(pIO);
      }
    }

    // --- interactive deck: bar fills + cursor-tilt parallax ---
    const stage = root.querySelector<HTMLElement>(".stage");
    const fillBars = () => qa(".barline i[data-w]").forEach((i) => { i.style.width = i.getAttribute("data-w") || ""; });
    if (stage) {
      if (rm || !hasIO) { fillBars(); }
      else {
        const sIO = new IntersectionObserver(
          (es) => es.forEach((e) => { if (e.isIntersecting) { fillBars(); sIO.disconnect(); } }),
          { threshold: 0.2 },
        );
        sIO.observe(stage);
        observers.push(sIO);
        const deck = stage.querySelector<HTMLElement>(".deck");
        if (deck) {
          const onMove = (ev: MouseEvent) => {
            const r = stage.getBoundingClientRect();
            const cx = (ev.clientX - r.left) / r.width - 0.5;
            const cy = (ev.clientY - r.top) / r.height - 0.5;
            deck.style.transform = `rotateX(${(14 - cy * 7).toFixed(2)}deg) rotateY(${(cx * 9).toFixed(2)}deg)`;
          };
          const onLeave = () => { deck.style.transform = ""; };
          stage.addEventListener("mousemove", onMove);
          stage.addEventListener("mouseleave", onLeave);
          cleanups.push(() => { stage.removeEventListener("mousemove", onMove); stage.removeEventListener("mouseleave", onLeave); });
        }
      }
    }

    // --- video placeholders (styled play-cards, no real media yet) ---
    qa("[data-video]").forEach((el) => {
      const stop = (ev: Event) => ev.preventDefault();
      el.addEventListener("click", stop);
      cleanups.push(() => el.removeEventListener("click", stop));
    });

    // --- winners reel: real YouTube Shorts. Cards AUTOPLAY MUTED inline once they
    // scroll into view; a tap opens the 9:16 lightbox WITH sound. An
    // IntersectionObserver keeps only the on-screen cards mounted as live players,
    // so the marquee/scroll never runs more than a handful of iframes at once.
    const reel = root.querySelector<HTMLElement>("#reel-track");
    const reelVp = root.querySelector<HTMLElement>(".reel-viewport");
    const WINS: { id: string; e: string; t: string }[] = [
      { id: "kBQlU9VRI_g", e: "💵", t: "$300 ishlab topdi" },
      { id: "ufYKqrVJLVM", e: "✈️", t: "Turkiyaga sayohat yutdi" },
      { id: "4MH0YAs3KGQ", e: "💸", t: "To'lovini qaytarib oldi" },
      { id: "Bt7IMFxZdIg", e: "💸", t: "To'lovini qaytarib oldi" },
      { id: "OEHU549lPTI", e: "💸", t: "To'lovini qaytarib oldi" },
      { id: "jSCytXorYPg", e: "🚀", t: "AI'ni biznesiga qo'shdi" },
      { id: "9ggvrMGDQ3A", e: "🎓", t: "Sertifikat bilan yakunladi" },
      { id: "vUx_7TqWfoE", e: "🎓", t: "Sertifikat bilan yakunladi" },
    ];
    const playSvg = '<svg width="18" height="18" viewBox="0 0 24 24" fill="#04150f"><path d="M8 5v14l11-7z"/></svg>';
    const attr = (s: string) => s.replace(/"/g, "&quot;");
    const mkCard = (w: { id: string; e: string; t: string }, dup: boolean) =>
      `<button type="button" class="vtest" data-vid="${w.id}"${dup ? ' aria-hidden="true" tabindex="-1"' : ""}` +
      ` aria-label="${attr(w.t)} — ovoz bilan ochish"` +
      ` style="background-image:url('https://i.ytimg.com/vi/${w.id}/hqdefault.jpg'),linear-gradient(160deg,#0f1c18,#0a130f)">` +
      `<span class="yt">${w.e} Sovrindor</span><span class="loop">🔇 Ovozsiz</span>` +
      `<div class="play-sm">${playSvg}</div>` +
      `<div class="who"><b>${attr(w.t)}</b><span>Ovoz uchun bosing</span></div></button>`;
    // Mount a muted, looping, controls-off preview inside a card; remove it when off-screen.
    const mountFrame = (card: Element) => {
      if (card.querySelector("iframe")) return;
      const id = card.getAttribute("data-vid");
      if (!id) return;
      const ifr = document.createElement("iframe");
      ifr.className = "vfill";
      ifr.src =
        `https://www.youtube.com/embed/${id}?autoplay=1&mute=1&loop=1&playlist=${id}` +
        `&controls=0&modestbranding=1&playsinline=1&rel=0&disablekb=1&fs=0&iv_load_policy=3`;
      ifr.title = "Sovrindor videosi (ovozsiz)";
      ifr.setAttribute("allow", "autoplay; encrypted-media; picture-in-picture");
      ifr.setAttribute("tabindex", "-1");
      ifr.setAttribute("aria-hidden", "true");
      card.insertBefore(ifr, card.firstChild);
      card.classList.add("playing");
    };
    const unmountFrame = (card: Element) => {
      const ifr = card.querySelector("iframe");
      if (ifr) ifr.remove();
      card.classList.remove("playing");
    };
    if (reel && !reel.childElementCount) {
      let html = "";
      WINS.forEach((w) => { html += mkCard(w, false); });
      WINS.forEach((w) => { html += mkCard(w, true); });
      reel.innerHTML = html;
      if ("IntersectionObserver" in window) {
        const io = new IntersectionObserver(
          (entries) => {
            entries.forEach((en) => {
              if (en.isIntersecting) mountFrame(en.target);
              else unmountFrame(en.target);
            });
          },
          { root: reelVp ?? null, rootMargin: "0px 240px", threshold: 0.25 }
        );
        reel.querySelectorAll<HTMLElement>(".vtest").forEach((c) => io.observe(c));
        cleanups.push(() => io.disconnect());
      }
    }

    // lightbox for the reel videos
    let modal = root.querySelector<HTMLElement>(".vmodal");
    if (!modal) {
      modal = document.createElement("div");
      modal.className = "vmodal";
      modal.setAttribute("role", "dialog");
      modal.setAttribute("aria-modal", "true");
      modal.innerHTML = '<div class="vbox"><button type="button" class="vclose" aria-label="Yopish">×</button></div>';
      root.appendChild(modal);
    }
    const vbox = modal.querySelector<HTMLElement>(".vbox");
    const openVid = (id: string) => {
      if (!vbox || !modal) return;
      const prev = vbox.querySelector("iframe");
      if (prev) prev.remove();
      const ifr = document.createElement("iframe");
      ifr.src = `https://www.youtube.com/embed/${id}?autoplay=1&playsinline=1&rel=0`;
      ifr.title = "Sovrindor videosi";
      ifr.setAttribute("allow", "autoplay; encrypted-media; fullscreen; picture-in-picture");
      ifr.setAttribute("allowfullscreen", "");
      vbox.appendChild(ifr);
      modal.classList.add("open");
      document.body.style.overflow = "hidden";
    };
    const closeVid = () => {
      if (!modal) return;
      modal.classList.remove("open");
      const ifr = modal.querySelector("iframe");
      if (ifr) ifr.remove();
      document.body.style.overflow = "";
    };
    const onReelClick = (e: MouseEvent) => {
      const card = (e.target as HTMLElement).closest?.(".vtest[data-vid]") as HTMLElement | null;
      if (card) { e.preventDefault(); const id = card.getAttribute("data-vid"); if (id) openVid(id); }
    };
    const onModalClick = (e: MouseEvent) => {
      const tgt = e.target as HTMLElement;
      if (tgt === modal || tgt.classList.contains("vclose")) closeVid();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") closeVid(); };
    root.addEventListener("click", onReelClick);
    modal.addEventListener("click", onModalClick);
    document.addEventListener("keydown", onKey);
    cleanups.push(() => {
      root.removeEventListener("click", onReelClick);
      modal?.removeEventListener("click", onModalClick);
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    });

    // --- lead form → submit-lead edge fn (persists + DMs admins; routed via /sb proxy) ---
    const form = root.querySelector<HTMLFormElement>("#leadForm");
    if (form) {
      // Honeypot: bots fill this hidden field; the edge fn silently drops those submissions.
      let hp = form.querySelector<HTMLInputElement>('input[name="company"]');
      if (!hp) {
        hp = document.createElement("input");
        hp.type = "text";
        hp.name = "company";
        hp.tabIndex = -1;
        hp.autocomplete = "off";
        hp.setAttribute("aria-hidden", "true");
        hp.style.cssText = "position:absolute;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none";
        form.appendChild(hp);
      }
      const btn = form.querySelector<HTMLButtonElement>('button[type="submit"]');
      const onSubmit = async (e: Event) => {
        e.preventDefault();
        const i = root.querySelector<HTMLInputElement>("#ism");
        const t = root.querySelector<HTMLInputElement>("#tel");
        const ok = root.querySelector<HTMLElement>("#okMsg");
        if (!i || !t || !i.value.trim() || !t.value.trim()) return;
        const name = i.value.trim();
        const phone = t.value.trim();
        const company = hp?.value ?? "";
        const restore = btn?.innerHTML ?? "";
        if (btn) { btn.disabled = true; btn.textContent = "Yuborilmoqda…"; }
        try {
          const { error } = await supabase.functions.invoke("submit-lead", {
            body: { name, phone, source: "landing", company },
          });
          if (error) throw error;
          if (ok) { ok.textContent = "✓ Rahmat! Tez orada bogʻlanamiz."; ok.style.color = ""; ok.style.display = "block"; }
          form.reset();
        } catch (err) {
          if (ok) {
            ok.textContent = "Yuborishda xatolik. Iltimos, birozdan soʻng qayta urinib koʻring.";
            ok.style.color = "#ff9d86";
            ok.style.display = "block";
          }
          // Make a broken lead path DB-visible (best-effort; never blocks the user).
          try {
            void supabase.functions.invoke("client-beacon", {
              body: { event_type: "other", message: "lead_submit_failed", route: "/", extra: { e: String((err as { message?: string })?.message ?? err) } },
            });
          } catch { /* noop */ }
        } finally {
          if (btn) { btn.disabled = false; btn.innerHTML = restore; }
        }
      };
      form.addEventListener("submit", onSubmit);
      cleanups.push(() => form.removeEventListener("submit", onSubmit));
    }

    // --- mobile nav toggle ---
    const tog = root.querySelector<HTMLElement>(".navtoggle");
    if (tog) {
      const onTog = () => {
        const l = root.querySelector<HTMLElement>(".nav-links");
        if (!l) return;
        const vis = l.style.display === "flex";
        l.style.display = vis ? "none" : "flex";
        l.style.position = "absolute"; l.style.top = "66px"; l.style.left = "0"; l.style.right = "0";
        l.style.flexDirection = "column"; l.style.background = "var(--bg-2)"; l.style.padding = "16px 24px";
        l.style.borderBottom = "1px solid var(--line)"; l.style.gap = "14px";
      };
      tog.addEventListener("click", onTog);
      cleanups.push(() => tog.removeEventListener("click", onTog));
    }

    // --- a "Kirish" (login) entry so returning students still have a way in ---
    const navRight = root.querySelector(".nav-right");
    if (navRight && !root.querySelector("[data-login-link]")) {
      const a = document.createElement("a");
      a.setAttribute("href", "/login");
      a.setAttribute("data-login-link", "");
      a.textContent = "Kirish";
      a.className = "btn btn-ghost";
      a.style.cssText = "padding:10px 18px;font-size:14px";
      navRight.insertBefore(a, navRight.firstChild);
    }

    // --- SPA-navigate internal links (e.g. the "Kirish" link → /login) ---
    const onClick = (ev: MouseEvent) => {
      const a = (ev.target as HTMLElement).closest?.("a");
      if (!a) return;
      const href = a.getAttribute("href") || "";
      if (href.startsWith("/") && !href.startsWith("//")) { ev.preventDefault(); nav(href); }
    };
    root.addEventListener("click", onClick);
    cleanups.push(() => root.removeEventListener("click", onClick));

    return () => {
      observers.forEach((o) => o.disconnect());
      cleanups.forEach((fn) => fn());
    };
  }, [nav]);

  return (
    <div
      ref={rootRef}
      className="aicl"
      style={{ minHeight: "100dvh" }}
      // Trusted static marketing markup generated at build time (landingSplitHtml.ts) — no user input.
      dangerouslySetInnerHTML={{ __html: LANDING_SPLIT_HTML }}
    />
  );
}
