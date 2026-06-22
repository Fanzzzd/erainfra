# Node Agent Design

The Portless node-agent is a Go daemon installed on every machine.

## Responsibilities

The agent performs only controlled, whitelisted host operations:

- Register machine with Portless.
- Install/update Netmaker netclient or future wg-agent.
- Install/update Nomad client.
- Install/update Consul agent.
- Install/update cloudflared on gateway nodes.
- Install/update Docker/containerd if requested.
- Manage systemd units owned by Portless.
- Report heartbeat, resources, runtime status, and network path metrics.
- Stream logs from local runtime.
- Execute approved maintenance commands.

## Non-Goals

The agent must not become a remote shell. It should not expose arbitrary command execution.

## Command Model

Each command should include:

```text
id
machine_id
type
payload
requested_by
risk_level
dry_run
requires_confirmation
status
started_at
finished_at
stdout_summary
stderr_summary
```

Allowed command types:

```text
install_runtime
install_network_client
install_nomad
install_consul
install_cloudflared
restart_service
cordon_machine
drain_machine
uncordon_machine
rotate_wireguard_key
collect_diagnostics
run_network_benchmark
upgrade_agent
```

Dangerous commands require confirmation and audit logs.

## Enrollment Flow

```text
1. User clicks Add Machine.
2. Portless generates one-time enrollment token.
3. User runs install command.
4. Agent registers with token.
5. API returns machine ID and desired install plan.
6. Agent applies install plan.
7. Agent joins network fabric.
8. Agent joins Nomad and Consul.
9. Agent reports ready.
```

## Install Command UX

```bash
curl -fsSL https://install.example.com/install.sh | sudo bash -s -- \
  --enroll-token pl_enroll_xxxxx
```

