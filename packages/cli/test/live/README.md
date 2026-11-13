# Live Substrate integration tests

These tests contact an existing Agent Substrate deployment. They create and
delete disposable Actors. They do not install Substrate or change worker pools,
ActorTemplates, or an existing Actor's egress policy.

## Requirements

- Substrate Control API v1.0.0.
- An existing ActorTemplate with a daemon wakeup probe and workspace at
  `/home/user/workspace`.
- The published sandbox image:
  `ghcr.io/jseguillon/n8n-sandbox-service-substrate@sha256:cfb59a6a2bcea0d185ffa2f5f52ee572c548b996979886d6246d557f4089ecd4`.
- Readable Control API token, CA, and router mTLS files. Use the same identity
  configuration as n8n. Do not put their contents in command arguments.
- A default egress policy that permits `registry.npmjs.org:443`. Use the
  [example policy](../../../../docs/substrate-egress-policy.example.json).
- An identity permitted to create, inspect, resume, suspend, and delete Actors,
  inspect their template, and create/read their egress policy in the test Atespace.

Configure these environment variables with endpoints, resource names, and file
paths, not file contents:

```text
SUBSTRATE_API_ENDPOINT
SUBSTRATE_ROUTER_URL
SUBSTRATE_ATESPACE
SUBSTRATE_ACTOR_TEMPLATE
SUBSTRATE_TOKEN_FILE
SUBSTRATE_CA_FILE
SUBSTRATE_ROUTER_CREDENTIAL_FILE
SUBSTRATE_EGRESS_POLICY_FILE
SUBSTRATE_SERVER_NAME  # optional; default api.ate-system.svc
```

The installation and identities remain externally managed. See the
[n8n connection guide](../../../../docs/substrate-ui-configuration.md) and the
[Substrate v1 installation guide](https://github.com/agent-substrate/substrate/blob/v1.0.0/docs/guides/operator-install.md).

## Run against the packaged n8n runtime

Build the checkout with `pnpm build`, or use a packaged n8n container. The test
uses Node's built-in test runner, so the container needs no Vitest installation.
It checks the template's image digest before it creates any Actors. Set
`SUBSTRATE_TEST_SANDBOX_IMAGE` to an explicit digest-pinned image reference only
when deliberately testing another image.

From a built checkout:

```sh
SUBSTRATE_INTEGRATION_TEST=1 pnpm --filter n8n test:substrate:live
```

To use an existing n8n test pod with its projected identity and configuration:

```sh
kubectl -n <namespace> cp packages/cli/test/live/substrate-sandbox.test.cjs \
  <pod>:/tmp/substrate-sandbox.test.cjs
kubectl -n <namespace> exec <pod> -- env \
  SUBSTRATE_INTEGRATION_TEST=1 \
  N8N_SUBSTRATE_TEST_PACKAGE_ROOT=/usr/local/lib/node_modules/n8n \
  node --test /tmp/substrate-sandbox.test.cjs
```

The suite creates a temporary SQLite database and sets its user folder before
loading n8n settings. It never uses the application's database. It removes its
temporary storage and deletes its disposable Actors in cleanup, including after
a failed step. Cleanup failures fail the suite. No LLM or user credentials are
needed. The package-root override selects a built runtime, not a database.

Coverage includes actual ATE suspension, grace-period cancellation, parallel
leases, binary filesystem operations, full download consumption, interrupted
execution streams, timeout, cancellation, cached-adapter recovery after automatic
deletion, configured egress, and recovery by a new coordinator without timers.

## Run the SDK-only suite

```sh
SUBSTRATE_INTEGRATION_TEST=1 pnpm --filter @n8n/agents test:substrate:live
```

This suite uses the provider source and Vitest. It requires no n8n database and
uses no LLM recording setup or dotenv file. It checks commands, filesystem
metadata, overwrite behavior, suspend/wake, cancellation, and deletion recovery.
Its registry-access test is explicitly skipped if no default egress policy file
is configured. The packaged-runtime suite requires that file for full coverage.

Without `SUBSTRATE_INTEGRATION_TEST=1`, both suites report skipped tests and
contact no deployment. With the flag set, missing configuration fails the suite
instead of silently skipping it. Run only against a dedicated test Atespace.
