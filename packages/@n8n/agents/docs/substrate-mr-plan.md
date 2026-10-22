# Substrate provider: upstream readiness plan

Review date: 2026-10-21. Baseline: n8n 2.43.8, integration commit `191ef6e7`.
This document describes proposed work. It is not a support guarantee.

## Recommendation

Treat the current integration as a working prototype. Ask the n8n maintainers
whether they want a native provider or an external backend for their existing
sandbox service protocol. Agree on ownership and supported Substrate versions
before expanding the public provider list.

The native provider preserves Actor lifecycle and snapshots. A compatible
external backend could reduce changes in n8n, but it would need to implement the
complete service API, including tenant authorization and lifecycle semantics.
It must not be a transparent, unauthenticated router proxy.

## Evidence and feature compatibility

The baseline is the `n8n-sandbox` adapter, not Sysbox in isolation. Sysbox is an
isolation backend; the daemon, image, and adapter determine the n8n API features.
The current Substrate template uses gVisor. Do not claim it has the same kernel
or nested-container behavior as Sysbox, or describe it as a hardware VM.

| Feature | Current evidence | MR requirement |
| --- | --- | --- |
| Provider selection and persistence | Browser verification passed; selection survived reload | Add backend persistence and provider-switch tests |
| Commands and stdout/stderr | Live command failure, timeout, router cancellation, and stdout/stderr callback tests passed; unit tests cover split, malformed, bounded, and error streams | Test reconnects |
| Node and Python execution | Live commands passed: Node 24.21.0 and Python 3.11.2 | Publish and test the image toolchain contract |
| File operations | Live binary read/write/append/list/stat/copy/move/delete, overwrite conflict, and recursive copy passed | Test large files and concurrent access |
| Suspend and restore | File persistence and router wake passed | Test process-memory continuity, worker loss, and durable snapshot completion |
| Knowledge search | Source uses `rg`, `timeout`, shell pipelines; required basic tools exist | Run real upload, mirror, search, read, and permission tests |
| Assistant workflow builder | Only basic workspace initialization/probe passed | Run `setupSandboxWorkspace`, TypeScript build, diagnostics, and workflow round-trip |
| Package installation and outbound HTTP | Live npm registry request failed with connection reset; Actors have default-deny egress | Provide tested restricted-egress or offline setup profiles |
| Preinstalled workflow SDK | Live Actor and n8n host both report 0.36.5 | Verify the complete dependency set and upgrade compatibility, not one version |
| Git commands | `git` absent in live image | Include it if part of the supported profile; otherwise document the limit |
| Nested Docker | `docker` absent; gVisor is not a Sysbox drop-in for nested Docker | Explicitly unsupported until separately designed and tested; no host socket mount |
| Process list/kill tools | Adapter has no `processes`; these tools are not registered | Same limitation exists in the current n8n-sandbox adapter; distinguish Daytona parity |
| Sandbox information | Native adapter has `getInfo`; Substrate does not | Implement metadata/status or explicitly declare capability limits |
| Agent scratch workspace and delegated sub-agents | Identity wiring exists; no full run verified | Test principal isolation and parent-workspace sharing across queued/resumed runs |
| Triggers, schedules, model calls, workflow tools | No evidence these depend directly on Sysbox | Regression-test them; external n8n task runners are a separate subsystem |
| Browser/computer use | Not verified; no browser capability promised by this adapter | Trace the relevant separate service integration before claiming support |
| Idle and ephemeral cleanup | Instance AI deletes ephemeral Actors at cache expiry; persistent Actors need an external idle controller | Provide a trusted persistent Actor idle controller |
| Assistant cleanup after restart | Uncached cleanup supports `n8n-sandbox` and Substrate by stable thread identity | Test orphan reconciliation |

Important: `setupSandboxWorkspace` writes package files and runs `npm install`.
The verification endpoint only initializes a workspace and runs `printf`.
A successful verification is therefore not proof that the full builder works.

## P0: lifecycle and transport correctness

1. Replace the handwritten protobuf subset with versioned generated types, or
   a maintained Substrate client. Pin the schema and add wire-contract tests.
   The prototype already exposed an unknown-field failure during live testing.
2. Propagate AbortSignal and deadlines into gRPC calls and file requests.
   One startup budget must cover create, inspect, resume, and health readiness.
   A local Promise timeout must not leave uncontrolled remote creation running.
3. Handle partial creation and late success. Delete newly owned temporary Actors
   after failed verification. Do not delete an existing persistent Actor because
   a reconnect failed. Record ownership and validate template/identity metadata.
4. Fix uncached Assistant cleanup. Keep enough provider/config identity to clean
   resources after provider changes and n8n restarts. Add orphan reconciliation.
5. Define persistent versus ephemeral semantics for Agent knowledge, Agent
   scratch space, and Assistant threads. Implement idle suspension and retention
   with a controller or supported Substrate mechanism. Test concurrent users so
   one run cannot suspend or delete another run's active workspace.
6. Bound NDJSON line size, accumulated output, and file downloads. Use existing
   output truncation conventions. Consume/cancel unused HTTP response bodies.
7. Define replay semantics for interrupted streams. The daemon exposes execution
   IDs, sequence/replay support, and cancellation. Do not retry arbitrary commands
   after ambiguous transport failure: that can execute a side effect twice.
8. Add safe retry/backoff for idempotent control operations and readiness.
   Classify authentication, policy, capacity, timeout, and missing-Actor errors.
9. Respect the Agents timeout configuration. The prototype obtains Substrate
   settings from Instance AI and does not use the Agents timeout at acquisition.
10. Extract a small daemon transport/filesystem interface. Avoid coupling a
    generic filesystem adapter to a union of concrete provider classes.

Acceptance: failure-injection tests cover late create, restart/delete, two n8n
workers acquiring the same Actor, token rotation, interrupted output, and cleanup.

## P0: networking without kubectl port-forward

### Preferred: n8n in the same Kubernetes cluster

- Use `api.ate-system.svc:443` for control and the router's service DNS for data.
  Confirm TLS SANs and supported load-balancing behavior for the headless API
  service. Use a supported service front door if needed.
- Use a dedicated n8n ServiceAccount with a projected, short-lived token. Set the
  audience required by the control API. Let Kubernetes rotate it. Mount the trust
  bundle separately. Do not use the bootstrap owner identity.
- Grant the identity only the required Actor/template permissions in its
  Atespace. Test actual authorization enforcement, not just authentication.
- Restrict router access with NetworkPolicy and an authenticated policy layer.
  The routing header is a destination, not proof of authorization.
- n8n workers need the same configuration, trust, and credentials as the main
  process if they execute sandbox operations.

### n8n outside the cluster

- Use a private VPN/routed network and private load balancer or ingress.
- Control ingress must support gRPC over HTTP/2 with TLS. Data ingress must
  support long NDJSON responses, disabled response buffering, suitable timeouts,
  and file-size limits. Validate the selected controller with real traffic.
- Authenticate data-plane access with a gateway token or mTLS. The adapter must
  gain explicit router authentication/trust support; it currently sends only
  `ate-target-actor`. The gateway must enforce the caller's Actor/Atespace scope.
- Keep both endpoints private where possible. Do not publish the raw router as
  an unauthenticated public NodePort or LoadBalancer.

For local development only, provide a supervised tunnel command with readiness,
restart, and token-expiry checks. This improves convenience but is not the
production architecture. No kubectl dependency should exist inside n8n.

## P0: user configuration and image contract

Provide an operator-owned connection and an admin-selectable provider. Ordinary
Agent users should not choose arbitrary endpoints, Atespaces, templates, or
control credentials.

Proposed operator inputs (names require maintainer agreement):

- Control endpoint, server name, and CA bundle.
- Router URL, separate router trust configuration, and supported auth mode.
- Atespace and immutable/versioned ActorTemplate reference.
- Token file for projected/workload identity; optional mTLS if supported end to end.
- Startup/command budgets and explicit persistent/ephemeral policy.
- Resource, concurrency, idle, and retention limits. Prefer template/controller
  ownership for these limits rather than conflicting per-command settings.

Prefer n8n-prefixed environment variable names for an upstream release. Keep
server-managed fields separate from UI settings. If encrypted n8n credentials
are supported later, define precedence and rotation first. Never expose secret
values, local file contents, or privileged template controls to the browser.

Provide a reference deployment with:

1. Digest-pinned daemon image and matching runtime/toolchain manifest.
2. Versioned template, non-root command execution, writable home/workspace,
   CPU/memory/disk limits, quotas, snapshot encryption and retention.
3. Dedicated identity, trust bundles, authorization policy, and NetworkPolicy.
4. Restricted-egress profile for required package registries and approved
   destinations. Include DNS and any egress TLS interception CA requirements.
5. Offline profile with a complete pinned dependency closure and a tested setup
   path that does not attempt registry refreshes. Preinstalled node_modules alone
   do not establish offline support.
6. A documented runtime compatibility test for rootless startup. Keep the v0.4
   chmod/chown workaround version-scoped and test that sandbox commands cannot
   regain startup capabilities. Do not ask users to invent these settings.

Enhance the UI verification result with control auth, template availability,
capacity/readiness, UID, required binaries, file I/O, and cleanup status. Separate
quick connectivity checks from the full builder/package check. Report unsupported
capabilities clearly. Do not label a disabled or invalid provider as configured.

## P1: tests, operations, and review packaging

- Add a shared provider contract suite for n8n-sandbox and Substrate. Include
  command quoting, Unicode/binary files, cwd/env, cancellation, and error mapping.
- Add CLI service tests for selection persistence, env precedence, missing
  config, failed verification, provider switch, and uncached deletion.
- Run a real Agent with knowledge upload/search and a delegated sub-agent.
  Run an Assistant build/edit/validate cycle. Include an offline failure case.
- Verify instance/project/principal isolation, forged routing headers, denied
  egress, expired credentials, and no control credentials inside an Actor.
- Add metrics for cold/warm startup, active/suspended/orphan Actors, failures,
  command duration, cleanup failures, and capacity. Redact credentials and
  sensitive Actor output from logs. Document alert and recovery procedures.
- Pin supported versions and publish a compatibility matrix for n8n, daemon,
  Substrate, and image. Test upgrades and template replacement with saved state.
- Keep dependency growth reviewable. Avoid eagerly loading a gRPC/protobuf stack
  when users select another provider.
- Remove workstation-specific documentation from the upstream patch. Supply
  portable examples, API documentation, release notes, and a reproducible demo.
- After maintainer agreement, rebase onto the accepted target branch. Split
  review into transport/contract, runtime/lifecycle, UI/settings, and deployment
  documentation changes. Keep CI tests deterministic and make live tests opt-in.

## Suggested delivery order

1. Maintainer design agreement and shared capability contract.
2. Fix lifecycle leaks, cancellation, bounds, and transport contract tests.
3. Deploy private service networking with rotating identity and router policy.
4. Publish a tested image/template plus online/offline dependency policy.
5. Run full Agent and Assistant acceptance tests; resolve parity gaps.
6. Submit the reviewed provider/UI patch with deployment docs and CI evidence.

Do not describe the prototype as production-ready until P0 requirements pass.
