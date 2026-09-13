-- Serialize Mini-App homework submissions per (student, assignment) so concurrent requests can never each
-- post media into the SHARED CLASS TOPIC.
--
-- WHY: submit-homework's multipart path posts the student's files into their Telegram group topic — an
-- IRREVERSIBLE, class-visible side effect. Two racing requests for the same assignment (double-tap, a client
-- retry after a slow 50MB upload on mobile, two open webviews) would each pass validation and each post,
-- leaving duplicate media in the group; worse, on the ungraded-resubmission path both then run a plain
-- UPDATE and last-writer-wins silently orphans the other request's already-posted media. The existing
-- unique (user_id, assignment_id) index on homework_submissions only catches the fresh-INSERT race, and only
-- AFTER the post already happened.
--
-- Rather than pre-inserting a placeholder submission (which would fire the +15 XP INSERT trigger for a
-- submission that may never complete), the claim lives in its own tiny table: the PK makes the claim atomic,
-- so exactly one request proceeds to Telegram and the rest get a clean 409.
--
-- Rows are transient — held for one request and deleted in a finally. claimed_at exists only so a crashed /
-- timed-out request can be taken over after a short staleness window instead of wedging the assignment.
create table if not exists public.homework_submit_claims (
  user_id       uuid        not null,
  assignment_id uuid        not null,
  claimed_at    timestamptz not null default now(),
  primary key (user_id, assignment_id)
);

-- Written ONLY by submit-homework via the service role. No policies = no anon/authenticated access at all
-- (service_role bypasses RLS), so a student can never inspect or clear another student's claim.
alter table public.homework_submit_claims enable row level security;

comment on table public.homework_submit_claims is
  'Transient per-(student,assignment) claim held by submit-homework while it posts homework media into the Telegram group topic, so concurrent requests cannot double-post into a shared class topic. Rows are deleted when the request finishes; claimed_at allows taking over a stale (crashed) claim.';
