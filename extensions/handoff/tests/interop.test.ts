import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { requestOverEvents } from "../interop.ts";

function fakeEventBus(): { on: (channel: string, handler: (data: unknown) => void) => () => void; emit: (channel: string, data: unknown) => void } {
	const emitter = new EventEmitter();
	return {
		on: (channel, handler) => {
			emitter.on(channel, handler);
			return () => emitter.off(channel, handler);
		},
		emit: (channel, data) => {
			emitter.emit(channel, data);
		},
	};
}

test("requestOverEvents resolves with the responder's reply on its own reply channel", async () => {
	const bus = fakeEventBus();
	const requests: unknown[] = [];
	bus.on("ping", (data) => {
		requests.push(data);
		const { replyChannel } = data as { replyChannel: string };
		bus.emit(replyChannel, { pong: true });
	});

	const result = await requestOverEvents(bus, "ping", { hello: "world" });

	assert.deepEqual(result, { pong: true });
	assert.equal(requests.length, 1);
	const request = requests[0] as { hello: string; replyChannel: string };
	assert.equal(request.hello, "world");
	assert.match(request.replyChannel, /^ping:reply:/);
});

test("requestOverEvents resolves undefined on timeout when nobody listens", async () => {
	const bus = fakeEventBus();

	const result = await requestOverEvents(bus, "nobody-home", { anything: 1 }, 20);

	assert.equal(result, undefined);
});

test("requestOverEvents ignores a late reply that arrives after timeout", async () => {
	const bus = fakeEventBus();
	let capturedReplyChannel: string | undefined;
	bus.on("slow", (data) => {
		capturedReplyChannel = (data as { replyChannel: string }).replyChannel;
	});

	const result = await requestOverEvents(bus, "slow", {}, 10);
	assert.equal(result, undefined);

	// A reply that shows up after the timeout must not throw or resolve anything further.
	assert.ok(capturedReplyChannel);
	bus.emit(capturedReplyChannel!, { tooLate: true });
});

test("requestOverEvents uses a fresh reply channel per call so concurrent requests do not cross-talk", async () => {
	const bus = fakeEventBus();
	const seen: string[] = [];
	bus.on("echo", (data) => {
		const { replyChannel, value } = data as { replyChannel: string; value: string };
		seen.push(replyChannel);
		bus.emit(replyChannel, { value });
	});

	const [a, b] = await Promise.all([
		requestOverEvents<{ value: string }, { value: string }>(bus, "echo", { value: "a" }),
		requestOverEvents<{ value: string }, { value: string }>(bus, "echo", { value: "b" }),
	]);

	assert.deepEqual(a, { value: "a" });
	assert.deepEqual(b, { value: "b" });
	assert.equal(new Set(seen).size, 2);
});
