// Exercises the real @colbymchenry/codegraph library through the real
// worker.ts child process (spawned exactly as production code spawns it).
// Uses only a tiny temp fixture and no network, so it runs by default rather
// than being environment-gated; only large-repository and remote-network
// tests are gated per the design doc.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CodeGraphWorkerPool } from "../worker-client.ts";

function makeFixture(): string {
	const root = mkdtempSync(join(tmpdir(), "codegraph-worker-it-"));
	mkdirSync(join(root, "src"), { recursive: true });
	writeFileSync(
		join(root, "src", "math.ts"),
		"export function add(a: number, b: number): number {\n  return a + b;\n}\n\nexport function double(x: number): number {\n  return add(x, x);\n}\n",
	);
	writeFileSync(
		join(root, "src", "main.ts"),
		"import { double } from \"./math\";\n\nexport function run(): number {\n  return double(21);\n}\n",
	);
	return root;
}

test("worker.ts indexes, searches, and traces a real fixture through the real library", { timeout: 60_000 }, async (t) => {
	const root = makeFixture();
	const pool = new CodeGraphWorkerPool({ maxWorkers: 1 });
	t.after(async () => {
		await pool.closeAll();
		rmSync(root, { recursive: true, force: true });
	});

	const openResult = (await pool.run(root, { type: "open", root })) as { initialized: boolean };
	assert.equal(openResult.initialized, false);

	const indexResult = (await pool.run(root, { type: "index_all" })) as { stats: { nodeCount: number } };
	assert.ok(indexResult.stats.nodeCount > 0);

	const searchResult = (await pool.run(root, { type: "search", query: "double", limit: 10 })) as Array<{ node: { id: string; name: string } }>;
	const doubleNode = searchResult.find((match) => match.node.name === "double")?.node;
	assert.ok(doubleNode, "expected to find the double() symbol");

	const symbolResult = (await pool.run(root, {
		type: "symbol",
		symbolId: doubleNode!.id,
		relation: "callees",
		depth: 1,
		limit: 10,
		includeSource: "bounded-body",
	})) as { node: { name: string }; related: Array<{ name: string }>; code?: string };
	assert.equal(symbolResult.node.name, "double");
	assert.ok(symbolResult.related.some((n) => n.name === "add"));
	assert.ok(symbolResult.code?.includes("return add(x, x)"));

	const addSearch = (await pool.run(root, { type: "search", query: "add", limit: 10 })) as Array<{ node: { id: string; name: string } }>;
	const addNode = addSearch.find((match) => match.node.name === "add")?.node;
	assert.ok(addNode);

	const traceResult = (await pool.run(root, {
		type: "trace",
		mode: "shortest_path",
		fromSymbolId: doubleNode!.id,
		toSymbolId: addNode!.id,
		depth: 3,
		limit: 10,
	})) as { pathFound: boolean; nodes: Array<{ name: string }> };
	assert.equal(traceResult.pathFound, true);
	assert.deepEqual(traceResult.nodes.map((n) => n.name), ["double", "add"]);

	const ambiguousResult = (await pool.run(root, {
		type: "symbol",
		name: "zzz_does_not_exist",
		relation: "definition",
		depth: 1,
		limit: 10,
		includeSource: "none",
	})) as { candidates: unknown[] };
	assert.deepEqual(ambiguousResult.candidates, []);

	writeFileSync(join(root, "src", "math.ts"), "export function add(a: number, b: number): number {\n  return a + b;\n}\n\nexport function triple(x: number): number {\n  return add(add(x, x), x);\n}\n");
	const changed = (await pool.run(root, { type: "changed_files" })) as { modified: string[] };
	assert.deepEqual(changed.modified, ["src/math.ts"]);

	const syncResult = (await pool.run(root, { type: "sync" })) as { filesModified: number };
	assert.equal(syncResult.filesModified, 1);

	await pool.run(root, { type: "close" });
});
