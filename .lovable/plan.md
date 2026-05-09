## Goal

Make Telegram homework buttons clear for students. Replace cryptic `M1 — title` and `V1.S1 — title` labels with module-number-based labels that scale automatically as new modules are added.

## Changes

All edits are in `supabase/functions/telegram-bot-webhook/index.ts` (Telegram bot, no UI). Logic, callback data, routing, and submission flow stay exactly the same — only the button text changes.

### 1. Top-level `/vazifalar` module buttons (line ~1164)

Currently:
```
📝 M1 — <module title>
```

New:
```
📝 1-MODUL VAZIFASI
```

The number comes from `m.position + 1` (already computed), so newly added modules automatically render `4-MODUL VAZIFASI`, `5-MODUL VAZIFASI`, etc. The module title is dropped from the button (already shown in the message body above).

### 2. Per-SAP buttons after tapping a module (line ~3328)

Currently:
```
📤 V1.S1 — <title>
📤 V1.S2 — <title>
📤 V1.S3 — <title>
```

New (numbered sequentially within the module by SAP order):
```
📤 Vazifa 1 — <title>
📤 Vazifa 2 — <title>
📤 Vazifa 3 — <title>
```

For a module with no SAPs (single standalone task), only one button is shown: `📤 Vazifa 1 — <title>` — same flow as before.

The header message stays:
```
📝 M{n} — {moduleTitle}

Qaysi vazifani topshirasiz?
```

### 3. Scope guarantees

- No DB schema or callback-data changes (`hw:mod:<moduleId>`, `hw:start:<assignmentId>` unchanged).
- Submission detection, grading flow, teacher notifications, and the in-app `HomeworkProfileSection` are not touched.
- Behavior for any future N-th module is automatic from `module.position`.

## Verification

- Manual smoke test in Telegram: open `/vazifalar` → confirm buttons read `1-MODUL VAZIFASI`, `2-MODUL VAZIFASI`, `3-MODUL VAZIFASI`.
- Tap `3-MODUL VAZIFASI` → confirm three buttons `Vazifa 1/2/3` appear and each opens the correct submission intent.
- Tap a single-task module → confirm one `Vazifa 1` button still works end-to-end.
