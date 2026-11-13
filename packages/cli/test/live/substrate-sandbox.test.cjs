// Run in a built checkout or copy this file into the packaged n8n container.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { randomUUID } = require('node:crypto');
const { mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const { setTimeout: wait } = require('node:timers/promises');
const { isDeepStrictEqual } = require('node:util');

const PUBLISHED_SANDBOX_IMAGE =
	'ghcr.io/jseguillon/n8n-sandbox-service-substrate@sha256:cfb59a6a2bcea0d185ffa2f5f52ee572c548b996979886d6246d557f4089ecd4';

test(
	'packaged n8n Substrate integration',
	{
		skip: process.env.SUBSTRATE_INTEGRATION_TEST !== '1',
		timeout: 240_000,
	},
	async (suite) => {
		async function step(name, run) {
			let passed = false;
			await suite.test(name, async () => {
				await run();
				passed = true;
			});
			assert.ok(passed, `Live integration step failed: ${name}`);
		}
		const required = [
			'SUBSTRATE_API_ENDPOINT',
			'SUBSTRATE_ROUTER_URL',
			'SUBSTRATE_ATESPACE',
			'SUBSTRATE_ACTOR_TEMPLATE',
			'SUBSTRATE_TOKEN_FILE',
			'SUBSTRATE_CA_FILE',
			'SUBSTRATE_ROUTER_CREDENTIAL_FILE',
			'SUBSTRATE_EGRESS_POLICY_FILE',
		];
		const missing = required.filter((name) => !process.env[name]?.trim());
		assert.equal(
			missing.length,
			0,
			`Set the required environment variables: ${missing.join(', ')}`,
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
		const packageRoot = process.env.N8N_SUBSTRATE_TEST_PACKAGE_ROOT || resolve(__dirname, '../..');
		const fromN8n = createRequire(join(packageRoot, 'package.json'));
		const agentsRequire = createRequire(fromN8n.resolve('@n8n/agents/sandbox'));
		const grpc = agentsRequire('@grpc/grpc-js');
		const protobuf = agentsRequire('protobufjs');
		const protocol = protobuf.parse(`syntax = "proto3"; package substrate.ateapi.v1;
message ObjectRef { string atespace = 1; string name = 2; }
message ActorRequest { ObjectRef actor = 1; }
message TemplateRequest { ObjectRef actor_template = 1; }
message PolicyRequest { ObjectRef actor = 1; string name = 2; }
message ActorStatus { int32 state = 1; }
message Actor { ActorStatus status = 5; }
message Container { string name = 1; string image = 2; }
message ActorTemplate { repeated Container containers = 3; }
message EgressPolicy { repeated EgressRule rules = 2; }
message EgressRule { TlsPassthroughRule tls_passthrough = 3; }
message TlsPassthroughRule { repeated string hostnames = 1; Ports ports = 2; }
message Ports { repeated int32 numbers = 2; }
`).root;
		async function rpc(method, requestName, responseName, request) {
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
			const input = protocol.lookupType(`substrate.ateapi.v1.${requestName}`);
			const output = protocol.lookupType(`substrate.ateapi.v1.${responseName}`);
			try {
				return await new Promise((resolveRpc, reject) =>
					client.makeUnaryRequest(
						`/substrate.ateapi.v1.Control/${method}`,
						(value) => Buffer.from(input.encode(input.fromObject(value)).finish()),
						(buffer) => output.toObject(output.decode(buffer)),
						request,
						metadata,
						{ deadline: Date.now() + 10_000 },
						(error, value) => (error ? reject(error) : resolveRpc(value)),
					),
				);
			} finally {
				client.close();
			}
		}
		const ref = (name) => ({ atespace: connection.atespace, name });
		async function state(actorId) {
			try {
				return (await rpc('GetActor', 'ActorRequest', 'Actor', { actor: ref(actorId) })).status
					?.state;
			} catch (error) {
				if (error.code === grpc.status.NOT_FOUND) return null;
				throw error;
			}
		}
		async function policy(actorId) {
			return await rpc('GetActorEgressPolicy', 'PolicyRequest', 'EgressPolicy', {
				actor: ref(actorId),
				name: 'default',
			});
		}
		async function poll(check, description, timeoutMs = 30_000) {
			const deadline = Date.now() + timeoutMs;
			while (Date.now() < deadline) {
				if (await check()) return;
				await wait(100);
			}
			assert.fail(`Timed out waiting for ${description}`);
		}
		await step('ActorTemplate uses the expected digest-pinned sandbox image', async () => {
			const image = process.env.SUBSTRATE_TEST_SANDBOX_IMAGE || PUBLISHED_SANDBOX_IMAGE;
			assert.match(image, /@sha256:[a-f0-9]{64}$/);
			const template = await rpc('GetActorTemplate', 'TemplateRequest', 'ActorTemplate', {
				actorTemplate: ref(connection.template),
			});
			suite.diagnostic(
				`ActorTemplate container digests: ${(template.containers ?? []).map((container) => container.image?.split('@')[1] || 'unpinned').join(', ')}`,
			);
			assert.ok(
				template.containers?.some(
					(container) => container.image?.split('@')[1] === image.split('@')[1],
				),
				'ActorTemplate must use SUBSTRATE_TEST_SANDBOX_IMAGE or the documented published image',
			);
		});

		// Set test-owned storage before importing n8n settings or database entities.
		const folder = await mkdtemp(join(tmpdir(), 'n8n-substrate-live-'));
		const actors = new Map();
		const resources = { database: undefined, coordinator: undefined };
		suite.after(async () => {
			const errors = [];
			for (const [id, sandbox] of actors) {
				try {
					await sandbox.destroy();
					await resources.coordinator.forgetActor(id);
					await poll(async () => (await state(id)) === null, 'disposable Actor deletion');
				} catch (error) {
					suite.diagnostic(`Actor cleanup requires attention: ${id}`);
					errors.push(error);
				}
			}
			try {
				await resources.database?.close();
			} catch (error) {
				errors.push(error);
			}
			try {
				await rm(folder, { recursive: true, force: true });
			} catch (error) {
				errors.push(error);
			}
			if (errors.length) throw new AggregateError(errors, 'Substrate live-test cleanup failed');
		});
		process.env.N8N_USER_FOLDER = folder;
		process.env.DB_TYPE = 'sqlite';
		process.env.DB_SQLITE_DATABASE = 'database.sqlite';
		process.env.DB_SQLITE_POOL_SIZE = '4';
		process.env.N8N_LOG_LEVEL = 'silent';
		const { Container } = fromN8n('@n8n/di');
		const { GlobalConfig } = fromN8n('@n8n/config');
		const { DbConnection, SubstrateActorActivityRepository } = fromN8n('@n8n/db');
		const { createSandbox, createFilesystem } = fromN8n('@n8n/agents/sandbox');
		const { SubstrateControl } = agentsRequire('./substrate-control.js');
		const { SubstrateActorLifecycleService } = fromN8n(
			join(packageRoot, 'dist/services/substrate-actor-lifecycle.service.js'),
		);
		const database = Container.get(DbConnection);
		resources.database = database;
		const warnings = [];
		await database.init();
		await database.migrate();
		const config = Container.get(GlobalConfig);
		config.generic.substrateSandboxSuspendDelayMs = 5_000;
		const repository = Container.get(SubstrateActorActivityRepository);
		const settings = {
			getProvider: () => 'substrate',
			getSubstrateConfig: async () => ({ connection }),
		};
		const logger = { warn: () => warnings.push('Actor cleanup failed') };
		const coordinator = new SubstrateActorLifecycleService(repository, settings, logger, config);
		resources.coordinator = coordinator;
		async function create(policyOverride = {}, tracked = true, actorConnection = connection) {
			const actor = await createSandbox({
				enabled: true,
				provider: 'substrate',
				connection: actorConnection,
				id: `live-${randomUUID()}`,
				timeout: 30_000,
				ephemeral: false,
				onOperation: tracked
					? coordinator.createOperationRecorder(actorConnection, {
							autoStopMinutes: 2,
							autoDeleteMinutes: 60,
							ephemeral: false,
							...policyOverride,
						})
					: undefined,
			});
			actors.set(actor.id, actor);
			return actor;
		}
		const row = async (actor) =>
			(await repository.findAll()).find((activity) => activity.actorId === actor.id);
		async function idle(actor) {
			const activity = await row(actor);
			assert.equal(Object.keys(activity.operationLeases).length, 0);
			assert.equal(activity.claimToken, null);
			return activity;
		}
		async function suspended(actor) {
			await poll(async () => {
				if ((await state(actor.id)) !== 4) return false;
				const activity = await row(actor);
				return (
					activity?.lastSuspendedAt &&
					activity.claimToken === null &&
					Object.keys(activity.operationLeases).length === 0
				);
			}, 'actual ATE suspension and completed database claim');
		}
		const sandbox = await create();
		const filesystem = createFilesystem(sandbox);
		const root = `/home/user/workspace/live-${randomUUID()}`;

		await step('command results precede the grace period and actual suspension', async () => {
			const result = await sandbox.executeCommand('printf', ['live-ready']);
			assert.equal(result.exitCode, 0);
			assert.equal(result.stdout.trim(), 'live-ready');
			const completed = Date.now();
			assert.ok((await idle(sandbox)).suspendAfter.getTime() - completed > 4_000);
			assert.equal(await state(sandbox.id), 2);
			await wait(2_500);
			assert.equal(await state(sandbox.id), 2);
			await suspended(sandbox);
			assert.ok(Date.now() - completed >= 4_800);
		});
		await step('follow-up work cancels the old deadline', async () => {
			assert.equal((await sandbox.executeCommand('printf', ['follow-up'])).exitCode, 0);
			await wait(1_000);
			const execution = sandbox.executeCommand('sleep', ['8']);
			await poll(
				async () => Object.keys((await row(sandbox)).operationLeases).length > 0,
				'follow-up lease',
			);
			await wait(5_500);
			assert.equal(await state(sandbox.id), 2);
			assert.equal((await row(sandbox)).suspendAfter, null);
			assert.equal((await execution).exitCode, 0);
			await suspended(sandbox);
		});
		await step('parallel commands retain independent leases', async () => {
			const short = sandbox.executeCommand('sleep', ['3']);
			const long = sandbox.executeCommand('sleep', ['10']);
			await poll(
				async () => Object.keys((await row(sandbox)).operationLeases).length >= 2,
				'parallel leases',
			);
			assert.equal((await short).exitCode, 0);
			assert.equal(Object.keys((await row(sandbox)).operationLeases).length, 1);
			await wait(5_500);
			assert.equal(await state(sandbox.id), 2);
			assert.equal((await row(sandbox)).suspendAfter, null);
			assert.equal((await long).exitCode, 0);
			await suspended(sandbox);
		});
		await step('binary filesystem operations survive suspend and wake', async () => {
			const binary = Buffer.from([0, 1, 2, 255]);
			await filesystem.mkdir(root, { recursive: true });
			await filesystem.writeFile(`${root}/source`, binary);
			await filesystem.appendFile(`${root}/source`, Buffer.from([3]));
			await filesystem.copyFile(`${root}/source`, `${root}/copy`, { overwrite: false });
			await filesystem.moveFile(`${root}/copy`, `${root}/moved`, { overwrite: false });
			assert.deepEqual(await filesystem.readFile(`${root}/moved`), Buffer.from([0, 1, 2, 255, 3]));
			assert.equal((await filesystem.stat(`${root}/moved`)).size, 5);
			assert.ok((await filesystem.readdir(root)).some((entry) => entry.name === 'moved'));
			await suspended(sandbox);
			assert.deepEqual(await filesystem.readFile(`${root}/moved`), Buffer.from([0, 1, 2, 255, 3]));
		});
		await step('a throttled real download holds its lease through body consumption', async () => {
			const contents = Buffer.alloc(2 * 1024 * 1024, 7);
			await filesystem.writeFile(`${root}/large`, contents);
			await sandbox.executeCommand('printf', ['before-download']);
			const fetch = globalThis.fetch;
			globalThis.fetch = async (url, options) => {
				const response = await fetch(url, options);
				if (!new URL(url).pathname.endsWith('/files/content')) return response;
				let first = true;
				return new Response(
					response.body.pipeThrough(
						new TransformStream({
							async transform(chunk, controller) {
								if (first) {
									first = false;
									await wait(6_500);
								}
								controller.enqueue(chunk);
							},
						}),
					),
					{ status: response.status, headers: response.headers },
				);
			};
			try {
				const download = filesystem.readFile(`${root}/large`);
				await poll(
					async () => Object.keys((await row(sandbox)).operationLeases).length > 0,
					'download lease',
				);
				await wait(5_500);
				assert.equal(await state(sandbox.id), 2);
				assert.equal((await row(sandbox)).suspendAfter, null);
				assert.deepEqual(await download, contents);
			} finally {
				globalThis.fetch = fetch;
			}
			await suspended(sandbox);
		});
		await step(
			'interrupted execution streams resume without running the command twice',
			async () => {
				const fetch = globalThis.fetch;
				let posts = 0;
				let resumes = 0;
				globalThis.fetch = async (url, options) => {
					const response = await fetch(url, options);
					if (new URL(url).pathname.endsWith('/executions') && options?.method === 'POST') {
						posts++;
						const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
						let prefix = '';
						while (!prefix.includes('\n')) {
							const chunk = await reader.read();
							assert.ok(!chunk.done, 'expected a started execution event');
							prefix += chunk.value;
						}
						await reader.cancel();
						return new Response(prefix.slice(0, prefix.indexOf('\n') + 1), {
							status: response.status,
							headers: response.headers,
						});
					}
					if (new URL(url).pathname.includes('/executions/') && options?.method !== 'DELETE')
						resumes++;
					return response;
				};
				try {
					const result = await sandbox.executeCommand('sh', [
						'-c',
						`printf once >> '${root}/execution-count'; printf 'first\\n'; sleep 1; printf 'last\\n'`,
					]);
					assert.equal(result.exitCode, 0);
					assert.equal(posts, 1);
					assert.ok(resumes > 0);
					assert.equal(result.stdout.match(/first/g)?.length, 1);
					assert.equal(result.stdout.match(/last/g)?.length, 1);
				} finally {
					globalThis.fetch = fetch;
				}
				assert.equal((await filesystem.readFile(`${root}/execution-count`)).toString(), 'once');
			},
		);
		await step('timeouts terminate remote work and release the operation', async () => {
			const marker = `${root}/timeout-marker`;
			const result = await sandbox.executeCommand('sh', ['-c', `sleep 2; touch '${marker}'`], {
				timeout: 250,
			});
			assert.equal(result.timedOut, true);
			assert.equal(result.success, false);
			await idle(sandbox);
			await wait(2_500);
			assert.equal(await filesystem.exists(marker), false);
			await suspended(sandbox);
		});
		await step('cancellation terminates remote work and releases the operation', async () => {
			const marker = `${root}/cancel-marker`;
			const controller = new AbortController();
			await assert.rejects(
				sandbox.executeCommand('sh', ['-c', `printf 'ready\\n'; sleep 2; touch '${marker}'`], {
					abortSignal: controller.signal,
					onStdout: () => controller.abort(),
				}),
			);
			await idle(sandbox);
			await wait(2_500);
			assert.equal(await filesystem.exists(marker), false);
			await suspended(sandbox);
		});
		await step(
			'automatic deletion recovers the same cached adapter as an empty Actor',
			async () => {
				const deleted = await create({ autoDeleteMinutes: 0 });
				const files = createFilesystem(deleted);
				await files.writeFile('/home/user/workspace/deleted-marker', 'old');
				await poll(
					async () => (await state(deleted.id)) === null && !(await row(deleted)),
					'automatic Actor deletion',
				);
				assert.equal((await deleted.executeCommand('printf', ['recreated'])).exitCode, 0);
				assert.equal(await files.exists('/home/user/workspace/deleted-marker'), false);
				await poll(
					async () => (await state(deleted.id)) === null && !(await row(deleted)),
					'replacement Actor deletion',
				);
			},
		);
		await step(
			'default egress rules are copied, permit npm access, and preserve existing policy',
			async () => {
				assert.equal(
					(
						await sandbox.executeCommand('curl', [
							'--fail',
							'--silent',
							'--show-error',
							'--max-time',
							'10',
							'--output',
							'/dev/null',
							'--write-out',
							'%{http_code}',
							'https://registry.npmjs.org/@n8n/workflow-sdk',
						])
					).stdout.trim(),
					'200',
				);
				const expected = JSON.parse(await readFile(connection.egressPolicyFile, 'utf8'));
				assert.ok(
					isDeepStrictEqual((await policy(sandbox.id)).rules, expected.rules),
					'Actor policy must match the configured default',
				);
				const denyFile = join(folder, 'deny-egress.json');
				await writeFile(denyFile, JSON.stringify({ rules: [] }));
				await new SubstrateControl(
					{ ...connection, egressPolicyFile: denyFile },
					20_000,
				).ensureActor(sandbox.id);
				assert.ok(
					isDeepStrictEqual((await policy(sandbox.id)).rules, expected.rules),
					'an existing policy must remain unchanged',
				);
			},
		);
		await step('a fresh coordinator recovers expired work without an in-memory timer', async () => {
			const orphan = await create({}, false);
			assert.equal((await orphan.executeCommand('printf', ['orphan'])).exitCode, 0);
			const fingerprint = (await row(sandbox)).connectionFingerprint;
			await repository.startOperation(
				{
					actorId: orphan.id,
					connectionFingerprint: fingerprint,
					autoStopMinutes: 0.01,
					autoDeleteMinutes: 60,
					ephemeral: false,
				},
				'abandoned-operation',
				1_000,
				new Date(Date.now() - 120_000),
			);
			await new SubstrateActorLifecycleService(
				repository,
				settings,
				logger,
				config,
			).cleanupIdleActors();
			await suspended(orphan);
		});
		await step('unset default policy does not implicitly permit egress', async () => {
			const isolated = await create({}, false, { ...connection, egressPolicyFile: undefined });
			assert.equal((await isolated.executeCommand('printf', ['no-policy'])).exitCode, 0);
			await assert.rejects(policy(isolated.id), (error) => error.code === grpc.status.NOT_FOUND);
		});
		assert.equal(warnings.length, 0, 'coordinator must not report cleanup failures');
	},
);
