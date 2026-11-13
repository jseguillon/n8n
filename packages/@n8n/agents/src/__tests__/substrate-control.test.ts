import { status } from '@grpc/grpc-js';
import { readFile } from 'node:fs/promises';

import { SubstrateControl } from '../workspace/sandbox/substrate-control';

vi.mock('node:fs/promises', () => ({ readFile: vi.fn() }));

const connection = {
	endpoint: 'localhost:18443',
	routerUrl: 'http://localhost:18000',
	atespace: 'test-space',
	template: 'test-template',
	tokenFile: '/run/substrate/token',
	caFile: '/run/substrate/ca.crt',
	serverName: 'api.ate-system.svc',
};

describe('SubstrateControl', () => {
	beforeEach(() => {
		vi.mocked(readFile).mockReset();
	});
	it('resumes an Actor after an idempotent create and matching template check', async () => {
		const control = new SubstrateControl(connection, 60_000);
		const alreadyExists = Object.assign(new Error('Actor already exists'), {
			code: status.ALREADY_EXISTS,
		});
		const call = vi.spyOn(control, 'call').mockImplementation(async (method) => {
			if (method === 'CreateActor') throw alreadyExists;
			if (method === 'GetActor') {
				return {
					metadata: { atespace: 'test-space', name: 'n8n-workspace' },
					actorTemplate: { atespace: 'test-space', name: 'test-template' },
				};
			}
			return undefined;
		});

		await control.ensureActor('n8n-workspace');

		expect(call.mock.calls.map(([method]) => method)).toEqual([
			'CreateActor',
			'GetActor',
			'ResumeActor',
		]);
	});

	it.each([
		{
			rules: [
				{ tlsPassthrough: { hostnames: ['packages.example.test'], ports: { numbers: [8443] } } },
			],
		},
		{
			rules: [
				{ http: { hostnames: ['*'], ports: { numbers: [80] } } },
				{ tlsPassthrough: { hostnames: ['*'], ports: { all: {} } } },
			],
		},
	])('copies administrator-defined rules before resuming an Actor: %j', async (policy) => {
		vi.mocked(readFile).mockResolvedValue(JSON.stringify(policy));
		const control = new SubstrateControl(
			{ ...connection, egressPolicyFile: '/run/config/egress.json' },
			60_000,
		);
		const call = vi.spyOn(control, 'call').mockImplementation(async (method) => {
			if (method === 'GetActor')
				return {
					metadata: { atespace: 'test-space', name: 'n8n-workspace' },
					actorTemplate: { atespace: 'test-space', name: 'test-template' },
				};
			return undefined;
		});
		await control.ensureActor('n8n-workspace');
		expect(readFile).toHaveBeenCalledWith('/run/config/egress.json', 'utf8');
		expect(call.mock.calls.map(([method]) => method)).toEqual([
			'CreateActor',
			'GetActor',
			'CreateActorEgressPolicy',
			'ResumeActor',
		]);
		expect(call).toHaveBeenCalledWith('CreateActorEgressPolicy', 'n8n-workspace', policy);
	});

	it('leaves an existing Actor policy unchanged', async () => {
		vi.mocked(readFile).mockResolvedValue(JSON.stringify({ rules: [] }));
		const control = new SubstrateControl(
			{ ...connection, egressPolicyFile: '/run/config/egress.json' },
			60_000,
		);
		const call = vi.spyOn(control, 'call').mockImplementation(async (method) => {
			if (method === 'GetActor')
				return {
					metadata: { atespace: 'test-space', name: 'n8n-workspace' },
					actorTemplate: { atespace: 'test-space', name: 'test-template' },
				};
			if (method === 'CreateActorEgressPolicy')
				throw Object.assign(new Error('policy exists'), { code: status.ALREADY_EXISTS });
			return undefined;
		});
		await control.ensureActor('n8n-workspace');
		expect(call).toHaveBeenLastCalledWith('ResumeActor', 'n8n-workspace');
		expect(call.mock.calls.map(([method]) => method)).toEqual([
			'CreateActor',
			'GetActor',
			'CreateActorEgressPolicy',
			'ResumeActor',
		]);
	});

	it.each([
		'invalid JSON',
		JSON.stringify({ rules: [{ http: { hostnames: ['example.test'] } }] }),
		JSON.stringify({
			rules: [{ tlsPassthrough: { hostnames: ['example.test'], ports: { numbers: [0] } } }],
		}),
		JSON.stringify({ rules: [], unexpected: 'not supported' }),
		JSON.stringify({
			rules: [{ tlsPassthrough: { hostnames: ['*'], ports: { numbers: [443], all: {} } } }],
		}),
		JSON.stringify({ rules: [{ http: { hostnames: ['*'], ports: { all: { enabled: true } } } }] }),
		JSON.stringify({
			rules: [{ http: { hostnames: ['*'], ports: { numbers: [80] }, effects: {} } }],
		}),
	])(
		'rejects invalid or unsupported configured rules before creating an Actor: %s',
		async (contents) => {
			vi.mocked(readFile).mockResolvedValue(contents);
			const control = new SubstrateControl(
				{ ...connection, egressPolicyFile: '/run/config/egress.json' },
				60_000,
			);
			const call = vi.spyOn(control, 'call');
			await expect(control.ensureActor('n8n-workspace')).rejects.toThrow(
				'egress policy file is invalid',
			);
			expect(call).not.toHaveBeenCalled();
		},
	);

	it('reports an unreadable policy without returning its private path', async () => {
		vi.mocked(readFile).mockRejectedValue(new Error('cannot read /private/config/egress.json'));
		const control = new SubstrateControl(
			{ ...connection, egressPolicyFile: '/private/config/egress.json' },
			60_000,
		);
		const call = vi.spyOn(control, 'call');
		await expect(control.ensureActor('n8n-workspace')).rejects.toThrow(
			'The server Substrate egress policy file could not be read',
		);
		expect(call).not.toHaveBeenCalled();
	});

	it('does not resume an Actor with a different template', async () => {
		const control = new SubstrateControl(connection, 60_000);
		const call = vi.spyOn(control, 'call').mockResolvedValue({
			metadata: { atespace: 'test-space', name: 'n8n-workspace' },
			actorTemplate: { atespace: 'test-space', name: 'other-template' },
		});

		await expect(control.ensureActor('n8n-workspace')).rejects.toThrow(
			'The existing Actor uses a different Substrate template',
		);
		expect(call).toHaveBeenCalledTimes(2);
		expect(call).not.toHaveBeenCalledWith('ResumeActor', 'n8n-workspace');
	});

	it('ignores a missing Actor during deletion', async () => {
		const control = new SubstrateControl(connection, 60_000);
		vi.spyOn(control, 'call').mockRejectedValue(
			Object.assign(new Error('Actor not found'), { code: status.NOT_FOUND }),
		);

		await expect(control.deleteActor('n8n-workspace')).resolves.toBeUndefined();
	});
});
