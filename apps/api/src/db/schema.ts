// Drizzle schema (Postgres dialect). Auth/audit core (M1) + domain models (M2).
// ponytail: tables are the source of truth; SQL is generated to db/migrations/0001_init.sql
// (drizzle-kit). The API still runs on in-memory stores until Postgres is wired (M2 import
// path is record-level + tested; live persistence is M10).
import { pgTable, uuid, text, timestamp, boolean, integer, jsonb } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const userRoles = pgTable('user_roles', {
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  role: text('role').notNull(),
});

export const auditLog = pgTable('audit_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  at: timestamp('at', { withTimezone: true }).defaultNow().notNull(),
  actor: text('actor').notNull(),
  action: text('action').notNull(),
  target: text('target'),
  outcome: text('outcome').notNull(),
  dryRun: boolean('dry_run'),
  meta: jsonb('meta'),
});

// --- M2 domain models ---

export const projects = pgTable('projects', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const environments = pgTable('environments', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id),
  name: text('name').notNull(), // e.g. prod, staging
});

export const services = pgTable('services', {
  id: uuid('id').primaryKey().defaultRandom(),
  environmentId: uuid('environment_id').notNull().references(() => environments.id),
  name: text('name').notNull(),
  type: text('type').notNull(), // web | worker | cron | database
  image: text('image').notNull(),
  replicas: integer('replicas').notNull().default(1),
  port: integer('port'),
  cpu: integer('cpu').notNull(),
  memoryMb: integer('memory_mb').notNull(),
  healthPath: text('health_path'),
  spec: jsonb('spec'), // full normalized ServiceSpec
});

export const domains = pgTable('domains', {
  id: uuid('id').primaryKey().defaultRandom(),
  environmentId: uuid('environment_id').notNull().references(() => environments.id),
  hostname: text('hostname').notNull().unique(),
  service: text('service').notNull(),
  ingress: text('ingress').notNull().default('cloudflare-tunnel'),
});

export const secrets = pgTable('secrets', {
  id: uuid('id').primaryKey().defaultRandom(),
  environmentId: uuid('environment_id').notNull().references(() => environments.id),
  name: text('name').notNull(),
  // ponytail: ciphertext only — never store plaintext; encryption/rotation is M10.
  ciphertext: text('ciphertext').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const machines = pgTable('machines', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  roles: jsonb('roles').notNull(), // MachineRole[]
  region: text('region').notNull(),
  wgIp: text('wg_ip').notNull().unique(),
  containerSubnet: text('container_subnet').notNull().unique(),
  online: boolean('online').notNull().default(false),
  publicKey: text('public_key'),
  lastHeartbeat: timestamp('last_heartbeat', { withTimezone: true }),
});

export const networkPaths = pgTable('network_paths', {
  id: uuid('id').primaryKey().defaultRandom(),
  fromMachine: text('from_machine').notNull(),
  toMachine: text('to_machine').notNull(),
  kind: text('kind').notNull(),
  rttMs: integer('rtt_ms').notNull(),
  throughputMbps: integer('throughput_mbps').notNull(),
  endpoint: text('endpoint'),
  relayId: text('relay_id'),
  measuredAt: timestamp('measured_at', { withTimezone: true }).defaultNow().notNull(),
});
