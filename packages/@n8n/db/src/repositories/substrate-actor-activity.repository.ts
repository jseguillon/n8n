import { Service } from '@n8n/di';
import { DataSource } from '@n8n/typeorm';
import type { UpdateResult } from '@n8n/typeorm';

import { SubstrateActorActivity } from '../entities/substrate-actor-activity';
import type { TransactionRunner } from '../services/transaction';
import { BaseRepository } from './base-repository';

class SubstrateActorActivityTable extends BaseRepository<SubstrateActorActivity> {
	constructor(dataSource: DataSource, transactionRunner: TransactionRunner) {
		super(SubstrateActorActivity, dataSource.manager, transactionRunner);
	}
}

export type SubstrateActorActivityInput = Pick<
	SubstrateActorActivity,
	'actorId' | 'connectionFingerprint' | 'autoStopMinutes' | 'autoDeleteMinutes' | 'ephemeral'
>;

@Service()
export class SubstrateActorActivityRepository {
	private readonly table: SubstrateActorActivityTable;

	constructor(dataSource: DataSource, transactionRunner: TransactionRunner) {
		this.table = new SubstrateActorActivityTable(dataSource, transactionRunner);
	}

	async recordActivity(input: SubstrateActorActivityInput, activityAt = new Date()): Promise<void> {
		await this.table.upsert(
			{
				...input,
				lastActivityAt: activityAt,
				lastSuspendedAt: null,
			},
			['actorId'],
		);
	}

	async findAll(): Promise<SubstrateActorActivity[]> {
		return await this.table.find();
	}

	async markSuspended(
		actorId: string,
		expectedActivityAt: Date,
		suspendedAt = new Date(),
	): Promise<boolean> {
		const result: UpdateResult = await this.table.update(
			{ actorId, lastActivityAt: expectedActivityAt },
			{ lastSuspendedAt: suspendedAt },
		);
		return (result.affected ?? 0) > 0;
	}

	async deleteIfUnchanged(actorId: string, expectedActivityAt: Date): Promise<boolean> {
		const result = await this.table.delete({ actorId, lastActivityAt: expectedActivityAt });
		return (result.affected ?? 0) > 0;
	}

	async deleteActor(actorId: string): Promise<void> {
		await this.table.delete({ actorId });
	}
}
