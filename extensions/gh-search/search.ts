// Pure functions for gh_search: argv building, --json field selection, response
// parsing, and bounded formatting. No network access and no `gh` invocation here —
// see runner.ts/index.ts for execution.

export type GhSearchType = "code" | "repos" | "issues" | "prs" | "commits";
export type GhSearchOrder = "asc" | "desc";
export type GhIssueState = "open" | "closed";

export interface GhSearchParams {
	type: GhSearchType;
	query?: string;
	owner?: string[];
	repo?: string[];
	limit?: number;
	sort?: string;
	order?: GhSearchOrder;
	// code
	language?: string;
	filename?: string;
	extension?: string;
	match?: string[];
	// repos / issues / prs / commits
	visibility?: string[];
	// issues / prs
	state?: GhIssueState;
	label?: string[];
	author?: string;
	assignee?: string;
	// prs only
	draft?: boolean;
	merged?: boolean;
	// commits only
	committer?: string;
}

export const DEFAULT_SEARCH_LIMIT = 20;
const MAX_OUTPUT_CHARS = 7000; // ~6-8KB text budget
const MAX_FRAGMENTS_PER_RESULT = 2;
const FRAGMENT_TRIM_CHARS = 200;
const FREE_TEXT_TRIM_CHARS = 200;

const COMMON_FIELDS = ["type", "query", "owner", "repo", "limit", "sort", "order"] as const;

const TYPE_FIELDS: Record<GhSearchType, readonly string[]> = {
	code: [...COMMON_FIELDS, "language", "filename", "extension", "match"],
	repos: [...COMMON_FIELDS, "visibility"],
	issues: [...COMMON_FIELDS, "visibility", "state", "label", "author", "assignee"],
	prs: [...COMMON_FIELDS, "visibility", "state", "label", "author", "assignee", "draft", "merged"],
	commits: [...COMMON_FIELDS, "visibility", "committer"],
};

const JSON_FIELDS: Record<GhSearchType, string> = {
	code: "path,repository,sha,textMatches,url",
	repos: "fullName,description,stargazersCount,language,updatedAt,url,isArchived",
	issues: "number,title,state,author,labels,commentsCount,updatedAt,url",
	prs: "number,title,state,author,labels,commentsCount,updatedAt,url,isDraft",
	commits: "sha,repository,commit,url",
};

/**
 * Rejects a call whose params include a field that does not apply to the
 * chosen `type`, naming the offending field and the valid fields for that
 * type. Silently ignoring a field the model explicitly set would let the
 * model wrongly conclude the filter had no matches instead of learning it
 * doesn't apply.
 */
export function validateSearchParams(params: GhSearchParams): void {
	const allowed = TYPE_FIELDS[params.type];
	if (!allowed) throw new Error(`gh_search: unknown type "${params.type}"`);
	const allowedSet = new Set<string>(allowed);
	for (const [key, value] of Object.entries(params)) {
		if (value === undefined) continue;
		if (!allowedSet.has(key)) {
			const validFields = allowed.filter((field) => field !== "type").join(", ");
			throw new Error(
				`gh_search field "${key}" is not valid for type "${params.type}". Valid fields for type "${params.type}": ${validFields}.`,
			);
		}
	}
}

function pushRepeatable(argv: string[], flag: string, values: string[] | undefined): void {
	if (!values) return;
	for (const value of values) argv.push(flag, value);
}

/**
 * Builds the argv to pass to `gh search <type> ...` (the "search" and "<type>"
 * tokens are NOT included here; see index.ts). Always includes `--json` with
 * the curated field list for the type. Never emits `--web`/`--template`.
 */
export function buildSearchArgv(params: GhSearchParams): string[] {
	validateSearchParams(params);
	const argv: string[] = [];
	pushRepeatable(argv, "--owner", params.owner);
	pushRepeatable(argv, "--repo", params.repo);
	if (params.limit !== undefined) argv.push("--limit", String(params.limit));
	if (params.sort !== undefined) argv.push("--sort", params.sort);
	if (params.order !== undefined) argv.push("--order", params.order);
	if (params.language !== undefined) argv.push("--language", params.language);
	if (params.filename !== undefined) argv.push("--filename", params.filename);
	if (params.extension !== undefined) argv.push("--extension", params.extension);
	pushRepeatable(argv, "--match", params.match);
	pushRepeatable(argv, "--visibility", params.visibility);
	if (params.state !== undefined) argv.push("--state", params.state);
	pushRepeatable(argv, "--label", params.label);
	if (params.author !== undefined) argv.push("--author", params.author);
	if (params.assignee !== undefined) argv.push("--assignee", params.assignee);
	if (params.draft !== undefined) argv.push(`--draft=${params.draft}`);
	if (params.merged !== undefined) argv.push(`--merged=${params.merged}`);
	if (params.committer !== undefined) argv.push("--committer", params.committer);
	argv.push("--json", JSON_FIELDS[params.type]);
	const query = params.query?.trim();
	if (query) {
		// gh's own Cobra flag parser (no shell involved) treats an argv element
		// starting with `-` as an unrecognized flag. A literal `--` marks the
		// end of flags so a leading-dash query (e.g. a negated qualifier like
		// `-label:bug`) is passed through as a plain positional argument.
		if (query.split(/\s+/).some((token) => token.startsWith("-"))) argv.push("--");
		argv.push(query);
	}
	return argv;
}

// --- Result row shapes, verified against the live `gh` CLI/API during design. ---

export interface GhCodeRow {
	path: string;
	repository: { nameWithOwner: string; url: string };
	sha: string;
	url: string;
	textMatches?: Array<{ fragment?: string }>;
}

export interface GhRepoRow {
	fullName: string;
	description?: string | null;
	stargazersCount?: number;
	language?: string | null;
	updatedAt?: string;
	url: string;
	isArchived?: boolean;
}

export interface GhIssueRow {
	number: number;
	title: string;
	state: string;
	author?: { login?: string } | null;
	labels?: Array<{ name: string }>;
	commentsCount?: number;
	updatedAt?: string;
	url: string;
	isDraft?: boolean; // prs only
}

export interface GhCommitRow {
	sha: string;
	repository?: { fullName?: string; nameWithOwner?: string };
	commit?: { message?: string; author?: { name?: string; date?: string } };
	url: string;
}

export type GhSearchRow = GhCodeRow | GhRepoRow | GhIssueRow | GhCommitRow;

export function parseSearchOutput(type: GhSearchType, stdout: string): GhSearchRow[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch (error) {
		throw new Error(`gh search ${type} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!Array.isArray(parsed)) throw new Error(`gh search ${type} returned non-array JSON`);
	return parsed as GhSearchRow[];
}

function trim(text: string | undefined | null, max: number): string {
	if (!text) return "";
	const collapsed = text.replace(/\s+/g, " ").trim();
	return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}

function formatCodeRow(row: GhCodeRow, index: number): string[] {
	const lines = [
		`${index}. ${row.path} — ${row.repository?.nameWithOwner ?? "unknown/unknown"}`,
		`   sha: ${row.sha}`,
		`   url: ${row.url}`,
	];
	for (const fragment of (row.textMatches ?? []).slice(0, MAX_FRAGMENTS_PER_RESULT)) {
		const text = trim(fragment.fragment, FRAGMENT_TRIM_CHARS);
		if (text) lines.push(`   > ${text}`);
	}
	return lines;
}

function formatRepoRow(row: GhRepoRow, index: number): string[] {
	const stars = row.stargazersCount ?? 0;
	const archived = row.isArchived ? " [archived]" : "";
	const language = row.language ? ` · ${row.language}` : "";
	const lines = [
		`${index}. ${row.fullName}${archived} — ★${stars}${language}`,
		`   updated: ${row.updatedAt ?? "unknown"}`,
	];
	const description = trim(row.description, FREE_TEXT_TRIM_CHARS);
	if (description) lines.push(`   ${description}`);
	lines.push(`   url: ${row.url}`);
	return lines;
}

function formatIssueOrPrRow(row: GhIssueRow, index: number): string[] {
	const draft = row.isDraft ? ", draft" : "";
	const labels = (row.labels ?? []).map((label) => label.name).join(", ") || "none";
	return [
		`${index}. #${row.number} ${row.title} [${row.state}${draft}]`,
		`   author: ${row.author?.login ?? "unknown"} · comments: ${row.commentsCount ?? 0} · labels: ${labels}`,
		`   updated: ${row.updatedAt ?? "unknown"}`,
		`   url: ${row.url}`,
	];
}

function formatCommitRow(row: GhCommitRow, index: number): string[] {
	const repoName = row.repository?.nameWithOwner ?? row.repository?.fullName ?? "unknown/unknown";
	const message = trim(row.commit?.message?.split(/\r?\n/)[0], FREE_TEXT_TRIM_CHARS);
	return [
		`${index}. ${row.sha} — ${repoName}`,
		`   ${message || "(no commit message)"}`,
		`   author: ${row.commit?.author?.name ?? "unknown"} · date: ${row.commit?.author?.date ?? "unknown"}`,
		`   url: ${row.url}`,
	];
}

function formatRow(type: GhSearchType, row: GhSearchRow, index: number): string[] {
	switch (type) {
		case "code":
			return formatCodeRow(row as GhCodeRow, index);
		case "repos":
			return formatRepoRow(row as GhRepoRow, index);
		case "issues":
		case "prs":
			return formatIssueOrPrRow(row as GhIssueRow, index);
		case "commits":
			return formatCommitRow(row as GhCommitRow, index);
	}
}

export interface FormattedSearchResult {
	text: string;
	shownCount: number;
	truncatedByBudget: boolean;
}

/**
 * Bounded formatted text summary (not a JSON dump). Global output cap of
 * ~6-8KB; if not every fetched row fits, an explicit truncation note is
 * appended rather than silently cutting the output short.
 */
export function formatSearchResults(type: GhSearchType, rows: GhSearchRow[], params: GhSearchParams): FormattedSearchResult {
	const queryNote = params.query?.trim() ? ` for query "${params.query.trim()}"` : "";
	if (rows.length === 0) {
		return { text: `gh_search type=${type}: no results${queryNote}.`, shownCount: 0, truncatedByBudget: false };
	}

	const header = `gh_search type=${type}: ${rows.length} result(s) fetched${queryNote}`;
	const lines: string[] = [header, ""];
	let currentLength = header.length + 1;
	let shown = 0;
	let truncatedByBudget = false;

	for (let index = 0; index < rows.length; index += 1) {
		const blockText = formatRow(type, rows[index] as GhSearchRow, index + 1).join("\n");
		if (shown > 0 && currentLength + blockText.length + 2 > MAX_OUTPUT_CHARS) {
			truncatedByBudget = true;
			break;
		}
		lines.push(blockText, "");
		currentLength += blockText.length + 2;
		shown += 1;
	}

	if (truncatedByBudget) {
		lines.push(
			`... output truncated: showing ${shown} of ${rows.length} fetched results (~${MAX_OUTPUT_CHARS}-char formatting budget). `
				+ "Narrow with owner/repo/language filters or a smaller limit for a more targeted, fully-shown result set.",
		);
	} else {
		const limitApplied = params.limit ?? DEFAULT_SEARCH_LIMIT;
		if (rows.length >= limitApplied) {
			lines.push(
				`Note: fetched the maximum requested (limit=${limitApplied}); more matches may exist on GitHub. `
					+ "Increase limit (up to 50) or narrow owner/repo/query to see more or different results.",
			);
		}
	}

	return { text: lines.join("\n").trimEnd(), shownCount: shown, truncatedByBudget };
}
