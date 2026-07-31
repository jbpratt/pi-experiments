import { randomUUID } from "node:crypto";

/**
 * Minimal request/response-over-events transport this extension needs from
 * `pi.events`. Kept narrow (rather than importing the full `EventBus` type)
 * so this module only depends on the two methods it actually calls.
 */
export interface RequestEventBus {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: (data: unknown) => void): () => void;
}

/**
 * Request/response RPC over `pi.events` with a correlation id (a per-call
 * random reply channel) and a timeout. Emits `payload` plus a generated
 * `replyChannel` on `channel`, listens once on `replyChannel`, and resolves
 * with whatever the first responder sends back.
 *
 * Resolves `undefined` when nothing replies before `timeoutMs` elapses (no
 * responder registered, or a slow/broken one) so callers can treat "no
 * interop partner" as a normal, non-throwing outcome.
 */
export function requestOverEvents<TReq extends object, TRes>(
	events: RequestEventBus,
	channel: string,
	payload: TReq,
	timeoutMs = 400,
): Promise<TRes | undefined> {
	return new Promise((resolve) => {
		const replyChannel = `${channel}:reply:${randomUUID()}`;
		let settled = false;
		let unsubscribe: () => void = () => {};

		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			unsubscribe();
			resolve(undefined);
		}, timeoutMs);

		unsubscribe = events.on(replyChannel, (data) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			unsubscribe();
			resolve(data as TRes);
		});

		events.emit(channel, { ...payload, replyChannel });
	});
}
