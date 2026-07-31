// Parent-side process lifecycle and JSONL framing for worker.ts. Owns
// spawning, request/response correlation, timeouts, cancellation, progress
// throttling, and the small-N (default 2) least-recently-used worker cap.
//
// No Pi API dependency either: this module only knows child_process, the
// worker protocol in types.ts, and the exact worker.ts script path.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

import type { WorkerFrame, WorkerHelloFrame, WorkerProgressFrame, WorkerRequest } from "./types.ts";

const WORKER_SCRIPT_PATH = join(dirname(fileURLToPath(import.meta.url)), "worker.ts");
const DEFAULT_HELLO_TIMEOUT_MS = 15_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const MAX_STDERR_BYTES = 8_192;
const PROGRESS_THROTTLE_MS = 500;

/** Environment variables stripped from every spawned worker for hygiene/safety. */
const STRIPPED_ENV_PREFIXES = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy", "NPM_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "GITHUB_TOKEN"];

export function buildWorkerEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...base };
	for (const key of STRIPPED_ENV_PREFIXES) delete env[key];
	env.DO_NOT_TRACK = "1";
	env.CODEGRAPH_TELEMETRY = "0";
	env.CODEGRAPH_NO_UPDATE_CHECK = "1";
	return env;
}

export class WorkerProtocolError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorkerProtocolError";
	}
}

export class WorkerTimeoutError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorkerTimeoutError";
	}
}

export class WorkerCrashedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorkerCrashedError";
	}
}

export class WorkerOperationError extends Error {
	readonly errorKind: string;
	constructor(errorKind: string, message: string) {
		super(message);
		this.name = "WorkerOperationError";
		this.errorKind = errorKind;
	}
}

export interface SpawnFn {
	(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; stdio: ["pipe", "pipe", "pipe"] }): ChildProcessWithoutNullStreams;
}

const defaultSpawn: SpawnFn = (command, args, options) => spawn(command, args, options) as ChildProcessWithoutNullStreams;

interface PendingEntry {
	resolve: (result: unknown) => void;
	reject: (error: Error) => void;
	timer?: NodeJS.Timeout;
	onProgress?: (frame: WorkerProgressFrame) => void;
	lastProgressAt: number;
}

export interface WorkerRequestOptions {
	timeoutMs?: number;
	signal?: AbortSignal;
	onProgress?: (frame: WorkerProgressFrame) => void;
}

class WorkerHandle {
	readonly root: string;
	lastUsedAt = Date.now();
	private child: ChildProcessWithoutNullStreams;
	private pending = new Map<string, PendingEntry>();
	private nextId = 0;
	private closed = false;
	/** True once we've actually sent a termination signal to the OS process; independent of `closed`. */
	private terminated = false;
	private stderrTail = "";
	private crashError: Error | undefined;
	readonly ready: Promise<WorkerHelloFrame>;

	constructor(root: string, execPath: string, spawnFn: SpawnFn, helloTimeoutMs: number) {
		this.root = root;
		this.child = spawnFn(execPath, ["--liftoff-only", "--disable-warning=ExperimentalWarning", "--experimental-strip-types", WORKER_SCRIPT_PATH], {
			cwd: root,
			env: buildWorkerEnv(),
			stdio: ["pipe", "pipe", "pipe"],
		});

		const rl = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
		rl.on("line", (line) => this.handleLine(line));

		this.child.stderr.on("data", (chunk: Buffer) => {
			this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-MAX_STDERR_BYTES);
		});

		this.child.once("error", (error) => {
			this.fail(new WorkerCrashedError(`codegraph worker failed to start: ${error.message}`));
			this.terminateProcess();
		});
		this.child.once("close", (code, signal) => {
			// The process already exited on its own; nothing left to terminate.
			this.terminated = true;
			if (!this.closed) this.fail(new WorkerCrashedError(`codegraph worker exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"}).${this.stderrTail ? ` stderr: ${this.stderrTail}` : ""}`));
		});

		this.ready = new Promise<WorkerHelloFrame>((resolve, reject) => {
			const timer = setTimeout(() => reject(new WorkerTimeoutError(`codegraph worker did not send "hello" within ${helloTimeoutMs}ms.`)), helloTimeoutMs);
			timer.unref?.();
			this.pending.set("__hello__", {
				resolve: (result) => {
					clearTimeout(timer);
					resolve(result as WorkerHelloFrame);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
				lastProgressAt: 0,
			});
		});
	}

	private handleLine(line: string): void {
		const trimmed = line.trim();
		if (!trimmed) return;
		let frame: WorkerFrame;
		try {
			frame = JSON.parse(trimmed);
		} catch {
			this.failAndTerminate(new WorkerProtocolError(`codegraph worker sent malformed JSON: ${trimmed.slice(0, 200)}`));
			return;
		}
		if (!frame || typeof frame !== "object" || typeof (frame as { type?: unknown }).type !== "string") {
			this.failAndTerminate(new WorkerProtocolError("codegraph worker sent a frame missing \"type\"."));
			return;
		}
		if (frame.type === "hello") {
			const helloPending = this.pending.get("__hello__");
			this.pending.delete("__hello__");
			helloPending?.resolve(frame);
			return;
		}
		const entry = this.pending.get(frame.id);
		if (!entry) return; // Late/duplicate frame for an id we stopped waiting on (timeout/cancel).
		if (frame.type === "progress") {
			const now = Date.now();
			if (entry.onProgress && now - entry.lastProgressAt >= PROGRESS_THROTTLE_MS) {
				entry.lastProgressAt = now;
				entry.onProgress(frame);
			}
			return;
		}
		this.pending.delete(frame.id);
		if (entry.timer) clearTimeout(entry.timer);
		if (frame.type === "ok") {
			entry.resolve(frame.result);
			return;
		}
		if (frame.type === "error") {
			entry.reject(new WorkerOperationError(frame.errorKind, frame.message));
			return;
		}
		this.failAndTerminate(new WorkerProtocolError(`codegraph worker sent an unexpected frame type: ${(frame as { type: string }).type}`));
	}

	/** Bookkeeping only: marks this handle unusable and rejects pending requests. Does not touch the OS process — see `terminateProcess()`. */
	private fail(error: Error): void {
		if (this.closed) return;
		this.closed = true;
		this.crashError = error;
		for (const entry of this.pending.values()) {
			if (entry.timer) clearTimeout(entry.timer);
			entry.reject(error);
		}
		this.pending.clear();
	}

	/** Idempotent: actually signals the OS child process to exit. Safe to call even if `fail()` already ran (or vice versa). */
	private terminateProcess(): void {
		if (this.terminated) return;
		this.terminated = true;
		try {
			this.child.stdin.end();
		} catch {
			// Already gone.
		}
		this.child.kill("SIGTERM");
		const forceKill = setTimeout(() => {
			this.child.kill("SIGKILL");
		}, 5_000);
		forceKill.unref?.();
	}

	/**
	 * A protocol violation or fatal error must stop the worker immediately
	 * per design ("A worker is stopped on ... protocol failure, or fatal
	 * library error") rather than merely marking this handle unusable and
	 * waiting for some later `kill()` call that might never come.
	 */
	private failAndTerminate(error: Error): void {
		this.fail(error);
		this.terminateProcess();
	}

	get pendingCount(): number {
		return this.pending.size;
	}

	get isClosed(): boolean {
		return this.closed;
	}

	request(request: Omit<WorkerRequest, "id">, options: WorkerRequestOptions = {}): Promise<unknown> {
		if (this.closed) return Promise.reject(this.crashError ?? new WorkerCrashedError("codegraph worker is closed."));
		if (options.signal?.aborted) return Promise.reject(new DOMException("The operation was aborted.", "AbortError"));
		this.lastUsedAt = Date.now();
		const id = String(++this.nextId);
		const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		return new Promise((resolve, reject) => {
			const onAbort = () => {
				this.pending.delete(id);
				reject(new DOMException("The operation was aborted.", "AbortError"));
			};
			const timer = setTimeout(() => {
				this.pending.delete(id);
				options.signal?.removeEventListener("abort", onAbort);
				reject(new WorkerTimeoutError(`codegraph worker request "${request.type}" timed out after ${timeoutMs}ms.`));
			}, timeoutMs);
			timer.unref?.();
			this.pending.set(id, {
				resolve: (result) => {
					options.signal?.removeEventListener("abort", onAbort);
					resolve(result);
				},
				reject: (error) => {
					options.signal?.removeEventListener("abort", onAbort);
					reject(error);
				},
				timer,
				onProgress: options.onProgress,
				lastProgressAt: 0,
			});
			if (options.signal) options.signal.addEventListener("abort", onAbort, { once: true });
			this.child.stdin.write(`${JSON.stringify({ ...request, id })}\n`);
		});
	}

	/** Always actually terminates the OS process, even if this handle was already marked closed by an earlier internal failure. */
	kill(): void {
		this.failAndTerminate(this.crashError ?? new WorkerCrashedError("codegraph worker was stopped."));
	}
}

export interface CodeGraphWorkerPoolOptions {
	execPath?: string;
	spawnFn?: SpawnFn;
	maxWorkers?: number;
	helloTimeoutMs?: number;
}

/**
 * At most `maxWorkers` live child processes at a time, one per exact
 * worktree root. Never falls back to a different root's worker: callers
 * always pass the exact canonical root they mean to query.
 */
export class CodeGraphWorkerPool {
	private readonly execPath: string;
	private readonly spawnFn: SpawnFn;
	private readonly maxWorkers: number;
	private readonly helloTimeoutMs: number;
	private readonly handles = new Map<string, WorkerHandle>();
	private readonly creating = new Map<string, Promise<WorkerHandle>>();

	constructor(options: CodeGraphWorkerPoolOptions = {}) {
		this.execPath = options.execPath ?? process.execPath;
		this.spawnFn = options.spawnFn ?? defaultSpawn;
		this.maxWorkers = options.maxWorkers ?? 2;
		this.helloTimeoutMs = options.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS;
	}

	get liveRootCount(): number {
		return this.handles.size;
	}

	private async getOrCreate(root: string): Promise<WorkerHandle> {
		const existing = this.handles.get(root);
		if (existing && !existing.isClosed) {
			existing.lastUsedAt = Date.now();
			return existing;
		}
		if (existing?.isClosed) this.handles.delete(root);

		const inFlight = this.creating.get(root);
		if (inFlight) return inFlight;

		const createPromise = (async () => {
			await this.makeRoomFor(root);
			const handle = new WorkerHandle(root, this.execPath, this.spawnFn, this.helloTimeoutMs);
			try {
				await handle.ready;
			} catch (error) {
				handle.kill();
				throw error;
			}
			this.handles.set(root, handle);
			return handle;
		})();
		this.creating.set(root, createPromise);
		try {
			return await createPromise;
		} finally {
			this.creating.delete(root);
		}
	}

	private async makeRoomFor(root: string): Promise<void> {
		if (this.handles.has(root)) return;
		while (this.handles.size >= this.maxWorkers) {
			const idle = [...this.handles.values()].filter((handle) => handle.pendingCount === 0).sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
			const victim = idle ?? [...this.handles.values()].sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
			if (!victim) return;
			if (victim.pendingCount > 0) {
				// Best-effort wait for the busiest-but-oldest worker to drain before
				// evicting it, bounded so a stuck request cannot hang pool growth.
				const deadline = Date.now() + 5_000;
				while (victim.pendingCount > 0 && Date.now() < deadline) {
					await new Promise((resolve) => setTimeout(resolve, 50));
				}
			}
			this.handles.delete(victim.root);
			victim.kill();
		}
	}

	async run(root: string, request: Omit<WorkerRequest, "id">, options?: WorkerRequestOptions): Promise<unknown> {
		const handle = await this.getOrCreate(root);
		return handle.request(request, options);
	}

	async closeRoot(root: string): Promise<void> {
		const handle = this.handles.get(root);
		if (!handle) return;
		this.handles.delete(root);
		try {
			await handle.request({ type: "close" }, { timeoutMs: 5_000 });
		} catch {
			// Fall through to a hard kill below regardless of graceful-close outcome.
		}
		handle.kill();
	}

	async closeAll(): Promise<void> {
		const roots = [...this.handles.keys()];
		await Promise.all(roots.map((root) => this.closeRoot(root)));
	}
}
