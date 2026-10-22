import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { SubstrateSandbox } from '../../workspace/sandbox/substrate-sandbox';

const connection = {
	endpoint: process.env.SUBSTRATE_API_ENDPOINT ?? '',
	routerUrl: process.env.SUBSTRATE_ROUTER_URL ?? '',
	atespace: process.env.SUBSTRATE_ATESPACE ?? '',
	template: process.env.SUBSTRATE_ACTOR_TEMPLATE ?? '',
	tokenFile: process.env.SUBSTRATE_TOKEN_FILE ?? '',
	caFile: process.env.SUBSTRATE_CA_FILE ?? '',
	serverName: process.env.SUBSTRATE_SERVER_NAME ?? 'api.ate-system.svc',
};

const enabled =
	process.env.SUBSTRATE_INTEGRATION_TEST === '1' && Object.values(connection).every(Boolean);

async function withSandbox(run: (sandbox: SubstrateSandbox, root: string) => Promise<void>) {
	const id = `n8n-test-${randomUUID()}`;
	const root = `/home/user/workspace/.n8n-substrate-${id}`;
	const sandbox = new SubstrateSandbox({ ...connection, id, timeout: 20_000 });
	let testError: Error | undefined;
	let cleanupError: Error | undefined;

	try {
		await sandbox.start();
		await run(sandbox, root);
	} catch (error) {
		testError = error instanceof Error ? error : new Error(String(error));
	}

	try {
		await sandbox.destroy();
	} catch (error) {
		cleanupError = error instanceof Error ? error : new Error(String(error));
	}

	if (testError && cleanupError)
		throw new AggregateError([testError, cleanupError], 'Substrate test and cleanup failed');
	if (testError) throw testError;
	if (cleanupError) throw cleanupError;
}

describe.skipIf(!enabled)('Substrate sandbox integration', () => {
	it('persists workspace files through suspend and router wake', async () => {
		await withSandbox(async (sandbox, path) => {
			await sandbox.writeFile(sandbox.id, path, 'persisted');
			expect((await sandbox.executeCommand('cat', [path])).stdout).toBe('persisted\n');

			await sandbox.stop();

			// The router wakes the Actor before forwarding the file request.
			expect((await sandbox.readFile(sandbox.id, path)).toString()).toBe('persisted');
			expect((await sandbox.executeCommand('cat', [path])).stdout).toBe('persisted\n');
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
					{ name: 'source.bin', size: 5, isDir: false },
					{ name: 'moved.bin', size: 5, isDir: false },
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

	it('cancels a running command through the router', async () => {
		await withSandbox(async (sandbox) => {
			const abortController = new AbortController();
			const abort = setTimeout(() => abortController.abort(), 250);

			try {
				await expect(
					sandbox.executeCommand('sleep', ['10'], { abortSignal: abortController.signal }),
				).rejects.toThrow();
			} finally {
				clearTimeout(abort);
			}
		});
	}, 120_000);
});
