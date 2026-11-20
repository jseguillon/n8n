import { createSandbox } from '@n8n/agents/sandbox';
import type { SubstrateSandboxConfig, WorkspaceSandbox } from '@n8n/agents/sandbox';
import type { Logger } from '@n8n/backend-common';
import type { SubstrateActorActivity, SubstrateActorActivityRepository } from '@n8n/db';
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

	it('serializes updates for one Actor across independent recorders and keeps distinct leases', async () => {
		let release!: (value: boolean) => void;
		repository.startOperation.mockReturnValueOnce(
			new Promise<boolean>((resolve) => {
				release = resolve;
			}),
		);
		const firstRecorder = service.createOperationRecorder(connection, policy);
		const secondRecorder = service.createOperationRecorder(connection, policy);
		const first = firstRecorder('n8n-test', 'first', 'started', 60_000);
		const second = secondRecorder('n8n-test', 'second', 'started', 60_000);
		await vi.advanceTimersByTimeAsync(0);
		expect(repository.startOperation).toHaveBeenCalledOnce();
		release(true);
		await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
		expect(repository.startOperation.mock.calls.map(([, operationId]) => operationId)).toEqual([
			'first',
			'second',
		]);
	});

	it('allows a different Actor to progress while one Actor update is pending', async () => {
		let release!: (value: boolean) => void;
		repository.startOperation.mockReturnValueOnce(
			new Promise<boolean>((resolve) => {
				release = resolve;
			}),
		);
		const recorder = service.createOperationRecorder(connection, policy);
		const first = recorder('n8n-slow', 'first', 'started', 60_000);
		await expect(recorder('n8n-fast', 'second', 'started', 60_000)).resolves.toBe(true);
		release(true);
		await first;
	});

	it('continues queued updates after a bookkeeping failure', async () => {
		repository.startOperation.mockRejectedValueOnce(new Error('database unavailable'));
		const recorder = service.createOperationRecorder(connection, policy);
		const failed = expect(recorder('n8n-test', 'first', 'started', 60_000)).rejects.toThrow(
			'database unavailable',
		);
		const second = recorder('n8n-test', 'second', 'started', 60_000);
		await failed;
		await expect(second).resolves.toBe(true);
	});

	it('does not acquire a lease for an operation cancelled while queued', async () => {
		let release!: (value: boolean) => void;
		repository.startOperation.mockReturnValueOnce(
			new Promise<boolean>((resolve) => {
				release = resolve;
			}),
		);
		const recorder = service.createOperationRecorder(connection, policy);
		const controller = new AbortController();
		const first = recorder('n8n-test', 'first', 'started', 60_000);
		const second = recorder('n8n-test', 'cancelled', 'started', 60_000, controller.signal);
		const cancelled = expect(second).rejects.toMatchObject({ name: 'AbortError' });
		await vi.advanceTimersByTimeAsync(0);
		controller.abort();
		release(true);
		await first;
		await cancelled;
		expect(repository.startOperation).toHaveBeenCalledOnce();
	});

	it('does not hold the update queue while waiting for the suspend RPC', async () => {
		let complete!: () => void;
		sandbox.stop.mockReturnValue(
			new Promise<void>((resolve) => {
				complete = resolve;
			}),
		);
		const recorder = service.createOperationRecorder(connection, policy);
		const finished = recorder('n8n-test', 'finished', 'finished', 60_000);
		await vi.advanceTimersByTimeAsync(0);
		expect(sandbox.stop).toHaveBeenCalledOnce();
		const controller = new AbortController();
		controller.abort();
		await expect(
			recorder('n8n-test', 'cancelled', 'started', 60_000, controller.signal),
		).rejects.toMatchObject({ name: 'AbortError' });
		expect(repository.startOperation).not.toHaveBeenCalled();
		complete();
		await finished;
	});

	it('accepts only fingerprints derived from operator-approved previous templates', async () => {
		await service.createOperationRecorder(connection, policy)('n8n-test', 'old', 'started', 60_000);
		const oldFingerprint = repository.startOperation.mock.calls[0][0].connectionFingerprint;
		await service.createOperationRecorder(
			{ ...connection, template: 'new-template', previousTemplates: [connection.template] },
			policy,
		)('n8n-test', 'new', 'started', 60_000);
		expect(repository.startOperation).toHaveBeenLastCalledWith(
			expect.objectContaining({ connectionFingerprint: expect.not.stringMatching(oldFingerprint) }),
			'new',
			120_000,
			undefined,
			[oldFingerprint],
		);
	});

	it('keeps recovery cleanup active for an approved previous template', async () => {
		await service.createOperationRecorder(connection, policy)('n8n-test', 'old', 'started', 60_000);
		const oldFingerprint = repository.startOperation.mock.calls[0][0].connectionFingerprint;
		settings.getProvider.mockReturnValue('n8n-sandbox');
		settings.getSubstrateConfigForCleanup.mockResolvedValue({
			enabled: true,
			provider: 'substrate',
			connection: {
				...connection,
				template: 'new-template',
				previousTemplates: [connection.template],
			},
		});
		repository.findAll.mockResolvedValue([
			mock<SubstrateActorActivity>({ actorId: 'n8n-test', connectionFingerprint: oldFingerprint }),
		]);
		await service.cleanupIdleActors(undefined, now.getTime());
		expect(repository.claimDueActor).toHaveBeenCalledWith(
			'n8n-test',
			oldFingerprint,
			expect.any(String),
			now,
			true,
		);
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
