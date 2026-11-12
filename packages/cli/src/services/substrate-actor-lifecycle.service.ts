import { createHash } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';

import { Logger } from '@n8n/backend-common';
import { GlobalConfig } from '@n8n/config';
import { SubstrateActorActivityRepository, type SubstrateActorSuspensionClaim } from '@n8n/db';
import { Service } from '@n8n/di';
import { createSandbox } from '@n8n/agents/sandbox';
import type { SubstrateCommandActivityPhase, SubstrateSandboxConfig } from '@n8n/agents/sandbox';

import { SandboxSettingsService } from './sandbox-settings.service';

const ACTOR_ID_PREFIX = 'n8n-';
const SUSPENSION_CLAIM_LEASE_MS = 10 * 60_000;

export type SubstrateActorLifecyclePolicy = {
	autoStopMinutes: number;
	autoDeleteMinutes: number;
	ephemeral: boolean;
};

function connectionFingerprint(connection: SubstrateSandboxConfig['connection']): string {
	return createHash('sha256')
		.update(
			JSON.stringify({
				endpoint: connection.endpoint,
				routerUrl: connection.routerUrl,
				atespace: connection.atespace,
				template: connection.template,
				serverName: connection.serverName,
			}),
		)
		.digest('hex');
}

@Service()
export class SubstrateActorLifecycleService {
	constructor(
		private readonly activityRepository: SubstrateActorActivityRepository,
		private readonly sandboxSettingsService: SandboxSettingsService,
		private readonly logger: Logger,
		private readonly globalConfig: GlobalConfig,
	) {}

	createActivityRecorder(
		connection: SubstrateSandboxConfig['connection'],
		policy: SubstrateActorLifecyclePolicy,
	): (actorId: string, abortSignal?: AbortSignal) => Promise<void> {
		const fingerprint = connectionFingerprint(connection);
		return async (actorId, abortSignal) => {
			const input = {
				actorId,
				connectionFingerprint: fingerprint,
				autoStopMinutes: policy.autoStopMinutes,
				autoDeleteMinutes: policy.autoDeleteMinutes,
				ephemeral: policy.ephemeral,
			};
			while (true) {
				abortSignal?.throwIfAborted();
				if (await this.activityRepository.recordActivity(input)) return;
				await wait(100, undefined, abortSignal ? { signal: abortSignal } : undefined);
			}
		};
	}

	createCommandActivityRecorder(
		connection: SubstrateSandboxConfig['connection'],
		policy: SubstrateActorLifecyclePolicy,
	): (
		actorId: string,
		phase: SubstrateCommandActivityPhase,
		commandTimeoutMs: number,
		abortSignal?: AbortSignal,
	) => Promise<boolean> {
		const recordActivity = this.createActivityRecorder(connection, policy);
		return async (actorId, phase, commandTimeoutMs, abortSignal) => {
			if (phase === 'started') {
				await recordActivity(actorId, abortSignal);
				return await this.activityRepository.recordCommandStarted(actorId, commandTimeoutMs);
			}
			if (phase === 'heartbeat') {
				return await this.activityRepository.recordCommandHeartbeat(actorId, commandTimeoutMs);
			}
			const finishedAt = new Date();
			const delayMs =
				policy.autoStopMinutes > 0 ? this.globalConfig.generic.substrateSandboxSuspendDelayMs : 0;
			if (delayMs > 0) {
				void this.finishCommandAfterDelay(connection, policy, actorId, finishedAt, delayMs);
			} else {
				await this.finishCommandAfterDelay(connection, policy, actorId, finishedAt, 0);
			}
			return true;
		};
	}

	private async finishCommandAfterDelay(
		connection: SubstrateSandboxConfig['connection'],
		policy: SubstrateActorLifecyclePolicy,
		actorId: string,
		finishedAt: Date,
		delayMs: number,
	): Promise<void> {
		try {
			if (delayMs > 0) await wait(delayMs);
			const completion = await this.activityRepository.recordCommandFinished(actorId, finishedAt);
			if (!completion) return;

			const claim = await this.activityRepository.claimCommandFinishedActor(
				completion.actorId,
				new Date(),
			);
			if (claim) void this.finishCommandLifecycle(connection, policy, claim);
		} catch (error) {
			this.logger.warn('Failed to finish Substrate Actor command cleanup', {
				actorId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	private async finishCommandLifecycle(
		connection: SubstrateSandboxConfig['connection'],
		policy: SubstrateActorLifecyclePolicy,
		completion: SubstrateActorSuspensionClaim,
	): Promise<void> {
		try {
			const sandbox = await createSandbox({
				enabled: true,
				provider: 'substrate',
				connection,
				id: this.unprefixActorId(completion.actorId),
				ephemeral: false,
				onActivity: undefined,
				onCommandActivity: undefined,
			});
			if (!sandbox) {
				await this.activityRepository.releaseSuspensionClaim(
					completion.actorId,
					completion.claimedAt,
				);
				return;
			}

			const destroy = sandbox.destroy?.bind(sandbox);
			if (completion.action === 'delete') {
				if (!destroy) {
					await this.activityRepository.releaseSuspensionClaim(
						completion.actorId,
						completion.claimedAt,
					);
					return;
				}
				await destroy();
				const deleted = await this.activityRepository.deleteIfUnchanged(
					completion.actorId,
					completion.activityAt,
					completion.claimedAt,
				);
				if (!deleted) {
					await this.activityRepository.releaseSuspensionClaim(
						completion.actorId,
						completion.claimedAt,
					);
				}
				return;
			}

			const stop = sandbox.stop?.bind(sandbox);
			if (!stop) {
				await this.activityRepository.releaseSuspensionClaim(
					completion.actorId,
					completion.claimedAt,
				);
				return;
			}
			await stop();
			const markedSuspended = await this.activityRepository.markSuspended(
				completion.actorId,
				completion.activityAt,
				completion.claimedAt,
				new Date(),
				policy.autoDeleteMinutes !== 0,
			);
			if (!markedSuspended) {
				await this.activityRepository.releaseSuspensionClaim(
					completion.actorId,
					completion.claimedAt,
				);
				return;
			}
			if (policy.autoDeleteMinutes === 0) {
				if (!destroy) {
					await this.activityRepository.releaseSuspensionClaim(
						completion.actorId,
						completion.claimedAt,
					);
					return;
				}
				await destroy();
				const deleted = await this.activityRepository.deleteIfUnchanged(
					completion.actorId,
					completion.activityAt,
					completion.claimedAt,
				);
				if (!deleted) {
					await this.activityRepository.releaseSuspensionClaim(
						completion.actorId,
						completion.claimedAt,
					);
				}
			}
		} catch (error) {
			await this.activityRepository
				.releaseSuspensionClaim(completion.actorId, completion.claimedAt)
				.catch(() => undefined);
			this.logger.warn('Failed to reclaim a Substrate Actor after its command finished', {
				actorId: completion.actorId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	async forgetActor(actorId: string): Promise<void> {
		await this.activityRepository.deleteActor(actorId);
	}

	async cleanupIdleActors(signal?: AbortSignal, now = Date.now()): Promise<void> {
		if (this.sandboxSettingsService.getProvider() !== 'substrate') return;
		await this.activityRepository.releaseExpiredSuspensionClaims(
			new Date(now - SUSPENSION_CLAIM_LEASE_MS),
		);
		const activities = await this.activityRepository.findAll();
		if (activities.length === 0 || signal?.aborted) return;

		const config = await this.sandboxSettingsService.getSubstrateConfig();
		const fingerprint = connectionFingerprint(config.connection);
		for (const activity of activities) {
			if (signal?.aborted) return;
			if (activity.connectionFingerprint !== fingerprint) continue;

			const idleForMs = now - activity.lastActivityAt.getTime();
			const shouldStop =
				activity.lastSuspendedAt === null &&
				activity.autoStopMinutes > 0 &&
				idleForMs >= activity.autoStopMinutes * 60_000;
			const shouldDelete = activity.ephemeral
				? shouldStop
				: activity.lastSuspendedAt !== null &&
					activity.autoDeleteMinutes >= 0 &&
					now - activity.lastSuspendedAt.getTime() >= activity.autoDeleteMinutes * 60_000;

			if (!shouldStop && !shouldDelete) continue;

			const claimedAt = new Date(now);
			let claimed = false;
			try {
				const sandbox = await createSandbox({
					...config,
					id: this.unprefixActorId(activity.actorId),
					ephemeral: false,
					onActivity: undefined,
					onCommandActivity: undefined,
				});
				if (!sandbox) continue;
				claimed = await this.activityRepository.claimIdleActor(
					activity.actorId,
					activity.lastActivityAt,
					activity.lastSuspendedAt,
					claimedAt,
					new Date(now),
				);
				if (!claimed) continue;
				const destroy = sandbox.destroy?.bind(sandbox);

				if (shouldDelete) {
					if (!destroy) {
						await this.activityRepository.releaseSuspensionClaim(activity.actorId, claimedAt);
						continue;
					}
					await destroy();
					const deleted = await this.activityRepository.deleteIfUnchanged(
						activity.actorId,
						activity.lastActivityAt,
						claimedAt,
					);
					if (!deleted)
						await this.activityRepository.releaseSuspensionClaim(activity.actorId, claimedAt);
					continue;
				}

				// This adapter is fresh, so BaseSandbox._stop() would no-op while it is pending.
				const stop = sandbox.stop?.bind(sandbox);
				if (!stop) {
					await this.activityRepository.releaseSuspensionClaim(activity.actorId, claimedAt);
					continue;
				}
				await stop();
				const markedSuspended = await this.activityRepository.markSuspended(
					activity.actorId,
					activity.lastActivityAt,
					claimedAt,
					new Date(now),
					activity.autoDeleteMinutes !== 0,
				);
				if (markedSuspended && activity.autoDeleteMinutes === 0) {
					if (!destroy) {
						await this.activityRepository.releaseSuspensionClaim(activity.actorId, claimedAt);
						continue;
					}
					await destroy();
					const deleted = await this.activityRepository.deleteIfUnchanged(
						activity.actorId,
						activity.lastActivityAt,
						claimedAt,
					);
					if (!deleted)
						await this.activityRepository.releaseSuspensionClaim(activity.actorId, claimedAt);
				} else if (!markedSuspended) {
					await this.activityRepository.releaseSuspensionClaim(activity.actorId, claimedAt);
				}
			} catch (error) {
				if (claimed) {
					await this.activityRepository
						.releaseSuspensionClaim(activity.actorId, claimedAt)
						.catch(() => undefined);
				}
				this.logger.warn('Failed to clean up idle Substrate Actor', {
					actorId: activity.actorId,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}

	private unprefixActorId(actorId: string): string {
		if (!actorId.startsWith(ACTOR_ID_PREFIX)) {
			throw new Error('Invalid Substrate Actor ID');
		}
		return actorId.slice(ACTOR_ID_PREFIX.length);
	}
}
