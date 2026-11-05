import type { InstanceAiSandboxProvider } from '@n8n/api-types';
import { normalizeSandboxProvider as normalizeRuntimeSandboxProvider } from '@n8n/agents/sandbox';
import { OperationalError } from 'n8n-workflow';
import type { InstanceAiConfig } from '@n8n/config';
import type { SubstrateSandboxConfig } from '@n8n/agents/sandbox';

export function substrateSandboxConfig(config: InstanceAiConfig): SubstrateSandboxConfig {
	const connection = {
		endpoint: config.substrateEndpoint,
		routerUrl: config.substrateRouterUrl,
		atespace: config.substrateAtespace,
		template: config.substrateTemplate,
		tokenFile: config.substrateTokenFile,
		caFile: config.substrateCaFile,
		serverName: config.substrateServerName,
	};
	if (Object.values(connection).some((value) => !value?.trim())) {
		throw new OperationalError(
			'Configure the SUBSTRATE_API_ENDPOINT, SUBSTRATE_ROUTER_URL, SUBSTRATE_ATESPACE, SUBSTRATE_ACTOR_TEMPLATE, SUBSTRATE_TOKEN_FILE and SUBSTRATE_CA_FILE environment variables.',
		);
	}
	return {
		enabled: true,
		provider: 'substrate',
		connection,
		timeout: config.sandboxTimeout,
		ephemeral: config.sandboxEphemeral,
	};
}

/** Coerce a raw config/env value to a supported provider, falling back to the default. */
export function normalizeSandboxProvider(value: string | undefined): InstanceAiSandboxProvider {
	return normalizeRuntimeSandboxProvider(value);
}

export const N8N_SANDBOX_SERVICE_URL_REQUIRED_MESSAGE =
	'N8N_SANDBOX_SERVICE_URL is required when Instance AI sandbox provider is n8n-sandbox.';

/** Require a non-empty n8n sandbox service URL, raising a clear operator-facing error otherwise. */
export function requireN8nSandboxServiceUrl(value: string): string {
	const serviceUrl = value.trim();
	if (serviceUrl.length === 0) {
		throw new OperationalError(N8N_SANDBOX_SERVICE_URL_REQUIRED_MESSAGE);
	}
	return serviceUrl;
}
