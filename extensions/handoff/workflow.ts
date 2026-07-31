import { formatDestinationReview, parseDestinationReview } from "./core.ts";

/**
 * Custom session-entry type appended to the *new* replacement session's setup,
 * regardless of whether an external interop responder confirmed a destination.
 * This extension owns this constant; it is not borrowed from any other package.
 */
export const HANDOFF_SOURCE_ENTRY_TYPE = "pi-handoff:source";

export type HandoffGenerationResult =
	| { status: "completed"; prompt: string; title?: string }
	| { status: "cancelled" }
	| { status: "error"; message: string };

/**
 * "attached"/"new" are confirmed by an external interop responder (see index.ts).
 * "standalone" means no responder confirmed a destination (none registered, it
 * declined with `{kind:"none"}`, or the request timed out): the handoff document
 * is generated and reviewed like any other, but nothing is persisted externally
 * and no destination-title generation step runs.
 */
export type HandoffTarget = { kind: "attached"; cardId: string } | { kind: "new" } | { kind: "standalone" };

interface HandoffUi {
	editor(title: string, initial: string): Promise<string | undefined>;
	notify(message: string, level?: "info" | "warning" | "error"): void;
}

interface ReplacementContext {
	sendUserMessage(content: string): Promise<void>;
}

export interface HandoffCommandContext {
	hasUI: boolean;
	mode: string;
	model?: unknown;
	ui: HandoffUi;
	sessionManager: {
		buildSessionContext(): { messages: unknown[] };
		getSessionId(): string;
		getSessionFile(): string | undefined;
		isPersisted(): boolean;
	};
	waitForIdle(): Promise<void>;
	newSession(options: {
		parentSession: string;
		setup(sessionManager: { appendCustomEntry(customType: string, data?: unknown): string }): Promise<void> | void;
		withSession(ctx: ReplacementContext): Promise<void> | void;
	}): Promise<{ cancelled: boolean }>;
}

export interface HandoffGenerationInput {
	goal: string;
	messages: unknown[];
	target: HandoffTarget;
}

export interface ResolveHandoffTargetInput {
	sourceSessionId: string;
	sourceSessionFile: string;
}

export interface PersistHandoffInput {
	goal: string;
	document: string;
	title?: string;
	target: HandoffTarget;
	sourceSessionId: string;
	sourceSessionFile: string;
}

export interface PersistedHandoff {
	cardId: string;
	handoffId: string;
	document: string;
}

export type GenerateHandoffPrompt = (
	input: HandoffGenerationInput,
	ctx: HandoffCommandContext,
) => Promise<HandoffGenerationResult>;

export type ResolveHandoffTarget = (
	input: ResolveHandoffTargetInput,
	ctx: HandoffCommandContext,
) => Promise<HandoffTarget>;

export type PersistHandoff = (
	input: PersistHandoffInput,
	ctx: HandoffCommandContext,
) => Promise<PersistedHandoff>;

export function createHandoffHandler(
	generate: GenerateHandoffPrompt,
	resolveTarget: ResolveHandoffTarget,
	persist: PersistHandoff,
) {
	return async (args: string, ctx: HandoffCommandContext): Promise<void> => {
		if (!ctx.hasUI) return;

		const goal = args.trim();
		if (!goal) {
			ctx.ui.notify("Usage: /handoff <goal for the continuation>", "warning");
			return;
		}
		if (!ctx.model) {
			ctx.ui.notify("No model selected", "error");
			return;
		}

		await ctx.waitForIdle();

		const sourceSessionFile = ctx.sessionManager.getSessionFile();
		if (!ctx.sessionManager.isPersisted() || !sourceSessionFile) {
			ctx.ui.notify("Handoff requires a persisted current session", "error");
			return;
		}

		const sourceSessionId = ctx.sessionManager.getSessionId();
		let target: HandoffTarget;
		try {
			target = await resolveTarget({ sourceSessionId, sourceSessionFile }, ctx);
		} catch (error) {
			ctx.ui.notify(`Handoff cannot start: ${error instanceof Error ? error.message : String(error)}`, "error");
			return;
		}

		const messages = ctx.sessionManager.buildSessionContext().messages;
		if (messages.length === 0) {
			ctx.ui.notify("No conversation to hand off", "warning");
			return;
		}

		let generation: HandoffGenerationResult;
		try {
			generation = await generate({ goal, messages, target }, ctx);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Handoff generation failed: ${message}`, "error");
			return;
		}

		if (generation.status === "cancelled") {
			ctx.ui.notify("Handoff cancelled", "info");
			return;
		}
		if (generation.status === "error") {
			ctx.ui.notify(`Handoff generation failed: ${generation.message}`, "error");
			return;
		}

		const destinationGeneration = target.kind === "new"
			? { title: generation.title ?? "", prompt: generation.prompt }
			: undefined;
		const editedPrompt = await ctx.ui.editor(
			target.kind === "new"
				? "Review destination title and handoff document (Esc to cancel)"
				: "Review handoff document (Esc to cancel)",
			destinationGeneration ? formatDestinationReview(destinationGeneration) : generation.prompt,
		);
		if (editedPrompt === undefined) {
			ctx.ui.notify("Handoff cancelled", "info");
			return;
		}

		const reviewed = target.kind === "new" ? parseDestinationReview(editedPrompt, goal) : undefined;
		const document = target.kind === "new" ? reviewed?.prompt ?? "" : editedPrompt.trim();
		if (!document) {
			ctx.ui.notify(
				target.kind === "new"
					? "Handoff cancelled: the reviewed destination title or document is invalid"
					: "Handoff cancelled: document is empty",
				"warning",
			);
			return;
		}

		let handoff: PersistedHandoff;
		try {
			handoff = await persist(
				{
					goal,
					document,
					title: reviewed?.title,
					target,
					sourceSessionId,
					sourceSessionFile,
				},
				ctx,
			);
		} catch (error) {
			ctx.ui.notify(`Handoff was not saved: ${error instanceof Error ? error.message : String(error)}`, "error");
			return;
		}

		const result = await ctx.newSession({
			parentSession: sourceSessionFile,
			setup: (sessionManager) => {
				sessionManager.appendCustomEntry(HANDOFF_SOURCE_ENTRY_TYPE, {
					sourceSessionFile,
					goal,
					createdAt: Date.now(),
					...(target.kind === "standalone"
						? {}
						: { workboard: { cardId: handoff.cardId, handoffId: handoff.handoffId } }),
				});
			},
			withSession: async (replacementCtx) => {
				await replacementCtx.sendUserMessage(handoff.document);
			},
		});
		if (result.cancelled) {
			ctx.ui.notify(
				target.kind === "standalone"
					? "New session creation cancelled. The reviewed handoff prompt was not saved anywhere and is lost."
					: `New session creation cancelled. Handoff ${handoff.handoffId.slice(0, 8)} remains saved on destination card ${handoff.cardId.slice(0, 8)}.`,
				"info",
			);
		}
	};
}
