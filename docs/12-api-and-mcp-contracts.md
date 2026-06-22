# API and MCP Contracts

## API Style

Use tRPC for internal dashboard APIs and REST for webhooks/install/bootstrap endpoints.

## Core API Routers

```text
auth
users
teams
projects
environments
services
deployments
machines
network
domains
secrets
logs
metrics
audit
settings
```

## Key Endpoints

REST:

```text
GET  /health
GET  /install.sh
POST /api/agent/enroll
POST /api/agent/heartbeat
POST /api/webhooks/github
POST /api/webhooks/cloudflare
```

tRPC:

```text
project.list
project.get
project.create
service.create
service.update
service.evaluateZeroDowntime
deployment.create
deployment.rollback
deployment.logs
machine.list
machine.get
machine.createEnrollment
machine.command
network.pathMatrix
network.recommendations
domain.create
secret.create
```

## MCP Tools

MCP tools should map to safe platform actions:

```text
list_apps
get_app
get_app_health
get_release_history
deploy_app
rollback_release
get_logs
explain_failed_deployment
list_machines
get_machine
get_network_matrix
run_network_benchmark
create_preview_environment
add_domain
rotate_secret
```

Dangerous tools:

```text
drain_machine
remove_machine
delete_app
rotate_network_keys
```

Dangerous tools require dry-run and confirmation.

