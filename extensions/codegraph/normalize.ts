// Normalizes raw @colbymchenry/codegraph worker-op results (see worker.ts)
// into the bounded, versioned public types from types.ts. Nothing in this
// module ever leaks raw upstream fields (e.g. `visibility`, `isAsync`,
// `isStatic`, `isAbstract`, `updatedAt`) into the public contract.

import type {
	CodeGraphBoundsApplied,
	CodeGraphConfig,
	CodeGraphFreshness,
	CodeGraphIndexPreview,
	CodeGraphRelationEdge,
	CodeGraphResultEnvelope,
	CodeGraphResultStatus,
	CodeGraphSourceExcerpt,
	CodeGraphStatusAction,
	CodeGraphStatusResult,
	CodeGraphSearchResult,
	CodeGraphSpan,
	CodeGraphSymbol,
	CodeGraphSymbolRelation,
	CodeGraphSymbolResult,
	CodeGraphTraceMode,
	CodeGraphTraceResult,
} from "./types.ts";
import { RESULT_SCHEMA_VERSION, coverageTierForLanguage } from "./types.ts";

// ---------------------------------------------------------------------------
// Raw upstream shapes (see extensions/codegraph/node_modules/@colbymchenry/codegraph/dist/types.d.ts)
// ---------------------------------------------------------------------------

export interface RawNode {
	id: string;
	kind: string;
	name: string;
	qualifiedName: string;
	filePath: string;
	language: string;
	startLine: number;
	endLine: number;
	startColumn: number;
	endColumn: number;
	signature?: string;
	visibility?: string;
	isExported?: boolean;
	isAsync?: boolean;
	isStatic?: boolean;
	isAbstract?: boolean;
	updatedAt?: number;
}

export interface RawEdge {
	source: string;
	target: string;
	kind: string;
	metadata?: Record<string, unknown>;
	line?: number;
	column?: number;
	provenance?: unknown;
}

export interface RawGraphStats {
	nodeCount: number;
	edgeCount: number;
	fileCount: number;
	dbSizeBytes: number;
	filesByLanguage?: Record<string, number>;
}

export interface RawSymbolSingle {
	node: RawNode;
	related: RawNode[];
	edges: RawEdge[];
	code?: string;
	codeError?: string;
}

export interface RawSymbolCandidates {
	candidates: RawNode[];
}

export interface RawTraceResult {
	pathFound?: boolean;
	nodes: RawNode[];
	edges: RawEdge[];
}

export interface RawStatusResult {
	stats?: RawGraphStats;
	backend?: string;
	journalMode?: string;
	lastIndexedAt?: number | null;
}

// ---------------------------------------------------------------------------
// Context shared by every normalize* call
// ---------------------------------------------------------------------------

export interface NormalizeContext {
	repositoryId: string;
	displayPath: string;
	head: string | null;
	branch: string | null;
	codegraphVersion: string;
	status: CodeGraphResultStatus;
	freshness?: CodeGraphFreshness;
	config: CodeGraphConfig;
	message?: string;
}

// ---------------------------------------------------------------------------
// Leaf mappers
// ---------------------------------------------------------------------------

export function nodeToSymbol(node: RawNode): CodeGraphSymbol {
	const span: CodeGraphSpan = {
		path: node.filePath,
		startLine: node.startLine,
		endLine: node.endLine,
		startColumn: node.startColumn,
		endColumn: node.endColumn,
	};
	const symbol: CodeGraphSymbol = {
		symbolId: node.id,
		name: node.name,
		qualifiedName: node.qualifiedName,
		kind: node.kind,
		language: node.language,
		coverage: coverageTierForLanguage(node.language),
		span,
	};
	if (node.signature) symbol.signature = node.signature;
	if (node.isExported) symbol.isExported = true;
	return symbol;
}

export function edgeToRelation(edge: RawEdge): CodeGraphRelationEdge {
	const relation: CodeGraphRelationEdge = {
		kind: edge.kind,
		fromSymbolId: edge.source,
		toSymbolId: edge.target,
	};
	if (edge.line !== undefined) relation.line = edge.line;
	if (edge.column !== undefined) relation.column = edge.column;
	return relation;
}

export function buildEnvelope(context: NormalizeContext): CodeGraphResultEnvelope {
	const envelope: CodeGraphResultEnvelope = {
		schemaVersion: RESULT_SCHEMA_VERSION,
		codegraphVersion: context.codegraphVersion,
		status: context.status,
		repositoryId: context.repositoryId,
		displayPath: context.displayPath,
		head: context.head,
		branch: context.branch,
	};
	if (context.freshness) envelope.freshness = context.freshness;
	if (context.message) envelope.message = context.message;
	return envelope;
}

// ---------------------------------------------------------------------------
// Bounding helpers
// ---------------------------------------------------------------------------

function boundArray<T>(items: T[], limit: number): { items: T[]; omitted: number } {
	if (items.length <= limit) return { items, omitted: 0 };
	return { items: items.slice(0, limit), omitted: items.length - limit };
}

/**
 * Deterministic last-resort byte trimming: repeatedly drops the last entry
 * from whichever known array field (candidates/nodes/edges/related) is
 * currently largest, re-measuring after every removal, until the object
 * fits `maxBytes` or every such array is empty. Mutates and returns
 * `result` in place; never touches non-array fields.
 */
function enforceByteBudget<T extends Record<string, unknown>>(result: T, maxBytes: number): boolean {
	const arrayKeys = (["candidates", "nodes", "edges", "related"] as const).filter((key) => Array.isArray((result as Record<string, unknown>)[key]));
	if (arrayKeys.length === 0) return false;
	let bytesOmitted = false;
	while (Buffer.byteLength(JSON.stringify(result), "utf8") > maxBytes) {
		let largestKey: (typeof arrayKeys)[number] | null = null;
		let largestLength = 0;
		for (const key of arrayKeys) {
			const length = (result[key] as unknown[]).length;
			if (length > largestLength) {
				largestLength = length;
				largestKey = key;
			}
		}
		if (!largestKey || largestLength === 0) break;
		(result as Record<string, unknown>)[largestKey] = (result[largestKey] as unknown[]).slice(0, -1);
		bytesOmitted = true;
	}
	return bytesOmitted;
}

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

export function normalizeSearchResult(raw: Array<{ node: RawNode; score: number; highlights?: string[] }>, context: NormalizeContext): CodeGraphSearchResult {
	const { items, omitted } = boundArray(raw, context.config.maxResults);
	const result: CodeGraphSearchResult = {
		...buildEnvelope(context),
		candidates: items.map((entry) => nodeToSymbol(entry.node)),
	};
	const bounds: CodeGraphBoundsApplied = { nodeLimit: context.config.maxResults, nodesOmitted: omitted };
	const bytesOmitted = enforceByteBudget(result, context.config.maxResultBytes);
	if (bytesOmitted) bounds.bytesOmitted = true;
	result.bounds = bounds;
	return result;
}

// ---------------------------------------------------------------------------
// symbol
// ---------------------------------------------------------------------------

export function normalizeSymbolResult(
	raw: RawSymbolCandidates | RawSymbolSingle,
	relation: CodeGraphSymbolRelation | undefined,
	includeSource: "none" | "signature" | "bounded-body",
	context: NormalizeContext,
): CodeGraphSymbolResult {
	if ("candidates" in raw) {
		const ambiguous = raw.candidates.length > 1;
		const { items, omitted } = boundArray(raw.candidates, context.config.maxResults);
		const result: CodeGraphSymbolResult = {
			...buildEnvelope({ ...context, status: ambiguous ? "ambiguous" : context.status }),
			candidates: items.map(nodeToSymbol),
		};
		const bounds: CodeGraphBoundsApplied = { nodeLimit: context.config.maxResults, nodesOmitted: omitted };
		const bytesOmitted = enforceByteBudget(result, context.config.maxResultBytes);
		if (bytesOmitted) bounds.bytesOmitted = true;
		result.bounds = bounds;
		return result;
	}

	const { items: relatedItems, omitted: nodesOmitted } = boundArray(raw.related, context.config.maxResults);
	const { items: edgeItems, omitted: edgesOmitted } = boundArray(raw.edges, context.config.maxResults);

	let source: CodeGraphSourceExcerpt | undefined;
	let snippetLineLimit: number | undefined;
	if (includeSource === "signature") {
		source = { mode: "signature", text: raw.node.signature ?? "", truncated: false };
	} else if (includeSource === "bounded-body") {
		const code = raw.code ?? "";
		const lines = code.split("\n");
		if (lines.length > context.config.maxSnippetLines) {
			source = { mode: "bounded-body", text: lines.slice(0, context.config.maxSnippetLines).join("\n"), truncated: true };
			snippetLineLimit = context.config.maxSnippetLines;
		} else {
			source = { mode: "bounded-body", text: code, truncated: false };
		}
	}

	const result: CodeGraphSymbolResult = {
		...buildEnvelope(context),
		symbol: nodeToSymbol(raw.node),
		related: relatedItems.map(nodeToSymbol),
		edges: edgeItems.map(edgeToRelation),
	};
	if (relation) result.relation = relation;
	if (source) result.source = source;

	const bounds: CodeGraphBoundsApplied = { nodeLimit: context.config.maxResults, edgeLimit: context.config.maxResults, nodesOmitted, edgesOmitted };
	if (snippetLineLimit !== undefined) bounds.snippetLineLimit = snippetLineLimit;
	const bytesOmitted = enforceByteBudget(result, context.config.maxResultBytes);
	if (bytesOmitted) bounds.bytesOmitted = true;
	result.bounds = bounds;
	return result;
}

// ---------------------------------------------------------------------------
// trace
// ---------------------------------------------------------------------------

export function normalizeTraceResult(raw: RawTraceResult, mode: CodeGraphTraceMode, context: NormalizeContext): CodeGraphTraceResult {
	const { items: nodeItems, omitted: nodesOmitted } = boundArray(raw.nodes, context.config.maxResults);
	const { items: edgeItems, omitted: edgesOmitted } = boundArray(raw.edges, context.config.maxResults);

	const result: CodeGraphTraceResult = {
		...buildEnvelope(context),
		mode,
		nodes: nodeItems.map(nodeToSymbol),
		edges: edgeItems.map(edgeToRelation),
		pathFound: mode === "shortest_path" ? Boolean(raw.pathFound) : undefined,
	};

	const bounds: CodeGraphBoundsApplied = { nodeLimit: context.config.maxResults, edgeLimit: context.config.maxResults, nodesOmitted, edgesOmitted };
	const bytesOmitted = enforceByteBudget(result, context.config.maxResultBytes);
	if (bytesOmitted) bounds.bytesOmitted = true;
	result.bounds = bounds;
	return result;
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

export function normalizeStatusResult(
	action: CodeGraphStatusAction,
	raw: RawStatusResult | undefined,
	context: NormalizeContext & { indexed: boolean; preview?: CodeGraphIndexPreview },
): CodeGraphStatusResult {
	const result: CodeGraphStatusResult = {
		...buildEnvelope(context),
		action,
		indexed: context.indexed,
	};

	if (raw?.stats) {
		result.stats = {
			nodeCount: raw.stats.nodeCount,
			edgeCount: raw.stats.edgeCount,
			fileCount: raw.stats.fileCount,
			dbSizeBytes: raw.stats.dbSizeBytes,
		};
		if (raw.stats.filesByLanguage) {
			const counts = Object.fromEntries(Object.entries(raw.stats.filesByLanguage).filter(([, count]) => (count ?? 0) > 0));
			if (Object.keys(counts).length > 0) result.languageCounts = counts;
		}
	}

	if (context.preview) result.preview = context.preview;

	enforceByteBudget(result, context.config.maxResultBytes);
	return result;
}
