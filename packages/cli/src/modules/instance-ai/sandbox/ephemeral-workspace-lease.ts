import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';

import type { SubstrateOperationRecorder } from '@n8n/agents/sandbox';
import { Time } from '@n8n/constants';

/** Keep a cached workspace across tool calls. A stopped main stops renewing its lease. */
export async function holdEphemeralWorkspace(
	actorId: string,
	record: SubstrateOperationRecorder,
	startTimeout: number,
	onRenewalFailure: () => void,
) {
	const id = randomUUID();
	const interval = Time.minutes.toMilliseconds;
	const signal = AbortSignal.timeout(startTimeout);
	while (!(await record(actorId, id, 'started', interval, signal))) {
		await wait(100, undefined, { signal });
	}
	let renewing = false;
	const timer = setInterval(async () => {
		if (renewing) return;
		renewing = true;
		try {
			if (!(await record(actorId, id, 'heartbeat', interval))) onRenewalFailure();
		} catch {
			onRenewalFailure();
		} finally {
			renewing = false;
		}
	}, interval / 2);
	timer.unref();
	return {
		stopRenewing: () => clearInterval(timer),
		release: async () => {
			clearInterval(timer);
			await record(actorId, id, 'finished', interval);
		},
	};
}
