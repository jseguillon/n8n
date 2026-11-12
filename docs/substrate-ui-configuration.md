# Configure Agent Substrate in the shared sandbox UI

Use **Settings > Agents > Shared sandbox** to configure Agent Substrate.
The same connection serves Agents and n8n Assistant.

## Configuration boundary

The design follows the existing Daytona connection flow: an instance
administrator enters connection fields, verifies the connection, and saves an
instance credential. Deployment settings remain with the server operator.

| Setting | Owner | Reason |
| --- | --- | --- |
| Control API endpoint (`host:port`) | UI / encrypted instance credential | Identifies the Substrate control service |
| Router URL (`http://` or `https://`) | UI / encrypted instance credential | Identifies the daemon routing service |
| Atespace and ActorTemplate | UI / encrypted instance credential | Select existing resources authorized for the control identity |
| Static bearer access token | Optional password field / encrypted instance credential | Same storage path and redaction behavior as other provider credentials |
| Renewable token file path | Server environment and mount only | The operator owns file access and renewal |
| Private CA file and TLS server-name override | Server environment only | The operator owns the trust boundary |
| Router client identity bundle | Server environment and mount only | Authenticates n8n to the router through mTLS |
| Kubernetes identity, worker images, and template definitions | Server operator | They are not sandbox connection fields |
| Timeouts and lifecycle policy | Server operator | They control runtime behavior |

The UI does not accept `tokenFile`, `caFile`, or `serverName` fields. The backend
also rejects these fields in a submitted Substrate credential. It returns only
a boolean indicating whether the server supplies a renewable token, never that
token's path or value.

## Configure through the UI

1. Open **Settings > Agents > Shared sandbox > Add sandbox**.
2. Select **Agent Substrate**.
3. Enter the control endpoint, router URL, Atespace, and ActorTemplate.
4. If the operator provides a renewable token file, the form shows a server-
   managed identity notice. Otherwise enter the bearer token in **Access token**.
5. Select **Save**. n8n verifies a disposable Actor, its command execution and
   filesystem access, then saves the connection through n8n credentials.

The connection is stored as a `substrateApi` instance credential. Settings keep
its assignment, not plaintext connection secrets. The existing n8n encryption
and secret-redaction mechanisms apply. Editing restores redacted secrets on the
backend. Selecting an existing Substrate credential uses the same saved-credential
selection and assignment flow as Daytona and n8n Sandbox. It does not load the
secret into the selection form. New or edited connections use the sandbox
verification endpoint before the dialog saves them.

Credential edits require both the settings permission and
`credential:manageInstance`. Existing credential selection uses the standard
instance-credential availability and assignment checks. These are instance-admin
settings, not per-Agent or per-user connection overrides.

## Server-owned configuration

For a publicly trusted control certificate, TLS uses the system trust store.
The TLS name defaults to the host in the UI control endpoint. A private cluster
or a local port-forward usually needs operator configuration:

```yaml
environment:
  SUBSTRATE_TOKEN_FILE: /run/substrate/token
  SUBSTRATE_CA_FILE: /run/substrate/ca.crt
  SUBSTRATE_ROUTER_CREDENTIAL_FILE: /run/substrate/router-identity.pem
  SUBSTRATE_SERVER_NAME: api.ate-system.svc
volumes:
  - /operator/connection:/run/substrate:ro
```

The mounted token takes precedence over any static credential token. It is read
again for each control RPC, so external token renewal does not require an n8n
restart. A UI-entered static token is not automatically renewed.

The router identity bundle contains the client certificate chain and private
key. The router must trust its identity. The Control API bearer token does not
replace this bundle. See the external installation guide for identity issuance
and renewal.

To use UI-owned connection settings, do not force these values in the process
environment:

```text
N8N_INSTANCE_AI_SANDBOX_PROVIDER
N8N_INSTANCE_AI_SANDBOX_ENABLED
SUBSTRATE_API_ENDPOINT
SUBSTRATE_ROUTER_URL
SUBSTRATE_ATESPACE
SUBSTRATE_ACTOR_TEMPLATE
```

Retain the server-owned TLS and token-file variables when the deployment needs
them. Restart n8n after you change its environment.

## Full environment-managed mode remains available

An operator can configure the complete connection through the seven
`SUBSTRATE_*` variables and enable/select Substrate through
`N8N_INSTANCE_AI_SANDBOX_*`. A complete environment connection takes precedence
over stored UI credentials. The form then remains environment-managed, like the
existing Daytona and n8n Sandbox forms. Partial TLS or identity settings alone
do not lock the UI connection editor.
