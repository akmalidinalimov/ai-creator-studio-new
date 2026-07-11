-- In-group homework picker ("Ask, then guess") — 2026-07-11.
-- New capture mode 'picker': a media post in the homework topic is HELD here while the bot asks
-- the student, in-thread with inline buttons, which module→task it belongs to. On pick (or on the
-- ~10-min expiry fallback, which reuses the smart auto-tag guess) the pending post becomes a real
-- homework_submissions row through the normal machinery. Work is never lost: no pick ⇒ auto-tag.
-- Flag-gated via platform_settings homework_capture {"mode":"picker","course_ids":[...]};
-- flipping back to {"mode":"auto"} instantly restores today's behavior.

create table if not exists public.hw_pending_posts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  from_tg_id bigint not null,                -- poster's Telegram id (owner-locks the buttons)
  group_id uuid not null references public.groups(id) on delete cascade,
  course_id uuid not null,
  telegram_chat_id bigint not null,
  telegram_thread_id bigint not null,
  first_message_id bigint not null,          -- the student's post (gets the ✅ reaction on finalize)
  media jsonb not null default '[]'::jsonb,  -- same item shape as homework_submissions.media
  submitted_text text,
  picker_message_id bigint,                  -- the bot's in-thread picker reply (deleted on finalize)
  state text not null default 'pending' check (state in ('pending','done','expired')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

-- One live picker per student per topic; album photos append to it.
create unique index if not exists uq_hw_pending_live
  on public.hw_pending_posts (user_id, telegram_chat_id, telegram_thread_id)
  where state = 'pending';
create index if not exists idx_hw_pending_expiry
  on public.hw_pending_posts (state, expires_at);

-- Service-role only (the bot); no client access.
alter table public.hw_pending_posts enable row level security;
