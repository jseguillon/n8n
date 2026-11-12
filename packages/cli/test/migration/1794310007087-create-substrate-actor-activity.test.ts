import {
	createTestMigrationContext,
	initDbUpToMigration,
	runSingleMigration,
} from '@n8n/backend-test-utils';
import { DbConnection } from '@n8n/db';
import { Container } from '@n8n/di';
import { DataSource } from '@n8n/typeorm';

const MIGRATION_NAME = 'CreateSubstrateActorActivity1794310007087';

describe('CreateSubstrateActorActivity migration', () => {
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

	it('creates the persistent Actor activity table', async () => {
		const context = createTestMigrationContext(dataSource);
		try {
			const table = await context.queryRunner.getTable(
				`${context.tablePrefix}substrate_actor_activity`,
			);
			expect(table?.columns.map(({ name }) => name)).toEqual(
				expect.arrayContaining([
					'actorId',
					'connectionFingerprint',
					'lastActivityAt',
					'lastSuspendedAt',
					'autoStopMinutes',
					'autoDeleteMinutes',
					'ephemeral',
				]),
			);
			expect(table?.primaryColumns.map(({ name }) => name)).toEqual(['actorId']);
		} finally {
			await context.queryRunner.release();
		}
	});
});
