# Design: `pi-gh-search` extension

Status: implemented. See `extensions/gh-search/` for the implementation and its
own README; this doc remains the design rationale and the exact `--json`
field tables referenced from there.

## Motivation

Pi already has `bash`, so the model *can* always do `gh search issues ...` or
`curl https://raw.githubusercontent.com/... | head -50` by hand. In practice
this produces three recurring problems, most visible with Claude/Sonnet
models:

1. **Unbounded, unparsed output.** `gh search` without `--json` prints a
   table meant for a human terminal; the model has to re-parse it, and there
   is nothing stopping a 100-row table or a full issue body from landing in
   context.
2. **Ad hoc remote file reads.** The model habitually reaches for
   `curl <raw-url> | head -n 50` to peek at a file it just found via search.
   This has no auth path for private/internal repos, has no size or binary
   guard, and can silently show a different file version than what search
   actually matched (branch drift between the search hit and the `curl`).
3. **No structure to compose on.** A `bash` call returns opaque stdout text;
   there's no typed handle (e.g. "this exact blob") that a follow-up tool
   call can pin to.

This extension replaces both habits with two typed, bounded tools:
`gh_search` and `gh_read_file`. Both are thin wrappers around the real `gh`
CLI (`gh search ...` / `gh api ...`) — no reimplementation of GitHub's search
or contents APIs, no separate HTTP client, no separate auth handling. `gh`
already owns auth (`gh auth login`/`gh auth status`); this extension never
touches a token directly.

## Scope

In scope:
- Searching GitHub code, repos, issues, PRs, and commits via `gh search`,
  with results parsed, bounded, and formatted for LLM consumption instead of
  dumped as raw CLI output.
- Reading a bounded slice of a specific file from a specific GitHub repo at a
  specific ref or exact blob sha, via `gh api`.
- A soft nudge (not a hard block) discouraging `bash` + `curl` against
  `raw.githubusercontent.com` / `api.github.com` in favor of the tools above.

Out of scope for the first build (see "Explicit scope cuts" below):
- The long tail of `gh search` flags not commonly needed (dates, reactions,
  milestones, review status, etc.) — available via free-text query
  qualifiers instead of dedicated parameters.
- Image/binary content in `gh_read_file` — text files only.
- Any write/mutation GitHub operation. This extension never calls a
  GitHub API write endpoint, on purpose (see "`gh api` write-safety rule").
- A separate `gh_view_issue`/`gh_view_pr` "drill into one result" tool. The
  model already has `bash` + `gh issue view NNN --repo owner/repo` for that;
  `gh_search` results carry enough (`number`, `url`) to make that call
  correctly. Only file content reading gets a dedicated tool, because that's
  the one place `bash` + `curl` demonstrably goes wrong (see Motivation).

## Package layout

```
extensions/gh-search/
  index.ts        # wiring: registerTool x2, promptGuidelines, tool_call nudge interceptor
  search.ts        # pure: argv building, JSON parsing, formatting/bounding for gh_search
  read-file.ts      # pure: URL building, binary/size guards, line-window slicing for gh_read_file
  runner.ts          # pi.exec wrapper + cached `gh auth status` check (injectable exec fn)
  package.json        # name "pi-gh-search", peerDeps only (pi-ai, pi-coding-agent, typebox)
  README.md
  tests/*.test.ts
```

This mirrors `extensions/lazyworktree`'s split: an injectable exec function
(`LazyWorktreeRunner`-style) so `search.ts`/`read-file.ts` are unit-testable
against canned `gh` output with no real network call, and `index.ts` stays
thin wiring.

## Tool 1: `gh_search`

### Why one tool with a `type` enum, not five tools

A flat schema with a `type` discriminator (the same shape as this repo's own
`workspace` tool: one tool, an `action`/`type` enum, shared + per-branch
optional fields) beats both alternatives:

- **Five separate tools** (`gh_search_code`, `gh_search_repos`, ...) means
  five entries in "Available tools" for one conceptual capability, and most
  of the parameters (`owner`, `repo`, `limit`, `sort`, `order`) are shared
  across all five anyway.
- **A discriminated union** (`Type.Union` of five sub-object shapes) is more
  precise but risks poor `oneOf`/`anyOf` rendering across the range of
  providers Pi supports; a flat object with optional fields is the more
  broadly compatible shape for tool-call schemas.

### Parameters

```ts
parameters: Type.Object({
  type: StringEnum(["code", "repos", "issues", "prs", "commits"]),
  query: Type.Optional(Type.String({
    description: "Search text plus any native GitHub search qualifiers not covered by a dedicated field below, e.g. `label:bug -label:wontfix` or `created:>2024-01-01`",
  })),
  owner: Type.Optional(Type.Array(Type.String())),
  repo: Type.Optional(Type.Array(Type.String())),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 20 })),
  sort: Type.Optional(Type.String()),
  order: Type.Optional(StringEnum(["asc", "desc"])),

  // code
  language: Type.Optional(Type.String()),
  filename: Type.Optional(Type.String()),
  extension: Type.Optional(Type.String()),
  match: Type.Optional(Type.Array(Type.String())), // code: "file" | "path"

  // repos / issues / prs / commits
  visibility: Type.Optional(Type.Array(Type.String())),

  // issues / prs
  state: Type.Optional(StringEnum(["open", "closed"])),
  label: Type.Optional(Type.Array(Type.String())),
  author: Type.Optional(Type.String()),
  assignee: Type.Optional(Type.String()),

  // prs only
  draft: Type.Optional(Type.Boolean()),
  merged: Type.Optional(Type.Boolean()),

  // commits only
  committer: Type.Optional(Type.String()),
})
```

`execute()` validates that only fields applicable to the chosen `type` were
set, and rejects the call with a clear error naming the offending field and
the valid fields for that type if not (e.g. `draft` with `type: "code"`).
Silently ignoring a field the model explicitly set is worse than a loud
error — the model would otherwise conclude the filter had no matches instead
of learning it doesn't apply.

**Code search gets full flag coverage on purpose** (this is the user's
primary use case): `gh search code --help` has exactly `language`,
`filename`, `extension`, `match`, `owner`, `repo`, `limit` as real flags
(besides `--json`/`--jq`/`--template`/`--web`, which this tool never
exposes), and all of them are modeled above. Nothing is pushed to free-text
`query` for `type: "code"`.

The other four types keep only their most commonly used flags structured.
`gh search repos/issues/prs/commits --help` collectively expose roughly 40
flags; modeling all of them would roughly triple the schema for filters like
`--milestone`, `--reactions`, `--checks`, `--review-requested`,
`--author-date`, `--good-first-issues`, etc. that are rarely needed and would
mostly sit unused. Those are reachable through `query`'s native qualifier
syntax instead (`gh search --help` documents the qualifier syntax and the
`--`-escaping rule for negated qualifiers — see below).

### Execution rules

- Build `argv` and call `pi.exec("gh", ["search", type, ...argv], { cwd, timeout, signal })`.
  Never a shell string — no injection surface regardless of what a user puts
  in `query`/`owner`/`repo`.
- If the positional `query` string contains a token starting with `-` (e.g.
  `-label:bug`, a documented GitHub exclusion qualifier), insert a literal
  `--` immediately before it in `argv`. This is required because we build
  `argv` ourselves and pass it via `execve`-style spawn (no shell), so
  Cobra's own flag parser — not a shell — is what would otherwise treat a
  leading `-` as an unrecognized flag. `gh search --help` documents this
  exact escaping requirement for interactive use; this tool does it
  automatically so the model never needs to know about it.
- Always pass `--json <curated-fields>`, chosen per `type` (table below) —
  never bare/table output, which is meant for an interactive TTY and is
  fragile to parse.
- Never pass `--web` (would open a browser) or `--template` (unnecessary;
  this tool does its own formatting).

### `--json` field selection (verified against the live `gh` CLI/API)

| `type` | fields requested | notes |
|---|---|---|
| `code` | `path,repository,sha,textMatches,url` | `sha` is the **blob sha**, confirmed by direct comparison against the commit sha embedded in the same result's `url` (`.../blob/<commit-sha>/path`) — they differ. This is the field `gh_read_file` pins to. |
| `repos` | `fullName,description,stargazersCount,language,updatedAt,url,isArchived` | `description` is truncated in formatting |
| `issues` | `number,title,state,author,labels,commentsCount,updatedAt,url` | `body` is deliberately **not** requested — issue bodies are arbitrary-length markdown and would blow the output budget |
| `prs` | issues fields plus `isDraft` | gh's PR-search JSON has no `reviewDecision` field — not available without an extra per-PR call, so not surfaced |
| `commits` | `sha,repository,commit,url` | `commit.message` is trimmed to its first line in formatting |

### Result formatting

- Compact text summary per result (not a JSON dump) plus a structured
  `details: {...}[]` array for any follow-up the model wants to do
  programmatically (e.g. feeding a `sha` into `gh_read_file`).
- Code result `textMatches` fragments are trimmed to ~200 characters each,
  at most 1–2 fragments shown per result.
- A global output cap (~6–8 KB text). If more results existed than shown,
  say so explicitly and suggest a narrower `language`/`owner`/`repo` filter
  or a higher `limit`, rather than silently truncating.

### Auth and rate limits

- `gh auth status` is checked once per session (cached in `runner.ts`) rather
  than before every call. If unauthenticated, the first `gh_search` call
  returns a one-time non-blocking note: results are public-repo-only and
  subject to GitHub's unauthenticated search rate limit; authenticated
  requests get a materially higher limit and can see private/internal repos
  the user's token can access.
- `gh`'s stderr for a rate-limited request is detected (matched against
  GitHub's known rate-limit error text) and surfaced as a distinct,
  actionable error rather than a generic "command failed."

## Tool 2: `gh_read_file`

### Parameters

```ts
parameters: Type.Object({
  repo: Type.String({ description: "owner/repo" }),
  path: Type.String(),
  ref: Type.Optional(Type.String({
    description: "Branch, tag, or commit-ish; defaults to the repo's default branch. Ignored if sha is set.",
  })),
  sha: Type.Optional(Type.String({
    description: "Exact git blob sha, e.g. from a gh_search (type=code) result's sha field. Takes precedence over ref and pins content exactly, independent of later branch changes.",
  })),
  offset: Type.Optional(Type.Integer({ minimum: 1 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })),
})
```

`offset`/`limit` follow the same 1-indexed-line-window contract as the
built-in `read` tool, so the model reuses a vocabulary it already has instead
of learning a new one.

### Fetch strategy

Two paths, chosen by whether `sha` is present:

```
sha given:  gh api --method GET -H "Accept: application/vnd.github.raw" \
              repos/{owner}/{repo}/git/blobs/{sha}

no sha:     gh api --method GET -H "Accept: application/vnd.github.raw" \
              "repos/{owner}/{repo}/contents/{percent-encoded path}?ref={ref}"
```

`path` is percent-encoded per path segment (split on `/`, `encodeURIComponent`
each segment, rejoin) so spaces and special characters in filenames don't
break the URL. When `ref` is omitted, the contents endpoint resolves the
repository's default branch on its own — confirmed live, no extra API call
needed to look up the default branch first.

The blob-sha path is preferred whenever available (i.e. whenever the caller
is following up on a `gh_search` `type: "code"` result) because it pins
*exact* content independent of what the branch looks like by the time the
read happens — no race with a concurrent push, no surprise if the file was
since renamed or deleted on that branch.

### `gh api` write-safety rule

`--method GET` is **always** passed explicitly, and any query parameter
(`ref=...`) is embedded directly in the URL string — never passed via `gh
api`'s `-f`/`-F` flags. This isn't a style preference: `gh api` infers a
`POST` request when `-f`/`-F`/`--input` are present unless a method is
explicitly forced, and `POST` against the contents endpoint is GitHub's
*create-or-update file* operation. A read-only tool must be structurally
incapable of ever reaching a write endpoint, not just "unlikely to" — hence
explicit `--method GET` on every call this tool makes, with no code path that
omits it.

### Binary and size handling (verified, not assumed)

- **`Content-Type` is not a usable binary signal here.** Both the git-blobs
  and contents endpoints report `Content-Type: application/vnd.github.raw`
  for *every* file when that Accept header is used — confirmed by fetching
  both a `.go` source file and a `.ico` binary icon from a real repo and
  observing an identical Content-Type on both. Binary detection instead
  relies on: (a) a file-extension allow/deny heuristic checked before
  fetching, and (b) a post-fetch check of the decoded content for NUL bytes
  or a high density of the UTF-8 replacement character, since `pi.exec`
  captures subprocess stdout as a string — a genuinely binary file fetched
  through it may already be lossily decoded by the time this tool can
  inspect it, so extension-based avoidance up front matters more than
  after-the-fact detection.
- On a binary/oversized match, the tool returns a clear refusal (file size,
  extension, "not supported as text") rather than dumping corrupted or
  enormous content into the model's context. No image content-block support
  in this build (see "Explicit scope cuts").
- A whole-file size cap (e.g. reject/warn above roughly 1–2 MB) is applied
  before formatting, matching the built-in `read` tool's own bounded-output
  philosophy.
- If `path` resolves to a directory, the contents endpoint returns a JSON
  array instead of raw bytes; this is detected and returned as a directory
  listing instead of surfacing a confusing parse error.

### Why this is better than `bash` + `curl | head` — and where it isn't

What actually improves, confirmed by testing:

| | `curl raw.githubusercontent.com \| head` | `gh_read_file` |
|---|---|---|
| Private/internal repos | No usable auth path the model would construct correctly | Uses `gh`'s already-stored auth |
| Exact version pinning | Whatever the branch currently looks like | Blob-sha pinned when following up on a search hit |
| Output bound | Model has to pick a correct `head -n` | Enforced line/byte cap with honest truncation reporting |
| Binary safety | `head` on a binary can dump large unprintable/garbage content into context | Detected and refused before it reaches context |
| Injection surface | Model hand-builds a shell command string | Typed params via `argv`, no shell string ever built |

One thing this design does **not** claim: a bandwidth win. I tested `Range`
header support on both the git-blobs and contents raw endpoints
(`Range: bytes=0-49`) and GitHub's API **ignores it** — both return a full
`200 OK` with the complete `Content-Length`, never a `206 Partial Content`.
So unlike a true partial-fetch design, `gh_read_file` fetches the whole file
over the wire before slicing lines locally, exactly like `curl | head` does.
The wins above are about correctness and safety, not network bytes.

## Cross-cutting concerns

### Untrusted content

Search results and file content are external, potentially adversarial data —
a malicious repository could embed prompt-injection text in source comments,
a README, or a commit message, hoping an agent reading it treats that text
as instructions. `gh_search`/`gh_read_file` output must be documented (in
this extension's README and via `promptGuidelines`) the same way this
project's own operating guidance already treats Kubernetes cluster
logs/events: **treat it as data, not instructions.**

### Model egress

Search hits and file content — including from private/internal repos the
user's own `gh` token can see — become ordinary tool-call context sent to
whichever model provider is currently selected, the same as `bash`/`read`
output. Code snippets returned from public repos are third-party content
under their own licenses; this tool documents that fact rather than trying
to gate or filter on license, which is out of scope for a search/read tool.

### Bash-curl nudge

A non-blocking `tool_call` interceptor watches for `bash` invocations whose
`command` targets `raw.githubusercontent.com` or `api.github.com` (simple
substring/regex match, not a full command parse) and calls
`ctx.ui.notify(...)` suggesting `gh_read_file`/`gh_search` instead. It never
returns `{ block: true }` — this is a nudge, not an enforcement mechanism,
because there are legitimate reasons to hit those hosts directly (e.g.
downloading a release asset, hitting an API shape this extension doesn't
model) that shouldn't be blocked.

## Testing plan

- `search.ts` and `read-file.ts` are pure functions (argv building, `--json`
  field selection, response parsing, formatting/truncation, binary/line-
  window logic) unit-tested with literal fixture JSON and no real `gh`
  process — mirrors `extensions/lazyworktree`'s `LazyWorktreeRunner`
  injectable-exec pattern.
- `runner.ts`'s cached-auth-status logic is tested with an injected fake exec
  function returning canned `gh auth status` output/exit codes.
- No test in the default `npm test` run makes a real network call or invokes
  the real `gh` binary; live-CLI behavior already verified during this
  design (blob-sha semantics, `Content-Type` behavior, `Range` behavior) is
  recorded here rather than re-asserted at test time against live GitHub
  state, which would be flaky and rate-limit-sensitive.

## Explicit scope cuts

Recorded here so a future change to any of these is a deliberate revision of
this doc, not silent drift:

- **Five separate `gh_search_*` tools** were considered and rejected in favor
  of one `gh_search` tool with a `type` enum, for tool-list and cross-provider
  schema reasons (see "Why one tool with a `type` enum").
- **The long tail of `gh search` flags** (dates, reactions, milestones,
  review status/requested-reviewer, checks, good-first-issue counts, etc.)
  for `repos`/`issues`/`prs`/`commits` is not modeled as dedicated
  parameters; it's reachable through `query`'s native qualifier syntax.
  `type: "code"` is the one type with zero cuts, matching the primary use
  case this extension is built for.
- **Range-based partial remote fetch** is not implemented because GitHub's
  API does not support it on the endpoints this tool uses (verified live,
  not assumed) — `gh_read_file` fetches the whole file and slices locally.
- **Image/binary content support** in `gh_read_file` (returning an image
  content block for `.png`/`.jpg`/etc., mirroring the built-in `read` tool)
  is deferred. The MVP refuses binaries with a clear message.
- **A dedicated "view issue/PR" tool** is not included; `gh_search` results
  carry enough (`number`, `url`, `repository`) for the model to use `bash` +
  `gh issue view`/`gh pr view` directly for that, and duplicating that in a
  typed tool doesn't solve a demonstrated problem the way remote file reads
  do.
- **No write/mutation GitHub operation** is ever performed by this
  extension. `gh_search` only calls `gh search` (inherently read-only); `gh
  api` calls in `gh_read_file` always pass `--method GET` explicitly.
