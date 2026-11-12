import { Service } from '@n8n/di';
import { DataSource, IsNull, LessThanOrEqual, type UpdateResult } from '@n8n/typeorm';

import { SubstrateActorActivity } from '../entities/substrate-actor-activity';
import { TransactionRunner } from '../services/transaction';
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

	async recordActivity(
		input: SubstrateActorActivityInput,
		activityAt = new Date(),
	): Promise<boolean> {
		for (;;) {
			const activity = await this.table.findOneBy({ actorId: input.actorId });
			if (!activity) {
				await this.table.upsert({ ...input, lastActivityAt: activityAt, lastSuspendedAt: null }, [
					'actorId',
				]);
				continue;
			}
			if (activity.suspensionClaimedAt) return false;

			const recordedAt = new Date(
				Math.max(activityAt.getTime(), activity.lastActivityAt.getTime()),
			);
			const result = await this.table.update(
				{
					actorId: input.actorId,
					lastActivityAt: activity.lastActivityAt,
					suspensionClaimedAt: IsNull(),
				},
				{ ...input, lastActivityAt: recordedAt, lastSuspendedAt: null },
			);
			if ((result.affected ?? 0) > 0) return true;
		}
	}

	async findAll(): Promise<SubstrateActorActivity[]> {
		return await this.table.find();
	}

	async markSuspended(
		actorId: string,
		expectedActivityAt: Date,
		claimedAt: Date,
		suspendedAt = new Date(),
		releaseClaim = true,
	): Promise<boolean> {
		const result: UpdateResult = await this.table.update(
			{ actorId, lastActivityAt: expectedActivityAt, suspensionClaimedAt: claimedAt },
			{
				lastSuspendedAt: suspendedAt,
				suspensionClaimedAt: releaseClaim ? null : claimedAt,
				activeCommandCount: 0,
				activeCommandLeaseUntil: null,
			},
		);
		return (result.affected ?? 0) > 0;
	}

	async claimIdleActor(
		actorId: string,
		expectedActivityAt: Date,
		expectedSuspendedAt: Date | null,
		claimedAt: Date,
		now = new Date(),
	): Promise<boolean> {
		const common = {
			actorId,
			lastActivityAt: expectedActivityAt,
			lastSuspendedAt: expectedSuspendedAt ?? IsNull(),
			suspensionClaimedAt: IsNull(),
		};
		const eligibleConditions = [
			{ ...common, activeCommandCount: 0 },
			{ ...common, activeCommandLeaseUntil: IsNull() },
			{ ...common, activeCommandLeaseUntil: LessThanOrEqual(now) },
		];
		for (const where of eligibleConditions) {
			const result = await this.table.update(where, {
				suspensionClaimedAt: claimedAt,
				activeCommandCount: 0,
				activeCommandLeaseUntil: null,
			});
			if ((result.affected ?? 0) > 0) return true;
		}
		return false;
	}

	async releaseExpiredSuspensionClaims(expiredBefore: Date): Promise<void> {
		await this.table.update(
			{ suspensionClaimedAt: LessThanOrEqual(expiredBefore) },
			{ suspensionClaimedAt: null },
		);
	}

	async releaseSuspensionClaim(actorId: string, claimedAt: Date): Promise<void> {
		await this.table.update(
			{ actorId, suspensionClaimedAt: claimedAt },
			{ suspensionClaimedAt: null },
		);
	}

	async recordCommandStarted(
		actorId: string,
		commandTimeoutMs: number,
		activityAt = new Date(),
	): Promise<boolean> {
		const activity = await this.table.findOneBy({ actorId });
		if (!activity || activity.suspensionClaimedAt) return false;

		const hasActiveCommands =
			activity.activeCommandCount > 0 &&
			activity.activeCommandLeaseUntil !== null &&
			activity.activeCommandLeaseUntil.getTime() > activityAt.getTime();
		const recordedAt = new Date(Math.max(activityAt.getTime(), activity.lastActivityAt.getTime()));
		const newLeaseUntil = new Date(recordedAt.getTime() + commandTimeoutMs + 60_000);
		const activeCommandLeaseUntil = hasActiveCommands
			? new Date(Math.max(activity.activeCommandLeaseUntil!.getTime(), newLeaseUntil.getTime()))
			: newLeaseUntil;
		const result = await this.table.update(
			{ actorId, lastActivityAt: activity.lastActivityAt, suspensionClaimedAt: IsNull() },
			{
				lastActivityAt: recordedAt,
				lastSuspendedAt: null,
				activeCommandCount: hasActiveCommands ? activity.activeCommandCount + 1 : 1,
				activeCommandLeaseUntil,
			},
		);
		return (result.affected ?? 0) > 0;
	}

	async recordCommandHeartbeat(
		actorId: string,
		commandTimeoutMs: number,
		activityAt = new Date(),
	): Promise<boolean> {
		const activity = await this.table.findOneBy({ actorId });
		if (
			!activity ||
			activity.suspensionClaimedAt ||
			activity.activeCommandCount === 0 ||
			!activity.activeCommandLeaseUntil
		) {
			return false;
		}

		const recordedAt = new Date(Math.max(activityAt.getTime(), activity.lastActivityAt.getTime()));
		const newLeaseUntil = new Date(recordedAt.getTime() + commandTimeoutMs + 60_000);
		const result = await this.table.update(
			{ actorId, lastActivityAt: activity.lastActivityAt, suspensionClaimedAt: IsNull() },
			{
				lastActivityAt: recordedAt,
				activeCommandLeaseUntil: new Date(
					Math.max(activity.activeCommandLeaseUntil.getTime(), newLeaseUntil.getTime()),
				),
			},
		);
		return (result.affected ?? 0) > 0;
	}

	async recordCommandFinished(actorId: string, activityAt = new Date()): Promise<void> {
		for (;;) {
			const activity = await this.table.findOneBy({ actorId });
			if (!activity || activity.suspensionClaimedAt) return;
			const recordedAt = new Date(
				Math.max(activityAt.getTime(), activity.lastActivityAt.getTime()),
			);

			const hasActiveCommands =
				activity.activeCommandCount > 0 &&
				activity.activeCommandLeaseUntil !== null &&
				activity.activeCommandLeaseUntil.getTime() > recordedAt.getTime();
			const remainingCommandCount = hasActiveCommands
				? Math.max(0, activity.activeCommandCount - 1)
				: 0;
			const result = await this.table.update(
				{ actorId, lastActivityAt: activity.lastActivityAt, suspensionClaimedAt: IsNull() },
				{
					lastActivityAt: recordedAt,
					lastSuspendedAt: null,
					activeCommandCount: remainingCommandCount,
					activeCommandLeaseUntil:
						remainingCommandCount > 0 ? new Date(recordedAt.getTime() + 60_000) : null,
				},
			);
			if ((result.affected ?? 0) > 0) return;
		}
	}

	async deleteIfUnchanged(
		actorId: string,
		expectedActivityAt: Date,
		claimedAt?: Date,
	): Promise<boolean> {
		const result = await this.table.delete({
			actorId,
			lastActivityAt: expectedActivityAt,
			...(claimedAt ? { suspensionClaimedAt: claimedAt } : {}),
		});
		return (result.affected ?? 0) > 0;
	}

	async deleteActor(actorId: string): Promise<void> {
		await this.table.delete({ actorId });
	}
}
