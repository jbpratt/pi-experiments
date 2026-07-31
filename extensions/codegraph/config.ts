// Global and (optionally) trusted-project configuration loading. Pure and
// Pi-API-free: index.ts resolves the exact paths and trust flag and passes
// them in here.
//
// Trusted project configuration may only ever narrow behavior: lower numeric
// limits, or add extra exclusions. It can never raise a limit above the
// global/default value, weaken confirmation, or touch anything not listed
// below.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG, type CodeGraphConfig } from "./types.ts";

const NARROWABLE_NUMERIC_KEYS = ["maxResults", "maxDepth", "maxSnippetLines", "maxResultBytes", "indexTimeoutMs", "syncTimeoutMs"] as const;

type NarrowableKey = (typeof NARROWABLE_NUMERIC_KEYS)[number];

export function defaultGlobalConfigPath(): string {
	return join(homedir(), ".pi", "agent", "codegraph.json");
}

export function defaultProjectConfigPath(cwd: string): string {
	return join(cwd, ".pi", "codegraph.json");
}

function readJsonFile(path: string): Record<string, unknown> | undefined {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
	try {
		const parsed = JSON.parse(text);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

function isPositiveFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** Applies a fully-trusted config layer (global scope): any valid field may set any value. */
function applyGlobalLayer(base: CodeGraphConfig, raw: Record<string, unknown> | undefined): CodeGraphConfig {
	if (!raw) return base;
	const next: CodeGraphConfig = { ...base };
	if (isPositiveFiniteNumber(raw.maxWorkers)) next.maxWorkers = Math.floor(raw.maxWorkers);
	for (const key of NARROWABLE_NUMERIC_KEYS) {
		if (isPositiveFiniteNumber(raw[key])) next[key] = raw[key] as number;
	}
	if (isStringArray(raw.exclude)) next.exclude = [...raw.exclude];
	return next;
}

/** Applies a trusted-project config layer: numeric limits may only shrink; excludes may only grow. */
function applyProjectLayer(base: CodeGraphConfig, raw: Record<string, unknown> | undefined): CodeGraphConfig {
	if (!raw) return base;
	const next: CodeGraphConfig = { ...base };
	for (const key of NARROWABLE_NUMERIC_KEYS) {
		const candidate = raw[key as NarrowableKey];
		if (isPositiveFiniteNumber(candidate) && candidate < next[key]) next[key] = candidate;
	}
	if (isStringArray(raw.exclude)) {
		next.exclude = [...new Set([...next.exclude, ...raw.exclude])];
	}
	// maxWorkers is intentionally not project-overridable: it bounds process
	// resource usage for the whole Pi session, not one repository.
	return next;
}

export interface ConfigSources {
	/** Defaults to `~/.pi/agent/codegraph.json`. */
	globalConfigPath?: string;
	/** Defaults to `<cwd>/.pi/codegraph.json`; only read when `projectTrusted` is true. */
	projectConfigPath?: string;
	projectTrusted: boolean;
}

export function loadConfig(sources: ConfigSources): CodeGraphConfig {
	const globalPath = sources.globalConfigPath ?? defaultGlobalConfigPath();
	let config = applyGlobalLayer(DEFAULT_CONFIG, readJsonFile(globalPath));
	if (sources.projectTrusted && sources.projectConfigPath) {
		config = applyProjectLayer(config, readJsonFile(sources.projectConfigPath));
	}
	return config;
}
