// The WebSocket listener for graphical clients: the socket's JSON objects, one per text frame, on 127.0.0.1 only, behind
// Traefik as wss://june.kit/. The first frame must be a hello with a device token (see "Client protocol for graphical
// clients" in docs/architecture.org).
import { WebSocket, WebSocketServer } from "ws";
import type { Devices } from "./devices.ts";
import type { Reply } from "./protocol.ts";
import type { Logger } from "./runtime.ts";

export const PROTOCOL = 1;
/** A wrong, revoked, or missing token, or no hello: the client stops reconnecting and asks to be paired. */
export const UNAUTHORIZED = 4401;
export const UNSUPPORTED = 4400;

/** What a connection does once it has said hello: the same requests as the Unix socket. */
export type Session = { handle(value: unknown): void; close(): void };

export type RemoteOptions = {
	readonly port: number;
	readonly devices: Devices;
	readonly log: Logger;
	readonly session: (send: (reply: Reply) => void, device: string) => Session;
	/** Tests shorten these. */
	readonly helloMs?: number;
	readonly pingMs?: number;
	readonly maxBuffered?: number;
};

export type Remote = {
	readonly port: number;
	/** Live connections per device. */
	connections(): Map<string, number>;
	/** Close a device's connections with 4401; how many there were. */
	revoke(name: string): number;
	close(): Promise<void>;
};

type Entry = { device?: string; alive: boolean; shut(code: number, reason: string): void };

const MAX_PAYLOAD = 32 * 1024 * 1024;

export async function startRemote(options: RemoteOptions): Promise<Remote> {
	const { devices, log } = options;
	const helloMs = options.helloMs ?? 10_000;
	const pingMs = options.pingMs ?? 30_000;
	const maxBuffered = options.maxBuffered ?? 8 * 1024 * 1024;
	const server = new WebSocketServer({ host: "127.0.0.1", port: options.port, maxPayload: MAX_PAYLOAD });
	await new Promise<void>((resolve, reject) => {
		server.once("listening", resolve);
		server.once("error", reject);
	});
	server.on("error", (error) => log.warn("remote_error", { error: error.message }));
	const address = server.address();
	const port = typeof address === "object" && address !== null ? address.port : options.port;

	/** Every open connection; `device` is set after hello. */
	const open = new Map<WebSocket, Entry>();

	server.on("connection", (ws) => {
		let device: string | undefined;
		let session: Session | undefined;
		let shut = false;
		const end = (code: number, reason: string) => {
			if (shut) return;
			shut = true;
			clearTimeout(hello);
			open.delete(ws);
			session?.close();
			ws.close(code, reason);
		};
		const entry: Entry = { alive: true, shut: end };
		open.set(ws, entry);
		const hello = setTimeout(() => end(UNAUTHORIZED, "no hello"), helloMs);
		const send = (reply: Reply) => {
			if (shut || ws.readyState !== WebSocket.OPEN) return;
			ws.send(JSON.stringify(reply));
			// A client this far behind is cheaper to drop: a reconnect costs only a reset.
			if (ws.bufferedAmount > maxBuffered) {
				log.warn("remote_backlog", { device, bytes: ws.bufferedAmount });
				shut = true;
				open.delete(ws);
				session?.close();
				ws.terminate();
			}
		};
		ws.on("pong", () => (entry.alive = true));
		ws.on("error", () => {});
		ws.on("close", () => {
			clearTimeout(hello);
			open.delete(ws);
			if (!shut) session?.close();
			shut = true;
			if (device) log.info("remote_closed", { device });
		});
		ws.on("message", (data, isBinary) => {
			if (shut) return;
			let value: unknown;
			if (!isBinary) {
				try {
					value = JSON.parse(data.toString("utf8"));
				} catch {}
			}
			if (session === undefined) {
				const request = value as { op?: unknown; requestId?: unknown; token?: unknown; protocol?: unknown } | undefined;
				if (request?.op !== "hello") return end(UNAUTHORIZED, "hello first");
				let name: string | undefined;
				try {
					name = devices.verify(request.token);
				} catch (error) {
					// An unreadable device file refuses everyone rather than taking the daemon down.
					log.error("remote_devices_unreadable", { file: devices.file, error: (error as Error).message });
				}
				if (name === undefined) {
					log.warn("remote_refused", {});
					return end(UNAUTHORIZED, "unknown device");
				}
				if (request.protocol !== PROTOCOL) return end(UNSUPPORTED, `protocol ${PROTOCOL} only`);
				clearTimeout(hello);
				device = entry.device = name;
				log.info("remote_hello", { device });
				send({ type: "hello", requestId: String(request.requestId ?? ""), device, protocol: PROTOCOL });
				session = options.session(send, device);
				return;
			}
			if (isBinary) return send({ type: "error", message: "Binary frames are not supported yet" });
			if (value === undefined || value === null || typeof value !== "object") return send({ type: "error", message: "Malformed request" });
			if ((value as { op?: unknown }).op === "hello") return send({ type: "error", requestId: (value as { requestId?: string }).requestId, message: "Already said hello" });
			session.handle(value);
		});
	});

	// One ping round for every connection: one that never answered the last ping is dropped.
	const pinger = setInterval(() => {
		for (const [ws, entry] of [...open]) {
			if (!entry.alive) {
				entry.shut(1001, "no pong");
				ws.terminate();
				continue;
			}
			entry.alive = false;
			ws.ping();
		}
	}, pingMs);

	log.info("remote_listening", { host: "127.0.0.1", port });
	return {
		port,
		connections() {
			const counts = new Map<string, number>();
			for (const { device } of open.values()) if (device !== undefined) counts.set(device, (counts.get(device) ?? 0) + 1);
			return counts;
		},
		revoke(name) {
			let closed = 0;
			for (const entry of [...open.values()]) {
				if (entry.device !== name) continue;
				entry.shut(UNAUTHORIZED, "revoked");
				closed++;
			}
			return closed;
		},
		close() {
			clearInterval(pinger);
			for (const ws of server.clients) ws.terminate();
			return new Promise((resolve) => server.close(() => resolve()));
		},
	};
}
