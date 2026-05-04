# Post-deploy smoke test — v3.14

Run after every publish. Target: ~5 minutes manual, or paste the SQL block at the bottom for automated DB-side checks.

Legend: ✅ pass · ⚠️ degraded but non-blocking · ❌ fail (rollback)

---

## 1. Admin nav (v3.14 phase 1)

- [ ] `/admin/dashboard` loads. Top nav shows: Dashboard · Courses · Users · Groups · **Boshqaruv ▾**
- [ ] `Bahalash` link is **not** in the top nav
- [ ] Open **Boshqaruv** dropdown → all 7 links present and clickable:
  Vazifalar · Sertifikatlar · Reaktivatsiya · Smart eslatmalar · Chuqur tahlillar · Reyting · Sozlamalar
- [ ] `/teacher/homework` still loads directly (not removed, just unlinked)
- [ ] Dashboard shows the **Engagement health** stacked bar (Active 7d / 30d / Logged once / Never)

## 2. Settings (v3.14)

- [ ] `/admin/settings` loads
- [ ] Edit any field → "o'zgartirildi" indicator appears
- [ ] Sticky **Hammasini saqlash** button appears at bottom; clicking it persists and clears indicators
- [ ] Reload → values still saved

## 3. Groups + Telegram topics (v3.13.1)

- [ ] `/admin/groups` list renders
- [ ] Hover row icons → tooltips show (Talabalar / Tahrirlash / O'chirish)
- [ ] Click **Tahrirlash** on a group → modal opens with **Telegram topiklari** section per module
- [ ] Paste `https://t.me/c/2123456789/15` → save → toast `N ta topik saqlandi` fires
- [ ] DB check: `select telegram_topic_id from group_module_topics where group_id=...` returns `15`

## 4. CSV import in Students modal (v3.13.2)

- [ ] Click people icon on a group row → Students modal opens
- [ ] Upload a CSV with mix of (a) existing student in another group, (b) existing student in this group, (c) brand-new email
- [ ] Toast format: `N talaba qo'shildi · X yangi · Y mavjud · Z allaqachon guruhda`
- [ ] New rows appear in `profiles` with `group_id` set; auth user created via `admin-create-students`

## 5. Bot perf (v3.14 phase 2)

- [ ] In Telegram, send `Statistikam` → first reply <1.5s, second tap (within 30s) **noticeably instant** (cache hit)
- [ ] Edge logs show `console.time` entries for handler latency
- [ ] Trigger re-engagement send twice within 5 min for same user → `telegram_magic_links` gets **1** new row, not 2
- [ ] `pg_cron` job `bot-warmth-ping` is enabled and last run <10 min ago
- [ ] Teacher submits a grade → student's next `Mening vazifalarim` reflects it immediately (cache invalidated)

## 6. Backward compat — v3.0.X → v3.13.2 happy paths

- [ ] Student login (email + password) works
- [ ] Telegram magic-link login works (`/auth/magic?t=...` redeems and lands on `/dashboard`)
- [ ] Open a lesson → Bunny video plays (signed URL)
- [ ] Submit a homework from `/lesson/...` → row in `homework_submissions`
- [ ] Bot grading flow: teacher grades from bot → score recorded, student notified
- [ ] Weekly nudge cron (`detect-and-nudge`) last run successful
- [ ] Certificate generation: complete a course → cert PDF generated, share image works
- [ ] Leaderboard `/leaderboard` renders top N

---

## Automated DB checks (paste into SQL editor)

```sql
-- 1. Bot warmth cron healthy
select jobname, schedule, active,
       (select max(start_time) from cron.job_run_details d where d.jobid = j.jobid) as last_run
from cron.job j where jobname = 'bot-warmth-ping';

-- 2. Magic link reuse working (no duplicates within 5 min for same user+purpose)
select user_id, purpose, count(*)
from telegram_magic_links
where created_at > now() - interval '1 day'
group by 1,2 having count(*) > (
  select count(distinct date_trunc('minute', created_at) / 5) from telegram_magic_links t2
  where t2.user_id = telegram_magic_links.user_id and t2.purpose = telegram_magic_links.purpose
    and t2.created_at > now() - interval '1 day'
);
-- expect 0 rows

-- 3. Group topics save round-trip
select group_id, module_id, telegram_topic_id, telegram_topic_url, updated_at
from group_module_topics order by updated_at desc limit 5;

-- 4. CSV import created users recently
select id, email, group_id, created_at from profiles
where created_at > now() - interval '1 hour' order by created_at desc;

-- 5. Edge function error rate (last hour) — should be < 1%
select function_id, count(*) filter (where status_code >= 500) * 1.0 / count(*) as err_rate
from function_logs where timestamp > now() - interval '1 hour'
group by 1 order by err_rate desc;
```

## Rollback triggers

Hard rollback if any of these:
- Login broken (email or magic-link)
- Bot webhook returning 5xx > 5% for >5 min
- `group_module_topics` writes failing
- Dashboard unable to load for admin role
