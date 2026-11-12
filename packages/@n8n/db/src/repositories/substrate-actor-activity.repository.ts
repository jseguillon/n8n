import { Service } from '@n8n/di';
import { DataSource } from '@n8n/typeorm';

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

export type SubstrateActorSuspensionClaim = {
	actorId: string;
	claimToken: string;
	action: 'suspend' | 'delete';
};

const CLAIM_LEASE_MS = 10 * 60_000;

function liveOperations(activity: SubstrateActorActivity, now: number) {
	return Object.fromEntries(
		Object.entries(activity.operationLeases).filter(([, until]) => until > now),
	);
}

function claimIsLive(activity: SubstrateActorActivity, now: number) {
	return (
		activity.suspensionClaimedAt !== null &&
		(activity.claimUntil?.getTime() ?? activity.suspensionClaimedAt.getTime() + CLAIM_LEASE_MS) >
			now
	);
}

@Service()
export class SubstrateActorActivityRepository {
	private readonly table: SubstrateActorActivityTable;

	constructor(dataSource: DataSource, transactionRunner: TransactionRunner) {
		this.table = new SubstrateActorActivityTable(dataSource, transactionRunner);
	}

	private get rows() {
		return this.table.managerFor({}).getRepository(SubstrateActorActivity);
	}

	private async update(activity: SubstrateActorActivity, changes: Partial<SubstrateActorActivity>) {
		const result = await this.rows.update(
			{ actorId: activity.actorId, revision: activity.revision },
			{ ...changes, revision: activity.revision + 1 },
		);
		return (result.affected ?? 0) > 0;
	}

	async startOperation(
		input: SubstrateActorActivityInput,
		operationId: string,
		leaseMs: number,
		now = new Date(),
	): Promise<boolean> {
		for (;;) {
			const activity = await this.rows.findOneBy({ actorId: input.actorId });
			if (!activity) {
				// Ignore concurrent creation instead of overwriting another operation's lease.
				await this.rows
					.createQueryBuilder()
					.insert()
					.values({
						...input,
						lastActivityAt: now,
						lastSuspendedAt: null,
						suspensionClaimedAt: null,
						operationLeases: {},
					})
					.orIgnore()
					.execute();
				continue;
			}
			if (
				activity.connectionFingerprint !== input.connectionFingerprint ||
				claimIsLive(activity, now.getTime())
			)
				return false;
			const leases = liveOperations(activity, now.getTime());
			leases[operationId] = Math.max(leases[operationId] ?? 0, now.getTime() + leaseMs);
			if (
				await this.update(activity, {
					...input,
					operationLeases: leases,
					lastActivityAt: now,
					lastSuspendedAt: null,
					suspendAfter: null,
					suspensionClaimedAt: null,
					claimToken: null,
					claimUntil: null,
				})
			)
				return true;
		}
	}

	async heartbeatOperation(
		actorId: string,
		operationId: string,
		leaseMs: number,
		now = new Date(),
	): Promise<boolean> {
		for (;;) {
			const activity = await this.rows.findOneBy({ actorId });
			if (
				!activity ||
				claimIsLive(activity, now.getTime()) ||
				!Object.hasOwn(activity.operationLeases, operationId)
			)
				return false;
			const leases = liveOperations(activity, now.getTime());
			leases[operationId] = Math.max(
				activity.operationLeases[operationId],
				now.getTime() + leaseMs,
			);
			if (await this.update(activity, { operationLeases: leases, lastActivityAt: now }))
				return true;
		}
	}

	async finishOperation(
		actorId: string,
		operationId: string,
		delayMs: number,
		now = new Date(),
	): Promise<Date | null> {
		for (;;) {
			const activity = await this.rows.findOneBy({ actorId });
			// Duplicate and late completions cannot release another operation's lease.
			if (
				!activity ||
				!Object.hasOwn(activity.operationLeases, operationId) ||
				claimIsLive(activity, now.getTime())
			)
				return null;
			const leases = liveOperations(activity, now.getTime());
			delete leases[operationId];
			const suspendAfter =
				activity.autoStopMinutes > 0 && Object.keys(leases).length === 0
					? new Date(now.getTime() + delayMs)
					: null;
			if (
				await this.update(activity, { operationLeases: leases, lastActivityAt: now, suspendAfter })
			)
				return suspendAfter;
		}
	}

	async claimDueActor(
		actorId: string,
		fingerprint: string,
		claimToken: string,
		now = new Date(),
		recovery = false,
	): Promise<SubstrateActorSuspensionClaim | undefined> {
		for (;;) {
			const activity = await this.rows.findOneBy({ actorId });
			if (
				!activity ||
				activity.connectionFingerprint !== fingerprint ||
				claimIsLive(activity, now.getTime())
			)
				return;
			if (Object.keys(liveOperations(activity, now.getTime())).length > 0) return;
			// Keep legacy command leases until they expire during an upgrade.
			if (
				activity.activeCommandCount > 0 &&
				(activity.activeCommandLeaseUntil?.getTime() ?? 0) > now.getTime()
			)
				return;
			const shouldDelete =
				activity.lastSuspendedAt !== null &&
				activity.autoDeleteMinutes >= 0 &&
				now.getTime() - activity.lastSuspendedAt.getTime() >= activity.autoDeleteMinutes * 60_000;
			const shouldSuspend =
				activity.lastSuspendedAt === null &&
				activity.autoStopMinutes > 0 &&
				(activity.suspendAfter !== null
					? activity.suspendAfter.getTime() <= now.getTime()
					: recovery &&
						now.getTime() - activity.lastActivityAt.getTime() >= activity.autoStopMinutes * 60_000);
			if (!shouldDelete && !shouldSuspend) return;
			const action =
				shouldDelete || activity.ephemeral || activity.autoDeleteMinutes === 0
					? 'delete'
					: 'suspend';
			if (
				await this.update(activity, {
					claimToken,
					claimUntil: new Date(now.getTime() + CLAIM_LEASE_MS),
					suspensionClaimedAt: now,
					operationLeases: {},
					activeCommandCount: 0,
					activeCommandLeaseUntil: null,
				})
			) {
				return { actorId, claimToken, action };
			}
		}
	}

	async completeClaim(claim: SubstrateActorSuspensionClaim, now = new Date()): Promise<boolean> {
		for (;;) {
			const activity = await this.rows.findOneBy({ actorId: claim.actorId });
			if (!activity || activity.claimToken !== claim.claimToken) return false;
			if (claim.action === 'delete') {
				const result = await this.rows.delete({
					actorId: claim.actorId,
					revision: activity.revision,
					claimToken: claim.claimToken,
				});
				if ((result.affected ?? 0) > 0) return true;
			} else if (
				await this.update(activity, {
					lastSuspendedAt: now,
					suspendAfter: null,
					suspensionClaimedAt: null,
					claimUntil: null,
					claimToken: null,
				})
			)
				return true;
		}
	}

	async releaseClaim(claim: SubstrateActorSuspensionClaim): Promise<void> {
		for (;;) {
			const activity = await this.rows.findOneBy({ actorId: claim.actorId });
			if (!activity || activity.claimToken !== claim.claimToken) return;
			if (
				await this.update(activity, {
					suspensionClaimedAt: null,
					claimUntil: null,
					claimToken: null,
				})
			)
				return;
		}
	}

	async findAll(): Promise<SubstrateActorActivity[]> {
		return await this.rows.find();
	}

	async deleteActor(actorId: string): Promise<void> {
		await this.rows.delete({ actorId });
	}
}
