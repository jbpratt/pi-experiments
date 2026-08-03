// Pure functions for gh_read_file: URL/argv building, percent-encoding,
// binary/size guards, directory-listing detection, and line-window slicing.
// No network access and no `gh` invocation here — see runner.ts/index.ts.

export interface GhReadFileParams {
	repo: string; // "owner/repo"
	path: string;
	ref?: string;
	sha?: string;
	offset?: number;
	limit?: number;
}

const DEFAULT_LINE_LIMIT = 2000;
const MAX_OUTPUT_BYTES = 50 * 1024; // 50KB, matches the built-in read tool's output cap
export const MAX_FILE_BYTES = 1.5 * 1024 * 1024; // ~1.5MB whole-file cap before formatting

// Extensions treated as binary and refused before any fetch happens. Not
// exhaustive; anything not on this list is still backstopped by a post-decode
// NUL-byte / replacement-character check, since `Content-Type` is not a
// usable binary signal on either gh_read_file fetch path (verified: both the
// git-blobs and contents raw endpoints report `application/vnd.github.raw`
// for text and binary files alike).
const BINARY_EXTENSIONS = new Set([
	// images
	"png", "jpg", "jpeg", "gif", "bmp", "ico", "webp", "tiff", "tif", "psd", "ai", "eps", "heic", "heif", "avif",
	// office/documents
	"pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp",
	// archives
	"zip", "tar", "tgz", "gz", "bz2", "xz", "7z", "rar", "zst", "lz4",
	// executables/libraries/objects
	"exe", "dll", "so", "dylib", "a", "o", "obj", "lib", "bin", "wasm", "class", "jar", "war", "ear", "pyc", "pyo", "pyd", "node",
	// databases
	"db", "sqlite", "sqlite3", "mdb",
	// audio/video
	"mp3", "mp4", "wav", "flac", "ogg", "oga", "m4a", "mov", "avi", "mkv", "webm", "wmv", "flv",
	// fonts
	"ttf", "otf", "woff", "woff2", "eot",
	// disk images / packages
	"iso", "img", "dmg", "apk", "aab", "deb", "rpm", "msi", "pak", "crx",
]);

export function getExtension(path: string): string | undefined {
	const base = path.split("/").pop() ?? path;
	const dot = base.lastIndexOf(".");
	if (dot <= 0 || dot === base.length - 1) return undefined;
	return base.slice(dot + 1).toLowerCase();
}

export function isDeniedBinaryExtension(path: string): boolean {
	const extension = getExtension(path);
	return extension !== undefined && BINARY_EXTENSIONS.has(extension);
}

/** Post-decode backstop for files whose extension wasn't on the deny list. */
export function looksBinaryContent(content: string): boolean {
	if (content.includes("\u0000")) return true;
	if (content.length === 0) return false;
	let replacementCount = 0;
	for (const char of content) if (char === "\uFFFD") replacementCount += 1;
	return replacementCount / content.length > 0.01;
}

export function normalizePath(path: string): string {
	let normalized = path.trim();
	while (normalized.startsWith("./")) normalized = normalized.slice(2);
	while (normalized.startsWith("/")) normalized = normalized.slice(1);
	return normalized;
}

export function encodePathSegments(path: string): string {
	return normalizePath(path).split("/").map(encodeURIComponent).join("/");
}

export function parseRepo(repo: string): { owner: string; name: string } {
	const parts = repo.trim().split("/");
	if (parts.length !== 2 || !parts[0] || !parts[1]) {
		throw new Error(`gh_read_file repo must be "owner/repo", got "${repo}"`);
	}
	return { owner: parts[0], name: parts[1] };
}

export interface GhReadFileRequest {
	argv: string[];
	url: string;
	usedSha: boolean;
}

/**
 * `--method GET` is always explicit and any query parameter is embedded
 * directly in the URL string, never passed via `gh api`'s `-f`/`-F`, which
 * would let `gh api` infer a POST — the contents endpoint's POST verb
 * overwrites/creates files. No code path here may omit `--method GET`.
 */
export function buildReadFileRequest(params: GhReadFileParams): GhReadFileRequest {
	const { owner, name } = parseRepo(params.repo);
	if (!params.path.trim()) throw new Error("gh_read_file path must not be empty");

	const sha = params.sha?.trim();
	if (sha) {
		const url = `repos/${owner}/${name}/git/blobs/${encodeURIComponent(sha)}`;
		return { argv: ["api", "--method", "GET", "-H", "Accept: application/vnd.github.raw", url], url, usedSha: true };
	}

	const encodedPath = encodePathSegments(params.path);
	const ref = params.ref?.trim();
	const query = ref ? `?ref=${encodeURIComponent(ref)}` : "";
	const url = `repos/${owner}/${name}/contents/${encodedPath}${query}`;
	return { argv: ["api", "--method", "GET", "-H", "Accept: application/vnd.github.raw", url], url, usedSha: false };
}

// --- Directory listing (contents endpoint only; the git/blobs/{sha} path never returns one) ---

export interface GhDirectoryEntry {
	name: string;
	path: string;
	type: string; // "file" | "dir" | "symlink" | "submodule"
	size?: number;
	sha?: string;
}

export function tryParseDirectoryListing(stdout: string): GhDirectoryEntry[] | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		return undefined;
	}
	if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
	const isEntry = (value: unknown): value is GhDirectoryEntry => {
		return Boolean(value) && typeof value === "object"
			&& typeof (value as { name?: unknown }).name === "string"
			&& typeof (value as { path?: unknown }).path === "string"
			&& typeof (value as { type?: unknown }).type === "string";
	};
	return parsed.every(isEntry) ? (parsed as GhDirectoryEntry[]) : undefined;
}

export function formatDirectoryListing(params: GhReadFileParams, entries: GhDirectoryEntry[]): string {
	const lines = [`gh_read_file: ${params.path || "."} in ${params.repo} is a directory (${entries.length} entries)`, ""];
	for (const entry of entries) {
		const kind = entry.type === "dir" ? "dir " : "file";
		const size = entry.type === "file" && typeof entry.size === "number" ? ` (${entry.size} bytes)` : "";
		lines.push(`[${kind}] ${entry.name}${size}`);
	}
	// offset/limit are a file line-window contract; a directory has no lines to window,
	// so an explicitly-set value is dropped here. Say so rather than silently ignoring it.
	if (params.offset !== undefined || params.limit !== undefined) {
		lines.push("", "Note: offset/limit were ignored — path is a directory, not a file.");
	}
	return lines.join("\n");
}

// --- Binary/size refusal ---

export interface ReadFileRefusal {
	refused: true;
	reason: "binary-extension" | "oversized" | "binary-content";
	message: string;
}

export function refuseForExtension(path: string): ReadFileRefusal {
	const extension = getExtension(path) ?? "(none)";
	return {
		refused: true,
		reason: "binary-extension",
		message: `gh_read_file: "${path}" has extension ".${extension}", which is treated as binary. `
			+ "This build only supports reading text files. Use bash + gh api/curl directly if you specifically need this binary content.",
	};
}

export function refuseForSize(path: string, sizeBytes: number): ReadFileRefusal {
	return {
		refused: true,
		reason: "oversized",
		message: `gh_read_file: "${path}" is ${sizeBytes} bytes, exceeding the ${MAX_FILE_BYTES}-byte text-file cap. `
			+ "GitHub's API does not support partial/range fetch on this endpoint, so the whole file was already downloaded; "
			+ "it is refused here to avoid dumping an oversized file into context.",
	};
}

export function refuseForBinaryContent(path: string): ReadFileRefusal {
	return {
		refused: true,
		reason: "binary-content",
		message: `gh_read_file: "${path}" appears to be binary (NUL bytes or heavy replacement-character density after decoding), `
			+ "even though its extension was not recognized as binary. This build only supports reading text files.",
	};
}

/** Checked before any fetch happens; extension-only, no content available yet. */
export function checkExtensionGuard(path: string): ReadFileRefusal | undefined {
	return isDeniedBinaryExtension(path) ? refuseForExtension(path) : undefined;
}

/** Checked after fetch: whole-file size cap, then the NUL/replacement-char backstop. */
export function checkContentGuard(path: string, content: string): ReadFileRefusal | undefined {
	const sizeBytes = Buffer.byteLength(content, "utf8");
	if (sizeBytes > MAX_FILE_BYTES) return refuseForSize(path, sizeBytes);
	if (looksBinaryContent(content)) return refuseForBinaryContent(path);
	return undefined;
}

// --- Line-window slicing, same 1-indexed contract as the built-in `read` tool ---

export interface LineWindowResult {
	lines: string[];
	startLine: number; // 1-indexed, 0 if the file has no lines
	endLine: number; // 1-indexed inclusive
	totalLines: number;
	truncated: boolean; // true if the window or the output byte cap cut off remaining lines
}

export function sliceLines(content: string, offset?: number, limit?: number): LineWindowResult {
	const allLines = content.split(/\r\n|\r|\n/);
	const totalLines = allLines.length;
	if (totalLines === 0) return { lines: [], startLine: 0, endLine: 0, totalLines: 0, truncated: false };

	const start = Math.max(1, offset ?? 1);
	const effectiveLimit = limit ?? DEFAULT_LINE_LIMIT;
	const startIndex = Math.min(start - 1, totalLines);
	const windowEndExclusive = Math.min(totalLines, startIndex + effectiveLimit);
	const windowLines = allLines.slice(startIndex, windowEndExclusive);
	let truncatedByWindow = windowEndExclusive < totalLines;

	const capped: string[] = [];
	let bytes = 0;
	let truncatedByBytes = false;
	for (const line of windowLines) {
		const lineBytes = Buffer.byteLength(line, "utf8") + 1;
		if (capped.length > 0 && bytes + lineBytes > MAX_OUTPUT_BYTES) {
			truncatedByBytes = true;
			break;
		}
		capped.push(line);
		bytes += lineBytes;
	}
	if (truncatedByBytes) truncatedByWindow = true;

	return {
		lines: capped,
		startLine: startIndex + 1,
		endLine: startIndex + capped.length,
		totalLines,
		truncated: truncatedByWindow,
	};
}

export function formatReadFileText(params: GhReadFileParams, request: GhReadFileRequest, slice: LineWindowResult): string {
	const pin = request.usedSha ? `sha ${params.sha}` : params.ref ? `ref ${params.ref}` : "default branch";
	const refIgnored = request.usedSha && params.ref ? " (ref ignored: sha takes precedence)" : "";
	const header = `gh_read_file: ${params.repo}:${params.path} @ ${pin}${refIgnored}`;
	if (slice.totalLines === 0) return `${header}\n(empty file)`;
	const range = `lines ${slice.startLine}-${slice.endLine} of ${slice.totalLines}`;
	const lines = [`${header} (${range})`, "", ...slice.lines];
	if (slice.truncated) {
		lines.push(
			"",
			`... truncated: more lines remain beyond line ${slice.endLine}. Use offset=${slice.endLine + 1} to continue reading.`,
		);
	}
	return lines.join("\n");
}
