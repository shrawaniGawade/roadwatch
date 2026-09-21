CREATE TABLE IF NOT EXISTS notifications (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  source_event_id uuid UNIQUE REFERENCES outbox(id),
  event_key text UNIQUE NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz,
  acknowledged_by uuid REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS notifications_tenant_created ON notifications(tenant_id,created_at DESC);
CREATE TABLE IF NOT EXISTS automation_status (
  worker text PRIMARY KEY,
  last_success_at timestamptz NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'
);
