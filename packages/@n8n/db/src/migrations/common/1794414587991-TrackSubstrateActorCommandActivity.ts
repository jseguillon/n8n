import type { MigrationContext, ReversibleMigration } from '../migration-types';

export class TrackSubstrateActorCommandActivity1794414587991 implements ReversibleMigration {
	async up({ schemaBuilder: { addColumns, column } }: MigrationContext) {
		await addColumns(
			'substrate_actor_activity',
			[
				column('suspensionClaimedAt').timestampTimezone(3),
				column('activeCommandCount').int.notNull.default(0),
				column('activeCommandLeaseUntil').timestampTimezone(3),
			],
			{ recreatesOnSqlite: true },
		);
	}

	async down({ schemaBuilder: { dropColumns } }: MigrationContext) {
		await dropColumns(
			'substrate_actor_activity',
			['activeCommandLeaseUntil', 'activeCommandCount', 'suspensionClaimedAt'],
			{ recreatesOnSqlite: true },
		);
	}
}
