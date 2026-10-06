-- Support auto-resolver, PR1: the data layer (owner request + approved plan, 2026-10-06). READ-ONLY: nothing here
-- changes a student; the agent is OFF (platform_settings.support_agent.enabled = false).
--
-- For every «❓ Yordam» ticket (support_tickets, #278) the agent will:
--   1. build a PII-careful snapshot of the student's platform state — support_user_snapshot(user);
--   2. evaluate a deterministic rule catalog of the incident classes already met — support_evaluate_rules(snapshot):
--      every hit names a whitelisted action WITH its exact args (the model never decides — CLAUDE.md);
--   3. (PR2) let an LLM map the free-text complaint to the hits and draft the replies, (PR3) propose the fix to the
--      admin, execute it only after ✅, verify it, answer the student, (PR4) escalate code-class causes to the ops PR
--      pipeline.
--
-- This migration: the settings, the queue (support_diagnoses), the proposal ledger (support_fix_proposals), the AI
-- cost ledger (support_ai_calls), the snapshot, the rules (pure, read nothing → the self-test below runs them on fixture
-- snapshots, inert by construction), and the enqueue path (trigger on a new ticket + a reconciler cron), both doing
-- nothing while the agent is disabled.

-- ───────────────────────────── settings ─────────────────────────────
insert into public.platform_settings (key, value)
values ('support_agent', jsonb_build_object(
  'enabled', false,                -- master kill-switch: nothing is queued while false
  'mode', 'off',                   -- off | shadow (diagnose, show to admins, no buttons) | propose (✅ executes)
  'auto_actions', '[]'::jsonb,     -- PR5: actions that may run without a tap (empty = every fix needs ✅)
  'ai_daily_budget_usd', 1,
  'proposal_ttl_h', 24,
  'escalate', jsonb_build_object('enabled', false, 'min_users', 3, 'window_h', 72, 'cooldown_d', 7)))
on conflict (key) do nothing;

-- ───────────────────────────── tables ─────────────────────────────
create table if not exists public.support_diagnoses (
  id           bigserial primary key,
  ticket_id    bigint not null references public.support_tickets(id) on delete cascade,
  run_no       integer not null default 1,
  status       text not null default 'queued' check (status in ('queued', 'leased', 'done', 'needs_human', 'failed')),
  lease_until  timestamptz,
  attempts     integer not null default 0,
  snapshot     jsonb,
  rule_hits    jsonb,
  llm          jsonb,
  cost_usd     numeric(10, 6) not null default 0,
  error        text check (error is null or char_length(error) <= 500),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (ticket_id, run_no)
);
create index if not exists support_diagnoses_status_idx on public.support_diagnoses (status, created_at);

create table if not exists public.support_fix_proposals (
  id              bigserial primary key,           -- the id in the bot's sa:<x>:<id> callbacks (≤ 16 bytes)
  ticket_id       bigint not null references public.support_tickets(id) on delete cascade,
  diagnosis_id    bigint references public.support_diagnoses(id) on delete set null,
  rule_id         text not null,
  action          text check (action is null or action in (
                    'assign_group', 'heal_split', 'set_account_type', 'reconcile_points', 'task_accept',
                    'homework_resubmit')),            -- the ONLY executable actions (support_apply_fix, PR3)
  args            jsonb not null default '{}'::jsonb,
  args_hash       text not null,
  class           text not null check (class in ('data', 'reply_only', 'code_bug', 'needs_human')),
  confidence      text not null default 'medium' check (confidence in ('high', 'medium', 'low')),
  evidence        text check (evidence is null or char_length(evidence) <= 2000),
  student_message text check (student_message is null or char_length(student_message) <= 3500),
  status          text not null default 'shadow' check (status in (
                    'shadow', 'proposed', 'applied', 'verified', 'verify_failed', 'superseded', 'rejected',
                    'expired', 'failed', 'sent')),
  decided_by      uuid references public.profiles(id) on delete set null,
  decided_at      timestamptz,
  result          jsonb,
  admin_messages  jsonb not null default '[]'::jsonb check (jsonb_typeof(admin_messages) = 'array'),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create unique index if not exists support_fix_proposals_active_uq
  on public.support_fix_proposals (ticket_id, rule_id, args_hash)
  where status in ('shadow', 'proposed');
create index if not exists support_fix_proposals_ticket_idx on public.support_fix_proposals (ticket_id);

create table if not exists public.support_ai_calls (
  id            bigserial primary key,
  diagnosis_id  bigint references public.support_diagnoses(id) on delete set null,
  provider      text,
  model         text,
  input_tokens  integer,
  output_tokens integer,
  cost_usd      numeric(10, 6) not null default 0,
  ok            boolean not null default false,
  error         text check (error is null or char_length(error) <= 500),
  created_at    timestamptz not null default now()
);
create index if not exists support_ai_calls_created_idx on public.support_ai_calls (created_at);

do $$
declare
  _t text;
begin
  foreach _t in array array['support_diagnoses', 'support_fix_proposals', 'support_ai_calls'] loop
    execute format('alter table public.%I enable row level security', _t);
    execute format('revoke all on table public.%I from public, anon, authenticated', _t);
    execute format('grant select, insert, update, delete on table public.%I to service_role', _t);
    execute format('grant usage, select on sequence public.%I to service_role', _t || '_id_seq');
    execute format('drop policy if exists %I on public.%I', _t || '_admin_read', _t);
    execute format('create policy %I on public.%I for select to authenticated using (public.has_role((select auth.uid()), ''admin''::public.app_role))',
                   _t || '_admin_read', _t);
    execute format('grant select on table public.%I to authenticated', _t);
  end loop;
end $$;

-- ───────────────────────────── the snapshot ─────────────────────────────
create or replace function public.support_user_snapshot(_user uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
-- Everything the rules (and later the LLM) may know about one student, PII-careful: ids, group / course / module
-- names, counts, reasons (an ALLOWLIST of health actions, each reason ≤ 120 chars), timestamps. Never: the student's
-- name, email, phone, raw Telegram updates, message texts, IPs, user agents. (The snapshot is stored and, in PR2, the
-- LLM sees it; the admin card shows the name from the ticket instead.)
declare
  _p record;
  _tg bigint;
  _snap jsonb;
begin
  select p.id, p.telegram_id, p.telegram_username,
         p.status::text as status, p.archived_at, p.account_type::text as account_type,
         p.telegram_write_access_at, p.group_id
    into _p from public.profiles p where p.id = _user;
  if not found then
    return jsonb_build_object('v', 1, 'found', false, 'user_id', _user);
  end if;
  _tg := _p.telegram_id;

  select jsonb_build_object(
    'v', 1, 'found', true, 'user_id', _p.id, 'telegram_id', _tg, 'username', _p.telegram_username,
    'status', _p.status, 'archived', _p.archived_at is not null, 'account_type', _p.account_type,
    'write_access', _p.telegram_write_access_at is not null,
    'group', (select jsonb_build_object('id', g.id, 'name', g.name, 'course_id', g.course_id, 'course_title', c.title,
                                        'course_published', coalesce(c.published, false))
                from public.groups g left join public.courses c on c.id = g.course_id where g.id = _p.group_id),
    'roles', coalesce((select jsonb_agg(r.role::text order by r.role::text) from public.user_roles r where r.user_id = _p.id), '[]'::jsonb),
    'enrollments', coalesce((select jsonb_agg(jsonb_build_object('course_id', e.course_id, 'tier', t.name, 'module_limit', t.module_limit))
                               from public.enrollments e left join public.course_tiers t on t.id = e.tier_id
                              where e.user_id = _p.id), '[]'::jsonb),
    'twin', (select jsonb_build_object('role', case when s.a_id = _p.id then 'keeper' else 'twin' end,
                                       'other_id', case when s.a_id = _p.id then s.b_id else s.a_id end,
                                       'username', s.username, 'keeper_group', s.a_group, 'twin_group', s.b_group,
                                       'twin_empty', s.b_empty)
               from public.identity_split_pairs() s where s.a_id = _p.id or s.b_id = _p.id limit 1),
    'same_tg_profiles', case when _tg is null then 0 else
                          (select count(*) from public.profiles x where x.telegram_id = _tg and x.id <> _p.id) end,
    -- where they really post (14 days), by group, most active first
    'posting', coalesce((
      select jsonb_agg(jsonb_build_object('group_id', z.group_id, 'group_name', g.name, 'course_id', g.course_id,
                                          'n', z.n, 'last', z.last) order by z.n desc)
        from (select e.group_id, count(*)::int as n, max(e.sent_at) as last
                from public.group_message_events e
               where e.sent_at > now() - interval '14 days' and e.group_id is not null
                 and (e.profile_id = _p.id or (_tg is not null and e.profile_id is null and e.telegram_user_id = _tg))
               group by e.group_id) z
        join public.groups g on g.id = z.group_id), '[]'::jsonb),
    -- DB-visible health rows about them (7 days), by action + reason
    'health', coalesce((
      select jsonb_agg(jsonb_build_object('action', h.action, 'reason', h.reason, 'n', h.n, 'last', h.last) order by h.last desc)
        from (select a.action, left(coalesce(a.details->>'reason', a.details->>'error'), 120) as reason, count(*)::int as n,
                     max(a.created_at) as last
                from public.admin_actions a
               where a.created_at > now() - interval '7 days'
                 and a.action in ('telegram_send_failed', 'hw_capture_skipped', 'hw_capture_failed', 'group_moved',
                                  'group_move_carried', 'challenge_task_sender_held', 'group_poster_unresolved',
                                  'username_link_refused', 'telegram_username_conflict', 'video_access_denied',
                                  'support_ticket_undelivered', 'cross_course_move_refused', 'auto_register_failed',
                                  'miniapp_not_linked', 'miniapp_mint_failed', 'bot_write_access_stamp_failed')
                 and (a.target_user_id = _p.id
                      or (_tg is not null and (a.details->>'recipient' = _tg::text or a.details->>'telegram_id' = _tg::text
                                               or a.details->>'tg_user_id' = _tg::text)))
               group by 1, 2) h), '[]'::jsonb),
    'hw', jsonb_build_object(
      'submitted_30d', (select count(*) from public.homework_submissions s where s.user_id = _p.id and s.submitted_at > now() - interval '30 days'),
      'ungraded', (select count(*) from public.homework_submissions s where s.user_id = _p.id and (s.score is null or s.score_is_stale)),
      'last_at', (select max(s.submitted_at) from public.homework_submissions s where s.user_id = _p.id),
      'pending_open', (select count(*) from public.hw_pending_posts h where (h.user_id = _p.id or (_tg is not null and h.user_id is null and h.from_tg_id = _tg))
                          and h.state not in ('filed', 'done', 'cancelled', 'expired') and h.created_at > now() - interval '7 days')),
    'task_msgs', coalesce((
      select jsonb_agg(jsonb_build_object('outcome', m.outcome, 'group_id', m.group_id, 'n', m.n) order by m.n desc)
        from (select outcome, group_id, count(*)::int as n from public.challenge_task_messages
               where (user_id = _p.id or (_tg is not null and user_id is null and tg_user_id = _tg)) and sent_at > now() - interval '7 days'
               group by 1, 2) m), '[]'::jsonb),
    'task_subs', coalesce((
      select jsonb_agg(jsonb_build_object('id', s.id, 'task_id', s.task_id, 'status', s.status, 'missing', to_jsonb(s.missing),
                                          'reason', s.reason, 'at', s.last_item_at) order by s.last_item_at desc)
        from (select * from public.challenge_task_submissions where user_id = _p.id and last_item_at > now() - interval '7 days'
               order by last_item_at desc limit 5) s), '[]'::jsonb),
    'modules', coalesce((
      select jsonb_agg(jsonb_build_object('id', m.id, 'position', m.position, 'title', m.title,
                                          'access', public.has_module_access(_p.id, m.id)) order by m.position)
        from public.modules m join public.groups g on g.course_id = m.course_id where g.id = _p.group_id), '[]'::jsonb),
    'xp_total', (select x.total_xp from public.user_xp x where x.user_id = _p.id),
    'xp_7d', coalesce((select jsonb_object_agg(q.reason, q.s) from (select reason, sum(amount)::int as s from public.xp_events
                         where user_id = _p.id and created_at > now() - interval '7 days' group by reason) q), '{}'::jsonb),
    'client_errors_7d', coalesce((select jsonb_object_agg(q.event_type, q.n) from (select event_type, count(*)::int as n
                         from public.client_error_events where user_id = _p.id and created_at > now() - interval '7 days'
                         group by event_type) q), '{}'::jsonb),
    'last_move', (select jsonb_build_object('at', a.created_at, 'old_group', a.details->>'old_group', 'new_group', a.details->>'new_group')
                    from public.admin_actions a where a.action = 'group_moved' and a.target_user_id = _p.id
                   order by a.created_at desc limit 1),
    'open_tickets', (select count(*) from public.support_tickets t where t.user_id = _p.id and t.status = 'open'),
    'at', now())
  into _snap;
  return _snap;
end
$fn$;

revoke execute on function public.support_user_snapshot(uuid) from public, anon, authenticated;
grant execute on function public.support_user_snapshot(uuid) to service_role;

-- ───────────────────────────── the rule catalog v1 ─────────────────────────────
create or replace function public.support_evaluate_rules(_s jsonb)
returns jsonb
language plpgsql
stable
set search_path = public, pg_temp
as $fn$
-- Pure (reads nothing; STABLE only because it parses timestamps): the snapshot in, the hits out — [{rule, class, confidence, action, args, message_key, evidence}]. Every hit
-- names a whitelisted action (support_fix_proposals.action) with its EXACT args, or none (reply-only / needs a human /
-- code bug). The rules are the incident classes already met (2026-10-03 .. 10-06); the LLM (PR2) only chooses which
-- hit matches the complaint and writes the words.
declare
  _hits jsonb := '[]'::jsonb;
  _uid text := _s->>'user_id';
  _tg boolean := (_s->>'telegram_id') is not null;
  _group jsonb := _s->'group';
  _gid text := _s->'group'->>'id';
  _course text := _s->'group'->>'course_id';
  _twin jsonb := _s->'twin';
  _posting jsonb := coalesce(_s->'posting', '[]'::jsonb);
  _active_groups int;
  _top jsonb;
  _own_n int := 0;
  _wrong int := 0;
  _x jsonb;
  _locked text;
  _miss text;
  _reasons text;
begin
  if not coalesce((_s->>'found')::boolean, false) then
    return jsonb_build_array(jsonb_build_object('rule', 'R00_not_found', 'class', 'needs_human', 'confidence', 'high',
      'action', null, 'args', '{}'::jsonb, 'message_key', null, 'evidence', 'Profil topilmadi'));
  end if;

  -- R02 identity split: this (bot) account and an empty username-only twin that holds the group
  -- (the user who IS the username-only twin never opens a ticket: tickets come from the bot, i.e. the keeper)
  if jsonb_typeof(_twin) = 'object' and _twin->>'role' = 'keeper' and (_twin->>'twin_group') is not null then
    if coalesce((_twin->>'twin_empty')::boolean, false) and (_gid is null or _gid = _twin->>'twin_group') then
      _hits := _hits || jsonb_build_object('rule', 'R02_identity_split', 'class', 'data', 'confidence', 'high',
        'action', 'heal_split',
        'args', jsonb_build_object('keeper', _uid, 'twin', _twin->>'other_id', 'group', _twin->>'twin_group'),
        'message_key', 'identity_fixed',
        'evidence', 'Bitta oʻquvchining ikkita hisobi: bot hisobi guruhsiz, boʻsh ikkinchi hisob (@' || coalesce(_twin->>'username', '?')
                    || ') guruhda. Ikkinchisi arxivlanadi, guruh bot hisobiga oʻtadi.');
    else
      _hits := _hits || jsonb_build_object('rule', 'R02_identity_split', 'class', 'needs_human', 'confidence', 'high',
        'action', null, 'args', jsonb_build_object('keeper', _uid, 'twin', _twin->>'other_id'), 'message_key', null,
        'evidence', 'Ikkita hisob, lekin ikkinchisida ham faollik bor yoki ikki xil guruh — qoʻlda birlashtirish kerak.');
    end if;
  end if;

  -- R01 no group: a real (bot) account without a group, posting in exactly one group's chat
  if _tg and _gid is null and not (_hits @> '[{"rule": "R02_identity_split"}]') then
    select count(*) into _active_groups from jsonb_array_elements(_posting) p where (p->>'n')::int > 0;
    _top := _posting->0;                                                       -- posting is sorted by n desc
    if _active_groups = 1
       or (_active_groups > 1 and (_top->>'n')::int >= 2 * ((_posting->1)->>'n')::int
           and (_top->>'last')::timestamptz >= ((_posting->1)->>'last')::timestamptz) then
      _hits := _hits || jsonb_build_object('rule', 'R01_no_group', 'class', 'data',
        'confidence', case when _active_groups = 1 then 'high' else 'medium' end,
        'action', 'assign_group', 'args', jsonb_build_object('user', _uid, 'group', _top->>'group_id'),
        'message_key', 'group_fixed',
        'evidence', 'Platformada guruh yoʻq, lekin 14 kunda ' || (_top->>'n') || ' ta xabar «' || (_top->>'group_name')
                    || '» chatida' || case when _active_groups > 1 then ' (boshqa guruhlarda kamroq va eskiroq)' else '' end
                    || '. Shu guruhga biriktirish.');
    elsif _active_groups > 1 then
      _hits := _hits || jsonb_build_object('rule', 'R01_no_group', 'class', 'needs_human', 'confidence', 'medium',
        'action', null, 'args', '{}'::jsonb, 'message_key', null,
        'evidence', 'Platformada guruh yoʻq va ' || _active_groups || ' ta guruh chatida yozadi — qaysi biri ekanini tanlang.');
    else
      _hits := _hits || jsonb_build_object('rule', 'R01_no_group', 'class', 'needs_human', 'confidence', 'medium',
        'action', null, 'args', '{}'::jsonb, 'message_key', null,
        'evidence', 'Platformada guruh yoʻq va hech bir guruh chatida yozmagan.');
    end if;
  end if;

  -- R03 wrong group: profile group A, but writes only in B (same course), or refused as wrong_group. The target is
  -- always a group they POST in: wrong_group refusals with no recent posting give no target, hence no hit.
  if _gid is not null then
    select coalesce(max((p->>'n')::int), 0) into _own_n from jsonb_array_elements(_posting) p where p->>'group_id' = _gid;
    select p into _top from jsonb_array_elements(_posting) p
     where p->>'group_id' <> _gid and p->>'course_id' = _course order by (p->>'n')::int desc limit 1;
    select coalesce(sum((m->>'n')::int), 0) into _wrong from jsonb_array_elements(coalesce(_s->'task_msgs', '[]'::jsonb)) m
     where m->>'outcome' = 'wrong_group';
    _wrong := _wrong + (select coalesce(sum((h->>'n')::int), 0) from jsonb_array_elements(coalesce(_s->'health', '[]'::jsonb)) h
                         where h->>'action' = 'hw_capture_skipped' and h->>'reason' = 'other_group_topic');
    if _top is not null and ((_own_n = 0 and (_top->>'n')::int >= 3) or _wrong >= 2) then
      _hits := _hits || jsonb_build_object('rule', 'R03_wrong_group', 'class', 'data', 'confidence', 'medium',
        'action', 'assign_group', 'args', jsonb_build_object('user', _uid, 'group', _top->>'group_id'),
        'message_key', 'moved_group',
        'evidence', 'Platformada «' || (_group->>'name') || '», lekin yozayotgani «' || (_top->>'group_name') || '» ('
                    || (_top->>'n') || ' xabar; oʻz guruhida ' || _own_n || '; rad etilgan postlar: ' || _wrong
                    || '). Oʻsha guruhga oʻtkazish yoki oʻz guruhiga yozishni aytish.');
      _hits := _hits || jsonb_build_object('rule', 'R03_wrong_group_reply', 'class', 'reply_only', 'confidence', 'low',
        'action', null, 'args', jsonb_build_object('group', _gid), 'message_key', 'post_in_own_group',
        'evidence', 'Muqobil: guruhni oʻzgartirmasdan, oʻz guruhi («' || (_group->>'name') || '») topigiga yozishni aytish.');
    end if;
  end if;

  -- R04 provisional (trial) account: no lessons until the payment is confirmed
  if _s->>'account_type' = 'provisional' then
    _hits := _hits || jsonb_build_object('rule', 'R04_provisional', 'class', 'data', 'confidence', 'low',
      'action', 'set_account_type', 'args', jsonb_build_object('user', _uid, 'type', 'paid'), 'message_key', 'access_opened',
      'evidence', 'Hisob «provisional» — darslar yopiq. Faqat toʻlov tasdiqlangan boʻlsa «paid» ga oʻtkazing.');
  end if;

  -- R05 module beyond the tier limit (reply only: the limit is a business decision)
  select string_agg((m->>'position')::int + 1 || '-modul', ', ' order by (m->>'position')::int) into _locked
    from jsonb_array_elements(coalesce(_s->'modules', '[]'::jsonb)) m where not coalesce((m->>'access')::boolean, true);
  if _locked is not null then
    _hits := _hits || jsonb_build_object('rule', 'R05_tier_limit', 'class', 'reply_only', 'confidence', 'low',
      'action', null, 'args', jsonb_build_object('locked', _locked), 'message_key', 'tier_limit',
      'evidence', 'Yopiq modullar: ' || _locked || ' (tarif chegarasi).');
  end if;

  -- R06 the bot cannot DM them
  if _tg and exists (select 1 from jsonb_array_elements(coalesce(_s->'health', '[]'::jsonb)) h
                      where h->>'action' = 'telegram_send_failed' and (h->>'n')::int > 0) then
    _hits := _hits || jsonb_build_object('rule', 'R06_dm_blocked', 'class', 'reply_only', 'confidence', 'low',
      'action', null, 'args', '{}'::jsonb, 'message_key', 'dm_now_works',
      'evidence', 'Bot unga xabar yubora olmagan (oxirgi 7 kunda).');
  end if;

  -- R07 homework posts skipped by the bot
  select string_agg(distinct coalesce(h->>'reason', h->>'action'), ', ') into _reasons from jsonb_array_elements(coalesce(_s->'health', '[]'::jsonb)) h
   where h->>'action' in ('hw_capture_skipped', 'hw_capture_failed');
  if _reasons is not null then
    _hits := _hits || jsonb_build_object('rule', 'R07_hw_skipped', 'class', 'reply_only', 'confidence', 'medium',
      'action', null, 'args', jsonb_build_object('reasons', _reasons), 'message_key', 'repost_homework',
      'evidence', 'Uyga vazifa postlari qabul qilinmagan: ' || _reasons || '. Sabab tuzatilgach, qayta yuborishi kerak.');
  end if;

  -- R08 an extra task waiting for a missing part
  select string_agg(coalesce(nullif(array_to_string(array(select jsonb_array_elements_text(coalesce(t->'missing', '[]'::jsonb))), '+'), ''), '?')
                    || ' (#' || (t->>'task_id') || ')', ', ') into _miss
    from jsonb_array_elements(coalesce(_s->'task_subs', '[]'::jsonb)) t where t->>'status' = 'needs_more';
  if _miss is not null then
    _hits := _hits || jsonb_build_object('rule', 'R08_task_needs_more', 'class', 'reply_only', 'confidence', 'high',
      'action', null, 'args', jsonb_build_object('missing', _miss), 'message_key', 'task_missing_part',
      'evidence', 'Qoʻshimcha vazifa toʻliq emas, yetishmaydi: ' || _miss || '.');
  end if;

  -- R10 points after a recent move (the retro credit runs on the move; a scoped re-run is harmless and idempotent)
  if (_s->'last_move'->>'at') is not null and (_s->'last_move'->>'at')::timestamptz > (_s->>'at')::timestamptz - interval '7 days' then
    _hits := _hits || jsonb_build_object('rule', 'R10_points_after_move', 'class', 'data', 'confidence', 'low',
      'action', 'reconcile_points', 'args', jsonb_build_object('user', _uid, 'since', (_s->'last_move'->>'at')::timestamptz - interval '14 days'),
      'message_key', 'points_restored',
      'evidence', 'Yaqinda guruhi oʻzgargan (' || (_s->'last_move'->>'at') || '); ballarni qayta hisoblash.');
  end if;

  -- C01 video errors although every module of the course is open → a code-class candidate
  if coalesce((_s->'client_errors_7d'->>'video_error')::int, 0) > 0 and _gid is not null and _locked is null
     and (_s->>'account_type') is distinct from 'provisional' then
    _hits := _hits || jsonb_build_object('rule', 'C01_video_bug', 'class', 'code_bug', 'confidence', 'medium',
      'action', null, 'args', jsonb_build_object('video_errors', (_s->'client_errors_7d'->>'video_error')::int),
      'message_key', 'investigating',
      'evidence', 'Video xatolari (' || (_s->'client_errors_7d'->>'video_error') || ' ta), holbuki barcha modullar ochiq — kod muammosi boʻlishi mumkin.');
  end if;

  -- C02 homework capture failures on a healthy profile → a code-class candidate
  if exists (select 1 from jsonb_array_elements(coalesce(_s->'health', '[]'::jsonb)) h
              where h->>'action' = 'hw_capture_failed' and (h->>'n')::int > 0)
     and _gid is not null and _tg then
    _hits := _hits || jsonb_build_object('rule', 'C02_hw_capture_failed', 'class', 'code_bug', 'confidence', 'medium',
      'action', null, 'args', '{}'::jsonb, 'message_key', 'investigating',
      'evidence', 'Uyga vazifani saqlashda texnik xato (hw_capture_failed), profil esa toʻgʻri — kod muammosi boʻlishi mumkin.');
  end if;

  return _hits;
end
$fn$;

revoke execute on function public.support_evaluate_rules(jsonb) from public, anon, authenticated;
grant execute on function public.support_evaluate_rules(jsonb) to service_role;

-- Self-test: the rules on fixture snapshots (a pure function — nothing is read or written).
do $$
declare
  _base jsonb := jsonb_build_object('v', 1, 'found', true, 'user_id', '00000000-0000-0000-0000-00000000000a',
    'telegram_id', 111, 'account_type', 'paid', 'group', null, 'posting', '[]'::jsonb, 'health', '[]'::jsonb,
    'task_msgs', '[]'::jsonb, 'task_subs', '[]'::jsonb, 'modules', '[]'::jsonb, 'client_errors_7d', '{}'::jsonb,
    'at', '2026-10-06T00:00:00Z');
  _g3 jsonb := jsonb_build_object('group_id', '00000000-0000-0000-0000-000000000003', 'group_name', '3-GURUH',
                                  'course_id', '00000000-0000-0000-0000-0000000000c1', 'n', 6, 'last', '2026-10-05T00:00:00Z');
  _r jsonb;
begin
  -- R01: no group, posts in one chat → assign that group
  _r := public.support_evaluate_rules(_base || jsonb_build_object('posting', jsonb_build_array(_g3)));
  if not (_r @> '[{"rule": "R01_no_group", "action": "assign_group", "class": "data"}]')
     or _r->0->'args'->>'group' <> '00000000-0000-0000-0000-000000000003' then
    raise exception 'ABORT: R01 self-test failed: %', _r;
  end if;
  -- R01 dominant: 135 recent posts in 3-GURUH, 46 older ones in 4-GURUH → assign 3-GURUH (medium)
  _r := public.support_evaluate_rules(_base || jsonb_build_object('posting', jsonb_build_array(
          _g3 || jsonb_build_object('n', 135, 'last', '2026-10-06T00:00:00Z'),
          jsonb_build_object('group_id', '00000000-0000-0000-0000-000000000004', 'group_name', '4-GURUH',
                             'course_id', '00000000-0000-0000-0000-0000000000c1', 'n', 46, 'last', '2026-10-03T00:00:00Z'))));
  if not (_r @> '[{"rule": "R01_no_group", "action": "assign_group", "confidence": "medium"}]')
     or _r->0->'args'->>'group' <> '00000000-0000-0000-0000-000000000003' then
    raise exception 'ABORT: R01 dominant self-test failed: %', _r;
  end if;
  -- R02: an empty twin holds the group → heal_split (and R01 does not fire twice)
  _r := public.support_evaluate_rules(_base || jsonb_build_object('posting', jsonb_build_array(_g3), 'twin', jsonb_build_object(
          'role', 'keeper', 'other_id', '00000000-0000-0000-0000-00000000000b', 'username', 'x',
          'keeper_group', null, 'twin_group', '00000000-0000-0000-0000-000000000003', 'twin_empty', true)));
  if not (_r @> '[{"rule": "R02_identity_split", "action": "heal_split"}]') or _r @> '[{"rule": "R01_no_group"}]' then
    raise exception 'ABORT: R02 self-test failed: %', _r;
  end if;
  -- R03: profile in group 1, writes only in group 3 of the same course → assign 3 (+ the reply-only alternative)
  _r := public.support_evaluate_rules(_base || jsonb_build_object(
          'group', jsonb_build_object('id', '00000000-0000-0000-0000-000000000001', 'name', '1-GURUH',
                                      'course_id', '00000000-0000-0000-0000-0000000000c1'),
          'posting', jsonb_build_array(_g3)));
  if not (_r @> '[{"rule": "R03_wrong_group", "action": "assign_group"}]') or not (_r @> '[{"rule": "R03_wrong_group_reply"}]') then
    raise exception 'ABORT: R03 self-test failed: %', _r;
  end if;
  -- R08: an extra task missing its text
  _r := public.support_evaluate_rules(_base || jsonb_build_object('group', jsonb_build_object('id', 'g', 'name', 'n', 'course_id', 'c'),
          'task_subs', jsonb_build_array(jsonb_build_object('task_id', 2, 'status', 'needs_more', 'missing', jsonb_build_array('text')))));
  if not (_r @> '[{"rule": "R08_task_needs_more", "class": "reply_only"}]') then
    raise exception 'ABORT: R08 self-test failed: %', _r;
  end if;
  -- a healthy, quiet student → no hit at all (the LLM / a human takes it)
  _r := public.support_evaluate_rules(_base || jsonb_build_object('group', jsonb_build_object('id', 'g', 'name', 'n', 'course_id', 'c')));
  if jsonb_array_length(_r) <> 0 then
    raise exception 'ABORT: a healthy snapshot produced hits: %', _r;
  end if;
end $$;

-- Smoke test of the snapshot (STABLE, read-only): plpgsql binds columns lazily, so a wrong column name would only
-- fail at the worker's first call. Run it on a real student and on a missing id, and feed the result to the rules.
do $$
declare
  _u uuid := (select p.id from public.profiles p join public.groups g on g.id = p.group_id
               where p.telegram_id is not null order by p.created_at desc limit 1);
  _snap jsonb;
begin
  if _u is not null then
    _snap := public.support_user_snapshot(_u);
    if not coalesce((_snap->>'found')::boolean, false) or jsonb_typeof(_snap->'posting') <> 'array' then
      raise exception 'ABORT: support_user_snapshot smoke test failed: %', left(_snap::text, 300);
    end if;
    perform public.support_evaluate_rules(_snap);
  end if;
  if (public.support_user_snapshot('00000000-0000-0000-0000-000000000000')->>'found')::boolean then
    raise exception 'ABORT: a missing user was found';
  end if;
end $$;

-- ───────────────────────────── the queue ─────────────────────────────
create or replace function public.support_diagnosis_enqueue()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  if coalesce((select (value->>'enabled')::boolean from public.platform_settings where key = 'support_agent'), false) then
    insert into public.support_diagnoses (ticket_id, run_no) values (new.id, 1) on conflict (ticket_id, run_no) do nothing;
  end if;
  return null;
exception when others then
  -- never fail the ticket itself; the reconciler re-enqueues and this row is the signal
  begin
    insert into public.admin_actions (actor_user_id, action, details)
    values (null, 'support_diagnosis_enqueue_failed', jsonb_build_object('ticket_id', new.id, 'error', left(sqlerrm, 300)));
  exception when others then null;
  end;
  return null;
end
$fn$;

revoke execute on function public.support_diagnosis_enqueue() from public, anon, authenticated;

drop trigger if exists trg_support_tickets_diagnose on public.support_tickets;
create trigger trg_support_tickets_diagnose
  after insert on public.support_tickets
  for each row execute function public.support_diagnosis_enqueue();

create or replace function public.support_diagnosis_reconcile()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
-- Open tickets of the last 3 days without any diagnosis get one (a trigger that failed, or tickets opened while the
-- agent was off and then switched on). Nothing while the agent is disabled.
declare
  _n int := 0;
begin
  if not coalesce((select (value->>'enabled')::boolean from public.platform_settings where key = 'support_agent'), false) then
    return 0;
  end if;
  insert into public.support_diagnoses (ticket_id, run_no)
  select t.id, 1 from public.support_tickets t
   where t.status = 'open' and t.created_at > now() - interval '3 days'
     and not exists (select 1 from public.support_diagnoses d where d.ticket_id = t.id)
  on conflict (ticket_id, run_no) do nothing;
  get diagnostics _n = row_count;
  return _n;
end
$fn$;

revoke execute on function public.support_diagnosis_reconcile() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'support-diagnosis-reconcile') then
    perform cron.unschedule('support-diagnosis-reconcile');
  end if;
  perform cron.schedule('support-diagnosis-reconcile', '*/10 * * * *', 'select public.support_diagnosis_reconcile()');
end $$;
