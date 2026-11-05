import type { ICredentialType, INodeProperties } from 'n8n-workflow';

export class SubstrateApi implements ICredentialType {
	name = 'substrateApi';

	displayName = 'Agent Substrate';

	documentationUrl = 'https://github.com/agent-substrate/substrate';

	properties: INodeProperties[] = [
		{
			displayName: 'Control API Endpoint',
			name: 'endpoint',
			type: 'string',
			required: true,
			default: '',
			placeholder: 'api.ate-system.svc:443',
		},
		{
			displayName: 'Router URL',
			name: 'routerUrl',
			type: 'string',
			required: true,
			default: '',
			placeholder: 'http://atenet-router.ate-system.svc',
		},
		{ displayName: 'Atespace', name: 'atespace', type: 'string', required: true, default: '' },
		{
			displayName: 'Actor Template',
			name: 'template',
			type: 'string',
			required: true,
			default: '',
		},
		{
			displayName: 'Access Token',
			name: 'apiToken',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			description:
				'Bearer token. Leave empty when the operator provides a renewable token file on the server.',
		},
	];
}
