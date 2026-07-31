import assert from "node:assert/strict";
import test from "node:test";
import { renderCompact, renderExpanded } from "../render.ts";
import type { CodeGraphStatusResult, CodeGraphSymbol, CodeGraphSymbolResult, CodeGraphSearchResult, CodeGraphTraceResult } from "../types.ts";
import { RESULT_SCHEMA_VERSION } from "../types.ts";

function makeSymbol(overrides: Partial<CodeGraphSymbol> = {}): CodeGraphSymbol {
	return {
		symbolId: "fn:abc123",
		name: "doThing",
		qualifiedName: "src/foo.ts::doThing",
		kind: "function",
		language: "typescript",
		coverage: "semantic",
		span: { path: "src/foo.ts", startLine: 10, endLine: 20, startColumn: 0, endColumn: 1 },
		signature: "function doThing(): void",
		...overrides,
	};
}

function makeSearchResult(overrides: Partial<CodeGraphSearchResult> = {}): CodeGraphSearchResult {
	return {
		schemaVersion: RESULT_SCHEMA_VERSION,
		codegraphVersion: "1.5.0",
		status: "ready",
		repositoryId: "repo-1",
		displayPath: "~/code/repo",
		head: "deadbeef",
		branch: "main",
		candidates: [makeSymbol(), makeSymbol({ symbolId: "fn:def456", name: "otherThing" })],
		...overrides,
	};
}

test("renderCompact/renderExpanded on search result mention count and displayPath", () => {
	const result = makeSearchResult();
	const compact = renderCompact(result);
	const expanded = renderExpanded(result);
	assert.match(compact, /2 candidate/);
	assert.ok(compact.includes("~/code/repo"));
	assert.match(expanded, /2/);
	assert.ok(expanded.includes("~/code/repo"));
	assert.ok(compact.length > 0);
	assert.ok(expanded.length > 0);
});

test("renderExpanded on ambiguous symbol result indicates ambiguity and lists candidates", () => {
	const result: CodeGraphSymbolResult = {
		schemaVersion: RESULT_SCHEMA_VERSION,
		codegraphVersion: "1.5.0",
		status: "ambiguous",
		repositoryId: "repo-1",
		displayPath: "~/code/repo",
		head: "deadbeef",
		branch: "main",
		candidates: [makeSymbol(), makeSymbol({ symbolId: "fn:def456", name: "otherThing" })],
	};
	const expanded = renderExpanded(result);
	assert.match(expanded, /[Aa]mbiguous/);
	assert.ok(expanded.includes("doThing"));
	assert.ok(expanded.includes("otherThing"));
});

test("renderExpanded includes partial-coverage caveat for shallow/unsupported symbols", () => {
	const shallowResult = makeSearchResult({ candidates: [makeSymbol({ language: "yaml", coverage: "shallow" })] });
	const shallowExpanded = renderExpanded(shallowResult);
	assert.match(shallowExpanded, /read\/grep|grep/i);

	const unsupportedResult = makeSearchResult({ candidates: [makeSymbol({ language: "cobol", coverage: "unsupported" })] });
	const unsupportedExpanded = renderExpanded(unsupportedResult);
	assert.match(unsupportedExpanded, /read\/grep|grep/i);

	const semanticResult = makeSearchResult({ candidates: [makeSymbol({ coverage: "semantic" })] });
	const semanticExpanded = renderExpanded(semanticResult);
	assert.doesNotMatch(semanticExpanded, /grep/i);
});

test("renderExpanded on a trace result with pathFound false clearly states no path found", () => {
	const result: CodeGraphTraceResult = {
		schemaVersion: RESULT_SCHEMA_VERSION,
		codegraphVersion: "1.5.0",
		status: "ready",
		repositoryId: "repo-1",
		displayPath: "~/code/repo",
		head: "deadbeef",
		branch: "main",
		mode: "shortest_path",
		nodes: [],
		edges: [],
		pathFound: false,
	};
	const expanded = renderExpanded(result);
	assert.match(expanded, /no path found/i);
});

test("renderExpanded truncates long lists and shows an 'and N more' marker", () => {
	const candidates = Array.from({ length: 60 }, (_, index) => makeSymbol({ symbolId: `fn:${index}`, name: `sym${index}` }));
	const result = makeSearchResult({ candidates });
	const expanded = renderExpanded(result);
	assert.match(expanded, /and \d+ more/);
});

test("neither render function throws on a minimal, mostly-empty status result", () => {
	const result: CodeGraphStatusResult = {
		schemaVersion: RESULT_SCHEMA_VERSION,
		codegraphVersion: "1.5.0",
		status: "not_indexed",
		repositoryId: "repo-1",
		displayPath: "~/code/repo",
		head: null,
		branch: null,
		action: "inspect",
		indexed: false,
	};
	assert.doesNotThrow(() => renderCompact(result));
	assert.doesNotThrow(() => renderExpanded(result));
	assert.ok(renderCompact(result).length > 0);
	assert.ok(renderExpanded(result).length > 0);
});
