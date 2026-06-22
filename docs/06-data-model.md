# Data Model

This is the product-level schema. Implementation can start with Drizzle/Postgres.

## Identity and RBAC

```text
users
teams
team_members
roles
permissions
api_tokens
sessions
audit_logs
```

Permissions:

```text
project.read
project.write
deployment.create
deployment.rollback
machine.read
machine.write
machine.drain
secret.write
domain.write
network.write
mcp.use
```

## Machines and Network

```text
machines
machine_roles
machine_labels
machine_heartbeats
machine_commands
network_nodes
network_paths
network_relays
wireguard_keys
```

Machine fields:

```text
id
name
hostname
region
roles
online
agent_version
runtime_version
nomad_status
consul_status
wireguard_status
wg_ip
container_subnet
cpu_total
memory_total
disk_total
last_heartbeat_at
```

Network path fields:

```text
from_machine_id
to_machine_id
kind
rtt_ms
throughput_mbps
packet_loss
jitter_ms
endpoint
relay_id
last_tested_at
```

## Apps and Services

```text
projects
environments
services
service_dependencies
service_domains
service_env_vars
service_secrets
service_resources
service_placement_rules
```

Service types:

```text
web
worker
cron
database
static
```

## Releases and Deployments

```text
releases
deployments
deployment_steps
deployment_events
builds
rollbacks
incidents
```

Release states:

```text
pending
building
deploying
healthy
degraded
failed
rolling_back
rolled_back
cancelled
```

## Domains and Ingress

```text
domains
cloudflare_accounts
cloudflare_zones
cloudflare_tunnels
cloudflare_routes
gateway_nodes
```

## Secrets

MVP can store encrypted secrets in Postgres. Future integrations can support Vault, Infisical, 1Password, Bitwarden Secrets, and External Secrets-like patterns.

Secrets must never be returned to the UI once saved.

