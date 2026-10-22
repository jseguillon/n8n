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

describe.skipIf(!enabled)('Substrate sandbox integration', () => {
	it('persists workspace files through suspend and router wake', async () => {
		const id = `n8n-test-${randomUUID()}`;
		const path = `/home/user/workspace/.n8n-substrate-${id}`;
		const sandbox = new SubstrateSandbox({ ...connection, id, timeout: 20_000 });
		let testError: Error | undefined;
		let cleanupError: Error | undefined;

		try {
			await sandbox.start();
			await sandbox.writeFile(sandbox.id, path, 'persisted');
			expect((await sandbox.executeCommand('cat', [path])).stdout).toBe('persisted\n');

			await sandbox.stop();

			// The router wakes the Actor before forwarding the file request.
			expect((await sandbox.readFile(sandbox.id, path)).toString()).toBe('persisted');
			expect((await sandbox.executeCommand('cat', [path])).stdout).toBe('persisted\n');
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
	}, 120_000);
});
