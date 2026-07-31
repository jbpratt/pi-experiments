#!/usr/bin/env node
// CodeGraph library adapter, run as a standalone child process by
// worker-client.ts. This file has no dependency on any Pi extension API: it
// only knows the JSONL protocol in types.ts and the @colbymchenry/codegraph
// library. It is spawned with a minimal, network-disabling environment (see
// worker-client.ts) and is bound to exactly one project root for its whole
// lifetime.
//
// Protocol: one JSON object per line on stdin (WorkerRequest), one JSON
// object per line on stdout (WorkerFrame). stderr is diagnostic text only,
// never parsed. The process prints a "hello" frame on startup, then serially
// processes one request at a time in arrival order (never concurrently)
// because CodeGraph itself is not documented as safe for concurrent
// mutation on one connection.

import { createInterface } from "node:readline";
import { createRequire } from "node:module";

// Defensive: worker-client.ts already sets these on the spawned process env,
// but set them again here so this file is safe to run directly for manual
// diagnosis too.
process.env.DO_NOT_TRACK ??= "1";
process.env.CODEGRAPH_TELEMETRY ??= "0";
process.env.CODEGRAPH_NO_UPDATE_CHECK ??= "1";

const require_ = createRequire(import.meta.url);

const MAX_WIRE_ITEMS = 500;

/** @typedef {import("./types.ts").WorkerRequest} WorkerRequest */
/** @typedef {import("./types.ts").WorkerFrame} WorkerFrame */

let CodeGraphClass;
let codegraphVersion = "unknown";

async function loadLibrary() {
	const moduleExports = await import("@colbymchenry/codegraph");
	CodeGraphClass = moduleExports.CodeGraph ?? moduleExports.default?.CodeGraph;
	if (!CodeGraphClass) {
		throw new Error("codegraph: CodeGraph export not found in @colbymchenry/codegraph (unexpected package layout)");
	}
	try {
		codegraphVersion = require_("@colbymchenry/codegraph/package.json").version ?? "unknown";
	} catch {
		codegraphVersion = "unknown";
	}
}

/** Bound to exactly one project root for the lifetime of this process. */
let boundRoot;
/** @type {import("@colbymchenry/codegraph").CodeGraph | null} */
let graph = null;

function send(frame) {
	process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function sendOk(id, result) {
	send({ type: "ok", id, result });
}

function sendError(id, errorKind, message) {
	send({ type: "error", id, errorKind, message });
}

function capArray(items) {
	return Array.isArray(items) ? items.slice(0, MAX_WIRE_ITEMS) : items;
}

function subgraphToWire(subgraph) {
	if (!subgraph) return { nodes: [], edges: [], roots: [] };
	const nodeEntries = subgraph.nodes instanceof Map ? [...subgraph.nodes.values()] : Object.values(subgraph.nodes ?? {});
	return {
		nodes: capArray(nodeEntries),
		edges: capArray(subgraph.edges ?? []),
		roots: subgraph.roots ?? [],
		confidence: subgraph.confidence,
	};
}

function classifyLibraryError(error) {
	const name = error?.name ?? error?.constructor?.name ?? "";
	if (name === "DatabaseError") return "database";
	if (name === "ParseError") return "parse";
	if (name === "SearchError") return "search";
	if (name === "ConfigError") return "config";
	if (name === "FileError") return "not_found";
	return "internal";
}

function requireGraph(id) {
	if (!graph) {
		sendError(id, "not_open", `No CodeGraph instance is open for ${boundRoot ?? "(no root bound yet)"}. Send "open" first.`);
		return null;
	}
	return graph;
}

async function handleOpen(request) {
	const { id, root } = request;
	if (boundRoot !== undefined && boundRoot !== root) {
		sendError(id, "invalid_request", `This worker is bound to ${boundRoot}; cannot open a different root ${root}.`);
		return;
	}
	boundRoot = root;
	try {
		const initialized = CodeGraphClass.isInitialized(root);
		if (!initialized) {
			sendOk(id, { initialized: false });
			return;
		}
		if (!graph) graph = await CodeGraphClass.open(root, { sync: false });
		sendOk(id, { initialized: true, stats: graph.getStats() });
	} catch (error) {
		sendError(id, classifyLibraryError(error), error instanceof Error ? error.message : String(error));
	}
}

async function handleIndexAll(request) {
	const { id } = request;
	try {
		if (graph) {
			sendOk(id, { stats: graph.getStats(), created: false });
			return;
		}
		if (boundRoot === undefined) {
			sendError(id, "invalid_request", "Send \"open\" before \"index_all\".");
			return;
		}
		graph = await CodeGraphClass.init(boundRoot, {
			index: true,
			onProgress: (progress) => {
				send({ type: "progress", id, filesIndexed: progress?.filesIndexed, filesDiscovered: progress?.filesDiscovered });
			},
		});
		sendOk(id, { stats: graph.getStats(), created: true });
	} catch (error) {
		sendError(id, classifyLibraryError(error), error instanceof Error ? error.message : String(error));
	}
}

async function handleSync(request) {
	const { id } = request;
	const g = requireGraph(id);
	if (!g) return;
	try {
		const syncResult = await g.sync();
		sendOk(id, syncResult ?? null);
	} catch (error) {
		sendError(id, classifyLibraryError(error), error instanceof Error ? error.message : String(error));
	}
}

async function handleChangedFiles(request) {
	const { id } = request;
	const g = requireGraph(id);
	if (!g) return;
	try {
		sendOk(id, g.getChangedFiles());
	} catch (error) {
		sendError(id, classifyLibraryError(error), error instanceof Error ? error.message : String(error));
	}
}

async function handleStats(request) {
	const { id } = request;
	const g = requireGraph(id);
	if (!g) return;
	try {
		sendOk(id, {
			stats: g.getStats(),
			backend: g.getBackend?.(),
			journalMode: g.getJournalMode?.(),
			lastIndexedAt: g.getLastIndexedAt?.() ?? null,
		});
	} catch (error) {
		sendError(id, classifyLibraryError(error), error instanceof Error ? error.message : String(error));
	}
}

async function handleSearch(request) {
	const { id, query, kinds, languages, pathPrefix, limit } = request;
	const g = requireGraph(id);
	if (!g) return;
	try {
		const results = g.searchNodes(query, {
			kinds: kinds && kinds.length > 0 ? kinds : undefined,
			languages: languages && languages.length > 0 ? languages : undefined,
			limit: Math.min(limit * 4, MAX_WIRE_ITEMS),
		});
		const filtered = pathPrefix ? results.filter((match) => match.node?.filePath?.startsWith(pathPrefix)) : results;
		sendOk(id, capArray(filtered.slice(0, limit)));
	} catch (error) {
		sendError(id, classifyLibraryError(error), error instanceof Error ? error.message : String(error));
	}
}

function resolveSymbolCandidates(g, { symbolId, name }) {
	if (symbolId) {
		const context = g.getContext(symbolId);
		return context?.focal ? [context.focal] : [];
	}
	const matches = g.searchNodes(name, { limit: MAX_WIRE_ITEMS });
	const exact = matches.filter((match) => match.node?.name === name || match.node?.qualifiedName === name);
	const pool = exact.length > 0 ? exact : matches;
	const seen = new Map();
	for (const match of pool) {
		if (match.node && !seen.has(match.node.id)) seen.set(match.node.id, match.node);
	}
	return [...seen.values()];
}

async function handleSymbol(request) {
	const { id, symbolId, name, relation, depth, limit, includeSource } = request;
	const g = requireGraph(id);
	if (!g) return;
	try {
		let candidates;
		try {
			candidates = resolveSymbolCandidates(g, { symbolId, name });
		} catch (error) {
			sendError(id, classifyLibraryError(error), error instanceof Error ? error.message : String(error));
			return;
		}
		if (candidates.length === 0) {
			sendOk(id, { candidates: [] });
			return;
		}
		if (candidates.length > 1) {
			sendOk(id, { candidates: capArray(candidates.slice(0, limit)) });
			return;
		}
		const node = candidates[0];
		const result = { node, related: [], edges: [] };
		if (relation && relation !== "definition") {
			switch (relation) {
				case "usages": {
					const pairs = g.findUsages(node.id).slice(0, limit);
					result.related = pairs.map((p) => p.node);
					result.edges = pairs.map((p) => p.edge);
					break;
				}
				case "callers": {
					const pairs = g.getCallers(node.id, depth).slice(0, limit);
					result.related = pairs.map((p) => p.node);
					result.edges = pairs.map((p) => p.edge);
					break;
				}
				case "callees": {
					const pairs = g.getCallees(node.id, depth).slice(0, limit);
					result.related = pairs.map((p) => p.node);
					result.edges = pairs.map((p) => p.edge);
					break;
				}
				case "type_hierarchy": {
					const subgraph = subgraphToWire(g.getTypeHierarchy(node.id));
					result.related = subgraph.nodes.slice(0, limit);
					result.edges = subgraph.edges.slice(0, limit);
					break;
				}
				case "context": {
					const context = g.getContext(node.id);
					const relatedNodes = [...(context.ancestors ?? []), ...(context.children ?? []), ...(context.types ?? []), ...(context.imports ?? [])];
					const refs = [...(context.incomingRefs ?? []), ...(context.outgoingRefs ?? [])];
					const seen = new Map(relatedNodes.map((n) => [n.id, n]));
					for (const ref of refs) if (ref.node) seen.set(ref.node.id, ref.node);
					result.related = [...seen.values()].slice(0, limit);
					result.edges = refs.map((r) => r.edge).slice(0, limit);
					break;
				}
			}
		}
		if (includeSource === "bounded-body") {
			try {
				result.code = await g.getCode(node.id);
			} catch (error) {
				result.codeError = error instanceof Error ? error.message : String(error);
			}
		}
		sendOk(id, result);
	} catch (error) {
		sendError(id, classifyLibraryError(error), error instanceof Error ? error.message : String(error));
	}
}

async function handleTrace(request) {
	const { id, mode, fromSymbolId, toSymbolId, edgeKinds, depth, limit } = request;
	const g = requireGraph(id);
	if (!g) return;
	try {
		if (mode === "shortest_path") {
			if (!toSymbolId) {
				sendError(id, "invalid_request", "shortest_path requires toSymbolId.");
				return;
			}
			const path = g.findPath(fromSymbolId, toSymbolId, edgeKinds && edgeKinds.length > 0 ? edgeKinds : undefined);
			if (!path) {
				sendOk(id, { pathFound: false, nodes: [], edges: [] });
				return;
			}
			sendOk(id, {
				pathFound: true,
				nodes: capArray(path.map((step) => step.node).slice(0, limit)),
				edges: capArray(path.map((step) => step.edge).filter(Boolean).slice(0, limit)),
			});
			return;
		}
		if (mode === "call_graph") {
			const subgraph = subgraphToWire(g.getCallGraph(fromSymbolId, depth));
			sendOk(id, { pathFound: undefined, nodes: subgraph.nodes.slice(0, limit), edges: subgraph.edges.slice(0, limit) });
			return;
		}
		if (mode === "impact") {
			const subgraph = subgraphToWire(g.getImpactRadius(fromSymbolId, depth));
			sendOk(id, { pathFound: undefined, nodes: subgraph.nodes.slice(0, limit), edges: subgraph.edges.slice(0, limit) });
			return;
		}
		sendError(id, "invalid_request", `Unknown trace mode: ${mode}`);
	} catch (error) {
		sendError(id, classifyLibraryError(error), error instanceof Error ? error.message : String(error));
	}
}

async function handleClose(request) {
	const { id } = request;
	try {
		graph?.close();
		graph = null;
		sendOk(id, null);
	} catch (error) {
		sendError(id, classifyLibraryError(error), error instanceof Error ? error.message : String(error));
	} finally {
		process.exit(0);
	}
}

async function handleRequest(request) {
	switch (request.type) {
		case "open":
			return handleOpen(request);
		case "close":
			return handleClose(request);
		case "index_all":
			return handleIndexAll(request);
		case "sync":
			return handleSync(request);
		case "changed_files":
			return handleChangedFiles(request);
		case "stats":
			return handleStats(request);
		case "search":
			return handleSearch(request);
		case "symbol":
			return handleSymbol(request);
		case "trace":
			return handleTrace(request);
		default:
			sendError(request.id ?? "unknown", "invalid_request", `Unknown request type: ${JSON.stringify(request.type)}`);
	}
}

async function main() {
	try {
		await loadLibrary();
	} catch (error) {
		send({ type: "error", id: "startup", errorKind: "runtime_unsupported", message: error instanceof Error ? error.message : String(error) });
		process.exitCode = 1;
		return;
	}

	send({ type: "hello", protocolVersion: 1, codegraphVersion, nodeVersion: process.version });

	const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
	for await (const line of rl) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let request;
		try {
			request = JSON.parse(trimmed);
		} catch {
			send({ type: "error", id: "unknown", errorKind: "invalid_request", message: "Malformed JSON request line." });
			continue;
		}
		if (!request || typeof request !== "object" || typeof request.id !== "string" || typeof request.type !== "string") {
			send({ type: "error", id: request?.id ?? "unknown", errorKind: "invalid_request", message: "Request missing required id/type fields." });
			continue;
		}
		// Sequential by construction: we await each handler fully before the
		// `for await` loop reads the next line.
		await handleRequest(request);
	}
	graph?.close();
}

process.on("SIGTERM", () => {
	graph?.close();
	process.exit(0);
});

main();
