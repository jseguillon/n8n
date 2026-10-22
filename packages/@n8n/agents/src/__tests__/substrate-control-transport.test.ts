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
			path: '/ateapi.Control/DeleteActor',
			request: { actor: { atespace: 'test-space', name: 'n8n-workspace' }, anyState: true },
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
message ObjectRef { string atespace = 1; string name = 2; }
message Actor { ObjectRef metadata = 1; ObjectRef actor_template = 4; }
message CreateActorRequest { Actor actor = 1; }
`).root;
		const actor = protocol.lookupType('Actor');
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
			.lookupType('CreateActorRequest')
			.decode(create.serialize(create.request));
		expect(protocol.lookupType('CreateActorRequest').toObject(createRequest)).toMatchObject({
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
});
