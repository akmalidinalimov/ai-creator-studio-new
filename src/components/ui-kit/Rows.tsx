import * as React from "react";
import { Check, ChevronRight, Lock, Play } from "lucide-react";

import { cn } from "@/lib/utils";
import { glossShadowStyle, glossSurfaceClass } from "./shared";

// Mockup: .mod / .mod.done / .mod.active / .mod.lock — a module in the course tree.
// `available` (no mockup modifier class — the plain `.mod .n` base styling) is a within-tier-cap
// module the student simply hasn't started yet: openable like `done`, just no checkmark/lock.
export type ModuleRowState = "done" | "active" | "locked" | "available";

export interface ModuleRowProps {
  state: ModuleRowState;
  n: number;
  title: string;
  meta?: string;
  lockReason?: string;
  onClick?: () => void;
  className?: string;
}

const ModuleRow = React.forwardRef<HTMLDivElement, ModuleRowProps>(
  ({ state, n, title, meta, lockReason, onClick, className }, ref) => {
    const clickable = typeof onClick === "function";
    return (
      <div
        ref={ref}
        onClick={onClick}
        role={clickable ? "button" : undefined}
        tabIndex={clickable ? 0 : undefined}
        onKeyDown={
          clickable
            ? (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onClick?.();
                }
              }
            : undefined
        }
        className={cn(
          "mb-2 flex items-center gap-3 rounded-md border border-border p-[11px]",
          glossSurfaceClass,
          clickable &&
            "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
          state === "locked" && "opacity-55",
          className,
        )}
        style={glossShadowStyle}
      >
        <div
          className={cn(
            "grid size-[34px] flex-none place-items-center rounded-md font-extrabold",
            state === "done" && "bg-good/16 text-good",
            state === "active" && "bg-cta text-cta-foreground",
            state === "locked" && "bg-tint text-muted-foreground",
            state === "available" && "bg-tint text-primary",
          )}
        >
          {state === "done" ? <Check className="size-4" strokeWidth={3} /> : null}
          {state === "active" || state === "available" ? n : null}
          {state === "locked" ? <Lock className="size-3.5" /> : null}
        </div>
        <div className="min-w-0 flex-1">
          <b className="block truncate text-sm font-bold text-foreground">{title}</b>
          {state === "locked" && lockReason ? (
            <span className="block text-[11px] font-semibold text-gold-2">{lockReason}</span>
          ) : meta ? (
            <span className="block text-xs font-semibold text-muted-foreground">{meta}</span>
          ) : null}
        </div>
        {clickable && state !== "locked" ? (
          <ChevronRight className="size-[18px] flex-none text-muted-foreground" />
        ) : null}
      </div>
    );
  },
);
ModuleRow.displayName = "ModuleRow";

// Mockup: .lessonrow / .lessonrow.done / .lessonrow.here — a lesson within the active module.
export type LessonRowState = "done" | "upcoming";

export interface LessonRowProps {
  state: LessonRowState;
  title: string;
  meta?: string;
  here?: boolean;
  /** Optional position marker shown in the leading circle for an upcoming (not done/here) lesson. */
  index?: number | string;
  onClick?: () => void;
  className?: string;
}

const LessonRow = React.forwardRef<HTMLDivElement, LessonRowProps>(
  ({ state, title, meta, here, index, onClick, className }, ref) => {
    const clickable = typeof onClick === "function";
    return (
      <div
        ref={ref}
        onClick={onClick}
        role={clickable ? "button" : undefined}
        tabIndex={clickable ? 0 : undefined}
        onKeyDown={
          clickable
            ? (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onClick?.();
                }
              }
            : undefined
        }
        className={cn(
          "ml-11 mb-1.5 flex items-center gap-2.5 rounded-md border border-border bg-surface-2 px-[11px] py-2.5",
          here && "border-cta/50 bg-accent-soft",
          clickable &&
            "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
          className,
        )}
      >
        <div
          className={cn(
            "grid size-[26px] flex-none place-items-center rounded-sm bg-card text-xs font-extrabold text-muted-foreground",
            state === "done" && "text-good",
            here && "bg-cta text-cta-foreground",
          )}
        >
          {here ? <Play className="size-3" fill="currentColor" strokeWidth={0} /> : null}
          {!here && state === "done" ? <Check className="size-3.5" strokeWidth={3} /> : null}
          {!here && state !== "done" ? (index ?? "•") : null}
        </div>
        <div className="min-w-0 flex-1 text-[13px] font-bold text-foreground">
          {title}
          {meta ? <span className="block text-[11px] font-semibold text-muted-foreground">{meta}</span> : null}
        </div>
        {here ? (
          <span className="flex-none whitespace-nowrap rounded-full bg-cta px-2 py-1 text-[10px] font-extrabold text-cta-foreground">
            Shu yerda
          </span>
        ) : null}
      </div>
    );
  },
);
LessonRow.displayName = "LessonRow";

export { ModuleRow, LessonRow };
