// Exact repository identity resolution for the codegraph extension. This
// module has no dependency on any Pi extension API: it only knows how to
// shell out to a handful of read-only `git` plumbing commands and derive a
// stable, opaque identifier from the canonical worktree root. See
// worker.ts/worker-client.ts for the sibling modules this mirrors in style.
//
// Never falls back to nearest-".codegraph" discovery or any other implicit
// scoping: the caller always gets back the exact canonical worktree root for
// the given `cwd`, or a typed error.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import type { CodeGraphRepositoryIdentity } from "./types.ts";

const GIT_TIMEOUT_MS = 5_000;
const ID_HASH_LENGTH = 24;

/**
 * Thrown when `cwd` is not inside a Git working tree, or when `git` itself
 * cannot be run (missing binary, timeout). Callers must fail closed rather
 * than treat this as "no repository" and continue.
 */
export class NotAGitRepositoryError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "NotAGitRepositoryError";
	}
}

interface GitRunResult {
	stdout: string;
	code: number;
}

function runGit(args: string[], cwd: string): Promise<GitRunResult> {
	return new Promise((resolvePromise, reject) => {
		execFile("git", args, { cwd, timeout: GIT_TIMEOUT_MS, encoding: "utf8" }, (error, stdout) => {
			if (error) {
				const code = typeof (error as NodeJS.ErrnoException & { code?: number | string }).code === "number" ? (error as unknown as { code: number }).code : 1;
				if ((error as NodeJS.ErrnoException).code === "ENOENT") {
					reject(new NotAGitRepositoryError(`git executable not found while resolving repository identity for ${cwd}.`));
					return;
				}
				if ((error as { killed?: boolean; signal?: string }).killed) {
					reject(new NotAGitRepositoryError(`git ${args.join(" ")} timed out after ${GIT_TIMEOUT_MS}ms in ${cwd}.`));
					return;
				}
				resolvePromise({ stdout: stdout ?? "", code });
				return;
			}
			resolvePromise({ stdout: stdout ?? "", code: 0 });
		});
	});
}

async function runGitOrThrow(args: string[], cwd: string, notARepoMessage: string): Promise<string> {
	const result = await runGit(args, cwd);
	if (result.code !== 0) {
		throw new NotAGitRepositoryError(notARepoMessage);
	}
	return result.stdout.trim();
}

function computeRepositoryId(canonicalWorktreeRoot: string): string {
	return createHash("sha256").update(canonicalWorktreeRoot).digest("hex").slice(0, ID_HASH_LENGTH);
}

/**
 * Resolves the exact canonical Git worktree root containing `cwd`, together
 * with its common dir, HEAD commit, and current branch. Fails closed with
 * `NotAGitRepositoryError` when `cwd` is not inside a Git working tree.
 */
export async function resolveRepositoryIdentity(cwd: string): Promise<CodeGraphRepositoryIdentity> {
	const rawWorktreeRoot = await runGitOrThrow(["rev-parse", "--show-toplevel"], cwd, `${cwd} is not inside a Git working tree.`);
	const canonicalWorktreeRoot = await realpath(rawWorktreeRoot);

	const rawCommonDir = await runGitOrThrow(["rev-parse", "--git-common-dir"], cwd, `${cwd} is not inside a Git working tree.`);
	const gitCommonDir = isAbsolute(rawCommonDir) ? rawCommonDir : resolve(canonicalWorktreeRoot, rawCommonDir);

	const headResult = await runGit(["rev-parse", "HEAD"], cwd);
	const head = headResult.code === 0 ? headResult.stdout.trim() : null;

	let branch: string | null = null;
	if (head !== null) {
		const branchResult = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
		if (branchResult.code === 0) {
			const branchName = branchResult.stdout.trim();
			branch = branchName === "HEAD" ? null : branchName;
		}
	}

	return {
		id: computeRepositoryId(canonicalWorktreeRoot),
		source: "local",
		worktreeRoot: canonicalWorktreeRoot,
		gitCommonDir,
		head,
		branch,
		indexDirName: ".codegraph",
	};
}
