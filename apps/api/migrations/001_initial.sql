CREATE TABLE tenants (
  id uuid PRIMARY KEY, name text NOT NULL, is_demo boolean NOT NULL DEFAULT false,
  settings jsonb NOT NULL DEFAULT '{}', version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE users (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id),
  email text NOT NULL UNIQUE, name text NOT NULL, password_hash text NOT NULL,
  role text NOT NULL CHECK(role IN ('admin','planner','reviewer','crew','viewer')),
  active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sessions (
  token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE TABLE login_limits (
  key text PRIMARY KEY, attempts integer NOT NULL DEFAULT 0,
  started_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE roads (
  id uuid NOT NULL, tenant_id uuid NOT NULL REFERENCES tenants(id), data jsonb NOT NULL,
  PRIMARY KEY(tenant_id,id)
);
CREATE TABLE segments (
  id uuid NOT NULL, tenant_id uuid NOT NULL, road_id uuid NOT NULL, data jsonb NOT NULL,
  PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,road_id) REFERENCES roads(tenant_id,id)
);
CREATE INDEX segments_road ON segments(tenant_id,road_id);
CREATE TABLE devices (
  id uuid NOT NULL, tenant_id uuid NOT NULL REFERENCES tenants(id), token_hash text UNIQUE,
  data jsonb NOT NULL, PRIMARY KEY(tenant_id,id)
);
CREATE TABLE calibrations (
  id uuid NOT NULL, tenant_id uuid NOT NULL, device_id uuid NOT NULL, data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id),
  FOREIGN KEY(tenant_id,device_id) REFERENCES devices(tenant_id,id)
);
CREATE TABLE surveys (
  id uuid NOT NULL, tenant_id uuid NOT NULL, device_id uuid NOT NULL, data jsonb NOT NULL,
  PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,device_id) REFERENCES devices(tenant_id,id)
);
CREATE TABLE defects (
  id uuid NOT NULL, tenant_id uuid NOT NULL, road_id uuid NOT NULL, segment_id uuid,
  version integer NOT NULL DEFAULT 1 CHECK(version > 0), data jsonb NOT NULL,
  PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,road_id) REFERENCES roads(tenant_id,id),
  FOREIGN KEY(tenant_id,segment_id) REFERENCES segments(tenant_id,id)
);
CREATE INDEX defects_status ON defects(tenant_id, (data->>'status'));
CREATE INDEX defects_road ON defects(tenant_id,road_id);
CREATE TABLE work_orders (
  id uuid NOT NULL, tenant_id uuid NOT NULL REFERENCES tenants(id), version integer NOT NULL DEFAULT 1,
  data jsonb NOT NULL, PRIMARY KEY(tenant_id,id)
);
CREATE TABLE work_order_defects (
  tenant_id uuid NOT NULL, work_order_id uuid NOT NULL, defect_id uuid NOT NULL,
  PRIMARY KEY(tenant_id,work_order_id,defect_id),
  FOREIGN KEY(tenant_id,work_order_id) REFERENCES work_orders(tenant_id,id),
  FOREIGN KEY(tenant_id,defect_id) REFERENCES defects(tenant_id,id)
);
CREATE TABLE media (
  id uuid NOT NULL, tenant_id uuid NOT NULL, survey_id uuid NOT NULL,
  filename text NOT NULL, mime_type text NOT NULL, storage_key text NOT NULL,
  sha256 text NOT NULL CHECK(length(sha256)=64), size_bytes bigint NOT NULL CHECK(size_bytes>0),
  metadata jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,survey_id) REFERENCES surveys(tenant_id,id)
);
CREATE TABLE evidence (
  id uuid NOT NULL, tenant_id uuid NOT NULL, media_id uuid NOT NULL, defect_id uuid NOT NULL,
  data jsonb NOT NULL, PRIMARY KEY(tenant_id,id),
  FOREIGN KEY(tenant_id,media_id) REFERENCES media(tenant_id,id),
  FOREIGN KEY(tenant_id,defect_id) REFERENCES defects(tenant_id,id)
);
CREATE TABLE jobs (
  id uuid NOT NULL, tenant_id uuid NOT NULL, survey_id uuid NOT NULL, media_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','processing','completed','failed')),
  attempts integer NOT NULL DEFAULT 0, retry_limit integer NOT NULL DEFAULT 3, error text, pipeline_version text NOT NULL DEFAULT 'roadwatch-v1',
  available_at timestamptz NOT NULL DEFAULT now(), lease_until timestamptz, lease_token uuid,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  result jsonb, PRIMARY KEY(tenant_id,id),
  UNIQUE(tenant_id,media_id,pipeline_version),
  FOREIGN KEY(tenant_id,survey_id) REFERENCES surveys(tenant_id,id),
  FOREIGN KEY(tenant_id,media_id) REFERENCES media(tenant_id,id)
);
CREATE INDEX jobs_available ON jobs(status,available_at,lease_until);
CREATE TABLE upload_requests (
  tenant_id uuid NOT NULL, idempotency_key text NOT NULL, sha256 text NOT NULL, request_hash text NOT NULL,
  survey_id uuid NOT NULL, media_id uuid NOT NULL, job_id uuid NOT NULL,
  PRIMARY KEY(tenant_id,idempotency_key),
  FOREIGN KEY(tenant_id,media_id) REFERENCES media(tenant_id,id),
  FOREIGN KEY(tenant_id,job_id) REFERENCES jobs(tenant_id,id)
);
CREATE TABLE audit (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), actor text NOT NULL,
  action text NOT NULL, entity_type text NOT NULL, entity_id text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_tenant_created ON audit(tenant_id,created_at DESC);
CREATE TABLE outbox (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), event_type text NOT NULL,
  aggregate_id text NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz, attempts integer NOT NULL DEFAULT 0, last_error text
);
CREATE INDEX outbox_pending ON outbox(created_at) WHERE published_at IS NULL;
