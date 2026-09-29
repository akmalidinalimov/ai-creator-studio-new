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
// Rule 3 (hand-rolled x-internal-secret receiver check) is BLOCKING too, with its legacy sites listed.
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";

const TELEGRAM_MSG =
  "Raw api.telegram.org call — use sendTelegram() from _shared/telegram-send.ts so the send outcome is classified and a non-delivery is recorded (DB-visible), not silently lost.";
const SECRET_MSG =
  "Hand-rolled internal-secret check — use verifyInternalSecret(req, admin) from _shared/internal-secret.ts. A per-isolate cache that never re-fetches, or a compare against the INTERNAL_FN_SECRET env var, 403s every cron call after a secret rotation until the isolate recycles.";
const WRITE_MSG =
  "Direct supabase .update()/.upsert() — route through mutate()/mutateMany()/saveWithToast() from @/lib/mutate so a 0-row (RLS-filtered) write can't read as success.";

// Rule 4 — an ilike on telegram_username must go through likeEscape() (_shared/username.ts): "_" is a LIKE
// wildcard and Telegram usernames contain it, so an unescaped value is not an exact match — on the
// first-time username→profile link paths that let one user claim another student's unlinked account.
const USERNAME_MSG =
  "Unescaped ilike on telegram_username — wrap the value in likeEscape() from _shared/username.ts. '_' is a LIKE wildcard, so \"a_ice1\" would match the profile \"alice1\".";
const USERNAME_SELECTORS = [
  {
    selector:
      "CallExpression[callee.property.name='ilike'][arguments.0.value='telegram_username']:not(:has(CallExpression[callee.name='likeEscape']))",
    message: USERNAME_MSG,
  },
];

const TELEGRAM_SELECTORS = [
  { selector: "Literal[value=/api\\.telegram\\.org/]", message: TELEGRAM_MSG },
  { selector: "TemplateElement[value.raw=/api\\.telegram\\.org/]", message: TELEGRAM_MSG },
];
// Reading the header yourself, or touching the env copy of the secret. Setting the header on an
// OUTGOING request is an object-literal key, not a .get() argument, so senders are not flagged.
const SECRET_SELECTORS = [
  { selector: "CallExpression[callee.property.name='get'] > Literal[value=/^x-internal-secret$/i]", message: SECRET_MSG },
  { selector: "Literal[value='INTERNAL_FN_SECRET']", message: SECRET_MSG },
];

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
    // Rule 3 rides in the same list: flat config REPLACES (doesn't merge) a rule's options when two
    // blocks configure it for one file, so the two rule families share one no-restricted-syntax entry.
    rules: { "no-restricted-syntax": ["error", ...TELEGRAM_SELECTORS, ...SECRET_SELECTORS, ...USERNAME_SELECTORS] },
  },

  // Rule 3 — no hand-rolled x-internal-secret RECEIVER check in edge functions. BLOCKING ("error").
  // Every pg_cron-called receiver is on verifyInternalSecret() (rotation-safe: re-fetches Vault once on
  // mismatch) — the precondition for rotating INTERNAL_FN_SECRET without 403ing cron jobs. The
  // selectors live in Rule 1's list above; this block drops them (keeps the Telegram ones) for the
  // legacy sites NOT migrated, each with its reason. Shrink this list; don't grow it.
  {
    files: [
      "supabase/functions/_shared/internal-secret.ts",           // the verifier itself
      "supabase/functions/admin-create-students/index.ts",       // fresh RPC per call (no cache) + JWT path; called by edge fns
      "supabase/functions/telegram-bot-webhook/index.ts",        // env OR fresh RPC per call; not type-checked in CI — migrate separately
      "supabase/functions/warmup-dispatch/index.ts",             // already re-fetches on mismatch; not scheduled
      "supabase/functions/warmup-drainer/index.ts",              // already re-fetches on mismatch; not scheduled
      "supabase/functions/leaderboard-recalc/index.ts",          // no caller (deletion candidate)
      "supabase/functions/streak-rollover/index.ts",             // no caller (deletion candidate)
      "supabase/functions/refresh-teacher-keyboards/index.ts",   // one-off, no caller (deletion candidate)
      "supabase/functions/render-badge/index.ts",                // no caller (deletion candidate)
      "supabase/functions/generate-module-share-image/index.ts", // only caller is notify-completion (deletion candidate)
      "supabase/functions/notify-completion/index.ts",           // no caller since #188 (deletion candidate)
    ],
    languageOptions: { parser: tseslint.parser },
    rules: { "no-restricted-syntax": ["error", ...TELEGRAM_SELECTORS, ...USERNAME_SELECTORS] },
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
