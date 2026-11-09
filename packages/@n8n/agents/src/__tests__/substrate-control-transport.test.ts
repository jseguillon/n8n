import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'protobufjs';

const {
	metadataEntries,
	newClient,
	makeUnaryRequest,
	clientClose,
	createSsl,
	readFile,
	MetadataMock,
	ClientMock,
} = vi.hoisted(() => {
	const entries = new Map<string, string>();
	const newClient = vi.fn();
	const makeUnaryRequest = vi.fn();
	const clientClose = vi.fn();
	const createSsl = vi.fn(() => ({ kind: 'ssl' }));
	const readFile = vi.fn();

	class MetadataMock {
		set(key: string, value: string) {
			entries.set(key, value);
		}
	}

	class ClientMock {
		constructor(target: string, credentials: unknown, options: unknown) {
			newClient(target, credentials, options);
		}

		makeUnaryRequest(
			path: string,
			serialize: (value: object) => Buffer,
			deserialize: (value: Buffer) => unknown,
			request: object,
			metadata: MetadataMock,
			options: { deadline: number },
			done: (error: Error | null, value?: unknown) => void,
		) {
			const result = makeUnaryRequest({
				path,
				serialize,
				deserialize,
				request,
				metadata,
				options,
				done,
			});
			if (result instanceof Error) done(result);
			else done(null, result === undefined ? undefined : deserialize(result));
		}

		close() {
			clientClose();
		}
	}

	return {
		metadataEntries: entries,
		newClient,
		makeUnaryRequest,
		clientClose,
		createSsl,
		readFile,
		MetadataMock,
		ClientMock,
	};
});

vi.mock('@grpc/grpc-js', () => ({
	Client: ClientMock,
	Metadata: MetadataMock,
	credentials: { createSsl },
	status: { ALREADY_EXISTS: 6, NOT_FOUND: 5 },
}));

vi.mock('node:fs/promises', () => ({ readFile }));

import { SubstrateControl } from '../workspace/sandbox/substrate-control';

const connection = {
	endpoint: 'control.example.test:443',
	routerUrl: 'https://router.example.test',
	atespace: 'test-space',
	template: 'test-template',
	tokenFile: '/run/substrate/token',
	caFile: '/run/substrate/ca.crt',
	serverName: 'api.ate-system.svc',
};

afterEach(() => {
	metadataEntries.clear();
	newClient.mockClear();
	makeUnaryRequest.mockClear();
	clientClose.mockClear();
	createSsl.mockClear();
	readFile.mockReset();
});

describe('SubstrateControl transport', () => {
	it.each(['ca', 'token'])(
		'reports a server %s file error without returning its path',
		async (file) => {
			readFile.mockRejectedValue(new Error('ENOENT: /operator/private-connection-file'));
			const control = new SubstrateControl(
				{
					...connection,
					caFile: file === 'ca' ? '/operator/private-connection-file' : '',
					tokenFile: file === 'token' ? '/operator/private-connection-file' : '',
					token: 'fixture-token',
				},
				1_000,
			);
			await expect(control.call('DeleteActor', 'n8n-workspace')).rejects.toThrow(
				`The server Substrate ${file === 'ca' ? 'CA' : 'token'} file could not be read`,
			);
			expect(newClient).not.toHaveBeenCalled();
		},
	);
	it('uses an encrypted credential token and system trust without reading server files', async () => {
		const control = new SubstrateControl(
			{ ...connection, tokenFile: '', caFile: '', token: 'fixture-token' },
			1_000,
		);
		await control.call('DeleteActor', 'n8n-workspace');
		expect(readFile).not.toHaveBeenCalled();
		expect(createSsl).toHaveBeenCalledWith(undefined);
		expect(metadataEntries.get('authorization')).toBe('Bearer fixture-token');
	});

	it('reads a renewed server token in preference to a static credential', async () => {
		readFile.mockImplementation(async (path: string) =>
			path.endsWith('ca.crt') ? Buffer.from('ca') : 'renewed-token',
		);
		const control = new SubstrateControl({ ...connection, token: 'unused-fixture' }, 1_000);
		await control.call('DeleteActor', 'n8n-workspace');
		expect(metadataEntries.get('authorization')).toBe('Bearer renewed-token');
	});
	it('uses TLS, bearer metadata, and a bounded deadline', async () => {
		const ca = Buffer.from('test-ca');
		readFile.mockImplementation(async (path: string) =>
			path.endsWith('ca.crt') ? ca : ' token\n',
		);
		const control = new SubstrateControl(connection, 1_000);
		const before = Date.now();

		await control.call('DeleteActor', 'n8n-workspace');

		expect(createSsl).toHaveBeenCalledWith(ca);
		expect(newClient).toHaveBeenCalledWith('control.example.test:443', expect.anything(), {
			'grpc.ssl_target_name_override': 'api.ate-system.svc',
			'grpc.default_authority': 'api.ate-system.svc',
		});
		expect(metadataEntries.get('authorization')).toBe('Bearer token');
		expect(makeUnaryRequest.mock.calls[0][0]).toMatchObject({
			path: '/substrate.ateapi.v1.Control/DeleteActor',
			request: { actor: { atespace: 'test-space', name: 'n8n-workspace' } },
		});
		expect(makeUnaryRequest.mock.calls[0][0].options.deadline).toBeGreaterThanOrEqual(
			before + 1_000,
		);
		expect(clientClose).toHaveBeenCalledOnce();
	});

	it('closes the client when the control API returns an error', async () => {
		readFile.mockImplementation(async (path: string) =>
			path.endsWith('ca.crt') ? Buffer.from('ca') : 'token',
		);
		makeUnaryRequest.mockReturnValueOnce(new Error('control unavailable'));
		const control = new SubstrateControl(connection, 1_000);

		await expect(control.call('SuspendActor', 'n8n-workspace')).rejects.toThrow(
			'control unavailable',
		);

		expect(clientClose).toHaveBeenCalledOnce();
	});

	it('serializes Actor creation and decodes GetActor responses', async () => {
		const protocol = parse(`syntax = "proto3";
package substrate.ateapi.v1;
message ObjectRef { string atespace = 1; string name = 2; }
message ResourceMetadata { string atespace = 1; string name = 2; }
message Actor { ResourceMetadata metadata = 1; ObjectRef actor_template = 2; }
message CreateActorRequest { Actor actor = 1; }
`).root;
		const actor = protocol.lookupType('substrate.ateapi.v1.Actor');
		readFile.mockImplementation(async (path: string) =>
			path.endsWith('ca.crt') ? Buffer.from('ca') : 'token',
		);
		makeUnaryRequest.mockReturnValueOnce(undefined).mockReturnValueOnce(
			Buffer.from(
				actor
					.encode(
						actor.fromObject({
							metadata: { atespace: 'test-space', name: 'n8n-workspace' },
							actorTemplate: { atespace: 'test-space', name: 'test-template' },
						}),
					)
					.finish(),
			),
		);
		const control = new SubstrateControl(connection, 1_000);

		await control.call('CreateActor', 'n8n-workspace');
		const create = makeUnaryRequest.mock.calls[0][0];
		const createRequest = protocol
			.lookupType('substrate.ateapi.v1.CreateActorRequest')
			.decode(create.serialize(create.request));
		expect(
			protocol.lookupType('substrate.ateapi.v1.CreateActorRequest').toObject(createRequest),
		).toMatchObject({
			actor: {
				metadata: { atespace: 'test-space', name: 'n8n-workspace' },
				actorTemplate: { atespace: 'test-space', name: 'test-template' },
			},
		});

		await expect(control.call('GetActor', 'n8n-workspace')).resolves.toMatchObject({
			metadata: { atespace: 'test-space', name: 'n8n-workspace' },
			actorTemplate: { atespace: 'test-space', name: 'test-template' },
		});
	});

	it('creates a TLS passthrough policy for the npm registry', async () => {
		const protocol = parse(`syntax = "proto3";
package substrate.ateapi.v1;
message ObjectRef { string atespace = 1; string name = 2; }
message ResourceMetadata { string atespace = 1; string name = 2; }
message EgressPolicy { ResourceMetadata metadata = 1; repeated EgressRule rules = 2; }
message EgressRule { TlsPassthroughRule tls_passthrough = 3; }
message TlsPassthroughRule { repeated string hostnames = 1; Ports ports = 2; }
message Ports { repeated int32 numbers = 2; }
message CreateActorEgressPolicyRequest { ObjectRef actor = 1; EgressPolicy egress_policy = 2; }
`).root;
		readFile.mockImplementation(async (path: string) =>
			path.endsWith('ca.crt') ? Buffer.from('ca') : 'token',
		);
		const control = new SubstrateControl(connection, 1_000);

		await control.call('CreateActorEgressPolicy', 'n8n-workspace');

		const request = makeUnaryRequest.mock.calls[0][0];
		const decoded = protocol
			.lookupType('substrate.ateapi.v1.CreateActorEgressPolicyRequest')
			.decode(request.serialize(request.request));
		expect(request.path).toBe('/substrate.ateapi.v1.Control/CreateActorEgressPolicy');
		expect(
			protocol.lookupType('substrate.ateapi.v1.CreateActorEgressPolicyRequest').toObject(decoded),
		).toMatchObject({
			actor: { atespace: 'test-space', name: 'n8n-workspace' },
			egressPolicy: {
				metadata: { atespace: 'test-space', name: 'default' },
				rules: [
					{
						tlsPassthrough: {
							hostnames: ['registry.npmjs.org'],
							ports: { numbers: [443] },
						},
					},
				],
			},
		});
	});

	it('suspends with synchronous snapshot durability', async () => {
		const protocol = parse(`syntax = "proto3";
package substrate.ateapi.v1;
message ObjectRef { string atespace = 1; string name = 2; }
enum DurabilityMode {
  DURABILITY_MODE_UNSPECIFIED = 0;
  DURABILITY_MODE_SYNCHRONOUS = 1;
  DURABILITY_MODE_ASYNCHRONOUS = 2;
}
message SuspendOptions { DurabilityMode mode = 1; }
message SuspendActorRequest { ObjectRef actor = 1; SuspendOptions options = 2; }
`).root;
		readFile.mockImplementation(async (path: string) =>
			path.endsWith('ca.crt') ? Buffer.from('ca') : 'token',
		);
		const control = new SubstrateControl(connection, 1_000);

		await control.call('SuspendActor', 'n8n-workspace');

		const request = makeUnaryRequest.mock.calls[0][0];
		const decoded = protocol
			.lookupType('substrate.ateapi.v1.SuspendActorRequest')
			.decode(request.serialize(request.request));
		expect(request.path).toBe('/substrate.ateapi.v1.Control/SuspendActor');
		expect(
			protocol.lookupType('substrate.ateapi.v1.SuspendActorRequest').toObject(decoded),
		).toMatchObject({
			actor: { atespace: 'test-space', name: 'n8n-workspace' },
			options: { mode: 1 },
		});
	});
});
