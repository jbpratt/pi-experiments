import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { NotAGitRepositoryError, resolveRepositoryIdentity } from "../scope.ts";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
	const { stdout } = await execFileAsync("git", args, { cwd });
	return stdout.trim();
}

async function initRepoWithCommit(root: string): Promise<void> {
	await git(root, ["init", "--initial-branch=main"]);
	await git(root, ["config", "user.email", "test@example.com"]);
	await git(root, ["config", "user.name", "Test"]);
	await git(root, ["config", "commit.gpgsign", "false"]);
	await git(root, ["config", "tag.gpgsign", "false"]);
	writeFileSync(join(root, "file.txt"), "hello\n");
	await git(root, ["add", "file.txt"]);
	await git(root, ["commit", "-m", "initial commit"]);
}

function tmpRoot(prefix: string): string {
	return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

test("resolves identity for a normal repo with a commit", async (t) => {
	const root = tmpRoot("pi-codegraph-scope-");
	t.after(() => rmSync(root, { recursive: true, force: true }));
	await initRepoWithCommit(root);

	const identity = await resolveRepositoryIdentity(root);

	assert.equal(identity.worktreeRoot, root);
	assert.equal(identity.source, "local");
	assert.equal(identity.indexDirName, ".codegraph");
	assert.equal(identity.branch, "main");
	assert.match(identity.head ?? "", /^[0-9a-f]{40}$/);
	assert.ok(identity.gitCommonDir.length > 0);
	assert.ok(identity.gitCommonDir.startsWith("/"));
	assert.match(identity.id, /^[0-9a-f]+$/);
});

test("two worktrees of the same repo get different ids; same root is stable across calls", async (t) => {
	const root = tmpRoot("pi-codegraph-scope-");
	t.after(() => rmSync(root, { recursive: true, force: true }));
	await initRepoWithCommit(root);

	const worktreeParent = tmpRoot("pi-codegraph-scope-wt-");
	t.after(() => rmSync(worktreeParent, { recursive: true, force: true }));
	const secondWorktreePath = join(worktreeParent, "second");
	await git(root, ["worktree", "add", "-b", "second-branch", secondWorktreePath]);

	const first = await resolveRepositoryIdentity(root);
	const second = await resolveRepositoryIdentity(secondWorktreePath);
	const firstAgain = await resolveRepositoryIdentity(root);

	assert.notEqual(first.worktreeRoot, second.worktreeRoot);
	assert.notEqual(first.id, second.id);
	assert.equal(first.id, firstAgain.id);
});

test("unborn HEAD resolves head and branch to null instead of throwing", async (t) => {
	const root = tmpRoot("pi-codegraph-scope-unborn-");
	t.after(() => rmSync(root, { recursive: true, force: true }));
	await git(root, ["init", "--initial-branch=main"]);

	const identity = await resolveRepositoryIdentity(root);

	assert.equal(identity.head, null);
	assert.equal(identity.branch, null);
});

test("detached HEAD resolves branch to null but head to a real commit", async (t) => {
	const root = tmpRoot("pi-codegraph-scope-detached-");
	t.after(() => rmSync(root, { recursive: true, force: true }));
	await initRepoWithCommit(root);
	const head = await git(root, ["rev-parse", "HEAD"]);
	await git(root, ["checkout", "--detach", head]);

	const identity = await resolveRepositoryIdentity(root);

	assert.equal(identity.branch, null);
	assert.equal(identity.head, head);
});

test("a non-git directory throws NotAGitRepositoryError", async (t) => {
	const root = tmpRoot("pi-codegraph-scope-nongit-");
	t.after(() => rmSync(root, { recursive: true, force: true }));

	await assert.rejects(() => resolveRepositoryIdentity(root), NotAGitRepositoryError);
});

test("resolving from a nested subdirectory returns the same worktree root", async (t) => {
	const root = tmpRoot("pi-codegraph-scope-nested-");
	t.after(() => rmSync(root, { recursive: true, force: true }));
	await initRepoWithCommit(root);
	const nested = join(root, "src", "feature");
	mkdirSync(nested, { recursive: true });

	const fromRoot = await resolveRepositoryIdentity(root);
	const fromNested = await resolveRepositoryIdentity(nested);

	assert.equal(fromNested.worktreeRoot, fromRoot.worktreeRoot);
	assert.equal(fromNested.id, fromRoot.id);
});
