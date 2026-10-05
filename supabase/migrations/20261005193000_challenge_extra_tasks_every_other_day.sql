-- SUPERSEDED, NEVER APPLIED (2026-10-05): this file's migration was added by #270, but that PR also deleted
-- 20261005112000 with near-identical text, so git reported a RENAME and the deploy workflow (git diff
-- --diff-filter=A) never ran it. The same migration ships as 20261005194500. Kept as a no-op so the repo
-- history stays honest and a replay of every file applies it exactly once.
select 1;
