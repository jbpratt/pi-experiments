# pi-handoff

A [pi](https://pi.dev) extension that adds a `/handoff <goal>` command: it asks
the model to turn the current conversation plus your stated goal into a
concise, self-contained continuation prompt, lets you review and edit it, then
starts a brand-new session and sends it that prompt.

This extension has no dependency on any other pi extension or package beyond
pi itself. By default it is fully standalone — nothing is persisted outside
the session. It also defines a small optional request/response interop
contract (see below) that a separate task-tracking extension can implement to
own where handoffs go.

## What it does

1. `/handoff <goal>` waits for the agent to go idle, then asks (via the
   optional interop channel below) whether some other extension wants to own
   this handoff's destination. With no responder, the handoff proceeds
   standalone.
2. The current conversation and your goal are sent to the model, which
   returns a continuation prompt (and, only when a responder confirmed a
   brand-new destination, a destination title as well).
3. You review and can edit the generated prompt (and title, if applicable) in
   pi's multi-line editor before anything happens. Cancelling at this point
   (or leaving the document empty) aborts the handoff — nothing is created.
4. If a responder confirmed a destination, the reviewed document is sent back
   over the persist interop channel for that extension to store. If nothing
   confirmed a destination, this step is skipped entirely.
5. A new session is started as a child of the current one, and the reviewed
   document is sent to it as the first user message. A `pi-handoff:source`
   session entry records the source session, the goal, and (when applicable)
   the destination ids, for audit/debugging — it does not participate in LLM
   context.

If persisting to an already-confirmed destination fails (the responder times
out or replies with `ok: false`), the handoff fails closed: you get an error
notification and no new session is created. This avoids leaving a destination
card with no matching handoff document.

## Install

```bash
pi install npm:pi-handoff
```

or from a local checkout:

```bash
pi install ./extensions/handoff
```

## Interop (optional)

See [`../../docs/interop-conventions.md`](../../docs/interop-conventions.md)
for the general request/response-over-`pi.events` pattern this extension
uses: a correlation id in the form of a per-call random reply channel, plus a
short timeout so a missing or slow responder degrades to "no responder"
instead of hanging or throwing.

A task-tracking extension can opt into owning handoff destinations by
listening on both channels below. Both are versioned (`:v1` suffix); treat
any shape change as a new channel name.

### `pi-handoff:workboard:resolve-target:v1`

Asked once per `/handoff` invocation, before generation, to decide whether
this handoff should target an already-tracked destination, a brand-new one,
or neither.

Request payload (emitted by this extension):

```ts
{ sourceSessionId: string; sourceSessionFile: string; replyChannel: string }
```

Reply payload (emitted by the responder on `replyChannel`):

```ts
| { kind: "attached"; cardId: string }
| { kind: "new" }
| { kind: "none" }
```

No listener, a `{ kind: "none" }` reply, or a timeout (default 400ms) are all
treated identically: the handoff proceeds standalone. `{ kind: "new" }`
additionally makes this extension ask the model for a destination title
alongside the continuation prompt, and show both for review.

### `pi-handoff:workboard:persist:v1`

Only emitted when `resolve-target` confirmed `attached` or `new`. Asks the
responder to durably persist the reviewed handoff document.

Request payload:

```ts
{
  goal: string;
  document: string;
  title?: string; // present when the confirmed target was "new"
  target: { kind: "attached"; cardId: string } | { kind: "new" };
  sourceSessionId: string;
  sourceSessionFile: string;
  replyChannel: string;
}
```

Reply payload:

```ts
| { ok: true; cardId: string; handoffId: string }
| { ok: false; reason: string }
```

A missing reply or `ok: false` here fails the whole handoff closed (error
notification, no new session) rather than silently falling back to
standalone, since a responder already confirmed a destination exists at this
point.

## Notes on scope

This extension does not ship any task-tracking or destination-persistence
logic of its own — no SQLite state, no card store, no "new destination" UI
beyond the plain title/prompt review editor. Unlike the private reference
implementation this was ported from, it also does not import or assume the
presence of any specific companion extension; it only defines the two
interop channels above and behaves fully standalone without a responder.

If you want handoffs to land somewhere durable, wire that up yourself against
these two channels from your own extension.
