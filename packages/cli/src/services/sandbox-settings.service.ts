import type { InstanceAiConnectionUpdate, InstanceAiSandboxProvider } from '@n8n/api-types';
import {
	normalizeSandboxProvider as normalizeRuntimeSandboxProvider,
	type DaytonaSandboxConfig,
	type SubstrateSandboxConfig,
} from '@n8n/agents/sandbox';
import { Logger } from '@n8n/backend-common';
import { GlobalConfig } from '@n8n/config';
import type { AgentsConfig, DeploymentConfig, InstanceAiConfig } from '@n8n/config';
import type { OperationContext } from '@n8n/db';
import { Service } from '@n8n/di';
import { ensureError } from '@n8n/utils/errors/ensure-error';
import type { ICredentialDataDecryptedObject } from 'n8n-workflow';
import { nanoid } from 'nanoid';

import {
	InstanceCredentialBroker,
	type InstanceCredentialUse,
	type ResolvedInstanceCredential,
} from '@/credentials/instance-credential-broker';
import { UnprocessableRequestError, OperationalError } from '@n8n/errors';
import { substrateSandboxConfig } from '@/modules/instance-ai/sandbox-provider';

import { AiService } from './ai.service';
import { callAiServiceWithRetry } from '@/utils/ai-service-retry';

const N8N_SANDBOX_HEADER_NAME = 'x-api-key';

type SandboxCredential = {
	type: string;
	data: Record<string, unknown>;
};

function requireConnectionValue(
	type: string,
	data: Record<string, unknown>,
	field: string,
): string {
	const value = data[field];
	if (typeof value !== 'string' || value.trim().length === 0) {
		throw new UnprocessableRequestError(
			`The field "${field}" is required for provider connection type "${type}"`,
		);
	}
	return value.trim();
}

function requireHttpUrl(type: string, data: Record<string, unknown>, field: string): string {
	const value = requireConnectionValue(type, data, field);
	try {
		const url = new URL(value);
		if (url.protocol === 'http:' || url.protocol === 'https:') return value;
	} catch {}
	throw new UnprocessableRequestError(
		`The field "${field}" must be a valid HTTP URL for provider connection type "${type}"`,
	);
}

function parseSandboxServiceCredential({ type, data }: SandboxCredential): string {
	const headerName = requireConnectionValue(type, data, 'name').toLowerCase();
	if (headerName !== N8N_SANDBOX_HEADER_NAME) {
		throw new UnprocessableRequestError(
			`The credential's header name must be "${N8N_SANDBOX_HEADER_NAME}" but is "${headerName}"`,
		);
	}
	return requireConnectionValue(type, data, 'value');
}

function parseDaytonaCredential({ type, data }: SandboxCredential): {
	apiUrl: string;
	apiKey: string;
} {
	return {
		apiUrl: requireHttpUrl(type, data, 'apiUrl'),
		apiKey: requireConnectionValue(type, data, 'apiKey'),
	};
}

export const INSTANCE_AI_DAYTONA_CREDENTIAL_POLICY: InstanceCredentialUse = {
	id: 'instance-ai:sandbox:daytona',
	credentialTypes: ['daytonaApi'],
	validate: parseDaytonaCredential,
};

export const INSTANCE_AI_N8N_SANDBOX_CREDENTIAL_POLICY: InstanceCredentialUse = {
	id: 'instance-ai:sandbox:n8n',
	credentialTypes: ['httpHeaderAuth'],
	validate: parseSandboxServiceCredential,
};

/** Connection fields belong to the instance credential; TLS and token files stay server-owned. */
export function parseSubstrateCredential({ type, data }: SandboxCredential) {
	if (['tokenFile', 'caFile', 'serverName'].some((field) => field in data)) {
		throw new UnprocessableRequestError(
			'Substrate TLS trust and token files are managed on the server',
		);
	}
	if (data.apiToken !== undefined && typeof data.apiToken !== 'string') {
		throw new UnprocessableRequestError('The Substrate access token must be a string');
	}
	const endpoint = requireConnectionValue(type, data, 'endpoint');
	const match = /^(?:\[[a-fA-F0-9:]+\]|[a-zA-Z0-9.-]+):(\d+)$/.exec(endpoint);
	if (!match || Number(match[1]) < 1 || Number(match[1]) > 65535) {
		throw new UnprocessableRequestError(
			'The Substrate control endpoint must be a host:port without a URL scheme',
		);
	}
	const routerUrl = requireHttpUrl(type, data, 'routerUrl');
	const router = new URL(routerUrl);
	if (router.username || router.password || router.search || router.hash) {
		throw new UnprocessableRequestError(
			'The Substrate router URL must not contain credentials, a query, or a fragment',
		);
	}
	const atespace = requireConnectionValue(type, data, 'atespace');
	const template = requireConnectionValue(type, data, 'template');
	for (const value of [atespace, template]) {
		if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value)) {
			throw new UnprocessableRequestError(
				'Substrate Atespace and ActorTemplate must be DNS labels',
			);
		}
	}
	return {
		endpoint,
		routerUrl,
		atespace,
		template,
		token: typeof data.apiToken === 'string' ? data.apiToken.trim() : '',
	};
}

export const INSTANCE_AI_SUBSTRATE_CREDENTIAL_POLICY: InstanceCredentialUse = {
	id: 'instance-ai:sandbox:substrate',
	credentialTypes: ['substrateApi'],
	validate: parseSubstrateCredential,
};

@Service()
export class SandboxSettingsService {
	private readonly config: InstanceAiConfig;

	private readonly agentsConfig: AgentsConfig;

	private readonly deploymentConfig: DeploymentConfig;

	private readonly environmentSandboxProvider: InstanceAiSandboxProvider;

	private credentialUsesRegistered = false;

	constructor(
		globalConfig: GlobalConfig,
		private readonly instanceCredentialBroker: InstanceCredentialBroker,
		private readonly logger: Logger,
		private readonly aiService: AiService,
	) {
		this.config = globalConfig.instanceAi;
		this.agentsConfig = globalConfig.agents;
		this.deploymentConfig = globalConfig.deployment;
		this.config.sandboxProvider = this.getProvider();
		this.environmentSandboxProvider = this.getProvider();
	}

	isAgentSandboxEnabled(): boolean {
		return this.agentsConfig.sandboxEnabled || this.config.sandboxEnabled;
	}

	getProvider(): InstanceAiSandboxProvider {
		return normalizeRuntimeSandboxProvider(this.config.sandboxProvider);
	}

	async getSubstrateConfig(
		connection?: InstanceAiConnectionUpdate,
	): Promise<SubstrateSandboxConfig> {
		if (connection && connection.type !== 'substrateApi')
			throw new UnprocessableRequestError(
				'The Substrate connection must use a substrateApi credential',
			);
		if (!connection && this.environmentSandboxProvider === 'substrate') {
			try {
				return substrateSandboxConfig(this.config);
			} catch {
				/* Partial server config can supply only TLS or a renewable token. */
			}
		}
		const resolved =
			connection ??
			(await this.resolveServiceCredential(
				INSTANCE_AI_SUBSTRATE_CREDENTIAL_POLICY,
				'Substrate sandbox',
			));
		if (!resolved) return substrateSandboxConfig(this.config);
		const parsed = parseSubstrateCredential(resolved);
		if (!this.config.substrateTokenFile && !parsed.token) {
			throw new UnprocessableRequestError(
				'A Substrate access token or server token file is required',
			);
		}
		return {
			enabled: true,
			provider: 'substrate',
			connection: {
				...parsed,
				tokenFile: this.config.substrateTokenFile || '',
				caFile: this.config.substrateCaFile || '',
				serverName:
					process.env.SUBSTRATE_SERVER_NAME?.trim() ||
					parsed.endpoint.replace(/:\d+$/, '').replace(/^\[|\]$/g, ''),
			},
			timeout: this.config.sandboxTimeout,
			ephemeral: this.config.sandboxEphemeral,
		};
	}

	registerCredentialUses(): void {
		if (this.credentialUsesRegistered) return;
		this.instanceCredentialBroker.registerUse(INSTANCE_AI_DAYTONA_CREDENTIAL_POLICY);
		this.instanceCredentialBroker.registerUse(INSTANCE_AI_N8N_SANDBOX_CREDENTIAL_POLICY);
		this.instanceCredentialBroker.registerUse(INSTANCE_AI_SUBSTRATE_CREDENTIAL_POLICY);
		this.credentialUsesRegistered = true;
	}

	async resolveDaytonaSandboxConfig(
		projectId: string,
		options: Pick<DaytonaSandboxConfig, 'image' | 'snapshot'> & { fallbackSnapshot?: string },
	): Promise<
		Pick<
			DaytonaSandboxConfig,
			'daytonaApiUrl' | 'daytonaApiKey' | 'image' | 'snapshot' | 'getAuthToken'
		>
	> {
		const snapshot = options.snapshot?.trim() || undefined;
		if (!this.aiService.isProxyEnabled()) {
			const credentials = await this.resolveDaytonaConfig();
			return {
				daytonaApiUrl: credentials.apiUrl,
				daytonaApiKey: credentials.apiKey,
				image: options.image,
				snapshot,
			};
		}

		const proxySnapshot = snapshot || options.fallbackSnapshot?.trim() || undefined;
		if (!proxySnapshot) {
			throw new OperationalError(
				'The Daytona proxy requires a sandbox snapshot. For Agent sandboxes, set N8N_AGENTS_AI_SANDBOX_SNAPSHOT. For app builds, set N8N_INSTANCE_AI_SANDBOX_SNAPSHOT.',
			);
		}
		const client = await this.aiService.getClient();
		return {
			daytonaApiUrl: client.getSandboxProxyBaseUrl(),
			snapshot: proxySnapshot,
			getAuthToken: async () => {
				const token = await callAiServiceWithRetry(
					'Sandbox proxy token mint',
					async () =>
						await client.getBuilderApiProxyToken({ id: projectId }, { userMessageId: nanoid() }),
					this.logger,
				);
				return token.accessToken;
			},
		};
	}

	async resolveDaytonaConfig(): Promise<{ apiUrl?: string; apiKey?: string }> {
		const { daytonaApiUrl, daytonaApiKey } = this.config;
		const envConfig = {
			apiUrl: daytonaApiUrl || undefined,
			apiKey: daytonaApiKey || undefined,
		};
		const resolved = await this.resolveServiceCredential(
			INSTANCE_AI_DAYTONA_CREDENTIAL_POLICY,
			'Daytona sandbox',
		);
		if (!resolved) return envConfig;
		try {
			return parseDaytonaCredential(resolved);
		} catch (error) {
			this.warnCredentialFallback(
				'Daytona sandbox',
				INSTANCE_AI_DAYTONA_CREDENTIAL_POLICY.id,
				ensureError(error).message,
			);
			return envConfig;
		}
	}

	async resolveN8nSandboxConfig(
		ctx?: OperationContext,
	): Promise<{ serviceUrl?: string; apiKey?: string }> {
		const { n8nSandboxServiceUrl, n8nSandboxServiceApiKey } = this.config;
		const envConfig = {
			serviceUrl: n8nSandboxServiceUrl || undefined,
			apiKey: n8nSandboxServiceApiKey || undefined,
		};
		const resolved = await this.resolveServiceCredential(
			INSTANCE_AI_N8N_SANDBOX_CREDENTIAL_POLICY,
			'n8n Sandbox',
			ctx,
		);
		if (!resolved) return envConfig;

		try {
			const apiKey = parseSandboxServiceCredential(resolved);
			return { serviceUrl: n8nSandboxServiceUrl || undefined, apiKey };
		} catch (error) {
			this.warnCredentialFallback(
				'n8n Sandbox',
				INSTANCE_AI_N8N_SANDBOX_CREDENTIAL_POLICY.id,
				ensureError(error).message,
			);
			return envConfig;
		}
	}

	private async resolveServiceCredential(
		policy: InstanceCredentialUse,
		service: string,
		ctx?: OperationContext,
	): Promise<ResolvedInstanceCredential | null> {
		if (this.deploymentConfig.type === 'cloud') return null;
		const resolved = ctx
			? this.instanceCredentialBroker.resolveForUse(policy, ctx)
			: this.instanceCredentialBroker.resolveForUse(policy);
		return await resolved.catch((error: unknown) => {
			this.warnCredentialFallback(service, policy.id, ensureError(error).message);
			return null;
		});
	}

	private warnCredentialFallback(service: string, credentialUseId: string, reason: string): void {
		this.logger
			.scoped('instance-ai')
			.warn(`Could not resolve the configured ${service} credential; using environment fallback`, {
				credentialUseId,
				error: reason,
			});
	}
}
