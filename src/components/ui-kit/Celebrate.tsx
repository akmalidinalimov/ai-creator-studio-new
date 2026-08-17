import * as React from "react";

import { cn } from "@/lib/utils";
import { XpPill } from "./Chips";

// Mockup: .celebrate (.burst + h2 + p + .xpbig) — the lesson/module/level-up/tier-up overlay.
// Entrance uses the existing `animate-fade-in` utility gated by `motion-safe:` so it's a no-op
// under prefers-reduced-motion (Task 2.7 wires the trigger + honors reduced motion further).
export interface CelebrateProps {
  emoji: string;
  title: string;
  body: string;
  xp?: number;
  locale?: string;
  className?: string;
}

function Celebrate({ emoji, title, body, xp, locale, className }: CelebrateProps) {
  return (
    <div className={cn("motion-safe:animate-fade-in px-2.5 pb-1.5 pt-5 text-center", className)}>
      <div
        className="mx-auto mb-4 grid size-[92px] place-items-center rounded-lg bg-accent text-[42px] text-accent-foreground shadow-elevated"
        aria-hidden
      >
        {emoji}
      </div>
      <h2 className="mb-1.5 font-display text-2xl font-extrabold tracking-tight text-foreground">{title}</h2>
      <p className="mx-auto mb-4 max-w-[32ch] text-sm leading-relaxed text-muted-foreground">{body}</p>
      {typeof xp === "number" ? <XpPill xp={xp} locale={locale} className="mb-1" /> : null}
    </div>
  );
}

export { Celebrate };
