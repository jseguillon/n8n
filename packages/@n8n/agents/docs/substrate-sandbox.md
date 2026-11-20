# Substrate sandbox

The `substrate` provider uses the Substrate v1 Control API to manage Actors.
It sends commands and file requests through `atenet-router`.
Each sandbox uses an Actor in the configured Atespace and ActorTemplate.

## Configure n8n

Use **Settings > Agents > Shared sandbox** to enter the control endpoint,
router URL, Atespace, ActorTemplate, and optional static access token. The UI
verifies and saves a `substrateApi` instance credential. Server-owned TLS trust,
router credentials, and renewable token files stay outside the form.

The connection serves Agents and n8n Assistant. Editing a saved connection uses
the existing credential encryption, redaction, and permission checks. Selecting
an existing credential does not return its secret to the form.

For a fully environment-managed connection, use the variables below.

Set these server environment variables:

| Variable | Value |
| --- | --- |
| `SUBSTRATE_API_ENDPOINT` | gRPC host and port, without a URL scheme |
| `SUBSTRATE_ROUTER_URL` | Private HTTPS router URL |
| `SUBSTRATE_ATESPACE` | Atespace name |
| `SUBSTRATE_ACTOR_TEMPLATE` | Template name in that Atespace |
| `SUBSTRATE_ACTOR_TAG` | Optional operator-prepared dependency snapshot tag in the same Atespace and template |
| `SUBSTRATE_PREVIOUS_ACTOR_TEMPLATES` | Optional comma-separated allowlist of previous template names for existing Actors |
| `SUBSTRATE_TOKEN_FILE` | Path to a mounted bearer token file |
| `SUBSTRATE_CA_FILE` | Path to the control API CA bundle |
| `SUBSTRATE_ROUTER_CREDENTIAL_FILE` | Path to a mounted PodIdentity PEM bundle for router mTLS |
| `SUBSTRATE_SERVER_NAME` | TLS server name; defaults to `api.ate-system.svc` |
| `SUBSTRATE_EGRESS_POLICY_FILE` | Optional server-owned JSON file with default Actor egress rules |

Mount the token and CA files read-only. The n8n user must be able to read them.
Mount a projected PodIdentity credential bundle for the n8n service account.
Allow that SPIFFE ID in the Substrate router ingress list.
Use a token whose audience and issuer match the control API configuration.
Rotate the token before it expires. The client reads it for each control API call.
The router credential stays deployment-managed, even when you enter a static
Control API token in the UI. The router must use HTTPS.
Keep the router private. Grant the control identity access only to its Atespace.

Leave `N8N_INSTANCE_AI_SANDBOX_PROVIDER` unset to select **Agent Substrate** in
**Agents → Add a code sandbox**. The dialog verifies a workspace and saves the
provider selection. It does not send the server token or CA to the browser.

Agents and Assistant use the same instance rollout flag, `140_substrate_sandbox`. Set
`N8N_SUBSTRATE_SANDBOX_ENABLED=true` to enable it on an instance. This setting
does not configure a Substrate connection.

For server-managed configuration, set
`N8N_INSTANCE_AI_SANDBOX_PROVIDER=substrate` and
`N8N_INSTANCE_AI_SANDBOX_ENABLED=true`. The UI then shows a server-managed
connection instead of the provider choices.

A complete environment connection takes precedence over saved credentials.
Partial TLS or token-file settings alone do not lock the connection form.
For a UI connection, an unset CA file uses system trust. An unset TLS name uses
the endpoint host. A mounted token file takes precedence over a static token.
When you mount a token, set `SUBSTRATE_API_ENDPOINT` on the server. Saved and
draft connections must use that endpoint, including its port.

Before changing to another connection, retire workspaces through their original
connection. n8n does not move Actors between connections or delete them through
an unrelated endpoint. An existing workspace with a different connection reports
an error instead of waiting for a cleanup claim.

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

`stop()` suspends persistent Actors with asynchronous durability (mode `2`).
The RPC returns after the node-local checkpoint. atelet uploads the snapshot
to object storage in the background. Synchronous durability (mode `1`) also
waits for that upload to complete. Until the upload completes, the latest
checkpoint depends on the node that holds it. See the
[Substrate v1 API](https://github.com/agent-substrate/substrate/blob/v1.0.0/api/ateapi/v1/ateapi.proto).
`stop()` deletes ephemeral Actors. A router request can wake a suspended
Actor and restore its state. `destroy()` deletes it.
Verification workspaces are deleted after the probe.
Agent workspaces use the existing project, Agent, and principal identity.
Assistant workspaces use a thread-derived identity.
n8n records Substrate Actor activity in its database. When automatic suspension
is enabled, n8n requests suspension as soon as the final command or file
operation finishes, fails, or times out. There is no pre-suspend timer or grace
period. n8n waits for the asynchronous suspend RPC to return before it releases
the database claim. It does not wait for the upload to object storage.
n8n deletes an ephemeral Actor without keeping a snapshot.
Each operation has its own persisted lease. File reads hold their lease until
the response body is consumed. Cleanup claims use a database revision and a
unique owner token. Duplicate completions cannot release another operation's
lease, and an expired claim owner cannot complete a newer claim.
The command timeout still applies independently of the suspend behavior.
If the execution stream disconnects, n8n resumes it by execution ID instead of
starting the command again.

If a cached adapter receives a not-found response, it checks the Actor through
the Control API. A missing file does not recreate an existing Actor. When the
Actor is gone, concurrent requests share one recreation and retry once. A command
can retry this way only if its submission was rejected with HTTP 404. An accepted
or started execution is never resubmitted because replay failed. A recreated
Actor starts from its prepared runtime without the previous user files.
Assistant checks the workspace initialization marker again
and reruns setup before reusing its cached workspace.

A cluster-leader task runs once per hour as a recovery check for Actors whose
command-exit cleanup was missed, for example after an n8n restart. It uses the
configured auto-stop interval and deletes suspended Actors after their retention
interval.

For an ephemeral Assistant workspace, each main holds a lease while it caches
the workspace. Idle eviction releases that lease. n8n deletes the Actor after
the last lease ends. If a main exits or deletion fails, the hourly cleanup task
can retry after the leases expire. Turning off the rollout does not disable cleanup.

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

The ActorTemplate router target must match the daemon listen port and prepare
`/home/user/workspace`. Commands run under the daemon's configured user.

## Default egress policy

Substrate v1 applies egress policies per Actor. A template's golden egress policy
does not carry over to Actors created from it. n8n has no built-in destination
allowlist. Configure a server-owned default policy before workspace setup needs
to download npm packages.

1. Save the example below as a JSON file readable by the n8n process.
2. Mount that file read-only, for example at `/run/substrate/egress-policy.json`.
3. Set `SUBSTRATE_EGRESS_POLICY_FILE=/run/substrate/egress-policy.json`.
4. Restart n8n after you change the environment variable.

The file contains rules, without resource metadata:

```json
{
  "rules": [
    {
      "tlsPassthrough": {
        "hostnames": ["registry.npmjs.org"],
        "ports": { "numbers": [443] }
      }
    }
  ]
}
```

This example permits npm registry TLS traffic on port 443. Add only the hosts
and ports your sandbox workloads need. This integration accepts HTTP and TLS
passthrough rules with hostname lists and either `ports.numbers` (up to 16 port
numbers) or `ports.all: {}`. A hostname of `*` matches every hostname. The loader
rejects unsupported rule types and fields instead of silently dropping them.
An empty rules list permits no outbound destinations.

For broad web access, use an HTTP rule for `*` on port 80 and a TLS passthrough
rule for `*` with `ports.all: {}`. The explicit HTTP port takes precedence.
Substrate rejects an HTTP and TLS rule with the same hostname pattern when both
select all ports. Substrate v1 policies do not allow arbitrary TCP, UDP,
TLS without SNI, STARTTLS, or server-first protocols. Cleartext HTTP on other
ports needs an explicit HTTP rule.

n8n reads and validates the file before Actor acquisition. It copies the rules
into an Actor's `default` policy before resume when that Actor has no policy.
Existing Actor policies remain unchanged. Changing the file affects newly
created Actors and Actors without a policy; it does not reconcile existing
policies. Use Substrate's policy API or CLI to change an existing policy.

When the variable is unset, n8n makes no egress-policy calls. Substrate denies
unmatched DNS and outbound traffic, so package downloads need an existing policy
or a configured default. Egress policy files and rules are server-managed, not
editable through an n8n credential or the sandbox connection form.

## Workspace preparation

A command's `executionTimeMs` measures daemon execution, in milliseconds.
The Assistant turn also includes model calls, lazy workspace setup, router wake,
file transfers, and suspension. The first workspace tool initializes workflow
dependencies even when the requested command is small.

Prepare the ActorTemplate with the sandbox daemon, Node.js, and a writable
`/home/user/workspace`. The daemon must expose a readiness probe. Operators can
install shared dependencies before the template captures its golden snapshot.
Leave `SUBSTRATE_ACTOR_TAG` unset to use the template's golden snapshot.

Use `SUBSTRATE_ACTOR_TAG` to seed new Actors from a dependency-only snapshot.
The tag must belong to the configured Atespace and ActorTemplate. This setting
does not change existing Actors or their template checks. An absent or
incompatible configured tag fails Actor creation. With the setting unset, n8n
uses the template's golden snapshot as before.

Substrate workspace setup checks the local dependency tree with `npm ls --all`.
It skips installation only when the complete tree satisfies the generated
package manifest. Missing or incompatible dependencies use the existing install
path. Linked-SDK development mode still installs its packages.

When you select a new immutable template, list approved old names in
`SUBSTRATE_PREVIOUS_ACTOR_TEMPLATES`. Existing Actors keep their original
template and state. Both template validation and persisted activity accept only
the explicit same-Atespace allowlist. Cleanup continues to handle old Actors.
