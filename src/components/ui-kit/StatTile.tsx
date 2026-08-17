import * as React from "react";

import { cn } from "@/lib/utils";
import { glossShadowStyle, glossSurfaceClass } from "./shared";

// Mockup: .stat / .stat.hl — icon + big number + label; highlight tints the icon coral.
export interface StatTileProps extends React.HTMLAttributes<HTMLDivElement> {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  highlight?: boolean;
}

const StatTile = React.forwardRef<HTMLDivElement, StatTileProps>(
  ({ icon, label, value, highlight, className, style, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        "rounded-md border border-border p-2.5 text-center",
        glossSurfaceClass,
        className,
      )}
      style={{ ...glossShadowStyle, ...style }}
      {...props}
    >
      <div className={cn("mx-auto mb-1.5 size-[22px] [&_svg]:size-full", highlight ? "text-accent" : "text-primary")}>
        {icon}
      </div>
      {/* NOT font-display: Unbounded's ss01 stylistic set renders digits as circled
          numerals under this app's global `cv11,ss01` font-feature-settings (verified
          against /kit — 1240 rendered as "①②④⓪"). font-sans (Onest) is safe here. */}
      <div className="text-[17px] font-extrabold leading-none tracking-tight tabular-nums text-foreground">
        {value}
      </div>
      <div className="mt-1 text-[10.5px] font-semibold tracking-wide text-muted-foreground">{label}</div>
    </div>
  ),
);
StatTile.displayName = "StatTile";

export { StatTile };
