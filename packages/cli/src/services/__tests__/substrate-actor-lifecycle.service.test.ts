import { createHash } from 'node:crypto';

import { createSandbox } from '@n8n/agents/sandbox';
import type { WorkspaceSandbox } from '@n8n/agents/sandbox';
import type { Logger } from '@n8n/backend-common';
import type { GlobalConfig } from '@n8n/config';
import type { SubstrateActorActivity } from '@n8n/db';
import type { SubstrateSandboxConfig } from '@n8n/agents/sandbox';
import { mock } from 'vitest-mock-extended';

import type { SandboxSettingsService } from '../sandbox-settings.service';
import type { SubstrateActorActivityRepository } from '@n8n/db';
import { SubstrateActorLifecycleService } from '../substrate-actor-lifecycle.service';

vi.mock('@n8n/agents/sandbox', async (importOriginal) => ({
	...(await importOriginal<typeof import('@n8n/agents/sandbox')>()),
	createSandbox: vi.fn(),
}));

type TestWorkspaceSandbox = WorkspaceSandbox &
	Required<Pick<WorkspaceSandbox, 'stop' | '_stop' | 'destroy'>>;

const connection: SubstrateSandboxConfig['connection'] = {
	endpoint: 'api.substrate.example:443',
	routerUrl: 'https://router.example',
	atespace: 'n8n-sandboxes',
	template: 'n8n-sandbox',
	tokenFile: '/run/secrets/substrate-token',
	caFile: '/run/secrets/substrate-ca',
	routerCredentialFile: '/run/secrets/router-identity',
	serverName: 'api.substrate.example',
};

const fingerprint = createHash('sha256')
	.update(
		JSON.stringify({
			endpoint: connection.endpoint,
			routerUrl: connection.routerUrl,
			atespace: connection.atespace,
			template: connection.template,
			serverName: connection.serverName,
		}),
	)
	.digest('hex');

function makeActivity(overrides: Partial<SubstrateActorActivity> = {}): SubstrateActorActivity {
	const now = new Date('2026-11-10T12:00:00.000Z');
	return {
		actorId: 'n8n-actor-1',
		connectionFingerprint: fingerprint,
		lastActivityAt: now,
		lastSuspendedAt: null,
		suspensionClaimedAt: null,
		activeCommandCount: 0,
		activeCommandLeaseUntil: null,
		autoStopMinutes: 5,
		autoDeleteMinutes: 1_440,
		ephemeral: false,
		createdAt: now,
		updatedAt: now,
		...overrides,
		setUpdateDate: () => {},
	};
}

describe('SubstrateActorLifecycleService', () => {
	const activityRepository = mock<SubstrateActorActivityRepository>();
	const sandboxSettingsService = mock<SandboxSettingsService>();
	const logger = mock<Logger>();
	const globalConfig = mock<GlobalConfig>();
	let service: SubstrateActorLifecycleService;

	beforeEach(() => {
		vi.resetAllMocks();
		activityRepository.findAll.mockResolvedValue([]);
		activityRepository.recordActivity.mockResolvedValue(true);
		activityRepository.claimIdleActor.mockResolvedValue(true);
		activityRepository.markSuspended.mockResolvedValue(true);
		activityRepository.releaseExpiredSuspensionClaims.mockResolvedValue();
		activityRepository.releaseSuspensionClaim.mockResolvedValue();
		activityRepository.claimCommandFinishedActor.mockResolvedValue(undefined);
		globalConfig.generic.substrateSandboxSuspendDelayMs = 0;
		sandboxSettingsService.getProvider.mockReturnValue('substrate');
		sandboxSettingsService.getSubstrateConfig.mockResolvedValue({
			enabled: true,
			provider: 'substrate',
			connection,
		});
		service = new SubstrateActorLifecycleService(
			activityRepository,
			sandboxSettingsService,
			logger,
			globalConfig,
		);
	});

	it('persists the connection fingerprint and cleanup policy with each activity update', async () => {
		const recorder = service.createActivityRecorder(connection, {
			autoStopMinutes: 5,
			autoDeleteMinutes: 1_440,
			ephemeral: false,
		});

		await recorder('n8n-actor-1');

		expect(activityRepository.recordActivity).toHaveBeenCalledWith({
			actorId: 'n8n-actor-1',
			connectionFingerprint: fingerprint,
			autoStopMinutes: 5,
			autoDeleteMinutes: 1_440,
			ephemeral: false,
		});
	});

	it('suspends an idle persistent Actor without deleting its files', async () => {
		const activity = makeActivity({
			lastActivityAt: new Date('2026-11-10T11:54:00.000Z'),
		});
		activityRepository.findAll.mockResolvedValue([activity]);
		activityRepository.markSuspended.mockResolvedValue(true);
		const sandbox = mock<TestWorkspaceSandbox>();
		sandbox.stop.mockResolvedValue();
		sandbox._stop.mockResolvedValue();
		vi.mocked(createSandbox).mockResolvedValue(sandbox);

		await service.cleanupIdleActors(undefined, Date.parse('2026-11-10T12:00:00.000Z'));

		expect(activityRepository.claimIdleActor).toHaveBeenCalledWith(
			'n8n-actor-1',
			activity.lastActivityAt,
			null,
			new Date('2026-11-10T12:00:00.000Z'),
			new Date('2026-11-10T12:00:00.000Z'),
		);
		expect(createSandbox).toHaveBeenCalledWith(
			expect.objectContaining({ id: 'actor-1', ephemeral: false }),
		);
		expect(sandbox.stop).toHaveBeenCalledOnce();
		expect(sandbox._stop).not.toHaveBeenCalled();
		expect(sandbox.destroy).not.toHaveBeenCalled();
		expect(activityRepository.markSuspended).toHaveBeenCalledWith(
			'n8n-actor-1',
			activity.lastActivityAt,
			new Date('2026-11-10T12:00:00.000Z'),
			new Date('2026-11-10T12:00:00.000Z'),
			true,
		);
		expect(activityRepository.claimIdleActor.mock.invocationCallOrder[0]).toBeLessThan(
			sandbox.stop.mock.invocationCallOrder[0],
		);
	});

	it('does not stop when the conditional claim finds an active command', async () => {
		const activity = makeActivity({
			lastActivityAt: new Date('2026-11-10T11:54:00.000Z'),
			activeCommandCount: 1,
			activeCommandLeaseUntil: new Date('2026-11-10T12:05:00.000Z'),
		});
		activityRepository.findAll.mockResolvedValue([activity]);
		activityRepository.claimIdleActor.mockResolvedValue(false);
		const sandbox = mock<TestWorkspaceSandbox>();
		vi.mocked(createSandbox).mockResolvedValue(sandbox);

		await service.cleanupIdleActors(undefined, Date.parse('2026-11-10T12:00:00.000Z'));

		expect(sandbox.stop).not.toHaveBeenCalled();
		expect(activityRepository.markSuspended).not.toHaveBeenCalled();
	});

	it('records command start, heartbeat, and exit activity', async () => {
		const recorder = service.createCommandActivityRecorder(connection, {
			autoStopMinutes: 5,
			autoDeleteMinutes: 1_440,
			ephemeral: false,
		});
		activityRepository.recordCommandStarted.mockResolvedValue(true);
		activityRepository.recordCommandHeartbeat.mockResolvedValue(true);

		await recorder('n8n-actor-1', 'started', 600_000);
		await recorder('n8n-actor-1', 'heartbeat', 600_000);
		await recorder('n8n-actor-1', 'finished', 600_000);

		expect(activityRepository.recordCommandStarted).toHaveBeenCalledWith('n8n-actor-1', 600_000);
		expect(activityRepository.recordCommandHeartbeat).toHaveBeenCalledWith('n8n-actor-1', 600_000);
		expect(activityRepository.recordCommandFinished).toHaveBeenCalledWith(
			'n8n-actor-1',
			expect.any(Date),
		);
		expect(createSandbox).not.toHaveBeenCalled();
	});

	it('waits for the configured command grace period before trying to suspend', async () => {
		globalConfig.generic.substrateSandboxSuspendDelayMs = 40;
		activityRepository.recordCommandFinished.mockResolvedValue({
			actorId: 'n8n-actor-1',
			activityAt: new Date(),
			action: 'suspend',
		});
		activityRepository.claimCommandFinishedActor.mockResolvedValue(undefined);
		const recorder = service.createCommandActivityRecorder(connection, {
			autoStopMinutes: 5,
			autoDeleteMinutes: 1_440,
			ephemeral: false,
		});

		await recorder('n8n-actor-1', 'finished', 600_000);
		expect(activityRepository.recordCommandFinished).not.toHaveBeenCalled();
		expect(activityRepository.claimCommandFinishedActor).not.toHaveBeenCalled();

		await new Promise((resolve) => setTimeout(resolve, 60));

		const finishedAt = activityRepository.recordCommandFinished.mock.calls[0]?.[1];
		expect(finishedAt).toBeInstanceOf(Date);
		expect(activityRepository.claimCommandFinishedActor).toHaveBeenCalledWith(
			'n8n-actor-1',
			expect.any(Date),
		);
		expect(createSandbox).not.toHaveBeenCalled();
	});

	it('does not suspend while a follow-up command is active during the grace period', async () => {
		globalConfig.generic.substrateSandboxSuspendDelayMs = 40;
		activityRepository.recordCommandStarted.mockResolvedValue(true);
		activityRepository.recordCommandFinished.mockResolvedValue(undefined);
		const recorder = service.createCommandActivityRecorder(connection, {
			autoStopMinutes: 5,
			autoDeleteMinutes: 1_440,
			ephemeral: false,
		});

		await recorder('n8n-actor-1', 'finished', 600_000);
		await recorder('n8n-actor-1', 'started', 600_000);
		await new Promise((resolve) => setTimeout(resolve, 60));

		expect(activityRepository.recordCommandFinished).toHaveBeenCalledOnce();
		expect(activityRepository.claimCommandFinishedActor).not.toHaveBeenCalled();
		expect(createSandbox).not.toHaveBeenCalled();
	});

	it('does not apply the grace period when automatic suspension is disabled', async () => {
		globalConfig.generic.substrateSandboxSuspendDelayMs = 40;
		const recorder = service.createCommandActivityRecorder(connection, {
			autoStopMinutes: 0,
			autoDeleteMinutes: 1_440,
			ephemeral: false,
		});

		await recorder('n8n-actor-1', 'finished', 600_000);

		expect(activityRepository.recordCommandFinished).toHaveBeenCalledWith(
			'n8n-actor-1',
			expect.any(Date),
		);
		expect(activityRepository.claimCommandFinishedActor).not.toHaveBeenCalled();
	});

	it('does not delay command completion while suspending the persistent Actor', async () => {
		const finishedAt = new Date('2026-11-10T12:00:00.000Z');
		activityRepository.recordCommandFinished.mockResolvedValue({
			actorId: 'n8n-actor-1',
			activityAt: finishedAt,
			action: 'suspend',
		});
		activityRepository.claimCommandFinishedActor.mockResolvedValue({
			actorId: 'n8n-actor-1',
			activityAt: finishedAt,
			claimedAt: finishedAt,
			action: 'suspend',
		});
		activityRepository.markSuspended.mockResolvedValue(true);
		const sandbox = mock<TestWorkspaceSandbox>();
		let finishStop!: () => void;
		const stopFinished = new Promise<void>((resolve) => {
			finishStop = resolve;
		});
		sandbox.stop.mockReturnValue(stopFinished);
		vi.mocked(createSandbox).mockResolvedValue(sandbox);
		const recorder = service.createCommandActivityRecorder(connection, {
			autoStopMinutes: 5,
			autoDeleteMinutes: 1_440,
			ephemeral: false,
		});

		await recorder('n8n-actor-1', 'finished', 600_000);
		await vi.waitFor(() => expect(sandbox.stop).toHaveBeenCalledOnce());
		expect(activityRepository.markSuspended).not.toHaveBeenCalled();
		finishStop();
		await vi.waitFor(() => expect(activityRepository.markSuspended).toHaveBeenCalledOnce());

		expect(createSandbox).toHaveBeenCalledWith(
			expect.objectContaining({
				enabled: true,
				provider: 'substrate',
				id: 'actor-1',
				onActivity: undefined,
				onCommandActivity: undefined,
			}),
		);
		expect(sandbox.stop).toHaveBeenCalledOnce();
		expect(activityRepository.markSuspended).toHaveBeenCalledWith(
			'n8n-actor-1',
			finishedAt,
			expect.any(Date),
			expect.any(Date),
			true,
		);
		expect(sandbox.stop.mock.invocationCallOrder[0]).toBeLessThan(
			activityRepository.markSuspended.mock.invocationCallOrder[0],
		);
	});

	it('deletes an ephemeral Actor after the delayed command completion claim', async () => {
		const finishedAt = new Date('2026-11-10T12:00:00.000Z');
		const claimedAt = new Date('2026-11-10T12:00:05.000Z');
		globalConfig.generic.substrateSandboxSuspendDelayMs = 40;
		activityRepository.recordCommandFinished.mockResolvedValue({
			actorId: 'n8n-actor-1',
			activityAt: finishedAt,
			action: 'delete',
		});
		activityRepository.claimCommandFinishedActor.mockResolvedValue({
			actorId: 'n8n-actor-1',
			activityAt: finishedAt,
			claimedAt,
			action: 'delete',
		});
		activityRepository.deleteIfUnchanged.mockResolvedValue(true);
		const sandbox = mock<TestWorkspaceSandbox>();
		sandbox.destroy.mockResolvedValue();
		vi.mocked(createSandbox).mockResolvedValue(sandbox);
		const recorder = service.createCommandActivityRecorder(connection, {
			autoStopMinutes: 5,
			autoDeleteMinutes: 0,
			ephemeral: true,
		});

		await recorder('n8n-actor-1', 'finished', 600_000);
		await vi.waitFor(() => expect(sandbox.destroy).toHaveBeenCalledOnce());

		expect(sandbox.stop).not.toHaveBeenCalled();
		expect(activityRepository.deleteIfUnchanged).toHaveBeenCalledWith(
			'n8n-actor-1',
			finishedAt,
			claimedAt,
		);
	});

	it('releases the claim when remote suspension fails', async () => {
		const finishedAt = new Date('2026-11-10T12:00:00.000Z');
		const claimedAt = new Date('2026-11-10T12:00:05.000Z');
		activityRepository.recordCommandFinished.mockResolvedValue({
			actorId: 'n8n-actor-1',
			activityAt: finishedAt,
			action: 'suspend',
		});
		activityRepository.claimCommandFinishedActor.mockResolvedValue({
			actorId: 'n8n-actor-1',
			activityAt: finishedAt,
			claimedAt,
			action: 'suspend',
		});
		const sandbox = mock<TestWorkspaceSandbox>();
		sandbox.stop.mockRejectedValue(new Error('suspend failed'));
		vi.mocked(createSandbox).mockResolvedValue(sandbox);
		const recorder = service.createCommandActivityRecorder(connection, {
			autoStopMinutes: 5,
			autoDeleteMinutes: 1_440,
			ephemeral: false,
		});

		await recorder('n8n-actor-1', 'finished', 600_000);
		await vi.waitFor(() =>
			expect(activityRepository.releaseSuspensionClaim).toHaveBeenCalledWith(
				'n8n-actor-1',
				claimedAt,
			),
		);
		await vi.waitFor(() => expect(logger.warn).toHaveBeenCalledOnce());

		expect(logger.warn).toHaveBeenCalledWith(
			'Failed to reclaim a Substrate Actor after its command finished',
			expect.objectContaining({ actorId: 'n8n-actor-1' }),
		);
	});

	it('deletes a suspended Actor after its retention interval', async () => {
		const activity = makeActivity({
			lastActivityAt: new Date('2026-11-09T11:00:00.000Z'),
			lastSuspendedAt: new Date('2026-11-09T11:00:00.000Z'),
		});
		activityRepository.findAll.mockResolvedValue([activity]);
		activityRepository.deleteIfUnchanged.mockResolvedValue(true);
		const sandbox = mock<TestWorkspaceSandbox>();
		sandbox.destroy.mockResolvedValue();
		vi.mocked(createSandbox).mockResolvedValue(sandbox);

		await service.cleanupIdleActors(undefined, Date.parse('2026-11-10T12:00:00.000Z'));

		expect(sandbox.destroy).toHaveBeenCalledOnce();
		expect(activityRepository.deleteIfUnchanged).toHaveBeenCalledWith(
			activity.actorId,
			activity.lastActivityAt,
			new Date('2026-11-10T12:00:00.000Z'),
		);
	});

	it('deletes an ephemeral Actor after the auto-stop interval', async () => {
		const activity = makeActivity({
			lastActivityAt: new Date('2026-11-10T11:54:00.000Z'),
			autoDeleteMinutes: -1,
			ephemeral: true,
		});
		activityRepository.findAll.mockResolvedValue([activity]);
		activityRepository.deleteIfUnchanged.mockResolvedValue(true);
		const sandbox = mock<TestWorkspaceSandbox>();
		sandbox.destroy.mockResolvedValue();
		vi.mocked(createSandbox).mockResolvedValue(sandbox);

		await service.cleanupIdleActors(undefined, Date.parse('2026-11-10T12:00:00.000Z'));

		expect(sandbox.destroy).toHaveBeenCalledOnce();
		expect(sandbox._stop).not.toHaveBeenCalled();
	});

	it('does not delete when auto-stop is disabled', async () => {
		activityRepository.findAll.mockResolvedValue([
			makeActivity({
				lastActivityAt: new Date('2026-11-01T12:00:00.000Z'),
				autoStopMinutes: 0,
			}),
		]);

		await service.cleanupIdleActors(undefined, Date.parse('2026-11-10T12:00:00.000Z'));

		expect(createSandbox).not.toHaveBeenCalled();
	});
});
