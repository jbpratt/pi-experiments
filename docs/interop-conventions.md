# Interop conventions for extensions/*

Extensions in this repo are meant to be independently installable: someone can
run `pi-lazyworktree` without `pi-handoff`, or vice versa, and neither should
break. But sometimes two of them want to cooperate *if* the other one happens
to be installed too — leave a marker the other can read, announce a status the
other can display, or ask the other to actually do something.

The one thing you must never do for this is `import` code from another
extension's package. Per `@earendil-works/pi-coding-agent`'s `docs/packages.md`:

> Pi loads packages with separate module roots, so separate installs do not
> collide or share modules.

Two separately-installed pi packages don't share a module graph. Unless one
explicitly bundles the other as a real `dependency`/`bundledDependency` and
loads its resources through `node_modules/`, there is no module path from one
extension's `.ts` file to another's. So "does the user have the other
extension installed" and "cooperate with it when they do" has to go through
primitives that are routed through the shared pi runtime object and session
state instead of module resolution: `pi.events`, `pi.appendEntry`,
`pi.getCommands()`/`pi.getAllTools()`, and `pi.sendUserMessage()`. All of
these are real, documented `ExtensionAPI` surface — see
`@earendil-works/pi-coding-agent`'s `docs/extensions.md` — not something
bolted on for this purpose.

This doc collects the patterns worth reaching for, roughly in order of how
much coupling they cost.

## A. Duck-typed protocol constant

**Solves:** leaving a durable marker (an audit entry, a status card, a
completion record) that another extension may *optionally* read back later,
with zero packaging relationship between the two.

Both sides independently hardcode the same literal `customType` string and
each owns its own TypeScript interface for the payload shape. There is no
shared package — just an agreement, written down in each extension's own
README under a `## Interop` heading, that this string and shape are a
versioned wire contract. Suffix it `:v1` so a future breaking change can ship
as `:v2` without silently corrupting older readers.

Writer (`extensions/producer/index.ts`):

```typescript
// README: ## Interop
// Writes a durable "producer:record:v1" entry: { id: string; status: "ok" | "failed" }
// Any extension may read this back via ctx.sessionManager.getEntries()/getBranch().
pi.appendEntry("producer:record:v1", { id: "abc123", status: "ok" });
```

Reader (`extensions/consumer/index.ts`, a completely separate package):

```typescript
// README: ## Interop
// Optionally reads "producer:record:v1" entries if pi-producer happens to be installed.
// Shape is duck-typed against pi-producer's documented v1 contract; not imported.
interface ProducerRecordV1 {
  id: string;
  status: "ok" | "failed";
}

pi.on("session_start", (_event, ctx) => {
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type === "custom" && entry.customType === "producer:record:v1") {
      const record = entry.data as ProducerRecordV1;
      // ...
    }
  }
});
```

A different extension than the writer can even own the *rendering* for that
`customType` via `pi.registerEntryRenderer("producer:record:v1", ...)` — entry
renderers are looked up by `customType` at render time, not by which
extension called `appendEntry`.

**Tradeoffs:** if the counterpart isn't installed, you simply never see any
`producer:record:v1` entries — that's a no-op, not an error, so this degrades
safely. The failure mode to watch for is drift: two READMEs maintained in two
repos can silently disagree on the payload shape after one side changes it
without bumping the version suffix. There's no compiler catching that.

## B. Presence probing + optional capability announcement

**Solves:** the "is extension X even here?" gate that used to be a hard
`import { isXInstalled } from "x"` boolean check.

Two variants, often combined:

1. Check whether a known command or tool name is currently registered:

```typescript
function isHandoffInstalled(pi: ExtensionAPI): boolean {
  return pi.getCommands().some((c) => c.name === "handoff" && c.source === "extension");
  // or: pi.getAllTools().some((t) => t.name === "handoff_create_ticket")
}
```

2. A provider announces readiness on `session_start` so consumers don't have
   to poll:

```typescript
// Provider side
pi.on("session_start", () => {
  pi.events.emit("pi-handoff:ready", { version: 1 });
});
```

```typescript
// Consumer side — optional, no error if it never fires
pi.events.on("pi-handoff:ready", (data) => {
  const { version } = data as { version: number };
  handoffAvailable = true;
});
```

**Tradeoffs:** `pi.getCommands()`/`pi.getAllTools()` only tell you a name is
registered *right now* in this session — fine for a load-order-independent
gate, but it's a name collision away from a false positive if two unrelated
packages happen to register the same command/tool name. The event variant
only tells you the counterpart existed at `session_start` time; if it's
disabled mid-session there's nothing pushing a "gone" event unless the
provider explicitly emits one on teardown.

## C. Push-state via events

**Solves:** the pattern that used to be "import a live getter function from
the other extension and call it on every render" — a status line or widget
that wants to reflect another extension's in-memory state.

The provider emits on a documented channel every time its state actually
changes; the consumer subscribes once, near session start, and caches the
last value locally instead of pulling on demand.

```typescript
// Provider: extensions/queue-runner/index.ts
// README: ## Interop — emits "queue-runner:state:v1" with { pending: number; running: boolean }
// whenever queue state changes. No request/response; fire-and-forget.
function publishState(pi: ExtensionAPI, pending: number, running: boolean) {
  pi.events.emit("queue-runner:state:v1", { pending, running });
}
```

```typescript
// Consumer: extensions/status-line/index.ts
interface QueueRunnerStateV1 {
  pending: number;
  running: boolean;
}

let lastQueueState: QueueRunnerStateV1 | undefined;

pi.on("session_start", (_event, ctx) => {
  pi.events.on("queue-runner:state:v1", (data) => {
    lastQueueState = data as QueueRunnerStateV1;
    ctx.ui.setStatus("queue", lastQueueState.running ? `${lastQueueState.pending} queued` : undefined);
  });
});
```

**Tradeoffs:** `pi.events.emit` is synchronous and fire-and-forget — it does
not await async handlers, and a throwing/rejecting handler is caught and
logged by the bus itself rather than propagating back to the emitter or
crashing other listeners (see `createEventBus()` in
`dist/core/event-bus.js`). That means the provider never learns whether
anyone was listening. If the counterpart extension isn't installed, `emit`
still runs — it is just a call into an `EventEmitter` with zero listeners for
that channel — so this is inherently safe to call unconditionally. The
consumer just never gets a value and should have a sensible "unknown/absent"
default rather than assuming an update always eventually arrives.

## D. Request/response RPC-over-events

**Solves:** the case where a consumer needs the counterpart to *do* something
and hand back a result — e.g. "create a ticket you own and give me its id" —
not just observe a broadcast.

**There is no built-in synchronous cross-extension function-call API in
pi.** `pi.events` only gives you `emit`/`on`; there's no request/reply
primitive baked into the platform. This pattern is a convention layered on
top of `pi.events`: the requester makes up a one-off reply channel name,
embeds it in the request payload, and races a listener on that reply channel
against a short timeout. Because delivery is in-process (an `EventEmitter`
call, not a network round trip), a timeout of a few hundred milliseconds is
already generous — if nothing answers by then, treat the counterpart as not
installed (or not responding) and fall back to standalone behavior.

Requester helper:

```typescript
function requestTicket(
  pi: ExtensionAPI,
  payload: { title: string },
  timeoutMs = 300,
): Promise<{ id: string } | undefined> {
  return new Promise((resolve) => {
    const replyChannel = `ticket-service:reply:${crypto.randomUUID()}`;
    let settled = false;

    const unsubscribe = pi.events.on(replyChannel, (data) => {
      if (settled) return;
      settled = true;
      unsubscribe();
      resolve(data as { id: string });
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      unsubscribe();
      resolve(undefined); // no responder — counterpart absent, or too slow
    }, timeoutMs);
    timer.unref?.();

    pi.events.emit("ticket-service:request:v1", { ...payload, replyChannel });
  });
}
```

Responder skeleton (in the other, optional extension):

```typescript
pi.events.on("ticket-service:request:v1", async (data) => {
  const { title, replyChannel } = data as { title: string; replyChannel: string };
  const id = await createTicket(title); // whatever this extension actually owns
  pi.events.emit(replyChannel, { id });
});
```

**Tradeoffs:** this is the heaviest of the event-based patterns — you're
hand-rolling correlation IDs and timeout handling for what would be a
function call if the two extensions shared a module. Handler errors inside
the responder are swallowed by the bus's own try/catch (per
`createEventBus()`), so a responder that throws before calling
`pi.events.emit(replyChannel, ...)` looks identical to "not installed" from
the requester's side — the timeout fires either way. Keep the responder side
defensive and prefer emitting an explicit error payload on the reply channel
over letting an exception silently become a timeout.

## E. Optional thin shared "protocol" package

**Solves:** pattern A's literal-duplication problem once it actually starts
drifting — two READMEs disagreeing about a `customType` string or payload
shape because someone edited one and forgot the other.

Extract *only* the `customType` constants and the payload TypeScript
interfaces — no logic, no storage, no `ExtensionAPI` usage — into a small
published npm package. Both extensions list it as a normal (non-peer)
`dependency`, the same as any other third-party runtime dependency per
`@earendil-works/pi-coding-agent`'s `docs/packages.md` ("Dependencies" section):

```typescript
// pi-interop-protocols/src/ticket-service.ts
export const TICKET_SERVICE_REQUEST_V1 = "ticket-service:request:v1";
export interface TicketServiceRequestV1 {
  title: string;
  replyChannel: string;
}
```

```typescript
// extensions/ticket-service/index.ts
import { TICKET_SERVICE_REQUEST_V1, type TicketServiceRequestV1 } from "pi-interop-protocols/ticket-service";
```

This is a heavier-weight fallback, not the default. It reintroduces a real
package dependency between two things that are otherwise independently
installable, and it only pays for itself once you have enough literals (or
enough drift pain) to justify a versioned package release cycle. Start with
pattern A; reach for E when A's duplication becomes the actual bug.

## Decision table

| Need | Pattern |
| --- | --- |
| Leave a durable marker another extension may optionally read later | A — protocol constant |
| Cheap "is the other extension here?" gate | B — presence probing |
| One-shot "I just started/finished" signal | B — capability announcement event |
| Keep a status/UI display in sync with another extension's live state | C — push-state via events |
| Ask the other extension to do something and get a result back | D — request/response over events |
| A's duplicated literals across READMEs have started drifting | E — shared protocol package |

## When NOT to decouple

None of this is for extensions that are meant to ship and version together as
one suite, or for a plain type-only shape contract with no runtime
cooperation. If two extensions in this repo are conceptually one feature
split across files for organization, just share types through a normal
module import within that package — there's no "other install" to be
independent of.

These patterns exist specifically for extensions meant to be installed
independently that want to notice and cooperate with each other *when* the
other one happens to also be present, and to keep working correctly, with no
errors and no crashes, when it isn't.
