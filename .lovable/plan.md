## Goal

Add a true second level of homework: each module's existing V1/V2/V3 become **parent homeworks**, and each parent can hold 1–N **sub-tasks (SAPs)**. Students see one button per SAP, teachers get one notification per SAP submission, and the module score is the **sum of SAP scores**.

Existing single-level homeworks keep working — a parent with zero SAPs behaves exactly like today.

## Data model

Extend `homework_assignments` (nullable additions, no breaking change):

- `parent_id uuid null` → references `homework_assignments(id) on delete cascade`. `null` = parent (current rows).
- `sap_number int null` → ordering of SAPs inside a parent (1..N). `null` for parents.
- Keep `task_number`, `max_score`, `is_active`, `prompt_*`, `due_days_after_module_unlock` on both parents and SAPs. For a parent with SAPs, parent's `max_score` is informational; effective max = Σ(SAP.max_score).
- Index: `(parent_id, sap_number)`.

`homework_submissions` already has `assignment_id` — point it at the SAP id when SAPs exist, parent id otherwise. No schema change needed; submissions naturally become per-SAP.

Update view `vw_module_homework_score` (or replace it) so module score = **sum of SAP scores per student per module** (ignoring parent rows that have SAPs, to avoid double-counting). Display as `total / Σmax`.

## Admin UI (`AdminHomework.tsx`)

Per parent row, add:

- "➕ SAP qo'shish" button → opens the same `AssignForm` in SAP mode (sets `parent_id`, auto `sap_number = next`).
- Nested indented list of SAPs under the parent row (badge `S1`, `S2`, …) with edit / toggle / delete, mirroring parent controls.
- Parent row shows aggregate: `Max: Σ SAP / Muddat: parent's value` when SAPs exist.
- Validation: a parent cannot be deleted while it has SAPs (cascade handles DB, but confirm in UI).

The form gets one extra read-only field `parent_id` (hidden) and label switches "Yangi vazifa" ↔ "Yangi SAP".

## Student UI (`HomeworkSection.tsx`)

For each parent assignment:

- If parent has **no SAPs** → render exactly as today (one card, one "Topikga o'tish" button).
- If parent has **SAPs** → render parent header (title + cumulative score `Σscore / Σmax`), then a separate sub-card per SAP with:
  - Badge `V{task_number}.S{sap_number}`, SAP title, SAP `max_score`, prompt.
  - Its own "📌 Topikga o'tish" button (same module topic URL — shared per group_module_topics).
  - Its own result block (✅ score/max + feedback or ⏳ pending).

Module average box at top becomes `Σscore / Σmax` across all SAPs (and parents without SAPs).

## Telegram bot (`telegram-bot-webhook/index.ts`)

Submission flow already keys off `assignment_id`. Two adjustments:

1. The "which assignment am I submitting?" picker after a student replies in a module topic must list **SAPs** (with parent context) instead of parents-with-SAPs. Logic: expand each parent that has children into its SAPs; leave parents-without-children as-is.
2. `notifyTeachersOfSubmission` already runs per submission → automatically becomes per-SAP. Update the notification body to include parent title + SAP label, e.g. `V2 · S1 — "Brendlar uchun rasm"`. Deep-link button stays the same (message link).

Quiet-hours / dedup logic unchanged.

## Teacher UI (`TeacherHomework.tsx`)

Each row already corresponds to one submission → naturally one-per-SAP. Add to the enrichment:

- Show parent title + SAP label in the "Vazifa" column: `V2.S1 — Brendlar uchun rasm`.
- Drawer header same labeling.
- Max score per row already comes from the assignment row → works for SAPs.

No structural changes; just label improvements.

## Scoring

- Per-SAP scoring unchanged (`score / max_score`).
- Module total displayed to student & teacher = `Σ SAP.score / Σ SAP.max_score` (raw points).
- Replace the normalization in `vw_module_homework_score` with sum-based aggregation. Keep the view name so admin module-stats keep working; column rename `avg_score_normalized` → `module_total` (and update the two readers in `AdminHomework.tsx` and any analytics).

## Migration steps

1. **DB migration** (single migration):
   - `ALTER TABLE homework_assignments ADD COLUMN parent_id uuid REFERENCES homework_assignments(id) ON DELETE CASCADE, ADD COLUMN sap_number int;`
   - Index on `(parent_id, sap_number)`.
   - Recreate `vw_module_homework_score` to sum SAP scores per `(module_id, profile_id)`, treating any parent with children as a passthrough container.
   - RLS already covers child rows (same table, same policies).

2. **Admin UI** — add SAP CRUD under each parent row.
3. **Student UI** — render SAPs as separate sub-cards.
4. **Bot** — update submission picker + notification labels.
5. **Teacher UI** — labeling only.
6. **Smoke test**: existing module without SAPs, new module with 2 SAPs under V1, submit each SAP, verify two teacher notifications, verify cumulative score display.

## Out of scope

- Feature flags / staged rollout: skipping (low blast radius, parents without SAPs are unchanged).
- Per-SAP topic routing (kept as same module topic per your answer).
- Weighted scoring (raw sum only).
