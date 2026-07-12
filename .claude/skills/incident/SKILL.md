---
name: incident
description: Run the mandatory 6-step incident doctrine when any bug, complaint, or anomaly is reported. Use whenever the owner reports misbehavior, a watchdog fires, or a student/teacher complaint arrives. Never fix just the instance.
---

Run the full incident loop from CLAUDE.md for: $ARGUMENTS

Work through ALL six steps in order. Do not skip a step because the fix looks obvious —
the doctrine exists because obvious fixes kept missing sibling bugs.

## 1. Reproduce & root-cause from evidence

No fix without a verified failure sequence. Evidence sources, in order of value:
- `webhook_inbox` — every Telegram update is persisted raw; reconstruct the exact
  sequence of updates around the incident timestamp.
- `homework_teacher_dm_queue.error` — delivery failures with reasons.
- `admin_actions` — who did what, when.
- Function logs (`/analytics/endpoints/logs.all` in the Supabase dashboard).
- The domain tables themselves (submissions, xp_events, profiles).

If DB access is unavailable in this session, write the exact SQL for the owner to run
or use the read-only Supabase MCP if configured.

## 2. Fan out the class

Before writing any fix, enumerate EVERY sibling scenario:
- Same bug in other code paths (bot flow / picker / auto-capture / web).
- Other callback prefixes with the same pattern.
- Race variants (two students, two taps, retry + trigger overlap).
- Quantify blast radius with SQL: how many students/rows affected, since when.
Precedent: one 84-byte callback bug → audit of every button found two more dead screens.

## 3. Fix the class, not the case

- Shared engines over per-path patches.
- One pending rule used by every view.
- Atomic SQL (claims, jsonb appends) over read-modify-write.

## 4. Heal history

A fixed bug usually left damage behind. Write the backfill/reconciler that repairs old
rows — idempotent, ref-key/cycle-deduped — run it, verify counts before/after.

## 5. Add a detector

Every failure class gets an automated signal that fires BEFORE the next complaint:
- DB-side watchdog (SQL + pg_net → Telegram DM to admins), and/or
- a field in `hw_dm_health_stats()`, and/or
- the out-of-band GitHub verifier (`.github/workflows/hw-dm-health.yml`).
Rule: new features must emit DB-visible health signals — function-log-only errors are
invisible to the watchdog layer.

## 6. Record the lesson

Update the auto-memory files (especially `homework-capture-incident`) with root cause,
kill-switch, and detector location. Update CLAUDE.md if a new constraint was learned.

## Definition of done

All six steps have artifacts: evidence query results, the class enumeration, the fix PR,
the executed backfill with counts, the detector's location, and the memory update.
Present them as a checklist with ✅ per step.
