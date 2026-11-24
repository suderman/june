// Terminal streams: a paired client watching and typing into an agent's herdr-core terminal through the daemon (see
// "Terminal streams" in docs/architecture.org). The daemon only relays: for each stream it starts `hc connect` (or
// `ssh HOST hc connect` for a host this core has not added), attaches to one terminal the agents board lists, and maps
// the client's WebSocket frames onto the attach channel's frames. It never parses terminal output, never starts, resumes
// or kills a program, and offers no other hc method.
import { type ChildProcess, spawn } from "node:child_process";
import type { AgentSummary } from "./tools/herdr.ts";
import type { Logger } from "./runtime.ts";

/** herdr-core frame kinds (schema/README.md, "Framed mode"). */
const DATA = 0;
const CREDIT = 1;
const CLOSE = 2;
const RESIZE = 3;
const FOCUS = 4;
const FACTS = 5;
const AUTOMATIC_INPUT = 6;
const MAX_FRAME = 16 * 1024 * 1024;

export const NOT_FOUND = 4404;
export const UNAVAILABLE = 4409;
export const TOO_MANY = 4429;

/** What remote.ts hands a terminal stream: a way to talk to its client. */
export type TerminalSocket = {
	text(value: unknown): void;
	binary(data: Buffer): void;
	end(code: number, reason: string): void;
};

export type TerminalStream = { message(data: Buffer, binary: boolean): void; close(): void };

export type TerminalOptions = {
	readonly log: Logger;
	/** This host, as herdr: links and the boards name it. */
	readonly host: string;
	/** Hosts reached over SSH when hc has not added them: host -> ssh target. */
	readonly ssh: Record<string, string | undefined>;
	/** The agents the boards list on HOST. */
	readonly agents: (host: string) => Promise<AgentSummary[]>;
	/** Whether this core has HOST added as a machine. */
	readonly native: (host: string) => Promise<boolean>;
	/** Tests replace hc. */
	readonly spawn?: (argv: string[]) => ChildProcess;
};

const LINK = /^herdr:([a-z0-9-]+)\/([a-z]+):([0-9a-f-]{36})(?:@[A-Za-z0-9:]+)?$/;
const ADDRESS = /^t[0-9a-z]{1,8}$/;
const size = (n: unknown) => (typeof n === "number" && Number.isInteger(n) && n > 0 && n <= 1000 ? n : undefined);

/** Find the agent a hello names, by host and terminal or by a herdr: link's session; a reason when it is not allowed. */
export async function findAgent(hello: Record<string, unknown>, options: TerminalOptions): Promise<AgentSummary | string> {
	let host: string;
	let terminal: string | undefined;
	let session: string | undefined;
	if (typeof hello.link === "string") {
		const m = LINK.exec(hello.link);
		if (!m) return "not a session link";
		host = m[1]!;
		session = m[3]!;
	} else if (typeof hello.host === "string" && typeof hello.terminal === "string" && ADDRESS.test(hello.terminal)) {
		host = hello.host;
		terminal = hello.terminal;
	} else return "no terminal named";
	if (host !== options.host && !(host in options.ssh) && !(await options.native(host))) return "unknown host";
	const agents = await options.agents(host);
	const found = agents.find((a) => (session !== undefined ? a.session === session : a.terminal === terminal));
	if (found === undefined) return session !== undefined ? "not running" : "not an agent terminal";
	return found;
}

/** Open a stream for a client that said HELLO; returns at once, attaching in the background. */
export function openTerminal(hello: Record<string, unknown>, device: string, socket: TerminalSocket, options: TerminalOptions): TerminalStream {
	const { log } = options;
	let child: ChildProcess | undefined;
	let channel: number | undefined;
	let auto = false;
	let done = false;
	let buffer = Buffer.alloc(0);
	let where = "";
	const pending: Buffer[] = [];

	const frame = (ch: number, kind: number, payload: Buffer = Buffer.alloc(0)) => {
		const head = Buffer.alloc(9);
		head.writeUInt32LE(ch, 0);
		head.writeUInt8(kind, 4);
		head.writeUInt32LE(payload.length, 5);
		return Buffer.concat([head, payload]);
	};
	const write = (data: Buffer) => {
		if (child?.stdin?.writable) child.stdin.write(data);
	};
	const toCore = (kind: number, payload?: Buffer) => {
		const f = frame(channel ?? 0, kind, payload);
		if (channel === undefined) pending.push(f);
		else write(f);
	};
	const finish = (code: number, reason: string, closed?: unknown) => {
		if (done) return;
		done = true;
		if (closed !== undefined) socket.text({ type: "closed", ...(closed as object) });
		if (channel !== undefined) write(frame(channel, CLOSE));
		child?.stdin?.end();
		const c = child;
		setTimeout(() => c?.kill(), 2_000).unref();
		socket.end(code, reason.slice(0, 120));
		if (where) log.info("terminal_closed", { device, terminal: where, reason });
	};
	const rpc = (id: number, method: string, params: unknown) =>
		frame(0, DATA, Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params })));

	const onReply = (message: any) => {
		if (message.id === 1) {
			const r = message.result;
			if (message.error || !r?.methods?.includes("terminal.attach") || !r?.features?.includes("attach"))
				return finish(UNAVAILABLE, message.error?.message ?? "herdr-core cannot attach");
			auto = r.features.includes("automatic_input");
			return;
		}
		if (message.id === 2) {
			if (message.error) {
				const kind = message.error.data?.kind;
				return finish(kind === "unavailable" ? UNAVAILABLE : NOT_FOUND, message.error.message ?? "attach failed");
			}
			channel = message.result.channel;
			auto = auto && message.result.automatic_input === true;
			const t = message.result.terminal ?? {};
			socket.text({ type: "attached", host: hostOf, terminal: terminalOf, agent: agentOf, session: sessionOf, cols: t.cols, rows: t.rows, automaticInput: auto });
			for (const f of pending.splice(0)) write(Buffer.concat([frame(channel!, f.readUInt8(4), f.subarray(9))]));
			log.info("terminal_opened", { device, terminal: where });
		}
	};

	const onFrame = (ch: number, kind: number, payload: Buffer) => {
		if (ch === 0 && kind === DATA) {
			let message: any;
			try {
				message = JSON.parse(payload.toString("utf8"));
			} catch {
				return;
			}
			if (message.id !== undefined) onReply(message);
			return;
		}
		if (ch !== channel) return;
		if (kind === DATA) {
			const out = Buffer.alloc(payload.length + 1);
			out.writeUInt8(DATA, 0);
			payload.copy(out, 1);
			socket.binary(out);
		} else if (kind === CLOSE) {
			let reason: any = {};
			try {
				reason = payload.length > 0 ? JSON.parse(payload.toString("utf8")) : {};
			} catch {}
			finish(1000, String(reason.reason ?? "detached"), { reason: reason.reason ?? "detached", exitCode: reason.exit_code ?? null, signal: reason.signal ?? null });
		}
	};

	let hostOf = "";
	let terminalOf = "";
	let agentOf = "";
	let sessionOf: string | undefined;

	void (async () => {
		const found = await findAgent(hello, options).catch((error: Error) => `lookup failed: ${error.message}`);
		if (done) return;
		if (typeof found === "string") return finish(NOT_FOUND, found);
		hostOf = found.host;
		terminalOf = found.terminal;
		agentOf = found.agent;
		sessionOf = found.session;
		where = `${found.host}/${found.terminal}`;
		const local = found.host === options.host || (await options.native(found.host));
		const address = found.host === options.host || !local ? found.terminal : `${found.host}/${found.terminal}`;
		const argv = local ? ["hc", "connect"] : ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", options.ssh[found.host] ?? found.host, "hc", "connect"];
		if (done) return;
		child = (options.spawn ?? ((a) => spawn(a[0]!, a.slice(1), { stdio: ["pipe", "pipe", "ignore"] })))(argv);
		child.on("error", (error) => finish(UNAVAILABLE, `hc: ${error.message}`));
		child.on("exit", () => finish(UNAVAILABLE, "herdr-core connection ended"));
		child.stdin?.on("error", () => {});
		// Plain mode until hello's reply, which is one line; framed after it.
		let framed = false;
		child.stdout!.on("data", (chunk: Buffer) => {
			buffer = Buffer.concat([buffer, chunk]);
			if (!framed) {
				const nl = buffer.indexOf(10);
				if (nl < 0) return;
				let reply: any;
				try {
					reply = JSON.parse(buffer.subarray(0, nl).toString("utf8"));
				} catch {
					return finish(UNAVAILABLE, "herdr-core said something unexpected");
				}
				buffer = buffer.subarray(nl + 1);
				framed = true;
				onReply(reply);
				if (done) return;
				const cols = size(hello.cols) ?? 80;
				const rows = size(hello.rows) ?? 24;
				const history = Math.min(typeof hello.history === "number" && hello.history >= 0 ? Math.floor(hello.history) : 0, 10_000);
				write(rpc(2, "terminal.attach", { terminal: address, cols, rows, history, resumed: hello.resumed === true, ...(typeof hello.display === "object" && hello.display !== null ? { display: hello.display } : {}) }));
			}
			while (buffer.length >= 9) {
				const len = buffer.readUInt32LE(5);
				if (len > MAX_FRAME) return finish(UNAVAILABLE, "frame too large");
				if (buffer.length < 9 + len) break;
				const ch = buffer.readUInt32LE(0);
				const kind = buffer.readUInt8(4);
				const payload = buffer.subarray(9, 9 + len);
				buffer = buffer.subarray(9 + len);
				onFrame(ch, kind, payload);
				if (done) return;
			}
		});
		write(Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "hello", params: { generation: 1, framed: true } })}\n`));
	})();

	return {
		message(data, binary) {
			if (done) return;
			if (binary) {
				if (data.length < 1) return;
				const kind = data.readUInt8(0);
				if (kind !== DATA && kind !== AUTOMATIC_INPUT) return;
				toCore(kind === AUTOMATIC_INPUT && auto ? AUTOMATIC_INPUT : DATA, data.subarray(1));
				return;
			}
			let op: any;
			try {
				op = JSON.parse(data.toString("utf8"));
			} catch {
				return;
			}
			if (op?.op === "resize" && size(op.cols) && size(op.rows)) {
				const b = Buffer.alloc(4);
				b.writeUInt16LE(op.cols, 0);
				b.writeUInt16LE(op.rows, 2);
				toCore(RESIZE, b);
			} else if (op?.op === "focus") toCore(FOCUS, Buffer.from([op.on ? 1 : 0]));
			else if (op?.op === "facts" && typeof op.display === "object" && op.display !== null) toCore(FACTS, Buffer.from(JSON.stringify(op.display)));
			else if (op?.op === "credit" && Number.isInteger(op.bytes) && op.bytes > 0 && op.bytes <= 0xffffffff) {
				const b = Buffer.alloc(4);
				b.writeUInt32LE(op.bytes, 0);
				toCore(CREDIT, b);
			} else if (op?.op === "close") finish(1000, "closed by client");
		},
		close() {
			finish(1000, "client gone");
		},
	};
}
