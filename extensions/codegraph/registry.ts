// Private, user-only, on-disk registry of codegraph consent/index metadata.
// Never project-local and never committed. Stores only the
// `CodeGraphRegistryEntry` shape from types.ts: no credentials, tokens,
// query text, source snippets, or graph node/edge data. See scope.ts for the
// sibling module this mirrors in "no Pi API dependency" style.

import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { CodeGraphRegistryEntry } from "./types.ts";

const REGISTRY_SCHEMA_VERSION = 1;
const REGISTRY_FILE_NAME = "registry.json";

/**
 * Thrown by `update()` when no prior `recordConsent()` entry exists for the
 * given repository id.
 */
export class UnknownRepositoryError extends Error {
	constructor(repositoryId: string) {
		super(`No codegraph registry entry exists for repository id "${repositoryId}". Call recordConsent() first.`);
		this.name = "UnknownRepositoryError";
	}
}

interface RegistryFileShape {
	schemaVersion: 1;
	entries: Record<string, CodeGraphRegistryEntry>;
}

/**
 * Returns true when `value` is not a well-formed registry file shape (used
 * to distinguish "no file yet" and "valid empty registry" from corruption,
 * even though reads never throw for either case).
 */
export function isRegistryFileCorrupt(value: unknown): boolean {
	if (typeof value !== "object" || value === null) return true;
	const candidate = value as Partial<RegistryFileShape>;
	if (candidate.schemaVersion !== REGISTRY_SCHEMA_VERSION) return true;
	if (typeof candidate.entries !== "object" || candidate.entries === null || Array.isArray(candidate.entries)) return true;
	return false;
}

function emptyRegistry(): RegistryFileShape {
	return { schemaVersion: REGISTRY_SCHEMA_VERSION, entries: {} };
}

export interface CodeGraphRegistry {
	get(repositoryId: string): Promise<CodeGraphRegistryEntry | undefined>;
	recordConsent(entry: CodeGraphRegistryEntry): Promise<void>;
	update(repositoryId: string, patch: Partial<Pick<CodeGraphRegistryEntry, "lastGeneration" | "lastIndexedAt" | "state" | "codegraphVersion" | "extensionVersion">>): Promise<void>;
	list(): Promise<CodeGraphRegistryEntry[]>;
}

class FileRegistry implements CodeGraphRegistry {
	private readonly baseDir: string;
	private readonly filePath: string;

	constructor(baseDir: string) {
		this.baseDir = baseDir;
		this.filePath = join(baseDir, REGISTRY_FILE_NAME);
	}

	private async read(): Promise<RegistryFileShape> {
		let raw: string;
		try {
			raw = await readFile(this.filePath, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyRegistry();
			throw error;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return emptyRegistry();
		}
		if (isRegistryFileCorrupt(parsed)) return emptyRegistry();
		return parsed as RegistryFileShape;
	}

	private async writeAtomic(registryFile: RegistryFileShape): Promise<void> {
		await mkdir(this.baseDir, { recursive: true, mode: 0o700 });
		await chmod(this.baseDir, 0o700).catch(() => {});
		const tempPath = join(this.baseDir, `${REGISTRY_FILE_NAME}.tmp-${randomBytes(8).toString("hex")}`);
		await writeFile(tempPath, `${JSON.stringify(registryFile, null, "\t")}\n`, { mode: 0o600 });
		try {
			await rename(tempPath, this.filePath);
		} catch (error) {
			await rmSafe(tempPath);
			throw error;
		}
		await chmod(this.filePath, 0o600);
	}

	async get(repositoryId: string): Promise<CodeGraphRegistryEntry | undefined> {
		const registryFile = await this.read();
		return registryFile.entries[repositoryId];
	}

	async list(): Promise<CodeGraphRegistryEntry[]> {
		const registryFile = await this.read();
		return Object.values(registryFile.entries);
	}

	async recordConsent(entry: CodeGraphRegistryEntry): Promise<void> {
		const registryFile = await this.read();
		registryFile.entries[entry.repositoryId] = entry;
		await this.writeAtomic(registryFile);
	}

	async update(repositoryId: string, patch: Partial<Pick<CodeGraphRegistryEntry, "lastGeneration" | "lastIndexedAt" | "state" | "codegraphVersion" | "extensionVersion">>): Promise<void> {
		const registryFile = await this.read();
		const existing = registryFile.entries[repositoryId];
		if (!existing) throw new UnknownRepositoryError(repositoryId);
		registryFile.entries[repositoryId] = { ...existing, ...patch };
		await this.writeAtomic(registryFile);
	}
}

async function rmSafe(path: string): Promise<void> {
	try {
		await unlink(path);
	} catch {
		// Best-effort cleanup only; the caller already has a real error to throw.
	}
}

export function createFileRegistry(baseDir?: string): CodeGraphRegistry {
	const resolvedBaseDir = baseDir ?? join(homedir(), ".pi", "agent", "codegraph");
	return new FileRegistry(resolvedBaseDir);
}

// Re-exported for tests/diagnostics that want to confirm a directory exists
// without depending on internal FileRegistry details.
export async function registryFileExists(baseDir: string): Promise<boolean> {
	try {
		await stat(join(baseDir, REGISTRY_FILE_NAME));
		return true;
	} catch {
		return false;
	}
}
