import { Client, credentials, Metadata, status } from '@grpc/grpc-js';
import { readFile } from 'node:fs/promises';
import { parse } from 'protobufjs';
import { z } from 'zod';

export interface SubstrateConnection {
	endpoint: string;
	routerUrl: string;
	atespace: string;
	template: string;
	tokenFile: string;
	caFile: string;
	serverName: string;
}

// Wire-compatible subset of Substrate v0.4 ateapi.proto (Apache-2.0).
// https://github.com/agent-substrate/substrate/blob/v0.4.0/pkg/proto/ateapipb/ateapi.proto
const protocol = parse(`syntax = "proto3";
message ObjectRef { string atespace = 1; string name = 2; }
message Actor { ObjectRef metadata = 1; ObjectRef actor_template = 4; }
message CreateActorRequest { Actor actor = 1; }
message ActorRequest { ObjectRef actor = 1; bool any_state = 2; }
`).root;
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
		method: 'CreateActor' | 'GetActor' | 'ResumeActor' | 'SuspendActor' | 'DeleteActor',
		name: string,
	): Promise<unknown> {
		const c = this.connection;
		const [ca, token] = await Promise.all([readFile(c.caFile), readFile(c.tokenFile, 'utf8')]);
		const client = new Client(c.endpoint, credentials.createSsl(ca), {
			'grpc.ssl_target_name_override': c.serverName,
			'grpc.default_authority': c.serverName,
		});
		const metadata = new Metadata();
		metadata.set('authorization', `Bearer ${token.trim()}`);
		const ref = { atespace: c.atespace, name };
		const type = protocol.lookupType(
			method === 'CreateActor' ? 'CreateActorRequest' : 'ActorRequest',
		);
		const request =
			method === 'CreateActor'
				? { actor: { metadata: ref, actorTemplate: { atespace: c.atespace, name: c.template } } }
				: { actor: ref, ...(method === 'DeleteActor' ? { anyState: true } : {}) };
		try {
			return await new Promise<unknown>((resolve, reject) => {
				client.makeUnaryRequest(
					`/ateapi.Control/${method}`,
					(value: object) => Buffer.from(type.encode(type.fromObject(value)).finish()),
					(buffer: Buffer) =>
						method === 'GetActor'
							? protocol.lookupType('Actor').toObject(protocol.lookupType('Actor').decode(buffer))
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
		await this.call('ResumeActor', name);
	}

	async deleteActor(name: string): Promise<void> {
		try {
			await this.call('DeleteActor', name);
		} catch (error) {
			if (!isSubstrateStatus(error, status.NOT_FOUND)) throw error;
		}
	}
}
