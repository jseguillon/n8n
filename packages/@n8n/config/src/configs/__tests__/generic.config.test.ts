import { Container } from '@n8n/di';

import { GenericConfig } from '../generic.config';

describe('GenericConfig Substrate suspend delay', () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		Container.reset();
	});

	it('defaults to five seconds', () => {
		expect(Container.get(GenericConfig).substrateSandboxSuspendDelayMs).toBe(5_000);
	});

	it.each([
		['0', 0],
		['1500', 1_500],
	])('parses N8N_SUBSTRATE_SANDBOX_SUSPEND_DELAY_MS=%s as %i milliseconds', (value, expected) => {
		vi.stubEnv('N8N_SUBSTRATE_SANDBOX_SUSPEND_DELAY_MS', value);
		Container.reset();
		expect(Container.get(GenericConfig).substrateSandboxSuspendDelayMs).toBe(expected);
	});
});
