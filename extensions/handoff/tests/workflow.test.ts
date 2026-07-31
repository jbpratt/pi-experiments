import assert from "node:assert/strict";
import test from "node:test";
import { formatDestinationReview } from "../core.ts";
import {
	createHandoffHandler,
	HANDOFF_SOURCE_ENTRY_TYPE,
	type GenerateHandoffPrompt,
	type HandoffGenerationResult,
	type HandoffTarget,
	type PersistHandoff,
	type ResolveHandoffTarget,
} from "../workflow.ts";

interface FixtureOptions {
	hasUI?: boolean;
	persisted?: boolean;
	sessionFile?: string;
	messages?: unknown[];
	editedPrompt?: string;
	generation?: HandoffGenerationResult;
	persistError?: string;
	cancelReplacement?: boolean;
	target?: HandoffTarget;
	resolveError?: string;
}

const CARD_ID = "11111111-1111-4111-8111-111111111111";
const HANDOFF_ID = "22222222-2222-4222-8222-222222222222";

function fixture(options: FixtureOptions = {}) {
	const notifications: Array<{ message: string; level?: string }> = [];
	const generatedInputs: Array<{ goal: string; messages: unknown[]; target: HandoffTarget }> = [];
	const persistedInputs: Array<{
		goal: string;
		document: string;
		title?: string;
		target: HandoffTarget;
		sourceSessionId: string;
		sourceSessionFile: string;
	}> = [];
	const resolvedInputs: Array<{ sourceSessionId: string; sourceSessionFile: string }> = [];
	const replacementMessages: string[] = [];
	const editorCalls: Array<{ title: string; initial: string }> = [];
	const setupEntries: Array<{ customType: string; data?: unknown }> = [];
	const newSessionParents: string[] = [];
	let waited = 0;
	const messages = options.messages ?? [{ role: "user", content: "existing work" }];
	const generate: GenerateHandoffPrompt = async (input) => {
		generatedInputs.push(input);
		return options.generation ?? { status: "completed", prompt: "generated document" };
	};
	const resolveTarget: ResolveHandoffTarget = async (input) => {
		resolvedInputs.push(input);
		if (options.resolveError) throw new Error(options.resolveError);
		return options.target ?? { kind: "attached", cardId: CARD_ID };
	};
	const persist: PersistHandoff = async (input) => {
		persistedInputs.push(input);
		if (options.persistError) throw new Error(options.persistError);
		return { cardId: CARD_ID, handoffId: HANDOFF_ID, document: input.document };
	};
	const replacementContext = {
		async sendUserMessage(content: string) {
			replacementMessages.push(content);
		},
	};
	const context = {
		hasUI: options.hasUI ?? true,
		mode: "tui",
		model: { id: "test-model" },
		ui: {
			async editor(title: string, initial: string) {
				editorCalls.push({ title, initial });
				return Object.hasOwn(options, "editedPrompt") ? options.editedPrompt : "  reviewed document  ";
			},
			notify(message: string, level?: "info" | "warning" | "error") {
				notifications.push({ message, level });
			},
		},
		sessionManager: {
			buildSessionContext: () => ({ messages }),
			getSessionId: () => "source-session",
			getSessionFile: () => options.sessionFile ?? "/sessions/source.jsonl",
			isPersisted: () => options.persisted ?? true,
		},
		async waitForIdle() {
			waited++;
		},
		async newSession(newOptions: {
			parentSession: string;
			setup(sessionManager: { appendCustomEntry(customType: string, data?: unknown): string }): Promise<void> | void;
			withSession(ctx: typeof replacementContext): Promise<void> | void;
		}) {
			newSessionParents.push(newOptions.parentSession);
			if (options.cancelReplacement) return { cancelled: true };
			await newOptions.setup({
				appendCustomEntry(customType, data) {
					setupEntries.push({ customType, data });
					return "entry-id";
				},
			});
			await newOptions.withSession(replacementContext);
			return { cancelled: false };
		},
	};

	return {
		context,
		editorCalls,
		generate,
		generatedInputs,
		messages,
		newSessionParents,
		notifications,
		persist,
		persistedInputs,
		resolveTarget,
		resolvedInputs,
		replacementMessages,
		setupEntries,
		waited: () => waited,
	};
}

test("reviews a generated title and document before persisting a new-destination handoff", async () => {
	const generation = { title: "Implement destination handoffs", prompt: "Generated continuation." };
	const reviewed = { title: "Implement reviewed destination handoffs", prompt: "Reviewed continuation." };
	const f = fixture({
		target: { kind: "new" },
		generation: { status: "completed", ...generation },
		editedPrompt: formatDestinationReview(reviewed),
	});
	await createHandoffHandler(f.generate, f.resolveTarget, f.persist)("build destination handling", f.context);

	assert.deepEqual(f.generatedInputs, [{ goal: "build destination handling", messages: f.messages, target: { kind: "new" } }]);
	assert.deepEqual(f.editorCalls, [{
		title: "Review destination title and handoff document (Esc to cancel)",
		initial: formatDestinationReview(generation),
	}]);
	assert.deepEqual(f.persistedInputs, [{
		goal: "build destination handling",
		document: "Reviewed continuation.",
		title: "Implement reviewed destination handoffs",
		target: { kind: "new" },
		sourceSessionId: "source-session",
		sourceSessionFile: "/sessions/source.jsonl",
	}]);
	assert.equal(f.setupEntries[0].customType, HANDOFF_SOURCE_ENTRY_TYPE);
	assert.deepEqual(f.setupEntries[0].data, {
		sourceSessionFile: "/sessions/source.jsonl",
		goal: "build destination handling",
		createdAt: (f.setupEntries[0].data as { createdAt: number }).createdAt,
		workboard: { cardId: CARD_ID, handoffId: HANDOFF_ID },
	});
});

test("reviews and persists a handoff before creating its linked continuation session", async () => {
	const f = fixture();
	await createHandoffHandler(f.generate, f.resolveTarget, f.persist)("  finish the feature  ", f.context);

	assert.equal(f.waited(), 1);
	assert.deepEqual(f.resolvedInputs, [{ sourceSessionId: "source-session", sourceSessionFile: "/sessions/source.jsonl" }]);
	assert.deepEqual(f.generatedInputs, [{ goal: "finish the feature", messages: f.messages, target: { kind: "attached", cardId: CARD_ID } }]);
	assert.deepEqual(f.persistedInputs, [
		{
			goal: "finish the feature",
			document: "reviewed document",
			title: undefined,
			target: { kind: "attached", cardId: CARD_ID },
			sourceSessionId: "source-session",
			sourceSessionFile: "/sessions/source.jsonl",
		},
	]);
	assert.deepEqual(f.newSessionParents, ["/sessions/source.jsonl"]);
	assert.equal(f.setupEntries[0].customType, HANDOFF_SOURCE_ENTRY_TYPE);
	assert.deepEqual(f.setupEntries[0].data, {
		sourceSessionFile: "/sessions/source.jsonl",
		goal: "finish the feature",
		createdAt: (f.setupEntries[0].data as { createdAt: number }).createdAt,
		workboard: { cardId: CARD_ID, handoffId: HANDOFF_ID },
	});
	assert.deepEqual(f.replacementMessages, ["reviewed document"]);
});

test("a standalone target skips destination-title generation and records no workboard field", async () => {
	const f = fixture({ target: { kind: "standalone" } });
	await createHandoffHandler(f.generate, f.resolveTarget, f.persist)("continue", f.context);

	assert.deepEqual(f.generatedInputs, [{ goal: "continue", messages: f.messages, target: { kind: "standalone" } }]);
	assert.deepEqual(f.editorCalls, [{
		title: "Review handoff document (Esc to cancel)",
		initial: "generated document",
	}]);
	assert.deepEqual(f.persistedInputs, [{
		goal: "continue",
		document: "reviewed document",
		title: undefined,
		target: { kind: "standalone" },
		sourceSessionId: "source-session",
		sourceSessionFile: "/sessions/source.jsonl",
	}]);
	assert.equal(f.setupEntries[0].customType, HANDOFF_SOURCE_ENTRY_TYPE);
	const data = f.setupEntries[0].data as Record<string, unknown>;
	assert.equal(data.sourceSessionFile, "/sessions/source.jsonl");
	assert.equal(data.goal, "continue");
	assert.equal(typeof data.createdAt, "number");
	assert.equal("workboard" in data, false);
});

test("does nothing without UI", async () => {
	const f = fixture({ hasUI: false });
	await createHandoffHandler(f.generate, f.resolveTarget, f.persist)("continue", f.context);
	assert.equal(f.waited(), 0);
	assert.deepEqual(f.generatedInputs, []);
	assert.deepEqual(f.persistedInputs, []);
	assert.deepEqual(f.newSessionParents, []);
	assert.deepEqual(f.notifications, []);
});

test("cancellation during generation or review does not persist a handoff", async (t) => {
	await t.test("generation cancellation", async () => {
		const f = fixture({ target: { kind: "new" }, generation: { status: "cancelled" } });
		await createHandoffHandler(f.generate, f.resolveTarget, f.persist)("continue", f.context);
		assert.deepEqual(f.persistedInputs, []);
		assert.deepEqual(f.notifications.at(-1), { message: "Handoff cancelled", level: "info" });
	});

	await t.test("editor cancellation", async () => {
		const f = fixture({ target: { kind: "new" }, editedPrompt: undefined });
		await createHandoffHandler(f.generate, f.resolveTarget, f.persist)("continue", f.context);
		assert.deepEqual(f.persistedInputs, []);
		assert.deepEqual(f.notifications.at(-1), { message: "Handoff cancelled", level: "info" });
	});

	await t.test("empty edited document", async () => {
		const f = fixture({ editedPrompt: "  " });
		await createHandoffHandler(f.generate, f.resolveTarget, f.persist)("continue", f.context);
		assert.deepEqual(f.persistedInputs, []);
		assert.deepEqual(f.notifications.at(-1), {
			message: "Handoff cancelled: document is empty",
			level: "warning",
		});
	});
});

test("requires persistence for auditable source-session linkage", async () => {
	const f = fixture({ persisted: false, sessionFile: undefined });
	await createHandoffHandler(f.generate, f.resolveTarget, f.persist)("continue", f.context);
	assert.deepEqual(f.generatedInputs, []);
	assert.deepEqual(f.persistedInputs, []);
	assert.deepEqual(f.notifications.at(-1), {
		message: "Handoff requires a persisted current session",
		level: "error",
	});
});

test("fails closed on target resolution errors before generation", async () => {
	const f = fixture({ resolveError: "the current Pi session is ambiguously linked to multiple destinations" });
	await createHandoffHandler(f.generate, f.resolveTarget, f.persist)("continue", f.context);
	assert.deepEqual(f.generatedInputs, []);
	assert.deepEqual(f.persistedInputs, []);
	assert.deepEqual(f.notifications.at(-1), {
		message: "Handoff cannot start: the current Pi session is ambiguously linked to multiple destinations",
		level: "error",
	});
});

test("reports persistence failures without claiming a handoff was created", async () => {
	const f = fixture({ persistError: "no interop responder confirmed the handoff persistence request" });
	await createHandoffHandler(f.generate, f.resolveTarget, f.persist)("continue", f.context);
	assert.deepEqual(f.newSessionParents, []);
	assert.deepEqual(f.notifications.at(-1), {
		message: "Handoff was not saved: no interop responder confirmed the handoff persistence request",
		level: "error",
	});
});

test("keeps the destination handoff record when continuation session creation is cancelled", async () => {
	const f = fixture({
		target: { kind: "new" },
		generation: { status: "completed", title: "Continue destination work", prompt: "Generated continuation." },
		editedPrompt: formatDestinationReview({ title: "Continue destination work", prompt: "Reviewed continuation." }),
		cancelReplacement: true,
	});
	await createHandoffHandler(f.generate, f.resolveTarget, f.persist)("continue", f.context);
	assert.deepEqual(f.persistedInputs, [{
		goal: "continue",
		document: "Reviewed continuation.",
		title: "Continue destination work",
		target: { kind: "new" },
		sourceSessionId: "source-session",
		sourceSessionFile: "/sessions/source.jsonl",
	}]);
	assert.deepEqual(f.newSessionParents, ["/sessions/source.jsonl"]);
	assert.deepEqual(f.setupEntries, []);
	assert.deepEqual(f.replacementMessages, []);
	assert.deepEqual(f.notifications.at(-1), {
		message: `New session creation cancelled. Handoff ${HANDOFF_ID.slice(0, 8)} remains saved on destination card ${CARD_ID.slice(0, 8)}.`,
		level: "info",
	});
});

test("cancelling replacement session creation for a standalone handoff reports the prompt as lost", async () => {
	const f = fixture({ target: { kind: "standalone" }, cancelReplacement: true });
	await createHandoffHandler(f.generate, f.resolveTarget, f.persist)("continue", f.context);
	assert.deepEqual(f.notifications.at(-1), {
		message: "New session creation cancelled. The reviewed handoff prompt was not saved anywhere and is lost.",
		level: "info",
	});
});
