# Security and Safety Model

## Principles

- Do not expose SSH.
- Do not expose arbitrary shell execution through the agent.
- All mutation actions require authentication, RBAC, and audit logs.
- Dangerous actions require confirmation.
- Secrets are write-only in UI after creation.
- Agent commands are whitelisted.
- AI agents interact only through Portless APIs/MCP tools.

## Agent Security

The agent should use:

- Enrollment token for first registration.
- Machine identity after enrollment.
- mTLS or signed request authentication.
- Short-lived command leases.
- Command replay protection.
- Agent version pinning and upgrade policy.

## Secret Management

MVP:

- Store encrypted secrets in Postgres using envelope encryption.
- Do not log secret values.
- Do not return secret values from read APIs.
- Allow secret rotation.

Production:

- Support external secret stores.
- Support per-team secret scopes.
- Support audit trail for secret access and updates.

## AI Safety

MCP tools should be high-level:

```text
list_apps
get_app_health
deploy_app
rollback_release
get_logs
explain_failed_deployment
list_machines
get_network_paths
cordon_machine
drain_machine
```

No MCP tool should allow raw shell by default.

Dangerous MCP tools require:

- dry-run result.
- user confirmation.
- RBAC check.
- audit log.

