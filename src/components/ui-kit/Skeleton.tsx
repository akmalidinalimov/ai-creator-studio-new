import * as React from "react";

import { cn } from "@/lib/utils";

// Not present in the mockup (deferred there too) — generic token-driven pulse block for
// screen-specific loading layouts (Task 2.7 composes these into hero/stat/row skeletons).
function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("animate-pulse rounded-md bg-tint", className)} {...props} />;
}

export { Skeleton };
