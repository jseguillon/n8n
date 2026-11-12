import { randomUUID } from 'node:crypto';

import {
	createTestMigrationContext,
	initDbUpToMigration,
	runSingleMigration,
} from '@n8n/backend-test-utils';
import {
	DbConnection,
	SubstrateActorActivity,
	SubstrateActorActivityRepository,
	TransactionRunner,
} from '@n8n/db';
import { Container } from '@n8n/di';
import { DataSource } from '@n8n/typeorm';
import type { QueryRunner } from '@n8n/typeorm';

import { CoordinateSubstrateActorOperations1794502033913 } from '../../../@n8n/db/src/migrations/common/1794502033913-CoordinateSubstrateActorOperations';
import { wrapMigration } from '../../../@n8n/db/src/migrations/migration-helpers';

const MIGRATION_NAME = 'CoordinateSubstrateActorOperations1794502033913';
const now = new Date('2026-11-12T12:00:00Z');
const at = (ms: number) => new Date(now.getTime() + ms);

describe('Substrate operation coordination on the migrated database', () => {
	let dataSource: DataSource;
	let repository: SubstrateActorActivityRepository;
	const input = (actorId: string) => ({
		actorId,
		connectionFingerprint: 'a'.repeat(64),
		autoStopMinutes: 5,
		autoDeleteMinutes: -1,
		ephemeral: false,
	});
	beforeAll(async () => {
		await Container.get(DbConnection).init();
		dataSource = Container.get(DataSource);
		const context = createTestMigrationContext(dataSource);
		await context.queryRunner.clearDatabase();
		await context.queryRunner.release();
		await initDbUpToMigration(MIGRATION_NAME);
		dataSource = Container.get(DataSource);
		await runSingleMigration(MIGRATION_NAME);
		repository = Container.get(SubstrateActorActivityRepository);
	}, 60_000);
	afterAll(async () => {
		await Container.get(DbConnection).close();
	});

	it('keeps every concurrent operation at an identical timestamp and schedules once after all complete', async () => {
		const actor = input('n8n-concurrent');
		const ids = Array.from({ length: 12 }, (_, index) => `operation-${index}`);
		expect(
			await Promise.all(
				ids.map(async (id) => await repository.startOperation(actor, id, 60_000, now)),
			),
		).toEqual(ids.map(() => true));
		const row = await dataSource
			.getRepository(SubstrateActorActivity)
			.findOneByOrFail({ actorId: actor.actorId });
		expect(Object.keys(row.operationLeases).sort()).toEqual(ids.sort());
		await Promise.all(
			ids
				.slice(0, -1)
				.map(async (id) => await repository.finishOperation(actor.actorId, id, 5_000, at(1_000))),
		);
		expect(
			await repository.claimDueActor(
				actor.actorId,
				actor.connectionFingerprint,
				randomUUID(),
				at(10_000),
			),
		).toBeUndefined();
		expect(await repository.finishOperation(actor.actorId, ids.at(-1)!, 5_000, at(2_000))).toEqual(
			at(7_000),
		);
		expect(
			await repository.claimDueActor(
				actor.actorId,
				actor.connectionFingerprint,
				randomUUID(),
				at(6_999),
			),
		).toBeUndefined();
		const claims = await Promise.all(
			[1, 2].map(
				async () =>
					await repository.claimDueActor(
						actor.actorId,
						actor.connectionFingerprint,
						randomUUID(),
						at(7_000),
					),
			),
		);
		expect(claims.filter(Boolean)).toHaveLength(1);
	});

	it('keeps a file transfer live and gives a follow-up operation its own full grace period', async () => {
		const actor = input('n8n-file-overlap');
		await repository.startOperation(actor, 'command', 60_000, now);
		await repository.startOperation(actor, 'download', 60_000, at(100));
		expect(await repository.finishOperation(actor.actorId, 'command', 5_000, at(1_000))).toBeNull();
		expect(
			await repository.claimDueActor(
				actor.actorId,
				actor.connectionFingerprint,
				randomUUID(),
				at(9_000),
				true,
			),
		).toBeUndefined();
		expect(await repository.finishOperation(actor.actorId, 'download', 5_000, at(10_000))).toEqual(
			at(15_000),
		);
		await repository.startOperation(actor, 'follow-up', 60_000, at(14_000));
		expect(
			await repository.finishOperation(actor.actorId, 'command', 5_000, at(14_001)),
		).toBeNull();
		expect(
			await repository.claimDueActor(
				actor.actorId,
				actor.connectionFingerprint,
				randomUUID(),
				at(15_000),
			),
		).toBeUndefined();
		expect(await repository.finishOperation(actor.actorId, 'follow-up', 5_000, at(16_000))).toEqual(
			at(21_000),
		);
	});

	it('recovers after restart and fences stale claim completion and release', async () => {
		const actor = input('n8n-restart');
		await repository.startOperation(actor, 'abandoned', 60_000, now);
		const recovered = new SubstrateActorActivityRepository(
			dataSource,
			Container.get(TransactionRunner),
		);
		expect(
			await recovered.claimDueActor(
				actor.actorId,
				actor.connectionFingerprint,
				randomUUID(),
				at(59_999),
				true,
			),
		).toBeUndefined();
		const first = await recovered.claimDueActor(
			actor.actorId,
			actor.connectionFingerprint,
			randomUUID(),
			at(300_000),
			true,
		);
		expect(first).toBeDefined();
		const second = await recovered.claimDueActor(
			actor.actorId,
			actor.connectionFingerprint,
			randomUUID(),
			at(900_001),
			true,
		);
		expect(second).toBeDefined();
		expect(await recovered.completeClaim(first!, at(900_002))).toBe(false);
		await recovered.releaseClaim(first!);
		expect(await recovered.completeClaim(second!, at(900_003))).toBe(true);
	});

	it('does not suspend with auto-stop disabled and never uses another connection', async () => {
		const actor = { ...input('n8n-disabled'), autoStopMinutes: 0 };
		await repository.startOperation(actor, 'command', 60_000, now);
		expect(await repository.finishOperation(actor.actorId, 'command', 0, at(1_000))).toBeNull();
		expect(
			await repository.claimDueActor(
				actor.actorId,
				actor.connectionFingerprint,
				randomUUID(),
				at(9_000_000),
				true,
			),
		).toBeUndefined();
		expect(
			await repository.startOperation(
				{ ...actor, connectionFingerprint: 'b'.repeat(64) },
				'other',
				60_000,
				at(2_000),
			),
		).toBe(false);
	});

	it('deletes an ephemeral Actor through a single fenced action', async () => {
		const actor = { ...input('n8n-ephemeral'), ephemeral: true };
		await repository.startOperation(actor, 'command', 60_000, now);
		await repository.finishOperation(actor.actorId, 'command', 0, at(1_000));
		const claim = await repository.claimDueActor(
			actor.actorId,
			actor.connectionFingerprint,
			randomUUID(),
			at(1_000),
		);
		expect(claim?.action).toBe('delete');
		expect(await repository.completeClaim(claim!, at(1_001))).toBe(true);
		expect(
			await dataSource.getRepository(SubstrateActorActivity).findOneBy({ actorId: actor.actorId }),
		).toBeNull();
	});

	it('keeps suspended files until retention expires', async () => {
		const actor = { ...input('n8n-retention'), autoDeleteMinutes: 1 };
		await repository.startOperation(actor, 'command', 60_000, now);
		await repository.finishOperation(actor.actorId, 'command', 0, at(1_000));
		const suspend = await repository.claimDueActor(
			actor.actorId,
			actor.connectionFingerprint,
			randomUUID(),
			at(1_000),
		);
		expect(suspend?.action).toBe('suspend');
		await repository.completeClaim(suspend!, at(2_000));
		expect(
			await repository.claimDueActor(
				actor.actorId,
				actor.connectionFingerprint,
				randomUUID(),
				at(61_999),
				true,
			),
		).toBeUndefined();
		const deletion = await repository.claimDueActor(
			actor.actorId,
			actor.connectionFingerprint,
			randomUUID(),
			at(62_000),
			true,
		);
		expect(deletion?.action).toBe('delete');
	});

	it('lets new work acquire an expired claim and ignores the old owner afterward', async () => {
		const actor = input('n8n-expired-claim');
		await repository.startOperation(actor, 'first', 60_000, now);
		await repository.finishOperation(actor.actorId, 'first', 0, at(1_000));
		const old = await repository.claimDueActor(
			actor.actorId,
			actor.connectionFingerprint,
			randomUUID(),
			at(1_000),
		);
		expect(await repository.startOperation(actor, 'second', 60_000, at(2_000))).toBe(false);
		expect(await repository.startOperation(actor, 'second', 60_000, at(601_001))).toBe(true);
		expect(await repository.completeClaim(old!, at(601_002))).toBe(false);
		const row = await dataSource
			.getRepository(SubstrateActorActivity)
			.findOneByOrFail({ actorId: actor.actorId });
		expect(Object.keys(row.operationLeases)).toEqual(['second']);
		expect(row.lastSuspendedAt).toBeNull();
	});

	it('renews a specific operation and prevents a completed operation from reappearing', async () => {
		const actor = { ...input('n8n-heartbeat'), autoStopMinutes: 0.01 };
		await repository.startOperation(actor, 'download', 60_000, now);
		expect(await repository.heartbeatOperation(actor.actorId, 'download', 60_000, at(30_000))).toBe(
			true,
		);
		expect(
			await repository.claimDueActor(
				actor.actorId,
				actor.connectionFingerprint,
				randomUUID(),
				at(65_000),
				true,
			),
		).toBeUndefined();
		expect(await repository.finishOperation(actor.actorId, 'download', 5_000, at(70_000))).toEqual(
			at(75_000),
		);
		expect(await repository.heartbeatOperation(actor.actorId, 'download', 60_000, at(71_000))).toBe(
			false,
		);
		expect(
			await repository.finishOperation(actor.actorId, 'download', 5_000, at(72_000)),
		).toBeNull();
		expect(
			await repository.claimDueActor(
				actor.actorId,
				actor.connectionFingerprint,
				randomUUID(),
				at(75_000),
			),
		).toBeDefined();
	});

	it('reverts and reapplies the coordinator columns without dropping tracked Actors', async () => {
		wrapMigration(CoordinateSubstrateActorOperations1794502033913);
		const context = createTestMigrationContext(dataSource);
		const migration = new CoordinateSubstrateActorOperations1794502033913();
		const down = migration.down as unknown as (runner: QueryRunner) => Promise<void>;
		const up = migration.up as unknown as (runner: QueryRunner) => Promise<void>;
		try {
			await down.call(migration, context.queryRunner);
			await up.call(migration, context.queryRunner);
			const row = await context.queryRunner.manager
				.getRepository(SubstrateActorActivity)
				.findOneByOrFail({ actorId: 'n8n-disabled' });
			expect(row.revision).toBe(0);
			expect(row.operationLeases).toEqual({});
		} finally {
			await context.queryRunner.release();
		}
	});
});
