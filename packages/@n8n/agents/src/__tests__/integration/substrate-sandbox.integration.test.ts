import { randomUUID } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { SubstrateSandbox } from '../../workspace/sandbox/substrate-sandbox';
import { SubstrateControl } from '../../workspace/sandbox/substrate-control';

const connection = {
	endpoint: process.env.SUBSTRATE_API_ENDPOINT ?? '',
	routerUrl: process.env.SUBSTRATE_ROUTER_URL ?? '',
	atespace: process.env.SUBSTRATE_ATESPACE ?? '',
	template: process.env.SUBSTRATE_ACTOR_TEMPLATE ?? '',
	tokenFile: process.env.SUBSTRATE_TOKEN_FILE ?? '',
	caFile: process.env.SUBSTRATE_CA_FILE ?? '',
	routerCredentialFile: process.env.SUBSTRATE_ROUTER_CREDENTIAL_FILE ?? '',
	serverName: process.env.SUBSTRATE_SERVER_NAME ?? 'api.ate-system.svc',
	...(process.env.SUBSTRATE_EGRESS_POLICY_FILE
		? { egressPolicyFile: process.env.SUBSTRATE_EGRESS_POLICY_FILE }
		: {}),
};

const enabled = process.env.SUBSTRATE_INTEGRATION_TEST === '1';

async function withSandbox(run: (sandbox: SubstrateSandbox, root: string) => Promise<void>) {
	const id = `test-${randomUUID()}`;
	const root = `/home/user/workspace/.n8n-substrate-${id}`;
	const sandbox = new SubstrateSandbox({ ...connection, id, timeout: 20_000 });
	let testError: Error | undefined;
	let cleanupError: Error | undefined;

	try {
		await sandbox.ensureRunning();
		await run(sandbox, root);
	} catch (error) {
		testError = error instanceof Error ? error : new Error(String(error));
	}

	try {
		await sandbox.destroy();
		const control = new SubstrateControl(connection, 10_000);
		await vi.waitFor(
			async () => {
				await expect(control.call('GetActor', sandbox.id)).rejects.toMatchObject({ code: 5 });
			},
			{ timeout: 10_000, interval: 100 },
		);
	} catch (error) {
		cleanupError = error instanceof Error ? error : new Error(String(error));
	}

	if (testError && cleanupError)
		throw new AggregateError([testError, cleanupError], 'Substrate test and cleanup failed');
	if (testError) throw testError;
	if (cleanupError) throw cleanupError;
}

describe.skipIf(!enabled)('Substrate sandbox integration', () => {
	beforeAll(() => {
		const required = [
			'SUBSTRATE_API_ENDPOINT',
			'SUBSTRATE_ROUTER_URL',
			'SUBSTRATE_ATESPACE',
			'SUBSTRATE_ACTOR_TEMPLATE',
			'SUBSTRATE_TOKEN_FILE',
			'SUBSTRATE_CA_FILE',
			'SUBSTRATE_ROUTER_CREDENTIAL_FILE',
		];
		const missing = required.filter((name) => !process.env[name]?.trim());
		if (missing.length)
			throw new Error(`Set the required Substrate variables: ${missing.join(', ')}`);
	});
	afterEach(() => vi.restoreAllMocks());
	it('persists workspace files through suspend and router wake', async () => {
		await withSandbox(async (sandbox, path) => {
			await sandbox.writeFile(sandbox.id, path, 'persisted');
			expect((await sandbox.executeCommand('cat', [path])).stdout.trimEnd()).toBe('persisted');

			await sandbox.stop();

			// The router wakes the Actor before forwarding the file request.
			expect((await sandbox.readFile(sandbox.id, path)).toString()).toBe('persisted');
			expect((await sandbox.executeCommand('cat', [path])).stdout.trimEnd()).toBe('persisted');
		});
	}, 120_000);

	it('implements filesystem operations through the router', async () => {
		await withSandbox(async (sandbox, root) => {
			const nested = `${root}/nested`;
			const source = `${nested}/source.bin`;
			const copy = `${nested}/copy.bin`;
			const moved = `${nested}/moved.bin`;
			const data = Buffer.from([0, 1, 2, 255]);

			await sandbox.mkdir(sandbox.id, nested, true);
			await sandbox.writeFile(sandbox.id, source, data);
			await sandbox.appendFile(sandbox.id, source, Buffer.from([3]));
			expect(await sandbox.readFile(sandbox.id, source)).toEqual(Buffer.from([0, 1, 2, 255, 3]));

			await sandbox.copyFile(sandbox.id, { src: source, dest: copy, overwrite: false });
			await sandbox.moveFile(sandbox.id, { src: copy, dest: moved, overwrite: false });
			expect(await sandbox.readFile(sandbox.id, moved)).toEqual(Buffer.from([0, 1, 2, 255, 3]));
			expect(await sandbox.listFiles(sandbox.id, { path: nested })).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ name: 'source.bin', size: 5, isDir: false }),
					expect.objectContaining({ name: 'moved.bin', size: 5, isDir: false }),
				]),
			);
			expect(await sandbox.stat(sandbox.id, moved)).toMatchObject({
				name: 'moved.bin',
				path: moved,
				type: 'file',
				size: 5,
			});

			await sandbox.deleteFile(sandbox.id, moved);
			await sandbox.deleteFile(sandbox.id, root, { recursive: true });
			await sandbox.deleteFile(sandbox.id, root, { force: true, recursive: true });
		});
	}, 120_000);

	it('enforces filesystem overwrite rules and recursively copies directories', async () => {
		await withSandbox(async (sandbox, root) => {
			const source = `${root}/source`;
			const copy = `${root}/copy`;
			const moved = `${root}/moved`;
			const file = `${source}/nested/file.txt`;

			await sandbox.writeFile(sandbox.id, file, 'source');
			await expect(sandbox.writeFile(sandbox.id, file, 'other', false)).rejects.toMatchObject({
				status: 409,
			});
			await sandbox.copyFile(sandbox.id, {
				src: source,
				dest: copy,
				recursive: true,
				overwrite: false,
			});
			expect((await sandbox.readFile(sandbox.id, `${copy}/nested/file.txt`)).toString()).toBe(
				'source',
			);
			await sandbox.moveFile(sandbox.id, { src: copy, dest: moved, overwrite: false });
			expect((await sandbox.readFile(sandbox.id, `${moved}/nested/file.txt`)).toString()).toBe(
				'source',
			);
			await expect(sandbox.readFile(sandbox.id, `${copy}/nested/file.txt`)).rejects.toMatchObject({
				status: 404,
			});
		});
	}, 120_000);

	it('returns command exit state, environment, working directory, and timeout', async () => {
		await withSandbox(async (sandbox, root) => {
			await sandbox.mkdir(sandbox.id, root, true);
			const failed = await sandbox.executeCommand('sh', [
				'-c',
				'printf out; printf err >&2; exit 7',
			]);
			expect(failed).toMatchObject({ exitCode: 7, success: false });
			expect(failed.stdout).toContain('out');
			expect(failed.stderr).toContain('err');

			const configured = await sandbox.executeCommand('sh', ['-c', 'printf "$VALUE:$PWD"'], {
				env: { VALUE: 'configured' },
				cwd: root,
			});
			expect(configured.stdout).toContain(`configured:${root}`);

			const timedOut = await sandbox.executeCommand('sleep', ['1'], { timeout: 100 });
			expect(timedOut).toMatchObject({ success: false, timedOut: true });
		});
	}, 120_000);

	it.skipIf(!connection.egressPolicyFile)(
		'permits the npm registry through the configured default policy',
		async () => {
			await withSandbox(async (sandbox) => {
				const result = await sandbox.executeCommand('curl', [
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
				]);
				expect(result).toMatchObject({ exitCode: 0, success: true });
				expect(result.stdout.trim()).toBe('200');
			});
		},
		120_000,
	);

	it('cancels a running command through the router', async () => {
		await withSandbox(async (sandbox, root) => {
			const abortController = new AbortController();
			await sandbox.mkdir(sandbox.id, root, true);
			await expect(
				sandbox.executeCommand(
					'sh',
					['-c', `printf 'ready\\n'; sleep 2; touch '${root}/cancelled'`],
					{
						abortSignal: abortController.signal,
						onStdout: () => abortController.abort(),
					},
				),
			).rejects.toThrow();
			await new Promise((resolve) => setTimeout(resolve, 2_500));
			await expect(sandbox.stat(sandbox.id, `${root}/cancelled`)).rejects.toMatchObject({
				status: 404,
			});
		});
	}, 120_000);

	it('reuses the same cached adapter after Actor deletion without restoring deleted files', async () => {
		await withSandbox(async (sandbox, root) => {
			await sandbox.writeFile(sandbox.id, root, 'deleted data');
			await new SubstrateControl(connection, 20_000).deleteActor(sandbox.id);
			expect((await sandbox.executeCommand('printf', ['recreated'])).exitCode).toBe(0);
			await expect(sandbox.readFile(sandbox.id, root)).rejects.toMatchObject({ status: 404 });
			await sandbox.writeFile(sandbox.id, root, 'fresh data');
			expect((await sandbox.readFile(sandbox.id, root)).toString()).toBe('fresh data');
		});
	}, 120_000);

	it('recovers concurrent file requests after Actor deletion', async () => {
		await withSandbox(async (sandbox, root) => {
			await new SubstrateControl(connection, 20_000).deleteActor(sandbox.id);
			await Promise.all(
				[1, 2, 3].map(
					async (id) => await sandbox.writeFile(sandbox.id, `${root}/${id}`, String(id)),
				),
			);
			for (const id of [1, 2, 3])
				expect((await sandbox.readFile(sandbox.id, `${root}/${id}`)).toString()).toBe(String(id));
		});
	}, 120_000);
});
