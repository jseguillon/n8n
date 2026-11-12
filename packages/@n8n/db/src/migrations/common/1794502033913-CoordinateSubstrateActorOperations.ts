import type { MigrationContext, ReversibleMigration } from '../migration-types';

export class CoordinateSubstrateActorOperations1794502033913 implements ReversibleMigration {
	async up({ schemaBuilder: { addColumns, column } }: MigrationContext) {
		await addColumns(
			'substrate_actor_activity',
			[
				column('revision')
					.int.notNull.default(0)
					.comment('Compare-and-set revision for Actor lifecycle changes.'),
				column('operationLeases')
					.json.notNull.default("'{}'")
					.comment('Operation IDs mapped to lease expiry times in Unix milliseconds.'),
				column('suspendAfter').timestampTimezone(3),
				column('claimToken').uuid.comment('Unique owner of a suspend or delete claim.'),
				column('claimUntil').timestampTimezone(3),
			],
			{ recreatesOnSqlite: true },
		);
	}

	async down({ schemaBuilder: { dropColumns } }: MigrationContext) {
		await dropColumns(
			'substrate_actor_activity',
			['revision', 'operationLeases', 'suspendAfter', 'claimToken', 'claimUntil'],
			{ recreatesOnSqlite: true },
		);
	}
}
