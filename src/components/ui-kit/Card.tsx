import * as React from "react";

import { cn } from "@/lib/utils";
import { glossShadowStyle, glossSurfaceClass } from "./shared";

// Mockup: .card — surface bg, border, radius, soft shadow (+ dark glossy gradient/inset gloss).
const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, style, ...props }, ref) => (
    <div
      ref={ref}
      className={cn("rounded-lg border border-border p-4", glossSurfaceClass, className)}
      style={{ ...glossShadowStyle, ...style }}
      {...props}
    />
  ),
);
Card.displayName = "Card";

export { Card };
