// Run inside a packaged n8n test pod. This benchmark creates disposable Actors.
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { randomUUID } = require('node:crypto');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { performance } = require('node:perf_hooks');

function required(name) {
	assert.ok(process.env[name]?.trim(), `Set ${name}`);
	return process.env[name].trim();
}

function stats(values) {
	values.sort((a, b) => a - b);
	const middle = Math.floor(values.length / 2);
	const median = values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
	return { median, min: values[0], max: values.at(-1) };
}

async function main() {
	if (process.env.SUBSTRATE_INTEGRATION_TEST !== '1') {
		console.log('Skipped: set SUBSTRATE_INTEGRATION_TEST=1 to benchmark disposable Actors.');
		return;
	}
	const atespace = required('SUBSTRATE_BENCH_ATESPACE');
	const templates = required('SUBSTRATE_BENCH_TEMPLATES')
		.split(',')
		.map((name) => name.trim());
	const samples = Number(process.env.SUBSTRATE_BENCH_SAMPLES || 3);
	const repetitions = Number(process.env.SUBSTRATE_BENCH_REPETITIONS || 5);
	assert.ok(Number.isInteger(samples) && samples > 0 && samples <= 10);
	assert.ok(Number.isInteger(repetitions) && repetitions > 0 && repetitions <= 20);
	const folder = await mkdtemp(join(tmpdir(), 'n8n-fidelity-benchmark-'));
	process.env.N8N_USER_FOLDER = folder;
	process.env.DB_TYPE = 'sqlite';
	process.env.DB_SQLITE_DATABASE = 'database.sqlite';
	process.env.DB_SQLITE_POOL_SIZE = '4';
	process.env.N8N_LOG_LEVEL = 'silent';
	const root = process.env.N8N_SUBSTRATE_TEST_PACKAGE_ROOT || '/usr/local/lib/node_modules/n8n';
	const fromN8n = createRequire(join(root, 'package.json'));
	const { Container } = fromN8n('@n8n/di');
	const { DbConnection, SubstrateActorActivityRepository } = fromN8n('@n8n/db');
	const { createSandbox } = fromN8n('@n8n/agents/sandbox');
	const { createWorkspace, setupSandboxWorkspace, isSandboxWorkspaceInitialized } =
		fromN8n('@n8n/instance-ai');
	const { SubstrateActorLifecycleService } = fromN8n(
		join(root, 'dist/services/substrate-actor-lifecycle.service.js'),
	);
	const database = Container.get(DbConnection);
	const actors = new Map();
	const results = [];
	const warnings = [];
	const logger = { debug() {}, info() {}, error() {}, warn() {} };
	let repository;
	try {
		await database.init();
		await database.migrate();
		repository = Container.get(SubstrateActorActivityRepository);
		for (const template of templates) {
			const connection = {
				endpoint: required('SUBSTRATE_API_ENDPOINT'),
				routerUrl: required('SUBSTRATE_ROUTER_URL'),
				atespace,
				template,
				tokenFile: required('SUBSTRATE_TOKEN_FILE'),
				caFile: required('SUBSTRATE_CA_FILE'),
				routerCredentialFile: required('SUBSTRATE_ROUTER_CREDENTIAL_FILE'),
				serverName: process.env.SUBSTRATE_SERVER_NAME || 'api.ate-system.svc',
				egressPolicyFile: required('SUBSTRATE_EGRESS_POLICY_FILE'),
			};
			const coordinator = new SubstrateActorLifecycleService(
				repository,
				{
					getProvider: () => 'substrate',
					getSubstrateConfig: async () => ({ connection }),
				},
				{ warn: () => warnings.push('Lifecycle action failed') },
			);
			for (let sample = 0; sample < samples; sample++) {
				const sandbox = await createSandbox({
					enabled: true,
					provider: 'substrate',
					connection,
					id: `benchmark-${randomUUID()}`,
					timeout: 120_000,
					onOperation: coordinator.createOperationRecorder(connection, {
						autoStopMinutes: 5,
						autoDeleteMinutes: 60,
						ephemeral: false,
					}),
				});
				actors.set(sandbox.id, sandbox);
				const workspace = createWorkspace(sandbox);
				const execute = sandbox.executeCommand.bind(sandbox);
				let installs = 0;
				sandbox.executeCommand = async (command, ...args) => {
					if (command.startsWith('npm install')) installs++;
					return await execute(command, ...args);
				};
				let startedAt = performance.now();
				await workspace.init();
				const initMs = Math.round(performance.now() - startedAt);
				assert.ok(await workspace.filesystem.exists('/home/user/workspace/.n8n-runtime-ready'));
				startedAt = performance.now();
				assert.equal(
					await setupSandboxWorkspace(
						workspace,
						{
							logger,
							nodeService: { listSearchable: async () => [] },
						},
						{ verifiedBundles: new Map() },
					),
					true,
				);
				const setupMs = Math.round(performance.now() - startedAt);
				assert.equal(installs, 0, 'A prepared template must not install dependencies again');
				const warm = [];
				for (let repetition = 0; repetition < repetitions; repetition++) {
					startedAt = performance.now();
					assert.ok(await isSandboxWorkspaceInitialized(workspace));
					const markerMs = Math.round(performance.now() - startedAt);
					const commandStartedAt = performance.now();
					const command = await sandbox.executeCommand('ls', [], {
						cwd: '/home/user/workspace',
						timeout: 10_000,
					});
					assert.equal(command.exitCode, 0);
					warm.push({
						markerMs,
						commandMs: Math.round(performance.now() - commandStartedAt),
						daemonMs: command.executionTimeMs,
						totalMs: Math.round(performance.now() - startedAt),
					});
				}
				const result = {
					template,
					sample: sample + 1,
					initMs,
					setupMs,
					startupMs: initMs + setupMs,
					installs,
					warm,
				};
				results.push(result);
				console.log(JSON.stringify(result));
				await sandbox.destroy();
				await coordinator.forgetActor(sandbox.id);
				actors.delete(sandbox.id);
			}
		}
		assert.equal(warnings.length, 0, 'All lifecycle actions must succeed');
		console.log(
			JSON.stringify({
				summary: templates.map((template) => {
					const rows = results.filter((row) => row.template === template);
					return {
						template,
						samples: rows.length,
						initMs: stats(rows.map((row) => row.initMs)),
						setupMs: stats(rows.map((row) => row.setupMs)),
						startupMs: stats(rows.map((row) => row.startupMs)),
						warmPairMs: stats(rows.flatMap((row) => row.warm.map((entry) => entry.totalMs))),
						warmCommandMs: stats(rows.flatMap((row) => row.warm.map((entry) => entry.commandMs))),
						daemonMs: stats(rows.flatMap((row) => row.warm.map((entry) => entry.daemonMs))),
					};
				}),
			}),
		);
	} finally {
		try {
			for (const sandbox of actors.values()) {
				await sandbox.destroy();
				await repository?.deleteActor(sandbox.id);
			}
		} finally {
			await database.close();
			await rm(folder, { recursive: true, force: true });
		}
	}
}

main().catch((error) => {
	console.error(error.name, error.message);
	process.exitCode = 1;
});
