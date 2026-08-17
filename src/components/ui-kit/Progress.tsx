import * as React from "react";

import { cn } from "@/lib/utils";

function clampPct(n: number): number {
  return Math.min(100, Math.max(0, n));
}

// Mockup: .prog / .prog i — track + accent→primary gradient fill.
export interface ProgressBarProps extends React.HTMLAttributes<HTMLDivElement> {
  value: number;
}

const ProgressBar = React.forwardRef<HTMLDivElement, ProgressBarProps>(
  ({ value, className, ...props }, ref) => (
    <div ref={ref} className={cn("h-2 flex-1 overflow-hidden rounded-full bg-tint", className)} {...props}>
      <div
        className="h-full rounded-full bg-gradient-to-r from-accent to-primary"
        style={{ width: `${clampPct(value)}%` }}
      />
    </div>
  ),
);
ProgressBar.displayName = "ProgressBar";

// Mockup: .ring / .ring .in — conic-gradient dial with a centered surface disc + "N%" label.
export interface ProgressRingProps {
  pct: number;
  size?: number;
  className?: string;
}

function ProgressRing({ pct, size = 62, className }: ProgressRingProps) {
  const clamped = clampPct(pct);
  const innerSize = Math.round(size * 0.774);
  return (
    <div
      className={cn("grid flex-none place-items-center rounded-full", className)}
      style={{
        width: size,
        height: size,
        background: `conic-gradient(hsl(var(--accent)) 0% ${clamped}%, hsl(var(--tint)) ${clamped}% 100%)`,
      }}
    >
      {/* NOT font-display: Unbounded's ss01 stylistic set renders digits as circled
          numerals under this app's global `cv11,ss01` font-feature-settings (verified
          against /kit — 68% rendered as "⑥⑧%"). font-sans (Onest) is safe here. */}
      <div
        className="grid place-items-center rounded-full bg-card font-extrabold tabular-nums text-foreground"
        style={{ width: innerSize, height: innerSize, fontSize: innerSize < 44 ? 11 : 13 }}
      >
        {clamped}%
      </div>
    </div>
  );
}

// Mockup: .tierbar / .tierbar i — track + gold→accent gradient fill (tier progress).
export interface TierBarProps extends React.HTMLAttributes<HTMLDivElement> {
  pct: number;
}

const TierBar = React.forwardRef<HTMLDivElement, TierBarProps>(({ pct, className, ...props }, ref) => (
  <div ref={ref} className={cn("h-2.5 overflow-hidden rounded-full bg-tint", className)} {...props}>
    <div
      className="h-full rounded-full bg-gradient-to-r from-gold to-accent"
      style={{ width: `${clampPct(pct)}%` }}
    />
  </div>
));
TierBar.displayName = "TierBar";

export { ProgressBar, ProgressRing, TierBar };
