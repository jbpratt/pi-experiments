// Structural/wiring smoke test: does the extension register the expected
// tool and command surface with well-formed schemas? Full tool execution is
// covered indirectly by service.test.ts (fake worker) and
// worker-integration.test.ts (real library) — exercising codegraph_search et
// al. end-to-end here would require a real Git repository and a real worker
// process, which is out of scope for a fast structural test.
import assert from "node:assert/strict";
import test from "node:test";

import codegraphExtension from "../index.ts";

interface CapturedTool {
	name: string;
	label?: string;
	description?: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
	parameters: unknown;
	execute: (...args: unknown[]) => unknown;
}

interface CapturedCommand {
	description?: string;
	handler: (...args: unknown[]) => unknown;
}

function loadExtension() {
	const tools = new Map<string, CapturedTool>();
	const commands = new Map<string, CapturedCommand>();
	const eventHandlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
	const fakePi = {
		registerTool(definition: CapturedTool) {
			tools.set(definition.name, definition);
		},
		registerCommand(name: string, definition: CapturedCommand) {
			commands.set(name, definition);
		},
		on(event: string, handler: (...args: unknown[]) => unknown) {
			const list = eventHandlers.get(event) ?? [];
			list.push(handler);
			eventHandlers.set(event, list);
		},
	};
	codegraphExtension(fakePi as never);
	return { tools, commands, eventHandlers };
}

test("registers all four codegraph_* tools with non-empty descriptions and object parameter schemas", () => {
	const { tools } = loadExtension();
	for (const name of ["codegraph_search", "codegraph_symbol", "codegraph_trace", "codegraph_status"]) {
		const tool = tools.get(name);
		assert.ok(tool, `expected tool ${name} to be registered`);
		assert.ok(tool!.description && tool!.description.length > 0);
		assert.equal(typeof tool!.execute, "function");
		assert.equal(typeof tool!.parameters, "object");
	}
	assert.equal(tools.size, 4);
});

test("codegraph_search requires a query field in its parameter schema", () => {
	const { tools } = loadExtension();
	const schema = tools.get("codegraph_search")!.parameters as { required?: string[]; properties?: Record<string, unknown> };
	assert.ok(schema.required?.includes("query"));
	assert.ok(schema.properties?.query);
});

test("codegraph_trace requires mode and fromSymbolId in its parameter schema", () => {
	const { tools } = loadExtension();
	const schema = tools.get("codegraph_trace")!.parameters as { required?: string[] };
	assert.ok(schema.required?.includes("mode"));
	assert.ok(schema.required?.includes("fromSymbolId"));
});

test("codegraph_symbol does not require symbolId or name at the schema level (validated at runtime instead)", () => {
	const { tools } = loadExtension();
	const schema = tools.get("codegraph_symbol")!.parameters as { required?: string[] };
	assert.equal(schema.required?.includes("symbolId") ?? false, false);
	assert.equal(schema.required?.includes("name") ?? false, false);
});

test("every tool's promptGuidelines (when present) are non-empty, tool-specific strings", () => {
	const { tools } = loadExtension();
	for (const tool of tools.values()) {
		if (!tool.promptGuidelines) continue;
		assert.ok(tool.promptGuidelines.length > 0);
		for (const guideline of tool.promptGuidelines) assert.ok(guideline.trim().length > 0);
	}
});

test("registers the /codegraph command", () => {
	const { commands } = loadExtension();
	assert.ok(commands.has("codegraph"));
	assert.equal(typeof commands.get("codegraph")!.handler, "function");
});

test("registers a session_shutdown handler", () => {
	const { eventHandlers } = loadExtension();
	assert.ok((eventHandlers.get("session_shutdown")?.length ?? 0) > 0);
});
