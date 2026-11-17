// Run in an n8n container. This creates a tag from a new, dependency-only Actor.
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { randomUUID } = require('node:crypto');
const { readFile } = require('node:fs/promises');
const { dirname, join } = require('node:path');

async function main() {
	const required = [
		'SUBSTRATE_API_ENDPOINT',
		'SUBSTRATE_ROUTER_URL',
		'SUBSTRATE_ATESPACE',
		'SUBSTRATE_ACTOR_TEMPLATE',
		'SUBSTRATE_TOKEN_FILE',
		'SUBSTRATE_CA_FILE',
		'SUBSTRATE_ROUTER_CREDENTIAL_FILE',
		'SUBSTRATE_SEED_TAG',
	];
	for (const name of required) assert.ok(process.env[name]?.trim(), `Set ${name}`);
	const tag = process.env.SUBSTRATE_SEED_TAG;
	assert.match(tag, /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/);
	const root = process.env.N8N_SUBSTRATE_TEST_PACKAGE_ROOT || '/usr/local/lib/node_modules/n8n';
	const fromN8n = createRequire(join(root, 'package.json'));
	const { createSandbox } = fromN8n('@n8n/agents/sandbox');
	const agentsRequire = createRequire(fromN8n.resolve('@n8n/agents/sandbox'));
	const grpc = agentsRequire('@grpc/grpc-js');
	const protobuf = agentsRequire('protobufjs');
	const instanceRoot = dirname(fromN8n.resolve('@n8n/instance-ai'));
	const { PACKAGE_JSON, NPM_INSTALL_FLAGS_REFRESH_METADATA } = fromN8n(
		join(instanceRoot, 'workspace/sandbox-setup.js'),
	);
	const connection = {
		endpoint: process.env.SUBSTRATE_API_ENDPOINT,
		routerUrl: process.env.SUBSTRATE_ROUTER_URL,
		atespace: process.env.SUBSTRATE_ATESPACE,
		template: process.env.SUBSTRATE_ACTOR_TEMPLATE,
		tokenFile: process.env.SUBSTRATE_TOKEN_FILE,
		caFile: process.env.SUBSTRATE_CA_FILE,
		routerCredentialFile: process.env.SUBSTRATE_ROUTER_CREDENTIAL_FILE,
		serverName: process.env.SUBSTRATE_SERVER_NAME || 'api.ate-system.svc',
		egressPolicyFile: process.env.SUBSTRATE_EGRESS_POLICY_FILE,
	};
	const protocol = protobuf.parse(`syntax = "proto3"; package substrate.ateapi.v1;
message ObjectRef { string atespace = 1; string name = 2; }
message ResourceMetadata { string atespace = 1; string name = 2; }
message SnapshotStorage { int32 state = 1; }
message Snapshot { int32 fidelity = 4; SnapshotStorage durable_snapshot = 7; }
message TagStatus { Snapshot snapshot = 1; }
message Tag { ResourceMetadata metadata = 1; TagStatus status = 2; int32 scope = 3; ObjectRef source_actor = 4; }
message CreateTagRequest { Tag tag = 1; }
`).root;
	const sandbox = await createSandbox({
		enabled: true,
		provider: 'substrate',
		connection,
		id: `dependency-seed-${randomUUID()}`,
		timeout: 180_000,
	});
	try {
		await sandbox.writeFile(sandbox.id, '/home/user/workspace/package.json', PACKAGE_JSON);
		const result = await sandbox.executeCommand(
			`npm install ${NPM_INSTALL_FLAGS_REFRESH_METADATA} && npm ls --all --silent > /dev/null 2>&1`,
			[],
			{ cwd: '/home/user/workspace', timeout: 120_000 },
		);
		assert.equal(result.exitCode, 0, 'Dependency installation and validation must succeed');
		await sandbox.stop();
		const [ca, token] = await Promise.all([
			readFile(connection.caFile),
			readFile(connection.tokenFile, 'utf8'),
		]);
		const client = new grpc.Client(connection.endpoint, grpc.credentials.createSsl(ca), {
			'grpc.ssl_target_name_override': connection.serverName,
			'grpc.default_authority': connection.serverName,
		});
		const metadata = new grpc.Metadata();
		metadata.set('authorization', `Bearer ${token.trim()}`);
		const input = protocol.lookupType('substrate.ateapi.v1.CreateTagRequest');
		const output = protocol.lookupType('substrate.ateapi.v1.Tag');
		try {
			const created = await new Promise((resolve, reject) => {
				client.makeUnaryRequest(
					'/substrate.ateapi.v1.Control/CreateTag',
					(value) => Buffer.from(input.encode(input.fromObject(value)).finish()),
					(buffer) => output.toObject(output.decode(buffer)),
					{
						tag: {
							metadata: { atespace: connection.atespace, name: tag },
							scope: 1,
							sourceActor: { atespace: connection.atespace, name: sandbox.id },
						},
					},
					metadata,
					{ deadline: Date.now() + 180_000 },
					(error, value) => (error ? reject(error) : resolve(value)),
				);
			});
			assert.equal(created.status?.snapshot?.durableSnapshot?.state, 2);
			console.log(
				JSON.stringify({
					tag,
					atespace: connection.atespace,
					template: connection.template,
					fidelity: created.status.snapshot.fidelity,
					dependencies: JSON.parse(PACKAGE_JSON),
					installMs: result.executionTimeMs,
				}),
			);
		} finally {
			client.close();
		}
	} finally {
		await sandbox.destroy();
	}
}

main().catch((error) => {
	console.error(error.name, error.message);
	process.exitCode = 1;
});
