import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createPersistHandoff, createResolveHandoffTarget, HANDOFF_PERSIST_CHANNEL, HANDOFF_RESOLVE_TARGET_CHANNEL, generatePrompt } from "../index.ts";
import type { RequestEventBus } from "../interop.ts";

function agentMessage(text: string) {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

test("generatePrompt streams through the model's registered Provider instead of the global api-provider registry", async () => {
	// Extension-registered providers (e.g. anthropic-vertex from @twogiants/pi-anthropic-vertex)
	// compose their own streamSimple and never register with pi-ai's global api-provider
	// registry. generatePrompt must resolve the model via ctx.modelRegistry.getProvider(),
	// the same composed provider normal chat uses, not the low-level api-registry lookup
	// that only knows built-in apis.
	const model = { id: "claude-sonnet-5", provider: "anthropic-vertex", api: "anthropic-vertex" };
	const streamCalls: unknown[] = [];
	const provider = {
		streamSimple: (streamModel: unknown, context: unknown, options: unknown) => {
			streamCalls.push({ streamModel, context, options });
			return {
				result: async () => ({
					role: "assistant",
					content: [{ type: "text", text: "generated handoff prompt" }],
					stopReason: "stop",
					usage: {},
					api: model.api,
					provider: model.provider,
					model: model.id,
					timestamp: Date.now(),
				}),
			};
		},
	};
	const ctx = {
		model,
		modelRegistry: {
			getProvider: (providerId: string) => (providerId === model.provider ? provider : undefined),
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
		},
	} as unknown as Parameters<typeof generatePrompt>[0];

	const result = await generatePrompt(ctx, "continue the work", [agentMessage("hello world")], false);

	assert.deepEqual(result, { status: "completed", prompt: "generated handoff prompt" });
	assert.equal(streamCalls.length, 1);
});

test("generatePrompt fails closed when the model's provider is not registered", async () => {
	const model = { id: "claude-sonnet-5", provider: "unregistered-provider", api: "unregistered-provider" };
	const ctx = {
		model,
		modelRegistry: {
			getProvider: () => undefined,
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
		},
	} as unknown as Parameters<typeof generatePrompt>[0];

	const result = await generatePrompt(ctx, "continue the work", [agentMessage("hello world")], false);

	assert.deepEqual(result, { status: "error", message: 'No provider registered for "unregistered-provider"' });
});

function fakeEventBus(): RequestEventBus {
	const emitter = new EventEmitter();
	return {
		emit: (channel, data) => emitter.emit(channel, data),
		on: (channel, handler) => {
			emitter.on(channel, handler);
			return () => emitter.off(channel, handler);
		},
	};
}

test("resolveHandoffTarget is standalone when nothing responds", async () => {
	const events = fakeEventBus();
	const resolveHandoffTarget = createResolveHandoffTarget(events);

	const target = await resolveHandoffTarget(
		{ sourceSessionId: "source-session", sourceSessionFile: "/sessions/source.jsonl" },
		{} as never,
	);

	assert.deepEqual(target, { kind: "standalone" });
});

test("resolveHandoffTarget is standalone when the responder explicitly declines", async () => {
	const events = fakeEventBus();
	events.on(HANDOFF_RESOLVE_TARGET_CHANNEL, (data) => {
		const { replyChannel } = data as { replyChannel: string };
		events.emit(replyChannel, { kind: "none" });
	});
	const resolveHandoffTarget = createResolveHandoffTarget(events);

	const target = await resolveHandoffTarget(
		{ sourceSessionId: "source-session", sourceSessionFile: "/sessions/source.jsonl" },
		{} as never,
	);

	assert.deepEqual(target, { kind: "standalone" });
});

test("resolveHandoffTarget forwards attached/new confirmations from a responder", async () => {
	const events = fakeEventBus();
	let lastRequest: unknown;
	events.on(HANDOFF_RESOLVE_TARGET_CHANNEL, (data) => {
		lastRequest = data;
		const { replyChannel } = data as { replyChannel: string };
		events.emit(replyChannel, { kind: "attached", cardId: "card-1" });
	});
	const resolveHandoffTarget = createResolveHandoffTarget(events);

	const target = await resolveHandoffTarget(
		{ sourceSessionId: "source-session", sourceSessionFile: "/sessions/source.jsonl" },
		{} as never,
	);

	assert.deepEqual(target, { kind: "attached", cardId: "card-1" });
	assert.deepEqual(lastRequest, {
		sourceSessionId: "source-session",
		sourceSessionFile: "/sessions/source.jsonl",
		replyChannel: (lastRequest as { replyChannel: string }).replyChannel,
	});
});

test("persistHandoff for a standalone target synthesizes local ids without emitting a persist request", async () => {
	const events = fakeEventBus();
	let persistRequested = false;
	events.on(HANDOFF_PERSIST_CHANNEL, () => {
		persistRequested = true;
	});
	const persistHandoff = createPersistHandoff(events);

	const result = await persistHandoff(
		{
			goal: "continue",
			document: "the document",
			target: { kind: "standalone" },
			sourceSessionId: "source-session",
			sourceSessionFile: "/sessions/source.jsonl",
		},
		{} as never,
	);

	assert.equal(persistRequested, false);
	assert.equal(result.document, "the document");
	assert.ok(result.cardId);
	assert.ok(result.handoffId);
	assert.notEqual(result.cardId, result.handoffId);
});

test("persistHandoff for a confirmed destination round-trips the responder's ids", async () => {
	const events = fakeEventBus();
	let lastRequest: unknown;
	events.on(HANDOFF_PERSIST_CHANNEL, (data) => {
		lastRequest = data;
		const { replyChannel } = data as { replyChannel: string };
		events.emit(replyChannel, { ok: true, cardId: "card-1", handoffId: "handoff-1" });
	});
	const persistHandoff = createPersistHandoff(events);

	const result = await persistHandoff(
		{
			goal: "continue",
			document: "the document",
			title: "A title",
			target: { kind: "attached", cardId: "card-1" },
			sourceSessionId: "source-session",
			sourceSessionFile: "/sessions/source.jsonl",
		},
		{} as never,
	);

	assert.deepEqual(result, { cardId: "card-1", handoffId: "handoff-1", document: "the document" });
	assert.deepEqual(lastRequest, {
		goal: "continue",
		document: "the document",
		title: "A title",
		target: { kind: "attached", cardId: "card-1" },
		sourceSessionId: "source-session",
		sourceSessionFile: "/sessions/source.jsonl",
		replyChannel: (lastRequest as { replyChannel: string }).replyChannel,
	});
});

test("persistHandoff fails closed when a confirmed destination's persist request times out", async () => {
	const events = fakeEventBus();
	// No listener on HANDOFF_PERSIST_CHANNEL: the request times out.
	const persistHandoff = createPersistHandoff(events);

	await assert.rejects(
		persistHandoff(
			{
				goal: "continue",
				document: "the document",
				target: { kind: "new" },
				sourceSessionId: "source-session",
				sourceSessionFile: "/sessions/source.jsonl",
			},
			{} as never,
		),
		/no interop responder confirmed the handoff persistence request/,
	);
});

test("persistHandoff fails closed when the confirmed-destination responder replies ok:false", async () => {
	const events = fakeEventBus();
	events.on(HANDOFF_PERSIST_CHANNEL, (data) => {
		const { replyChannel } = data as { replyChannel: string };
		events.emit(replyChannel, { ok: false, reason: "card is archived" });
	});
	const persistHandoff = createPersistHandoff(events);

	await assert.rejects(
		persistHandoff(
			{
				goal: "continue",
				document: "the document",
				target: { kind: "attached", cardId: "card-1" },
				sourceSessionId: "source-session",
				sourceSessionFile: "/sessions/source.jsonl",
			},
			{} as never,
		),
		/card is archived/,
	);
});
