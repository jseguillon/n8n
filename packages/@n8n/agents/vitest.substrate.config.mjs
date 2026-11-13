// Real ATE tests do not use LLM credentials, dotenv files, or recorded traffic.
export default {
	test: {
		include: ['src/__tests__/integration/substrate-sandbox.integration.test.ts'],
		testTimeout: 120_000,
		hookTimeout: 30_000,
		maxWorkers: 1,
	},
};
