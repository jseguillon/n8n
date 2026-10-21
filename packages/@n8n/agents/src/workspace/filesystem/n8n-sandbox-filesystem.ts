import { SandboxServiceError } from '@n8n/sandbox-client';
import { dirname } from 'node:path/posix';

import { BaseFilesystem, type BaseFilesystemOptions } from './base-filesystem';
import { raceWithAbort } from '../../sdk/abort';
import type { N8nSandboxServiceSandbox } from '../sandbox/n8n-sandbox-sandbox';
import { SubstrateSandbox } from '../sandbox/substrate-sandbox';
import type {
	AbortableOptions,
	AppendOptions,
	CopyOptions,
	FileContent,
	FileEntry,
	FileStat,
	ListOptions,
	MkdirOptions,
	ProviderStatus,
	ReadOptions,
	RemoveOptions,
	WriteOptions,
} from '../types';

function getParentDirectory(path: string): string | null {
	const parent = dirname(path);
	return parent === '.' || parent === '/' ? null : parent;
}

/** Native agents filesystem adapter backed by the n8n sandbox service file API. */
export class N8nSandboxFilesystem extends BaseFilesystem {
	readonly id: string;

	readonly name = 'N8nSandboxFilesystem';

	readonly provider: string;

	status: ProviderStatus = 'pending';

	constructor(
		private readonly sandbox: N8nSandboxServiceSandbox | SubstrateSandbox,
		options?: BaseFilesystemOptions,
	) {
		super(options);
		this.provider = sandbox.provider;
		this.id = `n8n-sandbox-fs-${sandbox.id}`;
	}

	private async getClientAndSandboxId(abortSignal?: AbortSignal) {
		await this.sandbox.ensureRunning({ abortSignal });
		return {
			client: this.sandbox.getClient(),
			sandboxId: this.sandbox.id,
		};
	}

	private async withSandbox<T>(
		abortSignal: AbortSignal | undefined,
		op: (
			client: ReturnType<(N8nSandboxServiceSandbox | SubstrateSandbox)['getClient']>,
			sandboxId: string,
		) => Promise<T>,
	): Promise<T> {
		await this.ensureReady();
		return await raceWithAbort(async () => {
			const { client, sandboxId } = await this.getClientAndSandboxId(abortSignal);
			return await op(client, sandboxId);
		}, abortSignal);
	}

	async readFile(path: string, options?: ReadOptions): Promise<string | Buffer> {
		return await this.withSandbox(options?.abortSignal, async (client, sandboxId) => {
			const content =
				this.sandbox instanceof SubstrateSandbox
					? await this.sandbox.readFile(sandboxId, path, options?.abortSignal)
					: await client.readFile(sandboxId, path);
			if (options?.encoding) {
				return content.toString(options.encoding);
			}
			return content;
		});
	}

	async writeFile(path: string, content: FileContent, options?: WriteOptions): Promise<void> {
		await this.withSandbox(options?.abortSignal, async (client, sandboxId) => {
			if (options?.recursive) {
				const parent = getParentDirectory(path);
				if (parent) {
					if (this.sandbox instanceof SubstrateSandbox) {
						await this.sandbox.mkdir(sandboxId, parent, true, options.abortSignal);
					} else {
						await client.mkdir(sandboxId, parent, true);
					}
				}
			}
			if (this.sandbox instanceof SubstrateSandbox) {
				await this.sandbox.writeFile(
					sandboxId,
					path,
					content,
					options?.overwrite ?? true,
					options?.abortSignal,
				);
			} else {
				await client.writeFile(sandboxId, path, content, options?.overwrite ?? true);
			}
		});
	}

	async appendFile(path: string, content: FileContent, options?: AppendOptions): Promise<void> {
		await this.withSandbox(options?.abortSignal, async (client, sandboxId) => {
			if (this.sandbox instanceof SubstrateSandbox) {
				await this.sandbox.appendFile(sandboxId, path, content, options?.abortSignal);
			} else {
				await client.appendFile(sandboxId, path, content);
			}
		});
	}

	async deleteFile(path: string, options?: RemoveOptions): Promise<void> {
		await this.withSandbox(options?.abortSignal, async (client, sandboxId) => {
			const deleteOptions = { recursive: options?.recursive, force: options?.force };
			if (this.sandbox instanceof SubstrateSandbox) {
				await this.sandbox.deleteFile(sandboxId, path, deleteOptions, options?.abortSignal);
			} else {
				await client.deleteFile(sandboxId, path, deleteOptions);
			}
		});
	}

	async copyFile(src: string, dest: string, options?: CopyOptions): Promise<void> {
		await this.withSandbox(options?.abortSignal, async (client, sandboxId) => {
			const request = {
				src,
				dest,
				recursive: options?.recursive,
				overwrite: options?.overwrite,
			};
			if (this.sandbox instanceof SubstrateSandbox) {
				await this.sandbox.copyFile(sandboxId, request, options?.abortSignal);
			} else {
				await client.copyFile(sandboxId, request);
			}
		});
	}

	async moveFile(src: string, dest: string, options?: CopyOptions): Promise<void> {
		await this.withSandbox(options?.abortSignal, async (client, sandboxId) => {
			const request = {
				src,
				dest,
				overwrite: options?.overwrite,
			};
			if (this.sandbox instanceof SubstrateSandbox) {
				await this.sandbox.moveFile(sandboxId, request, options?.abortSignal);
			} else {
				await client.moveFile(sandboxId, request);
			}
		});
	}

	async mkdir(path: string, options?: MkdirOptions): Promise<void> {
		await this.withSandbox(options?.abortSignal, async (client, sandboxId) => {
			if (this.sandbox instanceof SubstrateSandbox) {
				await this.sandbox.mkdir(
					sandboxId,
					path,
					options?.recursive ?? false,
					options?.abortSignal,
				);
			} else {
				await client.mkdir(sandboxId, path, options?.recursive ?? false);
			}
		});
	}

	async rmdir(path: string, options?: RemoveOptions): Promise<void> {
		await this.deleteFile(path, options);
	}

	async readdir(path: string, options?: ListOptions): Promise<FileEntry[]> {
		return await this.withSandbox(options?.abortSignal, async (client, sandboxId) => {
			const files =
				this.sandbox instanceof SubstrateSandbox
					? await this.sandbox.listFiles(sandboxId, { path }, options?.abortSignal)
					: await client.listFiles(sandboxId, { path });
			return files.map((entry) => ({
				name: entry.name,
				type: entry.isDir ? 'directory' : 'file',
				size: entry.size,
			}));
		});
	}

	async exists(path: string, options?: AbortableOptions): Promise<boolean> {
		try {
			await this.stat(path, options);
			return true;
		} catch (error) {
			if (error instanceof SandboxServiceError && error.status === 404) {
				return false;
			}
			throw error;
		}
	}

	async stat(path: string, options?: AbortableOptions): Promise<FileStat> {
		return await this.withSandbox(options?.abortSignal, async (client, sandboxId) => {
			const stat =
				this.sandbox instanceof SubstrateSandbox
					? await this.sandbox.stat(sandboxId, path, options?.abortSignal)
					: await client.stat(sandboxId, path);
			return {
				name: stat.name,
				path: stat.path,
				type: stat.type,
				size: stat.size,
				createdAt: new Date(stat.createdAt),
				modifiedAt: new Date(stat.modifiedAt),
			};
		});
	}
}
