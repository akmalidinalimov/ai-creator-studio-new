import * as React from "react";
import { Flame, Zap } from "lucide-react";

import { cn } from "@/lib/utils";
import { formatXp, type TierKey } from "@/lib/xp";
import { TIER_NAMES } from "./shared";

// Mockup: .rewardchip — generic pill (icon + label). Used directly for tier/rank/bonus-XP
// chips (e.g. "Oltin daraja", "#4", "+50 XP") and as the base for TierBadge below.
export interface RewardChipProps extends React.HTMLAttributes<HTMLSpanElement> {
  icon?: React.ReactNode;
  children: React.ReactNode;
}

const RewardChip = React.forwardRef<HTMLSpanElement, RewardChipProps>(
  ({ icon, children, className, ...props }, ref) => (
    <span
      ref={ref}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border border-accent/45 bg-accent-soft px-3 py-1.5 text-[13px] font-extrabold text-foreground",
        className,
      )}
      {...props}
    >
      <span className="text-accent [&_svg]:size-3.5">{icon ?? <Zap fill="currentColor" strokeWidth={0} />}</span>
      {children}
    </span>
  ),
);
RewardChip.displayName = "RewardChip";

// Mockup: .streak — flame icon + "N kunlik seriya".
export interface StreakChipProps extends React.HTMLAttributes<HTMLSpanElement> {
  days: number;
}

const StreakChip = React.forwardRef<HTMLSpanElement, StreakChipProps>(({ days, className, ...props }, ref) => (
  <span
    ref={ref}
    className={cn(
      "inline-flex items-center gap-1.5 rounded-full border border-accent/45 bg-accent-soft py-1.5 pl-2 pr-2.5 text-[13px] font-extrabold text-foreground",
      className,
    )}
    {...props}
  >
    <Flame className="size-[15px] text-accent" fill="currentColor" strokeWidth={0} />
    {days} kunlik seriya
  </span>
));
StreakChip.displayName = "StreakChip";

// Mockup: .rewardchip used for the current tier ("🏆 Oltin daraja" pill in the dashboard header).
export interface TierBadgeProps extends Omit<RewardChipProps, "icon" | "children"> {
  tier: TierKey;
}

const TierBadge = React.forwardRef<HTMLSpanElement, TierBadgeProps>(({ tier, className, ...props }, ref) => (
  <RewardChip ref={ref} className={className} {...props}>
    {TIER_NAMES[tier]} daraja
  </RewardChip>
));
TierBadge.displayName = "TierBadge";

// Mockup: .xpbig — the bigger "+N XP" celebratory pill (Celebrate overlay).
export interface XpPillProps extends Omit<React.HTMLAttributes<HTMLSpanElement>, "children"> {
  xp: number;
  locale?: string;
}

const XpPill = React.forwardRef<HTMLSpanElement, XpPillProps>(({ xp, locale = "uz", className, ...props }, ref) => (
  <span
    ref={ref}
    // NOT font-display: Unbounded's ss01 stylistic set renders digits as circled numerals
    // under this app's global `cv11,ss01` font-feature-settings (verified against /kit).
    className={cn(
      "inline-flex items-center gap-1.5 rounded-full border border-accent/45 bg-accent-soft px-4 py-2.5 text-base font-extrabold text-foreground",
      className,
    )}
    {...props}
  >
    <Zap className="size-4 text-accent" fill="currentColor" strokeWidth={0} />+{formatXp(xp, locale)} XP
  </span>
));
XpPill.displayName = "XpPill";

// Mockup: .hstat.ok/.wait/.redo — homework status pill; text uses the --*-2 (louder) tokens,
// except `wait` which maps to the semantic --warning token per the token-usage brief.
export type StatusChipKind = "ok" | "wait" | "redo";

const STATUS_CLASSES: Record<StatusChipKind, string> = {
  ok: "bg-good/15 text-good-2",
  wait: "bg-warning/15 text-warning",
  redo: "bg-danger/15 text-danger-2",
};

export interface StatusChipProps extends Omit<React.HTMLAttributes<HTMLSpanElement>, "children"> {
  kind: StatusChipKind;
  label: string;
}

const StatusChip = React.forwardRef<HTMLSpanElement, StatusChipProps>(
  ({ kind, label, className, ...props }, ref) => (
    <span
      ref={ref}
      className={cn(
        "inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-1 text-[10.5px] font-extrabold",
        STATUS_CLASSES[kind],
        className,
      )}
      {...props}
    >
      {label}
    </span>
  ),
);
StatusChip.displayName = "StatusChip";

export { RewardChip, StreakChip, TierBadge, XpPill, StatusChip };
