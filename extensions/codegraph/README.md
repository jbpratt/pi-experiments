# pi-codegraph

A [pi](https://pi.dev) extension that exposes [CodeGraph](https://github.com/colbymchenry/codegraph) as typed symbol-search, symbol-relationship, and graph-trace tools for the exact current Git worktree.

This extension has no dependency on any other pi extension. It is a clean-room implementation, operationally independent from any lexical/Zoekt-style search extension you may also have installed: no shared backend, index registry, query compiler, cache, or lifecycle manager.

## What it does

**Session-scoped worker.** On first use for a worktree, the extension lazily spawns a Pi-owned Node child process (`worker.ts`) that imports the `@colbymchenry/codegraph` library directly and speaks a small versioned JSONL protocol over stdio. Telemetry and the update check are always disabled (`DO_NOT_TRACK=1`, `CODEGRAPH_TELEMETRY=0`, `CODEGRAPH_NO_UPDATE_CHECK=1`), and proxy/API-key environment variables are stripped from the worker's environment. At most 2 workers stay alive at once; opening a third root evicts the least-recently-used one. A protocol violation, crash, or explicit close always terminates the underlying OS process — no zombie workers.

**Exact worktree identity.** Every request resolves the exact canonical (symlink-resolved) Git worktree root via `git rev-parse --show-toplevel`, not nearest-`.codegraph` discovery. Two worktrees of the same repository always get distinct opaque repository IDs and never share an index or an answer.

**Four tools:**

- `codegraph_search` — find candidate symbols by name/text.
- `codegraph_symbol` — inspect one symbol's definition, usages, callers, callees, type hierarchy, or containment context.
- `codegraph_trace` — shortest path, call graph, or impact radius between symbols.
- `codegraph_status` — `inspect` (read-only), `ensure` (first indexing; requires interactive confirmation), `refresh` (local-only freshness sync). `acquire`/`fetch` are accepted for schema forward-compatibility but return `remote_unavailable`: remote repository acquisition is a separate, not-yet-implemented phase.

**Checkpoint freshness.** Every search/symbol/trace call first asks the worker for changed files and runs one incremental sync before answering, so staged, unstaged, untracked, renamed, and deleted files are reflected in the next query without a permanent file watcher.

**First-index consent.** The first index of a worktree requires interactive confirmation showing the exact worktree root, branch/HEAD, a bounded semantic/shallow/unsupported file-count preview (from `git ls-files`, before any CodeGraph API call), and that graph results may enter the currently selected Pi model's context. Denial or no UI performs no initialization. A private, user-only registry (`~/.pi/agent/codegraph/registry.json`, mode `0600`) records consent and last-sync state — never credentials, tokens, query text, or graph content.

**Bounded, typed, honest results.** Every result carries a schema version, freshness metadata, and a coverage tier (`semantic` for Python/TypeScript/JavaScript/TSX/JSX/Go, `shallow` for YAML file-tracking only, `unsupported` for everything else including shell). Node/edge counts, snippet lines, and total serialized bytes are all bounded before a result is returned; truncation is always reported via `bounds`, never silently applied. Ambiguous symbol names return candidates instead of guessing.

**Commands:**

```text
/codegraph
/codegraph status
/codegraph repos
/codegraph index
/codegraph refresh [repository-id]
/codegraph doctor
```

`/codegraph add`/`fetch` are registered but reply that remote acquisition is not implemented in this build, rather than silently failing or not existing.

## Install

```bash
pi install npm:pi-codegraph
```

or from a local checkout:

```bash
pi install ./extensions/codegraph
```

Requires Node **>=22.5** in Pi's own runtime (for built-in `node:sqlite`, which the CodeGraph library opens lazily). `/codegraph doctor` checks this and a few other preconditions without installing, upgrading, cloning, fetching, resetting, or rebuilding anything.

Installing pulls in `@colbymchenry/codegraph`'s platform-specific optional dependency, which bundles its own Node runtime and native parsing kernel for its separate CLI/MCP entry point — this extension only uses the library entry point, but `npm install` still downloads the full platform bundle (roughly 250–300 MB on disk). This is an upstream packaging characteristic, not something this extension controls.

## Notes on scope

This is a Phase 0 (runtime/library spike) + Phase 1 (current-worktree MVP) implementation. Deliberately out of scope for this build:

- **Remote repository acquisition** (`codegraph_status action=acquire|fetch`, `/codegraph add|fetch`, `remote.ts`, private managed checkouts). The public schemas accept these actions/commands so the surface doesn't need another breaking change later, but they always return `remote_unavailable`/an explanatory message and never touch the network. Only the exact current local worktree is supported; a `repositoryId` that doesn't match it is rejected.
- **Black-box comparison with a lexical/Zoekt-style search extension.** Not implemented, not benchmarked, and this extension has no awareness of any such extension.
- **A general command channel or CLI/MCP passthrough.** The worker only understands the fixed set of typed operations in `types.ts`; it never receives an executable, module path, arbitrary database path, or shell command from a request.
- **External index storage.** CodeGraph's public API does not expose a per-instance data path, so `.codegraph/` is created inside the worktree itself (upstream also writes `.codegraph/.gitignore`, but the directory may still appear as untracked repository state). This is stated in the first-index confirmation, not hidden.
- **Cross-tool-call sync coalescing as a separate optimization layer.** Each search/symbol/trace call runs its own checkpoint sync; concurrent calls are not deduplicated into one shared in-flight sync promise. In practice this is cheap (CodeGraph's own `sync()` is a fast no-op when nothing changed), but it is a simpler implementation than the design's "coalesce concurrent checks" bullet describes.
- **Index purge/rebuild and a confirmed repair flow.** A `repair_required` status is reported (e.g. on a database error) but no destructive recovery action is offered yet.

## Model egress

CodeGraph itself performs no network operation (this extension disables its telemetry/update-check paths). That does **not** mean graph results stay on your machine: search/symbol/trace results, paths, signatures, and any requested source excerpts become ordinary Pi tool-call context and follow your currently selected model provider's normal policy, the same as `read`/`grep` output would.
