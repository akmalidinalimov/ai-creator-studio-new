import * as React from "react";

import { cn } from "@/lib/utils";

// Mockup: .frbox — first-run / empty / error block: big icon, headline, body copy, optional CTA.
// Reused as the global error/offline block too (Task 2.7).
export interface EmptyStateProps extends React.HTMLAttributes<HTMLDivElement> {
  icon: React.ReactNode;
  title: string;
  body: string;
  cta?: React.ReactNode;
}

const EmptyState = React.forwardRef<HTMLDivElement, EmptyStateProps>(
  ({ icon, title, body, cta, className, ...props }, ref) => (
    <div ref={ref} className={cn("px-2.5 pb-1 pt-4 text-center", className)} {...props}>
      <div className="mb-1.5 text-[52px] leading-none">{icon}</div>
      <h2 className="mb-1.5 text-[22px] font-extrabold tracking-tight text-foreground">{title}</h2>
      <p className="mx-auto mb-4 max-w-[30ch] text-sm leading-relaxed text-muted-foreground">{body}</p>
      {cta ? <div className="grid gap-2">{cta}</div> : null}
    </div>
  ),
);
EmptyState.displayName = "EmptyState";

export { EmptyState };
