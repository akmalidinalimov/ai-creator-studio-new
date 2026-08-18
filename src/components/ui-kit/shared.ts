// Internal helpers shared across ui-kit primitives — not part of the public barrel.
//
// Mockup source of truth: docs/redesign/mockup.html. Several surfaces
// (.card/.mod/.stat/.hero .body/.lbrow/.hwitem/...) share one "gloss" treatment:
// a soft ambient shadow (--shadow-soft) plus, in dark mode only, an inset top
// highlight (--shadow-gloss) and a subtle top-to-bottom gradient
// (linear-gradient(180deg,#262d31,#1b2125) in the mockup — reproduced here purely
// from existing tokens as surface-2 → card, never hardcoded hex).
import type { CSSProperties } from "react";
import type { TierKey } from "@/lib/xp";

/** Card-like surface background: flat `bg-card` in light, a subtle top-lit gradient in dark. */
export const glossSurfaceClass = "bg-card dark:bg-gradient-to-b dark:from-surface-2 dark:to-card";

/**
 * Combined box-shadow (ambient `--shadow-soft` + dark-mode inset gloss `--shadow-gloss`) as an
 * inline style. Two Tailwind `shadow-*` utilities can't be stacked (both set the same CSS
 * property, so the later one simply wins) — an inline style is the reliable way to layer both
 * shadow tokens on the same element without touching global CSS.
 */
export const glossShadowStyle: CSSProperties = { boxShadow: "var(--shadow-soft), var(--shadow-gloss)" };

/** Uzbek tier display names — mirrors the ladder in src/lib/xp.ts (spec §7). */
export const TIER_NAMES: Record<TierKey, string> = {
  bronze: "Bronza",
  silver: "Kumush",
  gold: "Oltin",
  platinum: "Platina",
  diamond: "Olmos",
};
