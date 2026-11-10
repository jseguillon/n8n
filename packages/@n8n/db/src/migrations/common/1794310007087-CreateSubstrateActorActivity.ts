import type { MigrationContext, ReversibleMigration } from '../migration-types';

export class CreateSubstrateActorActivity1794310007087 implements ReversibleMigration {
	async up({ schemaBuilder: { createTable, column } }: MigrationContext) {
		await createTable('substrate_actor_activity')
			.withColumns(
				column('actorId').varchar(63).primary.notNull,
				column('connectionFingerprint').varchar(64).notNull,
				column('lastActivityAt').timestampTimezone(3).notNull,
				column('lastSuspendedAt').timestampTimezone(3),
				column('autoStopMinutes').double.notNull,
				column('autoDeleteMinutes').double.notNull,
				column('ephemeral').bool.notNull.default(false),
			)
			.withIndexOn(['connectionFingerprint', 'lastActivityAt']).withTimestamps;
	}

	async down({ schemaBuilder: { dropTable } }: MigrationContext) {
		await dropTable('substrate_actor_activity');
	}
}
