import * as React from "react";
import { Play } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "./Button";
import { ProgressBar } from "./Progress";
import { glossShadowStyle, glossSurfaceClass } from "./shared";

// Mockup: .hero (.cover + .body) — the "continue learning" hero card: a gradient banner
// (optional pill label + play button) over a body with title/meta/progress + one coral CTA.
export interface HeroProps {
  coverLabel?: string;
  title: string;
  meta?: string;
  progress?: number;
  ctaLabel?: string;
  onCtaClick?: () => void;
  onPlayClick?: () => void;
  className?: string;
}

function Hero({ coverLabel, title, meta, progress, ctaLabel, onCtaClick, onPlayClick, className }: HeroProps) {
  return (
    <div className={cn("overflow-hidden rounded-lg", className)} style={glossShadowStyle}>
      {/* `to-foreground` is a deep ink in light mode but foreground flips to a light color in
          dark mode (it's text-on-dark), so dark mode swaps the gradient's dark endpoint to
          `background` instead (verified against /kit — from-primary/to-foreground alone washed
          out to a flat bright mint in dark mode). */}
      <div className="relative flex h-[150px] items-end overflow-hidden bg-gradient-to-br from-primary to-foreground p-3.5 dark:to-background">
        <div
          className="pointer-events-none absolute inset-0"
          aria-hidden
          style={{ background: "radial-gradient(120px 90px at 82% 20%, hsl(var(--cta) / 0.55), transparent 70%)" }}
        />
        {coverLabel ? (
          <span className="relative z-10 max-w-full truncate rounded-full border border-white/30 bg-white/15 px-2.5 py-1.5 text-[11.5px] font-bold tracking-wide text-white backdrop-blur-sm">
            {coverLabel}
          </span>
        ) : null}
        {onPlayClick ? (
          <button
            type="button"
            onClick={onPlayClick}
            aria-label="Play"
            className="absolute left-1/2 top-1/2 grid size-[54px] -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-cta text-cta-foreground shadow-elevated"
          >
            <Play className="size-5" fill="currentColor" strokeWidth={0} />
          </button>
        ) : null}
      </div>
      <div className={cn("p-4", glossSurfaceClass)}>
        <h3 className="mb-1 break-words text-[16.5px] font-extrabold tracking-tight text-foreground">{title}</h3>
        {meta ? <div className="mb-3 text-[12.5px] font-semibold text-muted-foreground">{meta}</div> : null}
        <div className="flex items-center gap-3">
          {typeof progress === "number" ? <ProgressBar value={progress} /> : null}
          {ctaLabel ? (
            <Button variant="primary" size="sm" onClick={onCtaClick} className="flex-none">
              {ctaLabel}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export { Hero };
