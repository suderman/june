// June's logger, data-directory lock, and harness settings. They came from pi-durable-telegram until June dropped it for
// Pi Durable 1.5; the behaviour is the same.
import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import type { HarnessSettings } from "@earendil-works/pi-durable";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Readonly<Record<string, unknown>>;
export interface Logger {
	debug(event: string, fields?: LogFields): void;
	info(event: string, fields?: LogFields): void;
	warn(event: string, fields?: LogFields): void;
	error(event: string, fields?: LogFields): void;
}
export type LogSink = (level: LogLevel, line: string) => void;

const rank = { debug: 10, info: 20, warn: 30, error: 40 };

/** Masks secrets in a line before it is logged: bot tokens, provider keys, authorization headers, secret fields. */
const SECRETS: readonly [RegExp, string][] = [
	[/bot\d{5,}:[A-Za-z0-9_-]{20,}/g, "bot<redacted>"],
	[/\b\d{5,}:[A-Za-z0-9_-]{30,}\b/g, "<redacted-bot-token>"],
	[/sk-ant-[A-Za-z0-9_-]{8,}/g, "sk-ant-<redacted>"],
	[/\bsk-[A-Za-z0-9_-]{16,}/g, "sk-<redacted>"],
	[/\b(Bearer|Token|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 <redacted>"],
	[/("?(?:access_token|refresh_token|api_key|apiKey|token|refresh|access|password|secret)"?\s*[:=]\s*"?)[^"\s,&}]{6,}/gi, "$1<redacted>"],
];
export const redact = (text: string) => SECRETS.reduce((result, [pattern, replacement]) => result.replace(pattern, replacement), text);

/** One line per event, `level event key=value ...`, redacted; warnings and errors go to stderr. */
export function createLogger(options: { level?: LogLevel; sink?: LogSink } = {}): Logger {
	const threshold = rank[options.level ?? "info"] ?? rank.info;
	const sink: LogSink = options.sink ?? ((level, line) => (level === "warn" || level === "error" ? process.stderr : process.stdout).write(`${line}\n`));
	const emit = (level: LogLevel) => (event: string, fields?: LogFields) => {
		if (rank[level] >= threshold) sink(level, redact(formatLine(level, event, fields)));
	};
	return { debug: emit("debug"), info: emit("info"), warn: emit("warn"), error: emit("error") };
}

export function formatLine(level: LogLevel, event: string, fields?: LogFields): string {
	const parts = [level, event];
	for (const [key, value] of Object.entries(fields ?? {})) if (value !== undefined) parts.push(`${key}=${formatValue(value)}`);
	return parts.join(" ");
}

function formatValue(value: unknown): string {
	if (typeof value === "string") return /^[\w./:@+-]+$/.test(value) ? value : JSON.stringify(value);
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	// The first line only: causes and stacks may carry URLs with secrets.
	if (value instanceof Error) return JSON.stringify(`${value.name}: ${value.message}`.split("\n")[0]!.slice(0, 300));
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return JSON.stringify(String(value));
	}
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

/** Harness settings. `contextCap` limits the context: blocking compaction starts at the cap, background compaction at most a
 * quarter below it, and a compaction keeps at most a third of it, so a compacted context stays under both thresholds. */
export function createSettings(options: { contextCap?: number; contextWindow?: number } = {}): HarnessSettings {
	const { contextCap: cap, contextWindow: window } = options;
	const capped = cap !== undefined && window !== undefined && cap < window;
	return {
		progress: { partialIntervalMs: 300, outputIntervalMs: 500 },
		...(capped ? { compaction: { reserveTokens: window - cap, keepRecentTokens: Math.min(20_000, Math.floor(cap / 3)), backgroundTokens: Math.min(32_768, Math.floor(cap / 4)) } } : {}),
	};
}

type LockOwner = { pid: number; host: string; startedAt: string; startTime?: string };

export class LockHeld extends Error {
	readonly owner: LockOwner | undefined;
	constructor(owner: LockOwner | undefined, reason: string) {
		super(reason);
		this.name = "LockHeld";
		this.owner = owner;
	}
}

/** Start time of `pid` in clock ticks since boot (field 22 of /proc/<pid>/stat), so a reused pid is not mistaken for the owner. */
function startTime(pid: number): string | undefined {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
	} catch {
		return undefined;
	}
}

/**
 * The single-owner lock of the state directory, `owner.lock`, created exclusively. A lock whose owner is dead, or whose pid now
 * belongs to another process, is taken over once under `owner.lock.takeover`, so two processes judging the same stale lock
 * cannot both win; a live owner, or one on another host or of another user, is refused with `LockHeld`.
 */
export function acquireDataDirLock(dir: string): { path: string; release(): void } {
	const path = join(dir, "owner.lock");
	const pid = process.pid;
	const start = startTime(pid);
	const owner: LockOwner = { pid, host: hostname(), startedAt: new Date().toISOString(), ...(start === undefined ? {} : { startTime: start }) };
	if (!tryCreate(path, owner)) {
		const marker = `${path}.takeover`;
		// A marker older than ten seconds was left by a process that crashed mid-takeover, which takes microseconds.
		if (!tryCreate(marker, owner) && !(ageMs(marker) > 10_000 && (unlinkQuiet(marker), tryCreate(marker, owner))))
			throw new LockHeld(readOwner(path), "another process is taking over the state directory lock");
		try {
			const reason = refusal(path);
			if (reason !== undefined) throw new LockHeld(readOwner(path), reason);
			unlinkQuiet(path);
			if (!tryCreate(path, owner)) throw new LockHeld(readOwner(path), "another process took the lock first");
		} finally {
			unlinkQuiet(marker);
		}
	}
	return { path, release: () => readOwner(path)?.pid === pid && unlinkQuiet(path) };
}

/** Why the existing lock must stand, or undefined when it is stale. */
function refusal(path: string): string | undefined {
	const owner = readOwner(path);
	if (owner === undefined) return ageMs(path) > 10_000 ? undefined : "the state directory lock is being written by another process";
	if (owner.host !== hostname()) return `the state directory is locked by pid ${owner.pid} on host ${owner.host}`;
	let alive: "alive" | "dead" | "other_user";
	try {
		process.kill(owner.pid, 0);
		alive = "alive";
	} catch (error) {
		alive = (error as NodeJS.ErrnoException).code === "EPERM" ? "other_user" : "dead";
	}
	const reused = owner.startTime !== undefined && startTime(owner.pid) !== undefined && startTime(owner.pid) !== owner.startTime;
	if (alive === "dead" || reused) return undefined;
	if (alive === "other_user") return `the state directory is used by pid ${owner.pid} of another user (since ${owner.startedAt})`;
	return `the state directory is used by pid ${owner.pid} (since ${owner.startedAt})`;
}

function tryCreate(path: string, owner: LockOwner): boolean {
	let fd: number;
	try {
		fd = openSync(path, "wx", 0o600);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw error;
	}
	try {
		writeSync(fd, `${JSON.stringify(owner)}\n`);
	} finally {
		closeSync(fd);
	}
	return true;
}

function readOwner(path: string): LockOwner | undefined {
	try {
		const value = JSON.parse(readFileSync(path, "utf8"));
		return typeof value.pid === "number" && typeof value.host === "string" ? value : undefined;
	} catch {
		return undefined;
	}
}

function ageMs(path: string): number {
	try {
		return Date.now() - statSync(path).mtimeMs;
	} catch {
		return Number.POSITIVE_INFINITY;
	}
}

function unlinkQuiet(path: string): void {
	try {
		unlinkSync(path);
	} catch {}
}
