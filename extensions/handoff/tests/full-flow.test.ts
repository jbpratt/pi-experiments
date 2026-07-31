import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import handoff, { HANDOFF_PERSIST_CHANNEL, HANDOFF_RESOLVE_TARGET_CHANNEL } from "../index.ts";
import { HANDOFF_SOURCE_ENTRY_TYPE } from "../workflow.ts";

/**
 * End-to-end coverage for the real `handoff(pi)` factory: registers the
 * `/handoff` command against a fake `ExtensionAPI` (real `pi.events`
 * semantics via a plain EventEmitter, everything else stubbed) and drives
 * the actual exported handler through `resolveHandoffTarget`/`persistHandoff`
 * as wired by `index.ts` itself — not through directly-injected fakes like
 * workflow.test.ts, and not through the interop helpers in isolation like
 * interop.test.ts/index.test.ts. This is the one place a wiring mistake in
 * the default export (e.g. forgetting to bind `pi.events` into both
 * factories) would actually be caught.
 */

interface FakePi {
	events: { emit(channel: string, data: unknown): void; on(channel: string, handler: (data: unknown) => void): () => void };
	registerCommand(name: string, options: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }): void;
}

function fakePi(): FakePi {
	const emitter = new EventEmitter();
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
	return {
		events: {
			emit: (channel, data) => emitter.emit(channel, data),
			on: (channel, handler) => {
				emitter.on(channel, handler);
				return () => emitter.off(channel, handler);
			},
		},
		registerCommand: (name, options) => {
			commands.set(name, options);
		},
		get(name: string) {
			return commands.get(name);
		},
	} as unknown as FakePi & { get(name: string): { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> } | undefined };
}

interface FixtureOptions {
	responseText: string;
	editedPrompt: string;
}

function fixtureContext(options: FixtureOptions) {
	const notifications: Array<{ message: string; level?: string }> = [];
	const editorCalls: Array<{ title: string; initial: string }> = [];
	const setupEntries: Array<{ customType: string; data?: unknown }> = [];
	const replacementMessages: string[] = [];
	const newSessionCalls: string[] = [];
	let newSessionCalled = false;

	const provider = {
		streamSimple: () => ({
			result: async () => ({
				role: "assistant",
				content: [{ type: "text", text: options.responseText }],
				stopReason: "stop",
				usage: {},
				api: "test-api",
				provider: "test-provider",
				model: "test-model",
				timestamp: Date.now(),
			}),
		}),
	};

	const ctx = {
		hasUI: true,
		mode: "print", // non-"tui": generateHandoffPrompt calls generatePrompt directly, no ui.custom/BorderedLoader needed
		model: { id: "test-model", provider: "test-provider" },
		modelRegistry: {
			getProvider: () => provider,
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
		},
		ui: {
			async editor(title: string, initial: string) {
				editorCalls.push({ title, initial });
				return options.editedPrompt;
			},
			notify(message: string, level?: "info" | "warning" | "error") {
				notifications.push({ message, level });
			},
		},
		sessionManager: {
			buildSessionContext: () => ({ messages: [{ role: "user", content: "existing work" }] }),
			getSessionId: () => "source-session",
			getSessionFile: () => "/sessions/source.jsonl",
			isPersisted: () => true,
		},
		async waitForIdle() {},
		async newSession(newOptions: {
			parentSession: string;
			setup(sessionManager: { appendCustomEntry(customType: string, data?: unknown): string }): Promise<void> | void;
			withSession(ctx: { sendUserMessage(content: string): Promise<void> }): Promise<void> | void;
		}) {
			newSessionCalled = true;
			newSessionCalls.push(newOptions.parentSession);
			await newOptions.setup({
				appendCustomEntry(customType, data) {
					setupEntries.push({ customType, data });
					return "entry-id";
				},
			});
			await newOptions.withSession({
				async sendUserMessage(content: string) {
					replacementMessages.push(content);
				},
			});
			return { cancelled: false };
		},
	} as unknown as ExtensionCommandContext;

	return { ctx, notifications, editorCalls, setupEntries, replacementMessages, newSessionCalls, wasNewSessionCalled: () => newSessionCalled };
}

test("full /handoff run works standalone when nothing listens on the interop channels", async () => {
	const pi = fakePi();
	handoff(pi as unknown as ExtensionAPI);
	const command = (pi as unknown as { get(name: string): { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> } }).get("handoff");
	assert.ok(command, "handoff(pi) must register a /handoff command");

	const f = fixtureContext({ responseText: "Continue the implementation.", editedPrompt: "  Continue the implementation.  " });
	await command!.handler("continue the work", f.ctx);

	// Standalone: no destination-title review, no persist request, but the
	// session still gets started and tagged with a source entry.
	assert.deepEqual(f.editorCalls, [{ title: "Review handoff document (Esc to cancel)", initial: "Continue the implementation." }]);
	assert.deepEqual(f.replacementMessages, ["Continue the implementation."]);
	assert.equal(f.wasNewSessionCalled(), true);
	assert.equal(f.setupEntries[0]?.customType, HANDOFF_SOURCE_ENTRY_TYPE);
	const data = f.setupEntries[0]?.data as Record<string, unknown>;
	assert.equal(data.goal, "continue the work");
	assert.equal("workboard" in data, false);
	assert.deepEqual(
		f.notifications.filter((n) => n.level === "error"),
		[],
	);
});

test("full /handoff run persists through a responder that confirms a brand-new destination", async () => {
	const pi = fakePi();
	pi.events.on(HANDOFF_RESOLVE_TARGET_CHANNEL, (data) => {
		const { replyChannel } = data as { replyChannel: string };
		pi.events.emit(replyChannel, { kind: "new" });
	});
	pi.events.on(HANDOFF_PERSIST_CHANNEL, (data) => {
		const { replyChannel } = data as { replyChannel: string };
		pi.events.emit(replyChannel, { ok: true, cardId: "card-77", handoffId: "handoff-77" });
	});
	handoff(pi as unknown as ExtensionAPI);
	const command = (pi as unknown as { get(name: string): { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> } }).get("handoff");

	const f = fixtureContext({
		responseText: JSON.stringify({ title: "Implement destination handling", prompt: "Generated continuation." }),
		editedPrompt: "Destination title:\nReviewed destination title\n\nHandoff prompt:\nReviewed continuation.",
	});
	await command!.handler("build destination handling", f.ctx);

	assert.deepEqual(f.editorCalls, [{
		title: "Review destination title and handoff document (Esc to cancel)",
		initial: "Destination title:\nImplement destination handling\n\nHandoff prompt:\nGenerated continuation.",
	}]);
	assert.deepEqual(f.replacementMessages, ["Reviewed continuation."]);
	assert.equal(f.setupEntries[0]?.customType, HANDOFF_SOURCE_ENTRY_TYPE);
	assert.deepEqual((f.setupEntries[0]?.data as Record<string, unknown>).workboard, { cardId: "card-77", handoffId: "handoff-77" });
	assert.deepEqual(
		f.notifications.filter((n) => n.level === "error"),
		[],
	);
});

test("full /handoff run fails closed when a confirmed destination's persist step never answers", async () => {
	const pi = fakePi();
	pi.events.on(HANDOFF_RESOLVE_TARGET_CHANNEL, (data) => {
		const { replyChannel } = data as { replyChannel: string };
		pi.events.emit(replyChannel, { kind: "attached", cardId: "card-9" });
	});
	// Deliberately no listener on HANDOFF_PERSIST_CHANNEL: the persist request times out.
	handoff(pi as unknown as ExtensionAPI);
	const command = (pi as unknown as { get(name: string): { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> } }).get("handoff");

	const f = fixtureContext({ responseText: "Generated continuation.", editedPrompt: "Reviewed continuation." });
	await command!.handler("continue", f.ctx);

	assert.equal(f.wasNewSessionCalled(), false, "a session must not be created when persistence could not be confirmed");
	assert.deepEqual(f.notifications.at(-1), {
		message: "Handoff was not saved: no interop responder confirmed the handoff persistence request",
		level: "error",
	});
});
