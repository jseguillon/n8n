import { status } from '@grpc/grpc-js';

import { SubstrateControl } from '../workspace/sandbox/substrate-control';

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
