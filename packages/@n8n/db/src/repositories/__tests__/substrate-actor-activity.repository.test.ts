import { Container } from '@n8n/di';
import { IsNull, LessThanOrEqual } from '@n8n/typeorm';

import { SubstrateActorActivity } from '../../entities/substrate-actor-activity';
import { mockEntityManager } from '../../utils/test-utils/mock-entity-manager';
import { SubstrateActorActivityRepository } from '../substrate-actor-activity.repository';

describe('SubstrateActorActivityRepository', () => {
	const entityManager = mockEntityManager(SubstrateActorActivity);
	const repository = Container.get(SubstrateActorActivityRepository);
	const activityAt = new Date('2026-11-11T12:00:00.000Z');
	const activity = {
		actorId: 'n8n-test-actor',
		lastActivityAt: new Date('2026-11-11T11:59:00.000Z'),
		lastSuspendedAt: null,
		suspensionClaimedAt: null,
		activeCommandCount: 0,
		activeCommandLeaseUntil: null,
	} as SubstrateActorActivity;

	beforeEach(() => {
		vi.resetAllMocks();
	});

	it('records a command lease with a compare-and-set activity timestamp', async () => {
		entityManager.findOneBy.mockResolvedValueOnce(activity);
		entityManager.update.mockResolvedValueOnce({ affected: 1, generatedMaps: [], raw: [] });

		await expect(
			repository.recordCommandStarted(activity.actorId, 600_000, activityAt),
		).resolves.toBe(true);

		const [, criteria, update] = entityManager.update.mock.calls[0] ?? [];
		expect(criteria).toEqual({
			actorId: activity.actorId,
			lastActivityAt: activity.lastActivityAt,
			suspensionClaimedAt: IsNull(),
		});
		expect(update).toMatchObject({
			lastActivityAt: activityAt,
			activeCommandCount: 1,
			activeCommandLeaseUntil: new Date(activityAt.getTime() + 660_000),
		});
	});

	it('claims suspension only when no live command lease exists', async () => {
		entityManager.update.mockResolvedValue({ affected: 0, generatedMaps: [], raw: [] });
		const claimedAt = new Date('2026-11-11T12:00:00.000Z');

		await expect(
			repository.claimIdleActor(
				activity.actorId,
				activity.lastActivityAt,
				null,
				claimedAt,
				claimedAt,
			),
		).resolves.toBe(false);

		const criteria = entityManager.update.mock.calls.map(([, where]) => where);
		expect(criteria).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ activeCommandCount: 0 }),
				expect.objectContaining({ activeCommandLeaseUntil: IsNull() }),
				expect.objectContaining({ activeCommandLeaseUntil: LessThanOrEqual(claimedAt) }),
			]),
		);
	});

	it('records command exit and clears the final lease', async () => {
		entityManager.findOneBy.mockResolvedValueOnce({
			...activity,
			activeCommandCount: 1,
			activeCommandLeaseUntil: new Date(activityAt.getTime() + 660_000),
		});
		entityManager.update.mockResolvedValueOnce({ affected: 1, generatedMaps: [], raw: [] });

		await repository.recordCommandFinished(activity.actorId, activityAt);

		expect(entityManager.update.mock.calls[0]?.[2]).toMatchObject({
			lastActivityAt: activityAt,
			lastSuspendedAt: null,
			activeCommandCount: 0,
			activeCommandLeaseUntil: null,
		});
	});
});
