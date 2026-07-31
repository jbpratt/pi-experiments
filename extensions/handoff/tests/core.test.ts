import assert from "node:assert/strict";
import test from "node:test";
import {
	buildHandoffRequest,
	extractTextContent,
	fallbackHandoffTitle,
	formatDestinationReview,
	parseDestinationReview,
	parseGeneratedHandoff,
} from "../core.ts";

test("builds a delimited handoff request and extracts response text", () => {
	assert.equal(
		buildHandoffRequest("User: current state", "finish the implementation"),
		[
			"<conversation_history>",
			"User: current state",
			"</conversation_history>",
			"",
			"<handoff_goal>",
			"finish the implementation",
			"</handoff_goal>",
		].join("\n"),
	);
	assert.equal(
		extractTextContent([
			{ type: "thinking", text: "hidden" },
			{ type: "text", text: " first " },
			{ type: "text", text: "second" },
		]),
		"first \nsecond",
	);
	assert.match(buildHandoffRequest("history", "implement destination handling", true), /destination_card_title_required/);
});

test("parses a generated destination title and safely falls back from invalid structured output", () => {
	assert.deepEqual(
		parseGeneratedHandoff('{"title":"Implement destination handoffs","prompt":"Continue the implementation."}', "rough intent"),
		{ title: "Implement destination handoffs", prompt: "Continue the implementation." },
	);
	assert.deepEqual(
		parseGeneratedHandoff('{"title":"Handoff","prompt":"Continue safely."}', "implement destination handling"),
		{ title: "implement destination handling", prompt: "Continue safely." },
	);
	assert.deepEqual(parseGeneratedHandoff("Continue from the reviewed state.", "handoff"), {
		title: fallbackHandoffTitle("handoff"),
		prompt: "Continue from the reviewed state.",
	});
	assert.notEqual(fallbackHandoffTitle("handoff").toLowerCase(), "handoff");
	assert.equal(fallbackHandoffTitle("x".repeat(200)).length, 120);
});

test("round-trips a destination review through format/parse", () => {
	const generation = { title: "Implement destination handoffs", prompt: "Generated continuation." };
	const formatted = formatDestinationReview(generation);
	assert.equal(formatted, "Destination title:\nImplement destination handoffs\n\nHandoff prompt:\nGenerated continuation.");
	assert.deepEqual(parseDestinationReview(formatted, "some goal"), generation);
	assert.equal(parseDestinationReview("not a review document", "some goal"), undefined);
	assert.equal(parseDestinationReview("Destination title:\nT\n\nHandoff prompt:\n   ", "some goal"), undefined);
});
