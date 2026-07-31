// Plain, framework-free string rendering for normalized codegraph results.
// Deliberately has zero dependency on @earendil-works/pi-tui or any Pi
// extension API: a later module decides how (or whether) to wrap these
// strings in theme colors or tool-result content blocks.

import type { CodeGraphRelationEdge, CodeGraphSearchResult, CodeGraphStatusResult, CodeGraphSymbol, CodeGraphSymbolResult, CodeGraphTraceResult } from "./types.ts";

type CodeGraphAnyResult = CodeGraphSearchResult | CodeGraphSymbolResult | CodeGraphTraceResult | CodeGraphStatusResult;

const MAX_LIST_ENTRIES = 50;

function isStatusResult(result: CodeGraphAnyResult): result is CodeGraphStatusResult {
	return "action" in result && "indexed" in result;
}

function isTraceResult(result: CodeGraphAnyResult): result is CodeGraphTraceResult {
	return "nodes" in result && Array.isArray((result as CodeGraphTraceResult).nodes);
}

function hasSymbol(result: CodeGraphAnyResult): result is CodeGraphSymbolResult {
	return "symbol" in result && Boolean((result as CodeGraphSymbolResult).symbol);
}

function candidatesOf(result: CodeGraphAnyResult): CodeGraphSymbol[] {
	if ("candidates" in result && Array.isArray((result as CodeGraphSearchResult | CodeGraphSymbolResult).candidates)) {
		return (result as CodeGraphSearchResult | CodeGraphSymbolResult).candidates ?? [];
	}
	return [];
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// `includeId` is opt-in, not default: printing the opaque symbolId on every
// row of a bulk candidate/related list burns real tokens on a hash the
// model almost never reuses (upstream's own Claude-facing formatter omits
// node ids from prose entirely — see @colbymchenry/codegraph's
// context/formatter.js, which references symbols as "name (kind) - path:line"
// and only emits `id` in its separate JSON-for-programmatic-use variant).
// codegraph_trace has no name-based fallback, though, so the id must appear
// somewhere the model can carry forward: on the one resolved focal symbol
// from codegraph_symbol, and on trace node listings themselves — exactly the
// two places a model would actually chain a follow-up call from.
function formatSymbolLine(symbol: CodeGraphSymbol, options: { includeId?: boolean } = {}): string {
	const location = `${symbol.span.path}:${symbol.span.startLine}-${symbol.span.endLine}`;
	const signature = symbol.signature ? ` — ${symbol.signature}` : "";
	const id = options.includeId ? ` {symbolId: ${symbol.symbolId}}` : "";
	return `${symbol.name} [${symbol.kind}/${symbol.language} (${symbol.coverage})] ${location}${signature}${id}`;
}

function formatList<T>(items: T[], formatter: (item: T) => string, cap: number = MAX_LIST_ENTRIES): string[] {
	const lines = items.slice(0, cap).map(formatter);
	if (items.length > cap) lines.push(`... and ${items.length - cap} more`);
	return lines;
}

function coverageCaveatNeeded(symbols: CodeGraphSymbol[]): boolean {
	return symbols.some((symbol) => symbol.coverage === "shallow" || symbol.coverage === "unsupported");
}

function edgeDirectionLabel(edge: CodeGraphRelationEdge, focalSymbolId: string): string {
	if (edge.fromSymbolId === focalSymbolId) return `${edge.kind} →`;
	if (edge.toSymbolId === focalSymbolId) return `${edge.kind} ←`;
	return edge.kind;
}

// ---------------------------------------------------------------------------
// Compact rendering (collapsed tool-call summary)
// ---------------------------------------------------------------------------

export function renderCompact(result: CodeGraphAnyResult): string {
	const repo = result.displayPath || "(unknown repository)";
	const badges: string[] = [];
	if (result.status === "ambiguous") badges.push("ambiguous");
	if (result.freshness?.status === "possibly-stale") badges.push("possibly-stale");
	if (result.bounds?.nodesOmitted) badges.push(`${result.bounds.nodesOmitted} omitted`);
	if (result.bounds?.edgesOmitted) badges.push(`${result.bounds.edgesOmitted} edges omitted`);
	if (result.bounds?.bytesOmitted) badges.push("truncated");
	const badgeSuffix = badges.length > 0 ? ` (${badges.join(", ")})` : "";

	if (isStatusResult(result)) {
		const indexed = result.indexed ? "indexed" : "not indexed";
		return `codegraph status: ${repo} · ${result.action} · ${indexed}${badgeSuffix}`;
	}

	if (isTraceResult(result)) {
		const counts = `${result.nodes.length} node${result.nodes.length === 1 ? "" : "s"}, ${result.edges.length} edge${result.edges.length === 1 ? "" : "s"}`;
		const pathSuffix = result.mode === "shortest_path" ? ` · ${result.pathFound ? "path found" : "no path found"}` : "";
		return `codegraph trace (${result.mode ?? "trace"}): ${repo} · ${counts}${pathSuffix}${badgeSuffix}`;
	}

	if (hasSymbol(result)) {
		const relatedCount = result.related?.length ?? 0;
		const relatedSuffix = relatedCount > 0 ? ` · ${relatedCount} related` : "";
		return `codegraph symbol: ${repo} · ${result.symbol?.name}${relatedSuffix}${badgeSuffix}`;
	}

	const candidates = candidatesOf(result);
	return `codegraph search: ${repo} · ${candidates.length} candidate${candidates.length === 1 ? "" : "s"}${badgeSuffix}`;
}

// ---------------------------------------------------------------------------
// Expanded rendering (full multi-line plain text)
// ---------------------------------------------------------------------------

function headerLines(result: CodeGraphAnyResult): string[] {
	const lines: string[] = [`Repository: ${result.displayPath || "(unknown repository)"}`];
	const identityBits: string[] = [];
	if (result.branch) identityBits.push(`branch ${result.branch}`);
	if (result.head) identityBits.push(`HEAD ${result.head}`);
	if (identityBits.length > 0) lines.push(identityBits.join(" · "));

	if (result.freshness) {
		const lastIndexed = result.freshness.lastIndexedAt != null ? new Date(result.freshness.lastIndexedAt).toISOString() : "never";
		lines.push(`Freshness: ${result.freshness.status} · last indexed ${lastIndexed}`);
		if (result.freshness.warning) lines.push(`Warning: ${result.freshness.warning}`);
	} else {
		lines.push(`Status: ${result.status}`);
	}

	if (result.message) lines.push(result.message);
	if (result.bounds?.bytesOmitted) lines.push("Note: result was truncated to fit the size limit.");
	return lines;
}

export function renderExpanded(result: CodeGraphAnyResult): string {
	const lines: string[] = [...headerLines(result)];
	const involvedSymbols: CodeGraphSymbol[] = [];

	if (isStatusResult(result)) {
		lines.push(`Action: ${result.action}`);
		lines.push(result.indexed ? "Indexed: yes" : "Indexed: no");
		if (result.stats) {
			lines.push(`Stats: ${result.stats.nodeCount} nodes, ${result.stats.edgeCount} edges, ${result.stats.fileCount} files, ${formatBytes(result.stats.dbSizeBytes)}`);
		}
		if (result.languageCounts && Object.keys(result.languageCounts).length > 0) {
			const parts = Object.entries(result.languageCounts).map(([language, count]) => `${language}: ${count}`);
			lines.push(`Languages: ${parts.join(", ")}`);
		}
		if (result.preview) {
			const preview = result.preview;
			lines.push(`First-index preview: worktree ${preview.worktreeRoot}${preview.branch ? ` (${preview.branch})` : ""}`);
			lines.push(`  semantic ${preview.semanticFileCount}, shallow ${preview.shallowFileCount}, unsupported ${preview.unsupportedFileCount}, skipped ${preview.skippedFileCount}`);
			lines.push(`  will create .codegraph/: ${preview.willCreateIndexDir ? "yes" : "no"}`);
		}
	} else if (isTraceResult(result)) {
		if (result.mode === "shortest_path") {
			lines.push(result.pathFound ? "Path found." : "No path found between the requested symbols.");
		}
		involvedSymbols.push(...result.nodes);
		if (result.nodes.length > 0) {
			lines.push("Nodes:");
			for (const line of formatList(result.nodes, (node) => `  ${formatSymbolLine(node, { includeId: true })}`)) lines.push(line);
		}
		if (result.edges.length > 0) {
			lines.push("Edges:");
			for (const line of formatList(result.edges, (edge) => `  ${edge.kind}: ${edge.fromSymbolId} -> ${edge.toSymbolId}`)) lines.push(line);
		}
	} else if (hasSymbol(result) && result.symbol) {
		const symbol = result.symbol;
		involvedSymbols.push(symbol);
		lines.push(`Symbol: ${formatSymbolLine(symbol, { includeId: true })}`);
		if (result.relation) lines.push(`Relation: ${result.relation}`);

		const related = result.related ?? [];
		const edges = result.edges ?? [];
		if (related.length > 0) {
			involvedSymbols.push(...related);
			lines.push("Related:");
			const cappedCount = Math.min(related.length, MAX_LIST_ENTRIES);
			for (let index = 0; index < cappedCount; index++) {
				const relatedSymbol = related[index];
				const edge = edges[index];
				const label = edge ? `[${edgeDirectionLabel(edge, symbol.symbolId)}] ` : "";
				lines.push(`  ${label}${formatSymbolLine(relatedSymbol)}`);
			}
			if (related.length > MAX_LIST_ENTRIES) lines.push(`  ... and ${related.length - MAX_LIST_ENTRIES} more`);
		}

		if (result.source) {
			const truncatedSuffix = result.source.truncated ? ", truncated" : "";
			lines.push(`Source (${result.source.mode}${truncatedSuffix}):`);
			lines.push(result.source.text);
		}
	} else {
		const candidates = candidatesOf(result);
		involvedSymbols.push(...candidates);
		if (result.status === "ambiguous") lines.push(`Ambiguous: ${candidates.length} candidates match.`);
		if (candidates.length === 0) {
			lines.push("No candidates found.");
		} else {
			lines.push("Candidates:");
			for (const line of formatList(candidates, (candidate) => `  ${formatSymbolLine(candidate)}`)) lines.push(line);
		}
	}

	if (coverageCaveatNeeded(involvedSymbols)) {
		lines.push("Note: graph coverage is partial or absent for one or more involved languages (shallow/unsupported); fall back to read/grep to confirm results rather than treating this as authoritative.");
	}

	return lines.join("\n");
}
