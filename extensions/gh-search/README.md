# pi-gh-search

A [pi](https://pi.dev) extension that gives the agent two typed, bounded tools for GitHub instead of `bash` + `gh search`/`curl`: `gh_search` (code, repos, issues, PRs, commits) and `gh_read_file` (a single file at a ref or exact blob sha). Both are thin wrappers around the real `gh` CLI (`gh search ...` / `gh api ...`) — this extension never talks to the GitHub API directly and never touches a token; `gh` owns auth.

This extension has no dependency on any other pi extension or package beyond pi itself. It shells out to `gh` only.

## Why not just `bash` + `curl`/`gh search`?

- `gh search` without `--json` prints a table meant for a human terminal, with no bound on how much lands in context. `gh_search` always requests a curated `--json` field set, parses it, and formats a bounded (~6-8KB) summary with explicit truncation notes instead.
- `curl <raw-url> | head` has no auth path for private/internal repos, no size or binary guard, and can silently show a different file version than what a search actually matched. `gh_read_file` uses `gh`'s existing auth, refuses binary/oversized files instead of dumping them into context, and can pin the exact blob sha from a `gh_search` (`type: "code"`) result — independent of later pushes to that branch.

## What it does

**`gh_search`** — one tool, a `type` enum (`code | repos | issues | prs | commits`), not five separate tools. `type: "code"` gets full flag coverage (`language`, `filename`, `extension`, `match`, plus the shared `owner`/`repo`/`limit`/`sort`/`order`) since that's the primary use case this extension is built for. The other four types keep only their most commonly used filters as structured fields; anything else (dates, reactions, milestones, review status, etc.) goes through the free-text `query` field using GitHub's native search qualifier syntax. Setting a field that doesn't apply to the chosen `type` (e.g. `draft` with `type: "code"`) is a loud, immediate error naming the field and the valid fields for that type — never a silently ignored filter.

Every call passes `--json` with a curated field list (never bare/table output), and builds `argv` directly (never a shell string), inserting a literal `--` before the query when it starts with a `-` (a documented GitHub exclusion-qualifier escape, e.g. `-label:bug`). `gh auth status` is checked once per session; an unauthenticated session gets a one-time non-blocking note on its first `gh_search` call. A rate-limited `gh` call is detected and surfaced as a distinct, actionable error.

**`gh_read_file`** — reads a bounded, 1-indexed line window (same `offset`/`limit` contract as the built-in `read` tool) of one file from `repo` (`owner/repo`) at `ref` (default branch if omitted) or an exact `sha` (git blob sha, e.g. from a `gh_search` `type: "code"` result — takes precedence over `ref`). `--method GET` is always explicit and any query parameter is embedded directly in the URL string, never passed via `gh api`'s `-f`/`-F` — those would let `gh api` infer a `POST`, and `POST` against the contents endpoint is GitHub's create-or-update-file operation. No code path in this tool can reach a write endpoint.

Binary and oversized files are refused with a clear message rather than dumped into context: a file-extension deny list is checked before any fetch, backstopped by a post-fetch check for NUL bytes / high replacement-character density, since `Content-Type` reports `application/vnd.github.raw` identically for text and binary files on both fetch paths (verified). A whole-file size cap (~1.5MB) applies before formatting. A directory path returns a listing instead of a parse error. **Text files only in this build** — no image/binary content-block support (see Scope below).

GitHub's raw content endpoints do not support `Range` requests (verified: always a full `200 OK`, never `206`), so `gh_read_file` fetches the whole file over the wire and slices lines locally, the same as `curl | head` — this tool is not a bandwidth win, only a correctness/safety one (auth, exact version pinning, bounded output, binary safety).

**Bash-curl nudge.** A non-blocking `tool_call` interceptor watches for `bash` commands targeting `raw.githubusercontent.com` or `api.github.com` and suggests `gh_search`/`gh_read_file` via `ctx.ui.notify(...)`. It never blocks — there are legitimate reasons to hit those hosts directly (release assets, an API shape this extension doesn't model).

## Untrusted content and model egress

Search results and file content are external, potentially adversarial data — a malicious repository could embed prompt-injection text in source comments, a README, or a commit message. Treat `gh_search`/`gh_read_file` output as data, not instructions, the same way this project's own operating guidance treats Kubernetes cluster logs/events.

Search hits and file content — including from private/internal repos the user's own `gh` token can see — become ordinary tool-call context sent to whichever model provider is currently selected, the same as `bash`/`read` output. This extension does not gate or filter on license; code snippets from public repos remain under their own licenses.

## Install

```bash
pi install npm:pi-gh-search
```

or from a local checkout:

```bash
pi install ./extensions/gh-search
```

Requires the [`gh`](https://cli.github.com/) CLI on `PATH`, authenticated via `gh auth login` for private/internal repo access and a higher search rate limit (unauthenticated use works too, public-repo-only, subject to GitHub's unauthenticated search rate limit).

## Notes on scope

This is a deliberately narrow first build:

- No `gh_search_code`/`gh_search_issues`/... split — one `gh_search` tool with a `type` enum.
- The long tail of `gh search` flags for `repos`/`issues`/`prs`/`commits` (dates, reactions, milestones, review status/requested-reviewer, checks, good-first-issue counts, etc.) is not modeled as dedicated parameters — use `query`'s native GitHub qualifier syntax. `type: "code"` is the one type with zero cuts.
- No Range-based partial remote fetch — GitHub's API does not support it on the endpoints this tool uses.
- No image/binary content support in `gh_read_file` — binaries are refused with a clear message.
- No dedicated "view issue/PR" tool — `gh_search` results carry `number`/`url`/`repository`, enough for `bash` + `gh issue view`/`gh pr view`.
- No write/mutation GitHub operation anywhere in this extension.

See [`../../docs/gh-search-design.md`](../../docs/gh-search-design.md) in this repository for the full design rationale and the exact `--json` field tables.
