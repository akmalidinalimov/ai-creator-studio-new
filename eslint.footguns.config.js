// Footgun lint — the two silent-failure patterns the reliability foundation forbids.
//
// Run: `npm run lint:footguns`. Kept SEPARATE from eslint.config.js (which is advisory in CI) so each
// rule can gate independently as its legacy sites are migrated onto the paved-road primitives.
// STATUS: BOTH rules are now BLOCKING ("error"). Rule 2 (raw supabase .update()/.upsert() in src/)
// and Rule 1 (raw api.telegram.org SENDER in edge functions) are fully migrated onto the paved-road
// primitives (mutate()/saveWithToast() and sendTelegram()), so no new hand-rolled write or sender can
// merge. Non-sender api.telegram.org uses (getFile media retrieval, getChatMember) are exempt via
// `ignores`; a couple of legitimate raw senders (the webhook bot core + its multipart CSV export, and
// detect-and-nudge) carry an inline `// eslint-disable-next-line no-restricted-syntax` with a reason.
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

  // Rule 1 — no hand-rolled Telegram SENDER in edge functions. BLOCKING ("error"): every message
  // sender is on sendTelegram(). Exempt via `ignores` the files that hit api.telegram.org for NON-send
  // reasons (getFile / file-byte media retrieval, getChatMember membership probe) + the primitive
  // itself. The remaining raw senders — the webhook bot core `tgApi` + its multipart CSV `sendDocument`
  // (the JSON-only primitive can't carry multipart), and detect-and-nudge (needs the raw response for
  // its nudge_log message_id) — carry an inline eslint-disable with a rationale.
  {
    files: ["supabase/functions/**/*.ts"],
    ignores: [
      "supabase/functions/_shared/telegram-send.ts",       // the shared sender it lives in
      "supabase/functions/_shared/telegram-membership.ts", // getChatMember probe — not a message send
      "supabase/functions/hw-image-url/index.ts",          // getFile / file-byte media retrieval — not a send
      "supabase/functions/hw-audio-url/index.ts",          // getFile / file-byte media retrieval — not a send
    ],
    languageOptions: { parser: tseslint.parser },
    rules: {
      "no-restricted-syntax": [
        "error",
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
