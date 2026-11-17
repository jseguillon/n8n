import { createSandbox } from '@n8n/agents/sandbox';
import type { SubstrateSandboxConfig, WorkspaceSandbox } from '@n8n/agents/sandbox';
import type { Logger } from '@n8n/backend-common';
import type { SubstrateActorActivityRepository } from '@n8n/db';
import { mock } from 'vitest-mock-extended';

import type { SandboxSettingsService } from '../sandbox-settings.service';
import { SubstrateActorLifecycleService } from '../substrate-actor-lifecycle.service';

vi.mock('@n8n/agents/sandbox', async (original) => ({
	...(await original<typeof import('@n8n/agents/sandbox')>()),
	createSandbox: vi.fn(),
}));

const connection: SubstrateSandboxConfig['connection'] = {
	endpoint: 'api.example:443',
	routerUrl: 'https://router.example',
	atespace: 'test',
	template: 'sandbox',
	tokenFile: '/run/test/token',
	caFile: '/run/test/ca',
	serverName: 'api.example',
};
const policy = { autoStopMinutes: 5, autoDeleteMinutes: 60, ephemeral: false };

describe('Substrate Actor coordinator', () => {
	const repository = mock<SubstrateActorActivityRepository>();
	const settings = mock<SandboxSettingsService>();
	const logger = mock<Logger>();
	const sandbox = mock<WorkspaceSandbox & Required<Pick<WorkspaceSandbox, 'stop' | 'destroy'>>>();
	let service: SubstrateActorLifecycleService;
	const now = new Date('2026-11-12T12:00:00Z');

	beforeEach(() => {
		vi.resetAllMocks();
		vi.useFakeTimers();
		vi.setSystemTime(now);
		repository.startOperation.mockResolvedValue(true);
		repository.finishOperation.mockResolvedValue(now);
		repository.releaseClaim.mockResolvedValue();
		repository.claimDueActor.mockResolvedValue({
			actorId: 'n8n-test',
			claimToken: 'claim-1',
			action: 'suspend',
		});
		sandbox.stop?.mockResolvedValue();
		sandbox.destroy?.mockResolvedValue();
		vi.mocked(createSandbox).mockResolvedValue(sandbox);
		service = new SubstrateActorLifecycleService(repository, settings, logger);
	});
	afterEach(() => {
		vi.clearAllTimers();
		vi.useRealTimers();
	});

	it('claims suspension immediately after the final operation without a timer', async () => {
		const recorder = service.createOperationRecorder(connection, policy);
		await recorder('n8n-test', 'command-1', 'finished', 60_000);
		expect(repository.finishOperation).toHaveBeenCalledWith('n8n-test', 'command-1', 0);
		expect(vi.getTimerCount()).toBe(0);
		expect(sandbox.stop).toHaveBeenCalledOnce();
		expect(repository.completeClaim).toHaveBeenCalledWith({
			actorId: 'n8n-test',
			claimToken: 'claim-1',
			action: 'suspend',
		});
	});

	it('does not suspend while another operation holds a lease', async () => {
		const recorder = service.createOperationRecorder(connection, policy);
		repository.finishOperation.mockResolvedValueOnce(null);
		await recorder('n8n-test', 'first', 'finished', 60_000);
		expect(repository.claimDueActor).not.toHaveBeenCalled();
		await recorder('n8n-test', 'upload', 'finished', 60_000);
		expect(sandbox.stop).toHaveBeenCalledOnce();
	});

	it('respects a lost claim when another process started work', async () => {
		repository.claimDueActor.mockResolvedValue(undefined);
		await service.createOperationRecorder(connection, policy)(
			'n8n-test',
			'first',
			'finished',
			60_000,
		);
		expect(createSandbox).not.toHaveBeenCalled();
	});

	it.each(['suspend', 'delete'] as const)(
		'releases the claim after a remote %s failure',
		async (action) => {
			const claim = { actorId: 'n8n-test', claimToken: 'claim-1', action };
			repository.claimDueActor.mockResolvedValue(claim);
			sandbox.stop?.mockRejectedValue(new Error('remote unavailable'));
			sandbox.destroy?.mockRejectedValue(new Error('remote unavailable'));
			await service.createOperationRecorder(connection, policy)(
				'n8n-test',
				'first',
				'finished',
				60_000,
			);
			expect(repository.releaseClaim).toHaveBeenCalledWith(claim);
			expect(repository.completeClaim).not.toHaveBeenCalled();
			expect(logger.warn).toHaveBeenCalledOnce();
		},
	);

	it('keeps the claim until the asynchronous suspend RPC returns', async () => {
		let complete!: () => void;
		sandbox.stop?.mockReturnValue(
			new Promise<void>((resolve) => {
				complete = resolve;
			}),
		);
		const finished = service.createOperationRecorder(connection, policy)(
			'n8n-test',
			'first',
			'finished',
			60_000,
		);
		await vi.advanceTimersByTimeAsync(0);
		expect(sandbox.stop).toHaveBeenCalledOnce();
		expect(repository.completeClaim).not.toHaveBeenCalled();
		complete();
		await finished;
		expect(repository.completeClaim).toHaveBeenCalledOnce();
	});
});
