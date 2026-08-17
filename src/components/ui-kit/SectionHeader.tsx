import * as React from "react";

import { cn } from "@/lib/utils";

// Mockup: .slab — section title + optional trailing action ("Barchasi", "Batafsil", ...).
// `action` is a ReactNode so callers can drop in a plain string, a <button>, or a router <Link>.
export interface SectionHeaderProps extends React.HTMLAttributes<HTMLDivElement> {
  title: string;
  action?: React.ReactNode;
}

const SectionHeader = React.forwardRef<HTMLDivElement, SectionHeaderProps>(
  ({ title, action, className, ...props }, ref) => (
    <div ref={ref} className={cn("mb-2.5 mt-4 flex items-center justify-between", className)} {...props}>
      <h4 className="text-[14.5px] font-extrabold tracking-tight text-foreground">{title}</h4>
      {action ? <div className="text-[12.5px] font-bold text-primary [&_a]:no-underline">{action}</div> : null}
    </div>
  ),
);
SectionHeader.displayName = "SectionHeader";

export { SectionHeader };
