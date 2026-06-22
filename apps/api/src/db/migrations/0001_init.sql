-- Portless initial schema (M1 auth/audit + M2 domain models).
-- ponytail: hand-authored to match src/db/schema.ts; regenerate with
-- `drizzle-kit generate` once drizzle-orm/drizzle-kit versions are aligned.

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_roles (
  user_id uuid NOT NULL REFERENCES users(id),
  role text NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  at timestamptz NOT NULL DEFAULT now(),
  actor text NOT NULL,
  action text NOT NULL,
  target text,
  outcome text NOT NULL,
  dry_run boolean,
  meta jsonb
);

CREATE TABLE IF NOT EXISTS projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS environments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  name text NOT NULL
);

CREATE TABLE IF NOT EXISTS services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  environment_id uuid NOT NULL REFERENCES environments(id),
  name text NOT NULL,
  type text NOT NULL,
  image text NOT NULL,
  replicas integer NOT NULL DEFAULT 1,
  port integer,
  cpu integer NOT NULL,
  memory_mb integer NOT NULL,
  health_path text,
  spec jsonb
);

CREATE TABLE IF NOT EXISTS domains (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  environment_id uuid NOT NULL REFERENCES environments(id),
  hostname text NOT NULL UNIQUE,
  service text NOT NULL,
  ingress text NOT NULL DEFAULT 'cloudflare-tunnel'
);

CREATE TABLE IF NOT EXISTS secrets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  environment_id uuid NOT NULL REFERENCES environments(id),
  name text NOT NULL,
  ciphertext text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS machines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  roles jsonb NOT NULL,
  region text NOT NULL,
  wg_ip text NOT NULL UNIQUE,
  container_subnet text NOT NULL UNIQUE,
  online boolean NOT NULL DEFAULT false,
  public_key text,
  last_heartbeat timestamptz
);

CREATE TABLE IF NOT EXISTS network_paths (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_machine text NOT NULL,
  to_machine text NOT NULL,
  kind text NOT NULL,
  rtt_ms integer NOT NULL,
  throughput_mbps integer NOT NULL,
  endpoint text,
  relay_id text,
  measured_at timestamptz NOT NULL DEFAULT now()
);
