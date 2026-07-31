import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { CodeGraphWorkerPool, WorkerCrashedError, WorkerOperationError, WorkerProtocolError, WorkerTimeoutError, buildWorkerEnv, type SpawnFn } from "../worker-client.ts";

class FakeChild extends EventEmitter {
	stdout = new PassThrough();
	stderr = new PassThrough();
	stdin = { write: (_chunk: string) => true, end: () => {} };
	killed = false;
	// A real child process is a live OS handle that keeps the event loop
	// alive on its own, which is what lets CodeGraphWorkerPool's internal
	// unref'd bookkeeping timers (correctly unref'd so they never block a
	// real Pi process from exiting) actually get a chance to fire. Model
	// that here with a deliberately ref'd interval instead of an unref'd
	// one, so these tests don't depend on the outer process happening to
	// have other unrelated work pending.
	private keepAlive: NodeJS.Timeout = setInterval(() => {}, 1_000);
	constructor() {
		super();
		// A real process also stops holding the loop open once it has actually
		// exited, whether or not something called kill() on it first.
		this.once("close", () => clearInterval(this.keepAlive));
	}
	kill(_signal?: string) {
		this.killed = true;
		clearInterval(this.keepAlive);
		return true;
	}
}

function makeFakeSpawn(scripts: Map<string, FakeChild>, requestHandlers: Map<string, (child: FakeChild, request: Record<string, unknown>) => void>): SpawnFn {
	return (_command: string, _args: string[], options: { cwd: string }) => {
		const child = new FakeChild();
		scripts.set(options.cwd, child);
		let buffer = "";
		child.stdin.write = (chunk: string) => {
			buffer += chunk;
			let newlineIndex = buffer.indexOf("\n");
			while (newlineIndex !== -1) {
				const line = buffer.slice(0, newlineIndex);
				buffer = buffer.slice(newlineIndex + 1);
				if (line.trim()) {
					const request = JSON.parse(line);
					const handler = requestHandlers.get(request.type);
					if (handler) {
						handler(child, request);
					} else if (request.type === "close") {
						// Real worker.ts always answers close; keep the fake realistic so
						// tests don't depend on the (intentionally unref'd) graceful-close
						// timeout in CodeGraphWorkerPool.closeRoot to reach process exit.
						child.stdout.write(`${JSON.stringify({ type: "ok", id: request.id, result: null })}\n`);
					}
				}
				newlineIndex = buffer.indexOf("\n");
			}
			return true;
		};
		queueMicrotask(() => child.stdout.write(`${JSON.stringify({ type: "hello", protocolVersion: 1, codegraphVersion: "1.5.0", nodeVersion: process.version })}\n`));
		return child as unknown as ChildProcessWithoutNullStreams;
	};
}

function tmpRoot(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

test("buildWorkerEnv sets telemetry/update disables and strips proxy vars", () => {
	const env = buildWorkerEnv({ HTTP_PROXY: "http://x", OPENAI_API_KEY: "sk-x", PATH: "/bin" });
	assert.equal(env.DO_NOT_TRACK, "1");
	assert.equal(env.CODEGRAPH_TELEMETRY, "0");
	assert.equal(env.CODEGRAPH_NO_UPDATE_CHECK, "1");
	assert.equal(env.HTTP_PROXY, undefined);
	assert.equal(env.OPENAI_API_KEY, undefined);
	assert.equal(env.PATH, "/bin");
});

test("worker pool completes a request against a fake worker", async () => {
	const children = new Map<string, FakeChild>();
	const handlers = new Map<string, (child: FakeChild, request: Record<string, unknown>) => void>();
	handlers.set("stats", (child, request) => {
		child.stdout.write(`${JSON.stringify({ type: "ok", id: request.id, result: { stats: { nodeCount: 1 } } })}\n`);
	});
	const pool = new CodeGraphWorkerPool({ spawnFn: makeFakeSpawn(children, handlers), maxWorkers: 2 });
	const root = tmpRoot("codegraph-pool-");
	try {
		const result = await pool.run(root, { type: "stats" });
		assert.deepEqual(result, { stats: { nodeCount: 1 } });
	} finally {
		await pool.closeAll();
		rmSync(root, { recursive: true, force: true });
	}
});

test("worker pool surfaces a typed WorkerOperationError for an error frame", async () => {
	const children = new Map<string, FakeChild>();
	const handlers = new Map<string, (child: FakeChild, request: Record<string, unknown>) => void>();
	handlers.set("sync", (child, request) => {
		child.stdout.write(`${JSON.stringify({ type: "error", id: request.id, errorKind: "not_open", message: "no graph open" })}\n`);
	});
	const pool = new CodeGraphWorkerPool({ spawnFn: makeFakeSpawn(children, handlers) });
	const root = tmpRoot("codegraph-pool-");
	try {
		await assert.rejects(pool.run(root, { type: "sync" }), (error: Error) => {
			assert.ok(error instanceof WorkerOperationError);
			assert.equal((error as WorkerOperationError).errorKind, "not_open");
			return true;
		});
	} finally {
		await pool.closeAll();
		rmSync(root, { recursive: true, force: true });
	}
});

test("worker pool rejects pending requests with WorkerProtocolError on malformed frames", async () => {
	const children = new Map<string, FakeChild>();
	const handlers = new Map<string, (child: FakeChild, request: Record<string, unknown>) => void>();
	handlers.set("stats", (child) => {
		child.stdout.write("not json at all\n");
	});
	const pool = new CodeGraphWorkerPool({ spawnFn: makeFakeSpawn(children, handlers) });
	const root = tmpRoot("codegraph-pool-");
	try {
		await assert.rejects(pool.run(root, { type: "stats" }), (error: Error) => {
			assert.ok(error instanceof WorkerProtocolError);
			return true;
		});
	} finally {
		await pool.closeAll();
		rmSync(root, { recursive: true, force: true });
	}
});

test("worker pool times out a request that never responds", async () => {
	const children = new Map<string, FakeChild>();
	const handlers = new Map<string, (child: FakeChild, request: Record<string, unknown>) => void>();
	// No handler registered for "stats": the fake worker never answers.
	const pool = new CodeGraphWorkerPool({ spawnFn: makeFakeSpawn(children, handlers) });
	const root = tmpRoot("codegraph-pool-");
	try {
		await assert.rejects(pool.run(root, { type: "stats" }, { timeoutMs: 50 }), (error: Error) => {
			assert.ok(error instanceof WorkerTimeoutError);
			return true;
		});
	} finally {
		await pool.closeAll();
		rmSync(root, { recursive: true, force: true });
	}
});

test("worker pool fails in-flight requests when the child process exits unexpectedly", async () => {
	const children = new Map<string, FakeChild>();
	const handlers = new Map<string, (child: FakeChild, request: Record<string, unknown>) => void>();
	handlers.set("stats", (child) => {
		// Simulate a crash instead of answering.
		queueMicrotask(() => child.emit("close", 1, null));
	});
	const pool = new CodeGraphWorkerPool({ spawnFn: makeFakeSpawn(children, handlers) });
	const root = tmpRoot("codegraph-pool-");
	try {
		await assert.rejects(pool.run(root, { type: "stats" }), (error: Error) => {
			assert.ok(error instanceof WorkerCrashedError);
			return true;
		});
	} finally {
		await pool.closeAll();
		rmSync(root, { recursive: true, force: true });
	}
});

test("worker pool evicts the least-recently-used idle worker beyond the cap", async () => {
	const children = new Map<string, FakeChild>();
	const handlers = new Map<string, (child: FakeChild, request: Record<string, unknown>) => void>();
	handlers.set("stats", (child, request) => {
		child.stdout.write(`${JSON.stringify({ type: "ok", id: request.id, result: {} })}\n`);
	});
	const pool = new CodeGraphWorkerPool({ spawnFn: makeFakeSpawn(children, handlers), maxWorkers: 1 });
	const rootA = tmpRoot("codegraph-pool-a-");
	const rootB = tmpRoot("codegraph-pool-b-");
	try {
		await pool.run(rootA, { type: "stats" });
		assert.equal(pool.liveRootCount, 1);
		await pool.run(rootB, { type: "stats" });
		assert.equal(pool.liveRootCount, 1);
		assert.ok(children.get(rootA)?.killed, "worker for rootA should have been evicted");
	} finally {
		await pool.closeAll();
		rmSync(rootA, { recursive: true, force: true });
		rmSync(rootB, { recursive: true, force: true });
	}
});

test("worker pool cancels a pending request via AbortSignal", async () => {
	const children = new Map<string, FakeChild>();
	const handlers = new Map<string, (child: FakeChild, request: Record<string, unknown>) => void>();
	const pool = new CodeGraphWorkerPool({ spawnFn: makeFakeSpawn(children, handlers) });
	const root = tmpRoot("codegraph-pool-");
	const controller = new AbortController();
	try {
		const promise = pool.run(root, { type: "stats" }, { signal: controller.signal });
		controller.abort();
		await assert.rejects(promise, (error: Error) => {
			assert.equal(error.name, "AbortError");
			return true;
		});
	} finally {
		await pool.closeAll();
		rmSync(root, { recursive: true, force: true });
	}
});

