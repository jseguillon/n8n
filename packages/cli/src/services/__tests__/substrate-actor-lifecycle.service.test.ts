import { createHash } from 'node:crypto';

import { createSandbox } from '@n8n/agents/sandbox';
import type { WorkspaceSandbox } from '@n8n/agents/sandbox';
import type { Logger } from '@n8n/backend-common';
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
	let service: SubstrateActorLifecycleService;

	beforeEach(() => {
		vi.resetAllMocks();
		activityRepository.findAll.mockResolvedValue([]);
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
