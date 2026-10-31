// Client/daemon protocol: one JSON object per line over a Unix socket. Conversation updates are Pi Durable's own
// agent events (`watchEvents`), passed through unchanged after a trimmed snapshot.
import { connect, type Socket } from "node:net";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { AgentEvent, SnapshotEvent } from "@earendil-works/pi-durable";

export type Source = "kitty" | "cli" | "follow";

/** Terminal commands. All except /reload match pi-durable-telegram's bot menu. */
export const COMMANDS = [
	{ name: "new", description: "Start a fresh context (history is kept)" },
	{ name: "stop", description: "Stop the current run; queued messages continue" },
	{ name: "compact", description: "Compact the context, optionally with instructions" },
	{ name: "status", description: "Model, context, spend and queue" },
	{ name: "reload", description: "Reload prompt files and skills; keep the chat" },
	{ name: "help", description: "What this bot does" },
] as const;

/** `/name args` when `text` is one of the commands; undefined for ordinary text. */
export function parseCommand(text: string): { name: string; args: string } | undefined {
	const match = /^\/([a-z]+)(?:@\S+)?(?:\s+([\s\S]*))?$/.exec(text.trim());
	if (match === null || !COMMANDS.some((c) => c.name === match[1])) return undefined;
	return { name: match[1]!, args: (match[2] ?? "").trim() };
}

export type Request =
	| { op: "status"; requestId: string }
	| { op: "attach"; requestId: string }
	/** Entries without a stream: those since `since` (epoch ms), the newest `limit` of them. */
	| { op: "history"; requestId: string; since?: number; limit?: number }
	| { op: "submit"; requestId: string; text: string; images?: ImageContent[]; source: Source; whenBusy?: "steer" | "followUp"; wait?: boolean }
	| { op: "command"; requestId: string; name: string; args?: string };

export type Status = {
	ok: true;
	pid: number;
	startedAt: string;
	version: string;
	conversation: number;
	model: string;
	thinkingLevel: string;
	busy: boolean;
	/** Briefs running in June's working context in the background. */
	background: number;
	queued: number;
	entries: number;
	telegram: "off" | "polling" | "failed";
	tools: string[];
	/** The directory the daemon's code runs from: a checkout or the Nix store. */
	source: string;
};

export type Reply =
	| { type: "status"; requestId: string; status: Status }
	| { type: "snapshot"; requestId: string; snapshot: SnapshotEvent; omitted: number }
	| { type: "history"; requestId: string; entries: SnapshotEvent["entries"]; omitted: number }
	| { type: "events"; events: readonly AgentEvent[] }
	| { type: "accepted"; requestId: string; submissionId: number }
	| { type: "settled"; requestId: string; status: "done" | "unanswered"; text?: string; reason?: string }
	| { type: "reply"; requestId: string; text: string }
	| { type: "error"; requestId?: string; message: string };

/** Split a stream into JSON lines; malformed lines go to `onBad`. */
export function readLines(socket: Socket, onMessage: (value: unknown) => void, onBad?: (line: string) => void): void {
	let buffer = "";
	socket.setEncoding("utf8");
	socket.on("data", (chunk: string) => {
		buffer += chunk;
		let newline: number;
		while ((newline = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			if (line.trim() === "") continue;
			try {
				onMessage(JSON.parse(line));
			} catch {
				onBad?.(line);
			}
		}
	});
}

export function writeLine(socket: Socket, value: unknown): void {
	if (!socket.destroyed) socket.write(`${JSON.stringify(value)}\n`);
}

export class DaemonUnavailable extends Error {
	constructor(socketPath: string, cause: unknown) {
		super(`June is not running (no daemon at ${socketPath}): ${(cause as Error).message}`);
		this.name = "DaemonUnavailable";
	}
}

/** A connection to the daemon. `request` resolves with the first reply carrying its request id. */
export class Client {
	readonly #socket: Socket;
	readonly #pending = new Map<string, (reply: Reply) => void>();
	readonly #listeners = new Set<(reply: Reply) => void>();
	readonly closed: Promise<void>;

	private constructor(socket: Socket) {
		this.#socket = socket;
		readLines(socket, (value) => {
			const reply = value as Reply;
			const id = "requestId" in reply ? reply.requestId : undefined;
			const waiter = id === undefined ? undefined : this.#pending.get(id);
			if (waiter !== undefined && reply.type !== "settled") {
				this.#pending.delete(id!);
				waiter(reply);
			}
			for (const listener of this.#listeners) listener(reply);
		});
		this.closed = new Promise((resolve) => socket.once("close", () => resolve()));
	}

	static open(socketPath: string, timeoutMs = 3000): Promise<Client> {
		return new Promise((resolve, reject) => {
			const socket = connect(socketPath);
			const timer = setTimeout(() => socket.destroy(new Error("connection timed out")), timeoutMs);
			socket.once("connect", () => {
				clearTimeout(timer);
				resolve(new Client(socket));
			});
			socket.once("error", (error) => {
				clearTimeout(timer);
				reject(new DaemonUnavailable(socketPath, error));
			});
		});
	}

	on(listener: (reply: Reply) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	request(request: Request): Promise<Reply> {
		return new Promise((resolve, reject) => {
			this.#pending.set(request.requestId, resolve);
			void this.closed.then(() => reject(new Error("June closed the connection")));
			writeLine(this.#socket, request);
		});
	}

	close(): void {
		this.#socket.end();
	}
}
