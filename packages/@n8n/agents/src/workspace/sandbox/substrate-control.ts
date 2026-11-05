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
	serverName: string;
}

// Wire-compatible subset of Substrate v0.4 ateapi.proto (Apache-2.0).
// https://github.com/agent-substrate/substrate/blob/v0.4.0/pkg/proto/ateapipb/ateapi.proto
const PROTOCOL = `syntax = "proto3";
message ObjectRef { string atespace = 1; string name = 2; }
message Actor { ObjectRef metadata = 1; ObjectRef actor_template = 4; }
message CreateActorRequest { Actor actor = 1; }
message ActorRequest { ObjectRef actor = 1; bool any_state = 2; }
message EgressPolicy { ObjectRef metadata = 1; repeated EgressRule rules = 2; }
message EgressRule { TLSPassthroughRule tls_passthrough = 3; }
message TLSPassthroughRule { repeated string hostnames = 1; Ports ports = 2; }
message Ports { repeated int32 numbers = 2; }
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
	): Promise<unknown> {
		const [{ Client, credentials, Metadata }, { parse }] = await Promise.all([
			import('@grpc/grpc-js'),
			import('protobufjs'),
		]);
		const schema = (protocol ??= parse(PROTOCOL).root);
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
		const type = schema.lookupType(
			method === 'CreateActor'
				? 'CreateActorRequest'
				: method === 'CreateActorEgressPolicy'
					? 'CreateActorEgressPolicyRequest'
					: 'ActorRequest',
		);
		const request =
			method === 'CreateActor'
				? { actor: { metadata: ref, actorTemplate: { atespace: c.atespace, name: c.template } } }
				: method === 'CreateActorEgressPolicy'
					? {
							actor: ref,
							egressPolicy: {
								metadata: { atespace: c.atespace, name: 'default' },
								rules: [
									{
										tlsPassthrough: {
											hostnames: ['registry.npmjs.org'],
											ports: { numbers: [443] },
										},
									},
								],
							},
						}
					: { actor: ref, ...(method === 'DeleteActor' ? { anyState: true } : {}) };
		try {
			return await new Promise<unknown>((resolve, reject) => {
				client.makeUnaryRequest(
					`/ateapi.Control/${method}`,
					(value: object) => Buffer.from(type.encode(type.fromObject(value)).finish()),
					(buffer: Buffer) =>
						method === 'GetActor'
							? schema.lookupType('Actor').toObject(schema.lookupType('Actor').decode(buffer))
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
		try {
			await this.call('CreateActorEgressPolicy', name);
		} catch (error) {
			if (!isSubstrateStatus(error, status.ALREADY_EXISTS)) throw error;
		}
		await this.call('ResumeActor', name);
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
