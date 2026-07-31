// Orchestration: validation, consent, checkpoint freshness, and bounds. This
// is the one module that ties scope.ts + registry.ts + worker-client.ts +
// normalize.ts together. It has no Pi API dependency either — index.ts
// adapts `ctx.ui.confirm` into the `ConfirmFn` shape below so this module
// stays independently testable.

import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { promisify } from "node:util";

import { NotAGitRepositoryError, resolveRepositoryIdentity } from "./scope.ts";

type ResolveRepositoryIdentity = typeof resolveRepositoryIdentity;
import type { CodeGraphRegistry } from "./registry.ts";
import { CodeGraphWorkerPool, WorkerOperationError, type WorkerRequestOptions } from "./worker-client.ts";
import {
	buildEnvelope,
	normalizeSearchResult,
	normalizeStatusResult,
	normalizeSymbolResult,
	normalizeTraceResult,
	type NormalizeContext,
	type RawStatusResult,
	type RawSymbolCandidates,
	type RawSymbolSingle,
	type RawTraceResult,
} from "./normalize.ts";
import type {
	CodeGraphConfig,
	CodeGraphFreshness,
	CodeGraphIndexPreview,
	CodeGraphRepositoryIdentity,
	CodeGraphResultStatus,
	CodeGraphSearchInput,
	CodeGraphSearchResult,
	CodeGraphStatusInput,
	CodeGraphStatusResult,
	CodeGraphSymbolInput,
	CodeGraphSymbolResult,
	CodeGraphTraceInput,
	CodeGraphTraceResult,
} from "./types.ts";

const execFileAsync = promisify(execFile);
const require_ = createRequire(import.meta.url);

function resolveInstalledCodegraphVersion(): string {
	try {
		return (require_("@colbymchenry/codegraph/package.json") as { version?: string }).version ?? "unknown";
	} catch {
		return "unknown";
	}
}

const SEMANTIC_EXTENSIONS = new Set([".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".go"]);
const SHALLOW_EXTENSIONS = new Set([".yaml", ".yml"]);

export class UnknownRepositoryIdError extends Error {
	constructor(requested: string, current: string) {
		super(`Unknown repositoryId "${requested}". This build only supports the exact current worktree (repositoryId "${current}").`);
		this.name = "UnknownRepositoryIdError";
	}
}

export class InvalidCodeGraphRequestError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InvalidCodeGraphRequestError";
	}
}

export interface CodeGraphConfirmRequest {
	kind: "first-index";
	title: string;
	body: string;
}

/** Returns `false` (deny) whenever no interactive confirmation is available; never assume consent. */
export type ConfirmFn = (request: CodeGraphConfirmRequest) => Promise<boolean>;

export interface CodeGraphServiceOptions {
	pool: CodeGraphWorkerPool;
	registry: CodeGraphRegistry;
	config: CodeGraphConfig;
	extensionVersion: string;
	resolveIdentity?: ResolveRepositoryIdentity;
	now?: () => number;
}

function toDisplayPath(worktreeRoot: string): string {
	const home = homedir();
	return worktreeRoot === home || worktreeRoot.startsWith(`${home}/`) ? `~${worktreeRoot.slice(home.length)}` : worktreeRoot;
}

function clampLimit(requested: number | undefined, max: number): number {
	if (requested === undefined || !Number.isFinite(requested) || requested <= 0) return Math.min(20, max);
	return Math.min(Math.floor(requested), max);
}

function clampDepth(requested: number | undefined, max: number): number {
	if (requested === undefined || !Number.isFinite(requested) || requested <= 0) return Math.min(1, max);
	return Math.min(Math.floor(requested), max);
}

function isTransientWorkerFailure(error: unknown): error is WorkerOperationError {
	return error instanceof WorkerOperationError;
}

export class CodeGraphService {
	private readonly pool: CodeGraphWorkerPool;
	private readonly registry: CodeGraphRegistry;
	private readonly config: CodeGraphConfig;
	private readonly extensionVersion: string;
	private readonly resolveIdentity: ResolveRepositoryIdentity;
	private readonly now: () => number;
	/** Monotonic per-root sync generation, bumped whenever a sync reports any change. */
	private readonly generations = new Map<string, number>();

	constructor(options: CodeGraphServiceOptions) {
		this.pool = options.pool;
		this.registry = options.registry;
		this.config = options.config;
		this.extensionVersion = options.extensionVersion;
		this.resolveIdentity = options.resolveIdentity ?? resolveRepositoryIdentity;
		this.now = options.now ?? Date.now;
	}

	private generationFor(identity: CodeGraphRepositoryIdentity): string {
		return String(this.generations.get(identity.id) ?? 0);
	}

	private bumpGeneration(identity: CodeGraphRepositoryIdentity): string {
		const next = (this.generations.get(identity.id) ?? 0) + 1;
		this.generations.set(identity.id, next);
		return String(next);
	}

	private assertRepositoryId(identity: CodeGraphRepositoryIdentity, requested: string | undefined): void {
		if (requested !== undefined && requested !== identity.id) throw new UnknownRepositoryIdError(requested, identity.id);
	}

	private baseContext(identity: CodeGraphRepositoryIdentity, status: CodeGraphResultStatus, codegraphVersion: string, freshness?: CodeGraphFreshness, message?: string): NormalizeContext {
		return {
			repositoryId: identity.id,
			displayPath: toDisplayPath(identity.worktreeRoot),
			head: identity.head,
			branch: identity.branch,
			codegraphVersion,
			status,
			freshness,
			config: this.config,
			message,
		};
	}

	private async resolveAndValidate(cwd: string, repositoryId: string | undefined): Promise<CodeGraphRepositoryIdentity> {
		let identity: CodeGraphRepositoryIdentity;
		try {
			identity = await this.resolveIdentity(cwd);
		} catch (error) {
			if (error instanceof NotAGitRepositoryError) throw new InvalidCodeGraphRequestError(error.message);
			throw error;
		}
		this.assertRepositoryId(identity, repositoryId);
		return identity;
	}

	/** Opens (without creating) the exact root's graph. Never initializes. */
	private async openExisting(root: string, options?: WorkerRequestOptions): Promise<{ initialized: boolean; stats?: unknown; codegraphVersion?: string }> {
		const result = (await this.pool.run(root, { type: "open", root }, options)) as { initialized: boolean; stats?: unknown };
		return result;
	}

	private async syncAndFreshness(identity: CodeGraphRepositoryIdentity, options?: WorkerRequestOptions): Promise<CodeGraphFreshness> {
		const syncResult = (await this.pool.run(identity.worktreeRoot, { type: "sync" }, options)) as {
			filesChecked: number;
			filesAdded: number;
			filesModified: number;
			filesRemoved: number;
			nodesUpdated: number;
			durationMs: number;
		} | null;
		const changed = syncResult ? syncResult.filesAdded > 0 || syncResult.filesModified > 0 || syncResult.filesRemoved > 0 : false;
		const generation = changed ? this.bumpGeneration(identity) : this.generationFor(identity);
		const statsResult = (await this.pool.run(identity.worktreeRoot, { type: "stats" }, options)) as { lastIndexedAt: number | null };
		await this.registry.update(identity.id, { lastGeneration: generation, lastIndexedAt: statsResult.lastIndexedAt ?? null }).catch(() => undefined);
		return {
			status: changed ? "synced" : "current",
			lastIndexedAt: statsResult.lastIndexedAt ?? null,
			generation,
			sync: syncResult ?? undefined,
			dirtyWorktree: changed,
		};
	}

	async search(cwd: string, input: CodeGraphSearchInput, options?: WorkerRequestOptions): Promise<CodeGraphSearchResult> {
		const identity = await this.resolveAndValidate(cwd, input.repositoryId);
		const hello = await this.helloVersion(identity.worktreeRoot, options);
		const openResult = await this.openExisting(identity.worktreeRoot, options);
		if (!openResult.initialized) {
			return normalizeSearchResult([], this.baseContext(identity, "not_indexed", hello, undefined, 'Repository is not indexed yet. Call codegraph_status with action="ensure" to index the current worktree.'));
		}
		const freshness = await this.syncAndFreshness(identity, options);
		const limit = clampLimit(input.limit, this.config.maxResults);
		const raw = (await this.pool.run(
			identity.worktreeRoot,
			{
				type: "search",
				query: input.query,
				kinds: input.kinds,
				languages: input.languages,
				pathPrefix: input.pathPrefix,
				limit,
			},
			options,
		)) as Parameters<typeof normalizeSearchResult>[0];
		return normalizeSearchResult(raw, this.baseContext(identity, "ready", hello, freshness));
	}

	async symbol(cwd: string, input: CodeGraphSymbolInput, options?: WorkerRequestOptions): Promise<CodeGraphSymbolResult> {
		if (!input.symbolId && !input.name) throw new InvalidCodeGraphRequestError("codegraph_symbol requires exactly one of symbolId or name.");
		if (input.symbolId && input.name) throw new InvalidCodeGraphRequestError("codegraph_symbol requires exactly one of symbolId or name, not both.");
		const identity = await this.resolveAndValidate(cwd, input.repositoryId);
		const hello = await this.helloVersion(identity.worktreeRoot, options);
		const openResult = await this.openExisting(identity.worktreeRoot, options);
		if (!openResult.initialized) {
			return normalizeSymbolResult({ candidates: [] }, input.relation, "none", this.baseContext(identity, "not_indexed", hello, undefined, 'Repository is not indexed yet. Call codegraph_status with action="ensure" to index the current worktree.'));
		}
		const freshness = await this.syncAndFreshness(identity, options);
		const depth = clampDepth(input.depth, this.config.maxDepth);
		const limit = clampLimit(input.limit, this.config.maxResults);
		const includeSource = input.includeSource ?? "none";
		const raw = (await this.pool.run(
			identity.worktreeRoot,
			{
				type: "symbol",
				symbolId: input.symbolId,
				name: input.name,
				relation: input.relation,
				depth,
				limit,
				includeSource,
			},
			options,
		)) as RawSymbolCandidates | RawSymbolSingle;
		return normalizeSymbolResult(raw, input.relation, includeSource, this.baseContext(identity, "ready", hello, freshness));
	}

	async trace(cwd: string, input: CodeGraphTraceInput, options?: WorkerRequestOptions): Promise<CodeGraphTraceResult> {
		if (input.mode === "shortest_path" && !input.toSymbolId) throw new InvalidCodeGraphRequestError('codegraph_trace mode="shortest_path" requires toSymbolId.');
		const identity = await this.resolveAndValidate(cwd, input.repositoryId);
		const hello = await this.helloVersion(identity.worktreeRoot, options);
		const openResult = await this.openExisting(identity.worktreeRoot, options);
		if (!openResult.initialized) {
			return normalizeTraceResult({ nodes: [], edges: [] }, input.mode, this.baseContext(identity, "not_indexed", hello, undefined, 'Repository is not indexed yet. Call codegraph_status with action="ensure" to index the current worktree.'));
		}
		const freshness = await this.syncAndFreshness(identity, options);
		const depth = clampDepth(input.depth, this.config.maxDepth);
		const limit = clampLimit(input.limit, this.config.maxResults);
		const raw = (await this.pool.run(
			identity.worktreeRoot,
			{
				type: "trace",
				mode: input.mode,
				fromSymbolId: input.fromSymbolId,
				toSymbolId: input.toSymbolId,
				edgeKinds: input.edgeKinds,
				depth,
				limit,
			},
			options,
		)) as RawTraceResult;
		return normalizeTraceResult(raw, input.mode, this.baseContext(identity, "ready", hello, freshness));
	}

	async status(cwd: string, input: CodeGraphStatusInput, confirm: ConfirmFn, options?: WorkerRequestOptions): Promise<CodeGraphStatusResult> {
		const action = input.action ?? "inspect";
		if (action === "acquire" || action === "fetch") {
			const identity = await this.resolveAndValidate(cwd, input.repositoryId).catch(() => undefined);
			return {
				...buildEnvelope(this.baseContext(
					identity ?? { id: "unknown", worktreeRoot: cwd, gitCommonDir: cwd, head: null, branch: null, source: "local", indexDirName: ".codegraph" },
					"remote_unavailable",
					resolveInstalledCodegraphVersion(),
					undefined,
					`codegraph_status action="${action}" (remote acquisition) is not implemented in this build. Only the exact current worktree is supported.`,
				)),
				action,
				indexed: false,
			};
		}

		const identity = await this.resolveAndValidate(cwd, input.repositoryId);

		try {
			const hello = await this.helloVersion(identity.worktreeRoot, options);

			if (action === "refresh") {
				const openResult = await this.openExisting(identity.worktreeRoot, options);
				if (!openResult.initialized) {
					return normalizeStatusResult("refresh", undefined, { ...this.baseContext(identity, "not_indexed", hello, undefined, 'Repository is not indexed yet. Call codegraph_status with action="ensure" first.'), indexed: false });
				}
				const freshness = await this.syncAndFreshness(identity, options);
				const stats = (await this.pool.run(identity.worktreeRoot, { type: "stats" }, options)) as RawStatusResult;
				return normalizeStatusResult("refresh", stats, { ...this.baseContext(identity, "ready", hello, freshness), indexed: true });
			}

			if (action === "ensure") {
				const openResult = await this.openExisting(identity.worktreeRoot, options);
				if (openResult.initialized) {
					const freshness = await this.syncAndFreshness(identity, options);
					const stats = (await this.pool.run(identity.worktreeRoot, { type: "stats" }, options)) as RawStatusResult;
					return normalizeStatusResult("ensure", stats, { ...this.baseContext(identity, "ready", hello, freshness), indexed: true });
				}
				const preview = await this.buildIndexPreview(identity);
				const confirmed = await confirm({
					kind: "first-index",
					title: "Index this worktree with CodeGraph?",
					body: this.formatFirstIndexPreview(identity, preview),
				});
				if (!confirmed) {
					return normalizeStatusResult("ensure", undefined, { ...this.baseContext(identity, "consent_required", hello, undefined, "First indexing was not confirmed; no index was created."), indexed: false, preview });
				}
				try {
					const indexResult = (await this.pool.run(identity.worktreeRoot, { type: "index_all" }, options)) as RawStatusResult;
					await this.registry.recordConsent({
						schemaVersion: 1,
						repositoryId: identity.id,
						source: "local",
						worktreeRoot: identity.worktreeRoot,
						consentAt: this.now(),
						lastGeneration: this.generationFor(identity),
						lastIndexedAt: this.now(),
						codegraphVersion: hello,
						extensionVersion: this.extensionVersion,
						state: "ready",
					});
					return normalizeStatusResult("ensure", indexResult, { ...this.baseContext(identity, "ready", hello), indexed: true, preview });
				} catch (error) {
					await this.registry
						.recordConsent({
							schemaVersion: 1,
							repositoryId: identity.id,
							source: "local",
							worktreeRoot: identity.worktreeRoot,
							consentAt: this.now(),
							lastGeneration: "0",
							lastIndexedAt: null,
							codegraphVersion: hello,
							extensionVersion: this.extensionVersion,
							state: "incomplete",
						})
						.catch(() => undefined);
					return normalizeStatusResult("ensure", undefined, {
						...this.baseContext(identity, "repair_required", hello, undefined, `First indexing failed and left an incomplete index: ${error instanceof Error ? error.message : String(error)}`),
						indexed: false,
						preview,
					});
				}
			}

			// action === "inspect"
			const openResult = await this.openExisting(identity.worktreeRoot, options);
			if (!openResult.initialized) {
				return normalizeStatusResult("inspect", undefined, { ...this.baseContext(identity, "not_indexed", hello, undefined, 'Repository is not indexed yet. Call codegraph_status with action="ensure" to index it.'), indexed: false });
			}
			const stats = (await this.pool.run(identity.worktreeRoot, { type: "stats" }, options)) as RawStatusResult;
			return normalizeStatusResult("inspect", stats, {
				...this.baseContext(identity, "ready", hello, {
					status: "possibly-stale",
					lastIndexedAt: stats.lastIndexedAt ?? null,
					generation: this.generationFor(identity),
					dirtyWorktree: true,
					warning: "inspect does not sync; call refresh or search/symbol/trace for checkpointed freshness.",
				}),
				indexed: true,
			});
		} catch (error) {
			if (isTransientWorkerFailure(error) && error.errorKind === "database") {
				return normalizeStatusResult(action, undefined, {
					...this.baseContext(identity, "repair_required", resolveInstalledCodegraphVersion(), undefined, `CodeGraph database error: ${error.message}. Repair requires a separate confirmed action; the index was left untouched.`),
					indexed: false,
				});
			}
			return normalizeStatusResult(action, undefined, {
				...this.baseContext(identity, "worker_failed", resolveInstalledCodegraphVersion(), undefined, error instanceof Error ? error.message : String(error)),
				indexed: false,
			});
		}
	}

	private async helloVersion(root: string, options?: WorkerRequestOptions): Promise<string> {
		// Reads the actually-installed package version directly rather than
		// round-tripping to the worker: it's needed even for not_indexed/
		// consent_required results where no worker may exist yet, and the
		// installed version cannot change without an extension
		// reinstall/upgrade, which always ends the current process anyway.
		void root;
		void options;
		return resolveInstalledCodegraphVersion();
	}

	private async buildIndexPreview(identity: CodeGraphRepositoryIdentity): Promise<CodeGraphIndexPreview> {
		let files: string[] = [];
		try {
			const { stdout } = await execFileAsync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
				cwd: identity.worktreeRoot,
				timeout: 10_000,
				maxBuffer: 64 * 1024 * 1024,
			});
			files = stdout.split("\0").filter(Boolean);
		} catch {
			files = [];
		}
		let semantic = 0;
		let shallow = 0;
		let unsupported = 0;
		for (const file of files) {
			const dot = file.lastIndexOf(".");
			const ext = dot === -1 ? "" : file.slice(dot).toLowerCase();
			if (SEMANTIC_EXTENSIONS.has(ext)) semantic++;
			else if (SHALLOW_EXTENSIONS.has(ext)) shallow++;
			else unsupported++;
		}
		return {
			worktreeRoot: identity.worktreeRoot,
			branch: identity.branch,
			head: identity.head,
			willCreateIndexDir: true,
			semanticFileCount: semantic,
			shallowFileCount: shallow,
			unsupportedFileCount: unsupported,
			skippedFileCount: 0,
		};
	}

	private formatFirstIndexPreview(identity: CodeGraphRepositoryIdentity, preview: CodeGraphIndexPreview): string {
		return [
			`Worktree: ${identity.worktreeRoot}`,
			`Branch: ${identity.branch ?? "(detached)"}  HEAD: ${identity.head ?? "(no commits)"}`,
			`This will create ${identity.indexDirName}/ inside this worktree (upstream writes ${identity.indexDirName}/.gitignore, but the directory may still appear as untracked repository state).`,
			`Files: ${preview.semanticFileCount} semantic-graph, ${preview.shallowFileCount} shallow (file-tracking only), ${preview.unsupportedFileCount} unsupported/other.`,
			"Graph queries and bounded results may be sent to your currently selected Pi model as ordinary tool context.",
			"No network access is used for local indexing.",
		].join("\n");
	}
}
