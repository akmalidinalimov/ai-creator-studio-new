import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import "./landing-split.css";
import { LANDING_SPLIT_HTML } from "./landingSplitHtml";

// Public marketing landing for the 5-week AI CREATORS challenge ("Split Hero").
// The design is the approved, mobile-verified page; its exact markup lives in
// landingSplitHtml.ts (trusted static content — no user input) and its CSS in
// landing-split.css, scoped under `.aicl` so nothing collides with the app's
// Tailwind. The vanilla interactions from the design are re-authored below as a
// scoped, cleaned-up effect (reveal-on-scroll, count-up, progress fill, deck
// parallax, the winners reel, the lead form, and the mobile nav).
//
// NOTE (follow-up before real traffic): the lead form currently shows a success
// state only — it does NOT persist the lead yet. Wiring capture (a leads table +
// admin Telegram notify via sendTelegram) is a separate PR.
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

    // --- winners reel (facade — real page mounts YouTube Shorts here) ---
    const reel = root.querySelector<HTMLElement>("#reel-track");
    if (reel && !reel.childElementCount) {
      const svg = '<svg width="18" height="18" viewBox="0 0 24 24" fill="#04150f"><path d="M8 5v14l11-7z"/></svg>';
      const WINS = [
        { e: "🕋", t: "Umra safarini yutdi" }, { e: "🏆", t: "Noutbuk yutdi" }, { e: "💸", t: "To'lovini qaytarib oldi" },
        { e: "🚀", t: "Birinchi mijozini topdi" }, { e: "💵", t: "AI bilan daromad qildi" }, { e: "💸", t: "To'lovini qaytarib oldi" },
        { e: "🏆", t: "Noutbuk yutdi" }, { e: "💼", t: "Portfolio to'pladi" }, { e: "🎓", t: "Sertifikat bilan yakunladi" },
        { e: "🕋", t: "Umra safarini yutdi" },
      ];
      const mkCard = (w: { e: string; t: string }) =>
        `<div class="vtest"><span class="yt">${w.e} Sovrindor</span><span class="loop">Ovozsiz</span>` +
        `<div class="play-sm">${svg}</div><div class="vloader"></div>` +
        `<div class="who"><b>${w.t}</b><span>Bosib ovoz bilan ko'ring</span></div></div>`;
      let html = "";
      for (let k = 0; k < 2; k++) WINS.forEach((w) => { html += mkCard(w); });
      reel.innerHTML = html;
    }

    // --- lead form (success state only for now; see NOTE above) ---
    const form = root.querySelector<HTMLFormElement>("#leadForm");
    if (form) {
      const onSubmit = (e: Event) => {
        e.preventDefault();
        const i = root.querySelector<HTMLInputElement>("#ism");
        const t = root.querySelector<HTMLInputElement>("#tel");
        const ok = root.querySelector<HTMLElement>("#okMsg");
        if (i && t && i.value.trim() && t.value.trim()) {
          if (ok) ok.style.display = "block";
          form.reset();
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
