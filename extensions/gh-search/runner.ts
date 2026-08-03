// Thin wrapper around the real `gh` CLI: an injectable exec function (mirrors
// extensions/lazyworktree's LazyWorktreeRunner pattern) plus a per-session-cached
// `gh auth status` check. This extension never talks to the GitHub API directly;
// `gh` owns auth.

export interface GhExecResult {
	code: number;
	stdout: string;
	stderr: string;
}

export interface GhExecOptions {
	cwd?: string;
	timeout?: number;
	signal?: AbortSignal;
}

export interface GhExec {
	(command: string, args: string[], options?: GhExecOptions): Promise<GhExecResult>;
}

export interface GhAuthStatus {
	authenticated: boolean;
	detail: string;
}

const RATE_LIMIT_PATTERN = /rate limit/i;

/** Simple substring/regex match against gh's stderr text, not a structured API error check. */
export function isRateLimitError(stderr: string): boolean {
	return RATE_LIMIT_PATTERN.test(stderr);
}

// `gh auth status` reports one block per configured account, e.g.:
//
//   github.com
//     ✓ Logged in to github.com account jbpratt (...)
//     - Active account: true
//     ...
//     X Failed to log in to github.com account other-account (...)
//     - Active account: false
//     ...
//
// The process exit code is non-zero if *any* configured account failed to
// authenticate, even when the active account is fine. Exit code alone is
// therefore not a reliable signal; this parses per-account blocks and looks
// for an active account whose login line succeeded.
export function parseAuthStatus(output: string): GhAuthStatus {
	const lines = output.split(/\r?\n/);
	let blockOk = false;
	let authenticated = false;
	for (const line of lines) {
		const loginMatch = line.match(/(✓|X|✗)\s*(?:Logged in to|Failed to log in to)/);
		if (loginMatch) {
			blockOk = loginMatch[1] === "✓";
			continue;
		}
		if (blockOk && /Active account:\s*true/i.test(line)) authenticated = true;
	}
	return { authenticated, detail: output.trim() };
}

export const GH_UNAUTHENTICATED_NOTICE = "Note: gh has no active authenticated github.com account (or `gh auth status` could not be checked). "
	+ "gh_search results are limited to public repositories and GitHub's unauthenticated search rate limit. "
	+ "Run `gh auth login` for a higher rate limit and access to private/internal repositories.";

export class GhRunner {
	private readonly exec: GhExec;
	private authStatusPromise: Promise<GhAuthStatus> | undefined;
	private authNoticeShown = false;

	constructor(exec: GhExec) {
		this.exec = exec;
	}

	async run(args: string[], options: GhExecOptions = {}): Promise<GhExecResult> {
		try {
			return await this.exec("gh", args, options);
		} catch (error) {
			if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
				throw new Error("gh (GitHub CLI) is not installed or is not available on PATH");
			}
			throw error;
		}
	}

	private async loadAuthStatus(options: GhExecOptions): Promise<GhAuthStatus> {
		try {
			const result = await this.run(["auth", "status", "--hostname", "github.com"], {
				...options,
				timeout: options.timeout ?? 10_000,
			});
			return parseAuthStatus(`${result.stdout}\n${result.stderr}`);
		} catch (error) {
			return { authenticated: false, detail: error instanceof Error ? error.message : String(error) };
		}
	}

	/** Checked once per GhRunner instance (i.e. once per session), cached afterward. */
	checkAuthStatus(options: GhExecOptions = {}): Promise<GhAuthStatus> {
		this.authStatusPromise ??= this.loadAuthStatus(options);
		return this.authStatusPromise;
	}

	/** Returns the unauthenticated notice exactly once per session, or undefined once shown or once authenticated. */
	async unauthenticatedNoticeOnce(options: GhExecOptions = {}): Promise<string | undefined> {
		const status = await this.checkAuthStatus(options);
		if (status.authenticated || this.authNoticeShown) return undefined;
		this.authNoticeShown = true;
		return GH_UNAUTHENTICATED_NOTICE;
	}
}
