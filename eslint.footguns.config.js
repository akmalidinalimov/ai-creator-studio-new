// Footgun lint — the two silent-failure patterns the reliability foundation forbids.
//
// Run: `npm run lint:footguns`. Kept SEPARATE from eslint.config.js (which is advisory in CI) so each
// rule can gate independently as its legacy sites are migrated onto the paved-road primitives.
// STATUS: Rule 2 (raw supabase .update()/.upsert() in src/) is BLOCKING ("error") — every legacy
// write is on mutate()/saveWithToast(), so no new unwrapped write can merge. Rule 1 (raw
// api.telegram.org fetch) is still ADVISORY ("warn") — the sendTelegram() adoption is in flight.
// The CI step (no continue-on-error) fails on a Rule-2 error but not on a Rule-1 warning.
// Legitimate exceptions get an inline `// eslint-disable-next-line no-restricted-syntax` with a reason.
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";

const TELEGRAM_MSG =
  "Raw api.telegram.org call — use sendTelegram() from _shared/telegram-send.ts so the send outcome is classified and a non-delivery is recorded (DB-visible), not silently lost.";
const WRITE_MSG =
  "Direct supabase .update()/.upsert() — route through mutate()/mutateMany()/saveWithToast() from @/lib/mutate so a 0-row (RLS-filtered) write can't read as success.";

export default tseslint.config(
  { ignores: ["dist", "**/*.test.ts", "**/*.test.tsx"] },

  // Register (but don't enable) the plugins the app uses, so inline `eslint-disable react-hooks/…`
  // and `react-refresh/…` directives in src files resolve instead of erroring "rule not found".
  { plugins: { "react-hooks": reactHooks, "react-refresh": reactRefresh } },

  // Rule 1 — no hand-rolled Telegram fetch in edge functions (except the shared sender it lives in).
  // ADVISORY ("warn") for now: the sendTelegram() adoption (Phase 3) is still in flight (the webhook
  // grade-card + Tier-2.5 + drainers remain). It prints warnings but does not fail CI. Flip to "error"
  // once every raw api.telegram.org sender is migrated, so no new hand-rolled sender can merge.
  {
    files: ["supabase/functions/**/*.ts"],
    ignores: ["supabase/functions/_shared/telegram-send.ts"],
    languageOptions: { parser: tseslint.parser },
    rules: {
      "no-restricted-syntax": [
        "warn",
        { selector: "Literal[value=/api\\.telegram\\.org/]", message: TELEGRAM_MSG },
        { selector: "TemplateElement[value.raw=/api\\.telegram\\.org/]", message: TELEGRAM_MSG },
      ],
    },
  },

  // Rule 2 — no UNWRAPPED supabase write in src/. `mutate()` WRAPS the write (`mutate(() => x.update())`)
  // rather than removing the `.update()` call, so the selector must exclude `.update()/.upsert()` calls
  // that sit inside a mutate/mutateMany/saveWithToast call — otherwise it would flag the correctly
  // guarded sites forever. Exempts the primitive itself + teacherApi (the reference guarded pattern).
  // Heuristic (matches any `.update()/.upsert()` member call not so wrapped) — over-matches on a
  // non-supabase `.update()` are rare in src/ and get an inline `// eslint-disable-next-line`.
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/lib/mutate.ts", "src/lib/teacherApi.ts"],
    languageOptions: { parser: tseslint.parser },
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.property.name='update']:not(CallExpression[callee.name=/^(mutate|mutateMany|saveWithToast)$/] CallExpression[callee.property.name='update'])",
          message: WRITE_MSG,
        },
        {
          selector:
            "CallExpression[callee.property.name='upsert']:not(CallExpression[callee.name=/^(mutate|mutateMany|saveWithToast)$/] CallExpression[callee.property.name='upsert'])",
          message: WRITE_MSG,
        },
      ],
    },
  },
);
