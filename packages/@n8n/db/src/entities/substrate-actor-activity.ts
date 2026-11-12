import { Column, Entity, Index, PrimaryColumn } from '@n8n/typeorm';

import { DateTimeColumn, JsonColumn, dbType, WithTimestamps } from './abstract-entity';

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

	@DateTimeColumn({ nullable: true })
	suspensionClaimedAt: Date | null;

	@Column({ type: 'int', default: 0 })
	activeCommandCount: number;

	@DateTimeColumn({ nullable: true })
	activeCommandLeaseUntil: Date | null;

	@Column({ type: 'int', default: 0 })
	revision: number;

	@JsonColumn({ default: () => "'{}'" })
	operationLeases: Record<string, number>;

	@DateTimeColumn({ nullable: true })
	suspendAfter: Date | null;

	@Column({ type: dbType === 'postgresdb' ? 'uuid' : 'varchar', nullable: true })
	claimToken: string | null;

	@DateTimeColumn({ nullable: true })
	claimUntil: Date | null;

	@Column({ type: activityIntervalColumnType })
	autoStopMinutes: number;

	@Column({ type: activityIntervalColumnType })
	autoDeleteMinutes: number;

	@Column({ type: 'boolean', default: false })
	ephemeral: boolean;
}
