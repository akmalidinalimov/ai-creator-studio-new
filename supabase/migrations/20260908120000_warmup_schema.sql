-- ============================================================================
-- warmup schema — Slice 0 foundation. SPEC.md §3, with ten deltas marked DELTA-n inline.
-- ============================================================================
--
-- TOUCHES NOTHING IN public. No table in public is created, altered, or written. The only
-- statement outside the `warmup` schema is CREATE EXTENSION IF NOT EXISTS vector, which is
-- already installed on this project (migration 20260426191329) and is therefore a no-op here.
--
-- ACCESS MODEL. PostgREST reaches this schema only once `warmup` is added to the project's
-- Exposed schemas (Dashboard → API Settings). USAGE is granted to service_role ALONE, so anon
-- and authenticated are refused at the schema level, before RLS is even consulted. RLS is then
-- enabled on every table with ZERO policies as a second, independent layer: service_role holds
-- BYPASSRLS, everyone else sees nothing. Two layers, either one sufficient.
--
-- The LMS bot is untouched by this migration. It shares only the database.

CREATE SCHEMA IF NOT EXISTS warmup;

-- warmup.faq.embedding needs pgvector. Already project-wide; guarded so a fresh environment
-- (a branch database, a local stack) applies this file cleanly.
CREATE EXTENSION IF NOT EXISTS vector;

REVOKE ALL ON SCHEMA warmup FROM PUBLIC;
GRANT USAGE ON SCHEMA warmup TO service_role;

-- ----------------------------------------------------------------------------
-- participants
-- ----------------------------------------------------------------------------
CREATE TABLE warmup.participants (
  id                BIGSERIAL PRIMARY KEY,
  telegram_id       BIGINT UNIQUE NOT NULL,
  username          TEXT,
  first_name        TEXT,
  started_bot       BOOLEAN NOT NULL DEFAULT FALSE,
  started_bot_at    TIMESTAMPTZ,
  joined_channel_at TIMESTAMPTZ,
  left_at           TIMESTAMPTZ,
  segment           TEXT NOT NULL DEFAULT 'S0',
  streak            INT NOT NULL DEFAULT 0,
  streak_freezes    INT NOT NULL DEFAULT 0,
  last_active_at    TIMESTAMPTZ,
  survey            JSONB NOT NULL DEFAULT '{}'::jsonb,
  attendance        JSONB NOT NULL DEFAULT '{}'::jsonb,
  committed_events  TEXT[] NOT NULL DEFAULT '{}',
  referred_by       BIGINT,
  opted_out         BOOLEAN NOT NULL DEFAULT FALSE,
  paused_until      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- DELTA-10: SPEC writes `CREATE INDEX ON warmup.participants (segment)`, which auto-names and so
-- cannot carry IF NOT EXISTS. Every index below is named explicitly, matching house style in
-- supabase/migrations/.
CREATE INDEX IF NOT EXISTS participants_segment_idx
  ON warmup.participants (segment);
CREATE INDEX IF NOT EXISTS participants_started_bot_idx
  ON warmup.participants (started_bot) WHERE started_bot;

-- ----------------------------------------------------------------------------
-- ledger — APPEND ONLY, enforced in the database (DELTA-6)
-- ----------------------------------------------------------------------------
CREATE TABLE warmup.ledger (
  id           BIGSERIAL PRIMARY KEY,
  telegram_id  BIGINT NOT NULL,
  action       TEXT NOT NULL,
  points       INT NOT NULL,
  reason       TEXT,
  plugin       TEXT NOT NULL,
  campaign_day INT,
  source_ref   TEXT,
  dedupe_key   TEXT NOT NULL UNIQUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ledger_telegram_created_idx
  ON warmup.ledger (telegram_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ledger_action_created_idx
  ON warmup.ledger (action, created_at);

-- DELTA-6: the root CLAUDE.md prevention hierarchy, layer 2 — "a property that must never be
-- bypassed by ANY code path belongs in a CHECK / trigger / RLS, not in hoped-for app code".
-- Append-only stops being a convention the applier is trusted to honour. Points are derived
-- (total = SUM(ledger)), so a mutated row silently rewrites history; corrections are
-- compensating rows. The TRUNCATE trigger is separate because a row-level trigger does not
-- see TRUNCATE — without it the invariant has a hole wide enough to empty the table.
CREATE OR REPLACE FUNCTION warmup.ledger_is_append_only()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION
    'warmup.ledger is append-only: % denied. Corrections are compensating rows.', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$fn$;

CREATE TRIGGER ledger_append_only
  BEFORE UPDATE OR DELETE ON warmup.ledger
  FOR EACH ROW EXECUTE FUNCTION warmup.ledger_is_append_only();

CREATE TRIGGER ledger_no_truncate
  BEFORE TRUNCATE ON warmup.ledger
  FOR EACH STATEMENT EXECUTE FUNCTION warmup.ledger_is_append_only();

-- ----------------------------------------------------------------------------
-- events — the ingestion log
-- ----------------------------------------------------------------------------
CREATE TABLE warmup.events (
  id           BIGSERIAL PRIMARY KEY,
  event_type   TEXT NOT NULL,
  telegram_id  BIGINT,
  chat_id      BIGINT,
  message_id   BIGINT,
  payload      JSONB NOT NULL,
  processed_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- DELTA-1: Telegram redelivers an update whenever the webhook is slow to answer, so the same
  -- payload legitimately arrives twice. The unique key is (update_id, event_type), not update_id
  -- alone, because SPEC §6.1 normalises one update into two events (media + task hashtag →
  -- media.submitted AND task.completed). NULL for engine-emitted events (day.started, scores.frozen,
  -- …), which have no Telegram update behind them — hence the partial index.
  update_id    BIGINT,

  -- DELTA-2: concurrency + poison-event control for warmup-dispatch. Two overlapping ticks would
  -- otherwise claim the same unprocessed row and run its plugins twice; `award` survives that on
  -- ledger.dedupe_key, but a `send` effect carrying no dedupeKey does not — it would double-send.
  -- Same lease shape as broadcast_deliveries.last_attempt_at, which broadcast-drainer relies on.
  -- `attempts` stops an event that always throws from being retried forever.
  claimed_at   TIMESTAMPTZ,
  attempts     INT NOT NULL DEFAULT 0,
  last_error   TEXT
);
CREATE INDEX IF NOT EXISTS events_unprocessed_idx
  ON warmup.events (processed_at) WHERE processed_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS events_update_id_type_uidx
  ON warmup.events (update_id, event_type) WHERE update_id IS NOT NULL;

-- ----------------------------------------------------------------------------
-- outbox — every send leaves through here
-- ----------------------------------------------------------------------------
CREATE TABLE warmup.outbox (
  id            BIGSERIAL PRIMARY KEY,
  telegram_id   BIGINT,
  chat_id       BIGINT,
  surface       TEXT NOT NULL,   -- dm | channel | group
  kind          TEXT NOT NULL,   -- push | reply | render
  payload       JSONB NOT NULL,
  scheduled_for TIMESTAMPTZ NOT NULL,
  sent_at       TIMESTAMPTZ,
  status        TEXT NOT NULL DEFAULT 'queued',
  drop_reason   TEXT,
  attempts      INT NOT NULL DEFAULT 0,
  dedupe_key    TEXT UNIQUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- DELTA-3: the claim lease warmup-drainer holds while a batch is in flight, so two overlapping
  -- cron ticks cannot send the same row twice. Exactly what broadcast-drainer claims on today.
  last_attempt_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS outbox_status_scheduled_idx
  ON warmup.outbox (status, scheduled_for);

-- ----------------------------------------------------------------------------
-- content — draft → approve → post (Agent G)
-- ----------------------------------------------------------------------------
CREATE TABLE warmup.content (
  id           BIGSERIAL PRIMARY KEY,
  campaign_day INT,
  slot         TEXT NOT NULL,
  belief       TEXT,
  copy_key     TEXT NOT NULL,
  draft_text   TEXT,
  final_text   TEXT,
  media_ref    TEXT,
  status       TEXT NOT NULL DEFAULT 'draft',
  approved_by  BIGINT,
  post_at      TIMESTAMPTZ,
  posted_at    TIMESTAMPTZ,
  message_id   BIGINT
);

-- ----------------------------------------------------------------------------
-- snapshots — frozen scores; what every rendered card must agree with
-- ----------------------------------------------------------------------------
CREATE TABLE warmup.snapshots (
  id           BIGSERIAL PRIMARY KEY,
  campaign_day INT NOT NULL UNIQUE,
  frozen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  rows         JSONB NOT NULL
);

-- ----------------------------------------------------------------------------
-- faq
-- ----------------------------------------------------------------------------
CREATE TABLE warmup.faq (
  id         BIGSERIAL PRIMARY KEY,
  pattern    TEXT NOT NULL,
  embedding  VECTOR(1536),
  answer_key TEXT NOT NULL,
  hits       INT NOT NULL DEFAULT 0,
  active     BOOLEAN NOT NULL DEFAULT TRUE
);

-- ----------------------------------------------------------------------------
-- cm_log — community-manager routing decisions
-- ----------------------------------------------------------------------------
CREATE TABLE warmup.cm_log (
  id            BIGSERIAL PRIMARY KEY,
  telegram_id   BIGINT,
  inbound_text  TEXT,
  route         TEXT NOT NULL,
  outbound_text TEXT,
  model         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- escalations — questions that must reach a human
-- ----------------------------------------------------------------------------
CREATE TABLE warmup.escalations (
  id          BIGSERIAL PRIMARY KEY,
  telegram_id BIGINT NOT NULL,
  question    TEXT NOT NULL,
  category    TEXT NOT NULL,
  heat_flag   BOOLEAN NOT NULL DEFAULT FALSE,
  resolved_at TIMESTAMPTZ,
  resolved_by BIGINT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- campaign_pack — all campaign content lives here, versioned
-- ----------------------------------------------------------------------------
CREATE TABLE warmup.campaign_pack (
  id           BIGSERIAL PRIMARY KEY,
  version      TEXT UNIQUE NOT NULL,
  pack         JSONB NOT NULL,
  status       TEXT NOT NULL DEFAULT 'draft',  -- draft|validated|active|retired
  validated_at TIMESTAMPTZ,
  activated_at TIMESTAMPTZ,
  activated_by BIGINT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Name kept exactly as SPEC §3 writes it: other agents may target it in ON CONFLICT.
CREATE UNIQUE INDEX one_active_pack
  ON warmup.campaign_pack (status) WHERE status = 'active';

-- ----------------------------------------------------------------------------
-- plugin_state — plugin-owned scratch space, written only via the setState effect
-- ----------------------------------------------------------------------------
-- DELTA-4: SPEC §3 declares PRIMARY KEY (plugin, telegram_id, key). That statement applies
-- cleanly — and that is the trap. A primary key implies NOT NULL on every column, so PostgreSQL
-- silently coerces telegram_id to NOT NULL; nothing complains until the first plugin tries to
-- store plugin-global (non-per-participant) state with telegram_id NULL, months later, and gets
-- a not-null violation at runtime. Verified against PostgreSQL 18.3: CREATE TABLE succeeds,
-- is_nullable flips to NO, and the global INSERT is rejected.
--
-- scope_id preserves NULL-means-global while giving the key a NOT NULL column, and being STORED
-- it remains a valid ON CONFLICT target for upserts.
CREATE TABLE warmup.plugin_state (
  plugin      TEXT NOT NULL,
  telegram_id BIGINT,
  key         TEXT NOT NULL,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  scope_id    BIGINT GENERATED ALWAYS AS (COALESCE(telegram_id, -1)) STORED,
  PRIMARY KEY (plugin, scope_id, key)
);

-- ----------------------------------------------------------------------------
-- plugin_registry — engine-owned health and feature flags (DELTA-5, new table)
-- ----------------------------------------------------------------------------
-- Not in SPEC §3, but Slice 0 requires auto-disabling a plugin after N consecutive errors, and
-- edge functions keep no memory between invocations — the counter has to be in the database.
--
-- It deliberately does NOT live in warmup.plugin_state: plugins write that table through the
-- setState effect, so a failing plugin could clear its own error count and switch itself back
-- on. The applier must never write this table from a plugin effect.
CREATE TABLE warmup.plugin_registry (
  plugin             TEXT PRIMARY KEY,
  enabled            BOOLEAN NOT NULL DEFAULT TRUE,
  consecutive_errors INT NOT NULL DEFAULT 0,
  last_error         TEXT,
  last_error_at      TIMESTAMPTZ,
  disabled_at        TIMESTAMPTZ,
  disabled_reason    TEXT,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- Views — points are DERIVED, never a mutable counter
-- ----------------------------------------------------------------------------
-- DELTA-8: security_invoker. A PostgreSQL 15+ view without it executes as its owner, which would
-- read straight through the RLS on warmup.ledger and hand any caller who can reach the schema a
-- full leaderboard.
CREATE VIEW warmup.totals WITH (security_invoker = true) AS
  SELECT telegram_id, SUM(points)::INT AS total_points, MAX(created_at) AS last_award
  FROM warmup.ledger GROUP BY telegram_id;

-- DELTA-7: SPEC ranks on total_points alone, which leaves tied participants in whatever order
-- the planner returns — TASKS Slice 3 requires deterministic ties. Ordering by last_award then
-- telegram_id makes the ranking reproducible and gives the tie to whoever got there first.
-- This is an engine rule, not campaign content: no pack value can change it.
CREATE VIEW warmup.ranks WITH (security_invoker = true) AS
  SELECT telegram_id, total_points, last_award,
         RANK() OVER (ORDER BY total_points DESC, last_award ASC, telegram_id ASC) AS rank
  FROM warmup.totals;

-- ----------------------------------------------------------------------------
-- DELTA-9: RLS on every table, with zero policies
-- ----------------------------------------------------------------------------
-- The second of the two independent layers described at the top of this file. No policy is
-- defined anywhere, so RLS denies by default: only BYPASSRLS roles (service_role, postgres) read
-- or write. If `warmup` is ever exposed more broadly than intended, the tables stay closed.
ALTER TABLE warmup.participants    ENABLE ROW LEVEL SECURITY;
ALTER TABLE warmup.ledger          ENABLE ROW LEVEL SECURITY;
ALTER TABLE warmup.events          ENABLE ROW LEVEL SECURITY;
ALTER TABLE warmup.outbox          ENABLE ROW LEVEL SECURITY;
ALTER TABLE warmup.content         ENABLE ROW LEVEL SECURITY;
ALTER TABLE warmup.snapshots       ENABLE ROW LEVEL SECURITY;
ALTER TABLE warmup.faq             ENABLE ROW LEVEL SECURITY;
ALTER TABLE warmup.cm_log          ENABLE ROW LEVEL SECURITY;
ALTER TABLE warmup.escalations     ENABLE ROW LEVEL SECURITY;
ALTER TABLE warmup.campaign_pack   ENABLE ROW LEVEL SECURITY;
ALTER TABLE warmup.plugin_state    ENABLE ROW LEVEL SECURITY;
ALTER TABLE warmup.plugin_registry ENABLE ROW LEVEL SECURITY;

-- ----------------------------------------------------------------------------
-- Grants — service_role only. anon and authenticated are never named.
-- ----------------------------------------------------------------------------
GRANT ALL ON ALL TABLES    IN SCHEMA warmup TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA warmup TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA warmup GRANT ALL ON TABLES    TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA warmup GRANT ALL ON SEQUENCES TO service_role;
