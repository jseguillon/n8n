import {
	createTestMigrationContext,
	initDbUpToMigration,
	runSingleMigration,
} from '@n8n/backend-test-utils';
import { DbConnection, SubstrateActorActivity, SubstrateActorActivityRepository } from '@n8n/db';
import { Container } from '@n8n/di';
import { DataSource } from '@n8n/typeorm';
import type { QueryRunner } from '@n8n/typeorm';

import { TrackSubstrateActorCommandActivity1794414587991 } from '../../../@n8n/db/src/migrations/common/1794414587991-TrackSubstrateActorCommandActivity';
import { wrapMigration } from '../../../@n8n/db/src/migrations/migration-helpers';

const MIGRATION_NAME = 'TrackSubstrateActorCommandActivity1794414587991';

describe('TrackSubstrateActorCommandActivity migration', () => {
	let dataSource: DataSource;

	beforeAll(async () => {
		const dbConnection = Container.get(DbConnection);
		await dbConnection.init();
		dataSource = Container.get(DataSource);
		const context = createTestMigrationContext(dataSource);
		await context.queryRunner.clearDatabase();
		await context.queryRunner.release();
		await initDbUpToMigration(MIGRATION_NAME);
		dataSource = Container.get(DataSource);
		await runSingleMigration(MIGRATION_NAME);
	}, 60_000);

	afterAll(async () => {
		await Container.get(DbConnection).close();
	});

	it('adds command lease and suspension claim state to Actor activity', async () => {
		const repository = dataSource.getRepository(SubstrateActorActivity);
		await repository.insert({
			actorId: 'n8n-command-migration-test',
			connectionFingerprint: 'b'.repeat(64),
			lastActivityAt: new Date('2026-11-11T12:00:00.000Z'),
			lastSuspendedAt: null,
			autoStopMinutes: 5,
			autoDeleteMinutes: 1_440,
			ephemeral: false,
		});

		expect(await repository.findOneBy({ actorId: 'n8n-command-migration-test' })).toMatchObject({
			activeCommandCount: 0,
			activeCommandLeaseUntil: null,
			suspensionClaimedAt: null,
		});
	});

	it('blocks idle cleanup during a command and claims suspension after command exit', async () => {
		const actorId = 'n8n-command-lease-test';
		const activityRepository = Container.get(SubstrateActorActivityRepository);
		const startedAt = new Date('2026-11-11T12:00:00.000Z');
		const finishedAt = new Date('2026-11-11T12:02:00.000Z');

		await activityRepository.recordActivity(
			{
				actorId,
				connectionFingerprint: 'c'.repeat(64),
				autoStopMinutes: 1,
				autoDeleteMinutes: 1_440,
				ephemeral: false,
			},
			startedAt,
		);
		await expect(
			activityRepository.recordCommandStarted(actorId, 600_000, startedAt),
		).resolves.toBe(true);
		await expect(
			activityRepository.claimIdleActor(actorId, startedAt, null, startedAt, startedAt),
		).resolves.toBe(false);

		const completion = await activityRepository.recordCommandFinished(actorId, finishedAt);
		expect(completion).toEqual({
			actorId,
			activityAt: finishedAt,
			action: 'suspend',
		});
		const claim = await activityRepository.claimCommandFinishedActor(actorId, finishedAt);
		expect(claim).toEqual({
			actorId,
			activityAt: finishedAt,
			claimedAt: finishedAt,
			action: 'suspend',
		});
		await expect(
			activityRepository.markSuspended(actorId, finishedAt, claim!.claimedAt, finishedAt),
		).resolves.toBe(true);
	});

	it('allows the hourly fallback to claim a command lease that expired during restart', async () => {
		const actorId = 'n8n-command-restart-test';
		const activityRepository = Container.get(SubstrateActorActivityRepository);
		const startedAt = new Date('2026-11-11T12:00:00.000Z');
		const leaseExpiredAt = new Date(startedAt.getTime() + 660_001);

		await activityRepository.recordActivity(
			{
				actorId,
				connectionFingerprint: 'd'.repeat(64),
				autoStopMinutes: 1,
				autoDeleteMinutes: 1_440,
				ephemeral: false,
			},
			startedAt,
		);
		await activityRepository.recordCommandStarted(actorId, 600_000, startedAt);

		await expect(
			activityRepository.claimIdleActor(actorId, startedAt, null, leaseExpiredAt, leaseExpiredAt),
		).resolves.toBe(true);
	});

	it('allows hourly recovery to claim an Actor after its command lease expires', async () => {
		const actorId = 'n8n-hourly-command-recovery-test';
		const activityRepository = Container.get(SubstrateActorActivityRepository);
		const startedAt = new Date('2026-11-11T12:00:00.000Z');
		const sweepAt = new Date(startedAt.getTime() + 12 * 60 * 1_000);
		await activityRepository.recordActivity(
			{
				actorId,
				connectionFingerprint: 'e'.repeat(64),
				autoStopMinutes: 1,
				autoDeleteMinutes: 1_440,
				ephemeral: false,
			},
			startedAt,
		);
		await activityRepository.recordCommandStarted(actorId, 600_000, startedAt);

		await expect(
			activityRepository.claimIdleActor(actorId, startedAt, null, sweepAt, sweepAt),
		).resolves.toBe(true);
	});

	it('reverts and reapplies the command activity columns', async () => {
		wrapMigration(TrackSubstrateActorCommandActivity1794414587991);
		const context = createTestMigrationContext(dataSource);
		const migration = new TrackSubstrateActorCommandActivity1794414587991();
		const tableName = `${context.tablePrefix}substrate_actor_activity`;
		const down = migration.down as unknown as (queryRunner: QueryRunner) => Promise<void>;
		const up = migration.up as unknown as (queryRunner: QueryRunner) => Promise<void>;
		try {
			await down.call(migration, context.queryRunner);
			const reverted = await context.queryRunner.getTable(tableName);
			expect(reverted?.columns.map(({ name }) => name)).not.toEqual(
				expect.arrayContaining([
					'suspensionClaimedAt',
					'activeCommandCount',
					'activeCommandLeaseUntil',
				]),
			);

			await up.call(migration, context.queryRunner);
			const reapplied = await context.queryRunner.getTable(tableName);
			expect(reapplied?.columns.map(({ name }) => name)).toEqual(
				expect.arrayContaining([
					'suspensionClaimedAt',
					'activeCommandCount',
					'activeCommandLeaseUntil',
				]),
			);
		} finally {
			await context.queryRunner.release();
		}
	});
});
