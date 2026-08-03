import assert from "node:assert/strict";
import test from "node:test";
import {
	buildReadFileRequest,
	checkContentGuard,
	checkExtensionGuard,
	encodePathSegments,
	formatDirectoryListing,
	formatReadFileText,
	getExtension,
	isDeniedBinaryExtension,
	looksBinaryContent,
	parseRepo,
	sliceLines,
	tryParseDirectoryListing,
	type GhReadFileParams,
} from "../read-file.ts";

test("parseRepo splits owner/repo and rejects other shapes", () => {
	assert.deepEqual(parseRepo("cli/cli"), { owner: "cli", name: "cli" });
	assert.throws(() => parseRepo("cli"), /must be "owner\/repo"/);
	assert.throws(() => parseRepo("a/b/c"), /must be "owner\/repo"/);
	assert.throws(() => parseRepo("/repo"), /must be "owner\/repo"/);
});

test("encodePathSegments percent-encodes each path segment independently", () => {
	assert.equal(encodePathSegments("dir/my file.go"), "dir/my%20file.go");
	assert.equal(encodePathSegments("a/b/c.ts"), "a/b/c.ts");
	assert.equal(encodePathSegments("weird#name/file.go"), "weird%23name/file.go");
});

test("getExtension is case-insensitive and ignores dotfiles/no-extension paths", () => {
	assert.equal(getExtension("main.GO"), "go");
	assert.equal(getExtension("README"), undefined);
	assert.equal(getExtension(".gitignore"), undefined);
	assert.equal(getExtension("a/b/archive.tar.gz"), "gz");
});

test("isDeniedBinaryExtension flags known binary types and allows source/text types", () => {
	assert.equal(isDeniedBinaryExtension("logo.png"), true);
	assert.equal(isDeniedBinaryExtension("app.exe"), true);
	assert.equal(isDeniedBinaryExtension("main.go"), false);
	assert.equal(isDeniedBinaryExtension("notes.md"), false);
	assert.equal(isDeniedBinaryExtension("data.svg"), false);
});

test("buildReadFileRequest always passes --method GET explicitly, never -f/-F", () => {
	const request = buildReadFileRequest({ repo: "cli/cli", path: "go.mod" });
	assert.deepEqual(request.argv.slice(0, 3), ["api", "--method", "GET"]);
	assert.equal(request.argv.some((arg) => arg === "-f" || arg === "-F"), false);
});

test("buildReadFileRequest prefers the blob-sha path when sha is given, ignoring ref", () => {
	const request = buildReadFileRequest({ repo: "cli/cli", path: "go.mod", ref: "trunk", sha: "abc123" });
	assert.equal(request.usedSha, true);
	assert.equal(request.url, "repos/cli/cli/git/blobs/abc123");
	assert.equal(request.argv.includes("trunk"), false);
});

test("buildReadFileRequest uses the contents endpoint with percent-encoded path and ref query when no sha", () => {
	const request = buildReadFileRequest({ repo: "cli/cli", path: "my file.go", ref: "trunk" });
	assert.equal(request.usedSha, false);
	assert.equal(request.url, "repos/cli/cli/contents/my%20file.go?ref=trunk");
});

test("buildReadFileRequest omits ?ref= entirely when ref is not given (server resolves default branch)", () => {
	const request = buildReadFileRequest({ repo: "cli/cli", path: "go.mod" });
	assert.equal(request.url, "repos/cli/cli/contents/go.mod");
});

test("buildReadFileRequest rejects an empty path", () => {
	assert.throws(() => buildReadFileRequest({ repo: "cli/cli", path: "  " }), /path must not be empty/);
});

test("checkExtensionGuard refuses known-binary extensions before any fetch", () => {
	const refusal = checkExtensionGuard("assets/logo.png");
	assert.ok(refusal);
	assert.equal(refusal!.reason, "binary-extension");
	assert.match(refusal!.message, /\.png/);
});

test("checkExtensionGuard allows text-like extensions", () => {
	assert.equal(checkExtensionGuard("main.go"), undefined);
});

test("looksBinaryContent detects NUL bytes and high replacement-character density, allows normal text", () => {
	assert.equal(looksBinaryContent("hello\u0000world"), true);
	assert.equal(looksBinaryContent("\uFFFD".repeat(50)), true);
	assert.equal(looksBinaryContent("normal go source code\nwith unicode: café"), false);
	assert.equal(looksBinaryContent(""), false);
});

test("checkContentGuard refuses oversized content and binary-looking content, allows normal text", () => {
	const oversized = "x".repeat(2 * 1024 * 1024);
	const oversizedRefusal = checkContentGuard("big.txt", oversized);
	assert.ok(oversizedRefusal);
	assert.equal(oversizedRefusal!.reason, "oversized");

	const binaryRefusal = checkContentGuard("weird.dat", "\u0000\u0000binary");
	assert.ok(binaryRefusal);
	assert.equal(binaryRefusal!.reason, "binary-content");

	assert.equal(checkContentGuard("main.go", "package main\n"), undefined);
});

test("tryParseDirectoryListing recognizes a real gh contents-endpoint directory array", () => {
	const stdout = JSON.stringify([
		{ name: "gen-docs", path: "cmd/gen-docs", sha: "abc", size: 0, type: "dir" },
		{ name: "gh", path: "cmd/gh", sha: "def", size: 0, type: "dir" },
	]);
	const listing = tryParseDirectoryListing(stdout);
	assert.ok(listing);
	assert.equal(listing!.length, 2);
	assert.equal(listing![0]!.name, "gen-docs");
});

test("tryParseDirectoryListing returns undefined for plain file content or non-matching JSON", () => {
	assert.equal(tryParseDirectoryListing("package main\n"), undefined);
	assert.equal(tryParseDirectoryListing("[1, 2, 3]"), undefined);
	assert.equal(tryParseDirectoryListing("{}"), undefined);
	assert.equal(tryParseDirectoryListing("[]"), undefined);
});

test("formatDirectoryListing renders entries with type and size", () => {
	const text = formatDirectoryListing({ repo: "cli/cli", path: "cmd" } as GhReadFileParams, [
		{ name: "gen-docs", path: "cmd/gen-docs", type: "dir" },
		{ name: "main.go", path: "cmd/gh/main.go", type: "file", size: 123 },
	]);
	assert.match(text, /is a directory \(2 entries\)/);
	assert.match(text, /\[dir \] gen-docs/);
	assert.match(text, /\[file\] main\.go \(123 bytes\)/);
});

test("sliceLines is 1-indexed and defaults to the start of the file", () => {
	const result = sliceLines("a\nb\nc\nd\ne");
	assert.equal(result.startLine, 1);
	assert.equal(result.endLine, 5);
	assert.equal(result.totalLines, 5);
	assert.deepEqual(result.lines, ["a", "b", "c", "d", "e"]);
	assert.equal(result.truncated, false);
});

test("sliceLines honors offset/limit and reports truncation with more lines remaining", () => {
	const content = Array.from({ length: 10 }, (_, index) => `line${index + 1}`).join("\n");
	const result = sliceLines(content, 3, 4);
	assert.equal(result.startLine, 3);
	assert.equal(result.endLine, 6);
	assert.deepEqual(result.lines, ["line3", "line4", "line5", "line6"]);
	assert.equal(result.totalLines, 10);
	assert.equal(result.truncated, true);
});

test("sliceLines does not report truncation when the window reaches the end of the file", () => {
	const content = "a\nb\nc";
	const result = sliceLines(content, 2, 10);
	assert.deepEqual(result.lines, ["b", "c"]);
	assert.equal(result.truncated, false);
});

test("sliceLines normalizes CRLF and lone-CR line endings", () => {
	const result = sliceLines("a\r\nb\rc\nd");
	assert.deepEqual(result.lines, ["a", "b", "c", "d"]);
});

test("sliceLines applies a byte-size cap within the requested line window", () => {
	const bigLine = "x".repeat(40_000);
	const content = [bigLine, bigLine, bigLine].join("\n"); // ~120KB across 3 lines, cap is 50KB
	const result = sliceLines(content, 1, 3);
	assert.ok(result.lines.length < 3, "expected the byte cap to cut off before all 3 requested lines");
	assert.equal(result.truncated, true);
});

test("sliceLines handles an empty file", () => {
	const result = sliceLines("");
	assert.equal(result.totalLines, 1); // "".split gives one empty line, matching a zero-byte-file edge case
	assert.deepEqual(result.lines, [""]);
});

test("formatReadFileText reports the blob-sha pin and notes when ref was ignored", () => {
	const params: GhReadFileParams = { repo: "cli/cli", path: "go.mod", ref: "trunk", sha: "abc123" };
	const request = buildReadFileRequest(params);
	const slice = sliceLines("module x\n");
	const text = formatReadFileText(params, request, slice);
	assert.match(text, /@ sha abc123 \(ref ignored: sha takes precedence\)/);
});

test("formatReadFileText reports the ref pin when no sha is given", () => {
	const params: GhReadFileParams = { repo: "cli/cli", path: "go.mod", ref: "trunk" };
	const request = buildReadFileRequest(params);
	const slice = sliceLines("module x\n");
	const text = formatReadFileText(params, request, slice);
	assert.match(text, /@ ref trunk/);
});

test("formatReadFileText reports the default-branch pin when neither ref nor sha is given", () => {
	const params: GhReadFileParams = { repo: "cli/cli", path: "go.mod" };
	const request = buildReadFileRequest(params);
	const slice = sliceLines("module x\n");
	const text = formatReadFileText(params, request, slice);
	assert.match(text, /@ default branch/);
});

test("formatReadFileText includes a continuation hint (offset for the next call) when truncated", () => {
	const params: GhReadFileParams = { repo: "cli/cli", path: "big.go" };
	const request = buildReadFileRequest(params);
	const content = Array.from({ length: 10 }, (_, index) => `line${index + 1}`).join("\n");
	const slice = sliceLines(content, 1, 4);
	const text = formatReadFileText(params, request, slice);
	assert.match(text, /Use offset=5 to continue reading/);
});
