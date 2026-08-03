# Homework Step Attribution Fix — Implementation Plan

**Goal:** Show the correct step number for multi-step (SAP) homework, make picker/retag index resolution deterministic, and make auto-guessed attributions loud + auditable.

**Architecture:** A single pure helper (`displayStepNumber`) in `homework-routing.ts` becomes the one source of truth for the human-facing step number; every display surface calls it. A stable tiebreaker in `computeLeaves` removes latent index nondeterminism. A DB watchdog + digest line make both the SAP-display invariant and the auto-guess backlog visible.

**Tech Stack:** Deno edge functions (telegram-bot-webhook, notify-homework-submission), pure TS helpers with Deno tests, one SQL migration (detector), pipeline deploy (label-gated).

## Global Constraints (verbatim from project doctrine)
- Self-merge to `main` requires the owner's explicit "merge it" per PR.
- Migrations apply on merge ONLY with the `migration-approved` label; never `db push`.
- Telegram: callback_data ≤ 64 bytes; bots can't DM users who never pressed Start.
- Members get a forgiving sandbox — never police/flag member fumbling.
- New features must emit DB-visible health signals.
- Display decision (owner-approved 2026-08-03): a SAP sub-step is shown as **`sap_number`** ("Vazifa 1/2/3"), making Module 3 uniform with every other module. Non-SAP tasks are UNCHANGED (`task_number`).

## Root cause (confirmed from prod)
- **Bug 1 (display):** every surface derives the step from `homework_assignments.task_number`, which for a SAP leaf is the parent ordinal (3), shared by all sub-steps → S1/S2 show as "V3". Grade/attribution are correct. 29/38 SAP submissions last week displayed wrong.
- **Bug 2 (attribution):** `pickNextLeaf` ("first ungraded, else last") guesses the step when the picker is ignored → can misfile a task. 28 "(taxminiy)" cases /14d, 0 teacher-reviewed.
- **Class 3 (latent):** picker/retag resolve `leaves[index]` from an un-`ORDER BY`'d fetch; deterministic only while `(task_number, sap_number)` keys are distinct.

---

## PR A — Display fix + determinism + auto-guess visibility (NO migration)

### Task A1: `displayStepNumber` helper + `computeLeaves` tiebreaker (TDD)
**Files:**
- Modify: `supabase/functions/telegram-bot-webhook/homework-routing.ts`
- Test: `supabase/functions/telegram-bot-webhook/homework-routing.test.ts`

Add:
```ts
/** Human-facing step number. SAP sub-step → its sap_number (Module 3 reads "Vazifa 1/2/3");
 *  a normal task → its task_number (unchanged). Never throws; defaults to 1. */
export function displayStepNumber(
  leaf: { parent_id: string | null; task_number: number | null; sap_number: number | null },
): number {
  if (leaf.parent_id != null) return leaf.sap_number ?? leaf.task_number ?? 1;
  return leaf.task_number ?? 1;
}
```
And add an `id` tiebreaker to `computeLeaves` sort so index resolution is deterministic regardless of DB fetch order:
```ts
  leaves.sort((x, y) =>
    (x.task_number ?? 0) - (y.task_number ?? 0) ||
    (x.sap_number ?? 0) - (y.sap_number ?? 0) ||
    (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
```
Tests: displayStepNumber (SAP→sap, non-SAP→task, null-safety); computeLeaves stable order when two leaves share (task_number, sap_number) — same order across two shuffled inputs.

### Task A2: Route every display surface through `displayStepNumber`
**File:** `supabase/functions/telegram-bot-webhook/index.ts`
Replace `const tn = (a?.task_number ?? 1)` with `const tn = displayStepNumber(a)` at:
- `startHomeworkIntent` ~4650
- `finalizePendingPost` ~5123
- `handleGroupTopicMessage` ~5783

Simplify `aTitle` for SAP leaves — drop the "V{ptask}.S{sap} — " prefix (the step is now carried by `tn`); keep the plain leaf title. (~5124-5128, ~5784-5788.) Preserve the `(taxminiy)` suffix on guessed (5129).

Picker labels:
- Step-button list ~6576: `V${parentTn(l)}.S${l.sap_number}` → `Vazifa ${l.sap_number ?? "?"}` (leaf); non-SAP stays `V${l.task_number}`. (Use displayStepNumber for the number.)
- Decode confirm label ~6597: `V${leaf.task_number ?? leaf.sap_number ?? ""}` → `V${displayStepNumber(leaf)}`.

### Task A3: Teacher DMs carry the step number (not just the title)
**File:** `supabase/functions/telegram-bot-webhook/index.ts` (~5952-5954)
The immediate teacher DM builds `moduleName = "Modul ${mn}"` and passes `aTitle`. Since `aTitle` no longer embeds the step, include it: `moduleName = "Modul ${mn} · Vazifa ${tn}"`. Queue insert already stores `task_number: tn` (5934) → the sap-aware value now flows to `notify-homework-submission` (cron) automatically.

### Task A4: Louder auto-guess flag for teachers (Bug 2 visibility)
**Files:** `supabase/functions/telegram-bot-webhook/index.ts`, `notify-homework-submission/index.ts`
When `guessed`, the teacher DM (immediate + cron) must show a clear warning line + the ✏️ retag affordance, e.g. `⚠️ Avto-belgilangan — noto'g'ri bo'lsa ✏️ bilan to'g'rilang`. Detect "guessed" via the `(taxminiy)` marker already on `aTitle`/`assignment_title` (no schema change).

### Task A5: Review + ship
- Run `deno test supabase/functions/telegram-bot-webhook/` (routing + stats tests green).
- Dispatch **telegram-flow-reviewer** on the diff.
- PR (no `migration-approved` needed), CI green, owner "merge it", pipeline deploys changed functions.
- Post-deploy prod check: re-run the SAP display-consistency query — new submissions must show `queue.task_number == sap_number` for SAP leaves.

---

## PR B — Detector + heal (migration, `migration-approved`)

### Task B1: `homework_attribution_watchdog()` + health stat
**File:** `supabase/migrations/2026XXXX_homework_attribution_watchdog.sql`
- SAP-display invariant: count SAP submissions (last 24h) whose `homework_teacher_dm_queue.task_number <> sap_number` — should be 0 after PR A; >0 ⇒ regression ⇒ DM admins. (SECURITY DEFINER, service_role only, de-duped via app_settings, pg_net → Telegram, cron daily; mirror `enrollment_watchdog`.)
- Auto-guess backlog: count last-24h `(taxminiy)` submissions that are neither retagged nor graded → surface as a DB-visible number.
- Add both to a `homework_attribution_health()` stat and a line in `ops_daily_digest()`.

### Task B2: Heal — surface the recent auto-guessed backlog for review
One-time idempotent pass (in the same migration or a one-shot): summarize the last 14 days of un-retagged "(taxminiy)" submissions per teacher/group and DM the admins a compact review list (retag deep-links). No auto-retag — a human confirms. Audit to `admin_actions`.

### Task B3: Review + ship
- Dispatch **migration-safety-reviewer**.
- PR with `migration-approved`, CI green, owner "merge it", pipeline applies + ledgers.
- Verify: watchdog run returns 0 SAP-mismatch; digest shows the new lines.

## Heal-history note
No grade data is wrong (attribution/score verified correct for Bug 1). Past sent messages can't be un-sent. The only "heal" is surfacing Bug-2 guessed cases for human review (B2).

## E2E / verification
- Unit: `displayStepNumber`, `computeLeaves` determinism, `pickNextLeaf` (A1).
- Prod: display-consistency query before (29/38 wrong) vs after (0 wrong) — the objective proof.
- Manual: owner submits one Module-3 S1 via the bot; receipt + teacher DM must read "Vazifa 1".
