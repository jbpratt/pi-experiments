import assert from "node:assert/strict";
import test from "node:test";

import { CodeGraphService, InvalidCodeGraphRequestError, UnknownRepositoryIdError, type ConfirmFn } from "../service.ts";
import { CodeGraphWorkerPool } from "../worker-client.ts";
import type { CodeGraphRegistry } from "../registry.ts";
import { DEFAULT_CONFIG, type CodeGraphRepositoryIdentity, type CodeGraphRegistryEntry } from "../types.ts";

const IDENTITY: CodeGraphRepositoryIdentity = {
	id: "repo-1",
	source: "local",
	worktreeRoot: "/repo",
	gitCommonDir: "/repo/.git",
	head: "deadbeef",
	branch: "main",
	indexDirName: ".codegraph",
};

type Handler = (request: Record<string, unknown>) => unknown;

function makeFakePool(handlers: Record<string, Handler>): CodeGraphWorkerPool {
	return {
		async run(_root: string, request: Record<string, unknown>) {
			const handler = handlers[request.type as string];
			if (!handler) throw new Error(`no fake handler registered for request type "${request.type}"`);
			return handler(request);
		},
		async closeRoot() {},
		async closeAll() {},
		get liveRootCount() {
			return 0;
		},
	} as unknown as CodeGraphWorkerPool;
}

function makeFakeRegistry(): CodeGraphRegistry & { entries: Map<string, CodeGraphRegistryEntry> } {
	const entries = new Map<string, CodeGraphRegistryEntry>();
	return {
		entries,
		async get(repositoryId: string) {
			return entries.get(repositoryId);
		},
		async list() {
			return [...entries.values()];
		},
		async recordConsent(entry: CodeGraphRegistryEntry) {
			entries.set(entry.repositoryId, entry);
		},
		async update(repositoryId: string, patch: Partial<CodeGraphRegistryEntry>) {
			const existing = entries.get(repositoryId);
			if (!existing) throw new Error("unknown repository");
			entries.set(repositoryId, { ...existing, ...patch });
		},
	};
}

function makeService(handlers: Record<string, Handler>, registry: CodeGraphRegistry = makeFakeRegistry()): CodeGraphService {
	return new CodeGraphService({
		pool: makeFakePool(handlers),
		registry,
		config: DEFAULT_CONFIG,
		extensionVersion: "0.1.0-test",
		resolveIdentity: async () => IDENTITY,
	});
}

const denyConfirm: ConfirmFn = async () => false;
const allowConfirm: ConfirmFn = async () => true;

test("search returns not_indexed without ever calling search/sync when the root is not initialized", async () => {
	let searchCalled = false;
	const service = makeService({
		open: () => ({ initialized: false }),
		search: () => {
			searchCalled = true;
			return [];
		},
	});
	const result = await service.search("/repo/sub", { query: "foo" });
	assert.equal(result.status, "not_indexed");
	assert.deepEqual(result.candidates, []);
	assert.equal(searchCalled, false);
	assert.match(result.message ?? "", /action="ensure"/);
});

test("search happy path syncs then returns normalized candidates", async () => {
	const node = {
		id: "fn:1",
		kind: "function",
		name: "doThing",
		qualifiedName: "doThing",
		filePath: "src/a.ts",
		language: "typescript",
		startLine: 1,
		endLine: 2,
		startColumn: 0,
		endColumn: 1,
		isExported: true,
	};
	const service = makeService({
		open: () => ({ initialized: true }),
		sync: () => ({ filesChecked: 1, filesAdded: 0, filesModified: 0, filesRemoved: 0, nodesUpdated: 0, durationMs: 1 }),
		stats: () => ({ stats: { nodeCount: 1, edgeCount: 0, fileCount: 1, dbSizeBytes: 10 }, lastIndexedAt: 123 }),
		search: () => [{ node, score: 1 }],
	});
	const result = await service.search("/repo", { query: "doThing" });
	assert.equal(result.status, "ready");
	assert.equal(result.candidates.length, 1);
	assert.equal(result.candidates[0]?.symbolId, "fn:1");
	assert.equal(result.freshness?.status, "current");
});

test("search rejects an unknown repositoryId", async () => {
	const service = makeService({});
	await assert.rejects(service.search("/repo", { query: "x", repositoryId: "other-repo" }), UnknownRepositoryIdError);
});

test("symbol requires exactly one of symbolId or name", async () => {
	const service = makeService({});
	await assert.rejects(service.symbol("/repo", {}), InvalidCodeGraphRequestError);
	await assert.rejects(service.symbol("/repo", { symbolId: "a", name: "b" }), InvalidCodeGraphRequestError);
});

test("trace shortest_path requires toSymbolId", async () => {
	const service = makeService({});
	await assert.rejects(service.trace("/repo", { mode: "shortest_path", fromSymbolId: "a" }), InvalidCodeGraphRequestError);
});

test("status action=ensure denied by confirm never calls index_all and reports consent_required", async () => {
	let indexAllCalled = false;
	const registry = makeFakeRegistry();
	const service = makeService(
		{
			open: () => ({ initialized: false }),
			index_all: () => {
				indexAllCalled = true;
				return { stats: {} };
			},
		},
		registry,
	);
	const result = await service.status("/repo", { action: "ensure" }, denyConfirm);
	assert.equal(result.status, "consent_required");
	assert.equal(result.indexed, false);
	assert.equal(indexAllCalled, false);
	assert.equal(registry.entries.size, 0);
});

test("status action=ensure confirmed indexes and records consent", async () => {
	const registry = makeFakeRegistry();
	const service = makeService(
		{
			open: () => ({ initialized: false }),
			index_all: () => ({ stats: { nodeCount: 3, edgeCount: 2, fileCount: 1, dbSizeBytes: 100 } }),
		},
		registry,
	);
	const result = await service.status("/repo", { action: "ensure" }, allowConfirm);
	assert.equal(result.status, "ready");
	assert.equal(result.indexed, true);
	assert.equal(registry.entries.get("repo-1")?.state, "ready");
});

test("status action=ensure already-indexed is idempotent and never re-prompts", async () => {
	let confirmCalls = 0;
	const confirmSpy: ConfirmFn = async () => {
		confirmCalls++;
		return true;
	};
	const service = makeService({
		open: () => ({ initialized: true }),
		sync: () => ({ filesChecked: 0, filesAdded: 0, filesModified: 0, filesRemoved: 0, nodesUpdated: 0, durationMs: 0 }),
		stats: () => ({ stats: { nodeCount: 1, edgeCount: 0, fileCount: 1, dbSizeBytes: 1 }, lastIndexedAt: 1 }),
	});
	const result = await service.status("/repo", { action: "ensure" }, confirmSpy);
	assert.equal(result.indexed, true);
	assert.equal(confirmCalls, 0);
});

test("status action=inspect on a not-yet-indexed root never prompts and never mutates", async () => {
	const service = makeService({ open: () => ({ initialized: false }) });
	const result = await service.status("/repo", { action: "inspect" }, denyConfirm);
	assert.equal(result.status, "not_indexed");
	assert.equal(result.indexed, false);
});

test("status action=refresh on a not-yet-indexed root reports not_indexed instead of indexing", async () => {
	const service = makeService({ open: () => ({ initialized: false }) });
	const result = await service.status("/repo", { action: "refresh" }, denyConfirm);
	assert.equal(result.status, "not_indexed");
});

test("status action=acquire/fetch report remote_unavailable without any worker calls", async () => {
	const service = makeService({});
	const acquire = await service.status("/repo", { action: "acquire", url: "https://example.com/x.git" }, denyConfirm);
	assert.equal(acquire.status, "remote_unavailable");
	const fetch = await service.status("/repo", { action: "fetch", repositoryId: "repo-1" }, denyConfirm);
	assert.equal(fetch.status, "remote_unavailable");
});

test("status surfaces a database error as repair_required without throwing", async () => {
	const { WorkerOperationError } = await import("../worker-client.ts");
	const service = makeService({
		open: () => {
			throw new WorkerOperationError("database", "disk image is malformed");
		},
	});
	const result = await service.status("/repo", { action: "inspect" }, denyConfirm);
	assert.equal(result.status, "repair_required");
	assert.match(result.message ?? "", /disk image is malformed/);
});
