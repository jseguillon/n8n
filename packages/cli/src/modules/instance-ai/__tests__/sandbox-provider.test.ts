import { instanceAiSandboxProviderSchema } from '@n8n/api-types';
import { normalizeSandboxProvider as normalizeRuntimeSandboxProvider } from '@n8n/agents/sandbox';
import { OperationalError } from 'n8n-workflow';

import {
	N8N_SANDBOX_SERVICE_URL_REQUIRED_MESSAGE,
	normalizeSandboxProvider,
	requireN8nSandboxServiceUrl,
	substrateSandboxConfig,
} from '../sandbox-provider';

describe('sandbox-provider', () => {
	describe('normalizeSandboxProvider', () => {
		it('stays aligned with runtime sandbox providers', () => {
			for (const provider of instanceAiSandboxProviderSchema.options) {
				expect(normalizeRuntimeSandboxProvider(provider)).toBe(provider);
			}
		});

		it('returns supported sandbox providers unchanged', () => {
			expect(normalizeSandboxProvider('n8n-sandbox')).toBe('n8n-sandbox');
			expect(normalizeSandboxProvider('daytona')).toBe('daytona');
		});

		it('falls back to n8n-sandbox for unsupported values', () => {
			expect(normalizeSandboxProvider('local')).toBe('n8n-sandbox');
			expect(normalizeSandboxProvider(undefined)).toBe('n8n-sandbox');
		});
	});

	describe('requireN8nSandboxServiceUrl', () => {
		it('trims and returns a configured service URL', () => {
			expect(requireN8nSandboxServiceUrl('  http://sandbox-api:8080  ')).toBe(
				'http://sandbox-api:8080',
			);
		});

		it('throws an operational error when the service URL is missing', () => {
			expect(() => requireN8nSandboxServiceUrl('   ')).toThrow(OperationalError);
			expect(() => requireN8nSandboxServiceUrl('   ')).toThrow(
				N8N_SANDBOX_SERVICE_URL_REQUIRED_MESSAGE,
			);
		});
	});

	describe('substrateSandboxConfig', () => {
		const config = {
			substrateEndpoint: '127.0.0.1:18443',
			substrateRouterUrl: 'https://router.example.com',
			substrateAtespace: 'test-space',
			substrateTemplate: 'test-template',
			substrateTokenFile: '/run/substrate/token',
			substrateCaFile: '/run/substrate/ca.crt',
			substrateServerName: 'api.ate-system.svc',
			sandboxTimeout: 60_000,
			sandboxEphemeral: true,
		};

		it('returns the configured Substrate connection', () => {
			expect(substrateSandboxConfig(config as never)).toEqual({
				enabled: true,
				provider: 'substrate',
				connection: {
					endpoint: '127.0.0.1:18443',
					routerUrl: 'https://router.example.com',
					atespace: 'test-space',
					template: 'test-template',
					tokenFile: '/run/substrate/token',
					caFile: '/run/substrate/ca.crt',
					serverName: 'api.ate-system.svc',
				},
				timeout: 60_000,
				ephemeral: true,
			});
		});

		it.each(['', '   '])('rejects a missing required connection value %j', (value) => {
			expect(() =>
				substrateSandboxConfig({ ...config, substrateTokenFile: value } as never),
			).toThrow(OperationalError);
		});
	});
});
