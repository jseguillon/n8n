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
	const completedExecution = () =>
		new Response(
			[
				JSON.stringify({ type: 'started', exec_id: 'fresh-command', seq: 0 }),
				JSON.stringify({
					type: 'exit',
					exit_code: 0,
					success: true,
					execution_time_ms: 1,
					timed_out: false,
					killed: false,
					seq: 1,
				}),
			].join('\n') + '\n',
		);

	it('recreates a deleted Actor through the same cached adapter before retrying a rejected command', async () => {
		const ensureActor = vi.spyOn(SubstrateControl.prototype, 'ensureActor').mockResolvedValue();
		vi.spyOn(SubstrateControl.prototype, 'call').mockRejectedValue(
			Object.assign(new Error('missing Actor'), { code: 5 }),
		);
		let posts = 0;
		const fetch = vi.fn(async (_url: URL, init: RequestInit = {}) => {
			if (init.method === 'POST')
				return ++posts === 1
					? new Response('missing Actor', { status: 404 })
					: completedExecution();
			return new Response('ok');
		});
		vi.stubGlobal('fetch', fetch);
		const sandbox = new SubstrateSandbox(connection);
		sandbox.status = 'running';

		expect((await sandbox.executeCommand('printf', ['ok'])).exitCode).toBe(0);
		expect(posts).toBe(2);
		expect(ensureActor).toHaveBeenCalledOnce();
		expect(sandbox.status).toBe('running');
	});

	it('shares one recreation between concurrent filesystem requests', async () => {
		const ensureActor = vi.spyOn(SubstrateControl.prototype, 'ensureActor').mockResolvedValue();
		vi.spyOn(SubstrateControl.prototype, 'call').mockRejectedValue(
			Object.assign(new Error('missing Actor'), { code: 5 }),
		);
		let writes = 0;
		vi.stubGlobal(
			'fetch',
			vi.fn(async (_url: URL, init: RequestInit = {}) =>
				init.method === 'PUT' && ++writes <= 3
					? new Response('missing Actor', { status: 404 })
					: new Response('ok'),
			),
		);
		const sandbox = new SubstrateSandbox(connection);
		sandbox.status = 'running';

		await Promise.all(
			[1, 2, 3].map(async (id) => await sandbox.writeFile(sandbox.id, `/workspace/${id}`, 'fresh')),
		);
		expect(writes).toBe(6);
		expect(ensureActor).toHaveBeenCalledOnce();
	});

	it('does not recreate an Actor for a missing file', async () => {
		const ensureActor = vi.spyOn(SubstrateControl.prototype, 'ensureActor').mockResolvedValue();
		const probe = vi.spyOn(SubstrateControl.prototype, 'call').mockResolvedValue({});
		const fetch = vi.fn().mockResolvedValue(new Response('missing file', { status: 404 }));
		vi.stubGlobal('fetch', fetch);
		const sandbox = new SubstrateSandbox(connection);
		sandbox.status = 'running';

		await expect(sandbox.readFile(sandbox.id, '/missing')).rejects.toMatchObject({ status: 404 });
		expect(probe).toHaveBeenCalledWith('GetActor', sandbox.id);
		expect(ensureActor).not.toHaveBeenCalled();
		expect(fetch).toHaveBeenCalledOnce();
	});

	it.each([7, 14, 16])(
		'does not recreate when the existence probe fails with gRPC code %i',
		async (code) => {
			const ensureActor = vi.spyOn(SubstrateControl.prototype, 'ensureActor').mockResolvedValue();
			vi.spyOn(SubstrateControl.prototype, 'call').mockRejectedValue(
				Object.assign(new Error('probe failed'), { code }),
			);
			vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not found', { status: 404 })));
			const sandbox = new SubstrateSandbox(connection);
			sandbox.status = 'running';
			await expect(sandbox.readFile(sandbox.id, '/workspace/file')).rejects.toMatchObject({
				status: 404,
			});
			expect(ensureActor).not.toHaveBeenCalled();
		},
	);

	it('bounds recovery to one recreation for a rejected command', async () => {
		const ensureActor = vi.spyOn(SubstrateControl.prototype, 'ensureActor').mockResolvedValue();
		vi.spyOn(SubstrateControl.prototype, 'call').mockRejectedValue(
			Object.assign(new Error('missing Actor'), { code: 5 }),
		);
		let posts = 0;
		vi.stubGlobal(
			'fetch',
			vi.fn(async (_url: URL, init: RequestInit = {}) => {
				if (init.method === 'POST') {
					posts++;
					return new Response('not found', { status: 404 });
				}
				return new Response('ok');
			}),
		);
		const sandbox = new SubstrateSandbox(connection);
		sandbox.status = 'running';
		await expect(sandbox.executeCommand('printf', ['once'])).rejects.toMatchObject({ status: 404 });
		expect(posts).toBe(2);
		expect(ensureActor).toHaveBeenCalledOnce();
	});

	it('never resubmits a started execution when replay returns not found', async () => {
		const ensureActor = vi.spyOn(SubstrateControl.prototype, 'ensureActor').mockResolvedValue();
		const probe = vi
			.spyOn(SubstrateControl.prototype, 'call')
			.mockRejectedValue(Object.assign(new Error('missing Actor'), { code: 5 }));
		let posts = 0;
		vi.stubGlobal(
			'fetch',
			vi.fn(async (_url: URL, init: RequestInit = {}) => {
				if (init.method === 'POST') {
					posts++;
					return new Response('{"type":"started","exec_id":"started-command","seq":0}\n');
				}
				if (init.method === 'DELETE') return new Response('cancelled');
				return new Response('missing execution', { status: 404 });
			}),
		);
		const sandbox = new SubstrateSandbox(connection);
		sandbox.status = 'running';

		await expect(sandbox.executeCommand('touch', ['/workspace/once'])).rejects.toMatchObject({
			status: 404,
		});
		expect(posts).toBe(1);
		expect(ensureActor).not.toHaveBeenCalled();
		expect(probe).not.toHaveBeenCalled();
	});

	it('does not recreate after an ambiguous submission followed by a not-found response', async () => {
		const ensureActor = vi.spyOn(SubstrateControl.prototype, 'ensureActor').mockResolvedValue();
		const probe = vi
			.spyOn(SubstrateControl.prototype, 'call')
			.mockRejectedValue(Object.assign(new Error('missing Actor'), { code: 5 }));
		const ids: string[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (_url: URL, init: RequestInit = {}) => {
				if (init.method === 'POST') {
					if (typeof init.body !== 'string') throw new Error('Expected a JSON command body');
					const body = JSON.parse(init.body) as { exec_id: string };
					ids.push(body.exec_id);
					return new Response('unavailable', { status: ids.length === 1 ? 503 : 404 });
				}
				return new Response('ok');
			}),
		);
		const sandbox = new SubstrateSandbox(connection);
		sandbox.status = 'running';
		await expect(sandbox.executeCommand('touch', ['/workspace/once'])).rejects.toMatchObject({
			status: 404,
		});
		expect(ids).toHaveLength(2);
		expect(ids[0]).toBe(ids[1]);
		expect(ensureActor).not.toHaveBeenCalled();
		expect(probe).not.toHaveBeenCalled();
	});

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
		sandbox.status = 'running';
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
		sandbox.status = 'running';
		const signal = AbortSignal.timeout(1_000);

		await sandbox.readFile(sandbox.id, '/home/user/check.txt', signal);

		const forwarded = fetch.mock.calls[0]?.[1].signal;
		expect(forwarded).toBeInstanceOf(AbortSignal);
		expect(forwarded.aborted).toBe(false);
	});

	it('records one operation around each file request', async () => {
		const fetch = vi.fn().mockResolvedValue(new Response('ok'));
		const onOperation = vi.fn().mockResolvedValue(true);
		vi.stubGlobal('fetch', fetch);
		const sandbox = new SubstrateSandbox({ ...connection, id: 'test-actor', onOperation });
		sandbox.status = 'running';

		await sandbox.readFile(sandbox.id, '/home/user/check.txt');

		expect(onOperation).toHaveBeenCalledTimes(2);
		const operationId = onOperation.mock.calls[0]?.[1];
		expect(onOperation).toHaveBeenNthCalledWith(
			1,
			'n8n-test-actor',
			operationId,
			'started',
			300_000,
			expect.any(AbortSignal),
		);
		expect(onOperation).toHaveBeenNthCalledWith(
			2,
			'n8n-test-actor',
			operationId,
			'finished',
			300_000,
		);
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
		const fetch = vi.fn().mockResolvedValueOnce(new Response(executionStream));
		vi.stubGlobal('fetch', fetch);
		const onOperation = vi.fn().mockResolvedValue(true);
		onOperation.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
		const sandbox = new SubstrateSandbox({ ...connection, onOperation });
		sandbox.status = 'running';

		const execution = sandbox.executeCommand('sleep', ['600'], { timeout: 600_000 });
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
		const actorId = onOperation.mock.calls[0]?.[0];
		const operationId = onOperation.mock.calls[0]?.[1];
		expect(actorId).toMatch(/^n8n-/);
		expect(onOperation).toHaveBeenNthCalledWith(
			1,
			actorId,
			operationId,
			'started',
			600_000,
			expect.any(AbortSignal),
		);
		expect(onOperation).toHaveBeenNthCalledWith(
			2,
			actorId,
			operationId,
			'started',
			600_000,
			expect.any(AbortSignal),
		);
		expect(onOperation.mock.calls.some(([, , phase]) => phase === 'finished')).toBe(false);

		finishExecution();
		expect(await execution).toMatchObject({ success: true, exitCode: 0 });
		expect(onOperation).toHaveBeenLastCalledWith(actorId, operationId, 'finished', 600_000);
	});

	it('holds the file operation lease until the entire response body is consumed', async () => {
		let complete!: () => void;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('first'));
				complete = () => {
					controller.enqueue(new TextEncoder().encode('last'));
					controller.close();
				};
			},
		});
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body)));
		const onOperation = vi.fn().mockResolvedValue(true);
		const sandbox = new SubstrateSandbox({ ...connection, onOperation });
		sandbox.status = 'running';
		const read = sandbox.readFile(sandbox.id, '/workspace/file');
		await vi.waitFor(() => expect(onOperation).toHaveBeenCalledOnce());
		expect(onOperation.mock.calls[0]?.[2]).toBe('started');
		complete();
		expect((await read).toString()).toBe('firstlast');
		expect(onOperation.mock.calls.map(([, , phase]) => phase)).toEqual(['started', 'finished']);
	});

	it('still sends remote cancellation when lifecycle bookkeeping fails', async () => {
		const controller = new AbortController();
		const onOperation = vi
			.fn()
			.mockResolvedValueOnce(true)
			.mockRejectedValue(new Error('bookkeeping unavailable'));
		const fetch = vi
			.fn()
			.mockImplementationOnce(async () => {
				controller.abort();
				throw new DOMException('Cancelled', 'AbortError');
			})
			.mockResolvedValue(new Response('cancelled'));
		vi.stubGlobal('fetch', fetch);
		const sandbox = new SubstrateSandbox({ ...connection, onOperation });
		sandbox.status = 'running';

		await expect(
			sandbox.executeCommand('sleep', ['30'], { abortSignal: controller.signal }),
		).rejects.toThrow('Cancelled');
		expect(fetch.mock.calls.map(([, options]) => options.method)).toEqual(['POST', 'DELETE']);
		expect(fetch.mock.calls[1]?.[1].signal.aborted).toBe(false);
		expect(onOperation.mock.calls.map(([, , phase]) => phase)).toEqual(['started', 'finished']);
	});

	it('releases a failed file operation without masking its router error', async () => {
		const onOperation = vi
			.fn()
			.mockResolvedValueOnce(true)
			.mockRejectedValue(new Error('bookkeeping unavailable'));
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('unavailable', { status: 503 })));
		const sandbox = new SubstrateSandbox({ ...connection, onOperation });
		sandbox.status = 'running';

		await expect(sandbox.writeFile(sandbox.id, '/workspace/file', 'data')).rejects.toMatchObject({
			status: 503,
		});
		expect(onOperation.mock.calls.map(([, , phase]) => phase)).toEqual(['started', 'finished']);
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
		sandbox.status = 'running';

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
