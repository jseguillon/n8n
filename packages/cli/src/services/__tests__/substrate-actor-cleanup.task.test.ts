import { Time } from '@n8n/constants';
import { mock } from 'vitest-mock-extended';

import type { SubstrateActorLifecycleService } from '../substrate-actor-lifecycle.service';
import { SubstrateActorCleanupTask } from '../substrate-actor-cleanup.task';

describe('SubstrateActorCleanupTask', () => {
	it('runs its recovery sweep once per hour', () => {
		const task = new SubstrateActorCleanupTask(mock<SubstrateActorLifecycleService>());

		expect(task.schedule).toEqual({ kind: 'interval', intervalSeconds: Time.hours.toSeconds });
	});
});
