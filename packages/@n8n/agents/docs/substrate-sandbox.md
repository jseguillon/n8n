# Substrate sandbox

The `substrate` provider uses the Substrate v0.4 control API to manage Actors.
It sends commands and file requests through `atenet-router`.
Each sandbox uses an Actor in the configured Atespace and ActorTemplate.

## Configure n8n

Set these server environment variables:

| Variable | Value |
| --- | --- |
| `SUBSTRATE_API_ENDPOINT` | gRPC host and port, without a URL scheme |
| `SUBSTRATE_ROUTER_URL` | Private HTTP or HTTPS router URL |
| `SUBSTRATE_ATESPACE` | Atespace name |
| `SUBSTRATE_ACTOR_TEMPLATE` | Template name in that Atespace |
| `SUBSTRATE_TOKEN_FILE` | Path to a mounted bearer token file |
| `SUBSTRATE_CA_FILE` | Path to the control API CA bundle |
| `SUBSTRATE_SERVER_NAME` | TLS server name; defaults to `api.ate-system.svc` |

Mount the token and CA files read-only. The n8n user must be able to read them.
Use a token whose audience and issuer match the control API configuration.
Rotate the token before it expires. The client reads it for each control API call.
Keep the router private. Grant the control identity access only to its Atespace.

Leave `N8N_INSTANCE_AI_SANDBOX_PROVIDER` unset to select **Agent Substrate** in
**Agents → Add a code sandbox**. The dialog verifies a workspace and saves the
provider selection. It does not send the server token or CA to the browser.

For server-managed configuration, set
`N8N_INSTANCE_AI_SANDBOX_PROVIDER=substrate` and
`N8N_INSTANCE_AI_SANDBOX_ENABLED=true`. The UI then shows a server-managed
connection instead of the provider choices.

## Settings API

The sandbox provider enum also accepts `substrate` in the settings and
verification APIs. A sandbox verification request uses
`{"provider":"substrate"}` without a connection payload. An admin settings
update selects it with `{"sandboxProvider":"substrate","sandboxEnabled":true}`.
The server reads the connection from its environment in both cases.

## Lifecycle

`stop()` suspends persistent Actors. It deletes ephemeral Actors. A router request
can wake a suspended Actor and restore its state. `destroy()` deletes it.
Verification workspaces are deleted after the probe.
Agent chat workspaces are scoped to an n8n conversation thread. A later message
in the same thread reuses its Actor; a different thread receives a different Actor.
Substrate does not implement the Daytona idle timers in n8n. Use an external idle
controller to suspend inactive persistent Actors. Instance AI deletes its own
ephemeral Actors at cache expiry. Agent knowledge sandboxes reject
`N8N_AGENTS_AI_SANDBOX_EPHEMERAL=true` until an external cleanup controller is
configured for their deterministic Actor identities.

The ActorTemplate router target must match the daemon listen port and prepare
`/home/user/workspace`. The primary template uses port 8081. The v0.4
compatibility template uses port 80. Commands run under the daemon's configured
user.

## Integration test

The Substrate integration suite is disabled by default. Set
`SUBSTRATE_INTEGRATION_TEST=1` and provide the `SUBSTRATE_*` connection
variables to run it against a private test Atespace:

```sh
pnpm test:integration src/__tests__/integration/substrate-sandbox.integration.test.ts
```

The suite creates and deletes Actors. It verifies lifecycle wake and persistence,
router filesystem operations, command results, timeout, and cancellation. Do not
run it against a shared production Atespace.
