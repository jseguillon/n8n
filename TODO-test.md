# Substrate Sandbox Test TODO

Implement the following before treating the Substrate provider as equivalent to
the original Docker/DinD/Sysbox sandbox. Use the Docker tests as the behavior
reference; do not port Docker runtime, network, or Sysbox-specific assertions.

## Router filesystem conformance E2E

Exercise daemon filesystem operations through `atenet-router`: read, write,
append, list, stat, mkdir, copy, move, delete, binary data, invalid paths, and
file-to-command visibility.

Reference: `n8n-sandbox-service/e2e/tests/sandbox-api.spec.ts:269` and
`n8n-sandbox-service/e2e/tests/file-exec-consistency.spec.ts:19`.

## Command execution E2E

Test stdout/stderr, exit status, signals, environment, cwd, timeout, malformed
NDJSON, daemon error events, non-2xx responses, redirect rejection, and
cumulative output limits through a real Actor and router.

Reference: `n8n-sandbox-service/e2e/tests/sandbox-api.spec.ts:126` and
`n8n-sandbox-service/e2e/tests/resumable-exec.spec.ts:20`.

## Substrate control transport tests

Add transport-mocked tests for TLS and token metadata, deadlines, and gRPC
error propagation. Lifecycle semantics are covered by unit tests.

Target: `packages/@n8n/agents/src/workspace/sandbox/substrate-control.ts`.

## Authorization E2E

At the authenticated gateway policy boundary, prove a caller cannot select a
different Actor or Atespace, including attempts to control the
`ate-target-actor` header. This belongs in the deployment/gateway test suite,
not the Docker sandbox tests.
