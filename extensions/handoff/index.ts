import { randomUUID } from "node:crypto";
import type { Message } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { BorderedLoader, convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import {
	buildHandoffRequest,
	errorMessage,
	extractTextContent,
	HANDOFF_SYSTEM_PROMPT,
	parseGeneratedHandoff,
} from "./core.ts";
import { requestOverEvents, type RequestEventBus } from "./interop.ts";
import {
	createHandoffHandler,
	type GenerateHandoffPrompt,
	type HandoffGenerationResult,
	type HandoffTarget,
	type PersistHandoff,
	type ResolveHandoffTarget,
} from "./workflow.ts";

/**
 * Request/response channel used to ask an optional external system (for
 * example a task-tracking extension) whether the current session should
 * hand off to an already-attached destination, a brand-new one, or neither.
 *
 * Request payload:  { sourceSessionId, sourceSessionFile, replyChannel }
 * Reply payload:    { kind: "attached"; cardId: string } | { kind: "new" } | { kind: "none" }
 *
 * No listener, a `{kind:"none"}` reply, or a timeout are all treated the same
 * way: the handoff proceeds standalone (see workflow.ts's `HandoffTarget`).
 */
export const HANDOFF_RESOLVE_TARGET_CHANNEL = "pi-handoff:workboard:resolve-target:v1";

/**
 * Request/response channel used to ask that same optional external system to
 * durably persist a reviewed handoff document once a destination ("attached"
 * or "new") was confirmed via HANDOFF_RESOLVE_TARGET_CHANNEL.
 *
 * Request payload:  { goal, document, title?, target, sourceSessionId, sourceSessionFile, replyChannel }
 * Reply payload:    { ok: true; cardId: string; handoffId: string } | { ok: false; reason: string }
 *
 * Only called when a responder already confirmed a destination exists; a
 * missing responder or timeout at *this* step fails the handoff closed
 * (see persistHandoff below) rather than silently downgrading to standalone,
 * since that could create a destination with no matching handoff record.
 */
export const HANDOFF_PERSIST_CHANNEL = "pi-handoff:workboard:persist:v1";

interface ResolveTargetRequestPayload {
	sourceSessionId: string;
	sourceSessionFile: string;
}

type ResolveTargetResponsePayload = { kind: "attached"; cardId: string } | { kind: "new" } | { kind: "none" };

interface PersistRequestPayload {
	goal: string;
	document: string;
	title?: string;
	target: HandoffTarget;
	sourceSessionId: string;
	sourceSessionFile: string;
}

type PersistResponsePayload = { ok: true; cardId: string; handoffId: string } | { ok: false; reason: string };

export async function generatePrompt(
	ctx: ExtensionCommandContext,
	goal: string,
	messages: unknown[],
	destinationCardTitleRequired: boolean,
	signal?: AbortSignal,
): Promise<HandoffGenerationResult> {
	const model = ctx.model;
	if (!model) return { status: "error", message: "No model selected" };

	const conversation = serializeConversation(convertToLlm(messages as Parameters<typeof convertToLlm>[0]));
	if (!conversation.trim()) {
		return { status: "error", message: "No model-visible conversation content found" };
	}

	// Route through the registered (possibly extension-provided) Provider rather than
	// pi-ai's low-level api-provider registry: custom providers such as anthropic-vertex
	// register a `streamSimple` directly with the extension composer and are never added
	// to that global registry, so calling it directly fails with "No API provider
	// registered for api: <api>" even though normal chat works fine for the same model.
	const provider = ctx.modelRegistry.getProvider(model.provider);
	if (!provider) return { status: "error", message: `No provider registered for "${model.provider}"` };

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) return { status: "error", message: auth.error };

	const userMessage: Message = {
		role: "user",
		content: [{ type: "text", text: buildHandoffRequest(conversation, goal, destinationCardTitleRequired) }],
		timestamp: Date.now(),
	};
	const response = await provider
		.streamSimple(
			model,
			{ systemPrompt: HANDOFF_SYSTEM_PROMPT, messages: [userMessage] },
			{ apiKey: auth.apiKey, headers: auth.headers, env: auth.env, signal },
		)
		.result();

	if (response.stopReason === "aborted" || signal?.aborted) return { status: "cancelled" };
	if (response.stopReason === "error") {
		return { status: "error", message: response.errorMessage ?? "Model request failed" };
	}

	const content = extractTextContent(response.content);
	if (!content) return { status: "error", message: "The model returned an empty handoff prompt" };
	if (!destinationCardTitleRequired) return { status: "completed", prompt: content };
	const generated = parseGeneratedHandoff(content, goal);
	return generated.prompt
		? { status: "completed", ...generated }
		: { status: "error", message: "The model returned an empty handoff prompt" };
}

const generateHandoffPrompt: GenerateHandoffPrompt = async (input, workflowCtx) => {
	const ctx = workflowCtx as ExtensionCommandContext;
	if (ctx.mode !== "tui") {
		ctx.ui.notify("Generating handoff prompt...", "info");
		try {
			return await generatePrompt(ctx, input.goal, input.messages, input.target.kind === "new");
		} catch (error) {
			return { status: "error", message: errorMessage(error) };
		}
	}

	const result = await ctx.ui.custom<HandoffGenerationResult>((tui, theme, _keybindings, done) => {
		const loader = new BorderedLoader(tui, theme, `Generating handoff with ${ctx.model!.id}...`);
		let finished = false;
		const finish = (value: HandoffGenerationResult) => {
			if (finished) return;
			finished = true;
			done(value);
		};

		loader.onAbort = () => finish({ status: "cancelled" });
		void generatePrompt(ctx, input.goal, input.messages, input.target.kind === "new", loader.signal)
			.then(finish)
			.catch((error) => finish({ status: "error", message: errorMessage(error) }));
		return loader;
	});

	return result ?? { status: "cancelled" };
};

/**
 * Persist a reviewed handoff prompt and start its continuation session.
 *
 * Standalone by default: with no other extension listening on the interop
 * channels below, `/handoff <goal>` just generates and reviews a continuation
 * prompt and starts a fresh session with it — nothing is persisted outside
 * the session itself. A separate task-tracking extension can opt into owning
 * destinations (an attached or brand-new card) by responding on
 * `HANDOFF_RESOLVE_TARGET_CHANNEL` and `HANDOFF_PERSIST_CHANNEL`; see the
 * constants above and this package's README for the exact contract.
 */
/**
 * Factored out from the extension factory so tests can exercise
 * resolveHandoffTarget's interop behavior directly against a fake event bus,
 * without also standing up a full model/UI-capable command context.
 */
export function createResolveHandoffTarget(events: RequestEventBus): ResolveHandoffTarget {
	return async (input) => {
		const response = await requestOverEvents<ResolveTargetRequestPayload, ResolveTargetResponsePayload>(
			events,
			HANDOFF_RESOLVE_TARGET_CHANNEL,
			{ sourceSessionId: input.sourceSessionId, sourceSessionFile: input.sourceSessionFile },
		);
		if (response?.kind === "attached") return { kind: "attached", cardId: response.cardId };
		if (response?.kind === "new") return { kind: "new" };
		return { kind: "standalone" };
	};
}

/**
 * Factored out from the extension factory for the same reason as
 * createResolveHandoffTarget above.
 */
export function createPersistHandoff(events: RequestEventBus): PersistHandoff {
	return async (input) => {
		if (input.target.kind === "standalone") {
			// No responder confirmed a destination: nothing to persist externally.
			// Synthesize local ids purely for the "handoff saved" notification text.
			return { cardId: randomUUID(), handoffId: randomUUID(), document: input.document };
		}

		const response = await requestOverEvents<PersistRequestPayload, PersistResponsePayload>(
			events,
			HANDOFF_PERSIST_CHANNEL,
			{
				goal: input.goal,
				document: input.document,
				title: input.title,
				target: input.target,
				sourceSessionId: input.sourceSessionId,
				sourceSessionFile: input.sourceSessionFile,
			},
		);
		// A responder already confirmed a destination exists via resolveHandoffTarget.
		// Fail closed here rather than falling back to standalone: silently doing so
		// would leave that destination with no matching handoff record.
		if (!response) throw new Error("no interop responder confirmed the handoff persistence request");
		if (!response.ok) throw new Error(response.reason);
		return { cardId: response.cardId, handoffId: response.handoffId, document: input.document };
	};
}

export default function handoff(pi: ExtensionAPI) {
	const resolveHandoffTarget = createResolveHandoffTarget(pi.events);
	const persistHandoff = createPersistHandoff(pi.events);

	pi.registerCommand("handoff", {
		description: "Generate a reviewed continuation prompt and start a new session with it (optionally persisted by another extension via the interop channels)",
		handler: createHandoffHandler(generateHandoffPrompt, resolveHandoffTarget, persistHandoff),
	});
}
