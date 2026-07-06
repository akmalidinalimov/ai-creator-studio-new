import { useEffect, useRef } from "react";

/**
 * The logo's pixel-dissolve motif as an ambient background: teal squares dense
 * at an anchor point, scattering outward with a gentle twinkle. Honors
 * prefers-reduced-motion by drawing a single static frame (no rAF loop).
 */
export function PixelDissolve({ className, density = 9000 }: { className?: string; density?: number }) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    let squares: { x: number; y: number; s: number; o: number; tw: number }[] = [];

    const build = () => {
      const w = (canvas.width = canvas.offsetWidth);
      const h = (canvas.height = canvas.offsetHeight);
      const cx = w * 0.82;
      const cy = h * 0.3;
      const reach = Math.min(w, h) * 0.62;
      squares = [];
      const n = Math.min(150, Math.round((w * h) / density));
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        const r = Math.pow(Math.random(), 1.7) * reach;
        const near = 1 - Math.min(1, r / reach);
        squares.push({
          x: cx + Math.cos(a) * r,
          y: cy + Math.sin(a) * r * 0.9,
          s: 6 + Math.random() * 22 * near,
          o: 0.05 + near * 0.5,
          tw: Math.random() * 6.28,
        });
      }
    };

    let t = 0;
    const frame = (twinkle: boolean) => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (const p of squares) {
        const o = twinkle ? p.o * (0.6 + 0.4 * Math.sin(t + p.tw)) : p.o;
        ctx.fillStyle = `rgba(47,179,155,${o.toFixed(3)})`;
        ctx.fillRect(p.x - p.s / 2, p.y - p.s / 2, p.s, p.s);
      }
    };

    const loop = () => {
      t += 0.02;
      frame(true);
      raf = requestAnimationFrame(loop);
    };

    build();
    if (reduce) {
      frame(false);
    } else {
      loop();
    }

    const onResize = () => {
      build();
      if (reduce) frame(false);
    };
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
    };
  }, [density]);

  return <canvas ref={ref} className={className} aria-hidden="true" />;
}

export default PixelDissolve;
