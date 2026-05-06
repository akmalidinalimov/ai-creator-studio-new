## Goal

Add a deterministic, fast test suite that locks in the SAP-leaf routing rule:
"each detected submission is attached to the student's next un-graded leaf
(SAP, or parent-without-children), in `task_number`/`sap_number` order; if all
leaves are graded, fall back to the last leaf."

## Approach

The routing logic currently lives inline inside `handleHomeworkGroupMessage`
in `supabase/functions/telegram-bot-webhook/index.ts` (lines ~2829–2870) and
is not exported. Trying to test it through HTTP would require a live DB and
real Telegram payloads — slow, flaky, and noisy.

**Plan: extract the pure decision function, then unit-test it with Deno.**

### Step 1 — Extract pure helper

Create `supabase/functions/telegram-bot-webhook/homework-routing.ts` exporting:

```ts
export type AssignmentRow = {
  id: string;
  task_number: number | null;
  sap_number: number | null;
  parent_id: string | null;
  is_active?: boolean;
};
export type SubmissionRow = { assignment_id: string; score: number | null };

export function computeLeaves(all: AssignmentRow[]): AssignmentRow[] { … }
export function pickNextLeaf(
  leaves: AssignmentRow[],
  subs: SubmissionRow[],
): AssignmentRow | null { … }
```

`computeLeaves` = filter active rows, drop parents that have SAP children,
sort by `(task_number, sap_number)`.
`pickNextLeaf` = first leaf with no submission OR `score == null`; if none,
return last leaf; if `leaves` is empty, return null.

Refactor the matching block in `index.ts` to call these two helpers — pure
behavior preserved, no functional change.

### Step 2 — Add Deno test file

`supabase/functions/telegram-bot-webhook/homework-routing.test.ts` covering:

1. **Single parent, no SAPs, no submission** → routes to that parent.
2. **Single parent with 3 SAPs, none submitted** → routes to S1.
3. **Parent with SAPs, S1 graded, S2 ungraded** → routes to S2.
4. **Parent with SAPs, S1 submitted but ungraded (`score=null`)** → routes to S1
   (re-submission of pending work).
5. **Multiple parents (V1 with SAPs, V2 standalone), V1 fully graded** →
   routes to V2.
6. **All leaves graded** → falls back to the last leaf in order.
7. **Mixed module: parent V1 has children, parent V2 has none** → leaves =
   V1.S1, V1.S2, V2; ordering and routing correct.
8. **Inactive parent excluded** by upstream filter (test `computeLeaves`
   respects `is_active=false`).
9. **Per-student isolation**: two students with different submission states
   get different next leaves from the same `leaves` array.
10. **Empty input** → `pickNextLeaf` returns `null`.

Each test uses plain object literals — no DB, no network, runs in <1s.

### Step 3 — Run

Use `supabase--test_edge_functions` with
`{"functions": ["telegram-bot-webhook"]}` to confirm green.

## Files

- New: `supabase/functions/telegram-bot-webhook/homework-routing.ts`
- New: `supabase/functions/telegram-bot-webhook/homework-routing.test.ts`
- Edited: `supabase/functions/telegram-bot-webhook/index.ts` (replace inline
  leaf computation + leaf picker with calls into the new module; redeploy).

## Out of scope

- End-to-end webhook tests against live DB (would need fixtures + cleanup;
  not warranted for this rule).
- Re-testing the `/vazifalar` student menu (separate concern).
