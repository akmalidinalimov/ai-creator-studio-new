-- INSTAGRAM HANDLE: one parse rule for every writer; post/reel links and handle-less links are refused,
-- never stored, never allowed to wipe a handle, and never silent.
--
-- ═══ THE BUG (verified read-only against production, 2026-09-30) ═══
-- Challenge 6.0 credits a verified Instagram post to the student whose profiles.instagram_username
-- matches it (30 points per Instagram task), and challenge_task_render_post_text() sends every student
-- of an Instagram task to the app's Sozlamalar to set it. The BEFORE trigger
-- trg_profiles_normalize_instagram -> normalize_instagram_username() (live prosrc md5
-- c872c1b43db3b0dc23e00633d17fdea2, installed by 20260920103000) lower-cases, trims, takes the first
-- path segment of an instagram.com/ link, strips a leading "@", then tests ^[a-z0-9._]{1,30}$:
--   * a value that fails is silently replaced by the OLD value on an UPDATE (NULL on an INSERT) and the
--     row still saves. Settings.tsx read back only `id`, so the student saw "Saqlandi" while nothing was
--     stored; trg_profiles_zz_instagram_audit fires only when the value changes, so no row recorded it.
--     'my handle', 'алишер' and 'my-handle' were all dropped this way.
--   * a pasted post or reel link is stored as its first path segment:
--     'https://www.instagram.com/reel/C8xYz12/?igsh=abc' -> 'reel', 'https://www.instagram.com/p/ABC123/'
--     -> 'p', 'instagram.com' -> 'instagram.com'. uq_profiles_instagram_username (UNIQUE, citext) then
--     hands 'reel' to the first student who pastes a reel, and every later one gets a raw English
--     "duplicate key value violates unique constraint" — which also threw away the name/timezone edits
--     saved in the same UPDATE.
--   * 'https://instagram.com/' (a link with no handle) normalizes to NULL and CLEARS an existing handle.
-- Blast radius today: 695 profiles, 1 handle set (by its student, 2026-09-30 15:23 UTC, valid), 0 stored
-- values that the new rule would refuse (no 'reel'/'p'/'instagram.com'), 1 'instagram_handle_changed'
-- audit row. Nothing to heal.
--
-- ═══ THE FIX ═══
-- 1. public.instagram_handle_parse(text) -> (handle, reason). Pure (IMMUTABLE, no table access), the DB
--    twin of src/lib/instagramHandle.ts parseInstagramHandle(); src/test/instagramHandle.test.ts reads THIS
--    file and fails if the reserved-segment list or any parity case below disagrees with the TS copy.
--      blank                                   -> (NULL, NULL)            a blank field clears the handle
--      instagram.com/<p|reel|reels|tv|stories|explore|accounts|direct|share|s|about|legal|developer|web>/…
--                                              -> (NULL, not_profile_link)
--      instagram.com/ with no segment, or a bare "instagram.com"
--                                              -> (NULL, no_handle_in_link)
--      only "@"                                -> (NULL, empty)
--      more than 30 characters                 -> (NULL, too_long)
--      anything but a-z 0-9 . _                -> (NULL, bad_chars)
--      otherwise                               -> (handle, NULL)          lower-cased, "@" and link stripped
-- 2. public.instagram_handle_note_rejection(user, input, reason, op): SECURITY DEFINER, writes one
--    admin_actions 'instagram_handle_rejected' row (input truncated to 120 chars, reason, op, jwt role),
--    at most one per person per distinct input per minute. It does nothing unless called from inside a
--    trigger (pg_trigger_depth() >= 1, the 20260930120020 profiles_guard_* precedent), so a signed-in user
--    who can reach it over /rest/v1/rpc cannot forge rows.
-- 3. normalize_instagram_username(), pinned rewrite: parse; a valid handle or a blank field is stored as
--    parsed; a refused value is recorded (2) and then the OLD value is kept on an UPDATE and NULL stored on
--    an INSERT — never the raw input. An unexpected parse error is treated the same way (reason
--    'parse_error:<sqlstate>'), where the old body returned NEW with the RAW input.
-- Behaviour that changes on purpose: a non-blank input that yields no handle ('@', 'https://instagram.com/')
-- no longer clears a stored handle; post/reel/story links are refused instead of stored as 'reel'/'p'.
-- Unchanged: NULL and a blank string still clear the handle; the unique index; profiles_instagram_audit;
-- #222's profiles_column_guard (instagram_username is not a guarded column — profiles_guard_values() lists
-- only telegram_id, telegram_username, email, group_id, status, archived_at, account_type,
-- telegram_write_access_at, created_at).
--
-- WRITERS (all checked): src/pages/Settings.tsx (the student; this PR validates with the TS twin, sends the
-- NORMALIZED handle in its own UPDATE and reads the stored value back), src/pages/SalesIntake.tsx ->
-- staff-intake (service_role; this PR validates the form with the same rule). The bot and the Mini App
-- have no other Instagram field. READERS: challenge_health() counts handles; unchanged.
--
-- ═══ GRANTS ═══
-- normalize_instagram_username() is SECURITY INVOKER: for a student's own save it runs as `authenticated`
-- and for staff-intake as `service_role`, and EXECUTE is checked on every function it calls. So both new
-- functions are revoked from PUBLIC, anon and authenticated, then granted to authenticated and
-- service_role (the parse is pure; the note is trigger-depth gated). Owner, ACL and SECURITY INVOKER of
-- normalize_instagram_username() are asserted unchanged.
--
-- ═══ HOW, and why it is safe ═══
-- The trigger function is rewritten FROM ITS LIVE pg_get_functiondef, and only if its live prosrc (CRs
-- stripped) has the md5 read on 2026-09-30; anything else aborts with "regenerate". The whole prosrc is the
-- single replaced text (asserted to occur exactly once in the definition). After CREATE OR REPLACE (body
-- validation on) the stored definition must equal the executed text.
-- SELF-TEST (never sends, never awards, needs no JWT, takes no lock; mutates nothing it checks):
--   A. every parity case through instagram_handle_parse (pure);
--   B. grants, SECURITY DEFINER / INVOKER flags, volatility, the stored body, the trigger still enabled;
--   C. end to end on a real student row, as the migration role, inside a sub-block that raises a sentinel
--      so the implicit savepoint rolls EVERYTHING back on the success path too: a valid handle is stored
--      normalized; a reel link, a handle-less link and bad characters each keep it and leave one
--      'instagram_handle_rejected' row; a blank clears it; a direct call of the note at trigger depth 0
--      writes nothing. Then: the row, its updated_at and admin_actions are exactly as before. The profiles
--      triggers this fires (normalize, updated_at, #222's column guard, the instagram audit) take no
--      advisory lock and make no HTTP call (checked on production).
-- REPLAY-SAFE: the marker "(20260930154000)" in the trigger body means the rewrite is in place and is
-- skipped; both new functions are CREATE OR REPLACE; the self-test runs either way; the audit row is
-- written once.
-- DRY-RUN, read-only against production on 2026-09-30: the parse rule over the parity cases (0
-- mismatches), the pin and the single occurrence. PGlite harness:
-- supabase/functions/_challenge/testing/instagram-handle-check.ts (live shapes, live trigger bodies).
-- KILL SWITCH: alter table public.profiles disable trigger trg_profiles_normalize_instagram — the app still
-- sends normalized handles; staff intake would then store what sales typed.

-- ─────────────── 1. The parse rule (pure) ───────────────
create or replace function public.instagram_handle_parse(p_input text, out handle text, out reason text)
language plpgsql
immutable
set search_path to 'pg_catalog', 'public'
as $fn$
declare
  _v   text;
  _seg text;
begin
  handle := null;
  reason := null;
  _v := lower(regexp_replace(coalesce(p_input, ''), '^[[:space:]]+|[[:space:]]+$', '', 'g'));
  if _v = '' then
    return;                                  -- a blank field clears the handle
  end if;
  if position('instagram.com/' in _v) > 0 then
    _seg := split_part(_v, 'instagram.com/', 2);
    _seg := split_part(split_part(split_part(_seg, '?', 1), '#', 1), '/', 1);
    -- instagram-reserved-segments: the same list as INSTAGRAM_RESERVED_SEGMENTS in src/lib/instagramHandle.ts
    if _seg = any (array['p', 'reel', 'reels', 'tv', 'stories', 'explore', 'accounts', 'direct', 'share', 's', 'about', 'legal', 'developer', 'web']) then
      reason := 'not_profile_link';          -- a post / reel / story / other page, not a profile
      return;
    elsif _seg = '' then
      reason := 'no_handle_in_link';         -- "https://instagram.com/", "instagram.com/?hl=ru"
      return;
    end if;
    _v := _seg;
  elsif position('instagram.com' in _v) > 0 then
    reason := 'no_handle_in_link';           -- a bare "instagram.com"
    return;
  end if;
  _v := regexp_replace(regexp_replace(_v, '^@+', ''), '^[[:space:]]+|[[:space:]]+$', '', 'g');
  if _v = '' then
    reason := 'empty';
  elsif length(_v) > 30 then
    reason := 'too_long';
  elsif _v !~ '^[a-z0-9._]+$' then
    reason := 'bad_chars';
  else
    handle := _v;
  end if;
end;
$fn$;

revoke execute on function public.instagram_handle_parse(text) from public, anon, authenticated;
grant execute on function public.instagram_handle_parse(text) to authenticated, service_role;

-- ─────────────── 2. The refusal signal (trigger-only) ───────────────
create or replace function public.instagram_handle_note_rejection(p_user uuid, p_input text, p_reason text, p_op text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  _input text := left(coalesce(p_input, ''), 120);
begin
  -- Only normalize_instagram_username() calls this. A direct /rest/v1/rpc call runs at trigger depth 0
  -- and writes nothing, so a signed-in user cannot forge rows with it.
  if pg_trigger_depth() < 1 then
    return;
  end if;
  -- One row per person per distinct input per minute: a double-tapped Save is one refusal.
  if exists (select 1 from public.admin_actions a
              where a.action = 'instagram_handle_rejected'
                and a.created_at > now() - interval '1 minute'
                and a.target_user_id is not distinct from p_user
                and a.details->>'input' = _input) then
    return;
  end if;
  insert into public.admin_actions (actor_user_id, action, target_user_id, details)
  values (auth.uid(), 'instagram_handle_rejected', p_user,
          jsonb_build_object('input', _input, 'reason', p_reason, 'op', p_op,
                             'jwt_role', auth.role(), 'request_role', current_setting('role', true),
                             'source', 'normalize_instagram_username'));
end;
$fn$;

revoke execute on function public.instagram_handle_note_rejection(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.instagram_handle_note_rejection(uuid, text, text, text) to authenticated, service_role;

-- ─────────────── 3. normalize_instagram_username(): pinned rewrite ───────────────
do $mig$
declare
  _pin    constant text := 'c872c1b43db3b0dc23e00633d17fdea2';  -- md5(replace(prosrc, CR, '')), live, 2026-09-30
  _marker constant text := '(20260930154000)';
  _body   constant text := $body$
declare
  _raw    text;
  _handle text;
  _reason text;
begin
  -- (20260930154000) One parse rule for every writer: public.instagram_handle_parse(), the DB twin of
  -- src/lib/instagramHandle.ts. A post/reel link, a link with no handle, bad characters or more than 30
  -- characters is REFUSED: never stored, never allowed to wipe a handle that already earns points, and
  -- recorded in admin_actions ('instagram_handle_rejected') so a dropped handle is never silent.
  if new.instagram_username is null then
    return new;
  end if;
  _raw := new.instagram_username::text;
  begin
    select p.handle, p.reason into _handle, _reason from public.instagram_handle_parse(_raw) p;
  exception when others then
    _handle := null;
    _reason := 'parse_error:' || sqlstate;
  end;
  if _reason is null then
    new.instagram_username := _handle;       -- the normalized handle, or NULL for a blank field (clear)
    return new;
  end if;
  begin
    perform public.instagram_handle_note_rejection(new.id, _raw, _reason, tg_op);
  exception when others then
    null;                                    -- the signal must never block the save
  end;
  if tg_op = 'UPDATE' then
    new.instagram_username := old.instagram_username;
  else
    new.instagram_username := null;
  end if;
  return new;
end;
$body$;
  _fn regprocedure;
  _src text; _def text; _new text;
  _acl text; _owner oid; _secdef boolean;
  _n int;
begin
  -- The CREATE OR REPLACE below must validate the edited body, whatever the session default is.
  perform set_config('check_function_bodies', 'on', true);

  _fn := to_regprocedure('public.normalize_instagram_username()');
  if _fn is null then
    raise exception 'ABORT: public.normalize_instagram_username() does not exist';
  end if;
  select prosrc, coalesce(array_to_string(proacl, ','), ''), proowner, prosecdef
    into _src, _acl, _owner, _secdef
    from pg_proc where oid = _fn;

  if position(_marker in _src) > 0 then
    raise notice 'normalize_instagram_username already uses instagram_handle_parse -- rewrite skipped';
  else
    if md5(replace(_src, E'\r', '')) <> _pin then
      raise exception 'ABORT: normalize_instagram_username changed since it was verified on 2026-09-30 (md5 %); re-read the live definition and regenerate this migration',
        md5(replace(_src, E'\r', ''));
    end if;
    _def := pg_get_functiondef(_fn);
    _n := (length(_def) - length(replace(_def, _src, ''))) / length(_src);
    if _n <> 1 then
      raise exception 'ABORT: the normalize_instagram_username body matched % times in its definition (want exactly 1); regenerate this migration', _n;
    end if;
    _new := replace(_def, _src, _body);

    execute _new;

    -- Post-conditions, from the catalog only.
    if pg_get_functiondef(_fn) is distinct from _new then
      raise exception 'ABORT: normalize_instagram_username -- the stored definition differs from the one executed';
    end if;
    if (select coalesce(array_to_string(proacl, ','), '') from pg_proc where oid = _fn) <> _acl
       or (select proowner from pg_proc where oid = _fn) <> _owner
       or (select prosecdef from pg_proc where oid = _fn) <> _secdef then
      raise exception 'ABORT: normalize_instagram_username -- owner, ACL or SECURITY DEFINER changed';
    end if;
  end if;
end $mig$;

-- ─────────────── 4. Self-test + audit ───────────────
do $selftest$
declare
  _parse regprocedure := to_regprocedure('public.instagram_handle_parse(text)');
  _note  regprocedure := to_regprocedure('public.instagram_handle_note_rejection(uuid,text,text,text)');
  _norm  regprocedure := to_regprocedure('public.normalize_instagram_username()');
  _probe constant text := 'zz154selftest';
  _c record;
  _h text; _r text;
  _bad text := '';
  _src text;
  _student uuid; _updated timestamptz;
  _res jsonb := '{}'::jsonb;
  _e2e text := 'ran';
  _rows_before bigint;
begin
  -- A. The parse rule, case by case.
  for _c in
    select * from (values
      -- parity-cases:begin (src/test/instagramHandle.test.ts runs every row through the TS twin)
      ('@My.Handle', 'my.handle', null),
      ('my.handle', 'my.handle', null),
      ('  @@user_1  ', 'user_1', null),
      ('https://www.instagram.com/my.handle/?igsh=abc', 'my.handle', null),
      ('instagram.com/My_Handle', 'my_handle', null),
      ('https://instagram.com/my.handle#top', 'my.handle', null),
      ('www.instagram.com/@some.one', 'some.one', null),
      ('https://www.instagram.com/reel/C8xYz12/?igsh=abc', null, 'not_profile_link'),
      ('https://www.instagram.com/p/ABC123/', null, 'not_profile_link'),
      ('https://www.instagram.com/stories/someone/3456/', null, 'not_profile_link'),
      ('https://instagram.com/explore/tags/ai/', null, 'not_profile_link'),
      ('https://www.instagram.com/share/reel/BAabc/', null, 'not_profile_link'),
      ('https://instagram.com/', null, 'no_handle_in_link'),
      ('instagram.com', null, 'no_handle_in_link'),
      ('https://www.instagram.com', null, 'no_handle_in_link'),
      ('instagram.com/?hl=ru', null, 'no_handle_in_link'),
      ('@', null, 'empty'),
      ('@@@', null, 'empty'),
      ('my handle', null, 'bad_chars'),
      ('алишер', null, 'bad_chars'),
      ('my-handle', null, 'bad_chars'),
      ('https://t.me/someone', null, 'bad_chars'),
      ('abcdefghijklmnopqrstuvwxyz12345', null, 'too_long'),
      ('abcdefghijklmnopqrstuvwxyz1234', 'abcdefghijklmnopqrstuvwxyz1234', null),
      ('reel', 'reel', null),
      ('', null, null),
      ('   ', null, null)
      -- parity-cases:end
    ) as v(input, want_handle, want_reason)
  loop
    select p.handle, p.reason into _h, _r from public.instagram_handle_parse(_c.input) p;
    if _h is distinct from _c.want_handle or _r is distinct from _c.want_reason then
      _bad := _bad || format(' [%s -> %s / %s]', _c.input, _h, _r);
    end if;
  end loop;
  if _bad <> '' then
    raise exception 'ABORT: instagram_handle_parse disagrees with its cases:%', _bad;
  end if;
  select p.handle, p.reason into _h, _r from public.instagram_handle_parse(null) p;
  if _h is not null or _r is not null then
    raise exception 'ABORT: instagram_handle_parse(NULL) must be (NULL, NULL), got (%, %)', _h, _r;
  end if;

  -- B. Static checks.
  if _parse is null or _note is null or _norm is null then
    raise exception 'ABORT: a function of this migration is missing';
  end if;
  if not has_function_privilege('authenticated', _parse, 'EXECUTE') or not has_function_privilege('service_role', _parse, 'EXECUTE')
     or not has_function_privilege('authenticated', _note, 'EXECUTE') or not has_function_privilege('service_role', _note, 'EXECUTE') then
    raise exception 'ABORT: authenticated and service_role must be able to execute both helpers (the INVOKER trigger calls them as the writer)';
  end if;
  if has_function_privilege('anon', _parse, 'EXECUTE') or has_function_privilege('anon', _note, 'EXECUTE') then
    raise exception 'ABORT: anon can execute an instagram helper';
  end if;
  if not (select prosecdef from pg_proc where oid = _note) or (select prosecdef from pg_proc where oid = _parse)
     or (select prosecdef from pg_proc where oid = _norm) then
    raise exception 'ABORT: expected note = SECURITY DEFINER, parse and normalize = SECURITY INVOKER';
  end if;
  if (select provolatile from pg_proc where oid = _parse) <> 'i' then
    raise exception 'ABORT: instagram_handle_parse must be IMMUTABLE';
  end if;
  select prosrc into _src from pg_proc where oid = _norm;
  if position('(20260930154000)' in _src) = 0
     or position('from public.instagram_handle_parse(_raw)' in _src) = 0
     or position('perform public.instagram_handle_note_rejection(new.id, _raw, _reason, tg_op);' in _src) = 0
     or position('new.instagram_username := old.instagram_username;' in _src) = 0 then
    raise exception 'ABORT: normalize_instagram_username -- the stored body is not the parse-based one';
  end if;
  if not exists (select 1 from pg_trigger
                  where tgrelid = 'public.profiles'::regclass and tgname = 'trg_profiles_normalize_instagram'
                    and tgfoid = _norm and tgenabled <> 'D') then
    raise exception 'ABORT: trg_profiles_normalize_instagram is missing, disabled, or not on normalize_instagram_username()';
  end if;

  -- C. End to end on a real student row, rolled back by a sentinel (see the header).
  select p.id, p.updated_at into _student, _updated
    from public.profiles p
   where p.instagram_username is null and p.status = 'active' and p.archived_at is null
     and not exists (select 1 from public.user_roles r
                     where r.user_id = p.id and r.role in ('admin', 'teacher', 'superadmin'))
   order by p.created_at, p.id limit 1;
  select count(*) into _rows_before from public.admin_actions where details::text like '%' || _probe || '%';

  if _student is null then
    _e2e := 'skipped: no active student without a handle';
  elsif exists (select 1 from public.profiles where instagram_username = _probe || '.ok') then
    _e2e := 'skipped: the probe handle is taken';
  else
    begin
      update public.profiles set instagram_username = '@ZZ154SelfTest.OK' where id = _student
        returning instagram_username::text into _h;
      _res := _res || jsonb_build_object('valid', _h);
      update public.profiles set instagram_username = 'https://www.instagram.com/reel/' || _probe || '/?igsh=x' where id = _student
        returning instagram_username::text into _h;
      _res := _res || jsonb_build_object('reel_link', _h);
      update public.profiles set instagram_username = 'https://instagram.com/?' || _probe where id = _student
        returning instagram_username::text into _h;
      _res := _res || jsonb_build_object('no_handle_link', _h);
      update public.profiles set instagram_username = 'my ' || _probe where id = _student
        returning instagram_username::text into _h;
      _res := _res || jsonb_build_object('bad_chars', _h);
      _res := _res || jsonb_build_object('rejections', (
        select coalesce(jsonb_agg(a.details->>'reason' order by a.details->>'reason'), '[]'::jsonb)
          from public.admin_actions a
         where a.action = 'instagram_handle_rejected' and a.target_user_id = _student
           and a.details->>'input' like '%' || _probe || '%'));
      update public.profiles set instagram_username = '' where id = _student
        returning instagram_username::text into _h;
      _res := _res || jsonb_build_object('blank', coalesce(_h, '<null>'));
      perform public.instagram_handle_note_rejection(_student, 'direct ' || _probe, 'bad_chars', 'UPDATE');
      _res := _res || jsonb_build_object('direct_rows', (
        select count(*) from public.admin_actions a
         where a.action = 'instagram_handle_rejected' and a.details->>'input' = 'direct ' || _probe));
      raise exception using errcode = 'ZX154', message = 'instagram handle self-test rollback';
    exception when sqlstate 'ZX154' then
      null;
    end;

    if _res->>'valid' is distinct from _probe || '.ok'
       or _res->>'reel_link' is distinct from _probe || '.ok'
       or _res->>'no_handle_link' is distinct from _probe || '.ok'
       or _res->>'bad_chars' is distinct from _probe || '.ok'
       or _res->'rejections' is distinct from '["bad_chars", "no_handle_in_link", "not_profile_link"]'::jsonb
       or _res->>'blank' is distinct from '<null>'
       or _res->>'direct_rows' is distinct from '0' then
      raise exception 'ABORT: instagram handle end-to-end self-test failed: %', _res;
    end if;
    -- Nothing leaked out of the rolled-back block.
    if exists (select 1 from public.profiles
                where id = _student and (instagram_username is not null or updated_at is distinct from _updated))
       or (select count(*) from public.admin_actions where details::text like '%' || _probe || '%') <> _rows_before then
      raise exception 'ABORT: the instagram handle self-test left changes behind';
    end if;
  end if;

  -- Audit once, even if a racing deploy replays this file.
  insert into public.admin_actions (actor_user_id, action, details)
  select null, 'instagram_handle_parse_applied',
         jsonb_build_object('migration', '20260930154000',
                            'why', 'post/reel links were stored as ''reel''/''p'', a link with no handle cleared the handle, and a refused handle was dropped with no record while the page said Saqlandi',
                            'self_test', _e2e, 'self_test_results', _res,
                            'normalize_md5', (select md5(replace(prosrc, E'\r', '')) from pg_proc where oid = _norm),
                            'signal', 'admin_actions action = instagram_handle_rejected',
                            'kill_switch', 'alter table public.profiles disable trigger trg_profiles_normalize_instagram',
                            'at', now())
  where not exists (select 1 from public.admin_actions where action = 'instagram_handle_parse_applied');
end
$selftest$;
