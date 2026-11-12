import {
	createTestMigrationContext,
	initDbUpToMigration,
	runSingleMigration,
} from '@n8n/backend-test-utils';
import { DbConnection } from '@n8n/db';
import { Container } from '@n8n/di';
import { DataSource } from '@n8n/typeorm';
import type { QueryRunner } from '@n8n/typeorm';

import { TrackSubstrateActorCommandActivity1794414587991 } from '../../../@n8n/db/src/migrations/common/1794414587991-TrackSubstrateActorCommandActivity';
import { wrapMigration } from '../../../@n8n/db/src/migrations/migration-helpers';

const MIGRATION_NAME = 'TrackSubstrateActorCommandActivity1794414587991';

describe('TrackSubstrateActorCommandActivity migration', () => {
	let dataSource: DataSource;
	beforeAll(async () => {
		await Container.get(DbConnection).init();
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

	it('reverts and reapplies the legacy command activity columns', async () => {
		wrapMigration(TrackSubstrateActorCommandActivity1794414587991);
		const context = createTestMigrationContext(dataSource);
		const migration = new TrackSubstrateActorCommandActivity1794414587991();
		const tableName = `${context.tablePrefix}substrate_actor_activity`;
		const down = migration.down as unknown as (runner: QueryRunner) => Promise<void>;
		const up = migration.up as unknown as (runner: QueryRunner) => Promise<void>;
		const columns = ['suspensionClaimedAt', 'activeCommandCount', 'activeCommandLeaseUntil'];
		try {
			expect(
				(await context.queryRunner.getTable(tableName))?.columns.map(({ name }) => name),
			).toEqual(expect.arrayContaining(columns));
			await down.call(migration, context.queryRunner);
			expect(
				(await context.queryRunner.getTable(tableName))?.columns.map(({ name }) => name),
			).not.toEqual(expect.arrayContaining(columns));
			await up.call(migration, context.queryRunner);
			expect(
				(await context.queryRunner.getTable(tableName))?.columns.map(({ name }) => name),
			).toEqual(expect.arrayContaining(columns));
		} finally {
			await context.queryRunner.release();
		}
	});
});
