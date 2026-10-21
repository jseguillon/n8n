import { afterEach, describe, expect, it, vi } from 'vitest';

import { SubstrateControl } from '../workspace/sandbox/substrate-control';
import { SubstrateSandbox } from '../workspace/sandbox/substrate-sandbox';

const connection = {
	endpoint: 'localhost:18443',
	routerUrl: 'http://localhost:18000',
	atespace: 'test-space',
	template: 'test-template',
	tokenFile: '/run/substrate/token',
	caFile: '/run/substrate/ca.crt',
	serverName: 'api.ate-system.svc',
};

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe('Substrate sandbox daemon protocol', () => {
	it('suspends persistent Actors and deletes ephemeral Actors on stop', async () => {
		const controlCall = vi.spyOn(SubstrateControl.prototype, 'call').mockResolvedValue(undefined);
		const deleteActor = vi.spyOn(SubstrateControl.prototype, 'deleteActor').mockResolvedValue();
		const persistent = new SubstrateSandbox(connection);
		const ephemeral = new SubstrateSandbox({ ...connection, ephemeral: true });

		await persistent.stop();
		await ephemeral.stop();

		expect(controlCall).toHaveBeenCalledWith('SuspendActor', persistent.id);
		expect(deleteActor).toHaveBeenCalledWith(ephemeral.id);
	});

	it('maps daemon file metadata to the shared filesystem contract', async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(Response.json([{ name: 'check.txt', size: 4, is_dir: false }]))
			.mockResolvedValueOnce(
				Response.json({
					name: 'check.txt',
					path: '/home/user/check.txt',
					type: 'file',
					size: 4,
					created_at: '2026-10-20T00:00:00Z',
					modified_at: '2026-10-20T01:00:00Z',
				}),
			);
		vi.stubGlobal('fetch', fetch);
		const sandbox = new SubstrateSandbox(connection);
		expect(await sandbox.listFiles(sandbox.id, { path: '/home/user' })).toEqual([
			{ name: 'check.txt', size: 4, isDir: false },
		]);
		expect(await sandbox.stat(sandbox.id, '/home/user/check.txt')).toMatchObject({
			createdAt: '2026-10-20T00:00:00Z',
			modifiedAt: '2026-10-20T01:00:00Z',
		});
		expect(fetch.mock.calls[0][0].searchParams.get('path')).toBe('/home/user');
		expect(fetch.mock.calls[0][1].headers['ate-target-actor']).toBe(`test-space/${sandbox.id}`);
	});

	it('reads split execution events and rejects incomplete streams', async () => {
		vi.spyOn(SubstrateControl.prototype, 'ensureActor').mockResolvedValue();
		const encoder = new TextEncoder();
		const events = [
			{ type: 'started', exec_id: 'exec-1' },
			{ type: 'stdout', data: 'ok' },
			{
				type: 'exit',
				exit_code: 0,
				success: true,
				execution_time_ms: 1,
				timed_out: false,
				killed: false,
			},
		]
			.map((event) => JSON.stringify(event))
			.join('\n');
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(new Response('ok'))
			.mockResolvedValueOnce(
				new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(encoder.encode(events.slice(0, 20)));
							controller.enqueue(encoder.encode(events.slice(20)));
							controller.close();
						},
					}),
				),
			)
			.mockResolvedValueOnce(new Response('{"type":"stdout","data":"partial"}\n'));
		vi.stubGlobal('fetch', fetch);
		const sandbox = new SubstrateSandbox(connection);
		expect(await sandbox.executeCommand('printf', ['ok'])).toMatchObject({
			stdout: 'ok',
			exitCode: 0,
		});
		await expect(sandbox.executeCommand('printf', ['partial'])).rejects.toThrow(
			'without an exit event',
		);
	});
});
