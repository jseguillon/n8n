import { readFile } from 'node:fs/promises';
import type { Root } from 'protobufjs';
import { z } from 'zod';

export interface SubstrateConnection {
	endpoint: string;
	routerUrl: string;
	atespace: string;
	template: string;
	tokenFile: string;
	/** Static bearer credential. A server-mounted token file takes precedence. */
	token?: string;
	caFile: string;
	routerCredentialFile?: string;
	serverName: string;
	/** Server-owned JSON policy copied to Actors that have no policy. */
	egressPolicyFile?: string;
}

const egressDestinationSchema = z
	.object({
		hostnames: z
			.array(
				z
					.string()
					.trim()
					.min(1)
					.max(253)
					.regex(/^[a-zA-Z0-9.*-]+$/),
			)
			.min(1)
			.max(256),
		ports: z.union([
			z.object({ numbers: z.array(z.number().int().min(1).max(65535)).min(1).max(16) }).strict(),
			z.object({ all: z.object({}).strict() }).strict(),
		]),
	})
	.strict();

const egressPolicySchema = z
	.object({
		rules: z
			.array(
				z.union([
					z.object({ tlsPassthrough: egressDestinationSchema }).strict(),
					z.object({ http: egressDestinationSchema }).strict(),
				]),
			)
			.max(256),
	})
	.strict();

export type SubstrateEgressPolicy = z.infer<typeof egressPolicySchema>;

// Wire-compatible subset of the Substrate v1 Control API (Apache-2.0).
// https://github.com/agent-substrate/substrate/blob/v1.0.0/api/ateapi/v1/ateapi.proto
const API_PACKAGE = 'substrate.ateapi.v1';
const PROTOCOL = `syntax = "proto3";
package ${API_PACKAGE};
message ObjectRef { string atespace = 1; string name = 2; }
message ResourceMetadata { string atespace = 1; string name = 2; }
message Actor { ResourceMetadata metadata = 1; ObjectRef actor_template = 2; }
message CreateActorRequest { Actor actor = 1; }
message GetActorRequest { ObjectRef actor = 1; }
enum DurabilityMode {
  DURABILITY_MODE_UNSPECIFIED = 0;
  DURABILITY_MODE_SYNCHRONOUS = 1;
  DURABILITY_MODE_ASYNCHRONOUS = 2;
}
message SuspendOptions { DurabilityMode mode = 1; }
message SuspendActorRequest { ObjectRef actor = 1; SuspendOptions options = 2; }
message ResumeActorRequest { ObjectRef actor = 1; }
message DeleteOptions { int64 version = 1; string uid = 2; }
message DeleteActorRequest { ObjectRef actor = 1; DeleteOptions options = 2; }
message EgressPolicy { ResourceMetadata metadata = 1; repeated EgressRule rules = 2; }
message EgressRule { HttpRule http = 1; TlsPassthroughRule tls_passthrough = 3; }
message HttpRule { repeated string hostnames = 1; Ports ports = 2; }
message TlsPassthroughRule { repeated string hostnames = 1; Ports ports = 2; }
message Ports { AllPorts all = 1; repeated int32 numbers = 2; }
message AllPorts {}
message CreateActorEgressPolicyRequest { ObjectRef actor = 1; EgressPolicy egress_policy = 2; }
`;
let protocol: Root | undefined;
const actorSchema = z.object({
	metadata: z.object({ atespace: z.string(), name: z.string() }),
	actorTemplate: z.object({ atespace: z.string(), name: z.string() }),
});

export function isSubstrateStatus(error: unknown, code: number): boolean {
	return error instanceof Error && 'code' in error && error.code === code;
}

export class SubstrateControl {
	constructor(
		private readonly connection: SubstrateConnection,
		private readonly timeoutMs: number,
	) {}

	async call(
		method:
			| 'CreateActor'
			| 'GetActor'
			| 'ResumeActor'
			| 'SuspendActor'
			| 'DeleteActor'
			| 'CreateActorEgressPolicy',
		name: string,
		egressPolicy?: SubstrateEgressPolicy,
	): Promise<unknown> {
		if (method === 'CreateActorEgressPolicy' && !egressPolicy)
			throw new Error('A configured Substrate egress policy is required');
		const [{ Client, credentials, Metadata }, protobufjs] = await Promise.all([
			import('@grpc/grpc-js'),
			import('protobufjs'),
		]);
		// Handle protobufjs as the ESM default and the CommonJS namespace.
		const protobuf = protobufjs.default ?? protobufjs;
		const schema = (protocol ??= protobuf.parse(PROTOCOL).root);
		const c = this.connection;
		const [ca, token] = await Promise.all([
			c.caFile
				? readFile(c.caFile).catch(() => {
						throw new Error('The server Substrate CA file could not be read');
					})
				: undefined,
			c.tokenFile
				? readFile(c.tokenFile, 'utf8').catch(() => {
						throw new Error('The server Substrate token file could not be read');
					})
				: (c.token ?? ''),
		]);
		if (!token.trim()) throw new Error('A Substrate access token or server token file is required');
		const client = new Client(c.endpoint, credentials.createSsl(ca), {
			'grpc.ssl_target_name_override': c.serverName,
			'grpc.default_authority': c.serverName,
		});
		const metadata = new Metadata();
		metadata.set('authorization', `Bearer ${token.trim()}`);
		const ref = { atespace: c.atespace, name };
		const requestType =
			method === 'CreateActor'
				? 'CreateActorRequest'
				: method === 'CreateActorEgressPolicy'
					? 'CreateActorEgressPolicyRequest'
					: `${method}Request`;
		const type = schema.lookupType(`${API_PACKAGE}.${requestType}`);
		const request =
			method === 'CreateActor'
				? { actor: { metadata: ref, actorTemplate: { atespace: c.atespace, name: c.template } } }
				: method === 'CreateActorEgressPolicy'
					? {
							actor: ref,
							egressPolicy: {
								metadata: { atespace: c.atespace, name: 'default' },
								rules: egressPolicy?.rules,
							},
						}
					: method === 'SuspendActor'
						? { actor: ref, options: { mode: 1 } }
						: { actor: ref };
		try {
			return await new Promise<unknown>((resolve, reject) => {
				client.makeUnaryRequest(
					`/${API_PACKAGE}.Control/${method}`,
					(value: object) => Buffer.from(type.encode(type.fromObject(value)).finish()),
					(buffer: Buffer) =>
						method === 'GetActor'
							? schema
									.lookupType(`${API_PACKAGE}.Actor`)
									.toObject(schema.lookupType(`${API_PACKAGE}.Actor`).decode(buffer))
							: undefined,
					request,
					metadata,
					{ deadline: Date.now() + this.timeoutMs },
					(error, value) => (error ? reject(error) : resolve(value)),
				);
			});
		} finally {
			client.close();
		}
	}

	async ensureActor(name: string): Promise<void> {
		const { status } = await import('@grpc/grpc-js');
		const policy = await this.readDefaultEgressPolicy();
		try {
			await this.call('CreateActor', name);
		} catch (error) {
			if (!isSubstrateStatus(error, status.ALREADY_EXISTS)) throw error;
		}
		const actor = actorSchema.parse(await this.call('GetActor', name));
		if (
			actor.actorTemplate.atespace !== this.connection.atespace ||
			actor.actorTemplate.name !== this.connection.template
		) {
			throw new Error('The existing Actor uses a different Substrate template');
		}
		if (policy) {
			try {
				await this.call('CreateActorEgressPolicy', name, policy);
			} catch (error) {
				// An Actor's existing policy remains authoritative.
				if (!isSubstrateStatus(error, status.ALREADY_EXISTS)) throw error;
			}
		}
		await this.call('ResumeActor', name);
	}

	private async readDefaultEgressPolicy(): Promise<SubstrateEgressPolicy | undefined> {
		if (!this.connection.egressPolicyFile) return undefined;
		const contents = await readFile(this.connection.egressPolicyFile, 'utf8').catch(() => {
			throw new Error('The server Substrate egress policy file could not be read');
		});
		try {
			if (Buffer.byteLength(contents) > 1024 * 1024) throw new Error('Policy is too large');
			return egressPolicySchema.parse(JSON.parse(contents));
		} catch {
			throw new Error(
				'The server Substrate egress policy file is invalid; use supported HTTP or TLS passthrough rules',
			);
		}
	}

	async deleteActor(name: string): Promise<void> {
		const { status } = await import('@grpc/grpc-js');
		try {
			await this.call('DeleteActor', name);
		} catch (error) {
			if (!isSubstrateStatus(error, status.NOT_FOUND)) throw error;
		}
	}
}
