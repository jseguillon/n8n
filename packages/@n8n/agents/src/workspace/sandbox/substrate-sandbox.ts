import { SandboxServiceError } from '@n8n/sandbox-client';
import { readFile } from 'node:fs/promises';
import type {
	CopyFileRequest,
	DeleteFileOptions,
	FileContent,
	ListFilesOptions,
	MoveFileRequest,
} from '@n8n/sandbox-client';
import { createHash, randomUUID } from 'node:crypto';
import { Agent } from 'undici';
import { z } from 'zod';

import { BaseSandbox } from './base-sandbox';
import { toShellCommand } from './shell-command';
import { SubstrateControl, type SubstrateConnection } from './substrate-control';
import type { SandboxFileClient } from './types';
import type { CommandResult, ExecuteCommandOptions } from '../types';

const fileStat = z
	.object({
		name: z.string(),
		path: z.string(),
		type: z.enum(['file', 'directory']),
		size: z.number(),
		created_at: z.string(),
		modified_at: z.string(),
	})
	.transform(({ created_at, modified_at, ...stat }) => ({
		...stat,
		createdAt: created_at,
		modifiedAt: modified_at,
	}));
const fileEntry = z
	.object({
		name: z.string(),
		size: z.number(),
		is_dir: z.boolean(),
		type: z.enum(['file', 'directory']),
		mod_time: z.string(),
	})
	.transform(({ is_dir, mod_time, ...entry }) => ({ ...entry, isDir: is_dir, modTime: mod_time }));
const MAX_EXECUTION_EVENT_BYTES = 1024 * 1024;
const MAX_EXECUTION_OUTPUT_BYTES = 10 * 1024 * 1024;
const eventSchema = z.discriminatedUnion('type', [
	z.object({ type: z.literal('started'), exec_id: z.string() }),
	z.object({ type: z.literal('stdout'), data: z.string() }),
	z.object({ type: z.literal('stderr'), data: z.string() }),
	z.object({ type: z.literal('error'), error: z.string() }),
	z.object({
		type: z.literal('exit'),
		exit_code: z.number(),
		success: z.boolean(),
		execution_time_ms: z.number(),
		timed_out: z.boolean(),
		killed: z.boolean(),
	}),
]);

export interface SubstrateSandboxOptions extends SubstrateConnection {
	id?: string;
	timeout?: number;
	ephemeral?: boolean;
}

/** Each n8n workspace has its own Actor. The router wakes suspended Actors. */
export class SubstrateSandbox extends BaseSandbox {
	readonly name = 'SubstrateSandbox';
	readonly provider = 'substrate';
	readonly id: string;
	private readonly control: SubstrateControl;
	private readonly timeout: number;
	private routerAgent?: Agent;
	private routerAgentPromise?: Promise<Agent>;
	private routerAgentFingerprint?: string;

	constructor(private readonly options: SubstrateSandboxOptions) {
		super();
		this.id = `n8n-${options.id ?? randomUUID()}`;
		for (const value of [this.id, options.atespace, options.template]) {
			if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value))
				throw new Error('Substrate identities must be DNS labels');
		}
		const router = new URL(options.routerUrl);
		if (!['http:', 'https:'].includes(router.protocol) || router.username || router.password)
			throw new Error('Invalid Substrate router URL');
		this.timeout = options.timeout ?? 300_000;
		this.control = new SubstrateControl(options, this.timeout);
	}

	async start(): Promise<void> {
		await this.control.ensureActor(this.id);
		await this.request('/healthz');
	}

	async stop(): Promise<void> {
		if (this.options.ephemeral) {
			try {
				await this.control.deleteActor(this.id);
			} finally {
				await this.closeRouterAgent();
			}
			return;
		}
		await this.control.call('SuspendActor', this.id);
	}

	async destroy(): Promise<void> {
		try {
			await this.control.deleteActor(this.id);
		} finally {
			await this.closeRouterAgent();
		}
	}

	getFileClient(abortSignal?: AbortSignal): SandboxFileClient {
		return {
			readFile: async (id, path) => await this.readFile(id, path, abortSignal),
			writeFile: async (id, path, content, overwrite) =>
				await this.writeFile(id, path, content, overwrite, abortSignal),
			appendFile: async (id, path, content) =>
				await this.appendFile(id, path, content, abortSignal),
			deleteFile: async (id, path, options) =>
				await this.deleteFile(id, path, options, abortSignal),
			copyFile: async (id, request) => await this.copyFile(id, request, abortSignal),
			moveFile: async (id, request) => await this.moveFile(id, request, abortSignal),
			mkdir: async (id, path, recursive) => await this.mkdir(id, path, recursive, abortSignal),
			listFiles: async (id, options) => await this.listFiles(id, options, abortSignal),
			stat: async (id, path) => await this.stat(id, path, abortSignal),
		};
	}

	override getInstructions(): string {
		return 'Isolated Substrate sandbox. Home: /home/user. Workspace: /home/user/workspace.';
	}

	private async request(
		path: string,
		init: RequestInit = {},
		query: Record<string, string> = {},
	): Promise<Response> {
		const url = new URL(this.options.routerUrl.replace(/\/$/, '') + path);
		url.search = new URLSearchParams(query).toString();
		const headers = new Headers(init.headers);
		headers.set('ate-target-actor', `${this.options.atespace}/${this.id}`);
		const dispatcher = await this.getRouterAgent(url);
		const response = await fetch(url, {
			...init,
			redirect: 'error',
			headers,
			signal: init.signal ?? AbortSignal.timeout(this.timeout),
			// Node's fetch accepts the Undici dispatcher option for mTLS.
			// @ts-expect-error dispatcher is a Node fetch extension
			dispatcher,
		});
		if (!response.ok) {
			await response.body?.cancel();
			throw new SandboxServiceError(
				`Substrate daemon returned HTTP ${response.status}`,
				response.status,
			);
		}
		return response;
	}

	private async getRouterAgent(url: URL): Promise<Agent | undefined> {
		if (url.protocol !== 'https:') return undefined;
		const routerCredentialFile = this.options.routerCredentialFile;
		if (!routerCredentialFile) {
			throw new Error('A Substrate router client certificate file is required for HTTPS');
		}
		if (this.routerAgentPromise) return await this.routerAgentPromise;

		const caFile = this.options.caFile;
		if (!caFile) throw new Error('A Substrate router CA file is required for HTTPS');
		this.routerAgentPromise = (async () => {
			const [ca, credentialBundle] = await Promise.all([
				readFile(caFile).catch(() => {
					throw new Error('The server Substrate CA file could not be read');
				}),
				readFile(routerCredentialFile).catch(() => {
					throw new Error('The server Substrate router credential file could not be read');
				}),
			]);
			const fingerprint = createHash('sha256').update(ca).update(credentialBundle).digest('hex');
			if (this.routerAgent && this.routerAgentFingerprint === fingerprint) return this.routerAgent;

			const previous = this.routerAgent;
			this.routerAgent = new Agent({
				connect: { ca, cert: credentialBundle, key: credentialBundle },
			});
			this.routerAgentFingerprint = fingerprint;
			if (previous) void previous.close().catch(() => undefined);
			return this.routerAgent;
		})();
		try {
			this.routerAgent = await this.routerAgentPromise;
			return this.routerAgent;
		} finally {
			this.routerAgentPromise = undefined;
		}
	}

	private async closeRouterAgent(): Promise<void> {
		const agent = this.routerAgent ?? (await this.routerAgentPromise?.catch(() => undefined));
		await agent?.close();
		this.routerAgent = undefined;
		this.routerAgentFingerprint = undefined;
		this.routerAgentPromise = undefined;
	}

	override async executeCommand(
		command: string,
		args: string[] = [],
		options?: ExecuteCommandOptions,
	): Promise<CommandResult> {
		await this.ensureRunning({ abortSignal: options?.abortSignal });
		const timeout = options?.timeout ?? this.timeout;
		const signals = [AbortSignal.timeout(timeout + 30_000)];
		if (options?.abortSignal) signals.push(options.abortSignal);
		let execId: string | undefined;
		let stdout = '';
		let stderr = '';
		let outputBytes = 0;
		let result: CommandResult | undefined;
		try {
			const response = await this.request('/executions', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					command: toShellCommand(command, args),
					env: options?.env,
					workdir: options?.cwd,
					timeout_ms: timeout,
				}),
				signal: AbortSignal.any(signals),
			});
			if (!response.body) throw new Error('Substrate returned no execution stream');
			const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
			let pending = '';
			const consume = (line: string) => {
				if (!line.trim()) return;
				const event = eventSchema.parse(JSON.parse(line));
				switch (event.type) {
					case 'started':
						execId = event.exec_id;
						break;
					case 'stdout':
						outputBytes += Buffer.byteLength(event.data);
						if (outputBytes > MAX_EXECUTION_OUTPUT_BYTES)
							throw new Error('Substrate execution output exceeded the 10 MiB limit');
						stdout += event.data;
						options?.onStdout?.(event.data);
						break;
					case 'stderr':
						outputBytes += Buffer.byteLength(event.data);
						if (outputBytes > MAX_EXECUTION_OUTPUT_BYTES)
							throw new Error('Substrate execution output exceeded the 10 MiB limit');
						stderr += event.data;
						options?.onStderr?.(event.data);
						break;
					case 'error':
						throw new Error(event.error);
					case 'exit':
						result = {
							command,
							args,
							stdout,
							stderr,
							exitCode: event.exit_code,
							success: event.success,
							executionTimeMs: event.execution_time_ms,
							timedOut: event.timed_out,
							killed: event.killed,
						};
						break;
				}
			};
			try {
				for (;;) {
					const chunk = await reader.read();
					if (chunk.done) break;
					pending += chunk.value;
					let newline: number;
					while ((newline = pending.indexOf('\n')) >= 0) {
						const line = pending.slice(0, newline);
						if (Buffer.byteLength(line) > MAX_EXECUTION_EVENT_BYTES)
							throw new Error('Substrate execution event exceeded the 1 MiB limit');
						consume(line);
						pending = pending.slice(newline + 1);
					}
					if (Buffer.byteLength(pending) > MAX_EXECUTION_EVENT_BYTES)
						throw new Error('Substrate execution event exceeded the 1 MiB limit');
				}
				consume(pending);
			} finally {
				await reader.cancel().catch(() => {});
			}
			if (!result) throw new Error('Substrate execution ended without an exit event');
			return result;
		} catch (error) {
			if (execId)
				await this.request(`/executions/${encodeURIComponent(execId)}`, {
					method: 'DELETE',
					signal: AbortSignal.timeout(10_000),
				}).catch(() => {});
			throw error;
		}
	}

	async readFile(_id: string, path: string, abortSignal?: AbortSignal): Promise<Buffer> {
		return Buffer.from(
			await (await this.request('/files/content', { signal: abortSignal }, { path })).arrayBuffer(),
		);
	}
	async writeFile(
		_id: string,
		path: string,
		content: FileContent,
		overwrite = true,
		abortSignal?: AbortSignal,
	): Promise<void> {
		await this.request(
			'/files',
			{
				method: 'PUT',
				body: typeof content === 'string' ? content : new Uint8Array(content),
				signal: abortSignal,
			},
			{ path, overwrite: String(overwrite) },
		);
	}
	async appendFile(
		_id: string,
		path: string,
		content: FileContent,
		abortSignal?: AbortSignal,
	): Promise<void> {
		await this.request(
			'/files',
			{
				method: 'POST',
				body: typeof content === 'string' ? content : new Uint8Array(content),
				signal: abortSignal,
			},
			{ path },
		);
	}
	async deleteFile(
		_id: string,
		path: string,
		options?: DeleteFileOptions,
		abortSignal?: AbortSignal,
	): Promise<void> {
		await this.request(
			'/files',
			{ method: 'DELETE', signal: abortSignal },
			{
				path,
				recursive: String(options?.recursive ?? false),
				force: String(options?.force ?? false),
			},
		);
	}
	async copyFile(_id: string, request: CopyFileRequest, abortSignal?: AbortSignal): Promise<void> {
		await this.request('/files/copy', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(request),
			signal: abortSignal,
		});
	}
	async moveFile(_id: string, request: MoveFileRequest, abortSignal?: AbortSignal): Promise<void> {
		await this.request('/files/move', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(request),
			signal: abortSignal,
		});
	}
	async mkdir(
		_id: string,
		path: string,
		recursive = false,
		abortSignal?: AbortSignal,
	): Promise<void> {
		await this.request(
			'/mkdir',
			{ method: 'POST', signal: abortSignal },
			{ path, recursive: String(recursive) },
		);
	}
	async listFiles(_id: string, options?: ListFilesOptions, abortSignal?: AbortSignal) {
		return z
			.array(fileEntry)
			.parse(
				await (
					await this.request('/files', { signal: abortSignal }, { path: options?.path ?? '/' })
				).json(),
			);
	}
	async stat(_id: string, path: string, abortSignal?: AbortSignal) {
		return fileStat.parse(
			await (await this.request('/stat', { signal: abortSignal }, { path })).json(),
		);
	}
}
