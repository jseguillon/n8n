import { createHash, randomUUID } from 'node:crypto';

import {
	createSandbox,
	type SubstrateOperationRecorder,
	type SubstrateSandboxConfig,
} from '@n8n/agents/sandbox';
import { Logger } from '@n8n/backend-common';
import { GlobalConfig } from '@n8n/config';
import { SubstrateActorActivityRepository, type SubstrateActorActivityInput } from '@n8n/db';
import { Service } from '@n8n/di';

import { SandboxSettingsService } from './sandbox-settings.service';

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
	private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

	constructor(
		private readonly activityRepository: SubstrateActorActivityRepository,
		private readonly sandboxSettingsService: SandboxSettingsService,
		private readonly logger: Logger,
		private readonly globalConfig: GlobalConfig,
	) {}

	createOperationRecorder(
		connection: SubstrateSandboxConfig['connection'],
		policy: SubstrateActorLifecyclePolicy,
	): SubstrateOperationRecorder {
		const fingerprint = connectionFingerprint(connection);
		return async (actorId, operationId, phase, timeoutMs, abortSignal) => {
			if (phase === 'started') {
				abortSignal?.throwIfAborted();
				const input: SubstrateActorActivityInput = {
					actorId,
					connectionFingerprint: fingerprint,
					...policy,
				};
				const started = await this.activityRepository.startOperation(
					input,
					operationId,
					timeoutMs + 60_000,
				);
				if (started) this.cancelTimer(actorId);
				return started;
			}
			if (phase === 'heartbeat')
				return await this.activityRepository.heartbeatOperation(
					actorId,
					operationId,
					timeoutMs + 60_000,
				);
			const deadline = await this.activityRepository.finishOperation(
				actorId,
				operationId,
				this.globalConfig.generic.substrateSandboxSuspendDelayMs,
			);
			if (deadline) this.schedule(actorId, connection, deadline);
			return true;
		};
	}

	private cancelTimer(actorId: string) {
		clearTimeout(this.timers.get(actorId));
		this.timers.delete(actorId);
	}

	private schedule(
		actorId: string,
		connection: SubstrateSandboxConfig['connection'],
		deadline: Date,
	) {
		this.cancelTimer(actorId);
		const timer = setTimeout(
			() => {
				if (this.timers.get(actorId) !== timer) return;
				// Node timers can fire before the persisted deadline by a millisecond.
				if (Date.now() < deadline.getTime()) {
					this.schedule(actorId, connection, deadline);
					return;
				}
				this.timers.delete(actorId);
				void this.reclaim(actorId, connection).catch((error: unknown) =>
					this.logFailure(actorId, error),
				);
			},
			Math.max(0, deadline.getTime() - Date.now()),
		);
		timer.unref();
		this.timers.set(actorId, timer);
	}

	private logFailure(actorId: string, error: unknown) {
		this.logger.warn('Failed to reclaim a Substrate Actor', {
			actorId,
			error: error instanceof Error ? error.message : String(error),
		});
	}

	private async reclaim(
		actorId: string,
		connection: SubstrateSandboxConfig['connection'],
		recovery = false,
		now = new Date(),
	) {
		const claim = await this.activityRepository.claimDueActor(
			actorId,
			connectionFingerprint(connection),
			randomUUID(),
			now,
			recovery,
		);
		if (!claim) return;
		try {
			if (!actorId.startsWith('n8n-')) throw new Error('Invalid Substrate Actor ID');
			// The RPC deadline is shorter than the database claim lease.
			const sandbox = await createSandbox({
				enabled: true,
				provider: 'substrate',
				connection,
				id: actorId.slice(4),
				ephemeral: false,
				timeout: 60_000,
			});
			if (!sandbox) throw new Error('Substrate sandbox is unavailable');
			const reclaim =
				claim.action === 'delete' ? sandbox.destroy?.bind(sandbox) : sandbox.stop?.bind(sandbox);
			if (!reclaim) throw new Error('Substrate lifecycle action is unavailable');
			await reclaim();
			await this.activityRepository.completeClaim(claim);
		} catch (error) {
			await this.activityRepository.releaseClaim(claim).catch(() => undefined);
			this.logFailure(actorId, error);
		}
	}

	async forgetActor(actorId: string): Promise<void> {
		this.cancelTimer(actorId);
		await this.activityRepository.deleteActor(actorId);
	}

	async cleanupIdleActors(signal?: AbortSignal, now = Date.now()): Promise<void> {
		if (this.sandboxSettingsService.getProvider() !== 'substrate') return;
		const config = await this.sandboxSettingsService.getSubstrateConfig();
		const fingerprint = connectionFingerprint(config.connection);
		for (const activity of await this.activityRepository.findAll()) {
			if (signal?.aborted) return;
			if (activity.connectionFingerprint !== fingerprint) continue;
			try {
				await this.reclaim(activity.actorId, config.connection, true, new Date(now));
			} catch (error) {
				this.logFailure(activity.actorId, error);
			}
		}
	}
}
