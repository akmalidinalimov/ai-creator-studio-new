-- Post-migration data fix (applied live via the management API on 2026-07-05,
-- codified here for the record and for any future auth.users import).
--
-- When the 558 live students were migrated into this project, the auth.users
-- rows were inserted from a REST export that did not carry every GoTrue-managed
-- column. Two problems resulted:
--   1. instance_id was NULL. GoTrue filters by instance_id, so the admin API and
--      login could not find the users ("Database error finding users" / 0 users).
--   2. confirmation_token, recovery_token, email_change_token_new and email_change
--      were NULL. GoTrue scans these into non-nullable Go strings, so a NULL makes
--      the user query fail outright.
--
-- Both are safe to normalize: instance_id gets GoTrue's single-tenant default and
-- the token/change columns become empty strings (their intended "no pending
-- action" value). Idempotent — only touches rows still holding the bad values.
UPDATE auth.users
SET instance_id = '00000000-0000-0000-0000-000000000000'
WHERE instance_id IS NULL;

UPDATE auth.users
SET confirmation_token     = COALESCE(confirmation_token, ''),
    recovery_token         = COALESCE(recovery_token, ''),
    email_change_token_new = COALESCE(email_change_token_new, ''),
    email_change           = COALESCE(email_change, '')
WHERE confirmation_token IS NULL
   OR recovery_token IS NULL
   OR email_change_token_new IS NULL
   OR email_change IS NULL;
