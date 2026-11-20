import { createHash, randomUUID } from 'node:crypto';

import {
	createSandbox,
	type SubstrateOperationRecorder,
	type SubstrateSandboxConfig,
} from '@n8n/agents/sandbox';
import { Logger } from '@n8n/backend-common';
import { SubstrateActorActivityRepository, type SubstrateActorActivityInput } from '@n8n/db';
import { Service } from '@n8n/di';
import { runSerially } from '@n8n/utils/run-serially';

import { SandboxSettingsService } from './sandbox-settings.service';

export type SubstrateActorLifecyclePolicy = {
	autoStopMinutes: number;
	autoDeleteMinutes: number;
	ephemeral: boolean;
};

function connectionFingerprint(connection: SubstrateSandboxConfig['connection']): string {
	// Token and certificate rotation must not change which Actor activity this connection owns.
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
	private readonly operationUpdates = new Map<string, Promise<unknown>>();

	constructor(
		private readonly activityRepository: SubstrateActorActivityRepository,
		private readonly sandboxSettingsService: SandboxSettingsService,
		private readonly logger: Logger,
	) {}

	createOperationRecorder(
		connection: SubstrateSandboxConfig['connection'],
		policy: SubstrateActorLifecyclePolicy,
	): SubstrateOperationRecorder {
		const fingerprint = connectionFingerprint(connection);
		const previousFingerprints = (connection.previousTemplates ?? []).map((template) =>
			connectionFingerprint({ ...connection, template }),
		);
		return async (actorId, operationId, phase, timeoutMs, abortSignal) => {
			// Parallel transfers must not compete to update the same activity row.
			if (phase === 'started') {
				return await runSerially(this.operationUpdates, actorId, async () => {
					abortSignal?.throwIfAborted();
					const input: SubstrateActorActivityInput = {
						actorId,
						connectionFingerprint: fingerprint,
						...policy,
					};
					if (previousFingerprints.length > 0) {
						return await this.activityRepository.startOperation(
							input,
							operationId,
							timeoutMs + 60_000,
							undefined,
							previousFingerprints,
						);
					}
					return await this.activityRepository.startOperation(
						input,
						operationId,
						timeoutMs + 60_000,
					);
				});
			}
			if (phase === 'heartbeat')
				return await runSerially(
					this.operationUpdates,
					actorId,
					async () =>
						await this.activityRepository.heartbeatOperation(
							actorId,
							operationId,
							timeoutMs + 60_000,
						),
				);
			const deadline = await runSerially(
				this.operationUpdates,
				actorId,
				async () => await this.activityRepository.finishOperation(actorId, operationId, 0),
			);
			// A slow control RPC must not block admission checks or heartbeats in the local update queue.
			if (deadline) await this.reclaim(actorId, connection);
			return true;
		};
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
		await this.activityRepository.deleteActor(actorId);
	}

	async cleanupIdleActors(signal?: AbortSignal, now = Date.now()): Promise<void> {
		if (this.sandboxSettingsService.getProvider() !== 'substrate') return;
		const config = await this.sandboxSettingsService.getSubstrateConfig();
		const connections = [
			config.connection,
			...(config.connection.previousTemplates ?? []).map((template) => ({
				...config.connection,
				template,
			})),
		];
		for (const activity of await this.activityRepository.findAll()) {
			if (signal?.aborted) return;
			const connection = connections.find(
				(candidate) => connectionFingerprint(candidate) === activity.connectionFingerprint,
			);
			if (!connection) continue;
			try {
				await this.reclaim(activity.actorId, connection, true, new Date(now));
			} catch (error) {
				this.logFailure(activity.actorId, error);
			}
		}
	}
}
