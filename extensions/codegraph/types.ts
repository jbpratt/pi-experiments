// Extension-owned, versioned types for the codegraph extension. Nothing here
// is the raw @colbymchenry/codegraph library shape: worker.ts adapts library
// results into these types before they cross the worker/JSONL boundary, and
// normalize.ts adapts them again into the final bounded public tool results.
//
// Phase scope: local worktrees only. Remote acquisition (Phase 2) types are
// present in the public status schema for forward compatibility, but the
// service layer returns "remote_unavailable" for them in this build.

export const RESULT_SCHEMA_VERSION = 1;
export const WORKER_PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// Coverage / language tiers
//
// Upstream (@colbymchenry/codegraph 1.5.0) enumerates ~40 languages; Phase 1
// only claims semantic-graph quality for the subset below. Everything else
// (including "yaml", present upstream) is shallow or unsupported here. This
// mapping is intentionally conservative and versioned separately from
// upstream's own language list so a future upstream language addition never
// silently upgrades our coverage claim.
// ---------------------------------------------------------------------------

export type CoverageTier = "semantic" | "shallow" | "unsupported";

const SEMANTIC_LANGUAGES = new Set(["python", "typescript", "javascript", "tsx", "jsx", "go"]);
const SHALLOW_LANGUAGES = new Set(["yaml"]);

export function coverageTierForLanguage(language: string | undefined | null): CoverageTier {
	if (!language) return "unsupported";
	if (SEMANTIC_LANGUAGES.has(language)) return "semantic";
	if (SHALLOW_LANGUAGES.has(language)) return "shallow";
	return "unsupported";
}

// ---------------------------------------------------------------------------
// Repository identity
// ---------------------------------------------------------------------------

export interface CodeGraphRepositoryIdentity {
	/** Opaque stable identifier derived from the canonical worktree root. */
	id: string;
	source: "local";
	/** Canonical (symlink-resolved) absolute worktree root. */
	worktreeRoot: string;
	/** `git rev-parse --git-common-dir`, resolved to an absolute path. */
	gitCommonDir: string;
	head: string | null;
	branch: string | null;
	/** Fixed relative directory name upstream uses under the worktree root. */
	indexDirName: ".codegraph";
}

// ---------------------------------------------------------------------------
// Freshness
// ---------------------------------------------------------------------------

export interface CodeGraphSyncSummary {
	filesChecked: number;
	filesAdded: number;
	filesModified: number;
	filesRemoved: number;
	nodesUpdated: number;
	durationMs: number;
}

export interface CodeGraphFreshness {
	status: "current" | "synced" | "possibly-stale" | "incomplete";
	lastIndexedAt: number | null;
	/** Monotonic per-root counter; bumped on every completed sync. */
	generation: string;
	sync?: CodeGraphSyncSummary;
	dirtyWorktree: boolean;
	changedAfterQuery?: boolean;
	warning?: string;
}

// ---------------------------------------------------------------------------
// Normalized symbol/edge shapes (worker -> extension boundary and beyond)
// ---------------------------------------------------------------------------

export interface CodeGraphSpan {
	path: string;
	startLine: number;
	endLine: number;
	startColumn: number;
	endColumn: number;
}

export interface CodeGraphSymbol {
	/** Opaque, stable-per-content symbol id from upstream (`kind:hash`). */
	symbolId: string;
	name: string;
	qualifiedName: string;
	kind: string;
	language: string;
	coverage: CoverageTier;
	signature?: string;
	span: CodeGraphSpan;
	isExported?: boolean;
}

export interface CodeGraphRelationEdge {
	kind: string;
	fromSymbolId: string;
	toSymbolId: string;
	line?: number;
	column?: number;
}

export interface CodeGraphSourceExcerpt {
	mode: "signature" | "bounded-body";
	text: string;
	truncated: boolean;
}

// ---------------------------------------------------------------------------
// Bounds / truncation
// ---------------------------------------------------------------------------

export interface CodeGraphBoundsApplied {
	nodeLimit?: number;
	edgeLimit?: number;
	depthLimit?: number;
	snippetLineLimit?: number;
	byteLimit?: number;
	nodesOmitted?: number;
	edgesOmitted?: number;
	bytesOmitted?: boolean;
}

// ---------------------------------------------------------------------------
// Result envelope shared by every tool result
// ---------------------------------------------------------------------------

export type CodeGraphResultStatus =
	| "ready"
	| "not_indexed"
	| "consent_required"
	| "sync_failed"
	| "possibly_stale"
	| "ambiguous"
	| "partial"
	| "unsupported_language"
	| "worker_failed"
	| "protocol_failed"
	| "cancelled"
	| "timeout"
	| "repair_required"
	| "remote_unavailable"
	| "remote_failed"
	| "runtime_unsupported";

export interface CodeGraphResultEnvelope {
	schemaVersion: typeof RESULT_SCHEMA_VERSION;
	codegraphVersion: string;
	status: CodeGraphResultStatus;
	repositoryId: string;
	displayPath: string;
	head: string | null;
	branch: string | null;
	freshness?: CodeGraphFreshness;
	bounds?: CodeGraphBoundsApplied;
	message?: string;
}

export interface CodeGraphSearchResult extends CodeGraphResultEnvelope {
	candidates: CodeGraphSymbol[];
}

export interface CodeGraphSymbolResult extends CodeGraphResultEnvelope {
	/** Populated when the request resolved to exactly one symbol. */
	symbol?: CodeGraphSymbol;
	/** Populated instead of `symbol` when `name` was ambiguous. */
	candidates?: CodeGraphSymbol[];
	relation?: CodeGraphSymbolInput["relation"];
	related?: CodeGraphSymbol[];
	edges?: CodeGraphRelationEdge[];
	source?: CodeGraphSourceExcerpt;
}

export interface CodeGraphTraceResult extends CodeGraphResultEnvelope {
	mode?: CodeGraphTraceInput["mode"];
	nodes: CodeGraphSymbol[];
	edges: CodeGraphRelationEdge[];
	pathFound?: boolean;
}

export interface CodeGraphStatusResult extends CodeGraphResultEnvelope {
	action: CodeGraphStatusInput["action"];
	indexed: boolean;
	stats?: {
		nodeCount: number;
		edgeCount: number;
		fileCount: number;
		dbSizeBytes: number;
	};
	languageCounts?: Record<string, number>;
	preview?: CodeGraphIndexPreview;
}

export interface CodeGraphIndexPreview {
	worktreeRoot: string;
	branch: string | null;
	head: string | null;
	willCreateIndexDir: boolean;
	semanticFileCount: number;
	shallowFileCount: number;
	unsupportedFileCount: number;
	skippedFileCount: number;
}

// ---------------------------------------------------------------------------
// Public tool input schemas (types only; runtime schemas live in index.ts)
// ---------------------------------------------------------------------------

export type CodeGraphNodeKind = string;
export type CodeGraphEdgeKind = string;

export interface CodeGraphSearchInput {
	query: string;
	repositoryId?: string;
	kinds?: CodeGraphNodeKind[];
	languages?: string[];
	pathPrefix?: string;
	limit?: number;
}

export type CodeGraphSymbolRelation = "definition" | "usages" | "callers" | "callees" | "type_hierarchy" | "context";

export interface CodeGraphSymbolInput {
	symbolId?: string;
	name?: string;
	repositoryId?: string;
	relation?: CodeGraphSymbolRelation;
	depth?: number;
	limit?: number;
	includeSource?: "none" | "signature" | "bounded-body";
}

export type CodeGraphTraceMode = "shortest_path" | "call_graph" | "impact";

export interface CodeGraphTraceInput {
	mode: CodeGraphTraceMode;
	fromSymbolId: string;
	toSymbolId?: string;
	repositoryId?: string;
	edgeKinds?: CodeGraphEdgeKind[];
	depth?: number;
	limit?: number;
}

export type CodeGraphStatusAction = "inspect" | "ensure" | "refresh" | "acquire" | "fetch";

export interface CodeGraphStatusInput {
	action?: CodeGraphStatusAction;
	scope?: "current" | "registered" | "remote";
	repositoryId?: string;
	url?: string;
	ref?: string;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface CodeGraphConfig {
	maxWorkers: number;
	maxResults: number;
	maxDepth: number;
	maxSnippetLines: number;
	maxResultBytes: number;
	indexTimeoutMs: number;
	syncTimeoutMs: number;
	exclude: string[];
}

export const DEFAULT_CONFIG: CodeGraphConfig = {
	maxWorkers: 2,
	maxResults: 50,
	maxDepth: 3,
	maxSnippetLines: 40,
	maxResultBytes: 32_768,
	indexTimeoutMs: 1_800_000,
	syncTimeoutMs: 300_000,
	exclude: [],
};

// ---------------------------------------------------------------------------
// Registry (private, user-only, on-disk consent/index metadata)
// ---------------------------------------------------------------------------

export interface CodeGraphRegistryEntry {
	schemaVersion: 1;
	repositoryId: string;
	source: "local";
	worktreeRoot: string;
	consentAt: number;
	lastGeneration: string | null;
	lastIndexedAt: number | null;
	codegraphVersion: string;
	extensionVersion: string;
	state: "ready" | "incomplete" | "repair-required";
}

// ---------------------------------------------------------------------------
// Worker protocol (parent <-> child JSONL RPC)
//
// Each frame is one JSON object per line on the child's stdin/stdout. The
// child never receives an executable, module path, shell command, or
// arbitrary database path in a request: `root` is validated by the parent
// before the worker is spawned, and every operation is a known, typed op.
// ---------------------------------------------------------------------------

export interface WorkerOpenRequest {
	type: "open";
	id: string;
	root: string;
}

export interface WorkerCloseRequest {
	type: "close";
	id: string;
}

export interface WorkerIndexAllRequest {
	type: "index_all";
	id: string;
}

export interface WorkerSyncRequest {
	type: "sync";
	id: string;
}

export interface WorkerChangedFilesRequest {
	type: "changed_files";
	id: string;
}

export interface WorkerStatsRequest {
	type: "stats";
	id: string;
}

export interface WorkerSearchRequest {
	type: "search";
	id: string;
	query: string;
	kinds?: string[];
	languages?: string[];
	pathPrefix?: string;
	limit: number;
}

export interface WorkerSymbolRequest {
	type: "symbol";
	id: string;
	symbolId?: string;
	name?: string;
	relation?: CodeGraphSymbolRelation;
	depth: number;
	limit: number;
	includeSource: "none" | "signature" | "bounded-body";
}

export interface WorkerTraceRequest {
	type: "trace";
	id: string;
	mode: CodeGraphTraceMode;
	fromSymbolId: string;
	toSymbolId?: string;
	edgeKinds?: string[];
	depth: number;
	limit: number;
}

export type WorkerRequest =
	| WorkerOpenRequest
	| WorkerCloseRequest
	| WorkerIndexAllRequest
	| WorkerSyncRequest
	| WorkerChangedFilesRequest
	| WorkerStatsRequest
	| WorkerSearchRequest
	| WorkerSymbolRequest
	| WorkerTraceRequest;

// Preflight file/language counting for the first-index confirmation preview
// runs in service.ts via `git ls-files`, before any worker exists and before
// any CodeGraph API is touched. It is intentionally not a worker operation.

export interface WorkerProgressFrame {
	type: "progress";
	id: string;
	filesIndexed?: number;
	filesDiscovered?: number;
}

export interface WorkerOkFrame {
	type: "ok";
	id: string;
	result: unknown;
}

export interface WorkerErrorFrame {
	type: "error";
	id: string;
	errorKind: "not_open" | "already_open" | "database" | "parse" | "search" | "config" | "not_found" | "ambiguous" | "invalid_request" | "internal" | "runtime_unsupported";
	message: string;
}

export interface WorkerHelloFrame {
	type: "hello";
	protocolVersion: typeof WORKER_PROTOCOL_VERSION;
	codegraphVersion: string;
	nodeVersion: string;
}

export type WorkerFrame = WorkerProgressFrame | WorkerOkFrame | WorkerErrorFrame | WorkerHelloFrame;
