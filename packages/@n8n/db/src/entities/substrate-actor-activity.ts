import { Column, Entity, Index, PrimaryColumn } from '@n8n/typeorm';

import { DateTimeColumn, dbType, WithTimestamps } from './abstract-entity';

const activityIntervalColumnType = dbType === 'postgresdb' ? 'float8' : 'float';

@Entity({ name: 'substrate_actor_activity' })
@Index(['connectionFingerprint', 'lastActivityAt'])
export class SubstrateActorActivity extends WithTimestamps {
	@PrimaryColumn({ type: 'varchar', length: 63 })
	actorId: string;

	@Column({ type: 'varchar', length: 64 })
	connectionFingerprint: string;

	@DateTimeColumn()
	lastActivityAt: Date;

	@DateTimeColumn({ nullable: true })
	lastSuspendedAt: Date | null;

	@Column({ type: activityIntervalColumnType })
	autoStopMinutes: number;

	@Column({ type: activityIntervalColumnType })
	autoDeleteMinutes: number;

	@Column({ type: 'boolean', default: false })
	ephemeral: boolean;
}
