import assert from "node:assert/strict";
import test from "node:test";
import { GH_UNAUTHENTICATED_NOTICE, GhRunner, isRateLimitError, parseAuthStatus, type GhExecResult } from "../runner.ts";

const MULTI_ACCOUNT_ONE_BROKEN = `github.com
  ✓ Logged in to github.com account jbpratt (/home/user/.config/gh/hosts.yml)
  - Active account: true
  - Git operations protocol: ssh
  - Token: gho_************************************
  - Token scopes: 'repo', 'workflow'

  X Failed to log in to github.com account quay-devel (/home/user/.config/gh/hosts.yml)
  - Active account: false
  - The token in /home/user/.config/gh/hosts.yml is invalid.
  - To re-authenticate, run: gh auth login -h github.com
  - To forget about this account, run: gh auth logout -h github.com -u quay-devel
`;

const NOT_LOGGED_IN = "You are not logged in to any GitHub hosts. To log in, run: gh auth login\n";

const ALL_ACCOUNTS_BROKEN = `github.com
  X Failed to log in to github.com account jbpratt (/home/user/.config/gh/hosts.yml)
  - Active account: true
  - The token in /home/user/.config/gh/hosts.yml is invalid.
`;

test("parseAuthStatus treats an active successfully-logged-in account as authenticated even when another account exit-code-fails", () => {
	// This exact multi-account shape (exit code 1 despite the active account being fine) was
	// observed against the real `gh` CLI during design/implementation; exit code alone is not
	// a reliable authenticated/unauthenticated signal.
	const status = parseAuthStatus(MULTI_ACCOUNT_ONE_BROKEN);
	assert.equal(status.authenticated, true);
});

test("parseAuthStatus reports unauthenticated when no account is logged in", () => {
	assert.equal(parseAuthStatus(NOT_LOGGED_IN).authenticated, false);
});

test("parseAuthStatus reports unauthenticated when the active account's login itself failed", () => {
	assert.equal(parseAuthStatus(ALL_ACCOUNTS_BROKEN).authenticated, false);
});

test("isRateLimitError matches known GitHub rate-limit phrasing, case-insensitively", () => {
	assert.equal(isRateLimitError("API rate limit exceeded for user ID 123."), true);
	assert.equal(isRateLimitError("You have exceeded a secondary RATE LIMIT. Please wait."), true);
	assert.equal(isRateLimitError("gh: Not Found (HTTP 404)"), false);
});

function fakeExec(result: Partial<GhExecResult> & { code: number }): (command: string, args: string[]) => Promise<GhExecResult> {
	return async () => ({ stdout: "", stderr: "", ...result });
}

test("GhRunner.run prefixes a clear error when gh is not on PATH", async () => {
	const enoent = Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" });
	const runner = new GhRunner(async () => {
		throw enoent;
	});
	await assert.rejects(runner.run(["auth", "status"]), /gh \(GitHub CLI\) is not installed or is not available on PATH/);
});

test("GhRunner.run rethrows non-ENOENT errors unchanged", async () => {
	const boom = new Error("boom");
	const runner = new GhRunner(async () => {
		throw boom;
	});
	await assert.rejects(runner.run(["auth", "status"]), boom);
});

test("GhRunner caches gh auth status across calls (execs only once)", async () => {
	let calls = 0;
	const runner = new GhRunner(async () => {
		calls += 1;
		return { code: 0, stdout: "", stderr: MULTI_ACCOUNT_ONE_BROKEN };
	});
	const first = await runner.checkAuthStatus();
	const second = await runner.checkAuthStatus();
	assert.equal(calls, 1);
	assert.equal(first.authenticated, true);
	assert.deepEqual(first, second);
});

test("GhRunner.unauthenticatedNoticeOnce returns the notice exactly once when unauthenticated", async () => {
	const runner = new GhRunner(fakeExec({ code: 1, stderr: NOT_LOGGED_IN }));
	const first = await runner.unauthenticatedNoticeOnce();
	const second = await runner.unauthenticatedNoticeOnce();
	assert.equal(first, GH_UNAUTHENTICATED_NOTICE);
	assert.equal(second, undefined);
});

test("GhRunner.unauthenticatedNoticeOnce returns undefined when authenticated", async () => {
	const runner = new GhRunner(fakeExec({ code: 0, stderr: MULTI_ACCOUNT_ONE_BROKEN }));
	assert.equal(await runner.unauthenticatedNoticeOnce(), undefined);
});

test("GhRunner.unauthenticatedNoticeOnce treats a failed auth-status exec as unauthenticated", async () => {
	const runner = new GhRunner(async () => {
		throw new Error("network unreachable");
	});
	assert.equal(await runner.unauthenticatedNoticeOnce(), GH_UNAUTHENTICATED_NOTICE);
});
