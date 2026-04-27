# Add language switcher to the main (Landing) page

## Problem
The Landing page (`/`) header has Sign in / Start free buttons but no language switcher. Login, Signup, and the authenticated `Layout` already use the shared `LanguageSwitcher` component — only the public landing page is missing it.

## Change
Reuse the existing `LanguageSwitcher` component (no new logic, no new translations needed). It already persists the choice to `localStorage` and to `profiles.preferred_language` if signed in.

### 1. `src/pages/Landing.tsx` — desktop header
- Import `LanguageSwitcher` from `@/components/LanguageSwitcher`.
- Insert it inside the right-side action group (line ~137), before the Sign in button:

```tsx
<div className="flex items-center gap-2">
  <LanguageSwitcher />
  <Button asChild variant="outline" size="sm" className="hidden sm:inline-flex">
    <Link to="/login">{t("landing.nav.signIn")}</Link>
  </Button>
  ...
</div>
```

This keeps the switcher visible on both mobile and desktop (the Sign in button is hidden on `<sm`, but the switcher remains).

### 2. `src/pages/Landing.tsx` — mobile slide-out menu (around line 382–401)
Add the same `<LanguageSwitcher />` near the top of the mobile menu so users opening the hamburger also see it. Place it next to the `<Brand />` row or just above the auth links.

## Out of scope
- No changes to `LanguageSwitcher.tsx`, i18n config, or translations.
- No changes to other pages (Login, Signup, Layout already have it).

## Verification
- Visit `/` — flag + language code visible in the top-right header next to Sign in.
- Click it → dropdown lists Uz / Ru / En → selecting one updates landing copy (headlines, nav links, FAQ) immediately and persists across reloads.
- Open mobile menu → switcher visible there too.
