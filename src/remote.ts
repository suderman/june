// The WebSocket listener for graphical clients: the socket's JSON objects, one per text frame, on 127.0.0.1 only, behind
// Traefik as wss://june.kit/. The first frame must be a hello with a device token (see "Client protocol for graphical
// clients" in docs/architecture.org). The same port serves the user's avatar set, and the pictures their messages brought, over HTTP under paths the hello gives
// each device, so a client loads June's art from the daemon rather than a synced folder.
import { randomBytes } from "node:crypto";
import { createReadStream, realpathSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, sep } from "node:path";
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
	/** The user's avatar set, served read-only to paired devices; none without it. */
	readonly avatar?: string;
	/** The `n`th picture the user's message `id` brought, for a client to show with it; none without the callback. */
	readonly attachment?: (id: string, n: number) => Promise<{ data: string; mimeType: string } | undefined>;
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

/** What the avatar route serves: the manifest and the art, nothing else in the set's directory. */
const TYPES: Record<string, string> = { ".png": "image/png", ".webp": "image/webp", ".svg": "image/svg+xml" };

/** The file an avatar path names inside `root`, with its type; undefined for anything else. */
export function avatarFile(root: string, path: string): { file: string; type: string } | undefined {
	if (!/^[\w.\/-]+$/.test(path) || path.split("/").some((part) => part === "" || part === "." || part === "..")) return undefined;
	const type = path === "manifest.json" ? "application/json" : TYPES[extname(path).toLowerCase()];
	if (type === undefined) return undefined;
	let base: string;
	let file: string;
	try {
		base = realpathSync(root);
		file = realpathSync(`${base}/${path}`);
	} catch {
		return undefined;
	}
	// A link inside the set must not lead out of it.
	if (!file.startsWith(base + sep)) return undefined;
	return { file, type };
}

export async function startRemote(options: RemoteOptions): Promise<Remote> {
	const { devices, log } = options;
	const helloMs = options.helloMs ?? 10_000;
	const pingMs = options.pingMs ?? 30_000;
	const maxBuffered = options.maxBuffered ?? 8 * 1024 * 1024;
	// A key per device for the avatar route, made at its first hello and good until the daemon stops or the device is
	// revoked. A path rather than a header, because an image element cannot send one.
	const keys = new Map<string, string>();
	const keyFor = (device: string) => {
		for (const [key, name] of keys) if (name === device) return key;
		const key = randomBytes(18).toString("base64url");
		keys.set(key, device);
		return key;
	};
	const listed = (device: string) => {
		try {
			return devices.list().some((d) => d.name === device);
		} catch {
			return false;
		}
	};
	const http = createServer((request: IncomingMessage, response: ServerResponse) => {
		const notFound = () => {
			response.writeHead(404, { "content-type": "text/plain" });
			response.end("not found\n");
		};
		const url = (request.url ?? "").split("?")[0];
		const picture = /^\/attached\/([\w-]+)\/(\d{1,12})\/(\d)$/.exec(url);
		if (picture && (request.method === "GET" || request.method === "HEAD") && options.attachment !== undefined) {
			const owner = keys.get(picture[1]);
			if (owner === undefined || !listed(owner)) return notFound();
			// A message never changes, so a client keeps its picture for good.
			void options.attachment(picture[2]!, Number(picture[3])).then(
				(found) => {
					if (found === undefined) return notFound();
					const bytes = Buffer.from(found.data, "base64");
					response.writeHead(200, { "content-type": found.mimeType, "cache-control": "private, max-age=31536000, immutable", "content-length": String(bytes.length) });
					response.end(request.method === "HEAD" ? undefined : bytes);
				},
				() => notFound(),
			);
			return;
		}
		const m = /^\/avatar\/([\w-]+)\/(.+)$/.exec(url);
		if (!m || (request.method !== "GET" && request.method !== "HEAD") || options.avatar === undefined) return notFound();
		const device = keys.get(m[1]);
		if (device === undefined || !listed(device)) return notFound();
		let path: string;
		try {
			path = decodeURIComponent(m[2]);
		} catch {
			return notFound();
		}
		const found = avatarFile(options.avatar, path);
		if (found === undefined) return notFound();
		let info: ReturnType<typeof statSync>;
		try {
			info = statSync(found.file);
		} catch {
			return notFound();
		}
		if (!info.isFile()) return notFound();
		const etag = `"${info.size.toString(36)}-${Math.floor(info.mtimeMs).toString(36)}"`;
		const headers = { "content-type": found.type, "cache-control": "private, no-cache", etag };
		if (request.headers["if-none-match"] === etag) {
			response.writeHead(304, headers);
			return response.end();
		}
		response.writeHead(200, { ...headers, "content-length": String(info.size) });
		if (request.method === "HEAD") return response.end();
		createReadStream(found.file).on("error", () => response.destroy()).pipe(response);
	});
	const server = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });
	http.on("upgrade", (request, socket, head) => server.handleUpgrade(request, socket, head, (ws) => server.emit("connection", ws, request)));
	await new Promise<void>((resolve, reject) => {
		http.once("listening", resolve);
		http.once("error", reject);
		http.listen(options.port, "127.0.0.1");
	});
	http.on("error", (error) => log.warn("remote_error", { error: error.message }));
	server.on("error", (error) => log.warn("remote_error", { error: error.message }));
	const address = http.address();
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
				send({ type: "hello", requestId: String(request.requestId ?? ""), device, protocol: PROTOCOL, ...(options.avatar !== undefined ? { avatar: `/avatar/${keyFor(name)}/` } : {}), ...(options.attachment !== undefined ? { attached: `/attached/${keyFor(name)}/` } : {}) });
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
			for (const [key, device] of keys) if (device === name) keys.delete(key);
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
			server.close();
			http.closeAllConnections();
			return new Promise((resolve) => http.close(() => resolve()));
		},
	};
}
