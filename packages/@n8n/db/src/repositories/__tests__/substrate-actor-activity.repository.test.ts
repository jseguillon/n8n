import { Container } from '@n8n/di';
import type { Repository } from '@n8n/typeorm';
import { mock } from 'vitest-mock-extended';

import { SubstrateActorActivity } from '../../entities/substrate-actor-activity';
import { mockEntityManager } from '../../utils/test-utils/mock-entity-manager';
import { SubstrateActorActivityRepository } from '../substrate-actor-activity.repository';

describe('Substrate Actor operation revisions', () => {
	const manager = mockEntityManager(SubstrateActorActivity);
	const rows = mock<Repository<SubstrateActorActivity>>();
	const repository = Container.get(SubstrateActorActivityRepository);
	const now = new Date('2026-11-12T12:00:00Z');
	const activity = mock<SubstrateActorActivity>({
		actorId: 'n8n-test',
		revision: 1,
		connectionFingerprint: 'connection',
		operationLeases: {},
		lastActivityAt: now,
		lastSuspendedAt: null,
		suspendAfter: new Date(now.getTime() - 1),
		claimUntil: null,
		claimToken: null,
		suspensionClaimedAt: null,
		activeCommandCount: 0,
		activeCommandLeaseUntil: null,
		autoStopMinutes: 5,
		autoDeleteMinutes: -1,
		ephemeral: false,
	});

	beforeEach(() => {
		vi.resetAllMocks();
		manager.getRepository.mockReturnValue(rows);
	});

	it('retries a lost revision even when activity timestamps are identical', async () => {
		rows.findOneBy
			.mockResolvedValueOnce(activity)
			.mockResolvedValueOnce({ ...activity, revision: 2 });
		rows.update
			.mockResolvedValueOnce({ affected: 0, generatedMaps: [], raw: [] })
			.mockResolvedValueOnce({ affected: 1, generatedMaps: [], raw: [] });
		const claim = await repository.claimDueActor('n8n-test', 'connection', 'claim-1', now);
		expect(claim?.claimToken).toBe('claim-1');
		expect(rows.update.mock.calls.map(([where]) => where)).toEqual([
			{ actorId: 'n8n-test', revision: 1 },
			{ actorId: 'n8n-test', revision: 2 },
		]);
	});

	it('does not delete a newer operation when an old finish is duplicated', async () => {
		rows.findOneBy.mockResolvedValueOnce({
			...activity,
			operationLeases: { newer: now.getTime() + 60_000 },
		});
		expect(await repository.finishOperation('n8n-test', 'older', 5_000, now)).toBeNull();
		expect(rows.update).not.toHaveBeenCalled();
	});

	it.each([
		{ operationLeases: { upload: now.getTime() + 60_000 } },
		{ suspendAfter: new Date(now.getTime() + 1) },
		{ activeCommandCount: 1, activeCommandLeaseUntil: new Date(now.getTime() + 60_000) },
		{ claimToken: 'owner', suspensionClaimedAt: now, claimUntil: new Date(now.getTime() + 60_000) },
	])('does not claim protected or not-yet-due work: %j', async (overrides) => {
		rows.findOneBy.mockResolvedValueOnce({ ...activity, ...overrides });
		expect(
			await repository.claimDueActor('n8n-test', 'connection', 'claim-1', now),
		).toBeUndefined();
		expect(rows.update).not.toHaveBeenCalled();
	});

	it('ignores completion from a previous claim owner', async () => {
		rows.findOneBy.mockResolvedValueOnce({ ...activity, claimToken: 'new-owner' });
		expect(
			await repository.completeClaim(
				{ actorId: 'n8n-test', claimToken: 'old-owner', action: 'suspend' },
				now,
			),
		).toBe(false);
		expect(rows.update).not.toHaveBeenCalled();
	});
});
