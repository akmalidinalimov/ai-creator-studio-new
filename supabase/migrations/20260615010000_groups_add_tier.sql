-- Groups carry a TIER (in addition to their course). A group's tier becomes the
-- single source of truth for the tier of every student placed in it: the sales
-- intake form picks a group, and the student inherits that group's course + tier.
--
-- GOLDEN BASELINE: additive, nullable column only. NULL = no tier = full access
-- (today's behavior). Every existing AI CREATORS 4.0 group stays NULL, so no
-- student, enrollment, progress, or access decision changes. has_module_access
-- reads enrollments.tier_id, never groups.tier_id — this column only drives how
-- NEW students are assigned a tier at intake time. No backfill, no RLS change,
-- no trigger. If a tier is deleted, affected groups fall back to NULL (full).
ALTER TABLE public.groups
  ADD COLUMN IF NOT EXISTS tier_id uuid REFERENCES public.course_tiers(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_groups_tier ON public.groups(tier_id);
