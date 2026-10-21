import { SandboxServiceError } from '@n8n/sandbox-client';
import type {
	CopyFileRequest,
	DeleteFileOptions,
	FileContent,
	ListFilesOptions,
	MoveFileRequest,
} from '@n8n/sandbox-client';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { BaseSandbox } from './base-sandbox';
import { toShellCommand } from './shell-command';
import { SubstrateControl, type SubstrateConnection } from './substrate-control';
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
	.object({ name: z.string(), size: z.number(), is_dir: z.boolean() })
	.transform(({ is_dir, ...entry }) => ({ ...entry, isDir: is_dir }));
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
			await this.control.deleteActor(this.id);
			return;
		}
		await this.control.call('SuspendActor', this.id);
	}

	async destroy(): Promise<void> {
		await this.control.deleteActor(this.id);
	}

	getClient() {
		return this;
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
		const response = await fetch(url, {
			...init,
			redirect: 'error',
			headers: { 'ate-target-actor': `${this.options.atespace}/${this.id}`, ...init.headers },
			signal: init.signal ?? AbortSignal.timeout(this.timeout),
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

	async readFile(_id: string, path: string): Promise<Buffer> {
		return Buffer.from(await (await this.request('/files/content', {}, { path })).arrayBuffer());
	}
	async writeFile(
		_id: string,
		path: string,
		content: FileContent,
		overwrite = true,
	): Promise<void> {
		await this.request(
			'/files',
			{ method: 'PUT', body: typeof content === 'string' ? content : new Uint8Array(content) },
			{ path, overwrite: String(overwrite) },
		);
	}
	async appendFile(_id: string, path: string, content: FileContent): Promise<void> {
		await this.request(
			'/files',
			{ method: 'POST', body: typeof content === 'string' ? content : new Uint8Array(content) },
			{ path },
		);
	}
	async deleteFile(_id: string, path: string, options?: DeleteFileOptions): Promise<void> {
		await this.request(
			'/files',
			{ method: 'DELETE' },
			{
				path,
				recursive: String(options?.recursive ?? false),
				force: String(options?.force ?? false),
			},
		);
	}
	async copyFile(_id: string, request: CopyFileRequest): Promise<void> {
		await this.request('/files/copy', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(request),
		});
	}
	async moveFile(_id: string, request: MoveFileRequest): Promise<void> {
		await this.request('/files/move', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(request),
		});
	}
	async mkdir(_id: string, path: string, recursive = false): Promise<void> {
		await this.request('/mkdir', { method: 'POST' }, { path, recursive: String(recursive) });
	}
	async listFiles(_id: string, options?: ListFilesOptions) {
		return z
			.array(fileEntry)
			.parse(await (await this.request('/files', {}, { path: options?.path ?? '/' })).json());
	}
	async stat(_id: string, path: string) {
		return fileStat.parse(await (await this.request('/stat', {}, { path })).json());
	}
}
