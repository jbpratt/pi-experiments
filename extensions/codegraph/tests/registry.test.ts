import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { UnknownRepositoryError, createFileRegistry } from "../registry.ts";
import type { CodeGraphRegistryEntry } from "../types.ts";

function tmpBaseDir(): string {
	return mkdtempSync(join(tmpdir(), "pi-codegraph-registry-"));
}

function makeEntry(overrides: Partial<CodeGraphRegistryEntry> = {}): CodeGraphRegistryEntry {
	return {
		schemaVersion: 1,
		repositoryId: "repo-1",
		source: "local",
		worktreeRoot: "/repo/one",
		consentAt: 1_700_000_000_000,
		lastGeneration: null,
		lastIndexedAt: null,
		codegraphVersion: "1.5.0",
		extensionVersion: "0.1.0",
		state: "incomplete",
		...overrides,
	};
}

function isPosixPermissionTestable(): boolean {
	return process.platform !== "win32";
}

test("get/list return undefined/empty without creating anything when no file exists", async (t) => {
	const baseDir = tmpBaseDir();
	t.after(() => rmSync(baseDir, { recursive: true, force: true }));
	const registry = createFileRegistry(baseDir);

	assert.equal(await registry.get("repo-1"), undefined);
	assert.deepEqual(await registry.list(), []);
	assert.deepEqual(readdirSync(baseDir), []);
});

test("recordConsent then get round-trips the exact entry", async (t) => {
	const baseDir = tmpBaseDir();
	t.after(() => rmSync(baseDir, { recursive: true, force: true }));
	const registry = createFileRegistry(baseDir);
	const entry = makeEntry();

	await registry.recordConsent(entry);
	const fetched = await registry.get("repo-1");

	assert.deepEqual(fetched, entry);
});

test("update after recordConsent merges only the patched fields", async (t) => {
	const baseDir = tmpBaseDir();
	t.after(() => rmSync(baseDir, { recursive: true, force: true }));
	const registry = createFileRegistry(baseDir);
	const entry = makeEntry();
	await registry.recordConsent(entry);

	await registry.update("repo-1", { state: "ready", lastGeneration: "42" });
	const fetched = await registry.get("repo-1");

	assert.equal(fetched?.state, "ready");
	assert.equal(fetched?.lastGeneration, "42");
	assert.equal(fetched?.repositoryId, entry.repositoryId);
	assert.equal(fetched?.worktreeRoot, entry.worktreeRoot);
	assert.equal(fetched?.consentAt, entry.consentAt);
	assert.equal(fetched?.codegraphVersion, entry.codegraphVersion);
	assert.equal(fetched?.lastIndexedAt, entry.lastIndexedAt);
});

test("update without prior recordConsent rejects with UnknownRepositoryError", async (t) => {
	const baseDir = tmpBaseDir();
	t.after(() => rmSync(baseDir, { recursive: true, force: true }));
	const registry = createFileRegistry(baseDir);

	await assert.rejects(() => registry.update("missing-repo", { state: "ready" }), UnknownRepositoryError);
});

test("after a write, the registry file is 0o600 and its parent directory is 0o700", async (t) => {
	const baseDir = tmpBaseDir();
	t.after(() => rmSync(baseDir, { recursive: true, force: true }));
	const registry = createFileRegistry(baseDir);
	await registry.recordConsent(makeEntry());

	if (!isPosixPermissionTestable()) return;

	const filePath = join(baseDir, "registry.json");
	const fileMode = statSync(filePath).mode & 0o777;
	const dirMode = statSync(baseDir).mode & 0o777;
	assert.equal(fileMode, 0o600);
	assert.equal(dirMode, 0o700);
});

test("writing does not leave a stray temp file behind", async (t) => {
	const baseDir = tmpBaseDir();
	t.after(() => rmSync(baseDir, { recursive: true, force: true }));
	const registry = createFileRegistry(baseDir);
	await registry.recordConsent(makeEntry());
	await registry.update("repo-1", { state: "ready" });

	const entries = readdirSync(baseDir);
	assert.deepEqual(entries, ["registry.json"]);
});

test("a corrupt registry file is treated as empty by get/list rather than throwing", async (t) => {
	const baseDir = tmpBaseDir();
	t.after(() => rmSync(baseDir, { recursive: true, force: true }));
	writeFileSync(join(baseDir, "registry.json"), "{ not valid json", "utf8");
	const registry = createFileRegistry(baseDir);

	assert.equal(await registry.get("repo-1"), undefined);
	assert.deepEqual(await registry.list(), []);
});

test("two entries recorded under different repositoryIds both round-trip independently", async (t) => {
	const baseDir = tmpBaseDir();
	t.after(() => rmSync(baseDir, { recursive: true, force: true }));
	const registry = createFileRegistry(baseDir);
	const entryOne = makeEntry({ repositoryId: "repo-1", worktreeRoot: "/repo/one" });
	const entryTwo = makeEntry({ repositoryId: "repo-2", worktreeRoot: "/repo/two" });

	await registry.recordConsent(entryOne);
	await registry.recordConsent(entryTwo);

	const listed = await registry.list();
	assert.equal(listed.length, 2);
	assert.deepEqual(
		listed.find((entry) => entry.repositoryId === "repo-1"),
		entryOne,
	);
	assert.deepEqual(
		listed.find((entry) => entry.repositoryId === "repo-2"),
		entryTwo,
	);
});
