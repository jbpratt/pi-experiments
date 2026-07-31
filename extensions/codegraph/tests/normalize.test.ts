import assert from "node:assert/strict";
import test from "node:test";
import { nodeToSymbol, normalizeSearchResult, normalizeSymbolResult, normalizeTraceResult } from "../normalize.ts";
import type { NormalizeContext, RawEdge, RawNode } from "../normalize.ts";
import { DEFAULT_CONFIG } from "../types.ts";

function makeNode(overrides: Partial<RawNode> = {}): RawNode {
	return {
		id: "fn:abc123",
		kind: "function",
		name: "doThing",
		qualifiedName: "src/foo.ts::doThing",
		filePath: "src/foo.ts",
		language: "typescript",
		startLine: 10,
		endLine: 20,
		startColumn: 0,
		endColumn: 1,
		signature: "function doThing(): void",
		visibility: "public",
		isExported: true,
		isAsync: false,
		isStatic: false,
		isAbstract: false,
		updatedAt: 1700000000000,
		...overrides,
	};
}

function makeEdge(overrides: Partial<RawEdge> = {}): RawEdge {
	return {
		source: "fn:abc123",
		target: "fn:def456",
		kind: "calls",
		line: 15,
		column: 2,
		metadata: { note: "upstream noise" },
		provenance: { tool: "upstream" },
		...overrides,
	};
}

function makeContext(overrides: Partial<NormalizeContext> = {}): NormalizeContext {
	return {
		repositoryId: "repo-1",
		displayPath: "~/code/repo",
		head: "deadbeef",
		branch: "main",
		codegraphVersion: "1.5.0",
		status: "ready",
		config: DEFAULT_CONFIG,
		...overrides,
	};
}

test("nodeToSymbol maps coverage tiers and drops upstream-only fields", () => {
	const semantic = nodeToSymbol(makeNode({ language: "typescript" }));
	assert.equal(semantic.coverage, "semantic");

	const shallow = nodeToSymbol(makeNode({ language: "yaml" }));
	assert.equal(shallow.coverage, "shallow");

	const unsupported = nodeToSymbol(makeNode({ language: "cobol" }));
	assert.equal(unsupported.coverage, "unsupported");

	for (const key of ["visibility", "isAsync", "isStatic", "isAbstract", "updatedAt"]) {
		assert.equal(Object.prototype.hasOwnProperty.call(semantic, key), false, `${key} must not leak onto CodeGraphSymbol`);
	}
	assert.equal(semantic.symbolId, "fn:abc123");
	assert.deepEqual(semantic.span, { path: "src/foo.ts", startLine: 10, endLine: 20, startColumn: 0, endColumn: 1 });
});

test("normalizeSearchResult truncates to maxResults and reports nodesOmitted", () => {
	const config = { ...DEFAULT_CONFIG, maxResults: 2 };
	const raw = [makeNode({ id: "a" }), makeNode({ id: "b" }), makeNode({ id: "c" })].map((node) => ({ node, score: 1 }));
	const result = normalizeSearchResult(raw, makeContext({ config }));
	assert.equal(result.candidates.length, 2);
	assert.equal(result.bounds?.nodesOmitted, 1);
});

test("normalizeSymbolResult with 2 candidates sets status ambiguous and no symbol", () => {
	const raw = { candidates: [makeNode({ id: "a" }), makeNode({ id: "b" })] };
	const result = normalizeSymbolResult(raw, undefined, "none", makeContext());
	assert.ok(result.candidates);
	assert.equal(result.candidates?.length, 2);
	assert.equal(result.symbol, undefined);
	assert.equal(result.status, "ambiguous");
});

test("normalizeSymbolResult with zero candidates passes through caller status", () => {
	const raw = { candidates: [] as RawNode[] };
	const result = normalizeSymbolResult(raw, undefined, "none", makeContext({ status: "ready", message: "no matches" }));
	assert.deepEqual(result.candidates, []);
	assert.equal(result.status, "ready");
});

test("normalizeSymbolResult truncates a too-long bounded-body snippet", () => {
	const config = { ...DEFAULT_CONFIG, maxSnippetLines: 3 };
	const code = ["line1", "line2", "line3", "line4", "line5"].join("\n");
	const raw = { node: makeNode(), related: [], edges: [], code };
	const result = normalizeSymbolResult(raw, undefined, "bounded-body", makeContext({ config }));
	assert.equal(result.source?.truncated, true);
	assert.equal(result.source?.text.split("\n").length, 3);
	assert.equal(result.bounds?.snippetLineLimit, 3);
});

test("normalizeSymbolResult with includeSource none never sets source", () => {
	const raw = { node: makeNode(), related: [], edges: [] };
	const result = normalizeSymbolResult(raw, undefined, "none", makeContext());
	assert.equal(result.source, undefined);
});

test("normalizeSymbolResult drops metadata/provenance from edges", () => {
	const raw = { node: makeNode(), related: [makeNode({ id: "callee" })], edges: [makeEdge()] };
	const result = normalizeSymbolResult(raw, "callees", "none", makeContext());
	assert.equal(result.edges?.length, 1);
	const edge = result.edges?.[0] as Record<string, unknown>;
	assert.equal(edge.fromSymbolId, "fn:abc123");
	assert.equal(edge.toSymbolId, "fn:def456");
	assert.equal("metadata" in edge, false);
	assert.equal("provenance" in edge, false);
});

test("byte budget enforcement trims candidates and sets bytesOmitted", () => {
	const config = { ...DEFAULT_CONFIG, maxResults: 1000, maxResultBytes: 900 };
	const longName = "x".repeat(200);
	const raw = Array.from({ length: 20 }, (_, index) => ({
		node: makeNode({ id: `sym-${index}`, name: longName, signature: longName }),
		score: 1,
	}));
	const result = normalizeSearchResult(raw, makeContext({ config }));
	const bytes = Buffer.byteLength(JSON.stringify(result), "utf8");
	assert.ok(bytes <= config.maxResultBytes, `expected ${bytes} <= ${config.maxResultBytes}`);
	assert.equal(result.bounds?.bytesOmitted, true);
});

test("normalizeTraceResult leaves pathFound undefined for call_graph", () => {
	const result = normalizeTraceResult({ nodes: [makeNode()], edges: [] }, "call_graph", makeContext());
	assert.equal(result.pathFound, undefined);
});

test("normalizeTraceResult carries through pathFound for shortest_path, including false", () => {
	const found = normalizeTraceResult({ pathFound: true, nodes: [makeNode()], edges: [makeEdge()] }, "shortest_path", makeContext());
	assert.equal(found.pathFound, true);

	const notFound = normalizeTraceResult({ pathFound: false, nodes: [], edges: [] }, "shortest_path", makeContext());
	assert.equal(notFound.pathFound, false);
	assert.deepEqual(notFound.nodes, []);
	assert.deepEqual(notFound.edges, []);
});
