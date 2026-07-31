# pi-experiments

Personal [pi](https://pi.dev) extensions.

Each top-level directory under `extensions/` is a self-contained, independently
installable pi extension with its own `package.json`. See each extension's own
README for what it does and how to install it.

## Extensions

- [`extensions/codegraph`](extensions/codegraph) — typed symbol-search, symbol-relationship, and graph-trace tools for the exact current worktree, backed by a session-scoped CodeGraph worker.
- [`extensions/handoff`](extensions/handoff) — generates a reviewed session-handoff prompt via `/handoff <goal>` and starts a fresh continuation session with it, standalone by default with an optional interop contract for a task-tracking extension to own the destination.
- [`extensions/kube-approval`](extensions/kube-approval) — approval gate for guarded oc/kubectl/aws bash commands
- [`extensions/lazyworktree`](extensions/lazyworktree) — protects the LazyWorktree main checkout from unreviewed mutation and gives the agent a `workspace` tool to prepare, create, rebase, and merge managed Git worktrees.

## Development

```bash
npm install   # dev-only deps to run the test suite locally
npm test      # runs every extension's tests
npm run lint  # repo-wide whitespace/newline/JSON/syntax checks
```

Each extension also has its own `peerDependencies` declaring what it needs
from a real pi installation; the root `package.json` is private and exists
only for this dev workflow, not for publishing.
