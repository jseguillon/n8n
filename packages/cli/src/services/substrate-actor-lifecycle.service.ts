import { createHash } from 'node:crypto';

import { Logger } from '@n8n/backend-common';
import { SubstrateActorActivityRepository } from '@n8n/db';
import { Service } from '@n8n/di';
import { createSandbox } from '@n8n/agents/sandbox';
import type { SubstrateSandboxConfig } from '@n8n/agents/sandbox';

import { SandboxSettingsService } from './sandbox-settings.service';

const ACTOR_ID_PREFIX = 'n8n-';

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
	) {}

	createActivityRecorder(
		connection: SubstrateSandboxConfig['connection'],
		policy: SubstrateActorLifecyclePolicy,
	): (actorId: string) => Promise<void> {
		const fingerprint = connectionFingerprint(connection);
		return async (actorId) => {
			await this.activityRepository.recordActivity({
				actorId,
				connectionFingerprint: fingerprint,
				autoStopMinutes: policy.autoStopMinutes,
				autoDeleteMinutes: policy.autoDeleteMinutes,
				ephemeral: policy.ephemeral,
			});
		};
	}

	async forgetActor(actorId: string): Promise<void> {
		await this.activityRepository.deleteActor(actorId);
	}

	async cleanupIdleActors(signal?: AbortSignal, now = Date.now()): Promise<void> {
		if (this.sandboxSettingsService.getProvider() !== 'substrate') return;
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

			try {
				const sandbox = await createSandbox({
					...config,
					id: this.unprefixActorId(activity.actorId),
					ephemeral: false,
					onActivity: undefined,
				});
				if (!sandbox) continue;
				const destroy = sandbox.destroy?.bind(sandbox);

				if (shouldDelete) {
					if (!destroy) continue;
					await destroy();
					await this.activityRepository.deleteIfUnchanged(
						activity.actorId,
						activity.lastActivityAt,
					);
					continue;
				}

				// This adapter is fresh, so BaseSandbox._stop() would no-op while it is pending.
				const stop = sandbox.stop?.bind(sandbox);
				if (!stop) continue;
				await stop();
				const markedSuspended = await this.activityRepository.markSuspended(
					activity.actorId,
					activity.lastActivityAt,
					new Date(now),
				);
				if (markedSuspended && activity.autoDeleteMinutes === 0) {
					if (!destroy) continue;
					await destroy();
					await this.activityRepository.deleteIfUnchanged(
						activity.actorId,
						activity.lastActivityAt,
					);
				}
			} catch (error) {
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
