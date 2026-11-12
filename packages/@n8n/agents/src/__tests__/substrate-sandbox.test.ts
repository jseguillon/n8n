import { afterEach, describe, expect, it, vi } from 'vitest';
import { SandboxServiceError } from '@n8n/sandbox-client';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

	it('clears persisted activity after deleting an Actor', async () => {
		const deleteActor = vi.spyOn(SubstrateControl.prototype, 'deleteActor').mockResolvedValue();
		const onDestroyed = vi.fn().mockResolvedValue(undefined);
		const sandbox = new SubstrateSandbox({ ...connection, id: 'test-actor', onDestroyed });

		await sandbox.destroy();

		expect(deleteActor).toHaveBeenCalledWith('n8n-test-actor');
		expect(onDestroyed).toHaveBeenCalledWith('n8n-test-actor');
	});

	it('maps daemon file metadata to the shared filesystem contract', async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(
				Response.json([
					{
						name: 'check.txt',
						size: 4,
						is_dir: false,
						type: 'file',
						mod_time: '2026-10-20T01:00:00Z',
					},
				]),
			)
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
			{
				name: 'check.txt',
				size: 4,
				type: 'file',
				isDir: false,
				modTime: '2026-10-20T01:00:00Z',
			},
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

	it('records Actor activity before and after router requests', async () => {
		const fetch = vi.fn().mockResolvedValue(new Response('ok'));
		const onActivity = vi.fn().mockResolvedValue(undefined);
		vi.stubGlobal('fetch', fetch);
		const sandbox = new SubstrateSandbox({ ...connection, id: 'test-actor', onActivity });

		await sandbox.readFile(sandbox.id, '/home/user/check.txt');

		expect(onActivity).toHaveBeenCalledTimes(2);
		expect(onActivity).toHaveBeenNthCalledWith(1, 'n8n-test-actor');
		expect(onActivity).toHaveBeenNthCalledWith(2, 'n8n-test-actor');
	});

	it('keeps command activity open until the execution stream exits', async () => {
		vi.spyOn(SubstrateControl.prototype, 'ensureActor').mockResolvedValue();
		const encoder = new TextEncoder();
		let finishExecution!: () => void;
		const executionFinished = new Promise<void>((resolve) => {
			finishExecution = resolve;
		});
		const executionStream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode('{"type":"started","exec_id":"exec-1"}\n'));
				void executionFinished.then(() => {
					controller.enqueue(
						encoder.encode(
							'{"type":"exit","exit_code":0,"success":true,"execution_time_ms":10,"timed_out":false,"killed":false}\n',
						),
					);
					controller.close();
				});
			},
		});
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(new Response('ok'))
			.mockResolvedValueOnce(new Response(executionStream));
		vi.stubGlobal('fetch', fetch);
		const onCommandActivity = vi.fn().mockResolvedValue(true);
		onCommandActivity.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
		const sandbox = new SubstrateSandbox({ ...connection, onCommandActivity });

		const execution = sandbox.executeCommand('sleep', ['600'], { timeout: 600_000 });
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
		const actorId = onCommandActivity.mock.calls[0]?.[0];
		expect(actorId).toMatch(/^n8n-/);
		expect(onCommandActivity).toHaveBeenNthCalledWith(1, actorId, 'started', 600_000, undefined);
		expect(onCommandActivity).toHaveBeenNthCalledWith(2, actorId, 'started', 600_000, undefined);
		expect(onCommandActivity.mock.calls.some(([, phase]) => phase === 'finished')).toBe(false);

		finishExecution();
		expect(await execution).toMatchObject({ success: true, exitCode: 0 });
		expect(onCommandActivity).toHaveBeenLastCalledWith(actorId, 'finished', 600_000);
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

	it('uses the server PodIdentity bundle for HTTPS router requests', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'n8n-substrate-router-'));
		try {
			const caFile = join(directory, 'ca.pem');
			const routerCredentialFile = join(directory, 'router-credential-bundle.pem');
			await writeFile(caFile, 'test-ca');
			await writeFile(routerCredentialFile, 'test-router-credential');
			const fetch = vi.fn().mockResolvedValue(new Response('ok'));
			vi.stubGlobal('fetch', fetch);
			vi.spyOn(SubstrateControl.prototype, 'deleteActor').mockResolvedValue();
			const sandbox = new SubstrateSandbox({
				...connection,
				routerUrl: 'https://router.example.test',
				caFile,
				routerCredentialFile,
			});

			const request = (
				sandbox as unknown as {
					request: (path: string) => Promise<Response>;
				}
			).request.bind(sandbox);

			await request('/healthz');
			expect(fetch.mock.calls[0][1]).toHaveProperty('dispatcher');
			const initialDispatcher = (fetch.mock.calls[0][1] as RequestInit & { dispatcher: unknown })
				.dispatcher;
			await writeFile(routerCredentialFile, 'rotated-router-credential');
			await request('/healthz');
			const rotatedDispatcher = (fetch.mock.calls[1][1] as RequestInit & { dispatcher: unknown })
				.dispatcher;
			expect(rotatedDispatcher).not.toBe(initialDispatcher);
			await sandbox.destroy();
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it('requires a router client certificate for HTTPS', async () => {
		const fetch = vi.fn();
		vi.stubGlobal('fetch', fetch);
		const sandbox = new SubstrateSandbox({
			...connection,
			routerUrl: 'https://router.example.test',
		});

		await expect(
			(
				sandbox as unknown as {
					request: (path: string) => Promise<Response>;
				}
			).request('/healthz'),
		).rejects.toThrow('router client certificate file is required');
		expect(fetch).not.toHaveBeenCalled();
	});

	it('reads split execution events and resumes incomplete streams', async () => {
		vi.spyOn(SubstrateControl.prototype, 'ensureActor').mockResolvedValue();
		const encoder = new TextEncoder();
		const stdout = vi.fn();
		const stderr = vi.fn();
		const events = [
			{ type: 'started', exec_id: 'exec-1' },
			{ type: 'stdout', data: 'ok' },
			{ type: 'stderr', data: 'warning' },
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
			.mockImplementationOnce(async (_url, init) => {
				const postBody = JSON.parse(String(init?.body)) as { exec_id: string };
				return new Response(
					`{"seq":0,"type":"started","exec_id":"${postBody.exec_id}"}\n` +
						'{"seq":1,"type":"stdout","data":"par',
				);
			})
			.mockResolvedValueOnce(
				new Response(
					'{"seq":1,"type":"stdout","data":"partial"}\n' +
						'{"seq":2,"type":"exit","exit_code":0,"success":true,"execution_time_ms":1,"timed_out":false,"killed":false}\n',
				),
			);
		vi.stubGlobal('fetch', fetch);
		const sandbox = new SubstrateSandbox(connection);
		expect(
			await sandbox.executeCommand('printf', ['ok'], { onStdout: stdout, onStderr: stderr }),
		).toMatchObject({ stdout: 'ok', stderr: 'warning', exitCode: 0 });
		expect(stdout).toHaveBeenCalledWith('ok');
		expect(stderr).toHaveBeenCalledWith('warning');
		await expect(sandbox.executeCommand('printf', ['partial'])).resolves.toMatchObject({
			success: true,
			stdout: 'partial',
			exitCode: 0,
		});
		const postBody = JSON.parse(String(fetch.mock.calls[2][1]?.body)) as { exec_id: string };
		expect(fetch.mock.calls[3][0].pathname).toBe(`/executions/${postBody.exec_id}`);
		expect(fetch.mock.calls[3][0].searchParams.get('after')).toBe('0');
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

	it('resumes a started execution when its event stream disconnects', async () => {
		vi.spyOn(SubstrateControl.prototype, 'ensureActor').mockResolvedValue();
		const encoder = new TextEncoder();
		let started = false;
		let execId = '';
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(new Response('ok'))
			.mockImplementationOnce(async (_url, init) => {
				execId = (JSON.parse(String(init?.body)) as { exec_id: string }).exec_id;
				return new Response(
					new ReadableStream({
						pull(controller) {
							if (!started) {
								started = true;
								controller.enqueue(
									encoder.encode(`{"seq":0,"type":"started","exec_id":"${execId}"}\n`),
								);
								return;
							}
							controller.error(new TypeError('terminated'));
						},
					}),
				);
			})
			.mockResolvedValueOnce(
				new Response(
					'{"seq":1,"type":"exit","exit_code":0,"success":true,"execution_time_ms":10,"timed_out":false,"killed":false}\n',
				),
			);
		vi.stubGlobal('fetch', fetch);
		const sandbox = new SubstrateSandbox(connection);

		expect(await sandbox.executeCommand('sleep', ['600'])).toMatchObject({
			success: true,
			exitCode: 0,
		});

		expect(fetch.mock.calls[2][0].pathname).toBe(`/executions/${execId}`);
		expect(fetch.mock.calls[2][0].searchParams.get('after')).toBe('0');
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
