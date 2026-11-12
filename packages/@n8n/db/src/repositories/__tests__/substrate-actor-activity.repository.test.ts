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
		autoStopMinutes: 5,
		ephemeral: false,
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

	it('does not start a command while suspension is claimed', async () => {
		entityManager.findOneBy.mockResolvedValueOnce({
			...activity,
			suspensionClaimedAt: activityAt,
		});

		await expect(
			repository.recordCommandStarted(activity.actorId, 600_000, activityAt),
		).resolves.toBe(false);
		expect(entityManager.update).not.toHaveBeenCalled();
	});

	it('does not create a suspension candidate when auto-stop is disabled', async () => {
		entityManager.findOneBy.mockResolvedValueOnce({
			...activity,
			activeCommandCount: 1,
			activeCommandLeaseUntil: new Date(activityAt.getTime() + 660_000),
			autoStopMinutes: 0,
		});
		entityManager.update.mockResolvedValueOnce({ affected: 1, generatedMaps: [], raw: [] });

		await expect(
			repository.recordCommandFinished(activity.actorId, activityAt),
		).resolves.toBeUndefined();
		expect(entityManager.update.mock.calls[0]?.[2]).toMatchObject({
			activeCommandCount: 0,
			activeCommandLeaseUntil: null,
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

	it('returns a suspension candidate when the final running command exits', async () => {
		entityManager.findOneBy.mockResolvedValueOnce({
			...activity,
			activeCommandCount: 1,
			activeCommandLeaseUntil: new Date(activityAt.getTime() + 660_000),
		});
		entityManager.update.mockResolvedValueOnce({ affected: 1, generatedMaps: [], raw: [] });

		await expect(repository.recordCommandFinished(activity.actorId, activityAt)).resolves.toEqual({
			actorId: activity.actorId,
			activityAt,
			action: 'suspend',
		});

		expect(entityManager.update.mock.calls[0]?.[2]).toMatchObject({
			lastActivityAt: activityAt,
			lastSuspendedAt: null,
			activeCommandCount: 0,
			activeCommandLeaseUntil: null,
		});
	});

	it('retries a command finish claim against newer activity', async () => {
		const claimedAt = new Date('2026-11-11T12:00:05.000Z');
		const newerActivityAt = new Date('2026-11-11T12:00:03.000Z');
		entityManager.findOneBy
			.mockResolvedValueOnce(activity)
			.mockResolvedValueOnce({ ...activity, lastActivityAt: newerActivityAt });
		entityManager.update
			.mockResolvedValueOnce({ affected: 0, generatedMaps: [], raw: [] })
			.mockResolvedValueOnce({ affected: 1, generatedMaps: [], raw: [] });

		await expect(
			repository.claimCommandFinishedActor(activity.actorId, claimedAt),
		).resolves.toEqual({
			actorId: activity.actorId,
			activityAt: newerActivityAt,
			claimedAt,
			action: 'suspend',
		});
	});

	it('does not claim a command finish while another command is active', async () => {
		entityManager.findOneBy.mockResolvedValueOnce({
			...activity,
			activeCommandCount: 1,
			activeCommandLeaseUntil: new Date(activityAt.getTime() + 660_000),
		});

		await expect(
			repository.claimCommandFinishedActor(activity.actorId, activityAt),
		).resolves.toBeUndefined();
		expect(entityManager.update).not.toHaveBeenCalled();
	});

	it('does not claim a command finish while its command lease is still live', async () => {
		entityManager.findOneBy.mockResolvedValueOnce({
			...activity,
			activeCommandLeaseUntil: new Date(activityAt.getTime() + 60_000),
		});

		await expect(
			repository.claimCommandFinishedActor(activity.actorId, activityAt),
		).resolves.toBeUndefined();
		expect(entityManager.update).not.toHaveBeenCalled();
	});

	it('does not claim a command finish when the Actor is already suspended', async () => {
		entityManager.findOneBy.mockResolvedValueOnce({
			...activity,
			lastSuspendedAt: activityAt,
		});

		await expect(
			repository.claimCommandFinishedActor(activity.actorId, activityAt),
		).resolves.toBeUndefined();
		expect(entityManager.update).not.toHaveBeenCalled();
	});

	it('returns a delete claim for an ephemeral Actor', async () => {
		entityManager.findOneBy.mockResolvedValueOnce({ ...activity, ephemeral: true });
		entityManager.update.mockResolvedValueOnce({ affected: 1, generatedMaps: [], raw: [] });

		await expect(
			repository.claimCommandFinishedActor(activity.actorId, activityAt),
		).resolves.toEqual({
			actorId: activity.actorId,
			activityAt: activity.lastActivityAt,
			claimedAt: activityAt,
			action: 'delete',
		});
	});

	it('keeps the remaining command lease when another command finishes', async () => {
		entityManager.findOneBy.mockResolvedValueOnce({
			...activity,
			activeCommandCount: 2,
			activeCommandLeaseUntil: new Date(activityAt.getTime() + 660_000),
		});
		entityManager.update.mockResolvedValueOnce({ affected: 1, generatedMaps: [], raw: [] });

		await expect(
			repository.recordCommandFinished(activity.actorId, activityAt),
		).resolves.toBeUndefined();
		const update = entityManager.update.mock.calls[0]?.[2];
		expect(update).toMatchObject({
			activeCommandCount: 1,
		});
		expect(update).not.toHaveProperty('suspensionClaimedAt');
	});
});
