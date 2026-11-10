import {
	createTestMigrationContext,
	initDbUpToMigration,
	runSingleMigration,
} from '@n8n/backend-test-utils';
import { DbConnection, SubstrateActorActivity } from '@n8n/db';
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
		const repository = dataSource.getRepository(SubstrateActorActivity);
		await repository.insert({
			actorId: 'n8n-migration-test',
			connectionFingerprint: 'a'.repeat(64),
			lastActivityAt: new Date('2026-11-10T12:00:00.000Z'),
			lastSuspendedAt: null,
			autoStopMinutes: 5,
			autoDeleteMinutes: 1_440,
			ephemeral: false,
		});

		expect(await repository.findOneBy({ actorId: 'n8n-migration-test' })).toMatchObject({
			connectionFingerprint: 'a'.repeat(64),
			autoStopMinutes: 5,
			autoDeleteMinutes: 1_440,
			ephemeral: false,
		});
	});
});
