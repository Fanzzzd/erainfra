# Agent Implementation Playbook

This is the step-by-step coding guide for the AI agent.

## Rules

1. Keep the repository passing tests after every change.
2. Do not replace mature infrastructure with large custom code unless explicitly required.
3. Prefer provider interfaces and adapters.
4. Write tests for every new policy decision.
5. Do not introduce arbitrary shell execution.
6. Document every external service assumption.

## Suggested Implementation Order

1. Convert API from dependency-free server to Fastify + tRPC.
2. Add Drizzle/Postgres schema and migrations.
3. Implement AppSpec import and validation.
4. Implement machine enrollment database records.
5. Implement Netmaker provider interface with mocks.
6. Implement agent heartbeat.
7. Implement Nomad provider interface with mocks.
8. Implement Consul provider interface with mocks.
9. Implement Cloudflare provider interface with mocks.
10. Implement Temporal deploy workflow.
11. Build UI screens around real APIs.
12. Add MCP tools.
13. Add production install script.

## How to Handle Unknowns

When API details change, do not guess silently. Add a `docs/verification-notes.md` entry and implement the provider behind an interface so it can be swapped.

## Test Strategy

- Unit tests for scheduler, HA policy, renderers.
- Integration tests for API routes using test database.
- Provider mocks for Netmaker, Nomad, Consul, Cloudflare.
- Agent tests for command allowlist and install plans.
- End-to-end smoke test for sample deployment plan.

