import assert from "node:assert/strict";
import test from "node:test";
import {
	buildSearchArgv,
	formatSearchResults,
	parseSearchOutput,
	validateSearchParams,
	type GhSearchParams,
} from "../search.ts";

// Fixtures below are literal, trimmed `gh search <type> --json ...` output captured
// against the real `gh` CLI/API during design and implementation (cli/cli repo).
// No test in this file makes a network call or invokes the real `gh` binary.

const CODE_FIXTURE = JSON.stringify([
	{
		path: "cmd/gh/main.go",
		repository: { nameWithOwner: "cli/cli", url: "https://github.com/cli/cli" },
		sha: "e167bc6f4a51e642821bc627c6553773c61448fd",
		textMatches: [
			{
				fragment: "\t\"github.com/cli/cli/v2/internal/ghcmd\"\n)\n\nfunc main() {\n\tcode := ghcmd.Main()\n\tos.Exit(int(code))\n}",
			},
		],
		url: "https://github.com/cli/cli/blob/e83adbc0642994fae7c39a9a012eb34b8c81f4f1/cmd/gh/main.go",
	},
]);

const REPOS_FIXTURE = JSON.stringify([
	{
		description: "GitHub\u2019s official command line tool",
		fullName: "cli/cli",
		isArchived: false,
		language: "Go",
		stargazersCount: 45621,
		updatedAt: "2026-08-03T13:46:47Z",
		url: "https://github.com/cli/cli",
	},
]);

const ISSUES_FIXTURE = JSON.stringify([
	{
		author: { login: "Harsith2k5" },
		commentsCount: 2,
		labels: [{ name: "enhancement" }, { name: "gh-repo" }],
		number: 13608,
		state: "open",
		title: "UI: Enhance 'repo view' with clean visual hierarchy and padding",
		updatedAt: "2026-07-20T16:47:23Z",
		url: "https://github.com/cli/cli/issues/13608",
	},
]);

const PRS_FIXTURE = JSON.stringify([
	{
		author: { login: "maxbeizer" },
		commentsCount: 0,
		isDraft: true,
		labels: [{ name: "needs-triage" }],
		number: 14035,
		state: "open",
		title: "Fix project scope errors during issue creation",
		updatedAt: "2026-08-01T17:50:50Z",
		url: "https://github.com/cli/cli/pull/14035",
	},
]);

const COMMITS_FIXTURE = JSON.stringify([
	{
		commit: {
			author: { date: "2026-08-01T09:52:46+02:00", name: "William Martin" },
			message: "Merge pull request #13988 from cli/williammartin-fix-restwithnext-error-type\n\nFix RESTWithNext error type",
		},
		repository: { nameWithOwner: "cli/cli" },
		sha: "e83adbc0642994fae7c39a9a012eb34b8c81f4f1",
		url: "https://github.com/cli/cli/commit/e83adbc0642994fae7c39a9a012eb34b8c81f4f1",
	},
]);

test("validateSearchParams accepts a code-only field for type=code", () => {
	assert.doesNotThrow(() => validateSearchParams({ type: "code", language: "go" }));
});

test("validateSearchParams rejects a field that does not apply to the chosen type, naming field and valid fields", () => {
	assert.throws(
		() => validateSearchParams({ type: "code", draft: true } as unknown as GhSearchParams),
		/field "draft" is not valid for type "code".*Valid fields for type "code":.*language/s,
	);
});

test("validateSearchParams rejects prs-only draft/merged for issues", () => {
	assert.throws(() => validateSearchParams({ type: "issues", draft: true } as unknown as GhSearchParams), /"draft" is not valid for type "issues"/);
});

test("validateSearchParams rejects match for a non-code type (design deliberately excludes it there)", () => {
	assert.throws(() => validateSearchParams({ type: "issues", match: ["title"] } as unknown as GhSearchParams), /"match" is not valid for type "issues"/);
});

test("buildSearchArgv always includes --json with the curated field list per type", () => {
	assert.deepEqual(buildSearchArgv({ type: "code" }).slice(-2), ["--json", "path,repository,sha,textMatches,url"]);
	assert.deepEqual(buildSearchArgv({ type: "repos" }).slice(-2), ["--json", "fullName,description,stargazersCount,language,updatedAt,url,isArchived"]);
	assert.deepEqual(buildSearchArgv({ type: "issues" }).slice(-2), ["--json", "number,title,state,author,labels,commentsCount,updatedAt,url"]);
	assert.deepEqual(buildSearchArgv({ type: "prs" }).slice(-2), ["--json", "number,title,state,author,labels,commentsCount,updatedAt,url,isDraft"]);
	assert.deepEqual(buildSearchArgv({ type: "commits" }).slice(-2), ["--json", "sha,repository,commit,url"]);
});

test("buildSearchArgv builds repeatable flags one-per-value and never a shell string", () => {
	const argv = buildSearchArgv({ type: "code", owner: ["a", "b"], repo: ["a/x"], language: "go" });
	assert.deepEqual(argv.slice(0, 6), ["--owner", "a", "--owner", "b", "--repo", "a/x"]);
	assert.ok(argv.includes("--language"));
	assert.equal(argv.includes("go"), true);
});

test("buildSearchArgv inserts a literal -- before a leading-dash query token", () => {
	const argv = buildSearchArgv({ type: "issues", query: "-label:bug" });
	const dashDashIndex = argv.indexOf("--");
	assert.ok(dashDashIndex >= 0, "expected a literal -- before the query");
	assert.equal(argv[dashDashIndex + 1], "-label:bug");
	assert.equal(argv[argv.length - 1], "-label:bug");
});

test("buildSearchArgv does not insert -- for an ordinary query", () => {
	const argv = buildSearchArgv({ type: "issues", query: "readme typo" });
	assert.equal(argv.includes("--"), false);
	assert.equal(argv[argv.length - 1], "readme typo");
});

test("buildSearchArgv renders explicit boolean flags for draft/merged", () => {
	assert.ok(buildSearchArgv({ type: "prs", draft: true }).includes("--draft=true"));
	assert.ok(buildSearchArgv({ type: "prs", merged: false }).includes("--merged=false"));
});

test("buildSearchArgv omits the query entirely when unset", () => {
	const argv = buildSearchArgv({ type: "repos" });
	assert.equal(argv[argv.length - 1], "fullName,description,stargazersCount,language,updatedAt,url,isArchived");
});

test("parseSearchOutput parses real gh JSON fixtures and rejects malformed output", () => {
	assert.equal(parseSearchOutput("code", CODE_FIXTURE).length, 1);
	assert.equal(parseSearchOutput("repos", REPOS_FIXTURE).length, 1);
	assert.equal(parseSearchOutput("issues", ISSUES_FIXTURE).length, 1);
	assert.equal(parseSearchOutput("prs", PRS_FIXTURE).length, 1);
	assert.equal(parseSearchOutput("commits", COMMITS_FIXTURE).length, 1);
	assert.throws(() => parseSearchOutput("code", "not json"), /invalid JSON/);
	assert.throws(() => parseSearchOutput("code", "{}"), /non-array JSON/);
});

test("formatSearchResults reports no-results explicitly", () => {
	const formatted = formatSearchResults("code", [], { type: "code", query: "nonexistent-thing" });
	assert.match(formatted.text, /no results for query "nonexistent-thing"/);
	assert.equal(formatted.shownCount, 0);
});

test("formatSearchResults includes the full blob sha and url for code results (needed for gh_read_file follow-up)", () => {
	const rows = parseSearchOutput("code", CODE_FIXTURE);
	const formatted = formatSearchResults("code", rows, { type: "code" });
	assert.match(formatted.text, /sha: e167bc6f4a51e642821bc627c6553773c61448fd/);
	assert.match(formatted.text, /cmd\/gh\/main\.go/);
	assert.match(formatted.text, /func main/);
});

test("formatSearchResults trims a long code fragment to ~200 chars", () => {
	const rows = parseSearchOutput("code", JSON.stringify([
		{
			path: "big.go",
			repository: { nameWithOwner: "o/r", url: "https://github.com/o/r" },
			sha: "s".repeat(40),
			textMatches: [{ fragment: "x".repeat(500) }],
			url: "https://github.com/o/r/blob/main/big.go",
		},
	]));
	const formatted = formatSearchResults("code", rows, { type: "code" });
	const fragmentLine = formatted.text.split("\n").find((line) => line.trim().startsWith(">"));
	assert.ok(fragmentLine);
	assert.ok(fragmentLine!.length < 220);
});

test("formatSearchResults shows issue/pr fields including draft marker", () => {
	const rows = parseSearchOutput("prs", PRS_FIXTURE);
	const formatted = formatSearchResults("prs", rows, { type: "prs" });
	assert.match(formatted.text, /#14035 Fix project scope errors during issue creation \[open, draft\]/);
	assert.match(formatted.text, /author: maxbeizer/);
});

test("formatSearchResults shows repo star/language/archived summary", () => {
	const rows = parseSearchOutput("repos", REPOS_FIXTURE);
	const formatted = formatSearchResults("repos", rows, { type: "repos" });
	assert.match(formatted.text, /cli\/cli — ★45621 · Go/);
});

test("formatSearchResults shows commit sha, first message line, and author", () => {
	const rows = parseSearchOutput("commits", COMMITS_FIXTURE);
	const formatted = formatSearchResults("commits", rows, { type: "commits" });
	assert.match(formatted.text, /e83adbc0642994fae7c39a9a012eb34b8c81f4f1 — cli\/cli/);
	assert.match(formatted.text, /Merge pull request #13988 from cli\/williammartin-fix-restwithnext-error-type/);
	assert.match(formatted.text, /author: William Martin/);
});

test("formatSearchResults enforces a global output budget and reports explicit truncation, never cutting a result mid-block", () => {
	const rows = parseSearchOutput("repos", JSON.stringify(
		Array.from({ length: 60 }, (_, index) => ({
			fullName: `owner/repo-${index}`,
			description: "d".repeat(200),
			stargazersCount: index,
			language: "Go",
			updatedAt: "2026-01-01T00:00:00Z",
			url: `https://github.com/owner/repo-${index}`,
			isArchived: false,
		})),
	));
	const formatted = formatSearchResults("repos", rows, { type: "repos", limit: 50 });
	assert.ok(formatted.truncatedByBudget, "expected the 60-large-description-row fixture to exceed the output budget");
	assert.ok(formatted.shownCount > 0 && formatted.shownCount < rows.length);
	assert.match(formatted.text, /output truncated: showing \d+ of 60 fetched results/);
	// every shown row must be a complete block (url line present for each shown fullName)
	for (let index = 0; index < formatted.shownCount; index += 1) {
		assert.match(formatted.text, new RegExp(`owner/repo-${index}[\\s\\S]*?url: https://github\\.com/owner/repo-${index}`));
	}
});

test("formatSearchResults hints at a higher limit when the fetched row count equals the requested limit", () => {
	const rows = parseSearchOutput("repos", JSON.stringify([
		{ fullName: "a/b", url: "https://github.com/a/b" },
		{ fullName: "c/d", url: "https://github.com/c/d" },
	]));
	const formatted = formatSearchResults("repos", rows, { type: "repos", limit: 2 });
	assert.match(formatted.text, /fetched the maximum requested \(limit=2\)/);
});
