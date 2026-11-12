# Substrate sandbox

The `substrate` provider uses the Substrate v1 Control API to manage Actors.
It sends commands and file requests through `atenet-router`.
Each sandbox uses an Actor in the configured Atespace and ActorTemplate.

## Configure n8n

Use **Settings > Agents > Shared sandbox** to enter the control endpoint,
router URL, Atespace, ActorTemplate, and optional static access token. The UI
verifies and saves a `substrateApi` instance credential. Server-owned TLS trust,
router credentials, and renewable token files stay outside the form. See the
[UI configuration guide](../../../../docs/substrate-ui-configuration.md) for
the full field boundary and precedence rules.

For a fully environment-managed connection, use the variables below.

Set these server environment variables:

| Variable | Value |
| --- | --- |
| `SUBSTRATE_API_ENDPOINT` | gRPC host and port, without a URL scheme |
| `SUBSTRATE_ROUTER_URL` | Private HTTPS router URL |
| `SUBSTRATE_ATESPACE` | Atespace name |
| `SUBSTRATE_ACTOR_TEMPLATE` | Template name in that Atespace |
| `SUBSTRATE_TOKEN_FILE` | Path to a mounted bearer token file |
| `SUBSTRATE_CA_FILE` | Path to the control API CA bundle |
| `SUBSTRATE_ROUTER_CREDENTIAL_FILE` | Path to a mounted PodIdentity PEM bundle for router mTLS |
| `SUBSTRATE_SERVER_NAME` | TLS server name; defaults to `api.ate-system.svc` |

Mount the token and CA files read-only. The n8n user must be able to read them.
Mount a projected PodIdentity credential bundle for the n8n service account.
Allow that SPIFFE ID in the Substrate router ingress list.
Use a token whose audience and issuer match the control API configuration.
Rotate the token before it expires. The client reads it for each control API call.
The router credential stays deployment-managed, even when you enter a static
Control API token in the UI.
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
verification APIs. To test a draft UI connection, send `provider: "substrate"`
and `connection: { type: "substrateApi", data: ... }`. Save that same connection
with `sandboxConnection` in the admin settings update. Its data fields are
`endpoint`, `routerUrl`, `atespace`, `template`, and optional `apiToken`.

A verification request with only `{"provider":"substrate"}` resolves the
assigned instance credential, or the complete operator environment connection
when that mode is active. Selecting a provider alone does not create a working
UI connection. The server-owned file and TLS settings are never credential data.

## Lifecycle

`stop()` synchronously suspends persistent Actors and waits for a durable
snapshot. It deletes ephemeral Actors. A router request can wake a suspended
Actor and restore its state. `destroy()` deletes it.
Verification workspaces are deleted after the probe.
Agent workspaces use the existing project, Agent, and principal identity.
Assistant workspaces use a thread-derived identity.
n8n records Substrate Actor activity in its database. When automatic suspension
is enabled, n8n records completion immediately and sets a separate suspension
deadline after the final command or file operation finishes. The delay defaults
to 5 seconds. A new operation cancels the deadline and starts a new grace period
when that operation finishes. n8n then suspends a persistent Actor or deletes an
ephemeral Actor without keeping a snapshot.
Each operation has its own persisted lease. File reads hold their lease until
the response body is consumed. Cleanup claims use a database revision and a
unique owner token. Duplicate completions cannot release another operation's
lease, and an expired claim owner cannot complete a newer claim.
The command timeout still applies independently of the suspend behavior.
If the execution stream disconnects, n8n resumes it by execution ID instead of
starting the command again.

A cluster-leader task runs once per hour as a recovery check for Actors whose
command-exit cleanup was missed, for example after an n8n restart. It uses the
configured auto-stop interval and deletes suspended Actors after their retention
interval.

The coordinator migration preserves existing activity rows and legacy command
leases. It adds operation leases, revisions, suspension deadlines, and claim
ownership. Update all main processes together before using the new coordinator;
older processes do not participate in its revision checks.

Instance AI uses `N8N_INSTANCE_AI_SANDBOX_AUTO_STOP_MINUTES` (default 15) and
`N8N_INSTANCE_AI_SANDBOX_AUTO_DELETE_MINUTES` (default 10080). Agent workspaces
use `N8N_AGENTS_AI_SANDBOX_WORKSPACE_AUTO_STOP_MINUTES` (default 5) and
`N8N_AGENTS_AI_SANDBOX_WORKSPACE_AUTO_DELETE_MINUTES` (default 1440). Agent
knowledge sandboxes use `N8N_AGENTS_AI_SANDBOX_KNOWLEDGE_AUTO_STOP_MINUTES`
(default 15) and `N8N_AGENTS_AI_SANDBOX_KNOWLEDGE_AUTO_DELETE_MINUTES` (default
10080). These auto-stop intervals control whether n8n suspends an Actor after a
command and provide the recovery threshold for an Actor that missed
command-exit cleanup. Set an auto-stop value to `0` to disable automatic
suspension. Set an auto-delete value to a negative number to keep suspended
Actor files. Set it to `0` to delete an Actor when it is suspended. Daytona
auto-archive does not apply to Substrate.

Set `N8N_SUBSTRATE_SANDBOX_SUSPEND_DELAY_MS` to change the command suspend delay
in milliseconds. Set it to `0` to suspend or delete an Actor as soon as its final
command exits or times out.

The ActorTemplate router target must match the daemon listen port and prepare
`/home/user/workspace`. Commands run under the daemon's configured user.

The provider creates an Actor egress policy that permits TLS passthrough only to
`registry.npmjs.org:443`. This lets Agent workspaces install npm packages. All
other outbound destinations remain denied.

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
