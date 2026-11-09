import { expect, it, vi } from 'vitest';

const { clientClose } = vi.hoisted(() => ({ clientClose: vi.fn() }));

vi.mock('@grpc/grpc-js', () => {
	class ClientMock {
		constructor(_target: string, _credentials: unknown, _options: unknown) {}

		makeUnaryRequest(
			_path: string,
			_serialize: (value: object) => Buffer,
			_deserialize: (value: Buffer) => unknown,
			_request: object,
			_metadata: unknown,
			_options: { deadline: number },
			done: (error: Error | null, value?: unknown) => void,
		) {
			done(null);
		}

		close() {
			clientClose();
		}
	}

	class MetadataMock {
		set(_key: string, _value: string) {}
	}

	return {
		Client: ClientMock,
		Metadata: MetadataMock,
		credentials: { createSsl: () => ({}) },
	};
});

vi.mock('protobufjs', async () => {
	const actual = await vi.importActual<typeof import('protobufjs')>('protobufjs');
	return { default: { parse: actual.parse } };
});

import { SubstrateControl } from '../workspace/sandbox/substrate-control';

it('loads protobufjs from its CommonJS default export', async () => {
	const control = new SubstrateControl(
		{
			endpoint: 'control.example.test:443',
			routerUrl: 'https://router.example.test',
			atespace: 'test-space',
			template: 'test-template',
			token: 'fixture-token',
			tokenFile: '',
			caFile: '',
			serverName: 'api.ate-system.svc',
		},
		1_000,
	);

	await expect(control.call('DeleteActor', 'test-actor')).resolves.toBeUndefined();
	expect(clientClose).toHaveBeenCalledOnce();
});
