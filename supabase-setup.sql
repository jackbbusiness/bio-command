-- ============================================================
-- Bio-Command database setup
-- Run this entire script once in the Supabase SQL editor
-- after creating your project. Takes about 5 seconds.
-- ============================================================

-- Main data table: one row per user, full app DB in JSONB.
-- Using JSONB keeps the schema stable across all app updates;
-- no migrations are ever needed. The whole local DB syncs here.
CREATE TABLE IF NOT EXISTS operator_data (
  user_id   UUID PRIMARY KEY REFERENCES auth.users ON DELETE CASCADE,
  data      JSONB NOT NULL DEFAULT '{}',
  synced_at TIMESTAMPTZ DEFAULT NOW()
);

-- Push subscriptions: one row per device per user.
-- Stored so the Supabase Edge Function cron can push to all
-- devices belonging to the operator.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id         UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id    UUID REFERENCES auth.users ON DELETE CASCADE,
  endpoint   TEXT NOT NULL,
  p256dh     TEXT NOT NULL,
  auth_key   TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, endpoint)
);

-- Row Level Security: users can only see and write their own rows.
ALTER TABLE operator_data ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "operator_data_owner" ON operator_data
  FOR ALL USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "push_subs_owner" ON push_subscriptions
  FOR ALL USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Auto-update the synced_at timestamp on every write.
CREATE OR REPLACE FUNCTION update_synced_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.synced_at = NOW();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER operator_data_synced_at
  BEFORE UPDATE ON operator_data
  FOR EACH ROW EXECUTE FUNCTION update_synced_at();

-- Verify setup (should return "Setup complete")
SELECT 'Setup complete' AS status,
  (SELECT COUNT(*) FROM information_schema.tables
   WHERE table_schema = 'public'
   AND table_name IN ('operator_data', 'push_subscriptions')) AS tables_created;
