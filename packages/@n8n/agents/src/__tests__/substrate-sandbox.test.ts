import { afterEach, describe, expect, it, vi } from 'vitest';
import { SandboxServiceError } from '@n8n/sandbox-client';

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
		expect(new Headers(fetch.mock.calls[0][1].headers).get('ate-target-actor')).toBe(
			`test-space/${sandbox.id}`,
		);
	});

	it('forwards file operation cancellation to the router', async () => {
		const fetch = vi.fn().mockResolvedValue(new Response('ok'));
		vi.stubGlobal('fetch', fetch);
		const sandbox = new SubstrateSandbox(connection);
		const signal = AbortSignal.timeout(1_000);

		await sandbox.readFile(sandbox.id, '/home/user/check.txt', signal);

		expect(fetch).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({ signal }));
	});

	it('does not allow request headers to override the target Actor', async () => {
		const fetch = vi.fn().mockResolvedValue(new Response('ok'));
		vi.stubGlobal('fetch', fetch);
		const sandbox = new SubstrateSandbox(connection);

		await (
			sandbox as unknown as {
				request: (path: string, init: RequestInit) => Promise<Response>;
			}
		).request('/healthz', { headers: { 'ate-target-actor': 'other-space/other-actor' } });

		expect(new Headers(fetch.mock.calls[0][1].headers).get('ate-target-actor')).toBe(
			`test-space/${sandbox.id}`,
		);
	});

	it('reports router errors without following redirects', async () => {
		const fetch = vi.fn().mockResolvedValue(new Response('unavailable', { status: 503 }));
		vi.stubGlobal('fetch', fetch);
		const sandbox = new SubstrateSandbox(connection);

		await expect(sandbox.readFile(sandbox.id, '/home/user/check.txt')).rejects.toEqual(
			expect.objectContaining({
				constructor: SandboxServiceError,
				status: 503,
			}),
		);
		expect(fetch).toHaveBeenCalledWith(
			expect.any(URL),
			expect.objectContaining({ redirect: 'error' }),
		);
	});

	it('reads split execution events and rejects incomplete streams', async () => {
		vi.spyOn(SubstrateControl.prototype, 'ensureActor').mockResolvedValue();
		const encoder = new TextEncoder();
		const stdout = vi.fn();
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
		expect(await sandbox.executeCommand('printf', ['ok'], { onStdout: stdout })).toMatchObject({
			stdout: 'ok',
			exitCode: 0,
		});
		expect(stdout).toHaveBeenCalledWith('ok');
		await expect(sandbox.executeCommand('printf', ['partial'])).rejects.toThrow(
			'without an exit event',
		);
	});

	it('rejects malformed execution events after cancelling a started execution', async () => {
		vi.spyOn(SubstrateControl.prototype, 'ensureActor').mockResolvedValue();
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(new Response('ok'))
			.mockResolvedValueOnce(new Response('{"type":"started","exec_id":"exec-1"}\nnot-json\n'))
			.mockResolvedValueOnce(new Response('ok'));
		vi.stubGlobal('fetch', fetch);
		const sandbox = new SubstrateSandbox(connection);

		await expect(sandbox.executeCommand('false')).rejects.toThrow();

		expect(fetch.mock.calls[2][0].pathname).toBe('/executions/exec-1');
		expect(fetch.mock.calls[2][1]).toMatchObject({ method: 'DELETE' });
	});

	it('rejects oversized execution events before parsing them', async () => {
		vi.spyOn(SubstrateControl.prototype, 'ensureActor').mockResolvedValue();
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(new Response('ok'))
			.mockResolvedValueOnce(
				new Response(`{"type":"stdout","data":"${'x'.repeat(1024 * 1024)}"}\n`),
			);
		vi.stubGlobal('fetch', fetch);
		const sandbox = new SubstrateSandbox(connection);

		await expect(sandbox.executeCommand('printf', ['too-large'])).rejects.toThrow(
			'event exceeded the 1 MiB limit',
		);
	});

	it('cancels a started execution when its stream fails', async () => {
		vi.spyOn(SubstrateControl.prototype, 'ensureActor').mockResolvedValue();
		const encoder = new TextEncoder();
		let started = false;
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(new Response('ok'))
			.mockResolvedValueOnce(
				new Response(
					new ReadableStream({
						pull(controller) {
							if (!started) {
								started = true;
								controller.enqueue(encoder.encode('{"type":"started","exec_id":"exec-1"}\n'));
								return;
							}
							controller.error(new Error('stream failed'));
						},
					}),
				),
			)
			.mockResolvedValueOnce(new Response('ok'));
		vi.stubGlobal('fetch', fetch);
		const sandbox = new SubstrateSandbox(connection);

		await expect(sandbox.executeCommand('sleep', ['10'])).rejects.toThrow('stream failed');

		expect(fetch.mock.calls[2][0].pathname).toBe('/executions/exec-1');
		expect(fetch.mock.calls[2][1]).toMatchObject({ method: 'DELETE' });
	});

	it('reports daemon execution errors and cancels the execution', async () => {
		vi.spyOn(SubstrateControl.prototype, 'ensureActor').mockResolvedValue();
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(new Response('ok'))
			.mockResolvedValueOnce(
				new Response('{"type":"started","exec_id":"exec-1"}\n{"type":"error","error":"failed"}\n'),
			)
			.mockResolvedValueOnce(new Response('ok'));
		vi.stubGlobal('fetch', fetch);
		const sandbox = new SubstrateSandbox(connection);

		await expect(sandbox.executeCommand('false')).rejects.toThrow('failed');

		expect(fetch.mock.calls[2][0].pathname).toBe('/executions/exec-1');
	});

	it('rejects cumulative execution output above 10 MiB', async () => {
		vi.spyOn(SubstrateControl.prototype, 'ensureActor').mockResolvedValue();
		const data = 'x'.repeat(1024 * 1024 - 100);
		const events = Array.from({ length: 11 }, () => JSON.stringify({ type: 'stdout', data })).join(
			'\n',
		);
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(new Response('ok'))
			.mockResolvedValueOnce(new Response(`{"type":"started","exec_id":"exec-1"}\n${events}\n`))
			.mockResolvedValueOnce(new Response('ok'));
		vi.stubGlobal('fetch', fetch);
		const sandbox = new SubstrateSandbox(connection);

		await expect(sandbox.executeCommand('yes')).rejects.toThrow('output exceeded the 10 MiB limit');
	});
});
