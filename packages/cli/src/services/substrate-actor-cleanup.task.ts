import { Time } from '@n8n/constants';
import { clusterTarget, intervalFromSeconds, SystemTask } from '@n8n/decorators';
import type { SystemTaskSchedule } from '@n8n/decorators';

import { SubstrateActorLifecycleService } from './substrate-actor-lifecycle.service';

@SystemTask()
export class SubstrateActorCleanupTask implements SystemTask {
	readonly name = 'substrate-actor-cleanup';
	readonly schedule: SystemTaskSchedule = intervalFromSeconds(Time.hours.toSeconds);
	readonly target = clusterTarget({ scheduler: { retryOnFailure: true } });

	constructor(private readonly lifecycle: SubstrateActorLifecycleService) {}

	async run(signal: AbortSignal): Promise<void> {
		await this.lifecycle.cleanupIdleActors(signal);
	}
}
